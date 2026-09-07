/**
 * Helpdesk: ticket categories, tickets with their conversation, and the
 * knowledge base.
 *
 * Ported from the reference's `TicketCategory`, `HelpdeskTicket`,
 * `TicketComment` and `KbArticle`.
 *
 * ---------------------------------------------------------------------------
 * The CONVERSATION is embedded
 * ---------------------------------------------------------------------------
 * A comment is created with its ticket, read with it, and deleted with it, and
 * is never queried on its own — the reference's only query is
 * `findMany({ where: { ticketId } })`. In Postgres that costs a table and a
 * join; in MongoDB it is a subdocument, and the ticket detail becomes one read.
 * The count is bounded in practice by a ticket's lifetime.
 *
 * ---------------------------------------------------------------------------
 * Everything is EMPLOYEE-keyed
 * ---------------------------------------------------------------------------
 * The reference keys the requester, the assignee and every comment author on
 * `userId`. In this codebase a User may be a portal Customer (AD-4/AD-14), and
 * every other HRMS module scopes on `employeeId` — so employee-keying is both
 * what keeps a Customer out of a helpdesk queue and what lets the existing
 * actor and scope infrastructure apply without a special case.
 *
 * ---------------------------------------------------------------------------
 * The SLA is SNAPSHOTTED
 * ---------------------------------------------------------------------------
 * The reference computes breach from the LIVE category on every read, so
 * shortening a category's SLA retroactively breaches every historical ticket
 * booked to it. The hours in force when the ticket was raised are stored on the
 * ticket, and the due instant with them.
 */

import mongoose from 'mongoose';

import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  RESOLVER_MODULES,
} from '../../shared/schemas/helpdesk.js';

const { Schema } = mongoose;

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

const ticketCategorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 40 },

    /**
     * The permission module that owns this category.
     *
     * This is the access rule, not a hint: a resolver sees a ticket when they
     * hold `resolve` on the category's module. The reference stores an
     * equivalent `defaultAssigneeRoleKey` and routes on nothing.
     */
    resolverModule: { type: String, enum: RESOLVER_MODULES, required: true },

    slaHours: { type: Number, required: true, min: 1, max: 168 },
    /** Out of the picker for new tickets; existing ones keep working. */
    active: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'hrms_ticket_categories' },
);

/** The code is unique among live categories. */
ticketCategorySchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
ticketCategorySchema.index({ deletedAt: 1, name: 1 });

// ---------------------------------------------------------------------------
// Comment — embedded in its ticket
// ---------------------------------------------------------------------------

const commentSchema = new Schema(
  {
    authorEmployeeId: { type: Schema.Types.ObjectId, required: true },
    /** Snapshot, so a comment still reads correctly after the author leaves. */
    authorName: { type: String, default: '' },
    body: { type: String, required: true, trim: true, maxlength: 10_000 },
    /**
     * The resolver-only channel. Written only by a resolver for this ticket's
     * category — the reference takes it from the request body unchecked.
     */
    internal: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true, timestamps: false },
);

// ---------------------------------------------------------------------------
// Ticket
// ---------------------------------------------------------------------------

const ticketSchema = new Schema(
  {
    /** Human-facing handle, so a ticket can be quoted in an email or a call. */
    ticketNumber: { type: String, required: true },

    categoryId: { type: Schema.Types.ObjectId, required: true, index: true },
    /** Snapshotted from the category, so access survives a category rename. */
    resolverModule: { type: String, enum: RESOLVER_MODULES, required: true },

    requesterEmployeeId: { type: Schema.Types.ObjectId, required: true, index: true },
    requesterName: { type: String, default: '' },

    subject: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 10_000 },

    priority: { type: String, enum: TICKET_PRIORITIES, default: 'normal' },
    status: { type: String, enum: TICKET_STATUSES, default: 'open', index: true },

    assigneeEmployeeId: { type: Schema.Types.ObjectId, default: null, index: true },
    assigneeName: { type: String, default: '' },

    /** The SLA in force when this was raised. See the header. */
    slaHours: { type: Number, required: true, min: 1 },
    slaDueAt: { type: Date, required: true },

    /** Cleared on reopen — the reference leaves both stamped forever. */
    resolvedAt: { type: Date, default: null },
    resolvedByEmployeeId: { type: Schema.Types.ObjectId, default: null },
    resolutionNotes: { type: String, default: null, maxlength: 10_000 },
    closedAt: { type: Date, default: null },
    reopenedAt: { type: Date, default: null },

    comments: { type: [commentSchema], default: [] },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'hrms_helpdesk_tickets' },
);

ticketSchema.index({ ticketNumber: 1 }, { unique: true });
/** The four reads: my tickets, a queue, one assignee's load, and a breach sweep. */
ticketSchema.index({ deletedAt: 1, requesterEmployeeId: 1, createdAt: -1 });
ticketSchema.index({ deletedAt: 1, resolverModule: 1, status: 1, createdAt: -1 });
ticketSchema.index({ deletedAt: 1, assigneeEmployeeId: 1, status: 1 });
ticketSchema.index({ deletedAt: 1, status: 1, slaDueAt: 1 });

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

const kbArticleSchema = new Schema(
  {
    /** Optional link to a ticket category, as in the reference. */
    categoryId: { type: Schema.Types.ObjectId, default: null, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 50_000 },
    searchTags: { type: [String], default: [] },

    /** Null means a draft. The reference can never set this — see the analysis. */
    publishedAt: { type: Date, default: null },
    publishedByEmployeeId: { type: Schema.Types.ObjectId, default: null },

    authorEmployeeId: { type: Schema.Types.ObjectId, default: null },
    authorName: { type: String, default: '' },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'hrms_kb_articles' },
);

kbArticleSchema.index({ deletedAt: 1, publishedAt: -1 });
kbArticleSchema.index({ title: 'text', body: 'text', searchTags: 'text' });

// ---------------------------------------------------------------------------

export const TicketCategory =
  mongoose.models.TicketCategory ||
  mongoose.model('TicketCategory', ticketCategorySchema);

export const HelpdeskTicket =
  mongoose.models.HelpdeskTicket || mongoose.model('HelpdeskTicket', ticketSchema);

export const KbArticle =
  mongoose.models.KbArticle || mongoose.model('KbArticle', kbArticleSchema);

export default { TicketCategory, HelpdeskTicket, KbArticle };
