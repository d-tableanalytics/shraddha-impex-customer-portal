/**
 * Continuous feedback — praise and constructive notes, given any time.
 *
 * Ported from the reference's `feedback.service.ts`.
 *
 * ---------------------------------------------------------------------------
 * Anonymity is a PRESENTATION rule, not a storage one
 * ---------------------------------------------------------------------------
 * The sender is always recorded. The reference does the same and gives the
 * reason — moderation — then scrubs the identity from the DTO for anyone but
 * the sender. That is the right shape: anonymous feedback that is anonymous at
 * rest cannot be moderated when it turns abusive, and nobody can be held to it.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections
 * ---------------------------------------------------------------------------
 * 1. NO SENTINEL ID. The reference returns the zero UUID
 *    `00000000-0000-0000-0000-000000000000` as the sender of anonymous
 *    feedback. A magic value is a value some client will eventually compare,
 *    render or look up; the field is simply `null` here.
 *
 * 2. THE LISTS ARE PAGINATED (AD-13). The reference returns every note ever
 *    received, unbounded.
 *
 * 3. THE RECIPIENT MUST BE A LIVE EMPLOYEE. The reference checks only that the
 *    recipient is not the sender.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import { Feedback } from '../../../models/hrms/PerformanceModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import { HrmsForbiddenError, HrmsValidationError } from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const nameOf = (e) => `${e?.firstName ?? ''} ${e?.lastName ?? ''}`.trim() || 'Unknown';

/**
 * The wire shape, with anonymity applied.
 *
 * `viewerEmployeeId` decides whether the sender is named: the sender always
 * sees their own note, and nobody else sees behind an anonymous one.
 */
const toDto = (row, viewerEmployeeId) => {
  const anonymous = row.visibility === 'anonymous';
  const isSender = Boolean(viewerEmployeeId) && idStr(row.fromEmployeeId) === idStr(viewerEmployeeId);
  const reveal = !anonymous || isSender;

  return {
    id: idStr(row._id),
    // Absent, not a sentinel — see note 1.
    fromEmployeeId: reveal ? idStr(row.fromEmployeeId) : null,
    fromName: reveal ? row.fromName ?? null : 'Anonymous',
    anonymous,
    toEmployeeId: idStr(row.toEmployeeId),
    toName: row.toName ?? null,
    kind: row.kind,
    message: row.message,
    visibility: row.visibility,
    tags: row.tags ?? [],
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  };
};

async function paged(filter, query, viewerEmployeeId) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, kind } = query;
  const where = { ...filter, ...(kind ? { kind } : {}) };

  const [rows, total] = await Promise.all([
    Feedback.find(where)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Feedback.countDocuments(where),
  ]);

  return { data: rows.map((r) => toDto(r, viewerEmployeeId)), total, page, pageSize };
}

/** Notes written TO the caller. Anonymous senders stay anonymous here. */
export async function listReceivedFeedback(actor, query = {}) {
  if (!actor?.employeeId) return { data: [], total: 0, page: 1, pageSize: PAGE_SIZE_DEFAULT };
  return paged({ toEmployeeId: oid(actor.employeeId) }, query, actor.employeeId);
}

/** Notes written BY the caller. They see their own name on anonymous ones. */
export async function listGivenFeedback(actor, query = {}) {
  if (!actor?.employeeId) return { data: [], total: 0, page: 1, pageSize: PAGE_SIZE_DEFAULT };
  return paged({ fromEmployeeId: oid(actor.employeeId) }, query, actor.employeeId);
}

export async function giveFeedback(input, context = {}) {
  const actor = context.actor;
  if (!actor?.employeeId) {
    throw new HrmsForbiddenError('You need an employee record to give feedback.');
  }

  if (idStr(input.toEmployeeId) === idStr(actor.employeeId)) {
    throw new HrmsForbiddenError('You cannot give feedback to yourself.');
  }

  const [sender, recipient] = await Promise.all([
    Employee.findOne({ _id: actor.employeeId, deletedAt: null })
      .select('_id firstName lastName')
      .lean(),
    Employee.findOne({ _id: input.toEmployeeId, deletedAt: null })
      .select('_id firstName lastName status')
      .lean()
      .catch(() => null),
  ]);

  if (!recipient) {
    throw new HrmsValidationError('Unknown colleague.', [
      { path: 'toEmployeeId', message: 'That employee does not exist.' },
    ]);
  }
  if (['exited', 'inactive'].includes(recipient.status)) {
    throw new HrmsValidationError('That colleague has left.', [
      { path: 'toEmployeeId', message: 'Choose somebody who is still with the company.' },
    ]);
  }

  const row = await Feedback.create({
    fromEmployeeId: oid(actor.employeeId),
    fromName: nameOf(sender),
    toEmployeeId: recipient._id,
    toName: nameOf(recipient),
    kind: input.kind,
    message: input.message,
    visibility: input.visibility,
    tags: input.tags,
    createdByUserId: context.user?._id ?? null,
  });

  /**
   * The audit entry names the sender even for anonymous feedback — that is
   * what makes moderation possible, and it is the same reason the column is
   * retained. The MESSAGE is not copied into the trail: an audit log is read
   * by more people than a private note is.
   */
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.FEEDBACK_GIVEN,
    `Gave ${input.kind} feedback to ${nameOf(recipient)}${
      input.visibility === 'anonymous' ? ' (anonymous to the recipient)' : ''
    }`,
    context.req,
    {
      meta: {
        feedbackId: idStr(row._id),
        toEmployeeId: idStr(recipient._id),
        kind: input.kind,
        visibility: input.visibility,
      },
    },
  );

  return toDto(row.toObject(), actor.employeeId);
}

export { toDto as feedbackDto };

export default { listReceivedFeedback, listGivenFeedback, giveFeedback };
