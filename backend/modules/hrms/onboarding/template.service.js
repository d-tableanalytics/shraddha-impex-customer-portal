/**
 * Onboarding templates — the reusable task lists a checklist is stamped from.
 *
 * Ported from the reference's `onboarding-template.service.ts`.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections
 * ---------------------------------------------------------------------------
 * 1. TEMPLATES ARE RETIRED, NOT DELETED. The reference hard-deletes. Its
 *    checklists carry an optional `templateId` with no `onDelete` rule, so
 *    Prisma nulls the column and every live checklist silently loses its
 *    provenance — the Checklists table then renders "—" where a template name
 *    used to be. Here a template that has ever been instantiated cannot be
 *    removed at all, an unused one is soft-deleted, and every checklist copies
 *    the template's NAME at instantiation so history survives either way.
 *
 * 2. THE LIST IS PAGINATED (AD-13). The reference returns every template with
 *    every task template inlined, unbounded.
 *
 * 3. A TEMPLATE MUST HAVE AT LEAST ONE TASK — enforced in the shared schema.
 *    The reference defaults `tasks` to `[]`, and an empty template instantiates
 *    into a checklist that immediately auto-closes as "completed" because
 *    nothing is outstanding.
 */

import mongoose from 'mongoose';

import { OnboardingTemplate, OnboardingChecklist } from '../../../models/hrms/OnboardingModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import { resolveDepartment } from '../references/reference.service.js';
import { HrmsNotFoundError, HrmsConflictError, HrmsValidationError } from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const taskTemplateDto = (t) => ({
  id: idStr(t._id),
  title: t.title,
  description: t.description ?? null,
  dueDays: t.dueDays,
  assignTo: t.assignTo,
  order: t.order,
});

const toDto = (row, extras = {}) => ({
  id: idStr(row._id),
  name: row.name,
  appliesToRoleKey: row.appliesToRoleKey ?? null,
  appliesToDepartmentId: idStr(row.appliesToDepartmentId),
  appliesToDepartmentName: extras.appliesToDepartmentName ?? null,
  active: row.active,
  /** Ordered here, not by the caller — the reference sorts in every query. */
  tasks: [...(row.tasks ?? [])].sort((a, b) => a.order - b.order).map(taskTemplateDto),
  taskCount: (row.tasks ?? []).length,
  /** Whether this template has ever been used. Drives whether it can be removed. */
  checklistCount: extras.checklistCount ?? 0,
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
});

/**
 * Attach the department label and the usage count for a page of templates.
 *
 * Two queries for a page rather than two per row.
 */
async function enrich(rows) {
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r._id);
  const [counts, departments] = await Promise.all([
    OnboardingChecklist.aggregate([
      { $match: { templateId: { $in: ids } } },
      { $group: { _id: '$templateId', n: { $sum: 1 } } },
    ]),
    Promise.all(
      [...new Set(rows.map((r) => idStr(r.appliesToDepartmentId)).filter(Boolean))].map(
        async (id) => [id, (await resolveDepartment(id).catch(() => null))?.name ?? null],
      ),
    ),
  ]);

  const byTemplate = new Map(counts.map((c) => [idStr(c._id), c.n]));
  const deptName = new Map(departments);

  return rows.map((r) =>
    toDto(r, {
      checklistCount: byTemplate.get(idStr(r._id)) ?? 0,
      appliesToDepartmentName: deptName.get(idStr(r.appliesToDepartmentId)) ?? null,
    }),
  );
}

export async function listTemplates(query = {}) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, active, search } = query;

  const filter = {
    deletedAt: null,
    ...(active === undefined ? {} : { active }),
    // Anchored to the start, and escaped — a search term is data, not a pattern.
    ...(search ? { name: { $regex: `^${escapeRegex(search)}`, $options: 'i' } } : {}),
  };

  const [rows, total] = await Promise.all([
    OnboardingTemplate.find(filter)
      // Active first, then alphabetical — the reference's ordering exactly.
      .sort({ active: -1, name: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    OnboardingTemplate.countDocuments(filter),
  ]);

  return { data: await enrich(rows), total, page, pageSize };
}

/** A user-supplied search term is data, not a pattern. */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function getTemplate(id) {
  const row = await loadTemplate(id);
  return (await enrich([row]))[0];
}

export async function createTemplate(input, context = {}) {
  if (input.appliesToDepartmentId) await assertDepartment(input.appliesToDepartmentId);

  let row;
  try {
    row = await OnboardingTemplate.create({
      name: input.name,
      appliesToRoleKey: input.appliesToRoleKey ?? null,
      appliesToDepartmentId: input.appliesToDepartmentId
        ? oid(input.appliesToDepartmentId)
        : null,
      active: input.active,
      tasks: normaliseTasks(input.tasks),
      createdByUserId: context.user?._id ?? null,
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError(`A template called "${input.name}" already exists.`, {
        code: 'TEMPLATE_NAME_TAKEN',
      });
    }
    throw error;
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ONBOARDING_TEMPLATE_CREATED,
    `Created the onboarding template "${row.name}" with ${row.tasks.length} task(s)`,
    context.req,
    { meta: { templateId: idStr(row._id), name: row.name, taskCount: row.tasks.length } },
  );

  return getTemplate(row._id);
}

export async function updateTemplate(id, input, context = {}) {
  const existing = await loadTemplate(id);
  if (input.appliesToDepartmentId) await assertDepartment(input.appliesToDepartmentId);

  const $set = {};
  if (input.name !== undefined) $set.name = input.name;
  if (input.appliesToRoleKey !== undefined) $set.appliesToRoleKey = input.appliesToRoleKey;
  if (input.appliesToDepartmentId !== undefined) {
    $set.appliesToDepartmentId = input.appliesToDepartmentId
      ? oid(input.appliesToDepartmentId)
      : null;
  }
  if (input.active !== undefined) $set.active = input.active;

  /**
   * Replacing the task list REPLACES it, as the reference does.
   *
   * Checklists already running are untouched: their tasks were copied at
   * instantiation, so editing a template never rewrites work in progress. That
   * is the reason the copy exists.
   */
  if (input.tasks !== undefined) $set.tasks = normaliseTasks(input.tasks);

  try {
    await OnboardingTemplate.updateOne({ _id: existing._id, deletedAt: null }, { $set });
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError(`A template called "${input.name}" already exists.`, {
        code: 'TEMPLATE_NAME_TAKEN',
      });
    }
    throw error;
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ONBOARDING_TEMPLATE_UPDATED,
    `Updated the onboarding template "${existing.name}"`,
    context.req,
    { meta: { templateId: idStr(existing._id), fields: Object.keys($set) } },
  );

  return getTemplate(existing._id);
}

/**
 * Retire a template.
 *
 * A template that has ever been instantiated is refused outright rather than
 * soft-deleted: the checklists that ran from it are the payroll-grade record of
 * what a new hire was actually asked to do, and "delete the template" must not
 * read as an instruction to touch them. Deactivating is the way to take an
 * in-use template out of circulation, and the message says so.
 */
export async function retireTemplate(id, context = {}) {
  const existing = await loadTemplate(id);

  const used = await OnboardingChecklist.countDocuments({ templateId: existing._id });
  if (used > 0) {
    throw new HrmsConflictError(
      `"${existing.name}" has been used to start ${used} onboarding checklist(s), so it cannot be deleted. Mark it inactive instead.`,
      { code: 'TEMPLATE_IN_USE' },
    );
  }

  await OnboardingTemplate.updateOne(
    { _id: existing._id, deletedAt: null },
    { $set: { deletedAt: new Date(), active: false } },
  );

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ONBOARDING_TEMPLATE_RETIRED,
    `Deleted the unused onboarding template "${existing.name}"`,
    context.req,
    { meta: { templateId: idStr(existing._id), name: existing.name } },
  );
}

// ---------------------------------------------------------------------------

/** Order is normalised to the array's own order when the caller leaves gaps. */
function normaliseTasks(tasks = []) {
  return tasks.map((t, i) => ({
    title: t.title,
    description: t.description ?? null,
    dueDays: t.dueDays,
    assignTo: t.assignTo,
    order: Number.isInteger(t.order) && t.order > 0 ? t.order : i,
  }));
}

async function assertDepartment(departmentId) {
  const department = await resolveDepartment(departmentId).catch(() => null);
  if (!department) {
    throw new HrmsValidationError('Unknown department.', [
      { path: 'appliesToDepartmentId', message: 'That department does not exist.' },
    ]);
  }
}

export async function loadTemplate(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Template');
  const row = await OnboardingTemplate.findOne({ _id: id, deletedAt: null }).lean();
  if (!row) throw new HrmsNotFoundError('Template');
  return row;
}

export { toDto as templateDto, oid, idStr };

export default {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  retireTemplate,
};
