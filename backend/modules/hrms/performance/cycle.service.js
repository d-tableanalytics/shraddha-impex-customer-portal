/**
 * Review cycles — the window, the competency template, and the phase machine.
 *
 * Ported from the reference's `review-cycle.service.ts`.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections
 * ---------------------------------------------------------------------------
 * 1. THE PHASE MACHINE IS ENFORCED. The reference's own header says the phases
 *    "progress linearly", and `advancePhase` then accepts ANY phase from any
 *    phase — the only guard is that the cycle is not already closed. A cycle in
 *    `calibration` can be shoved back to `goal_setting`, invalidating every
 *    review written under it while leaving those rows in place. Here the
 *    transitions are a table, one step back is allowed to undo a premature
 *    advance, and even that is refused once responses have been submitted.
 *
 * 2. THE COMPETENCY TEMPLATE IS TYPED. The reference stores a free-form `Json`
 *    column; `ratings` is keyed on `competency.key`, so a malformed key is a
 *    rating that can never be read back.
 *
 * 3. CALIBRATION DOES NOT ROUND BEFORE BUCKETING. The reference buckets
 *    `Math.round(managerAverage)`, so a 3.5 average is reported in the 4 band
 *    and the distribution over-reports the top of the scale. The band is the
 *    floor of the average, and the exact average is returned beside it.
 *
 * 4. THE LIST IS PAGINATED (AD-13).
 */

import mongoose from 'mongoose';

import { ReviewCycle, ReviewResponse, Goal } from '../../../models/hrms/PerformanceModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import { PHASE_TRANSITIONS, RATING_MIN, RATING_MAX } from '../../../shared/constants/performance.js';
import { HrmsNotFoundError, HrmsConflictError } from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

const toDto = (row, extras = {}) => ({
  id: idStr(row._id),
  name: row.name,
  startDate: row.startDate,
  endDate: row.endDate,
  phase: row.phase,
  competencies: (row.competencies ?? []).map((c) => ({
    key: c.key,
    label: c.label,
    weight: c.weight,
  })),
  responseCount: extras.responseCount ?? 0,
  submittedCount: extras.submittedCount ?? 0,
  goalCount: extras.goalCount ?? 0,
  /** What the cycle may become next — the UI offers exactly these. */
  nextPhases: PHASE_TRANSITIONS[row.phase] ?? [],
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
});

/** Response and goal counts for a page of cycles — three queries, not three per row. */
async function enrich(rows) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r._id);

  const [responses, submitted, goals] = await Promise.all([
    ReviewResponse.aggregate([
      { $match: { cycleId: { $in: ids } } },
      { $group: { _id: '$cycleId', n: { $sum: 1 } } },
    ]),
    ReviewResponse.aggregate([
      { $match: { cycleId: { $in: ids }, submittedAt: { $ne: null } } },
      { $group: { _id: '$cycleId', n: { $sum: 1 } } },
    ]),
    Goal.aggregate([
      { $match: { cycleId: { $in: ids }, deletedAt: null } },
      { $group: { _id: '$cycleId', n: { $sum: 1 } } },
    ]),
  ]);

  const byId = (agg) => new Map(agg.map((a) => [idStr(a._id), a.n]));
  const r = byId(responses);
  const s = byId(submitted);
  const g = byId(goals);

  return rows.map((row) =>
    toDto(row, {
      responseCount: r.get(idStr(row._id)) ?? 0,
      submittedCount: s.get(idStr(row._id)) ?? 0,
      goalCount: g.get(idStr(row._id)) ?? 0,
    }),
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listCycles(query = {}) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, phase } = query;
  const filter = { ...(phase ? { phase } : {}) };

  const [rows, total] = await Promise.all([
    ReviewCycle.find(filter)
      // Most recent window first — the reference's ordering.
      .sort({ startDate: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    ReviewCycle.countDocuments(filter),
  ]);

  return { data: await enrich(rows), total, page, pageSize };
}

export async function getCycle(id) {
  const row = await loadCycle(id);
  return (await enrich([row]))[0];
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createCycle(input, context = {}) {
  let row;
  try {
    row = await ReviewCycle.create({
      name: input.name,
      startDate: input.startDate,
      endDate: input.endDate,
      phase: 'goal_setting',
      competencies: input.competencies,
      phaseHistory: [
        { phase: 'goal_setting', at: new Date(), byUserId: context.user?._id ?? null },
      ],
      createdByUserId: context.user?._id ?? null,
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError(`A cycle called "${input.name}" already exists.`, {
        code: 'CYCLE_NAME_TAKEN',
      });
    }
    throw error;
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.REVIEW_CYCLE_CREATED,
    `Created the review cycle "${row.name}" (${input.startDate} → ${input.endDate}) with ${input.competencies.length} competenc(ies)`,
    context.req,
    {
      meta: {
        cycleId: idStr(row._id),
        name: row.name,
        competencies: input.competencies.map((c) => c.key),
      },
    },
  );

  return getCycle(row._id);
}

function assertPhaseTransition(from, to) {
  if (from === to) {
    throw new HrmsConflictError(`This cycle is already in ${from.replace('_', ' ')}.`, {
      code: 'CYCLE_INVALID_TRANSITION',
    });
  }
  const allowed = PHASE_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new HrmsConflictError(
      allowed.length === 0
        ? `This cycle is ${from} and is final.`
        : `A cycle in ${from.replace('_', ' ')} can only move to: ${allowed.join(', ')}.`,
      { code: 'CYCLE_INVALID_TRANSITION' },
    );
  }
}

/**
 * Move the cycle to its next phase.
 *
 * Forward-by-one, or one step back to undo a premature advance — and the step
 * back is refused once anybody has submitted, because reviews written under a
 * phase must not have the ground moved beneath them.
 */
export async function advancePhase(id, input, context = {}) {
  const cycle = await loadCycle(id);
  assertPhaseTransition(cycle.phase, input.phase);

  const goingBack = isBackward(cycle.phase, input.phase);
  if (goingBack) {
    const submitted = await ReviewResponse.countDocuments({
      cycleId: cycle._id,
      submittedAt: { $ne: null },
    });
    if (submitted > 0) {
      throw new HrmsConflictError(
        `${submitted} review(s) have already been submitted in this cycle, so it cannot move back a phase.`,
        { code: 'CYCLE_HAS_SUBMISSIONS' },
      );
    }
  }

  const updated = await ReviewCycle.findOneAndUpdate(
    // Conditional on the phase we read, so two concurrent advances cannot both
    // land and skip a phase between them.
    { _id: cycle._id, phase: cycle.phase },
    {
      $set: { phase: input.phase },
      $push: {
        phaseHistory: { phase: input.phase, at: new Date(), byUserId: context.user?._id ?? null },
      },
    },
    { new: true },
  );
  if (!updated) {
    throw new HrmsConflictError('This cycle changed before your update was saved.', {
      code: 'CYCLE_INVALID_TRANSITION',
    });
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.REVIEW_CYCLE_PHASE_CHANGED,
    `Moved the cycle "${cycle.name}" from ${cycle.phase} to ${input.phase}`,
    context.req,
    {
      meta: {
        cycleId: idStr(cycle._id),
        from: cycle.phase,
        to: input.phase,
        backward: goingBack,
      },
    },
  );

  return getCycle(cycle._id);
}

/** Whether `to` sits earlier in the phase order than `from`. */
function isBackward(from, to) {
  const order = ['goal_setting', 'self_review', 'manager_review', 'calibration', 'closed'];
  return order.indexOf(to) < order.indexOf(from);
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * The calibration snapshot — every employee's ratings side by side.
 *
 * Reproduces the reference's aggregation: submitted responses only, averaged
 * per employee by kind, with peer and skip-level pooled into one "peer" column.
 *
 * 🔴 The reference then buckets `Math.round(managerAverage)` into the
 * distribution, so a 3.5 average is counted in band 4 and the top of the scale
 * is over-reported. The band here is the FLOOR of the average — 3.5 sits in
 * band 3, "at least 3 but not yet 4" — and the exact average is returned
 * beside it so nothing is hidden by the bucketing.
 */
export async function calibrationSnapshot(id) {
  const cycle = await loadCycle(id);

  const responses = await ReviewResponse.find({
    cycleId: cycle._id,
    submittedAt: { $ne: null },
  })
    .select('employeeId employeeName kind overallRating ratings')
    .lean();

  const byEmployee = new Map();
  for (const r of responses) {
    const key = idStr(r.employeeId);
    if (!byEmployee.has(key)) {
      byEmployee.set(key, {
        employeeId: key,
        employeeName: r.employeeName ?? null,
        self: [],
        manager: [],
        peer: [],
      });
    }
    if (r.overallRating === null || r.overallRating === undefined) continue;
    const bucket = byEmployee.get(key);
    if (r.kind === 'self') bucket.self.push(r.overallRating);
    else if (r.kind === 'manager') bucket.manager.push(r.overallRating);
    // Peer and skip-level pool together, as the reference pools them.
    else bucket.peer.push(r.overallRating);
  }

  const avg = (arr) =>
    arr.length ? Number((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2)) : null;

  const rows = [...byEmployee.values()]
    .map((b) => ({
      employeeId: b.employeeId,
      employeeName: b.employeeName,
      selfRating: avg(b.self),
      managerRating: avg(b.manager),
      peerAverage: avg(b.peer),
      /** How far self-assessment sits from the manager's — the point of calibration. */
      gap:
        avg(b.self) !== null && avg(b.manager) !== null
          ? Number((avg(b.self) - avg(b.manager)).toFixed(2))
          : null,
    }))
    .sort((a, b) => (b.managerRating ?? -1) - (a.managerRating ?? -1));

  const distribution = {};
  for (let band = RATING_MIN; band <= RATING_MAX; band += 1) distribution[band] = 0;
  for (const row of rows) {
    if (row.managerRating === null) continue;
    // FLOOR, not round — see the header.
    const band = Math.min(RATING_MAX, Math.max(RATING_MIN, Math.floor(row.managerRating)));
    distribution[band] += 1;
  }

  return {
    cycleId: idStr(cycle._id),
    cycleName: cycle.name,
    phase: cycle.phase,
    rated: rows.filter((r) => r.managerRating !== null).length,
    responses: rows,
    distribution,
  };
}

// ---------------------------------------------------------------------------

export async function loadCycle(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Review cycle');
  const row = await ReviewCycle.findById(id).lean();
  if (!row) throw new HrmsNotFoundError('Review cycle');
  return row;
}

export { toDto as cycleDto, assertPhaseTransition, isBackward, oid };

export default {
  listCycles,
  getCycle,
  createCycle,
  advancePhase,
  calibrationSnapshot,
};
