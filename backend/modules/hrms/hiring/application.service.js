/**
 * The application pipeline — one row per candidate × requisition.
 *
 * Ported from the reference's `application.service.ts`.
 *
 * ---------------------------------------------------------------------------
 * What changes, and why
 * ---------------------------------------------------------------------------
 * 1. THE PIPELINE ADVANCES ONE STEP AT A TIME. The reference only blocks moving
 *    OUT of `hired`/`rejected`, so `applied → offer` skips screening and
 *    interview entirely. The Kanban draws a funnel; a board where a card can
 *    teleport is not one, and any report reading stage history becomes fiction.
 *
 * 2. THE CANDIDATE IS RESOLVED. `create` takes a `candidateId` and never checks
 *    it exists — Postgres would have refused on the foreign key, MongoDB will
 *    not (AD-2), so a typo becomes a pipeline row pointing at nothing.
 *
 * 3. EVERY MOVE IS RECORDED. The reference keeps only the current stage and its
 *    timestamp, so "how long did screening take" is unanswerable and a mis-click
 *    that advanced somebody leaves no trace.
 */

import mongoose from 'mongoose';

import {
  Application,
  Candidate,
  JobRequisition,
  Interview,
  HiringOffer,
} from '../../../models/hrms/HiringModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import {
  APPLICATION_TRANSITIONS,
  CLOSED_APPLICATION_STAGES,
  PIPELINE_COLUMNS,
  TERMINAL_REQUISITION_STATUSES,
} from '../../../shared/constants/hiring.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsValidationError,
} from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const toDto = (row, extras = {}) => ({
  id: idStr(row._id),
  candidateId: idStr(row.candidateId),
  candidateName: extras.candidateName ?? null,
  candidateEmail: extras.candidateEmail ?? null,
  requisitionId: idStr(row.requisitionId),
  requisitionTitle: extras.requisitionTitle ?? null,
  stage: row.stage,
  appliedAt: row.appliedAt ? new Date(row.appliedAt).toISOString() : null,
  currentStageAt: row.currentStageAt ? new Date(row.currentStageAt).toISOString() : null,
  rejectionReason: row.rejectionReason ?? null,
  stageHistory: (row.stageHistory ?? []).map((e) => ({
    stage: e.stage,
    at: e.at ? new Date(e.at).toISOString() : null,
    note: e.note ?? null,
  })),
  interviewCount: extras.interviewCount ?? 0,
  hasOffer: extras.hasOffer ?? false,
});

/**
 * Attach the candidate, the requisition title and the two counts.
 *
 * Four queries for a page rather than four per row. The reference leans on
 * Prisma's `include`/`_count`; translated naively that is an N+1 the Kanban
 * multiplies by every card on the board.
 */
async function enrich(rows) {
  if (rows.length === 0) return [];

  const [candidates, requisitions, interviewCounts, offers] = await Promise.all([
    Candidate.find({ _id: { $in: [...new Set(rows.map((r) => idStr(r.candidateId)))] } })
      .select('name email')
      .lean(),
    JobRequisition.find({ _id: { $in: [...new Set(rows.map((r) => idStr(r.requisitionId)))] } })
      .select('title')
      .lean(),
    Interview.aggregate([
      { $match: { applicationId: { $in: rows.map((r) => r._id) } } },
      { $group: { _id: '$applicationId', n: { $sum: 1 } } },
    ]),
    HiringOffer.find({ applicationId: { $in: rows.map((r) => r._id) } })
      .select('applicationId')
      .lean(),
  ]);

  const candidateById = new Map(candidates.map((c) => [idStr(c._id), c]));
  const titleById = new Map(requisitions.map((r) => [idStr(r._id), r.title]));
  const interviewsById = new Map(interviewCounts.map((r) => [idStr(r._id), r.n]));
  const withOffer = new Set(offers.map((o) => idStr(o.applicationId)));

  return rows.map((row) => {
    const candidate = candidateById.get(idStr(row.candidateId));
    return toDto(row, {
      candidateName: candidate?.name ?? null,
      candidateEmail: candidate?.email ?? null,
      requisitionTitle: titleById.get(idStr(row.requisitionId)) ?? null,
      interviewCount: interviewsById.get(idStr(row._id)) ?? 0,
      hasOffer: withOffer.has(idStr(row._id)),
    });
  });
}

export async function listApplications(query = {}) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, requisitionId, candidateId, stage } = query;

  const filter = {
    ...(requisitionId ? { requisitionId: oid(requisitionId) } : {}),
    ...(candidateId ? { candidateId: oid(candidateId) } : {}),
    ...(stage ? { stage } : {}),
  };

  const [rows, total] = await Promise.all([
    Application.find(filter)
      .sort({ currentStageAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Application.countDocuments(filter),
  ]);

  return { data: await enrich(rows), total, page, pageSize };
}

/**
 * The Kanban board for one requisition.
 *
 * Returns every application grouped by column. Deliberately NOT paginated: a
 * board that shows page one of `applied` is not a board. The set is bounded by
 * one requisition's applicants, and the cap below keeps a runaway posting from
 * loading unboundedly — with a count so the UI can say what it is not showing.
 */
export async function pipelineBoard(requisitionId, { limitPerColumn = 200 } = {}) {
  if (!mongoose.isValidObjectId(requisitionId)) throw new HrmsNotFoundError('Requisition');

  const rows = await Application.find({ requisitionId: oid(requisitionId) })
    .sort({ currentStageAt: -1 })
    .limit(limitPerColumn * PIPELINE_COLUMNS.length)
    .lean();

  const total = await Application.countDocuments({ requisitionId: oid(requisitionId) });
  const enriched = await enrich(rows);

  const columns = PIPELINE_COLUMNS.map((stage) => ({
    stage,
    applications: enriched.filter((a) => a.stage === stage),
  }));

  return { requisitionId: idStr(requisitionId), columns, total, loaded: enriched.length };
}

export async function getApplication(id) {
  const row = await loadApplication(id);
  return (await enrich([row]))[0];
}

/**
 * Put a candidate into a requisition's pipeline.
 *
 * Both references are resolved before the write, and the unique
 * `(candidateId, requisitionId)` index is what actually prevents a duplicate
 * under a double submit — the pre-check below only improves the message.
 */
export async function createApplication(input, context = {}) {
  const [candidate, requisition] = await Promise.all([
    Candidate.findOne({ _id: input.candidateId, deletedAt: null }).select('name email').lean(),
    JobRequisition.findOne({ _id: input.requisitionId, deletedAt: null }).select('title status').lean(),
  ]);

  if (!candidate) {
    throw new HrmsValidationError('Unknown candidate.', [
      { path: 'candidateId', message: 'That candidate does not exist.' },
    ]);
  }
  if (!requisition) {
    throw new HrmsValidationError('Unknown requisition.', [
      { path: 'requisitionId', message: 'That requisition does not exist.' },
    ]);
  }
  if (TERMINAL_REQUISITION_STATUSES.includes(requisition.status)) {
    throw new HrmsConflictError(
      `That requisition is ${requisition.status} and is no longer accepting applications.`,
      { code: 'REQUISITION_CLOSED' },
    );
  }

  try {
    const row = await Application.create({
      candidateId: oid(input.candidateId),
      requisitionId: oid(input.requisitionId),
      stage: 'applied',
      appliedAt: new Date(),
      currentStageAt: new Date(),
      stageHistory: [
        { stage: 'applied', at: new Date(), byUserId: context.user?._id ?? null, note: null },
      ],
      createdByUserId: context.user?._id ?? null,
    });

    await recordAudit(
      context.user,
      AUDIT_ACTIONS.APPLICATION_CREATED,
      `${candidate.name} applied for "${requisition.title}"`,
      context.req,
      {
        meta: {
          applicationId: idStr(row._id),
          candidateId: idStr(candidate._id),
          requisitionId: idStr(requisition._id),
        },
      },
    );

    return getApplication(row._id);
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError(
        `${candidate.name} has already applied for "${requisition.title}".`,
        { code: 'APPLICATION_EXISTS' },
      );
    }
    throw error;
  }
}

/**
 * Advance or reject an application.
 *
 * The transition table is the rule; `hired` additionally requires an accepted
 * offer, which the reference also enforces and which is the one thing stopping
 * somebody being marked hired before they have agreed to anything.
 */
export async function moveStage(id, input, context = {}) {
  const application = await loadApplication(id);

  assertStageTransition(application.stage, input.stage);

  if (input.stage === 'hired') {
    const accepted = await HiringOffer.findOne({
      applicationId: oid(id),
      acceptedAt: { $ne: null },
    })
      .select('_id')
      .lean();
    if (!accepted) {
      throw new HrmsValidationError(
        'This candidate has not accepted an offer yet, so they cannot be marked hired.',
        [{ path: 'stage', message: 'Send an offer and wait for acceptance first.' }],
      );
    }
  }

  const now = new Date();
  const updated = await Application.findOneAndUpdate(
    // Conditional on the stage we validated, so two recruiters moving the same
    // card cannot both succeed.
    { _id: id, stage: application.stage },
    {
      $set: {
        stage: input.stage,
        currentStageAt: now,
        rejectionReason: input.stage === 'rejected' ? input.rejectionReason : null,
      },
      $push: {
        stageHistory: {
          stage: input.stage,
          at: now,
          byUserId: context.user?._id ?? null,
          note: input.rejectionReason ?? null,
        },
      },
    },
    { new: true },
  );
  if (!updated) {
    throw new HrmsConflictError('This application moved before your change was saved.', {
      code: 'APPLICATION_INVALID_TRANSITION',
    });
  }

  // Reaching the headcount closes the requisition, as in the reference.
  if (input.stage === 'hired') await fillRequisitionIfComplete(application.requisitionId, context);

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.APPLICATION_STAGE_MOVED,
    `Application moved from ${application.stage} to ${input.stage}`,
    context.req,
    {
      meta: {
        applicationId: idStr(id),
        candidateId: idStr(application.candidateId),
        requisitionId: idStr(application.requisitionId),
        from: application.stage,
        to: input.stage,
        rejectionReason: input.rejectionReason ?? null,
      },
    },
  );

  return getApplication(id);
}

/** Close the requisition once enough people have been hired. */
async function fillRequisitionIfComplete(requisitionId, context = {}) {
  const requisition = await JobRequisition.findById(requisitionId).select('headcount status title').lean();
  if (!requisition || TERMINAL_REQUISITION_STATUSES.includes(requisition.status)) return;

  const hired = await Application.countDocuments({ requisitionId, stage: 'hired' });
  if (hired < requisition.headcount) return;

  const result = await JobRequisition.updateOne(
    { _id: requisitionId, status: { $in: ['approved', 'open'] } },
    { $set: { status: 'filled' } },
  );

  if (result.modifiedCount > 0) {
    await recordAudit(
      context.user,
      AUDIT_ACTIONS.REQUISITION_STATUS_CHANGED,
      `Requisition "${requisition.title}" is filled — ${hired} of ${requisition.headcount} hired`,
      context.req,
      {
        meta: {
          requisitionId: idStr(requisitionId),
          from: requisition.status,
          to: 'filled',
          automatic: true,
        },
      },
    );
  }
}

/** Check a move against the declared table. One place, one message. */
export function assertStageTransition(from, to) {
  const allowed = APPLICATION_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new HrmsConflictError(
      CLOSED_APPLICATION_STAGES.includes(from)
        ? `This application is ${from} and can no longer be moved.`
        : `An application at ${from} can only move to: ${allowed.join(' or ')}.`,
      { code: 'APPLICATION_INVALID_TRANSITION' },
    );
  }
}

/**
 * Move an application to a stage the pipeline reaches automatically.
 *
 * Used when scheduling an interview or raising an offer. Silently does nothing
 * when the application is already at or past that stage, so a second interview
 * does not drag a candidate backwards from `offer` to `interview`.
 */
export async function advanceTo(applicationId, targetStage, context = {}) {
  const application = await Application.findById(applicationId).lean();
  if (!application) return;
  if (CLOSED_APPLICATION_STAGES.includes(application.stage)) return;

  const order = PIPELINE_COLUMNS.indexOf(application.stage);
  const target = PIPELINE_COLUMNS.indexOf(targetStage);
  if (order < 0 || target < 0 || target <= order) return;

  const now = new Date();
  await Application.updateOne(
    { _id: applicationId, stage: application.stage },
    {
      $set: { stage: targetStage, currentStageAt: now },
      $push: {
        stageHistory: {
          stage: targetStage,
          at: now,
          byUserId: context.user?._id ?? null,
          note: 'Advanced automatically',
        },
      },
    },
  );
}

async function loadApplication(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Application');
  const row = await Application.findById(id).lean();
  if (!row) throw new HrmsNotFoundError('Application');
  return row;
}

export { loadApplication, enrich as enrichApplications };

export default {
  listApplications,
  pipelineBoard,
  getApplication,
  createApplication,
  moveStage,
  advanceTo,
  assertStageTransition,
};
