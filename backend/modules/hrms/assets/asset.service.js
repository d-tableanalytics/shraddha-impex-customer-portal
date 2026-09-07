/**
 * Assets: catalogue, inventory, assignment and requests.
 *
 * Ported from the reference's `AssetCategoryService`, `AssetItemService` and
 * `AssetRequestService`. The workflow is its workflow:
 *
 *   available â”€â”€assignâ”€â”€â–¶ assigned â”€â”€returnâ”€â”€â–¶ available
 *        â””â”€â”€ set status â”€â”€â–¶ in_repair | retired | lost   (issue auto-closed)
 *
 *   submitted â”€â”€approveâ”€â”€â–¶ approved â”€â”€fulfilâ”€â”€â–¶ fulfilled
 *        â”œâ”€â”€rejectâ”€â”€â–¶ rejected     â””â”€â”€ cancel â”€â”€â–¶ cancelled
 *
 * Corrections to the reference, each deliberate and each covered by a test:
 *
 *   1. `assigned` CANNOT BE SET DIRECTLY. The reference's `setStatus` accepts
 *      it, producing an item that reads as issued with no assignment behind it
 *      â€” and which `assign()` then refuses because it is no longer available.
 *      Here `status` and the active assignment are derived from one another in
 *      the model, so they cannot disagree.
 *
 *   2. SERIAL NUMBERS ARE UNIQUE. The reference has neither a constraint nor a
 *      check, so two items can share one serial and a return can be booked
 *      against the wrong one.
 *
 *   3. AN ASSET IS NOT ISSUED TO SOMEONE WHO HAS LEFT. The reference checks
 *      only that the employee row exists.
 *
 *   4. THE ASSIGNMENT CARRIES THE ASSET. The reference's query fetches the item
 *      and its category and then drops both in the DTO, so its My Assets screen
 *      shows dates and conditions without ever saying which asset.
 *
 *   5. RETURNS RECORD A CONDITION. The reference has the field and its own
 *      return control never sends it.
 *
 *   6. MONEY IS EXACT, AND ZERO IS A PRICE. The reference stores a float and
 *      treats `purchasePrice: 0` as absent through a falsy test.
 *
 *   7. LISTS ARE PAGED, FILTERED AND SEARCHED SERVER-SIDE (AD-13).
 *
 *   8. CATEGORIES ARE SOFT-DELETED and refused while anything still points at
 *      them. The reference hard-deletes and counts only items, so a category
 *      with open requests deletes cleanly and orphans them.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import { AssetCategory, AssetItem, AssetRequest } from '../../../models/hrms/AssetModels.js';
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
  createAssetCategorySchema,
  updateAssetCategorySchema,
  createAssetItemSchema,
  updateAssetItemSchema,
  setAssetStatusSchema,
  assetListQuerySchema,
  assignAssetSchema,
  returnAssetSchema,
  createAssetRequestSchema,
  decideAssetRequestSchema,
  fulfillAssetRequestSchema,
  assetRequestListQuerySchema,
  TERMINAL_ASSET_STATUSES,
} from '../../../shared/schemas/asset.js';
import { formatZodIssues } from '../../../shared/validation/common.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsValidationError,
  HrmsForbiddenError,
} from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));

/** Money out to the wire: always two decimal places, never re-parsed. */
const dec = (v) => {
  if (v === null || v === undefined) return null;
  const [whole, fraction = ''] = String(v).split('.');
  return `${whole}.${`${fraction}00`.slice(0, 2)}`;
};

const iso = (v) => (v ? new Date(v).toISOString() : null);

function parse(schema, input, what) {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw new HrmsValidationError(`Invalid ${what}.`, formatZodIssues(result.error));
  }
  return result.data;
}

/** Whoever administers the inventory. The reference's single admin gate. */
const isAssetAdmin = (actor) => hasHrmsPermission(actor, M.ASSETS, A.ASSIGN, S.ORG);

/** Escape a user string before it becomes part of a regular expression. */
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const fullName = (employee) =>
  `${employee?.firstName ?? ''} ${employee?.lastName ?? ''}`.trim();

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

const categoryToDto = (row, itemCount = 0) => ({
  id: idStr(row._id),
  name: row.name,
  code: row.code,
  requiresSerialNumber: row.requiresSerialNumber,
  defaultLifespanMonths: row.defaultLifespanMonths,
  itemCount,
});

const assignmentToDto = (assignment, item, category) => ({
  id: idStr(assignment._id),
  assetItemId: idStr(item?._id),
  /**
   * WHICH asset. The reference's assignment DTO omits every one of these, so
   * its My Assets table can only show when something was issued, never what.
   */
  categoryId: idStr(item?.categoryId),
  categoryName: category?.name ?? null,
  serialNumber: item?.serialNumber ?? null,
  brand: item?.brand ?? null,
  model: item?.model ?? null,

  employeeId: idStr(assignment.employeeId),
  employeeName: assignment.employeeName || null,
  assignedAt: iso(assignment.assignedAt),
  assignedByName: assignment.assignedByName || null,
  conditionOnAssign: assignment.conditionOnAssign ?? null,
  returnedAt: iso(assignment.returnedAt),
  conditionOnReturn: assignment.conditionOnReturn ?? null,
  closedByStatus: assignment.closedByStatus ?? null,
});

const itemToDto = (row, category) => {
  const active = (row.assignments ?? []).find((a) => !a.returnedAt) ?? null;
  return {
    id: idStr(row._id),
    categoryId: idStr(row.categoryId),
    categoryName: category?.name ?? null,
    categoryCode: category?.code ?? null,
    serialNumber: row.serialNumber ?? null,
    brand: row.brand ?? null,
    model: row.model ?? null,
    purchaseDate: row.purchaseDate ?? null,
    warrantyEnd: row.warrantyEnd ?? null,
    amcEnd: row.amcEnd ?? null,
    purchasePrice: dec(row.purchasePrice),
    status: row.status,
    notes: row.notes ?? null,
    currentAssignment: active
      ? {
          id: idStr(active._id),
          employeeId: idStr(active.employeeId),
          employeeName: active.employeeName || null,
          assignedAt: iso(active.assignedAt),
          conditionOnAssign: active.conditionOnAssign ?? null,
        }
      : null,
    assignmentCount: (row.assignments ?? []).length,
    createdAt: iso(row.createdAt),
  };
};

const requestToDto = (row, { category, item, actor } = {}) => ({
  id: idStr(row._id),
  employeeId: idStr(row.employeeId),
  employeeName: row.employeeName || null,
  /**
   * Whether this request belongs to the person reading it.
   *
   * The queue needs it to stop offering a Decide button the server would refuse
   * â€” nobody decides their own request. Computed here rather than compared in
   * the browser, because the browser would have to be told the viewer's
   * employee id to do it, and that is a fact it does not otherwise need.
   */
  isOwnRequest:
    Boolean(actor?.employeeId) && idStr(row.employeeId) === idStr(actor.employeeId),
  categoryId: idStr(row.categoryId),
  categoryName: category?.name ?? null,
  justification: row.justification,
  status: row.status,
  decidedByName: row.decidedByName || null,
  decidedAt: iso(row.decidedAt),
  rejectionReason: row.rejectionReason ?? null,
  fulfilledAssetItemId: idStr(row.fulfilledAssetItemId),
  fulfilledSerialNumber: item?.serialNumber ?? null,
  fulfilledAt: iso(row.fulfilledAt),
  createdAt: iso(row.createdAt),
});

/** Live categories keyed by id, for a page of items or requests. */
async function categoriesByIds(ids = []) {
  const valid = ids.filter((id) => id && mongoose.isValidObjectId(id));
  if (valid.length === 0) return new Map();
  const rows = await AssetCategory.find({ _id: { $in: valid } })
    .select('_id name code')
    .lean();
  return new Map(rows.map((r) => [idStr(r._id), r]));
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function listCategories() {
  const rows = await AssetCategory.find({ deletedAt: null }).sort({ name: 1 }).lean();
  if (rows.length === 0) return [];

  // One grouped count, not one query per category.
  const counts = await AssetItem.aggregate([
    { $match: { deletedAt: null, categoryId: { $in: rows.map((r) => r._id) } } },
    { $group: { _id: '$categoryId', n: { $sum: 1 } } },
  ]);
  const byCategory = new Map(counts.map((c) => [idStr(c._id), c.n]));

  return rows.map((row) => categoryToDto(row, byCategory.get(idStr(row._id)) ?? 0));
}

export async function createCategory(input, actor, context = {}) {
  if (!isAssetAdmin(actor)) throw new HrmsForbiddenError('Only IT or HR can manage categories.');
  const dto = parse(createAssetCategorySchema, input, 'asset category');

  let row;
  try {
    row = await AssetCategory.create(dto);
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError(`Asset category "${dto.code}" already exists.`, {
        code: 'ASSET_CATEGORY_CODE_TAKEN',
      });
    }
    throw error;
  }

  const category = categoryToDto(row.toObject(), 0);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ASSET_CATEGORY_CREATED,
    `Created asset category ${category.code} (${category.name})`,
    context.req,
    { meta: { categoryId: category.id, code: category.code } },
  );
  return category;
}

export async function updateCategory(id, input, actor, context = {}) {
  if (!isAssetAdmin(actor)) throw new HrmsForbiddenError('Only IT or HR can manage categories.');
  const dto = parse(updateAssetCategorySchema, input, 'asset category');
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Asset category');

  const row = await AssetCategory.findOne({ _id: id, deletedAt: null });
  if (!row) throw new HrmsNotFoundError('Asset category');

  Object.assign(row, dto);
  await row.save();

  const category = categoryToDto(row.toObject(), 0);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ASSET_CATEGORY_UPDATED,
    `Updated asset category ${category.code}`,
    context.req,
    { meta: { categoryId: category.id, fields: Object.keys(dto) } },
  );
  return category;
}

/**
 * Retire a category.
 *
 * Soft, and refused while anything still points at it â€” items OR requests. The
 * reference hard-deletes and counts only items, so a category with open
 * requests deletes cleanly and leaves them pointing at nothing.
 */
export async function deleteCategory(id, actor, context = {}) {
  if (!isAssetAdmin(actor)) throw new HrmsForbiddenError('Only IT or HR can manage categories.');
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Asset category');

  const row = await AssetCategory.findOne({ _id: id, deletedAt: null }).lean();
  if (!row) throw new HrmsNotFoundError('Asset category');

  const [items, requests] = await Promise.all([
    AssetItem.countDocuments({ categoryId: id, deletedAt: null }),
    AssetRequest.countDocuments({ categoryId: id, deletedAt: null }),
  ]);
  if (items > 0 || requests > 0) {
    throw new HrmsConflictError(
      `"${row.name}" still has ${items} item${items === 1 ? '' : 's'} and ${requests} request${requests === 1 ? '' : 's'} booked to it. Retire those first.`,
      { code: 'ASSET_CATEGORY_IN_USE', details: { itemCount: items, requestCount: requests } },
    );
  }

  await AssetCategory.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ASSET_CATEGORY_DELETED,
    `Deleted asset category ${row.code} (${row.name})`,
    context.req,
    { meta: { categoryId: idStr(row._id), code: row.code } },
  );
  return { id: idStr(row._id), code: row.code, deleted: true };
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/**
 * The inventory grid. Administrators only â€” an ordinary employee sees their own
 * kit through `myAssets`, never the whole estate.
 *
 * Paged, filtered and searched by the SERVER. The reference ships every item
 * and pages the array in the browser.
 */
export async function listItems(actor, query = {}) {
  if (!hasHrmsPermission(actor, M.ASSETS, A.VIEW, S.ORG)) {
    throw new HrmsForbiddenError('You cannot view the asset inventory.');
  }
  const dto = parse(assetListQuerySchema, query, 'asset filter');
  const { page, pageSize } = dto;

  const filter = { deletedAt: null };
  if (dto.status) filter.status = dto.status;
  if (dto.categoryId) filter.categoryId = dto.categoryId;
  if (dto.search) {
    const rx = new RegExp(escapeRegex(dto.search), 'i');
    filter.$or = [{ serialNumber: rx }, { brand: rx }, { model: rx }];
  }

  const [rows, total] = await Promise.all([
    AssetItem.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    AssetItem.countDocuments(filter),
  ]);

  const categories = await categoriesByIds(rows.map((r) => r.categoryId));
  return {
    data: rows.map((row) => itemToDto(row, categories.get(idStr(row.categoryId)))),
    total,
    page,
    pageSize,
  };
}

export async function getItem(id, actor) {
  if (!hasHrmsPermission(actor, M.ASSETS, A.VIEW, S.ORG)) {
    throw new HrmsForbiddenError('You cannot view the asset inventory.');
  }
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Asset');

  const row = await AssetItem.findOne({ _id: id, deletedAt: null }).lean();
  if (!row) throw new HrmsNotFoundError('Asset');

  const categories = await categoriesByIds([row.categoryId]);
  const category = categories.get(idStr(row.categoryId));
  return {
    ...itemToDto(row, category),
    /** The full issue history, newest first. */
    assignments: (row.assignments ?? [])
      .slice()
      .sort((a, b) => new Date(b.assignedAt) - new Date(a.assignedAt))
      .map((a) => assignmentToDto(a, row, category)),
  };
}

export async function createItem(input, actor, context = {}) {
  if (!isAssetAdmin(actor)) throw new HrmsForbiddenError('Only IT or HR can add assets.');
  const dto = parse(createAssetItemSchema, input, 'asset');

  const category = await AssetCategory.findOne({
    _id: dto.categoryId,
    deletedAt: null,
  }).lean();
  if (!category) throw new HrmsValidationError('That asset category does not exist.');

  const serialNumber = dto.serialNumber?.trim() || null;
  if (category.requiresSerialNumber && !serialNumber) {
    throw new HrmsValidationError(
      `A serial number is required for ${category.name}.`,
      [{ path: 'serialNumber', message: 'Required for this category.' }],
    );
  }

  let row;
  try {
    row = await AssetItem.create({
      ...dto,
      serialNumber,
      purchasePrice:
        dto.purchasePrice === null || dto.purchasePrice === undefined
          ? null
          : mongoose.Types.Decimal128.fromString(String(dto.purchasePrice)),
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError(
        `Serial number "${serialNumber}" is already on another asset.`,
        { code: 'ASSET_SERIAL_TAKEN' },
      );
    }
    throw error;
  }

  const item = itemToDto(row.toObject(), category);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ASSET_ITEM_CREATED,
    `Added ${category.name}${serialNumber ? ` (${serialNumber})` : ''} to the inventory`,
    context.req,
    { meta: { assetItemId: item.id, categoryId: idStr(category._id) } },
  );
  return item;
}

export async function updateItem(id, input, actor, context = {}) {
  if (!isAssetAdmin(actor)) throw new HrmsForbiddenError('Only IT or HR can edit assets.');
  const dto = parse(updateAssetItemSchema, input, 'asset');
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Asset');

  const row = await AssetItem.findOne({ _id: id, deletedAt: null });
  if (!row) throw new HrmsNotFoundError('Asset');

  const category = await AssetCategory.findById(row.categoryId).lean();
  if (dto.serialNumber !== undefined) {
    const next = dto.serialNumber?.trim() || null;
    if (category?.requiresSerialNumber && !next) {
      throw new HrmsValidationError(`A serial number is required for ${category.name}.`);
    }
    row.serialNumber = next;
  }

  for (const field of ['brand', 'model', 'purchaseDate', 'warrantyEnd', 'amcEnd', 'notes']) {
    if (dto[field] !== undefined) row[field] = dto[field];
  }
  if (dto.purchasePrice !== undefined) {
    row.purchasePrice =
      dto.purchasePrice === null
        ? null
        : mongoose.Types.Decimal128.fromString(String(dto.purchasePrice));
  }

  try {
    await row.save();
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError('That serial number is already on another asset.', {
        code: 'ASSET_SERIAL_TAKEN',
      });
    }
    throw error;
  }

  const item = itemToDto(row.toObject(), category);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ASSET_ITEM_UPDATED,
    `Updated asset ${item.serialNumber ?? item.id}`,
    context.req,
    { meta: { assetItemId: item.id, fields: Object.keys(dto) } },
  );
  return item;
}

/**
 * Move an item between the non-assigned statuses.
 *
 * `assigned` is not settable â€” the schema refuses it. An item still out when it
 * is retired, lost or sent for repair has its issue closed here, and the model
 * derives the rest, so status and holder cannot disagree.
 */
export async function setItemStatus(id, input, actor, context = {}) {
  if (!isAssetAdmin(actor)) throw new HrmsForbiddenError('Only IT or HR can change asset status.');
  const dto = parse(setAssetStatusSchema, input, 'asset status');
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Asset');

  const row = await AssetItem.findOne({ _id: id, deletedAt: null });
  if (!row) throw new HrmsNotFoundError('Asset');

  if (row.status === dto.status) {
    throw new HrmsConflictError(`This asset is already ${dto.status.replace('_', ' ')}.`, {
      code: 'ASSET_STATUS_UNCHANGED',
    });
  }
  if (TERMINAL_ASSET_STATUSES.includes(row.status)) {
    throw new HrmsConflictError(
      `A ${row.status} asset cannot change status again.`,
      { code: 'ASSET_TERMINAL' },
    );
  }

  const active = (row.assignments ?? []).find((a) => !a.returnedAt);
  if (active) {
    active.returnedAt = new Date();
    active.returnedByEmployeeId = actor?.employeeId ?? null;
    active.conditionOnReturn = dto.note ?? null;
    active.closedByStatus = dto.status;
  }

  row.status = dto.status;
  if (dto.note) row.notes = dto.note;
  await row.save();

  const category = await AssetCategory.findById(row.categoryId).lean();
  const item = itemToDto(row.toObject(), category);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ASSET_STATUS_CHANGED,
    `Marked asset ${item.serialNumber ?? item.id} as ${dto.status}`,
    context.req,
    {
      meta: {
        assetItemId: item.id,
        status: dto.status,
        closedAssignment: Boolean(active),
      },
    },
  );
  return item;
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export async function assignItem(input, actor, context = {}) {
  if (!isAssetAdmin(actor)) throw new HrmsForbiddenError('Only IT or HR can assign assets.');
  const dto = parse(assignAssetSchema, input, 'assignment');

  const row = await AssetItem.findOne({ _id: dto.assetItemId, deletedAt: null });
  if (!row) throw new HrmsNotFoundError('Asset');
  if (row.status !== 'available') {
    throw new HrmsConflictError(
      `This asset is ${row.status.replace('_', ' ')} and cannot be assigned.`,
      { code: 'ASSET_NOT_AVAILABLE' },
    );
  }

  const employee = await Employee.findOne({ _id: dto.employeeId, deletedAt: null }).lean();
  if (!employee) throw new HrmsValidationError('That employee does not exist.');
  // The reference checks only that the row exists, so it will issue a laptop to
  // somebody who left last month.
  if (employee.status === 'exited' || employee.status === 'inactive') {
    throw new HrmsConflictError(
      `${fullName(employee)} has left; an asset cannot be issued to them.`,
      { code: 'EMPLOYEE_NOT_ACTIVE' },
    );
  }

  const assigner = actor?.employeeId
    ? await Employee.findById(actor.employeeId).select('firstName lastName').lean()
    : null;

  row.assignments.push({
    employeeId: employee._id,
    employeeName: fullName(employee),
    assignedAt: new Date(),
    assignedByEmployeeId: actor?.employeeId ?? null,
    assignedByName: assigner ? fullName(assigner) : '',
    conditionOnAssign: dto.conditionOnAssign ?? null,
  });
  // `status` and `assignedToEmployeeId` follow from the history in the model.
  await row.save();

  const category = await AssetCategory.findById(row.categoryId).lean();
  const item = itemToDto(row.toObject(), category);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ASSET_ASSIGNED,
    `Assigned ${category?.name ?? 'asset'} ${item.serialNumber ?? ''} to ${fullName(employee)}`.trim(),
    context.req,
    { meta: { assetItemId: item.id, employeeId: idStr(employee._id) } },
  );

  // The reference's assignment notice, to the person it was issued to.
  await notify({
    to: idStr(employee._id),
    type: INBOX_TYPES.ASSET_ASSIGNED,
    title: `${category?.name ?? 'An asset'} has been assigned to you`,
    body: 'Check My Assets to acknowledge receipt.',
    entity: 'asset_assignment',
    entityId: item.id,
  });

  return item;
}

/**
 * Take an asset back.
 *
 * Addressed by the ITEM, not by an assignment id: there is exactly one open
 * issue per item, so the item is the thing an administrator has in front of
 * them, and an id that must be looked up first is an id that can be got wrong.
 */
export async function returnItem(id, input, actor, context = {}) {
  if (!isAssetAdmin(actor)) throw new HrmsForbiddenError('Only IT or HR can accept returns.');
  const dto = parse(returnAssetSchema, input, 'return');
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Asset');

  const row = await AssetItem.findOne({ _id: id, deletedAt: null });
  if (!row) throw new HrmsNotFoundError('Asset');

  const active = (row.assignments ?? []).find((a) => !a.returnedAt);
  if (!active) {
    throw new HrmsConflictError('This asset is not currently assigned to anybody.', {
      code: 'ASSET_NOT_ASSIGNED',
    });
  }

  const heldBy = active.employeeName;
  active.returnedAt = new Date();
  active.returnedByEmployeeId = actor?.employeeId ?? null;
  // The reference's own return control sends nothing here, which is why its
  // "Condition on return" column can only ever render a dash.
  active.conditionOnReturn = dto.conditionOnReturn ?? null;
  await row.save();

  const category = await AssetCategory.findById(row.categoryId).lean();
  const item = itemToDto(row.toObject(), category);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ASSET_RETURNED,
    `${heldBy} returned ${category?.name ?? 'asset'} ${item.serialNumber ?? ''}`.trim(),
    context.req,
    { meta: { assetItemId: item.id, employeeId: idStr(active.employeeId) } },
  );
  return item;
}

/**
 * What one employee is holding, and what they have held.
 *
 * Self-service by default; a wider scope is required to look at anybody else.
 * This is the endpoint an IT admin uses when working the `it` clearance on an
 * exit â€” see documentation/hrms-assets-analysis.md Â§9.1.
 */
export async function assignmentsForEmployee(employeeId, actor) {
  const target = employeeId ?? idStr(actor?.employeeId);
  if (!target) return { data: [], outstanding: 0 };

  const isSelf = idStr(target) === idStr(actor?.employeeId);
  if (!isSelf && !hasHrmsPermission(actor, M.ASSETS, A.VIEW, S.ORG)) {
    throw new HrmsForbiddenError('You cannot view another employeeâ€™s assets.');
  }
  if (!mongoose.isValidObjectId(target)) throw new HrmsNotFoundError('Employee');

  // Every item this person appears in the history of â€” not only what they hold
  // now, so a returned asset stays visible to them.
  const rows = await AssetItem.find({
    deletedAt: null,
    'assignments.employeeId': target,
  }).lean();

  const categories = await categoriesByIds(rows.map((r) => r.categoryId));

  const data = [];
  for (const row of rows) {
    const category = categories.get(idStr(row.categoryId));
    for (const assignment of row.assignments ?? []) {
      if (idStr(assignment.employeeId) !== idStr(target)) continue;
      data.push(assignmentToDto(assignment, row, category));
    }
  }
  data.sort((a, b) => new Date(b.assignedAt) - new Date(a.assignedAt));

  return { data, outstanding: data.filter((a) => !a.returnedAt).length };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export async function listRequests(actor, query = {}) {
  const dto = parse(assetRequestListQuerySchema, query, 'request filter');
  const { page, pageSize } = dto;

  const filter = { deletedAt: null };
  if (dto.status) filter.status = dto.status;

  // An administrator sees the queue; everyone else sees only their own.
  if (!isAssetAdmin(actor)) {
    if (!actor?.employeeId) return { data: [], total: 0, page, pageSize };
    filter.employeeId = actor.employeeId;
  }

  const [rows, total] = await Promise.all([
    AssetRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    AssetRequest.countDocuments(filter),
  ]);

  const categories = await categoriesByIds(rows.map((r) => r.categoryId));
  const itemIds = rows.map((r) => r.fulfilledAssetItemId).filter(Boolean);
  const items = itemIds.length
    ? await AssetItem.find({ _id: { $in: itemIds } }).select('_id serialNumber').lean()
    : [];
  const itemById = new Map(items.map((i) => [idStr(i._id), i]));

  return {
    data: rows.map((row) =>
      requestToDto(row, {
        category: categories.get(idStr(row.categoryId)),
        item: itemById.get(idStr(row.fulfilledAssetItemId)),
        actor,
      }),
    ),
    total,
    page,
    pageSize,
  };
}

export async function createRequest(input, actor, context = {}) {
  const dto = parse(createAssetRequestSchema, input, 'asset request');

  if (!actor?.employeeId) {
    throw new HrmsValidationError(
      'Your user account is not linked to an employee record, so you cannot request an asset.',
    );
  }

  const category = await AssetCategory.findOne({
    _id: dto.categoryId,
    deletedAt: null,
  }).lean();
  if (!category) throw new HrmsValidationError('That asset category does not exist.');

  const employee = await Employee.findOne({
    _id: actor.employeeId,
    deletedAt: null,
  }).lean();
  if (!employee) throw new HrmsValidationError('Your employee record could not be found.');

  // One open request per category. The reference has no such rule, so a
  // frustrated employee can queue ten identical requests for a laptop.
  const existing = await AssetRequest.findOne({
    employeeId: actor.employeeId,
    categoryId: dto.categoryId,
    status: { $in: ['submitted', 'approved'] },
    deletedAt: null,
  }).lean();
  if (existing) {
    throw new HrmsConflictError(
      `You already have an open request for ${category.name}.`,
      { code: 'ASSET_REQUEST_OPEN', details: { requestId: idStr(existing._id) } },
    );
  }

  const row = await AssetRequest.create({
    employeeId: actor.employeeId,
    employeeName: fullName(employee),
    categoryId: dto.categoryId,
    justification: dto.justification,
    status: 'submitted',
  });

  const request = requestToDto(row.toObject(), { category, actor });
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ASSET_REQUEST_CREATED,
    `Requested ${category.name}`,
    context.req,
    { meta: { requestId: request.id, categoryId: idStr(category._id) } },
  );

  /**
   * The reference notifies every IT admin. Same recipients here, resolved from
   * the ROLE matrix rather than from anything the requester sent.
   *
   * 🔴 The justification is not copied in. The reference puts 100 characters
   * of the requester's own words into the notification; the request itself is
   * one click away for exactly the people being told.
   */
  await notify({
    to: await assetAdmins(),
    type: INBOX_TYPES.ASSET_REQUEST_RAISED,
    title: `${fullName(employee)} requested ${category.name}`,
    body: 'Awaiting your decision.',
    entity: 'asset_request',
    entityId: request.id,
  });

  return request;
}

/**
 * Who decides asset requests: IT admins, plus HR.
 *
 * `isAssetAdmin` is the authorisation rule for deciding one, so these are the
 * roles it admits — the notification and the permission cannot drift apart.
 */
async function assetAdmins() {
  const { HRMS_ROLES: R } = await import('../../../shared/permissions/constants.js');
  const User = (await import('../../../models/User.js')).default;

  const users = await User.find({
    roles: { $in: [R.IT_ADMIN, R.HR_ADMIN, R.SUPER_ADMIN] },
    status: 'Active',
  })
    .select('_id')
    .lean();
  if (users.length === 0) return [];

  const admins = await Employee.find({
    userId: { $in: users.map((u) => u._id) },
    deletedAt: null,
  })
    .select('_id')
    .lean();
  return admins.map((e) => idStr(e._id));
}

export async function decideRequest(id, input, actor, context = {}) {
  if (!isAssetAdmin(actor)) throw new HrmsForbiddenError('Only IT or HR can decide asset requests.');
  const dto = parse(decideAssetRequestSchema, input, 'decision');
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Asset request');

  const row = await AssetRequest.findOne({ _id: id, deletedAt: null });
  if (!row) throw new HrmsNotFoundError('Asset request');
  if (row.status !== 'submitted') {
    throw new HrmsConflictError(
      `A request can only be decided while it is submitted; this one is ${row.status}.`,
      { code: 'ASSET_REQUEST_BAD_STATE' },
    );
  }
  // Nobody approves the request they raised, however senior.
  if (idStr(row.employeeId) === idStr(actor?.employeeId)) {
    throw new HrmsForbiddenError('You cannot decide your own asset request.');
  }

  const decider = actor?.employeeId
    ? await Employee.findById(actor.employeeId).select('firstName lastName').lean()
    : null;

  row.status = dto.decision === 'approve' ? 'approved' : 'rejected';
  row.decidedByEmployeeId = actor?.employeeId ?? null;
  row.decidedByName = decider ? fullName(decider) : '';
  row.decidedAt = new Date();
  row.rejectionReason = dto.decision === 'reject' ? (dto.reason ?? null) : null;
  await row.save();

  const category = await AssetCategory.findById(row.categoryId).lean();
  const request = requestToDto(row.toObject(), { category, actor });
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ASSET_REQUEST_DECIDED,
    `${dto.decision === 'approve' ? 'Approved' : 'Rejected'} the ${category?.name ?? 'asset'} request from ${row.employeeName}`,
    context.req,
    { meta: { requestId: request.id, decision: dto.decision } },
  );

  // The reference's decision notice, to whoever raised the request.
  await notify({
    to: idStr(row.employeeId),
    type: INBOX_TYPES.ASSET_REQUEST_DECIDED,
    title: `Your ${category?.name ?? 'asset'} request was ${dto.decision === 'approve' ? 'approved' : 'rejected'}`,
    // No rejection reason: free text on a record the requester can open.
    body: null,
    entity: 'asset_request',
    entityId: request.id,
  });

  return request;
}

/** Issue a specific item against an approved request, in one step. */
export async function fulfillRequest(id, input, actor, context = {}) {
  if (!isAssetAdmin(actor)) throw new HrmsForbiddenError('Only IT or HR can fulfil asset requests.');
  const dto = parse(fulfillAssetRequestSchema, input, 'fulfilment');
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Asset request');

  const row = await AssetRequest.findOne({ _id: id, deletedAt: null });
  if (!row) throw new HrmsNotFoundError('Asset request');
  if (row.status !== 'approved') {
    throw new HrmsConflictError(
      `Only an approved request can be fulfilled; this one is ${row.status}.`,
      { code: 'ASSET_REQUEST_BAD_STATE' },
    );
  }

  const item = await AssetItem.findOne({ _id: dto.assetItemId, deletedAt: null }).lean();
  if (!item) throw new HrmsValidationError('That asset does not exist.');
  if (idStr(item.categoryId) !== idStr(row.categoryId)) {
    throw new HrmsValidationError('That asset is not in the category that was requested.');
  }

  // Reuses the assignment path, so the employee and availability checks, the
  // history entry and the derived status all behave identically.
  const assigned = await assignItem(
    { assetItemId: dto.assetItemId, employeeId: idStr(row.employeeId) },
    actor,
    context,
  );

  row.status = 'fulfilled';
  row.fulfilledAssetItemId = dto.assetItemId;
  row.fulfilledAt = new Date();
  await row.save();

  const category = await AssetCategory.findById(row.categoryId).lean();
  const request = requestToDto(row.toObject(), {
    category,
    item: { serialNumber: assigned.serialNumber },
    actor,
  });
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ASSET_REQUEST_FULFILLED,
    `Fulfilled ${row.employeeName}'s ${category?.name ?? 'asset'} request`,
    context.req,
    { meta: { requestId: request.id, assetItemId: idStr(dto.assetItemId) } },
  );
  return request;
}

export async function cancelRequest(id, actor, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Asset request');

  const row = await AssetRequest.findOne({ _id: id, deletedAt: null });
  if (!row) throw new HrmsNotFoundError('Asset request');

  const isSelf = idStr(row.employeeId) === idStr(actor?.employeeId);
  if (!isSelf && !isAssetAdmin(actor)) {
    throw new HrmsForbiddenError('Only the requester or IT can cancel this request.');
  }
  if (row.status !== 'submitted' && row.status !== 'approved') {
    throw new HrmsConflictError(`A ${row.status} request can no longer be cancelled.`, {
      code: 'ASSET_REQUEST_BAD_STATE',
    });
  }

  const wasStatus = row.status;
  row.status = 'cancelled';
  row.cancelledAt = new Date();
  await row.save();

  const category = await AssetCategory.findById(row.categoryId).lean();
  const request = requestToDto(row.toObject(), { category, actor });
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.ASSET_REQUEST_CANCELLED,
    `Cancelled the ${category?.name ?? 'asset'} request from ${row.employeeName} (was ${wasStatus})`,
    context.req,
    { meta: { requestId: request.id, previousStatus: wasStatus } },
  );
  return request;
}

export default {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  listItems,
  getItem,
  createItem,
  updateItem,
  setItemStatus,
  assignItem,
  returnItem,
  assignmentsForEmployee,
  listRequests,
  createRequest,
  decideRequest,
  fulfillRequest,
  cancelRequest,
};
