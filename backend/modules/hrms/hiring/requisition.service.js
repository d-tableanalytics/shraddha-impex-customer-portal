/**
 * Job requisitions and their postings.
 *
 * Ported from the reference's `job-requisition.service.ts` and
 * `job-posting.service.ts`. Grouped because a posting has no life of its own —
 * it is the public face of one requisition, and publishing it moves the
 * requisition's own status.
 *
 * ---------------------------------------------------------------------------
 * What changes, and why
 * ---------------------------------------------------------------------------
 * 1. THE STATE MACHINE IS ENFORCED. The reference documents
 *    `draft → approved → open → filled | cancelled` in a comment and then lets
 *    `setStatus` write anything at all, so a cancelled requisition can be
 *    reopened and a filled one dragged back to draft with its hires attached.
 *
 * 2. NOBODY APPROVES THEIR OWN REQUISITION. `approve` checks only
 *    `hiring:edit:org`, which the creator holds — so the person asking for
 *    headcount signs off on it. Payroll already refuses self-approved
 *    corrections; the same line is drawn here.
 *
 * 3. THE SLUG IS SERVER-GENERATED. A client-chosen slug is a way to squat a
 *    public path, or to probe which requisitions exist by trying names.
 *
 * 4. DEPARTMENT AND LOCATION ARE RESOLVED. AD-2 left no foreign key, so a
 *    dangling id would surface as a blank column on the careers page.
 */

import crypto from 'node:crypto';
import mongoose from 'mongoose';

import {
  JobRequisition,
  JobPosting,
  Application,
} from '../../../models/hrms/HiringModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { notifyUsers } from '../inbox/notifier.service.js';
import { INBOX_TYPES } from '../../../shared/constants/inbox.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import {
  REQUISITION_TRANSITIONS,
  TERMINAL_REQUISITION_STATUSES,
} from '../../../shared/constants/hiring.js';
import { toDecimalString, fromDecimal } from '../../../shared/payroll/money.js';
import {
  resolveDepartment,
  resolveLocation,
} from '../references/reference.service.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsValidationError,
  HrmsForbiddenError,
} from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const decimalOrNull = (v) =>
  v === null || v === undefined || v === '' ? null : mongoose.Types.Decimal128.fromString(toDecimalString(v));

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

const toDto = (row, extras = {}) => ({
  id: idStr(row._id),
  title: row.title,
  departmentId: idStr(row.departmentId),
  departmentName: extras.departmentName ?? null,
  locationId: idStr(row.locationId),
  locationName: extras.locationName ?? null,
  headcount: row.headcount,
  budgetMin: row.budgetMin === null || row.budgetMin === undefined ? null : fromDecimal(row.budgetMin),
  budgetMax: row.budgetMax === null || row.budgetMax === undefined ? null : fromDecimal(row.budgetMax),
  status: row.status,
  businessJustification: row.businessJustification ?? null,
  cancellationReason: row.cancellationReason ?? null,
  createdByUserId: idStr(row.createdByUserId),
  approvedByUserId: idStr(row.approvedByUserId),
  approvedAt: row.approvedAt ? new Date(row.approvedAt).toISOString() : null,
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  postingCount: extras.postingCount ?? 0,
  applicationCount: extras.applicationCount ?? 0,
});

/**
 * Attach department and location names, plus the two counts the list shows.
 *
 * Four aggregate queries for the whole page rather than four per row — the
 * reference relies on Prisma `_count` and `include`, and the naive Mongoose
 * translation is an N+1 that a busy pipeline multiplies by the page size.
 */
async function enrich(rows) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r._id);

  const [postingCounts, applicationCounts] = await Promise.all([
    JobPosting.aggregate([
      { $match: { requisitionId: { $in: ids }, deletedAt: null } },
      { $group: { _id: '$requisitionId', n: { $sum: 1 } } },
    ]),
    Application.aggregate([
      { $match: { requisitionId: { $in: ids } } },
      { $group: { _id: '$requisitionId', n: { $sum: 1 } } },
    ]),
  ]);
  const postings = new Map(postingCounts.map((r) => [idStr(r._id), r.n]));
  const applications = new Map(applicationCounts.map((r) => [idStr(r._id), r.n]));

  // Names resolve through the shared reference providers, so a retired
  // department still renders its name rather than a blank.
  const names = new Map();
  const lookups = [
    ...new Set(rows.flatMap((r) => [idStr(r.departmentId), idStr(r.locationId)]).filter(Boolean)),
  ];
  await Promise.all(
    lookups.map(async (id) => {
      const dept = await resolveDepartment(id).catch(() => null);
      if (dept) return names.set(id, dept.name);
      const loc = await resolveLocation(id).catch(() => null);
      if (loc) names.set(id, loc.name);
    }),
  );

  return rows.map((row) =>
    toDto(row, {
      departmentName: names.get(idStr(row.departmentId)) ?? null,
      locationName: names.get(idStr(row.locationId)) ?? null,
      postingCount: postings.get(idStr(row._id)) ?? 0,
      applicationCount: applications.get(idStr(row._id)) ?? 0,
    }),
  );
}

// ---------------------------------------------------------------------------
// Requisition reads
// ---------------------------------------------------------------------------

export async function listRequisitions(query = {}) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, status, departmentId, locationId } = query;

  const filter = {
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(departmentId ? { departmentId: oid(departmentId) } : {}),
    ...(locationId ? { locationId: oid(locationId) } : {}),
  };

  const [rows, total] = await Promise.all([
    JobRequisition.find(filter)
      .sort({ status: 1, createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    JobRequisition.countDocuments(filter),
  ]);

  return { data: await enrich(rows), total, page, pageSize };
}

export async function getRequisition(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Requisition');
  const row = await JobRequisition.findOne({ _id: id, deletedAt: null }).lean();
  if (!row) throw new HrmsNotFoundError('Requisition');
  return (await enrich([row]))[0];
}

// ---------------------------------------------------------------------------
// Requisition writes
// ---------------------------------------------------------------------------

/** Refuse a department or location id that does not resolve (AD-2). */
async function assertOrgReferences(input) {
  if (input.departmentId) {
    const dept = await resolveDepartment(input.departmentId).catch(() => null);
    if (!dept) {
      throw new HrmsValidationError('Unknown department.', [
        { path: 'departmentId', message: 'That department does not exist.' },
      ]);
    }
  }
  if (input.locationId) {
    const loc = await resolveLocation(input.locationId).catch(() => null);
    if (!loc) {
      throw new HrmsValidationError('Unknown location.', [
        { path: 'locationId', message: 'That location does not exist.' },
      ]);
    }
  }
}

export async function createRequisition(input, context = {}) {
  await assertOrgReferences(input);

  const row = await JobRequisition.create({
    ...input,
    departmentId: input.departmentId ? oid(input.departmentId) : null,
    locationId: input.locationId ? oid(input.locationId) : null,
    budgetMin: decimalOrNull(input.budgetMin),
    budgetMax: decimalOrNull(input.budgetMax),
    status: 'draft',
    createdByUserId: context.user?._id ?? null,
  });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.REQUISITION_CREATED,
    `Raised a requisition for ${row.headcount} × ${row.title}`,
    context.req,
    { meta: { requisitionId: idStr(row._id), title: row.title, headcount: row.headcount } },
  );

  return getRequisition(row._id);
}

/** Only a draft is editable — an approved requisition is a signed-off budget. */
export async function updateRequisition(id, input, context = {}) {
  const existing = await loadRequisition(id);
  if (existing.status !== 'draft') {
    throw new HrmsConflictError(
      `A ${existing.status} requisition can no longer be edited. Raise a new one instead.`,
      { code: 'REQUISITION_NOT_EDITABLE' },
    );
  }
  await assertOrgReferences(input);

  // Range checked against the MERGED row: the schema can only compare the two
  // values when both are in the same request, and an update that lowers only
  // the maximum would otherwise slip past.
  const merged = {
    budgetMin: input.budgetMin !== undefined ? input.budgetMin : fromDecimal(existing.budgetMin),
    budgetMax: input.budgetMax !== undefined ? input.budgetMax : fromDecimal(existing.budgetMax),
  };
  if (merged.budgetMin && merged.budgetMax && Number(merged.budgetMin) > Number(merged.budgetMax)) {
    throw new HrmsValidationError('The minimum budget cannot exceed the maximum.', [
      { path: 'budgetMin', message: 'Lower the minimum, or raise the maximum.' },
    ]);
  }

  const $set = { ...input };
  if (input.departmentId !== undefined) $set.departmentId = input.departmentId ? oid(input.departmentId) : null;
  if (input.locationId !== undefined) $set.locationId = input.locationId ? oid(input.locationId) : null;
  if (input.budgetMin !== undefined) $set.budgetMin = decimalOrNull(input.budgetMin);
  if (input.budgetMax !== undefined) $set.budgetMax = decimalOrNull(input.budgetMax);

  await JobRequisition.updateOne({ _id: id }, { $set });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.REQUISITION_UPDATED,
    `Updated the requisition "${existing.title}"`,
    context.req,
    { meta: { requisitionId: idStr(id), changed: Object.keys(input) } },
  );

  return getRequisition(id);
}

/**
 * Approve a draft requisition.
 *
 * 🔴 The creator cannot approve their own. The reference checks only
 * `hiring:edit:org` — which whoever raised it already holds — so the person
 * asking for headcount signs off on their own budget. That is the same
 * separation of duties Payroll enforces on corrections.
 */
export async function approveRequisition(id, actor, context = {}) {
  const existing = await loadRequisition(id);
  assertRequisitionTransition(existing.status, 'approved');

  if (
    existing.createdByUserId &&
    context.user?._id &&
    idStr(existing.createdByUserId) === idStr(context.user._id)
  ) {
    throw new HrmsForbiddenError(
      'You raised this requisition, so somebody else must approve it.',
    );
  }

  const row = await JobRequisition.findOneAndUpdate(
    // Conditional on the status we validated, so two approvers cannot both win.
    { _id: id, status: 'draft' },
    {
      $set: {
        status: 'approved',
        approvedByUserId: context.user?._id ?? null,
        approvedAt: new Date(),
      },
    },
    { new: true },
  );
  if (!row) {
    throw new HrmsConflictError('The requisition changed before it could be approved.', {
      code: 'REQUISITION_INVALID_TRANSITION',
    });
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.REQUISITION_APPROVED,
    `Approved the requisition "${row.title}" (${row.headcount} position(s))`,
    context.req,
    {
      meta: {
        requisitionId: idStr(id),
        title: row.title,
        headcount: row.headcount,
        raisedBy: idStr(existing.createdByUserId),
      },
    },
  );

  /**
   * Tell whoever raised it — the reference's own notification, and its own
   * guard: approving your own requisition tells you nothing you did not just
   * do.
   *
   * A requisition records its raiser as a USER id (the reference's shape,
   * inherited by this model), so this goes through `notifyUsers`, which
   * resolves it to the employee the rest of the system speaks in.
   */
  if (
    existing.createdByUserId &&
    idStr(existing.createdByUserId) !== idStr(context.user?._id)
  ) {
    await notifyUsers({
      toUserIds: idStr(existing.createdByUserId),
      type: INBOX_TYPES.REQUISITION_APPROVED,
      title: `Requisition approved: ${row.title}`,
      body: `${row.headcount} position(s).`,
      entity: 'job_requisition',
      entityId: idStr(id),
    });
  }

  return getRequisition(id);
}

export async function setRequisitionStatus(id, input, context = {}) {
  const existing = await loadRequisition(id);
  assertRequisitionTransition(existing.status, input.status);

  // `approved` is reached only through `approve`, which carries the
  // self-approval check and stamps who signed it off.
  if (input.status === 'approved') {
    throw new HrmsValidationError('Use the approve action to approve a requisition.');
  }

  const row = await JobRequisition.findOneAndUpdate(
    { _id: id, status: existing.status },
    {
      $set: {
        status: input.status,
        ...(input.status === 'cancelled' ? { cancellationReason: input.reason } : {}),
      },
    },
    { new: true },
  );
  if (!row) {
    throw new HrmsConflictError('The requisition changed before it could be updated.', {
      code: 'REQUISITION_INVALID_TRANSITION',
    });
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.REQUISITION_STATUS_CHANGED,
    `Requisition "${row.title}" moved from ${existing.status} to ${input.status}`,
    context.req,
    {
      meta: {
        requisitionId: idStr(id),
        from: existing.status,
        to: input.status,
        reason: input.reason ?? null,
      },
    },
  );

  return getRequisition(id);
}

/**
 * Check a move against the declared table.
 *
 * One place, one message. `REQUISITION_TRANSITIONS` is data, so a test can
 * assert the whole machine rather than probing for branches.
 */
export function assertRequisitionTransition(from, to) {
  const allowed = REQUISITION_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new HrmsConflictError(
      TERMINAL_REQUISITION_STATUSES.includes(from)
        ? `A ${from} requisition is final and cannot be changed.`
        : `A ${from} requisition cannot move to ${to}. It may only move to: ${allowed.join(', ') || 'nothing'}.`,
      { code: 'REQUISITION_INVALID_TRANSITION' },
    );
  }
}

async function loadRequisition(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Requisition');
  const row = await JobRequisition.findOne({ _id: id, deletedAt: null }).lean();
  if (!row) throw new HrmsNotFoundError('Requisition');
  return row;
}

export { loadRequisition };

// ===========================================================================
// Postings
// ===========================================================================

const postingDto = (row, extras = {}) => ({
  id: idStr(row._id),
  requisitionId: idStr(row.requisitionId),
  requisitionTitle: extras.requisitionTitle ?? null,
  publicSlug: row.publicSlug,
  description: row.description,
  requirements: row.requirements,
  boardIntegrations: row.boardIntegrations ?? [],
  publishedAt: row.publishedAt ? new Date(row.publishedAt).toISOString() : null,
  closedAt: row.closedAt ? new Date(row.closedAt).toISOString() : null,
  isLive: Boolean(row.publishedAt) && !row.closedAt,
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
});

/**
 * Build a public slug from the title.
 *
 * Server-generated, with a random suffix. The suffix is not decoration: two
 * "Senior Engineer" requisitions must not collide, and a guessable slug lets an
 * outsider enumerate what a company is hiring for before it is announced.
 */
function buildSlug(title) {
  const base = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'role';
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

export async function listPostings(query = {}) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, requisitionId, published } = query;

  const filter = {
    deletedAt: null,
    ...(requisitionId ? { requisitionId: oid(requisitionId) } : {}),
    ...(published === true ? { publishedAt: { $ne: null }, closedAt: null } : {}),
  };

  const [rows, total] = await Promise.all([
    JobPosting.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    JobPosting.countDocuments(filter),
  ]);

  const requisitions = await JobRequisition.find({
    _id: { $in: [...new Set(rows.map((r) => idStr(r.requisitionId)))] },
  })
    .select('title')
    .lean();
  const titles = new Map(requisitions.map((r) => [idStr(r._id), r.title]));

  return {
    data: rows.map((r) => postingDto(r, { requisitionTitle: titles.get(idStr(r.requisitionId)) })),
    total,
    page,
    pageSize,
  };
}

export async function createPosting(input, context = {}) {
  const requisition = await loadRequisition(input.requisitionId);

  // A draft has not been signed off, and a closed one is not hiring. Posting
  // either publicly would advertise a role nobody approved.
  if (!['approved', 'open'].includes(requisition.status)) {
    throw new HrmsConflictError(
      `A ${requisition.status} requisition cannot be posted. Approve it first.`,
      { code: 'REQUISITION_NOT_POSTABLE' },
    );
  }

  const row = await JobPosting.create({
    requisitionId: oid(input.requisitionId),
    publicSlug: buildSlug(requisition.title),
    description: input.description,
    requirements: input.requirements,
    boardIntegrations: input.boardIntegrations ?? [],
    createdByUserId: context.user?._id ?? null,
  });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.POSTING_CREATED,
    `Drafted a posting for "${requisition.title}"`,
    context.req,
    { meta: { postingId: idStr(row._id), requisitionId: idStr(requisition._id), slug: row.publicSlug } },
  );

  return postingDto(row.toObject(), { requisitionTitle: requisition.title });
}

/** Publishing makes the posting public and opens its requisition. */
export async function publishPosting(id, context = {}) {
  const posting = await loadPosting(id);
  if (posting.publishedAt) {
    throw new HrmsConflictError('That posting is already published.', {
      code: 'POSTING_ALREADY_PUBLISHED',
    });
  }
  if (posting.closedAt) {
    throw new HrmsConflictError('That posting has been closed and cannot be republished.', {
      code: 'POSTING_CLOSED',
    });
  }

  const requisition = await loadRequisition(posting.requisitionId);
  if (!['approved', 'open'].includes(requisition.status)) {
    throw new HrmsConflictError(
      `A ${requisition.status} requisition cannot be published.`,
      { code: 'REQUISITION_NOT_POSTABLE' },
    );
  }

  await JobPosting.updateOne({ _id: id }, { $set: { publishedAt: new Date() } });

  // approved -> open, as in the reference. Guarded by the same table as every
  // other move, so a requisition already `open` is left alone rather than
  // written again.
  if (requisition.status === 'approved') {
    await JobRequisition.updateOne(
      { _id: requisition._id, status: 'approved' },
      { $set: { status: 'open' } },
    );
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.POSTING_PUBLISHED,
    `Published "${requisition.title}" to the careers page`,
    context.req,
    { meta: { postingId: idStr(id), requisitionId: idStr(requisition._id), slug: posting.publicSlug } },
  );

  return (await listPostings({ requisitionId: requisition._id })).data.find(
    (p) => p.id === idStr(id),
  );
}

export async function closePosting(id, context = {}) {
  const posting = await loadPosting(id);
  if (posting.closedAt) {
    throw new HrmsConflictError('That posting is already closed.', { code: 'POSTING_CLOSED' });
  }

  await JobPosting.updateOne({ _id: id }, { $set: { closedAt: new Date() } });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.POSTING_CLOSED,
    `Closed the posting ${posting.publicSlug}`,
    context.req,
    { meta: { postingId: idStr(id), slug: posting.publicSlug } },
  );

  const row = await JobPosting.findById(id).lean();
  return postingDto(row);
}

async function loadPosting(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Posting');
  const row = await JobPosting.findOne({ _id: id, deletedAt: null }).lean();
  if (!row) throw new HrmsNotFoundError('Posting');
  return row;
}

export { postingDto, loadPosting, buildSlug };

export default {
  listRequisitions,
  getRequisition,
  createRequisition,
  updateRequisition,
  approveRequisition,
  setRequisitionStatus,
  listPostings,
  createPosting,
  publishPosting,
  closePosting,
};
