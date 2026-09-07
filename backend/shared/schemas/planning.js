/**
 * Planning wire contracts (AD-6).
 *
 * One definition per payload, validated by the `validate` middleware on the way
 * in and driving the same forms on the way out, so a rule cannot drift between
 * the two halves.
 */

import { z } from 'zod';

import { objectId, isoDay, money, paginationQuery } from '../validation/common.js';
import {
  HIRING_PLAN_STATUSES,
  FINANCIAL_YEAR_PATTERN,
  FINANCIAL_YEAR_HINT,
  FINANCIAL_YEAR_MIN,
  FINANCIAL_YEAR_MAX,
  PLANNED_HEADCOUNT_MAX,
} from '../constants/planning.js';

// ---------------------------------------------------------------------------
// Financial year
// ---------------------------------------------------------------------------

/**
 * `FY2026`, and nothing else.
 *
 * 🔴 The reference accepts `z.string().min(1).max(20)` here, so "FY2026",
 * "2026", "fy2026" and "FY 2026" are four distinct years to a unique index that
 * is supposed to guarantee one plan per department per year. Uppercasing and
 * pinning the shape is what makes that index mean what it claims.
 */
export const financialYear = z
  .string()
  .trim()
  .toUpperCase()
  .regex(FINANCIAL_YEAR_PATTERN, FINANCIAL_YEAR_HINT)
  .refine((v) => {
    const year = Number(v.slice(2));
    return year >= FINANCIAL_YEAR_MIN && year <= FINANCIAL_YEAR_MAX;
  }, `year must be between ${FINANCIAL_YEAR_MIN} and ${FINANCIAL_YEAR_MAX}`);

// ---------------------------------------------------------------------------
// Headcount plans
// ---------------------------------------------------------------------------

/**
 * An absent department means the plan is ORG-WIDE — the reference's own UI
 * labels a null department "Org-wide", and its drawer leaves the select empty
 * by default. `null` and omitted mean the same thing, so both are accepted and
 * both normalise to null.
 */
const optionalDepartmentId = objectId.nullish().transform((v) => v ?? null);

export const createHeadcountPlanSchema = z.object({
  financialYear,
  departmentId: optionalDepartmentId,
  plannedHeadcount: z.coerce.number().int().min(0).max(PLANNED_HEADCOUNT_MAX),
  // A string on the wire, because a JS number has already lost the paise by the
  // time it is parsed (AD-2). `null` clears it.
  budgetPerHead: money({ max: 1e11 }).nullish().transform((v) => v ?? null),
  notes: z.string().trim().max(2000).nullish().transform((v) => v ?? null),
});

/**
 * The reference has no update endpoint for a headcount plan at all — a plan is
 * created and then frozen, so a typo in the planned number is permanent.
 *
 * The year and the department are NOT updatable: together they identify the
 * plan and are the unique key. Moving a plan to another department is creating
 * a different plan.
 */
export const updateHeadcountPlanSchema = z
  .object({
    plannedHeadcount: z.coerce.number().int().min(0).max(PLANNED_HEADCOUNT_MAX).optional(),
    budgetPerHead: money({ max: 1e11 }).nullish().optional(),
    notes: z.string().trim().max(2000).nullish().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

export const listHeadcountPlansQuery = paginationQuery.extend({
  // Optional, so the page can open on everything rather than on nothing — the
  // reference's filter defaults to the current year and hides every other plan.
  financialYear: financialYear.optional(),
  departmentId: objectId.optional(),
});

// ---------------------------------------------------------------------------
// Hiring plans
// ---------------------------------------------------------------------------

export const createHiringPlanSchema = z.object({
  role: z.string().trim().min(1).max(200),
  // An ISO DAY, not a datetime. 🔴 The reference types this as a datetime and
  // stores it in a SQL `Date`, so a target date entered near midnight lands on
  // the wrong day depending on the browser's offset.
  plannedByDate: isoDay,
  departmentId: optionalDepartmentId,
  requisitionId: objectId.nullish().transform((v) => v ?? null),
  notes: z.string().trim().max(2000).nullish().transform((v) => v ?? null),
});

/**
 * Editing the plan itself. The status is deliberately NOT here — a transition
 * is a different act with a different audit action and its own legality check,
 * and folding it into a general patch is how a state machine stops being one.
 */
export const updateHiringPlanSchema = z
  .object({
    role: z.string().trim().min(1).max(200).optional(),
    plannedByDate: isoDay.optional(),
    departmentId: objectId.nullish().optional(),
    requisitionId: objectId.nullish().optional(),
    notes: z.string().trim().max(2000).nullish().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

export const hiringPlanStatusSchema = z.object({
  status: z.enum(HIRING_PLAN_STATUSES),
  /**
   * Optional, and only meaningful when completing. Left out, completing stamps
   * today — the reference can never fill this column at all, having no endpoint
   * that writes it.
   */
  actualByDate: isoDay.nullish().transform((v) => v ?? null),
  notes: z.string().trim().max(2000).nullish().transform((v) => v ?? null),
});

export const listHiringPlansQuery = paginationQuery.extend({
  status: z.enum(HIRING_PLAN_STATUSES).optional(),
  departmentId: objectId.optional(),
  requisitionId: objectId.optional(),
});

export default {
  financialYear,
  createHeadcountPlanSchema,
  updateHeadcountPlanSchema,
  listHeadcountPlansQuery,
  createHiringPlanSchema,
  updateHiringPlanSchema,
  hiringPlanStatusSchema,
  listHiringPlansQuery,
};
