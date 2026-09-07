/**
 * Reading and clearing my own inbox.
 *
 * Ported from the reference's `InboxService.list / unreadCount / markRead /
 * markAllRead`.
 *
 * ---------------------------------------------------------------------------
 * The one rule
 * ---------------------------------------------------------------------------
 * EVERY query in this file is scoped by `recipientEmployeeId` taken from the
 * authenticated actor. The id is never read from a body, a query string or a
 * path — the only thing a caller ever supplies is which of their OWN items to
 * act on, and even that is re-checked in the same statement that writes.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections
 * ---------------------------------------------------------------------------
 * 1. MARK-READ IS ONE STATEMENT. 🔴 The reference does
 *    `findFirst({ id, userId })` in one transaction and then
 *    `update({ where: { id } })` in another — the write predicate DROPS the
 *    user id. The prior check makes it safe today, but the authorisation and
 *    the write are not the same statement, which is the shape that becomes an
 *    IDOR the moment somebody reorders the function. Here it is a single
 *    `findOneAndUpdate` whose filter carries the recipient.
 *
 * 2. THE LIST IS PAGINATED AND FILTERABLE (AD-13). The reference returns
 *    `take: 100` with no cursor, so item 101 is unreachable FOREVER — and since
 *    it has no delete, no archive and no retention, every active employee
 *    eventually hits that ceiling and silently stops seeing older items.
 *
 * 3. ARCHIVE EXISTS, and so does a retention sweep. The reference's only
 *    lifecycle is "created".
 *
 * 4. THE LINK IS DERIVED, not stored — see the model's header.
 *
 * 5. THE READS ARE AUDITED where it matters. The reference audits nothing at
 *    all, so "who marked this read" is unanswerable. Listing is not audited —
 *    that would write a row every fifteen seconds per signed-in user — but
 *    clearing an inbox is.
 */

import mongoose from 'mongoose';

import { InboxItem } from '../../../models/hrms/InboxItem.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT, HRMS_ROUTE_PREFIX } from '../../../shared/constants/hrms.js';
import {
  INBOX_TYPE_META,
  categoryOf,
  labelOf,
  hrefFor,
  isActionable,
} from '../../../shared/constants/inbox.js';
import { HrmsNotFoundError, HrmsForbiddenError } from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

/**
 * The caller's own recipient id.
 *
 * An HRMS account with no employee record has no inbox — not an error, an empty
 * one. AD-4 makes the Employee the identity; an actor without one is a portal
 * account that happens to hold an HRMS role, and nothing is addressed to it.
 */
function recipientOf(actor) {
  const employeeId = actor?.employeeId ?? null;
  if (!employeeId || !mongoose.isValidObjectId(employeeId)) return null;
  return oid(employeeId);
}

const toDto = (row) => ({
  id: idStr(row._id),
  type: row.type,
  /** Human, not machine. 🔴 The reference renders the raw type in its pill. */
  typeLabel: labelOf(row.type),
  category: categoryOf(row.type),
  actionable: isActionable(row.type),
  title: row.title,
  body: row.body ?? null,
  entity: row.entity,
  entityId: idStr(row.entityId),
  /** Derived from the type, never stored — see the model's header. */
  href: hrefFor(row.type, HRMS_ROUTE_PREFIX),
  read: Boolean(row.readAt),
  readAt: row.readAt ? new Date(row.readAt).toISOString() : null,
  archived: Boolean(row.archivedAt),
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
});

/** The filter for one person's inbox, built from their own id and nothing else. */
function filterFor(recipientEmployeeId, query = {}) {
  const { state = 'all', type, category, archived = 'false' } = query;

  const byCategory =
    category && !type
      ? {
          type: {
            $in: Object.keys(INBOX_TYPE_META).filter(
              (t) => INBOX_TYPE_META[t].category === category,
            ),
          },
        }
      : {};

  return {
    recipientEmployeeId,
    archivedAt: archived === 'true' ? { $ne: null } : null,
    ...(state === 'unread' ? { readAt: null } : {}),
    ...(state === 'read' ? { readAt: { $ne: null } } : {}),
    ...(type ? { type } : {}),
    ...byCategory,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listInbox(query = {}, actor) {
  const recipient = recipientOf(actor);
  if (!recipient) return { data: [], total: 0, page: 1, pageSize: PAGE_SIZE_DEFAULT, unread: 0 };

  const { page = 1, pageSize = PAGE_SIZE_DEFAULT } = query;
  const filter = filterFor(recipient, query);

  const [rows, total, unread] = await Promise.all([
    InboxItem.find(filter)
      // The reference's ordering, kept: newest first.
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    InboxItem.countDocuments(filter),
    // Always the LIVE unread count, whatever this page was filtered to — the
    // badge and the list must not disagree.
    InboxItem.countDocuments({ recipientEmployeeId: recipient, readAt: null, archivedAt: null }),
  ]);

  return { data: rows.map(toDto), total, page, pageSize, unread };
}

/**
 * The badge. Polled every 15 seconds per signed-in user, as the reference's is.
 *
 * A covered count over `{ recipientEmployeeId, readAt, archivedAt }`, which is
 * exactly the second index on the model.
 */
export async function unreadCount(actor) {
  const recipient = recipientOf(actor);
  if (!recipient) return { count: 0 };

  const count = await InboxItem.countDocuments({
    recipientEmployeeId: recipient,
    readAt: null,
    archivedAt: null,
  });
  return { count };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Mark one item read.
 *
 * ONE statement, with the recipient in the filter — correction 1. A 404 rather
 * than a 403 when it belongs to somebody else: whether another person's
 * notification exists is not this caller's business, and telling them would
 * turn the endpoint into an enumeration oracle.
 */
export async function markRead(id, actor) {
  const recipient = recipientOf(actor);
  if (!recipient || !mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Inbox item');

  const updated = await InboxItem.findOneAndUpdate(
    { _id: id, recipientEmployeeId: recipient, readAt: null },
    { $set: { readAt: new Date() } },
    { new: true },
  ).lean();

  if (updated) return toDto(updated);

  // Either already read (idempotent, as the reference is) or not theirs (404).
  const existing = await InboxItem.findOne({
    _id: id,
    recipientEmployeeId: recipient,
  }).lean();
  if (!existing) throw new HrmsNotFoundError('Inbox item');
  return toDto(existing);
}

/** Mark one item unread again — the reference has no way back. */
export async function markUnread(id, actor) {
  const recipient = recipientOf(actor);
  if (!recipient || !mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Inbox item');

  const updated = await InboxItem.findOneAndUpdate(
    { _id: id, recipientEmployeeId: recipient },
    { $set: { readAt: null } },
    { new: true },
  ).lean();

  if (!updated) throw new HrmsNotFoundError('Inbox item');
  return toDto(updated);
}

/**
 * Mark several read.
 *
 * The ids are a SELECTION, not an authorisation: the filter still carries the
 * caller's recipient id, so ids belonging to anybody else simply do not match.
 * The response reports how many actually moved, which is how a caller learns
 * that some of what they sent was not theirs — without being told whose it was.
 */
export async function markManyRead(ids, actor, context = {}) {
  const recipient = recipientOf(actor);
  if (!recipient) return { updated: 0 };

  const valid = [...new Set(ids)].filter((id) => mongoose.isValidObjectId(id));
  if (valid.length === 0) return { updated: 0 };

  const result = await InboxItem.updateMany(
    { _id: { $in: valid.map(oid) }, recipientEmployeeId: recipient, readAt: null },
    { $set: { readAt: new Date() } },
  );

  const updated = result.modifiedCount ?? 0;
  if (updated > 0) await auditClear(context, AUDIT_ACTIONS.INBOX_MARKED_READ, updated);
  return { updated };
}

export async function markAllRead(actor, context = {}) {
  const recipient = recipientOf(actor);
  if (!recipient) return { updated: 0 };

  const result = await InboxItem.updateMany(
    { recipientEmployeeId: recipient, readAt: null, archivedAt: null },
    { $set: { readAt: new Date() } },
  );

  const updated = result.modifiedCount ?? 0;
  if (updated > 0) await auditClear(context, AUDIT_ACTIONS.INBOX_MARKED_ALL_READ, updated);
  return { updated };
}

/**
 * Archive — out of the way, not gone.
 *
 * The reference has no delete and no archive at all, which is why its table
 * grows without bound behind a hardcoded hundred-row ceiling. Archiving marks
 * an item read too: filing something you have not looked at is still filing it.
 */
export async function archive(ids, actor, context = {}) {
  const recipient = recipientOf(actor);
  if (!recipient) return { updated: 0 };

  const valid = [...new Set(ids)].filter((id) => mongoose.isValidObjectId(id));
  if (valid.length === 0) return { updated: 0 };

  const now = new Date();
  const result = await InboxItem.updateMany(
    { _id: { $in: valid.map(oid) }, recipientEmployeeId: recipient, archivedAt: null },
    [
      {
        $set: {
          archivedAt: now,
          // Keep an existing read timestamp; stamp one only if it is null.
          readAt: { $ifNull: ['$readAt', now] },
        },
      },
    ],
  );

  const updated = result.modifiedCount ?? 0;
  if (updated > 0) await auditClear(context, AUDIT_ACTIONS.INBOX_ARCHIVED, updated);
  return { updated };
}

/**
 * The audit entry for a bulk clear.
 *
 * Counts only — never the titles. An audit row that listed what was in
 * somebody's inbox would be a second copy of it, readable by every auditor.
 * 🔴 The reference audits none of this at all.
 */
async function auditClear(context, action, count) {
  await recordAudit(context.user, action, `Cleared ${count} inbox item${count === 1 ? '' : 's'}`, context.req, {
    meta: { count },
  });
}

// ---------------------------------------------------------------------------
// Retention (AD-16)
// ---------------------------------------------------------------------------

/**
 * The sweep behind `RETENTION_CATEGORIES.INBOX_ITEMS`.
 *
 * Phase 0 declared the category with `days: null` — retain indefinitely — so
 * this does nothing until somebody configures a window, which is the correct
 * default for a category nobody has decided about (AD-16). The reference has no
 * retention for inbox rows in any form.
 *
 * Only READ items are swept. An unread notification is still undelivered, and
 * deleting one because it is old means the person never finds out.
 */
export const inboxRetentionHandler = {
  description:
    'Deletes or archives READ inbox notifications past the configured window; unread items are never swept.',

  async sweep({ cutoff, action, dryRun = false, batchSize = 500 }) {
    /**
     * Only READ items are ever swept. An unread notification is still
     * undelivered — removing one because it is old means the person never
     * finds out, which is the opposite of what the notification was for.
     */
    const filter = { createdAt: { $lt: cutoff }, readAt: { $ne: null } };

    // `retain` is this category's Phase 0 default and means exactly that.
    if (action === 'retain') {
      return {
        scanned: 0,
        affected: 0,
        notes: ['inbox items are set to retain; nothing was removed'],
      };
    }

    const scanned = await InboxItem.countDocuments(filter);
    if (dryRun || scanned === 0) {
      return {
        scanned,
        affected: 0,
        notes: dryRun ? [`${scanned} read inbox item(s) would be ${action}d`] : [],
      };
    }

    if (action === 'delete') {
      // Bounded per pass, so a first sweep of a long-lived deployment cannot
      // become one unbounded delete.
      const ids = await InboxItem.find(filter).select('_id').limit(batchSize).lean();
      const result = await InboxItem.deleteMany({ _id: { $in: ids.map((r) => r._id) } });
      return { scanned, affected: result.deletedCount ?? 0 };
    }

    if (action === 'archive') {
      // For a notification, "archive" is the flag the model already carries —
      // out of the way, still readable, still auditable.
      const ids = await InboxItem.find({ ...filter, archivedAt: null })
        .select('_id')
        .limit(batchSize)
        .lean();
      const result = await InboxItem.updateMany(
        { _id: { $in: ids.map((r) => r._id) } },
        { $set: { archivedAt: new Date() } },
      );
      return { scanned, affected: result.modifiedCount ?? 0 };
    }

    return { scanned, affected: 0, notes: [`unsupported retention action "${action}"`] };
  },
};

export { HrmsForbiddenError };

export default {
  listInbox,
  unreadCount,
  markRead,
  markUnread,
  markManyRead,
  markAllRead,
  archive,
  inboxRetentionHandler,
};
