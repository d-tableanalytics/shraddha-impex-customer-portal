/**
 * Review responses — one row per (cycle × employee × reviewer × kind).
 *
 * Ported from the reference's `review-response.service.ts`.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections
 * ---------------------------------------------------------------------------
 * 1. PEER AND SKIP-LEVEL REVIEWS CAN ACTUALLY BE ASSIGNED. The reference sets
 *    `reviewerUserId = actor.userId` for both kinds, with an inline
 *    `// stub — real flow lets HR pick the reviewer` — so HR assigning a peer
 *    review assigns it to themselves, and two of the four review kinds are
 *    unusable. The reviewer is an explicit, validated input here.
 *
 * 2. AN EMPLOYEE CAN SEE THE REVIEWS WRITTEN ABOUT THEM. The reference's only
 *    listing is keyed on `reviewerUserId`, so a submitted manager review is
 *    collected and then never shown to its subject. `listAboutMe` exposes
 *    submitted responses about the caller — which is the entire point of
 *    running a review cycle.
 *
 * 3. THE SUBJECT MUST BE A LIVE EMPLOYEE. The reference resolves the employee
 *    and never checks `deletedAt` or status, so a review can be opened against
 *    somebody who has left.
 *
 * 4. RATINGS ARE CHECKED AGAINST THE CYCLE'S COMPETENCIES. The reference
 *    accepts any keys at all, so a rating can be filed under a competency the
 *    cycle does not have — and it is then invisible on every screen.
 *
 * 5. THE LISTS ARE PAGINATED (AD-13).
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import {
  ReviewCycle,
  ReviewResponse,
} from '../../../models/hrms/PerformanceModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { notify } from '../inbox/notifier.service.js';
import { INBOX_TYPES } from '../../../shared/constants/inbox.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import { RESPONSE_OPEN_PHASES } from '../../../shared/constants/performance.js';
import { hasHrmsPermission } from '../../../shared/permissions/has-permission.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsForbiddenError,
  HrmsValidationError,
} from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const nameOf = (e) => `${e?.firstName ?? ''} ${e?.lastName ?? ''}`.trim() || 'Unknown';

/** A Mongoose Map, or a plain object from `.lean()`, as a plain object. */
const ratingsOf = (v) => {
  if (!v) return {};
  if (v instanceof Map) return Object.fromEntries(v);
  return { ...v };
};

const toDto = (row) => ({
  id: idStr(row._id),
  cycleId: idStr(row.cycleId),
  cycleName: row.cycleName ?? null,
  employeeId: idStr(row.employeeId),
  employeeName: row.employeeName ?? null,
  reviewerEmployeeId: idStr(row.reviewerEmployeeId),
  reviewerName: row.reviewerName ?? null,
  kind: row.kind,
  ratings: ratingsOf(row.ratings),
  overallRating: row.overallRating ?? null,
  comments: row.comments ?? null,
  submittedAt: row.submittedAt ? new Date(row.submittedAt).toISOString() : null,
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The caller's own review queue — what they have been asked to write.
 *
 * No id is accepted: the reviewer comes from the session, so there is nothing
 * on the wire to tamper with and no permission beyond having an employee
 * record. Served by the `(reviewerEmployeeId, submittedAt)` index.
 */
export async function listMyReviews(actor, query = {}) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, cycleId, kind, submitted } = query;
  if (!actor?.employeeId) return { data: [], total: 0, page, pageSize };

  const filter = {
    reviewerEmployeeId: oid(actor.employeeId),
    ...(cycleId ? { cycleId: oid(cycleId) } : {}),
    ...(kind ? { kind } : {}),
    ...(submitted === undefined ? {} : { submittedAt: submitted ? { $ne: null } : null }),
  };

  const [rows, total] = await Promise.all([
    // Outstanding first, then most recent.
    ReviewResponse.find(filter)
      .sort({ submittedAt: 1, createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    ReviewResponse.countDocuments(filter),
  ]);

  return { data: rows.map(toDto), total, page, pageSize };
}

/**
 * The reviews written ABOUT the caller.
 *
 * 🔴 The reference has no such endpoint. It collects self, manager and peer
 * reviews and never shows any of them to their subject — the person the whole
 * exercise is about. Only SUBMITTED responses are returned, and only once the
 * cycle has reached calibration or closed, so an employee cannot watch their
 * manager's assessment take shape mid-cycle.
 */
export async function listReviewsAboutMe(actor, query = {}) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, cycleId } = query;
  if (!actor?.employeeId) return { data: [], total: 0, page, pageSize };

  const visibleCycles = await ReviewCycle.find({ phase: { $in: ['calibration', 'closed'] } })
    .select('_id')
    .lean();
  if (visibleCycles.length === 0) return { data: [], total: 0, page, pageSize };

  const filter = {
    employeeId: oid(actor.employeeId),
    submittedAt: { $ne: null },
    cycleId: cycleId
      ? oid(cycleId)
      : { $in: visibleCycles.map((c) => c._id) },
    ...(cycleId && !visibleCycles.some((c) => idStr(c._id) === idStr(cycleId))
      ? // Asked for a cycle that has not reached calibration — nothing to show.
        { _id: null }
      : {}),
  };

  const [rows, total] = await Promise.all([
    ReviewResponse.find(filter)
      .sort({ submittedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    ReviewResponse.countDocuments(filter),
  ]);

  /**
   * An anonymous-by-convention read: peer and skip-level reviewers are not
   * named to their subject. The reference names everybody, everywhere.
   */
  const data = rows.map((row) => {
    const dto = toDto(row);
    if (row.kind === 'peer' || row.kind === 'skip_level') {
      dto.reviewerEmployeeId = null;
      dto.reviewerName = row.kind === 'peer' ? 'A peer' : 'A skip-level reviewer';
    }
    return dto;
  });

  return { data, total, page, pageSize };
}

/** Every response in a cycle. HR's view, for calibration and chasing. */
export async function listCycleReviews(query = {}) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, cycleId, employeeId, kind, submitted } = query;

  const filter = {
    ...(cycleId ? { cycleId: oid(cycleId) } : {}),
    ...(employeeId ? { employeeId: oid(employeeId) } : {}),
    ...(kind ? { kind } : {}),
    ...(submitted === undefined ? {} : { submittedAt: submitted ? { $ne: null } : null }),
  };

  const [rows, total] = await Promise.all([
    ReviewResponse.find(filter)
      .sort({ employeeId: 1, kind: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    ReviewResponse.countDocuments(filter),
  ]);

  return { data: rows.map(toDto), total, page, pageSize };
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * Open a review row.
 *
 * Reviewer resolution follows the reference for `self` and `manager`, and
 * FIXES `peer`/`skip_level`, which the reference leaves as a stub pointing at
 * whoever clicked the button.
 */
export async function createReview(input, context = {}) {
  const actor = context.actor;

  const cycle = await ReviewCycle.findById(input.cycleId).lean().catch(() => null);
  if (!cycle) {
    throw new HrmsValidationError('Unknown cycle.', [
      { path: 'cycleId', message: 'That review cycle does not exist.' },
    ]);
  }
  if (!RESPONSE_OPEN_PHASES.includes(cycle.phase)) {
    throw new HrmsConflictError(
      `This cycle is in ${cycle.phase.replace('_', ' ')}, so reviews cannot be opened in it.`,
      { code: 'CYCLE_NOT_ACCEPTING_REVIEWS' },
    );
  }

  const employee = await Employee.findOne({ _id: input.employeeId, deletedAt: null })
    .select('_id firstName lastName userId reportingManagerId status')
    .lean()
    .catch(() => null);
  if (!employee) {
    throw new HrmsValidationError('Unknown employee.', [
      { path: 'employeeId', message: 'That employee does not exist.' },
    ]);
  }
  // 🔴 The reference never checks this — a review can be opened on somebody
  // who has already left.
  if (['exited', 'inactive'].includes(employee.status)) {
    throw new HrmsConflictError('That employee has left, so a review cannot be opened for them.', {
      code: 'EMPLOYEE_NOT_REVIEWABLE',
    });
  }

  const reviewer = await resolveReviewer(input, employee, actor);

  // Pre-checked only for a better message than a duplicate-key error; the
  // unique index is the guarantee.
  const existing = await ReviewResponse.findOne({
    cycleId: oid(input.cycleId),
    employeeId: oid(input.employeeId),
    reviewerEmployeeId: reviewer._id,
    kind: input.kind,
  })
    .select('_id')
    .lean();
  if (existing) {
    throw new HrmsConflictError('That review has already been opened.', {
      code: 'REVIEW_EXISTS',
    });
  }

  let row;
  try {
    row = await ReviewResponse.create({
      cycleId: cycle._id,
      cycleName: cycle.name,
      employeeId: employee._id,
      employeeName: nameOf(employee),
      reviewerEmployeeId: reviewer._id,
      reviewerName: nameOf(reviewer),
      kind: input.kind,
      createdByUserId: context.user?._id ?? null,
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError('That review has already been opened.', {
        code: 'REVIEW_EXISTS',
      });
    }
    throw error;
  }

  /**
   * The reference files an inbox item for the reviewer here, and Inbox now
   * exists — so this does too. The recipient is the review's OWN reviewer,
   * resolved and validated above; nothing about it comes from the request
   * beyond the id that was already checked.
   *
   * Self-assignment notifies nobody, which is the reference's rule
   * (`if (reviewerUserId !== actor.userId)`): being told to review yourself,
   * by yourself, in the same click, is noise.
   */
  if (idStr(reviewer._id) !== idStr(context.actor?.employeeId)) {
    await notify({
      to: idStr(reviewer._id),
      type: INBOX_TYPES.REVIEW_ASSIGNED,
      title: `Review pending: ${nameOf(employee)}`,
      body: `${input.kind.replace('_', ' ')} review in "${cycle.name}".`,
      entity: 'review_response',
      entityId: idStr(row._id),
    });
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.REVIEW_RESPONSE_CREATED,
    `Opened a ${input.kind.replace('_', ' ')} review of ${nameOf(employee)} for ${nameOf(reviewer)} in "${cycle.name}"`,
    context.req,
    {
      meta: {
        reviewId: idStr(row._id),
        cycleId: idStr(cycle._id),
        employeeId: idStr(employee._id),
        reviewerEmployeeId: idStr(reviewer._id),
        kind: input.kind,
      },
    },
  );

  return toDto(row.toObject());
}

/**
 * Who writes this review, and may the actor open it?
 *
 *   self        the employee themselves, and only they may open it
 *   manager     the employee's reporting manager — that manager, or HR
 *   peer        an explicitly chosen colleague — HR, or the employee's manager
 *   skip_level  the same, and the reviewer must not be the direct manager
 */
async function resolveReviewer(input, employee, actor) {
  const isHr = hasHrmsPermission(actor, M.PERFORMANCE, A.APPROVE, S.ORG);
  const actorEmployeeId = idStr(actor?.employeeId);

  if (input.kind === 'self') {
    if (actorEmployeeId !== idStr(employee._id)) {
      throw new HrmsForbiddenError('Only the employee can open their own self-review.');
    }
    return employee;
  }

  if (input.kind === 'manager') {
    if (!employee.reportingManagerId) {
      throw new HrmsValidationError('That employee has no reporting manager.', [
        { path: 'employeeId', message: 'Set a reporting manager before opening a manager review.' },
      ]);
    }
    const manager = await loadLiveEmployee(employee.reportingManagerId, 'reportingManager');
    if (idStr(manager._id) !== actorEmployeeId && !isHr) {
      throw new HrmsForbiddenError('Only the reporting manager or HR can open this review.');
    }
    return manager;
  }

  // peer / skip_level — the reference's stub. The reviewer is explicit here,
  // and the schema requires it.
  const canAssign =
    isHr ||
    (Boolean(actorEmployeeId) && idStr(employee.reportingManagerId) === actorEmployeeId);
  if (!canAssign) {
    throw new HrmsForbiddenError(
      'Only HR or the employee’s manager can assign a peer or skip-level review.',
    );
  }

  const reviewer = await loadLiveEmployee(input.reviewerEmployeeId, 'reviewerEmployeeId');
  if (idStr(reviewer._id) === idStr(employee._id)) {
    throw new HrmsValidationError('Somebody cannot peer-review themselves.', [
      { path: 'reviewerEmployeeId', message: 'Choose a different colleague.' },
    ]);
  }
  if (input.kind === 'skip_level' && idStr(reviewer._id) === idStr(employee.reportingManagerId)) {
    throw new HrmsValidationError('A skip-level review cannot come from the direct manager.', [
      { path: 'reviewerEmployeeId', message: 'Choose somebody above the reporting manager.' },
    ]);
  }
  return reviewer;
}

async function loadLiveEmployee(id, path) {
  const row = await Employee.findOne({ _id: id, deletedAt: null })
    .select('_id firstName lastName userId status reportingManagerId')
    .lean()
    .catch(() => null);
  if (!row) {
    throw new HrmsValidationError('Unknown employee.', [
      { path, message: 'That employee does not exist.' },
    ]);
  }
  if (['exited', 'inactive'].includes(row.status)) {
    throw new HrmsValidationError('That employee has left.', [
      { path, message: 'Choose somebody who is still with the company.' },
    ]);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/**
 * File the review.
 *
 * Only the assigned reviewer, once, and only while the cycle is still
 * accepting — the reference checks the reviewer and the once, but not the
 * phase, so a review can be filed into a closed cycle.
 */
export async function submitReview(id, input, context = {}) {
  const actor = context.actor;
  const row = await loadReview(id);

  if (!actor?.employeeId || idStr(row.reviewerEmployeeId) !== idStr(actor.employeeId)) {
    throw new HrmsForbiddenError('Only the assigned reviewer can submit this review.');
  }
  if (row.submittedAt) {
    throw new HrmsConflictError('This review has already been submitted.', {
      code: 'REVIEW_ALREADY_SUBMITTED',
    });
  }

  const cycle = await ReviewCycle.findById(row.cycleId).select('phase name competencies').lean();
  if (!cycle || !RESPONSE_OPEN_PHASES.includes(cycle.phase)) {
    throw new HrmsConflictError(
      `This cycle is in ${cycle?.phase ?? 'an unknown phase'}, so reviews can no longer be filed in it.`,
      { code: 'CYCLE_NOT_ACCEPTING_REVIEWS' },
    );
  }

  /**
   * 🔴 Every rated key must be a competency this cycle actually declares. The
   * reference accepts any key, and a rating under an unknown one is then
   * invisible on every screen that renders the template.
   */
  const known = new Set((cycle.competencies ?? []).map((c) => c.key));
  const unknown = Object.keys(input.ratings).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new HrmsValidationError('Unknown competency.', [
      {
        path: 'ratings',
        message: `This cycle has no competenc(ies) called: ${unknown.join(', ')}.`,
      },
    ]);
  }

  const updated = await ReviewResponse.findOneAndUpdate(
    // Conditional on still being unsubmitted, so a double submit cannot file twice.
    { _id: row._id, submittedAt: null },
    {
      $set: {
        ratings: input.ratings,
        overallRating: input.overallRating,
        comments: input.comments ?? null,
        submittedAt: new Date(),
      },
    },
    { new: true },
  );
  if (!updated) {
    throw new HrmsConflictError('This review was submitted before your request completed.', {
      code: 'REVIEW_ALREADY_SUBMITTED',
    });
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.REVIEW_RESPONSE_SUBMITTED,
    `Submitted a ${row.kind.replace('_', ' ')} review of ${row.employeeName} rated ${input.overallRating}/5`,
    context.req,
    {
      meta: {
        reviewId: idStr(row._id),
        cycleId: idStr(row.cycleId),
        employeeId: idStr(row.employeeId),
        kind: row.kind,
        overallRating: input.overallRating,
      },
    },
  );

  return toDto(updated.toObject());
}

/** One review, readable by its reviewer, its subject's org viewers, or HR. */
export async function getReview(id, actor) {
  const row = await loadReview(id);

  const isReviewer =
    Boolean(actor?.employeeId) && idStr(row.reviewerEmployeeId) === idStr(actor.employeeId);
  const isSubject =
    Boolean(actor?.employeeId) && idStr(row.employeeId) === idStr(actor.employeeId);
  const isOrg = hasHrmsPermission(actor, M.PERFORMANCE, A.VIEW, S.ORG);

  // The subject sees it only once submitted — mid-flight drafts are the
  // reviewer's until they are filed.
  if (isReviewer || isOrg || (isSubject && row.submittedAt)) return toDto(row);
  throw new HrmsNotFoundError('Review');
}

// ---------------------------------------------------------------------------

export async function loadReview(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Review');
  const row = await ReviewResponse.findById(id).lean();
  if (!row) throw new HrmsNotFoundError('Review');
  return row;
}

export { toDto as reviewDto, resolveReviewer };

export default {
  listMyReviews,
  listReviewsAboutMe,
  listCycleReviews,
  createReview,
  submitReview,
  getReview,
};
