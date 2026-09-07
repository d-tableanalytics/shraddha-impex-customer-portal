/**
 * The producer interface. ONE function, called once per business event.
 *
 * Ported from the reference's `InboxService.createWithTx`, which 13 modules
 * inject through an `@Global()` NestJS module. There is no DI container here,
 * so producers import `notify` directly — the same one-call-per-event shape,
 * without the framework.
 *
 * ---------------------------------------------------------------------------
 * Why a notification never fails its producer
 * ---------------------------------------------------------------------------
 * The reference writes the inbox row INSIDE the producer's transaction, so a
 * failed business write leaves no orphan notification. That is the right
 * instinct, and the wrong trade here: MongoDB transactions need a replica set,
 * this deployment does not assume one, and the failure it protects against
 * (an orphan row) is far less costly than the one it introduces (a leave
 * approval rolled back because a notification could not be written).
 *
 * So every write here is best-effort and caught. A notification is a courtesy
 * on top of a fact that is already recorded and already audited; it must never
 * be the reason a business action fails. The same reasoning the reference
 * applies to its own MAIL sends — `void (async () => …)()` with a catch —
 * applied one layer further out.
 *
 * ---------------------------------------------------------------------------
 * Recipients are resolved, never accepted
 * ---------------------------------------------------------------------------
 * `notify` takes an employee id (or several) that the CALLER derived from the
 * event — the request's approver, the ticket's assignee, the announcement's
 * audience. Nothing here reads a request body. There is no endpoint that
 * creates an inbox item, so there is no path by which a caller could address
 * one to somebody else.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import { InboxItem } from '../../../models/hrms/InboxItem.js';
import {
  INBOX_TYPE_LIST,
  INBOX_FANOUT_CHUNK,
  INBOX_TITLE_MAX,
  INBOX_BODY_MAX,
  isActionable,
} from '../../../shared/constants/inbox.js';
import { sendInboxMail } from './mail.service.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

/** Trim to the column's ceiling rather than letting Mongoose reject the write. */
const clamp = (s, max) => {
  if (s === null || s === undefined) return null;
  const str = String(s).trim();
  if (!str) return null;
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
};

/**
 * Recipients that are real, live, and unique.
 *
 * - Soft-deleted employees are dropped. Notifying a deleted record creates a
 *   row nobody will ever read, and the retention sweep would then have to know
 *   about it.
 * - Duplicates are collapsed. The reference does this by hand in exactly one of
 *   its 20 producers (`exit-request.service` keeps a `notified` Set) and not in
 *   the other 19 — so an approver who is also the HR contact gets the same exit
 *   notification twice.
 * - The actor is dropped by the CALLER when appropriate, not here; some events
 *   legitimately notify the person who caused them.
 */
async function liveRecipients(employeeIds) {
  const unique = [...new Set(employeeIds.map(idStr).filter(Boolean))].filter((id) =>
    mongoose.isValidObjectId(id),
  );
  if (unique.length === 0) return [];

  const rows = await Employee.find({ _id: { $in: unique.map(oid) }, deletedAt: null })
    .select('_id')
    .lean();

  return rows.map((r) => r._id);
}

/**
 * File a notification for one or more people.
 *
 * @param {object} input
 * @param {string|string[]} input.to          employee id(s), derived by the caller
 * @param {string}          input.type        one of INBOX_TYPES
 * @param {string}          input.title       what happened, in a line
 * @param {string}          [input.body]      one more line. NO amounts, NO free
 *                                            text copied from a request — see
 *                                            the model's note
 * @param {string}          input.entity      the collection it is about
 * @param {string}          input.entityId    the row it is about
 * @returns {Promise<number>} how many rows were written. Never throws.
 */
export async function notify(input) {
  try {
    const { to, type, title, entity, entityId, body = null } = input ?? {};

    // A typo'd type would otherwise be written and then fail the model's enum
    // at save time, inside a catch, silently. Fail loudly in development.
    if (!INBOX_TYPE_LIST.includes(type)) {
      throw new Error(`notify: unknown inbox type "${type}"`);
    }
    if (!entity || !entityId || !mongoose.isValidObjectId(entityId)) {
      throw new Error(`notify: ${type} needs a valid entity and entityId`);
    }

    const recipients = await liveRecipients(Array.isArray(to) ? to : [to]);
    if (recipients.length === 0) return 0;

    const now = new Date();
    const rows = recipients.map((recipientEmployeeId) => ({
      recipientEmployeeId,
      type,
      title: clamp(title, INBOX_TITLE_MAX) ?? 'Notification',
      body: clamp(body, INBOX_BODY_MAX),
      entity,
      entityId: oid(entityId),
      readAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    }));

    /**
     * ONE write per chunk. 🔴 The reference loops single INSERTs — an org-wide
     * announcement to 5,000 people is 5,000 round trips, inside the
     * announcement's own write transaction.
     *
     * `ordered: false` so one bad row cannot discard the rest of the fan-out.
     */
    let written = 0;
    for (let i = 0; i < rows.length; i += INBOX_FANOUT_CHUNK) {
      const chunk = rows.slice(i, i + INBOX_FANOUT_CHUNK);
      const inserted = await InboxItem.insertMany(chunk, { ordered: false });
      written += inserted.length;
    }

    /**
     * The mail half, for the seven events that warrant one.
     *
     * AFTER the rows are written, and inside this function's catch, so a mail
     * failure can never be the reason a notification is missing — the
     * reference's own rule for its sends. Producers call `notify` and nothing
     * else; adding or removing an email is one edit in `mailTemplates.js`, not
     * a change to any of the twenty call sites.
     *
     * Off unless `HRMS_MAIL_ENABLED` is set. See mail.service.js.
     */
    await sendInboxMail({ type, title: rows[0]?.title, recipients });

    return written;
  } catch (error) {
    /**
     * Swallowed on purpose — see the header. A notification that cannot be
     * written must not roll back the thing it was about.
     */
    console.error('[hrms:inbox] notify failed:', error?.message ?? error);
    return 0;
  }
}

/**
 * The same, for an event whose recipient may be identified by USER id.
 *
 * The reference addresses everything by user id; a couple of this codebase's
 * own records (an exit clearance's assignee) inherited that shape from it. This
 * resolves one to the employee the rest of the system speaks in, so producers
 * never have to.
 */
export async function notifyUsers(input) {
  const userIds = (Array.isArray(input?.toUserIds) ? input.toUserIds : [input?.toUserIds])
    .map(idStr)
    .filter(Boolean)
    .filter((id) => mongoose.isValidObjectId(id));

  if (userIds.length === 0) return 0;

  const employees = await Employee.find({ userId: { $in: userIds.map(oid) }, deletedAt: null })
    .select('_id')
    .lean()
    .catch(() => []);

  if (employees.length === 0) return 0;
  return notify({ ...input, to: employees.map((e) => idStr(e._id)) });
}

export { isActionable };

export default { notify, notifyUsers };
