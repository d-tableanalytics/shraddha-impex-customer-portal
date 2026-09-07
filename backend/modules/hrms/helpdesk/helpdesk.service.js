/**
 * Helpdesk: ticket categories, tickets and their conversation, and the
 * knowledge base.
 *
 * Ported from the reference's `TicketService` + `CommentService` + `KbService`.
 * The shape is its shape — a requester raises a ticket in a category, a
 * resolver team works a queue, the conversation carries internal notes, and an
 * SLA runs from creation.
 *
 * Corrections to the reference, each deliberate and each covered by a test:
 *
 *   1. CATEGORY SCOPE IS REAL. The reference computes
 *      `[hasPermission(...'helpdesk:hr'...), ...'payroll'..., ...'it'..., ...]
 *      .some(Boolean)` and calls the result `isResolver` — so an IT admin
 *      holding only `helpdesk:it:resolve:org` reads and edits HR grievances and
 *      payroll queries. The per-category keys exist and are then discarded. A
 *      resolver here sees exactly the categories they hold the grant for.
 *
 *   2. COMMENTING IS AUTHORISED. The reference's `create` never loads the
 *      ticket, so anyone holding `helpdesk:view:self` — everyone — can comment
 *      on any ticket id.
 *
 *   3. AN INTERNAL NOTE NEEDS A RESOLVER. The reference takes `internal` from
 *      the body unchecked, so a requester can write into the resolver channel.
 *
 *   4. THE STATE MACHINE IS ENFORCED. The reference writes whatever status
 *      arrives, from any status — `closed -> open` included — and never clears
 *      `resolvedAt` on reopen.
 *
 *   5. AN ASSIGNEE MUST BE ABLE TO RESOLVE THE TICKET. The reference accepts
 *      any uuid, including a portal Customer or a deleted user.
 *
 *   6. NAMES ARE RESOLVED. Both reference DTOs hardcode `''` with the comment
 *      "populated by controller"; the controller does not.
 *
 *   7. THE SLA IS SNAPSHOTTED, not recomputed from the live category.
 *
 *   8. THE KB CAN BE WRITTEN, and its search filters before it truncates —
 *      the reference takes the newest N and then substring-matches those, so an
 *      article outside the first page can never be found.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import {
  TicketCategory,
  HelpdeskTicket,
  KbArticle,
} from '../../../models/hrms/HelpdeskModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { notify } from '../inbox/notifier.service.js';
import { INBOX_TYPES } from '../../../shared/constants/inbox.js';
import { AUDIT_ACTIONS } from '../../../shared/constants/hrms.js';
import { hasHrmsPermission } from '../../../shared/permissions/has-permission.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';
import {
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
  RESOLVER_MODULES,
  canTransition,
} from '../../../shared/schemas/helpdesk.js';
import { formatZodIssues } from '../../../shared/validation/common.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsValidationError,
  HrmsForbiddenError,
} from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const iso = (v) => (v ? new Date(v).toISOString() : null);
const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fullName = (e) => `${e?.firstName ?? ''} ${e?.lastName ?? ''}`.trim();

function parse(schema, input, what) {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw new HrmsValidationError(`Invalid ${what}.`, formatZodIssues(result.error));
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Who may resolve what
// ---------------------------------------------------------------------------

/**
 * The categories this actor may work, as a list of resolver modules.
 *
 * `helpdesk:resolve:org` — the super-admin grant — spans all of them. Anything
 * else is per-team, which is the whole point the reference throws away.
 */
export function resolvableModules(actor) {
  if (hasHrmsPermission(actor, M.HELPDESK, A.RESOLVE, S.ORG)) {
    return [...RESOLVER_MODULES];
  }
  return RESOLVER_MODULES.filter((module) =>
    hasHrmsPermission(actor, module, A.RESOLVE, S.ORG),
  );
}

/** Whether this actor may work tickets in one specific category. */
export const canResolveModule = (actor, resolverModule) =>
  resolvableModules(actor).includes(resolverModule);

/** Whether this actor resolves anything at all. */
export const isAnyResolver = (actor) => resolvableModules(actor).length > 0;

/**
 * The query that limits a ticket list to what this actor may read.
 *
 * Own tickets always; plus every ticket in a category they resolve. Applied to
 * the QUERY — the reference filters `requesterUserId` in the query and then
 * lets any resolver see everything.
 */
function scopeFilter(actor) {
  const clauses = [];
  if (actor?.employeeId) clauses.push({ requesterEmployeeId: actor.employeeId });

  const modules = resolvableModules(actor);
  if (modules.length > 0) clauses.push({ resolverModule: { $in: modules } });

  // Nobody with neither an employee record nor a resolver grant sees anything.
  if (clauses.length === 0) return { _id: null };
  return { $or: clauses };
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

const categoryToDto = (row, ticketCount = 0) => ({
  id: idStr(row._id),
  name: row.name,
  code: row.code,
  resolverModule: row.resolverModule,
  slaHours: row.slaHours,
  active: row.active,
  ticketCount,
});

const commentToDto = (comment) => ({
  id: idStr(comment._id),
  authorEmployeeId: idStr(comment.authorEmployeeId),
  authorName: comment.authorName || null,
  body: comment.body,
  internal: comment.internal,
  createdAt: iso(comment.createdAt),
});

/** SLA state, from the hours snapshotted on the ticket. */
function slaState(row, now = Date.now()) {
  const due = row.slaDueAt ? new Date(row.slaDueAt).getTime() : null;
  const settled = row.status === 'resolved' || row.status === 'closed';
  if (due === null) return { slaDueAt: null, slaBreached: false, slaHoursRemaining: null };

  const breached = !settled && now > due;
  return {
    slaDueAt: iso(row.slaDueAt),
    slaBreached: breached,
    slaHoursRemaining: settled ? null : Math.max(0, (due - now) / 3_600_000),
  };
}

const ticketToDto = (row, { category, actor, includeComments = false } = {}) => {
  const mine = idStr(row.requesterEmployeeId) === idStr(actor?.employeeId);
  const resolver = canResolveModule(actor, row.resolverModule);

  return {
    id: idStr(row._id),
    ticketNumber: row.ticketNumber,
    categoryId: idStr(row.categoryId),
    categoryName: category?.name ?? null,
    resolverModule: row.resolverModule,

    requesterEmployeeId: idStr(row.requesterEmployeeId),
    requesterName: row.requesterName || null,
    subject: row.subject,
    body: row.body,
    priority: row.priority,
    status: row.status,

    assigneeEmployeeId: idStr(row.assigneeEmployeeId),
    assigneeName: row.assigneeName || null,

    slaHours: row.slaHours,
    ...slaState(row),

    resolvedAt: iso(row.resolvedAt),
    resolutionNotes: row.resolutionNotes ?? null,
    closedAt: iso(row.closedAt),
    reopenedAt: iso(row.reopenedAt),

    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),

    /** Lets the UI offer only what the server would accept. */
    isMine: mine,
    canResolve: resolver,

    ...(includeComments
      ? {
          comments: (row.comments ?? [])
            // An internal note is for the resolver team, and nobody else —
            // including the requester, even on their own ticket.
            .filter((c) => !c.internal || resolver)
            .map(commentToDto),
        }
      : { commentCount: (row.comments ?? []).filter((c) => !c.internal || resolver).length }),
  };
};

/** Live categories keyed by id, for a page of tickets. */
async function categoriesByIds(ids = []) {
  const valid = ids.filter((id) => id && mongoose.isValidObjectId(id));
  if (valid.length === 0) return new Map();
  const rows = await TicketCategory.find({ _id: { $in: valid } })
    .select('_id name code resolverModule')
    .lean();
  return new Map(rows.map((r) => [idStr(r._id), r]));
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * Administering the catalogue.
 *
 * `helpdesk:resolve:org` — held by the super admin alone — because a category
 * decides which team is answerable for a class of question, and that is not a
 * decision one team makes about another. The reference has no endpoint at all,
 * which is why its own Raise Ticket form posts `'hr-placeholder'`.
 */
const isCatalogueAdmin = (actor) =>
  hasHrmsPermission(actor, M.HELPDESK, A.RESOLVE, S.ORG);

export async function listCategories(actor, { includeInactive = false } = {}) {
  const filter = { deletedAt: null };
  if (!includeInactive) filter.active = true;

  const rows = await TicketCategory.find(filter).sort({ name: 1 }).lean();
  if (rows.length === 0) return [];

  const counts = await HelpdeskTicket.aggregate([
    { $match: { deletedAt: null, categoryId: { $in: rows.map((r) => r._id) } } },
    { $group: { _id: '$categoryId', n: { $sum: 1 } } },
  ]);
  const byCategory = new Map(counts.map((c) => [idStr(c._id), c.n]));

  return rows.map((row) => categoryToDto(row, byCategory.get(idStr(row._id)) ?? 0));
}

export async function createCategory(input, actor, context = {}) {
  if (!isCatalogueAdmin(actor)) {
    throw new HrmsForbiddenError('Only a super administrator can manage ticket categories.');
  }
  const dto = parse(createTicketCategorySchema, input, 'ticket category');

  let row;
  try {
    row = await TicketCategory.create(dto);
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError(`Ticket category "${dto.code}" already exists.`, {
        code: 'TICKET_CATEGORY_CODE_TAKEN',
      });
    }
    throw error;
  }

  const category = categoryToDto(row.toObject(), 0);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.TICKET_CATEGORY_CREATED,
    `Created the ticket category ${category.code} (${category.name}), answered by ${category.resolverModule}`,
    context.req,
    { meta: { categoryId: category.id, resolverModule: category.resolverModule } },
  );
  return category;
}

export async function updateCategory(id, input, actor, context = {}) {
  if (!isCatalogueAdmin(actor)) {
    throw new HrmsForbiddenError('Only a super administrator can manage ticket categories.');
  }
  const dto = parse(updateTicketCategorySchema, input, 'ticket category');
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Ticket category');

  const row = await TicketCategory.findOne({ _id: id, deletedAt: null });
  if (!row) throw new HrmsNotFoundError('Ticket category');

  const movedTeam = dto.resolverModule && dto.resolverModule !== row.resolverModule;
  Object.assign(row, dto);
  await row.save();

  // Live tickets keep the team they were raised against unless the category is
  // deliberately moved; then they move with it, so the queue stays coherent.
  if (movedTeam) {
    await HelpdeskTicket.updateMany(
      { categoryId: id, deletedAt: null, status: { $ne: 'closed' } },
      { $set: { resolverModule: dto.resolverModule } },
    );
  }

  const category = categoryToDto(row.toObject(), 0);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.TICKET_CATEGORY_UPDATED,
    `Updated the ticket category ${category.code}`,
    context.req,
    { meta: { categoryId: category.id, fields: Object.keys(dto), movedTeam } },
  );
  return category;
}

export async function deleteCategory(id, actor, context = {}) {
  if (!isCatalogueAdmin(actor)) {
    throw new HrmsForbiddenError('Only a super administrator can manage ticket categories.');
  }
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Ticket category');

  const row = await TicketCategory.findOne({ _id: id, deletedAt: null }).lean();
  if (!row) throw new HrmsNotFoundError('Ticket category');

  const open = await HelpdeskTicket.countDocuments({
    categoryId: id,
    deletedAt: null,
    status: { $ne: 'closed' },
  });
  if (open > 0) {
    throw new HrmsConflictError(
      `${open} open ticket${open === 1 ? '' : 's'} still belong${open === 1 ? 's' : ''} to "${row.name}". Close them, or deactivate the category instead.`,
      { code: 'TICKET_CATEGORY_IN_USE', details: { openTickets: open } },
    );
  }

  await TicketCategory.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.TICKET_CATEGORY_DELETED,
    `Deleted the ticket category ${row.code} (${row.name})`,
    context.req,
    { meta: { categoryId: idStr(row._id) } },
  );
  return { id: idStr(row._id), deleted: true };
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

/** `HD-2026-000123`. Sequential within the year, and safe to quote. */
async function nextTicketNumber() {
  const year = new Date().getUTCFullYear();
  const prefix = `HD-${year}-`;
  const latest = await HelpdeskTicket.findOne({ ticketNumber: new RegExp(`^${prefix}`) })
    .sort({ ticketNumber: -1 })
    .select('ticketNumber')
    .lean();
  const n = latest ? Number(latest.ticketNumber.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(6, '0')}`;
}

export async function listTickets(actor, query = {}) {
  const dto = parse(ticketListQuerySchema, query, 'ticket filter');
  const { page, pageSize } = dto;

  const filter = { deletedAt: null, ...scopeFilter(actor) };
  if (dto.status) filter.status = dto.status;
  if (dto.priority) filter.priority = dto.priority;
  if (dto.categoryId) filter.categoryId = dto.categoryId;
  if (dto.assigneeEmployeeId) filter.assigneeEmployeeId = dto.assigneeEmployeeId;

  const and = [];
  // `mine=true` narrows to my own, without widening anything.
  if (dto.mine === 'true') {
    if (!actor?.employeeId) return { data: [], total: 0, page, pageSize };
    and.push({ requesterEmployeeId: actor.employeeId });
  }
  if (dto.breachedOnly === 'true') {
    and.push({ slaDueAt: { $lt: new Date() }, status: { $nin: ['resolved', 'closed'] } });
  }
  if (dto.search) {
    const rx = new RegExp(escapeRegex(dto.search), 'i');
    and.push({ $or: [{ subject: rx }, { ticketNumber: rx }] });
  }
  if (and.length > 0) filter.$and = and;

  const [rows, total] = await Promise.all([
    HelpdeskTicket.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    HelpdeskTicket.countDocuments(filter),
  ]);

  const categories = await categoriesByIds(rows.map((r) => r.categoryId));
  return {
    data: rows.map((row) =>
      ticketToDto(row, { category: categories.get(idStr(row.categoryId)), actor }),
    ),
    total,
    page,
    pageSize,
  };
}

/**
 * Load a ticket this actor may read.
 *
 * The scope filter is applied to the LOOKUP, so "what may be listed" and "what
 * may be opened" are the same set by construction, and somebody with no claim
 * gets a 404 rather than a 403 that confirms the ticket exists.
 */
async function loadReadable(id, actor) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Ticket');
  const row = await HelpdeskTicket.findOne({
    _id: id,
    deletedAt: null,
    ...scopeFilter(actor),
  }).lean();
  if (!row) throw new HrmsNotFoundError('Ticket');
  return row;
}

export async function getTicket(id, actor) {
  const row = await loadReadable(id, actor);
  const categories = await categoriesByIds([row.categoryId]);
  return ticketToDto(row, {
    category: categories.get(idStr(row.categoryId)),
    actor,
    includeComments: true,
  });
}

export async function createTicket(input, actor, context = {}) {
  const dto = parse(createTicketSchema, input, 'ticket');

  if (!actor?.employeeId) {
    throw new HrmsValidationError(
      'Your user account is not linked to an employee record, so you cannot raise a ticket.',
    );
  }

  const category = await TicketCategory.findOne({
    _id: dto.categoryId,
    deletedAt: null,
    active: true,
  }).lean();
  if (!category) throw new HrmsValidationError('That ticket category does not exist.');

  const requester = await Employee.findOne({
    _id: actor.employeeId,
    deletedAt: null,
  }).lean();
  if (!requester) throw new HrmsValidationError('Your employee record could not be found.');

  const now = new Date();
  const row = await HelpdeskTicket.create({
    ticketNumber: await nextTicketNumber(),
    categoryId: category._id,
    // Snapshotted, so a later category edit cannot silently move this ticket
    // into another team's queue or rewrite its SLA.
    resolverModule: category.resolverModule,
    slaHours: category.slaHours,
    slaDueAt: new Date(now.getTime() + category.slaHours * 3_600_000),

    requesterEmployeeId: requester._id,
    requesterName: fullName(requester),
    subject: dto.subject,
    body: dto.body,
    priority: dto.priority,
    status: 'open',
  });

  const dtoOut = ticketToDto(row.toObject(), { category, actor });
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.TICKET_CREATED,
    `Raised ${dtoOut.ticketNumber} in ${category.name}`,
    context.req,
    {
      meta: {
        ticketId: dtoOut.id,
        ticketNumber: dtoOut.ticketNumber,
        categoryId: idStr(category._id),
        priority: dto.priority,
      },
    },
  );

  /*
   * INTEGRATION POINT — inbox notification. Deliberately NOT raised here.
   *
   * 🔴 The reference emits one inbox item at this exact point, addressed to
   * `actor.userId` — the person who just clicked Create — telling them what
   * they have just done. Nobody on the resolver side is told anything at all.
   *
   * Reproducing that would be reproducing a bug. The notification that matters
   * is the one to whoever has to work the ticket, and it is raised in
   * `assignTicket` where an assignee actually exists.
   */

  return dtoOut;
}

/** Load for a resolver action, and refuse anyone who cannot work this category. */
async function loadForResolver(id, actor) {
  const row = await loadReadable(id, actor);
  if (!canResolveModule(actor, row.resolverModule)) {
    throw new HrmsForbiddenError('That ticket belongs to another team’s queue.');
  }
  return HelpdeskTicket.findOne({ _id: row._id, deletedAt: null });
}

export async function updateTicket(id, input, actor, context = {}) {
  const dto = parse(updateTicketSchema, input, 'ticket');
  const row = await loadForResolver(id, actor);

  if (row.status === 'closed') {
    throw new HrmsConflictError('A closed ticket can no longer be edited.', {
      code: 'TICKET_CLOSED',
    });
  }

  if (dto.priority !== undefined) row.priority = dto.priority;
  await row.save();

  const categories = await categoriesByIds([row.categoryId]);
  const dtoOut = ticketToDto(row.toObject(), {
    category: categories.get(idStr(row.categoryId)),
    actor,
  });
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.TICKET_UPDATED,
    `Updated ${dtoOut.ticketNumber}`,
    context.req,
    { meta: { ticketId: dtoOut.id, fields: Object.keys(dto) } },
  );
  return dtoOut;
}

/**
 * Assign, or unassign.
 *
 * The assignee must be an active employee who can actually resolve this
 * category. The reference accepts any uuid — a portal Customer, a departed
 * employee, or an id belonging to nothing.
 */
export async function assignTicket(id, input, actor, context = {}) {
  const dto = parse(assignTicketSchema, input, 'assignment');
  const row = await loadForResolver(id, actor);

  if (row.status === 'closed') {
    throw new HrmsConflictError('A closed ticket can no longer be assigned.', {
      code: 'TICKET_CLOSED',
    });
  }

  if (!dto.assigneeEmployeeId) {
    row.assigneeEmployeeId = null;
    row.assigneeName = '';
    if (row.status === 'assigned') row.status = 'open';
  } else {
    const employee = await Employee.findOne({
      _id: dto.assigneeEmployeeId,
      deletedAt: null,
    }).lean();
    if (!employee) throw new HrmsValidationError('That employee does not exist.');
    if (employee.status === 'exited' || employee.status === 'inactive') {
      throw new HrmsConflictError(
        `${fullName(employee)} has left; a ticket cannot be assigned to them.`,
        { code: 'EMPLOYEE_NOT_ACTIVE' },
      );
    }

    // The assignee must hold the grant for this queue. Assigning an HR
    // grievance to somebody who cannot open it would bury it silently.
    const { default: User } = await import('../../../models/User.js');
    const user = employee.userId
      ? await User.findById(employee.userId).select('roles status').lean()
      : null;
    const { buildHrmsActor } = await import('../../../shared/permissions/has-permission.js');
    const candidate = buildHrmsActor({
      userId: idStr(employee.userId),
      roles: user?.roles ?? [],
      employee: { id: idStr(employee._id), managerChain: [] },
    });
    if (!canResolveModule(candidate, row.resolverModule)) {
      throw new HrmsValidationError(
        `${fullName(employee)} cannot resolve tickets in this category.`,
      );
    }

    row.assigneeEmployeeId = employee._id;
    row.assigneeName = fullName(employee);
    if (row.status === 'open') row.status = 'assigned';
  }
  await row.save();

  const categories = await categoriesByIds([row.categoryId]);
  const dtoOut = ticketToDto(row.toObject(), {
    category: categories.get(idStr(row.categoryId)),
    actor,
  });
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.TICKET_ASSIGNED,
    dto.assigneeEmployeeId
      ? `Assigned ${dtoOut.ticketNumber} to ${dtoOut.assigneeName}`
      : `Unassigned ${dtoOut.ticketNumber}`,
    context.req,
    { meta: { ticketId: dtoOut.id, assigneeEmployeeId: idStr(dto.assigneeEmployeeId) } },
  );

  /**
   * Tell the assignee — the notification the reference never sends. Skipped on
   * unassignment (nobody to tell) and on self-assignment (picking a ticket off
   * a queue is not news to the person who picked it).
   */
  if (
    dto.assigneeEmployeeId &&
    idStr(dto.assigneeEmployeeId) !== idStr(actor?.employeeId)
  ) {
    await notify({
      to: idStr(dto.assigneeEmployeeId),
      type: INBOX_TYPES.TICKET_ASSIGNED,
      title: `${dtoOut.ticketNumber} assigned to you`,
      // The subject only — the ticket body is the requester's own words and is
      // read on the ticket, by the people the category admits.
      body: dtoOut.subject ?? null,
      entity: 'helpdesk_ticket',
      entityId: dtoOut.id,
    });
  }

  return dtoOut;
}

/**
 * Move a ticket through the machine.
 *
 * Every move is checked against `TICKET_TRANSITIONS`. The reference writes
 * whatever arrives, so a closed ticket can be reopened by writing `open` and an
 * untouched one can be closed without ever being resolved.
 */
export async function changeStatus(id, input, actor, context = {}) {
  const dto = parse(changeTicketStatusSchema, input, 'status change');
  const row = await loadReadable(id, actor);
  const live = await HelpdeskTicket.findOne({ _id: row._id, deletedAt: null });

  const resolver = canResolveModule(actor, live.resolverModule);
  const requester = idStr(live.requesterEmployeeId) === idStr(actor?.employeeId);

  /*
   * Who may make this particular move.
   *
   * A requester owns two decisions about their own ticket: accepting the
   * resolution (closing it) and rejecting it (reopening). Everything else is
   * the resolver team's. The reference gives the requester nothing — they
   * cannot even close their own ticket — while giving every resolver every
   * category.
   */
  const requesterMove =
    requester &&
    live.status === 'resolved' &&
    (dto.status === 'closed' || dto.status === 'in_progress');

  if (!resolver && !requesterMove) {
    throw new HrmsForbiddenError(
      requester
        ? 'You can close or reopen your ticket once it has been resolved.'
        : 'That ticket belongs to another team’s queue.',
    );
  }

  if (live.status === dto.status) {
    throw new HrmsConflictError(`That ticket is already ${dto.status.replace('_', ' ')}.`, {
      code: 'TICKET_STATUS_UNCHANGED',
    });
  }
  if (!canTransition(live.status, dto.status)) {
    throw new HrmsConflictError(
      `A ${live.status.replace('_', ' ')} ticket cannot move to ${dto.status.replace('_', ' ')}.`,
      { code: 'TICKET_BAD_TRANSITION' },
    );
  }
  if (dto.status === 'resolved' && !dto.resolutionNotes?.trim()) {
    throw new HrmsValidationError('Say how it was resolved before resolving it.');
  }

  const previous = live.status;
  live.status = dto.status;

  if (dto.status === 'resolved') {
    live.resolvedAt = new Date();
    live.resolvedByEmployeeId = actor?.employeeId ?? null;
    live.resolutionNotes = dto.resolutionNotes.trim();
  }
  if (dto.status === 'closed') live.closedAt = new Date();

  // Reopening clears the resolution — the reference leaves it stamped, so a
  // live ticket carries a resolution date in the past.
  if (previous === 'resolved' && dto.status === 'in_progress') {
    live.resolvedAt = null;
    live.resolvedByEmployeeId = null;
    live.resolutionNotes = null;
    live.closedAt = null;
    live.reopenedAt = new Date();
    if (dto.resolutionNotes?.trim()) {
      live.comments.push({
        authorEmployeeId: actor?.employeeId ?? null,
        authorName: '',
        body: `Reopened: ${dto.resolutionNotes.trim()}`,
        internal: false,
        createdAt: new Date(),
      });
    }
  }

  await live.save();

  const categories = await categoriesByIds([live.categoryId]);
  const dtoOut = ticketToDto(live.toObject(), {
    category: categories.get(idStr(live.categoryId)),
    actor,
    includeComments: true,
  });
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.TICKET_STATUS_CHANGED,
    `Moved ${dtoOut.ticketNumber} from ${previous} to ${dto.status}`,
    context.req,
    { meta: { ticketId: dtoOut.id, from: previous, to: dto.status } },
  );
  return dtoOut;
}

/**
 * Add to the conversation.
 *
 * Authorised against the ticket, which the reference never loads — so anyone
 * can comment on any ticket id there. An internal note additionally requires
 * the resolver grant for this category.
 */
export async function addComment(id, input, actor, context = {}) {
  const dto = parse(createTicketCommentSchema, input, 'comment');
  const row = await loadReadable(id, actor);
  const live = await HelpdeskTicket.findOne({ _id: row._id, deletedAt: null });

  const resolver = canResolveModule(actor, live.resolverModule);
  const requester = idStr(live.requesterEmployeeId) === idStr(actor?.employeeId);
  if (!resolver && !requester) {
    throw new HrmsForbiddenError('You cannot comment on this ticket.');
  }
  if (dto.internal && !resolver) {
    throw new HrmsForbiddenError('Only the resolver team can leave an internal note.');
  }
  if (live.status === 'closed') {
    throw new HrmsConflictError('A closed ticket can no longer be commented on.', {
      code: 'TICKET_CLOSED',
    });
  }
  if (!actor?.employeeId) {
    throw new HrmsValidationError(
      'Your user account is not linked to an employee record, so you cannot comment.',
    );
  }

  const author = await Employee.findById(actor.employeeId)
    .select('firstName lastName')
    .lean();

  live.comments.push({
    authorEmployeeId: actor.employeeId,
    authorName: author ? fullName(author) : '',
    body: dto.body,
    internal: dto.internal,
    createdAt: new Date(),
  });
  await live.save();

  const categories = await categoriesByIds([live.categoryId]);
  const dtoOut = ticketToDto(live.toObject(), {
    category: categories.get(idStr(live.categoryId)),
    actor,
    includeComments: true,
  });
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.TICKET_COMMENT_ADDED,
    `Commented on ${dtoOut.ticketNumber}${dto.internal ? ' (internal)' : ''}`,
    context.req,
    { meta: { ticketId: dtoOut.id, internal: dto.internal } },
  );
  return dtoOut;
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

/** Authoring belongs to whoever answers the questions. */
const isKbAuthor = (actor) => isAnyResolver(actor);

const articleToDto = (row) => ({
  id: idStr(row._id),
  categoryId: idStr(row.categoryId),
  title: row.title,
  body: row.body,
  searchTags: row.searchTags ?? [],
  published: Boolean(row.publishedAt),
  publishedAt: iso(row.publishedAt),
  authorName: row.authorName || null,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
});

export async function listArticles(actor, query = {}) {
  const dto = parse(kbListQuerySchema, query, 'article filter');
  const { page, pageSize } = dto;

  const filter = { deletedAt: null };
  // A draft is visible only to somebody who could publish it.
  if (!(dto.includeDrafts === 'true' && isKbAuthor(actor))) {
    filter.publishedAt = { $ne: null };
  }
  if (dto.categoryId) filter.categoryId = dto.categoryId;
  if (dto.search) {
    // Filtered in the QUERY, then paged. The reference takes the newest N and
    // substring-matches those, so an older match can never be found.
    const rx = new RegExp(escapeRegex(dto.search), 'i');
    filter.$or = [{ title: rx }, { body: rx }, { searchTags: rx }];
  }

  const [rows, total] = await Promise.all([
    KbArticle.find(filter)
      .sort({ publishedAt: -1, createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    KbArticle.countDocuments(filter),
  ]);

  return { data: rows.map(articleToDto), total, page, pageSize };
}

export async function getArticle(id, actor) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Article');
  const filter = { _id: id, deletedAt: null };
  if (!isKbAuthor(actor)) filter.publishedAt = { $ne: null };

  const row = await KbArticle.findOne(filter).lean();
  if (!row) throw new HrmsNotFoundError('Article');
  return articleToDto(row);
}

export async function createArticle(input, actor, context = {}) {
  if (!isKbAuthor(actor)) {
    throw new HrmsForbiddenError('Only a resolver team can write knowledge base articles.');
  }
  const dto = parse(createKbArticleSchema, input, 'article');

  const author = actor?.employeeId
    ? await Employee.findById(actor.employeeId).select('firstName lastName').lean()
    : null;

  const row = await KbArticle.create({
    categoryId: dto.categoryId ?? null,
    title: dto.title,
    body: dto.body,
    searchTags: [...new Set(dto.searchTags)],
    publishedAt: dto.published ? new Date() : null,
    publishedByEmployeeId: dto.published ? (actor?.employeeId ?? null) : null,
    authorEmployeeId: actor?.employeeId ?? null,
    authorName: author ? fullName(author) : '',
  });

  const article = articleToDto(row.toObject());
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.KB_ARTICLE_CREATED,
    `${dto.published ? 'Published' : 'Drafted'} the article "${article.title}"`,
    context.req,
    { meta: { articleId: article.id, published: article.published } },
  );
  return article;
}

export async function updateArticle(id, input, actor, context = {}) {
  if (!isKbAuthor(actor)) {
    throw new HrmsForbiddenError('Only a resolver team can edit knowledge base articles.');
  }
  const dto = parse(updateKbArticleSchema, input, 'article');
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Article');

  const row = await KbArticle.findOne({ _id: id, deletedAt: null });
  if (!row) throw new HrmsNotFoundError('Article');

  for (const field of ['categoryId', 'title', 'body']) {
    if (dto[field] !== undefined) row[field] = dto[field];
  }
  if (dto.searchTags !== undefined) row.searchTags = [...new Set(dto.searchTags)];
  if (dto.published !== undefined) {
    if (dto.published && !row.publishedAt) {
      row.publishedAt = new Date();
      row.publishedByEmployeeId = actor?.employeeId ?? null;
    } else if (!dto.published) {
      row.publishedAt = null;
      row.publishedByEmployeeId = null;
    }
  }
  await row.save();

  const article = articleToDto(row.toObject());
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.KB_ARTICLE_UPDATED,
    `Updated the article "${article.title}"`,
    context.req,
    { meta: { articleId: article.id, fields: Object.keys(dto) } },
  );
  return article;
}

export async function deleteArticle(id, actor, context = {}) {
  if (!isKbAuthor(actor)) {
    throw new HrmsForbiddenError('Only a resolver team can delete knowledge base articles.');
  }
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Article');

  const row = await KbArticle.findOne({ _id: id, deletedAt: null }).lean();
  if (!row) throw new HrmsNotFoundError('Article');

  await KbArticle.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.KB_ARTICLE_DELETED,
    `Deleted the article "${row.title}"`,
    context.req,
    { meta: { articleId: idStr(row._id) } },
  );
  return { id: idStr(row._id), deleted: true };
}

export default {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  listTickets,
  getTicket,
  createTicket,
  updateTicket,
  assignTicket,
  changeStatus,
  addComment,
  listArticles,
  getArticle,
  createArticle,
  updateArticle,
  deleteArticle,
  resolvableModules,
  canResolveModule,
  isAnyResolver,
};
