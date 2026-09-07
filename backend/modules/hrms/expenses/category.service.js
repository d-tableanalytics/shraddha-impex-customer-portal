/**
 * Expense categories and their policies.
 *
 * Ported from the reference's `ExpenseCategoryService` and
 * `ExpensePolicyService`. Both are administered by the same grant
 * (`expenses:approve:org`) and read by anyone who can file a claim, so they
 * live together.
 *
 * Two corrections to the reference:
 *
 *   1. DELETE IS SOFT. The reference hard-deletes a category, and its line
 *      items hold a foreign key to it — so a historical claim would lose the
 *      name of what it was booked against. AD-2 removed foreign keys entirely,
 *      which makes a hard delete strictly worse here.
 *
 *   2. A DUPLICATE CODE IS A BUSINESS CONFLICT, not a driver error escaping as
 *      a 500.
 */

import mongoose from 'mongoose';

import ExpenseCategory from '../../../models/hrms/ExpenseCategory.js';
import ExpensePolicy from '../../../models/hrms/ExpensePolicy.js';
import ExpenseClaim from '../../../models/hrms/ExpenseClaim.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS } from '../../../shared/constants/hrms.js';
import {
  createExpenseCategorySchema,
  updateExpenseCategorySchema,
  upsertExpensePolicySchema,
} from '../../../shared/schemas/expense.js';
import { formatZodIssues } from '../../../shared/validation/common.js';
import { HrmsNotFoundError, HrmsConflictError, HrmsValidationError } from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const dec = (v) => (v === null || v === undefined ? null : String(v));

function parse(schema, input, what) {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw new HrmsValidationError(`Invalid ${what}.`, formatZodIssues(result.error));
  }
  return result.data;
}

const categoryToDto = (row, policy) => ({
  id: idStr(row._id),
  code: row.code,
  name: row.name,
  glCode: row.glCode ?? null,
  tallyLedger: row.tallyLedger ?? null,
  active: row.active,
  policy: policy
    ? {
        id: idStr(policy._id),
        dailyLimit: dec(policy.dailyLimit),
        monthlyLimit: dec(policy.monthlyLimit),
        autoApproveBelow: dec(policy.autoApproveBelow),
        requiresReceipt: policy.requiresReceipt,
        requiresApproval: policy.requiresApproval,
      }
    : null,
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Categories, each with its policy attached.
 *
 * One query for categories and one for policies, then a join in memory — not
 * one policy lookup per category.
 *
 * @param {object} [options]
 * @param {boolean} [options.includeInactive] retired-from-the-picker rows too;
 *   an administrator needs them, a claimant does not.
 */
export async function listCategories({ includeInactive = false } = {}) {
  const filter = { deletedAt: null };
  if (!includeInactive) filter.active = true;

  const rows = await ExpenseCategory.find(filter).sort({ name: 1 }).lean();
  if (rows.length === 0) return [];

  const policies = await ExpensePolicy.find({
    categoryId: { $in: rows.map((r) => r._id) },
    deletedAt: null,
  }).lean();
  const policyByCategory = new Map(policies.map((p) => [idStr(p.categoryId), p]));

  return rows.map((row) => categoryToDto(row, policyByCategory.get(idStr(row._id))));
}

export async function getCategory(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Expense category');

  const row = await ExpenseCategory.findOne({ _id: id, deletedAt: null }).lean();
  if (!row) throw new HrmsNotFoundError('Expense category');

  const policy = await ExpensePolicy.findOne({ categoryId: id, deletedAt: null }).lean();
  return categoryToDto(row, policy);
}

/** Live categories keyed by id, for validating a claim's lines in one query. */
export async function categoriesByIds(ids = []) {
  const valid = ids.filter((id) => mongoose.isValidObjectId(id));
  if (valid.length === 0) return new Map();

  const rows = await ExpenseCategory.find({ _id: { $in: valid }, deletedAt: null })
    .select('_id code name active')
    .lean();
  return new Map(rows.map((r) => [idStr(r._id), r]));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function translateDuplicate(error, code) {
  if (error?.code === 11000) {
    return new HrmsConflictError(`Expense category "${code}" already exists.`, {
      code: 'EXPENSE_CATEGORY_CODE_TAKEN',
    });
  }
  return error;
}

export async function createCategory(input, context = {}) {
  const dto = parse(createExpenseCategorySchema, input, 'expense category');

  let row;
  try {
    row = await ExpenseCategory.create(dto);
  } catch (error) {
    throw translateDuplicate(error, dto.code);
  }

  const category = categoryToDto(row, null);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXPENSE_CATEGORY_CREATED,
    `Created expense category ${category.code} (${category.name})`,
    context.req,
    { meta: { categoryId: category.id, code: category.code } },
  );
  return category;
}

export async function updateCategory(id, input, context = {}) {
  const dto = parse(updateExpenseCategorySchema, input, 'expense category');
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Expense category');

  const existing = await ExpenseCategory.findOne({ _id: id, deletedAt: null });
  if (!existing) throw new HrmsNotFoundError('Expense category');

  Object.assign(existing, dto);

  try {
    await existing.save();
  } catch (error) {
    throw translateDuplicate(error, dto.code ?? existing.code);
  }

  const policy = await ExpensePolicy.findOne({ categoryId: id, deletedAt: null }).lean();
  const category = categoryToDto(existing.toObject(), policy);

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXPENSE_CATEGORY_UPDATED,
    `Updated expense category ${category.code}`,
    context.req,
    { meta: { categoryId: category.id, fields: Object.keys(dto) } },
  );
  return category;
}

/**
 * Retire a category.
 *
 * Refused while any live claim still books a line to it. The reference hard
 * deletes and relies on a foreign key it no longer has here, so the check is
 * explicit — otherwise a historical claim would render a blank where the
 * category name should be.
 */
export async function deleteCategory(id, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Expense category');

  const existing = await ExpenseCategory.findOne({ _id: id, deletedAt: null }).lean();
  if (!existing) throw new HrmsNotFoundError('Expense category');

  const inUse = await ExpenseClaim.countDocuments({
    deletedAt: null,
    'lineItems.categoryId': id,
  });
  if (inUse > 0) {
    throw new HrmsConflictError(
      `${inUse} claim${inUse === 1 ? '' : 's'} still book expenses to "${existing.name}". Deactivate it instead so it stops appearing on new claims.`,
      { code: 'EXPENSE_CATEGORY_IN_USE', details: { claimCount: inUse } },
    );
  }

  await ExpenseCategory.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });
  await ExpensePolicy.updateMany({ categoryId: id }, { $set: { deletedAt: new Date() } });

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXPENSE_CATEGORY_DELETED,
    `Deleted expense category ${existing.code} (${existing.name})`,
    context.req,
    { meta: { categoryId: idStr(existing._id), code: existing.code } },
  );

  return { id: idStr(existing._id), code: existing.code, deleted: true };
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/**
 * Create or replace the policy for a category.
 *
 * The reference's endpoint is an upsert keyed on the category, and so is this:
 * a category has at most one policy.
 */
export async function upsertPolicy(input, context = {}) {
  const dto = parse(upsertExpensePolicySchema, input, 'expense policy');

  const category = await ExpenseCategory.findOne({
    _id: dto.categoryId,
    deletedAt: null,
  }).lean();
  if (!category) throw new HrmsValidationError('That expense category does not exist.');

  const toDecimal = (v) =>
    v === null || v === undefined ? null : mongoose.Types.Decimal128.fromString(String(v));

  const update = {
    dailyLimit: toDecimal(dto.dailyLimit),
    monthlyLimit: toDecimal(dto.monthlyLimit),
    autoApproveBelow: toDecimal(dto.autoApproveBelow),
    requiresReceipt: dto.requiresReceipt,
    requiresApproval: dto.requiresApproval,
    deletedAt: null,
  };

  const row = await ExpensePolicy.findOneAndUpdate(
    { categoryId: dto.categoryId },
    { $set: update, $setOnInsert: { categoryId: dto.categoryId } },
    { new: true, upsert: true, runValidators: true },
  ).lean();

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.EXPENSE_POLICY_UPSERTED,
    `Set the expense policy for ${category.code}`,
    context.req,
    { meta: { categoryId: idStr(dto.categoryId), code: category.code } },
  );

  return categoryToDto(category, row).policy;
}

export default {
  listCategories,
  getCategory,
  categoriesByIds,
  createCategory,
  updateCategory,
  deleteCategory,
  upsertPolicy,
};
