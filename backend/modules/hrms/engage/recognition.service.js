/**
 * Recognition — peer-to-peer kudos, with optional badges.
 *
 * Ported from the reference's `recognition.service.ts`.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections
 * ---------------------------------------------------------------------------
 * 1. NO SENTINEL ID. 🔴 The reference returns the zero UUID
 *    `00000000-0000-0000-0000-000000000000` as the sender of an anonymous
 *    recognition. A magic value is one a client will eventually compare,
 *    render or try to resolve; the field is simply absent here.
 *
 * 2. THE RECIPIENT MUST BE A LIVE EMPLOYEE. The reference checks only that the
 *    row exists, so kudos can be sent to somebody who has left or been deleted.
 *
 * 3. THE LISTS ARE PAGINATED (AD-13). The reference caps the wall at 100 and
 *    leaves `received` unbounded.
 *
 * 4. THE BADGE IS COPIED AT WRITE TIME, so renaming or removing one never
 *    rewrites the history of recognitions given under it.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import { Recognition, RecognitionBadge } from '../../../models/hrms/EngageModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { notify } from '../inbox/notifier.service.js';
import { INBOX_TYPES } from '../../../shared/constants/inbox.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import {
  HrmsConflictError,
  HrmsForbiddenError,
  HrmsValidationError,
} from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const nameOf = (e) => `${e?.firstName ?? ''} ${e?.lastName ?? ''}`.trim() || 'Unknown';

/**
 * The wire shape, with anonymity applied.
 *
 * `viewerEmployeeId` decides whether the sender is named: a sender always sees
 * their own kudos in their "given" list, and nobody else sees behind an
 * anonymous one.
 */
const toDto = (row, viewerEmployeeId) => {
  const isSender =
    Boolean(viewerEmployeeId) && idStr(row.fromEmployeeId) === idStr(viewerEmployeeId);
  const reveal = !row.anonymous || isSender;

  return {
    id: idStr(row._id),
    // Absent, not a sentinel — see note 1.
    fromEmployeeId: reveal ? idStr(row.fromEmployeeId) : null,
    fromName: reveal ? row.fromName ?? null : 'Anonymous',
    toEmployeeId: idStr(row.toEmployeeId),
    toName: row.toName ?? null,
    badgeId: idStr(row.badgeId),
    badgeName: row.badgeName ?? null,
    badgeIconKey: row.badgeIconKey ?? null,
    message: row.message,
    teamVisible: row.teamVisible,
    anonymous: row.anonymous,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  };
};

async function paged(filter, query, viewerEmployeeId) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT } = query;

  const [rows, total] = await Promise.all([
    Recognition.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Recognition.countDocuments(filter),
  ]);

  return { data: rows.map((r) => toDto(r, viewerEmployeeId)), total, page, pageSize };
}

/**
 * The public wall — team-visible kudos only.
 *
 * A `teamVisible: false` recognition is between the two people involved and
 * never appears here. (The reference filters the same way and then still
 * renders a "Private" tag on the wall, which can never be reached.)
 */
export async function recognitionWall(query = {}, actor) {
  return paged({ teamVisible: true }, query, actor?.employeeId);
}

/** Kudos the caller has received, private ones included. */
export async function recognitionsReceived(query = {}, actor) {
  if (!actor?.employeeId) return { data: [], total: 0, page: 1, pageSize: PAGE_SIZE_DEFAULT };
  return paged({ toEmployeeId: oid(actor.employeeId) }, query, actor.employeeId);
}

/** Kudos the caller has given. They see their own name on anonymous ones. */
export async function recognitionsGiven(query = {}, actor) {
  if (!actor?.employeeId) return { data: [], total: 0, page: 1, pageSize: PAGE_SIZE_DEFAULT };
  return paged({ fromEmployeeId: oid(actor.employeeId) }, query, actor.employeeId);
}

export async function giveRecognition(input, context = {}) {
  const actor = context.actor;
  if (!actor?.employeeId) {
    throw new HrmsForbiddenError('You need an employee record to give recognition.');
  }
  if (idStr(input.toEmployeeId) === idStr(actor.employeeId)) {
    throw new HrmsForbiddenError('You cannot recognise yourself.');
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
  // 🔴 The reference checks only existence — see note 2.
  if (['exited', 'inactive'].includes(recipient.status)) {
    throw new HrmsValidationError('That colleague has left.', [
      { path: 'toEmployeeId', message: 'Choose somebody who is still with the company.' },
    ]);
  }

  let badge = null;
  if (input.badgeId) {
    badge = await RecognitionBadge.findById(input.badgeId)
      .select('_id name iconKey')
      .lean()
      .catch(() => null);
    if (!badge) {
      throw new HrmsValidationError('Unknown badge.', [
        { path: 'badgeId', message: 'That badge does not exist.' },
      ]);
    }
  }

  const row = await Recognition.create({
    fromEmployeeId: oid(actor.employeeId),
    fromName: nameOf(sender),
    toEmployeeId: recipient._id,
    toName: nameOf(recipient),
    badgeId: badge?._id ?? null,
    // Copied, not joined — see note 4.
    badgeName: badge?.name ?? null,
    badgeIconKey: badge?.iconKey ?? null,
    message: input.message,
    teamVisible: input.teamVisible,
    anonymous: input.anonymous,
    createdByUserId: context.user?._id ?? null,
  });

  /**
   * Tell the recipient — the reference's own notification, and Inbox now
   * exists to carry it. The recipient is the recognition's OWN target,
   * resolved and validated above.
   *
   * The notification KEEPS the anonymity the recognition was given under: an
   * anonymous kudos says "Someone recognised you", exactly as the reference's
   * does, so the trail and the notification tell the same story.
   *
   * 🔴 The message body is not copied in. The reference puts 200 characters of
   * it into the notification; the recipient opens their Received list and
   * reads the whole thing there.
   */
  await notify({
    to: idStr(recipient._id),
    type: INBOX_TYPES.RECOGNITION_RECEIVED,
    title: input.anonymous ? 'Someone recognised you' : `${nameOf(sender)} recognised you`,
    body: badge ? `Badge: ${badge.name}` : null,
    entity: 'recognition',
    entityId: idStr(row._id),
  });

  /**
   *
   * The audit entry NAMES the sender even for anonymous kudos — that is what
   * makes moderation possible, and it is the reason the column is retained.
   * The MESSAGE body is not copied into the trail: an audit log is read by more
   * people than a private note is.
   */
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.RECOGNITION_GIVEN,
    `Recognised ${nameOf(recipient)}${badge ? ` with the "${badge.name}" badge` : ''}${
      input.anonymous ? ' (anonymous to the recipient)' : ''
    }`,
    context.req,
    {
      meta: {
        recognitionId: idStr(row._id),
        toEmployeeId: idStr(recipient._id),
        badgeId: idStr(badge?._id),
        teamVisible: input.teamVisible,
        anonymous: input.anonymous,
      },
    },
  );

  return toDto(row.toObject(), actor.employeeId);
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

const badgeDto = (row, extras = {}) => ({
  id: idStr(row._id),
  name: row.name,
  iconKey: row.iconKey,
  description: row.description ?? null,
  awardedCount: extras.awardedCount ?? 0,
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
});

/**
 * Every badge, with how often each has been awarded.
 *
 * Unpaginated on purpose: a badge catalogue is a fixed, small vocabulary that
 * the give-recognition form has to render in full, and paging a picker is not
 * a picker. Two queries regardless of size.
 */
export async function listBadges() {
  const rows = await RecognitionBadge.find({}).sort({ name: 1 }).lean();
  if (rows.length === 0) return [];

  const counts = await Recognition.aggregate([
    { $match: { badgeId: { $in: rows.map((r) => r._id) } } },
    { $group: { _id: '$badgeId', n: { $sum: 1 } } },
  ]);
  const byBadge = new Map(counts.map((c) => [idStr(c._id), c.n]));

  return rows.map((r) => badgeDto(r, { awardedCount: byBadge.get(idStr(r._id)) ?? 0 }));
}

export async function createBadge(input, context = {}) {
  let row;
  try {
    row = await RecognitionBadge.create({
      name: input.name,
      iconKey: input.iconKey,
      description: input.description ?? null,
      createdByUserId: context.user?._id ?? null,
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError(`A badge called "${input.name}" already exists.`, {
        code: 'BADGE_NAME_TAKEN',
      });
    }
    throw error;
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.RECOGNITION_BADGE_CREATED,
    `Created the recognition badge "${row.name}"`,
    context.req,
    { meta: { badgeId: idStr(row._id), name: row.name } },
  );

  return badgeDto(row.toObject());
}

export { toDto as recognitionDto, badgeDto };

export default {
  recognitionWall,
  recognitionsReceived,
  recognitionsGiven,
  giveRecognition,
  listBadges,
  createBadge,
};
