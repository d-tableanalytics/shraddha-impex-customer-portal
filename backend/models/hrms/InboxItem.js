/**
 * Inbox items — one row per person per event.
 *
 * Ported from the reference's `InboxItem` Prisma model, adapted to Mongoose and
 * the accepted decisions:
 *
 *   AD-1   single tenant, so no organizationId — its
 *          `@@index([organizationId, userId, createdAt])` loses a column, and
 *          becomes an index the listing query can actually use (see below)
 *   AD-2   ObjectId keys, no foreign keys — the notifier resolves recipients
 *          before writing
 *   AD-4   the recipient is an EMPLOYEE, not a User account
 *   AD-13  the list is server-paginated, so the indexes below matter
 *   AD-16  rows expire under a retention policy, which the reference has none of
 *
 * ---------------------------------------------------------------------------
 * 🔴 The recipient is an employee
 * ---------------------------------------------------------------------------
 * The reference keys every row on `userId`. That is why its exit-clearance and
 * onboarding-task assignees are user ids while the same people are employee ids
 * in every other query, and why an employee without a portal account can be a
 * task assignee but can never be told about it. Every scope check in this
 * codebase is employee-based (AD-4), so the recipient is too, and the notifier
 * resolves whatever a producer has — employee id, user id — down to one.
 *
 * ---------------------------------------------------------------------------
 * 🔴 `href` is NOT stored
 * ---------------------------------------------------------------------------
 * The reference stores a raw href per row: a per-item navigation target with no
 * shape and no allow-list, whose only contract is "somewhere the browser will
 * be sent". Here the row stores `entity` + `entityId`, and the link is DERIVED
 * from the type by `shared/constants/inbox.js#hrefFor`. A notification cannot
 * carry a link the server did not compute, and moving a screen is one edit
 * rather than a data migration.
 */

import mongoose from 'mongoose';

import { INBOX_TYPE_LIST, INBOX_TITLE_MAX, INBOX_BODY_MAX } from '../../shared/constants/inbox.js';

const { Schema } = mongoose;

const inboxItemSchema = new Schema(
  {
    /** Who this is for. Always server-derived; no endpoint accepts it. */
    recipientEmployeeId: { type: Schema.Types.ObjectId, required: true },

    /**
     * A CLOSED enum. 🔴 The reference's is open in practice — its `type` is a
     * bare Prisma `String` and its producers emit a value its own Zod schema
     * does not declare.
     */
    type: { type: String, required: true, enum: INBOX_TYPE_LIST },

    title: { type: String, required: true, trim: true, maxlength: INBOX_TITLE_MAX },

    /**
     * Optional one-line detail.
     *
     * 🔴 What does NOT go here: amounts, free text copied from a request, or
     * anything the recipient could not already see. The reference puts a claim
     * total in the title and the requester's reason in the body — a second,
     * unguarded copy of the record, which is also what leaves over SMTP. A
     * notification says what happened and where to look; the authorised screen
     * shows the detail.
     */
    body: { type: String, default: null, trim: true, maxlength: INBOX_BODY_MAX },

    /** What it is about. `entity` names the collection, in snake_case. */
    entity: { type: String, required: true, trim: true, maxlength: 80 },
    entityId: { type: Schema.Types.ObjectId, required: true },

    /** Null means unread. The reference's own representation. */
    readAt: { type: Date, default: null },

    /**
     * Archive, which the reference has no concept of — its only lifecycle is
     * "created", so its table grows without bound behind a hardcoded `take:
     * 100` that makes item 101 unreachable forever.
     */
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'hrms_inbox_items' },
);

/**
 * The listing query: one person's live items, newest first.
 *
 * 🔴 The reference declares `[organizationId, userId, createdAt]` and then
 * lists with `where: { userId }` alone — so its only listing query cannot use
 * its only compound index. This one is the query.
 */
inboxItemSchema.index({ recipientEmployeeId: 1, archivedAt: 1, createdAt: -1 });

/** The unread badge, polled every 15 seconds per signed-in user. */
inboxItemSchema.index({ recipientEmployeeId: 1, readAt: 1, archivedAt: 1 });

/** Filtering by type, which the reference offers no way to do. */
inboxItemSchema.index({ recipientEmployeeId: 1, type: 1, createdAt: -1 });

/** The retention sweep (AD-16), which the reference has none of. */
inboxItemSchema.index({ createdAt: 1 });

export const InboxItem =
  mongoose.models.InboxItem || mongoose.model('InboxItem', inboxItemSchema);

export default InboxItem;
