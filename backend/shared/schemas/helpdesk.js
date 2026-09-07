/**
 * Helpdesk validation schemas (AD-6).
 *
 * Ported from the reference's `packages/shared-types/src/helpdesk.ts`. Imported
 * by the Express validator AND by the React forms, so a rule cannot drift.
 *
 * Deviations from the reference, each deliberate:
 *   - `uuid` becomes `objectId` (AD-2), `organizationId` is gone (AD-1)
 *   - a category declares WHICH resolver team owns it. The reference stores
 *     `defaultAssigneeRoleKey` and routes on nothing.
 *   - list queries coerce. The reference types `page`/`limit` as `z.number()`
 *     and parses them from a query string, so a paged request cannot validate.
 *   - assignment and status are separate operations with their own schemas,
 *     because they are separate decisions with separate rules.
 */

import { z } from 'zod';

import { objectId } from '../validation/common.js';

export const TICKET_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);

export const TICKET_STATUSES = Object.freeze([
  'open',
  'assigned',
  'in_progress',
  'resolved',
  'closed',
]);

/** Nothing moves out of these. */
export const TERMINAL_TICKET_STATUSES = Object.freeze(['closed']);

/**
 * Which permission module governs a category.
 *
 * The reference has these four keys and collapses them into one boolean, so an
 * IT admin can read HR grievances. Here the category names its owning team and
 * that name is the access rule.
 */
export const RESOLVER_MODULES = Object.freeze([
  'helpdesk:hr',
  'helpdesk:payroll',
  'helpdesk:it',
]);

/**
 * The legal moves.
 *
 * The reference has no state machine: `PATCH` writes whatever status arrives,
 * so `closed -> open` and `open -> closed` are both accepted and a reopened
 * ticket keeps its resolution timestamp.
 */
export const TICKET_TRANSITIONS = Object.freeze({
  open: ['assigned', 'in_progress', 'resolved'],
  assigned: ['in_progress', 'resolved', 'open'],
  in_progress: ['resolved', 'assigned'],
  /** Reopening is a real transition, not an overwrite. */
  resolved: ['closed', 'in_progress'],
  closed: [],
});

export const canTransition = (from, to) =>
  Boolean(TICKET_TRANSITIONS[from]?.includes(to));

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const createTicketCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    /** Uppercase handle, stable across renames. */
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(1)
      .max(40)
      .regex(/^[A-Z0-9_]+$/, 'Use uppercase letters, digits or underscore only.'),
    resolverModule: z.enum(RESOLVER_MODULES),
    /** The reference's own 1–168 hour bound. */
    slaHours: z.coerce.number().int().min(1).max(168),
    active: z.boolean().default(true),
  })
  .strict();

/** The code identifies the category on every ticket booked to it; it is fixed. */
export const updateTicketCategorySchema = createTicketCategorySchema
  .omit({ code: true })
  .partial()
  .strict();

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export const createTicketSchema = z
  .object({
    categoryId: objectId,
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(10_000),
    priority: z.enum(TICKET_PRIORITIES).default('normal'),
  })
  .strict();

/** What a resolver may edit without moving the ticket through the machine. */
export const updateTicketSchema = z
  .object({
    priority: z.enum(TICKET_PRIORITIES).optional(),
  })
  .strict();

export const assignTicketSchema = z
  .object({
    /** Null unassigns. The service checks the target may actually resolve it. */
    assigneeEmployeeId: objectId.optional().nullable(),
  })
  .strict();

export const changeTicketStatusSchema = z
  .object({
    status: z.enum(TICKET_STATUSES),
    /** Required when resolving; carried as the reopen reason otherwise. */
    resolutionNotes: z.string().trim().max(10_000).optional().nullable(),
  })
  .strict();

export const ticketListQuerySchema = z
  .object({
    status: z.enum(TICKET_STATUSES).optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    categoryId: objectId.optional(),
    assigneeEmployeeId: objectId.optional(),
    /** `true` narrows to the caller's own tickets. */
    mine: z.enum(['true', 'false']).optional(),
    /** `true` narrows to tickets past their SLA and still open. */
    breachedOnly: z.enum(['true', 'false']).optional(),
    /** Matches the subject and the ticket number. */
    search: z.string().trim().max(120).optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
  })
  .strict();

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export const createTicketCommentSchema = z
  .object({
    body: z.string().trim().min(1).max(10_000),
    /**
     * A resolver-only channel. The reference takes this from the body with no
     * check, so a requester can write into it — on anybody's ticket.
     */
    internal: z.boolean().default(false),
  })
  .strict();

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

export const createKbArticleSchema = z
  .object({
    categoryId: objectId.optional().nullable(),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(50_000),
    searchTags: z.array(z.string().trim().max(50)).max(10).default([]),
    /** Absent means a draft. Only published articles are readable by staff. */
    published: z.boolean().default(false),
  })
  .strict();

export const updateKbArticleSchema = createKbArticleSchema.partial().strict();

export const kbListQuerySchema = z
  .object({
    categoryId: objectId.optional(),
    search: z.string().trim().max(200).optional(),
    /** Authors only; everyone else sees published articles regardless. */
    includeDrafts: z.enum(['true', 'false']).optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(50).optional().default(20),
  })
  .strict();

export default {
  createTicketCategorySchema,
  updateTicketCategorySchema,
  createTicketSchema,
  updateTicketSchema,
  assignTicketSchema,
  changeTicketStatusSchema,
  ticketListQuerySchema,
  createTicketCommentSchema,
  createKbArticleSchema,
  updateKbArticleSchema,
  kbListQuerySchema,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TERMINAL_TICKET_STATUSES,
  RESOLVER_MODULES,
  TICKET_TRANSITIONS,
  canTransition,
};
