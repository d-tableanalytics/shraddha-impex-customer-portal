/**
 * Performance collections.
 *
 * Ported from the reference's Prisma models, adapted to Mongoose and the
 * accepted decisions:
 *
 *   AD-1   single tenant, so no organizationId
 *   AD-2   ObjectId keys, no foreign keys — the services check references,
 *          and measures are Decimal128
 *   AD-4   the Employee is the canonical identity, not the User account
 *   AD-13  every list is server-paginated, so the indexes below matter
 *
 * Grouped in one file because these five collections are one module: a review
 * response is meaningless without its cycle, and a goal's cascade is a
 * self-relation within the same collection.
 *
 * ---------------------------------------------------------------------------
 * Participants are EMPLOYEES, not user accounts
 * ---------------------------------------------------------------------------
 * The reference keys `reviewerUserId`, `fromUserId`/`toUserId` and
 * `managerUserId`/`reportUserId` on the User table, then joins to `displayName`
 * on every read. Every scope check in this codebase is employee-based, the
 * manager chain lives on Employee, and Hiring's interview panel and
 * Onboarding's task assignees already made the same choice — so these are
 * employee ids, with the display name denormalised at write time.
 */

import mongoose from 'mongoose';

import {
  GOAL_STATUSES,
  REVIEW_PHASES,
  REVIEW_KINDS,
  FEEDBACK_KINDS,
  FEEDBACK_VISIBILITIES,
  ONE_ON_ONE_STATUSES,
  GOAL_WEIGHT_MIN,
  GOAL_WEIGHT_MAX,
  RATING_MIN,
  RATING_MAX,
  ONE_ON_ONE_MIN_MINUTES,
  ONE_ON_ONE_MAX_MINUTES,
} from '../../shared/constants/performance.js';

const { Schema } = mongoose;

const isoDay = { type: String, match: [/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date'] };

/** A measured quantity. Always Decimal128; never `Number` (AD-2). */
const measure = (extra = {}) => ({ type: Schema.Types.Decimal128, default: null, ...extra });

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

const goalSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, required: true },
    /** Denormalised at write time so a list needs no join. */
    employeeName: { type: String, default: null, trim: true, maxlength: 200 },

    /** OKR cascade — a self-reference within this collection. */
    parentGoalId: { type: Schema.Types.ObjectId, default: null },
    cycleId: { type: Schema.Types.ObjectId, default: null },

    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: null, trim: true, maxlength: 4000 },

    /**
     * The measure. `Decimal(14,2)` in the reference, so Decimal128 here.
     *
     * `progressPercent` is DERIVED on read — `current / target` — and is never
     * stored, because a stored percentage is a second source of truth that can
     * disagree with the two numbers beside it.
     */
    targetValue: measure(),
    currentValue: measure({ default: () => mongoose.Types.Decimal128.fromString('0') }),
    unit: { type: String, default: null, trim: true, maxlength: 40 },

    /**
     * Stored and displayed; drives no calculation.
     *
     * The reference collects a weight on every goal and every competency and
     * never computes a weighted anything. Kept for parity and documented as
     * inert rather than quietly given a meaning the reference does not have.
     */
    weight: {
      type: Number,
      required: true,
      default: 1,
      min: GOAL_WEIGHT_MIN,
      max: GOAL_WEIGHT_MAX,
    },

    status: { type: String, required: true, enum: GOAL_STATUSES, default: 'open' },
    dueDate: { ...isoDay, default: null },

    /**
     * Soft delete.
     *
     * 🔴 The reference hard-deletes a goal, and the cascade self-relation has
     * no `onDelete` — so deleting a parent leaves its children pointing at a
     * row that is gone. Here a goal with children cannot be removed at all, and
     * one without is retired.
     */
    deletedAt: { type: Date, default: null },

    createdByUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'hrms_goals' },
);

/** The list is ordered by status then most recent, as the reference orders it. */
goalSchema.index({ employeeId: 1, status: 1 });
goalSchema.index({ cycleId: 1 });
goalSchema.index({ parentGoalId: 1 });
goalSchema.index({ status: 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// ReviewCycle
// ---------------------------------------------------------------------------

const competencySchema = new Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 60 },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    weight: { type: Number, required: true, default: 1, min: 1, max: 10 },
  },
  { _id: false },
);

const reviewCycleSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    startDate: { ...isoDay, required: true },
    endDate: { ...isoDay, required: true },

    phase: { type: String, required: true, enum: REVIEW_PHASES, default: 'goal_setting' },

    /**
     * The competency template.
     *
     * The reference stores this as a free-form `Json` column shaped
     * `{ competencies: [...] }`. A typed subdocument array gets the same data
     * with the shape enforced — `ratings` is keyed on `competency.key`, so a
     * malformed key is a rating that can never be read back.
     */
    competencies: {
      type: [competencySchema],
      default: undefined,
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0 && v.length <= 20,
        message: 'A cycle needs between 1 and 20 competencies.',
      },
    },

    phaseHistory: {
      type: [
        new Schema(
          {
            phase: { type: String, required: true, enum: REVIEW_PHASES },
            at: { type: Date, required: true, default: Date.now },
            byUserId: { type: Schema.Types.ObjectId, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    createdByUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'hrms_review_cycles' },
);

reviewCycleSchema.index({ startDate: -1 });
reviewCycleSchema.index({ phase: 1, startDate: -1 });
/** Two cycles cannot share a name — the picker would be unusable. */
reviewCycleSchema.index({ name: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// ReviewResponse
// ---------------------------------------------------------------------------

const reviewResponseSchema = new Schema(
  {
    cycleId: { type: Schema.Types.ObjectId, required: true },
    cycleName: { type: String, default: null, trim: true, maxlength: 160 },

    /** The subject of the review. */
    employeeId: { type: Schema.Types.ObjectId, required: true },
    employeeName: { type: String, default: null, trim: true, maxlength: 200 },

    /** Who writes it. An employee, not a user account — see the header. */
    reviewerEmployeeId: { type: Schema.Types.ObjectId, required: true },
    reviewerName: { type: String, default: null, trim: true, maxlength: 200 },

    kind: { type: String, required: true, enum: REVIEW_KINDS },

    /**
     * `{ competencyKey: 1..5 }`.
     *
     * A Map rather than a loose object so Mongoose validates the values, and so
     * a key containing a dot cannot corrupt the document.
     */
    ratings: {
      type: Map,
      of: { type: Number, min: RATING_MIN, max: RATING_MAX },
      default: () => new Map(),
    },

    overallRating: { type: Number, default: null, min: RATING_MIN, max: RATING_MAX },
    comments: { type: String, default: null, trim: true, maxlength: 4000 },

    submittedAt: { type: Date, default: null },

    createdByUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'hrms_review_responses' },
);

/**
 * ONE ROW PER (cycle × employee × reviewer × kind), enforced by the database.
 *
 * The reference declares the same unique constraint and ALSO pre-checks with a
 * `findFirst` — the pre-check is kept here only to produce a better message
 * than a duplicate-key error.
 */
reviewResponseSchema.index(
  { cycleId: 1, employeeId: 1, reviewerEmployeeId: 1, kind: 1 },
  { unique: true },
);

/** "Reviews assigned to me" — the queue the Reviews tab is built on. */
reviewResponseSchema.index({ reviewerEmployeeId: 1, submittedAt: 1 });
/** "Reviews written about me" — the endpoint the reference never exposes. */
reviewResponseSchema.index({ employeeId: 1, submittedAt: 1 });
reviewResponseSchema.index({ cycleId: 1, employeeId: 1 });

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

const feedbackSchema = new Schema(
  {
    /**
     * The sender is ALWAYS recorded, even for anonymous feedback.
     *
     * The reference does the same and gives the reason — moderation — then
     * scrubs it from the DTO for anyone but the sender. The scrubbing happens
     * in the service; nothing in this collection is anonymous at rest.
     */
    fromEmployeeId: { type: Schema.Types.ObjectId, required: true },
    fromName: { type: String, default: null, trim: true, maxlength: 200 },

    toEmployeeId: { type: Schema.Types.ObjectId, required: true },
    toName: { type: String, default: null, trim: true, maxlength: 200 },

    kind: { type: String, required: true, enum: FEEDBACK_KINDS },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    visibility: {
      type: String,
      required: true,
      enum: FEEDBACK_VISIBILITIES,
      default: 'visible',
    },
    tags: {
      type: [{ type: String, trim: true, maxlength: 40 }],
      default: [],
      validate: { validator: (v) => v.length <= 10, message: 'At most 10 tags.' },
    },

    createdByUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'hrms_feedback' },
);

feedbackSchema.index({ toEmployeeId: 1, createdAt: -1 });
feedbackSchema.index({ fromEmployeeId: 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// OneOnOne
// ---------------------------------------------------------------------------

const itemSchema = new Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: 500 },
    done: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const oneOnOneSchema = new Schema(
  {
    managerEmployeeId: { type: Schema.Types.ObjectId, required: true },
    managerName: { type: String, default: null, trim: true, maxlength: 200 },

    reportEmployeeId: { type: Schema.Types.ObjectId, required: true },
    reportName: { type: String, default: null, trim: true, maxlength: 200 },

    scheduledAt: { type: Date, required: true },
    durationMinutes: {
      type: Number,
      required: true,
      default: 30,
      min: ONE_ON_ONE_MIN_MINUTES,
      max: ONE_ON_ONE_MAX_MINUTES,
    },

    /** The shared notepad. Either participant may edit all three. */
    agenda: { type: [itemSchema], default: [] },
    notes: { type: [itemSchema], default: [] },
    actionItems: { type: [itemSchema], default: [] },

    status: { type: String, required: true, enum: ONE_ON_ONE_STATUSES, default: 'scheduled' },

    createdByUserId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'hrms_one_on_ones' },
);

/** "My 1:1s" is an OR across both participants; one index per side serves it. */
oneOnOneSchema.index({ managerEmployeeId: 1, scheduledAt: -1 });
oneOnOneSchema.index({ reportEmployeeId: 1, scheduledAt: -1 });

// ---------------------------------------------------------------------------

export const Goal = mongoose.models.Goal || mongoose.model('Goal', goalSchema);

export const ReviewCycle =
  mongoose.models.ReviewCycle || mongoose.model('ReviewCycle', reviewCycleSchema);

export const ReviewResponse =
  mongoose.models.ReviewResponse || mongoose.model('ReviewResponse', reviewResponseSchema);

export const Feedback = mongoose.models.Feedback || mongoose.model('Feedback', feedbackSchema);

export const OneOnOne = mongoose.models.OneOnOne || mongoose.model('OneOnOne', oneOnOneSchema);

export default { Goal, ReviewCycle, ReviewResponse, Feedback, OneOnOne };
