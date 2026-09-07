/**
 * Headcount plans — planned headcount and budget per financial year.
 *
 * Ported from `planning.service.ts#listHeadcountPlans / createHeadcountPlan`.
 *
 * ---------------------------------------------------------------------------
 * Deliberate corrections
 * ---------------------------------------------------------------------------
 * 1. AN ORG-WIDE PLAN COUNTS THE ORGANISATION. 🔴 The reference computes
 *    `p.departmentId ? countMap.get(p.departmentId) ?? 0 : 0` — a plan with no
 *    department, which its own UI labels "Org-wide" and its drawer produces by
 *    default, is HARDCODED to zero actual headcount. Its utilization bar reads
 *    0% forever and the page's "Actual Headcount" tile silently under-counts.
 *    Org-wide means every active employee, which is what is counted here.
 *
 * 2. ONE SOURCE OF TRUTH PER DERIVED NUMBER. The reference STORES `totalBudget`
 *    at create and then RECOMPUTES it at read, ignoring the stored column; and
 *    it stores an `actualHeadcount` column that nothing ever writes. Both are
 *    derived here and neither is stored — see the model's header.
 *
 * 3. MONEY IS NEVER A FLOAT. 🔴 The reference multiplies a `Decimal(14,2)`
 *    read back as a JavaScript number: `budgetPerHead * plannedHeadcount`. The
 *    multiplication here is exact integer paise arithmetic in BigInt, and the
 *    result reaches the database as a string (AD-2).
 *
 * 4. THE UNIQUE CONSTRAINT IS HANDLED. The reference declares
 *    `@@unique([organizationId, financialYear, departmentId])` and does not
 *    catch the violation, so planning the same department twice returns a
 *    Prisma 500. Here it is a 409 that says which plan already exists.
 *
 * 5. THE DEPARTMENT IS VALIDATED. The reference stores any UUID it is given
 *    and then renders the resulting null name as "Org-wide" — so a plan for a
 *    department that does not exist is indistinguishable from a deliberate
 *    org-wide plan. AD-2 puts that check here, because MongoDB will not do it.
 *
 * 6. THE LIST IS PAGINATED AND THE YEAR FILTER IS OPTIONAL (AD-13). The
 *    reference returns every plan ever made, unbounded, and runs an unfiltered
 *    `groupBy` over every active employee on every request.
 *
 * 7. A PLAN CAN BE CORRECTED. The reference has no update endpoint, so a typo
 *    in a planned number is permanent and the only remedy is a duplicate row
 *    the unique index refuses.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import { HeadcountPlan } from '../../../models/hrms/PlanningModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS, PAGE_SIZE_DEFAULT } from '../../../shared/constants/hrms.js';
import { HEADCOUNT_ACTIVE_STATUSES } from '../../../shared/constants/planning.js';
import { fromDecimal } from '../../../shared/payroll/money.js';
import { resolveDepartment } from '../references/reference.service.js';
import { HrmsNotFoundError, HrmsConflictError } from '../hrms.errors.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

// ---------------------------------------------------------------------------
// Budget arithmetic
// ---------------------------------------------------------------------------

/**
 * `budgetPerHead × plannedHeadcount`, exactly.
 *
 * 🔴 The reference does this in double-precision floating point on a value it
 * declared as `Decimal(14,2)`. A per-head budget of ₹83,333.33 times 300 heads
 * is ₹2,49,99,999.00 exactly; the float route can land a paisa either side of
 * it, and the number is a budget somebody signs off.
 *
 * Paise are integers, so the multiplication is done in `BigInt` — no cap on the
 * operands, no rounding, and no dependence on the 2^53 safe-integer range that
 * a large budget times a large headcount would leave.
 *
 * `perHead` arrives as the wire STRING the `money()` schema produced, or as a
 * Decimal128 read back from the database. Both stringify to a plain decimal.
 */
export function totalBudgetString(perHead, headcount) {
  if (perHead === null || perHead === undefined) return null;

  const str = String(perHead).trim();
  const negative = str.startsWith('-');
  const [whole, fraction = ''] = (negative ? str.slice(1) : str).split('.');
  // Pad or truncate to exactly two decimal places, giving whole paise.
  const paise = BigInt(`${whole || '0'}${(fraction + '00').slice(0, 2)}`);

  const total = (negative ? -paise : paise) * BigInt(Math.trunc(Number(headcount) || 0));
  const sign = total < 0n ? '-' : '';
  const magnitude = (total < 0n ? -total : total).toString().padStart(3, '0');

  return `${sign}${magnitude.slice(0, -2)}.${magnitude.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// Actual headcount
// ---------------------------------------------------------------------------

/**
 * How many people are actually in each planned department, plus the org total.
 *
 * ONE aggregation for a whole page rather than a query per row, and restricted
 * to the departments on the page — the reference groups over every active
 * employee in the company on every request, whatever it was asked for.
 *
 * Soft-deleted employees are excluded (`deletedAt: null`), which the reference
 * has no equivalent of; an exited employee is not `active`, so they fall out on
 * status alone as well.
 */
async function actualHeadcounts(departmentIds) {
  const live = { deletedAt: null, status: { $in: HEADCOUNT_ACTIVE_STATUSES } };

  const [byDepartment, orgTotal] = await Promise.all([
    departmentIds.length
      ? Employee.aggregate([
          { $match: { ...live, departmentId: { $in: departmentIds.map(oid) } } },
          { $group: { _id: '$departmentId', count: { $sum: 1 } } },
        ])
      : Promise.resolve([]),
    Employee.countDocuments(live),
  ]);

  const map = new Map(byDepartment.map((r) => [idStr(r._id), r.count]));
  return { map, orgTotal };
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

const toDto = (row, actualHeadcount) => {
  const budgetPerHead = row.budgetPerHead ?? null;

  return {
    id: idStr(row._id),
    financialYear: row.financialYear,
    departmentId: idStr(row.departmentId),
    departmentName: row.departmentName ?? null,
    /** Null department means org-wide, which is the reference's own convention. */
    orgWide: !row.departmentId,
    plannedHeadcount: row.plannedHeadcount,
    /** Derived, never stored — see correction 2. */
    actualHeadcount,
    budgetPerHead: budgetPerHead === null ? null : fromDecimal(budgetPerHead),
    totalBudget:
      budgetPerHead === null
        ? null
        : fromDecimal(totalBudgetString(budgetPerHead, row.plannedHeadcount)),
    notes: row.notes ?? null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
};

/** Attach the live actual headcount to a page of plans, in one aggregation. */
async function enrich(rows) {
  if (rows.length === 0) return [];

  const departmentIds = [...new Set(rows.map((r) => idStr(r.departmentId)).filter(Boolean))];
  const { map, orgTotal } = await actualHeadcounts(departmentIds);

  return rows.map((row) =>
    toDto(row, row.departmentId ? (map.get(idStr(row.departmentId)) ?? 0) : orgTotal),
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listHeadcountPlans(query = {}) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, financialYear, departmentId } = query;

  const filter = {
    ...(financialYear ? { financialYear } : {}),
    ...(departmentId ? { departmentId: oid(departmentId) } : {}),
  };

  const [rows, total] = await Promise.all([
    HeadcountPlan.find(filter)
      // The reference's ordering: newest year first, then oldest plan first.
      .sort({ financialYear: -1, createdAt: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    HeadcountPlan.countDocuments(filter),
  ]);

  return { data: await enrich(rows), total, page, pageSize };
}

export async function getHeadcountPlan(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Headcount plan');
  const row = await HeadcountPlan.findById(id).lean();
  if (!row) throw new HrmsNotFoundError('Headcount plan');
  return (await enrich([row]))[0];
}

/**
 * The year's totals, for the page's three summary tiles.
 *
 * The reference sums these in the browser over the rows it happened to fetch,
 * which is only right while the list is unpaginated — the moment it is not, the
 * tiles describe the visible page rather than the year. Summed server-side, in
 * the database, over the whole year.
 */
export async function headcountSummary(query = {}) {
  const filter = query.financialYear ? { financialYear: query.financialYear } : {};
  const rows = await HeadcountPlan.find(filter).lean();
  const enriched = await enrich(rows);

  return {
    financialYear: query.financialYear ?? null,
    planCount: enriched.length,
    plannedHeadcount: enriched.reduce((sum, r) => sum + r.plannedHeadcount, 0),
    /**
     * Summed over DEPARTMENT plans only. An org-wide plan's actual is the whole
     * company, so adding it to the departmental figures would count most people
     * twice; when there is no departmental plan at all, the org-wide figure is
     * the only one there is.
     */
    actualHeadcount: enriched.some((r) => !r.orgWide)
      ? enriched.filter((r) => !r.orgWide).reduce((sum, r) => sum + r.actualHeadcount, 0)
      : (enriched[0]?.actualHeadcount ?? 0),
    totalBudget: enriched.reduce((sum, r) => sum + (r.totalBudget ?? 0), 0),
  };
}

/** Every financial year that has a plan, newest first — for the year picker. */
export async function financialYears() {
  const years = await HeadcountPlan.distinct('financialYear');
  return years.sort().reverse();
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Resolve the department, or confirm the plan is deliberately org-wide.
 *
 * See correction 5 — an unvalidated id renders as "Org-wide" in the reference,
 * so a mistake is invisible.
 */
async function resolveTarget(departmentId) {
  if (!departmentId) return { departmentId: null, departmentName: null };

  const department = await resolveDepartment(departmentId).catch(() => null);
  if (!department) throw new HrmsNotFoundError('Department');

  return { departmentId: oid(departmentId), departmentName: department.name ?? null };
}

export async function createHeadcountPlan(input, context = {}) {
  const target = await resolveTarget(input.departmentId);

  const existing = await HeadcountPlan.findOne({
    financialYear: input.financialYear,
    departmentId: target.departmentId,
  }).lean();
  if (existing) {
    throw new HrmsConflictError(
      target.departmentId
        ? `${target.departmentName ?? 'That department'} already has a plan for ${input.financialYear}.`
        : `There is already an org-wide plan for ${input.financialYear}.`,
      { details: { headcountPlanId: idStr(existing._id) } },
    );
  }

  let row;
  try {
    row = await HeadcountPlan.create({
      financialYear: input.financialYear,
      departmentId: target.departmentId,
      departmentName: target.departmentName,
      plannedHeadcount: input.plannedHeadcount,
      // A string reaches Decimal128 exactly; a number would not (AD-2).
      budgetPerHead: input.budgetPerHead ?? null,
      notes: input.notes ?? null,
      createdByUserId: context.user?._id ?? null,
    });
  } catch (error) {
    // Two requests for the same plan crossing between the check and the write.
    if (error?.code === 11000) {
      throw new HrmsConflictError(`A plan for ${input.financialYear} already exists.`);
    }
    throw error;
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.HEADCOUNT_PLAN_CREATED,
    `Planned ${input.plannedHeadcount} ${input.plannedHeadcount === 1 ? 'person' : 'people'} for ${
      target.departmentName ?? 'the whole company'
    } in ${input.financialYear}`,
    context.req,
    {
      meta: {
        headcountPlanId: idStr(row._id),
        financialYear: input.financialYear,
        departmentId: idStr(target.departmentId),
        plannedHeadcount: input.plannedHeadcount,
        budgetPerHead: input.budgetPerHead ?? null,
      },
    },
  );

  /**
   * Re-read through `enrich`, so what the client gets back is the real row.
   * 🔴 The reference hardcodes `actualHeadcount: 0` and `departmentName: null`
   * into its create response even when a department WAS supplied, so the row
   * shown immediately after creating is wrong until something refetches.
   */
  return (await enrich([row.toObject()]))[0];
}

export async function updateHeadcountPlan(id, input, context = {}) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Headcount plan');

  const existing = await HeadcountPlan.findById(id);
  if (!existing) throw new HrmsNotFoundError('Headcount plan');

  const patch = {};
  if (input.plannedHeadcount !== undefined) patch.plannedHeadcount = input.plannedHeadcount;
  if (input.budgetPerHead !== undefined) patch.budgetPerHead = input.budgetPerHead ?? null;
  if (input.notes !== undefined) patch.notes = input.notes ?? null;

  const before = {
    plannedHeadcount: existing.plannedHeadcount,
    budgetPerHead: existing.budgetPerHead === null ? null : fromDecimal(existing.budgetPerHead),
  };

  existing.set(patch);
  await existing.save();

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.HEADCOUNT_PLAN_UPDATED,
    `Updated the ${existing.financialYear} plan for ${existing.departmentName ?? 'the whole company'}`,
    context.req,
    {
      meta: {
        headcountPlanId: idStr(existing._id),
        financialYear: existing.financialYear,
        before,
        after: {
          plannedHeadcount: existing.plannedHeadcount,
          budgetPerHead:
            existing.budgetPerHead === null ? null : fromDecimal(existing.budgetPerHead),
        },
      },
    },
  );

  return (await enrich([existing.toObject()]))[0];
}

export default {
  listHeadcountPlans,
  getHeadcountPlan,
  headcountSummary,
  financialYears,
  createHeadcountPlan,
  updateHeadcountPlan,
  totalBudgetString,
};
