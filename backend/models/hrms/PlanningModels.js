/**
 * Planning collections.
 *
 * Ported from the reference's `HeadcountPlan` and `HiringPlan` Prisma models,
 * adapted to Mongoose and the accepted decisions:
 *
 *   AD-1   single tenant, so no organizationId — the reference's
 *          `@@unique([organizationId, financialYear, departmentId])` becomes a
 *          unique index on `(financialYear, departmentId)`
 *   AD-2   ObjectId keys, no foreign keys (the services resolve every
 *          reference before writing), and money is Decimal128
 *   AD-13  both lists are server-paginated, so the indexes below matter
 *
 * Two collections in one file because they are one module: the page is a single
 * screen with two tabs, and neither model means anything without the other's
 * context.
 *
 * ---------------------------------------------------------------------------
 * 🔴 Two derived columns the reference stores and never maintains
 * ---------------------------------------------------------------------------
 * The reference's table carries `actualHeadcount Int @default(0)` and
 * `totalBudget Decimal(16,2)`. Neither is a fact about the plan:
 *
 *   `actualHeadcount` is never written by anything. Its service computes the
 *   number live at read time and returns that, so the stored column reads 0
 *   forever to anything querying the table directly.
 *
 *   `totalBudget` IS written at create — and then ignored at read, where the
 *   service recomputes `budgetPerHead × plannedHeadcount`. Two sources of truth
 *   for one number, which disagree the moment a row is edited anywhere else.
 *
 * Both are therefore absent here and derived on read, once. A plan stores what
 * was PLANNED; what is actual is a question about Employee, and what the plan
 * costs is arithmetic.
 */

import mongoose from 'mongoose';

import {
  HIRING_PLAN_STATUSES,
  FINANCIAL_YEAR_PATTERN,
  PLANNED_HEADCOUNT_MAX,
} from '../../shared/constants/planning.js';

const { Schema } = mongoose;

/** A date the business means as a DAY, stored as one. See the note below. */
const isoDay = {
  type: String,
  match: [/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date'],
};

// ---------------------------------------------------------------------------
// Headcount plan
// ---------------------------------------------------------------------------

const headcountPlanSchema = new Schema(
  {
    /**
     * `FY2026`. Shape-checked here as well as in the Zod schema, because the
     * unique index below is only a guarantee if the key has one spelling.
     */
    financialYear: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      match: [FINANCIAL_YEAR_PATTERN, 'Expected a financial year like FY2026'],
    },

    /**
     * Null means ORG-WIDE — the reference's own table renders a null department
     * as "Org-wide". Kept nullable rather than split into a separate flag so
     * the unique index can treat it as part of the key.
     */
    departmentId: { type: Schema.Types.ObjectId, default: null },

    /**
     * Denormalised at write time so a list of plans needs no join, matching
     * every other module here. Refreshed whenever the plan is updated.
     */
    departmentName: { type: String, default: null, trim: true, maxlength: 200 },

    plannedHeadcount: {
      type: Number,
      required: true,
      min: 0,
      max: PLANNED_HEADCOUNT_MAX,
      validate: {
        validator: Number.isInteger,
        message: 'Planned headcount must be a whole number of people.',
      },
    },

    /**
     * Decimal128, never Number (AD-2). 🔴 The reference declares
     * `Decimal(14,2)` and then multiplies it as a JavaScript float, so a
     * per-head budget carrying paise loses precision on the way to a total.
     */
    budgetPerHead: { type: Schema.Types.Decimal128, default: null },

    notes: { type: String, default: null, trim: true, maxlength: 2000 },

    /** Who planned it. Retained for the same reason every other module does. */
    createdByUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'hrms_headcount_plans' },
);

/**
 * One plan per department per year — the reference's unique constraint, minus
 * the tenant column (AD-1).
 *
 * MongoDB treats every `null` as a distinct value for uniqueness purposes in a
 * *sparse* index, but this index is not sparse: a plain unique compound index
 * over a stored `null` compares nulls as equal, which is exactly what is wanted
 * here — there is one org-wide plan per year, not many.
 */
headcountPlanSchema.index({ financialYear: 1, departmentId: 1 }, { unique: true });

/** The list: a year's plans, department-ordered, oldest first (the reference's order). */
headcountPlanSchema.index({ financialYear: -1, createdAt: 1 });

// ---------------------------------------------------------------------------
// Hiring plan
// ---------------------------------------------------------------------------

const hiringPlanSchema = new Schema(
  {
    /** The job title being planned for. Free text in the reference too. */
    role: { type: String, required: true, trim: true, maxlength: 200 },

    /**
     * A DAY, stored as `YYYY-MM-DD`.
     *
     * 🔴 The reference declares `@db.Date` and feeds it
     * `new Date(dto.plannedByDate)` from an ISO *datetime* DTO, so a target
     * date entered in the evening in IST is stored as the previous day in UTC.
     * A target date has no time and no zone; storing the string it is means the
     * value cannot drift.
     */
    plannedByDate: { ...isoDay, required: true },

    /**
     * When the role was actually filled. 🔴 The reference has this column, has
     * a table column rendering it, and ships no endpoint that could ever write
     * it — so it renders "—" for every row forever.
     */
    actualByDate: { ...isoDay, default: null },

    status: {
      type: String,
      required: true,
      enum: HIRING_PLAN_STATUSES,
      default: 'planned',
    },

    departmentId: { type: Schema.Types.ObjectId, default: null },
    departmentName: { type: String, default: null, trim: true, maxlength: 200 },

    /**
     * The requisition this plan is being tracked against, if any.
     *
     * The reference stores this and NEVER reads it — there is no join, no
     * pipeline lookup and no status propagation anywhere in its codebase. It is
     * kept for the same reason, and validated to exist (AD-2 puts that check in
     * the service, because MongoDB will not do it). Reading Hiring's pipeline to
     * drive a plan's status would be inventing behaviour the reference does not
     * have, and is not done.
     */
    requisitionId: { type: Schema.Types.ObjectId, default: null },
    requisitionTitle: { type: String, default: null, trim: true, maxlength: 200 },

    notes: { type: String, default: null, trim: true, maxlength: 2000 },

    createdByUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'hrms_hiring_plans' },
);

/** The default list: everything, soonest target first (the reference's order). */
hiringPlanSchema.index({ plannedByDate: 1, createdAt: 1 });
/** Filtered by status, which is what a planning review actually does. */
hiringPlanSchema.index({ status: 1, plannedByDate: 1 });
hiringPlanSchema.index({ departmentId: 1, plannedByDate: 1 });
/** The reference's own `@@index([requisitionId])`, kept. */
hiringPlanSchema.index({ requisitionId: 1 });

// ---------------------------------------------------------------------------

export const HeadcountPlan =
  mongoose.models.HeadcountPlan || mongoose.model('HeadcountPlan', headcountPlanSchema);
export const HiringPlan =
  mongoose.models.HiringPlan || mongoose.model('HiringPlan', hiringPlanSchema);

export default { HeadcountPlan, HiringPlan };
