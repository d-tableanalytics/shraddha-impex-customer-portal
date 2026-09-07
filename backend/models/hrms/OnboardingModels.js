/**
 * Onboarding collections.
 *
 * Ported from the reference's Prisma models, adapted to Mongoose and the
 * accepted decisions:
 *
 *   AD-1   single tenant, so no organizationId
 *   AD-2   ObjectId keys, no foreign keys — the services check references,
 *          and money is Decimal128
 *   AD-7   the offer letter lives in object storage, never on the instance's
 *          disk, and is read only through a presigned URL
 *   AD-13  every list is server-paginated, so the indexes below matter
 *
 * Grouped in one file because these four collections are one aggregate: a task
 * template is meaningless without its template, and a task without its
 * checklist. The offer letter is here because the reference ships it inside the
 * same module and its lifecycle feeds the same screens.
 *
 * ---------------------------------------------------------------------------
 * Tasks are EMBEDDED in their checklist; task templates in their template
 * ---------------------------------------------------------------------------
 * The reference gives each its own table because Prisma needs one. Here they
 * are subdocuments, because a task is never queried without its checklist, the
 * whole set is written in one instantiation, and the count is bounded by the
 * template (100 tasks). That makes "update one task, then recompute whether the
 * checklist is settled" a single atomic document write rather than the
 * reference's read-modify-write across two tables.
 *
 * The one query that does need to reach across is "tasks assigned to me", and
 * the index below serves it directly.
 */

import mongoose from 'mongoose';

import {
  ASSIGN_TO,
  CHECKLIST_STATUSES,
  TASK_STATUSES,
  DUE_DAYS_MIN,
  DUE_DAYS_MAX,
} from '../../shared/constants/onboarding.js';

const { Schema } = mongoose;

const isoDay = { type: String, match: [/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date'] };

// ---------------------------------------------------------------------------
// OnboardingTemplate (+ embedded task templates)
// ---------------------------------------------------------------------------

const taskTemplateSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: null, trim: true, maxlength: 2000 },
    /** Days after the checklist starts. The reference defaults to 3. */
    dueDays: {
      type: Number,
      required: true,
      default: 3,
      min: DUE_DAYS_MIN,
      max: DUE_DAYS_MAX,
    },
    assignTo: { type: String, required: true, enum: ASSIGN_TO },
    order: { type: Number, required: true, default: 0, min: 0, max: 999 },
  },
  { _id: true },
);

const onboardingTemplateSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },

    /**
     * Advisory only, and documented as such.
     *
     * The reference stores both, renders them in the "Applies to" column, and
     * never reads either — no code picks a template from a new hire's role or
     * department. Kept so the field survives a migration; not wired to
     * selection, because there is no reference behaviour to reproduce.
     */
    appliesToRoleKey: { type: String, default: null, trim: true, maxlength: 60 },
    appliesToDepartmentId: { type: Schema.Types.ObjectId, default: null },

    active: { type: Boolean, required: true, default: true, index: true },

    tasks: {
      type: [taskTemplateSchema],
      default: undefined,
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0 && v.length <= 100,
        message: 'A template needs between 1 and 100 tasks.',
      },
    },

    /**
     * Soft delete.
     *
     * 🔴 The reference hard-deletes a template. Its checklists hold an optional
     * `templateId` with no `onDelete`, so Prisma nulls the column and every live
     * checklist silently loses its provenance — the Checklists table then shows
     * "—" where the template name was. A template that has ever been used is
     * retired here instead, and the service refuses to remove one in use.
     */
    deletedAt: { type: Date, default: null, index: true },

    createdByUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'hrms_onboarding_templates' },
);

/** The list is ordered active-first then by name, exactly as the reference orders it. */
onboardingTemplateSchema.index({ active: -1, name: 1 });
onboardingTemplateSchema.index(
  { name: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

// ---------------------------------------------------------------------------
// OnboardingChecklist (+ embedded tasks)
// ---------------------------------------------------------------------------

const onboardingTaskSchema = new Schema(
  {
    /** Which template task this came from. Null once that template task is gone. */
    taskTemplateId: { type: Schema.Types.ObjectId, default: null },

    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: null, trim: true, maxlength: 2000 },

    /**
     * The assignee is an EMPLOYEE, not a user account.
     *
     * The reference stores `assigneeUserId`, which cannot express a task owned
     * by somebody who has no login — and a new hire on day zero very often does
     * not have one yet. Employee is the canonical identity here (AD-4), exactly
     * as Hiring's interview panel is keyed on employees.
     */
    assigneeEmployeeId: { type: Schema.Types.ObjectId, default: null },
    /** Denormalised at instantiation so a list needs no join. */
    assigneeName: { type: String, default: null, trim: true, maxlength: 200 },

    assignTo: { type: String, required: true, enum: ASSIGN_TO },

    dueDate: { ...isoDay, default: null },

    status: { type: String, required: true, enum: TASK_STATUSES, default: 'pending' },
    completedAt: { type: Date, default: null },
    completedByUserId: { type: Schema.Types.ObjectId, default: null },

    notes: { type: String, default: null, trim: true, maxlength: 2000 },
    order: { type: Number, required: true, default: 0, min: 0, max: 999 },
  },
  { _id: true, timestamps: true },
);

const onboardingChecklistSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, required: true },
    /** Denormalised for the list; the employee's name at instantiation. */
    employeeName: { type: String, default: null, trim: true, maxlength: 200 },

    templateId: { type: Schema.Types.ObjectId, default: null },
    /**
     * The template's name AT INSTANTIATION.
     *
     * Copied rather than joined, so retiring or renaming a template never
     * rewrites the history of checklists that ran from it.
     */
    templateName: { type: String, default: null, trim: true, maxlength: 160 },

    status: { type: String, required: true, enum: CHECKLIST_STATUSES, default: 'active', index: true },

    startedAt: { type: Date, required: true, default: Date.now },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, default: null, trim: true, maxlength: 500 },

    tasks: { type: [onboardingTaskSchema], default: [] },

    createdByUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'hrms_onboarding_checklists' },
);

/**
 * ONE ACTIVE CHECKLIST PER EMPLOYEE, enforced by the database.
 *
 * 🔴 The reference checks for an existing active checklist with a `findFirst`
 * and then creates — a read-then-write with nothing behind it, so two
 * concurrent "Start onboarding" clicks both succeed and the employee ends up
 * with two live task lists. The partial index makes the guard real; the service
 * still pre-checks, but only to produce a better message than a duplicate-key
 * error.
 */
onboardingChecklistSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);

/** The list is ordered active-first then most recently started. */
onboardingChecklistSchema.index({ status: 1, startedAt: -1 });

/** One employee's onboarding history — the new-hire portal's only query. */
onboardingChecklistSchema.index({ employeeId: 1, startedAt: -1 });

/** "What is assigned to me" — the one query that reaches across checklists. */
onboardingChecklistSchema.index({ 'tasks.assigneeEmployeeId': 1, 'tasks.status': 1 });

// ---------------------------------------------------------------------------
// OfferLetter
// ---------------------------------------------------------------------------

const offerLetterSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, required: true },
    employeeName: { type: String, default: null, trim: true, maxlength: 200 },

    /** Annual cost to company. Decimal128 (AD-2) — the reference uses a float. */
    ctc: { type: Schema.Types.Decimal128, required: true },
    joiningDate: { ...isoDay, required: true },
    designation: { type: String, required: true, trim: true, maxlength: 120 },

    /**
     * The generated letter's storage key.
     *
     * Written to the `offer-letter` storage category and read only through
     * `issueReadUrl`, which authorises and audits. The reference writes a PDF to
     * the instance's local disk and then reads it back with
     * `path.resolve(uploadsRoot, pdfKey)` — a resolve that an absolute key would
     * escape entirely.
     */
    documentKey: { type: String, default: null },

    sentAt: { type: Date, default: null },
    sentByUserId: { type: Schema.Types.ObjectId, default: null },

    acceptedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null, trim: true, maxlength: 500 },

    /**
     * Proof of acceptance.
     *
     * 🔴 The reference stores a base64 PNG of a drawn signature — up to 500 KB —
     * inside this row, so every read of every offer drags the image along and it
     * lands in database backups. A typed legal name plus the timestamp, address
     * and user agent is the evidence that actually carries weight, and it is
     * what Hiring's offer acceptance records too.
     */
    signature: {
      type: new Schema(
        {
          name: { type: String, required: true, trim: true, maxlength: 120 },
          ipAddress: { type: String, default: null, maxlength: 64 },
          userAgent: { type: String, default: null, maxlength: 300 },
          signedAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: null,
    },

    createdByUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'hrms_offer_letters' },
);

offerLetterSchema.index({ createdAt: -1 });
offerLetterSchema.index({ employeeId: 1, createdAt: -1 });
/** Resolving a stored document back to its offer, for the file-access rule. */
offerLetterSchema.index({ documentKey: 1 }, { sparse: true });

// ---------------------------------------------------------------------------

export const OnboardingTemplate =
  mongoose.models.OnboardingTemplate ||
  mongoose.model('OnboardingTemplate', onboardingTemplateSchema);

export const OnboardingChecklist =
  mongoose.models.OnboardingChecklist ||
  mongoose.model('OnboardingChecklist', onboardingChecklistSchema);

export const OfferLetter =
  mongoose.models.OfferLetter || mongoose.model('OfferLetter', offerLetterSchema);

export default { OnboardingTemplate, OnboardingChecklist, OfferLetter };
