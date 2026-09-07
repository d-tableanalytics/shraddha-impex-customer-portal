/**
 * Exit request, its clearances, and its full-and-final settlement.
 *
 * Ported from the reference's `ExitRequest` + `ExitClearance` + `FullAndFinal` +
 * `RelievingLetter` â€” four tables that all cascade-delete from the request and
 * are always read together with it.
 *
 * ---------------------------------------------------------------------------
 * Clearances, F&F and the letter are EMBEDDED
 * ---------------------------------------------------------------------------
 * None has a life of its own. A clearance is created with the request, read
 * with it, and deleted with it; F&F and the relieving letter are one-to-one
 * (`@unique exit_request_id` in the reference's own schema). In Postgres that
 * costs four tables and four joins; in MongoDB it is one document and one read.
 * The clearance count is fixed at five.
 *
 * ---------------------------------------------------------------------------
 * Money is Decimal128
 * ---------------------------------------------------------------------------
 * AD-2 forbids floats for money. The reference declares `Decimal(14,2)` columns
 * and then computes every figure in JavaScript numbers â€” so the precision the
 * column promises is already gone by the time it is stored.
 *
 * ---------------------------------------------------------------------------
 * `ExitInterview` is not modelled
 * ---------------------------------------------------------------------------
 * The reference has the table, the DTO, the seed cleanup and the query include,
 * but no service and no endpoint that can ever create one. There is no
 * behaviour to port, so there is no model here.
 */

import mongoose from 'mongoose';

import {
  EXIT_STATUSES,
  EXIT_REASON_CATEGORIES,
  CLEARANCE_AREAS,
  CLEARANCE_STATUSES,
  TERMINAL_EXIT_STATUSES,
} from '../../shared/schemas/exit.js';

const { Schema } = mongoose;

/** Exact decimal addition over the string form, so no float is ever involved. */
export function sumMoney(values = []) {
  const paise = values.reduce((total, value) => {
    const text = String(value ?? '0');
    const negative = text.startsWith('-');
    const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
    const magnitude = BigInt(whole || '0') * 100n + BigInt(`${fraction}00`.slice(0, 2));
    return total + (negative ? -magnitude : magnitude);
  }, 0n);

  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/**
 * One area's sign-off.
 *
 * The assignee is an EMPLOYEE, not a user. The reference assigns to a userId,
 * which is why its clearance queue has to compare `assigneeUserId === me.user.id`
 * in the browser; every other HRMS module here scopes on employeeId, and keeping
 * that consistent is what lets the queue be filtered by the server.
 */
const clearanceSchema = new Schema(
  {
    area: { type: String, enum: CLEARANCE_AREAS, required: true },
    assigneeEmployeeId: { type: Schema.Types.ObjectId, default: null },
    /** Snapshotted so a completed clearance still reads correctly later. */
    assigneeName: { type: String, default: '' },
    status: { type: String, enum: CLEARANCE_STATUSES, default: 'pending' },
    completedAt: { type: Date, default: null },
    completedByEmployeeId: { type: Schema.Types.ObjectId, default: null },
    notes: { type: String, default: null, maxlength: 2000 },
  },
  { _id: true, timestamps: false },
);

/** One earning or deduction line in the settlement. */
const fnfLineSchema = new Schema(
  {
    code: { type: String, required: true },
    label: { type: String, required: true },
    amount: { type: Schema.Types.Decimal128, required: true },
  },
  { _id: false },
);

const fullAndFinalSchema = new Schema(
  {
    gross: { type: Schema.Types.Decimal128, required: true },
    deductions: { type: Schema.Types.Decimal128, required: true },
    netPayable: { type: Schema.Types.Decimal128, required: true },
    earnings: { type: [fnfLineSchema], default: [] },
    deductionLines: { type: [fnfLineSchema], default: [] },
    leaveEncashment: { type: Schema.Types.Decimal128, default: null },
    gratuity: { type: Schema.Types.Decimal128, default: null },
    noticeAdjustment: { type: Schema.Types.Decimal128, default: null },
    computedAt: { type: Date, default: Date.now },
    disbursedAt: { type: Date, default: null },
    /** Set when the settlement is paid through a payroll run. */
    payrollRunId: { type: Schema.Types.ObjectId, default: null },
  },
  { _id: false },
);

const relievingLetterSchema = new Schema(
  {
    /**
     * Storage key, minted by the storage layer. Never client-supplied, and
     * never sent to a browser â€” the letter is read through a presigned URL so
     * the object has no publicly addressable form.
     */
    storageKey: { type: String, default: null },
    generatedAt: { type: Date, default: null },
  },
  { _id: false },
);

const exitRequestSchema = new Schema(
  {
    // Not `index: true` â€” the partial-unique and compound indexes below both
    // lead on employeeId, and declaring it here as well makes Mongoose build a
    // third, redundant one.
    employeeId: { type: Schema.Types.ObjectId, required: true },
    /** Snapshot: the request must still read correctly after the record ages. */
    employeeName: { type: String, required: true },

    initiatedByEmployeeId: { type: Schema.Types.ObjectId, default: null },
    initiatedAt: { type: Date, default: Date.now },

    reason: { type: String, required: true, trim: true, maxlength: 2000 },
    reasonCategory: {
      type: String,
      enum: EXIT_REASON_CATEGORIES,
      default: 'resignation',
    },

    /** `YYYY-MM-DD`. A last working day is a calendar day, not an instant. */
    requestedLastDay: {
      type: String,
      required: true,
      match: [/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date'],
    },
    actualLastDay: {
      type: String,
      default: null,
      match: [/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date'],
    },

    status: { type: String, enum: EXIT_STATUSES, default: 'initiated', index: true },

    managerApprovedAt: { type: Date, default: null },
    managerApprovedByEmployeeId: { type: Schema.Types.ObjectId, default: null },
    hrApprovedAt: { type: Date, default: null },
    hrApprovedByEmployeeId: { type: Schema.Types.ObjectId, default: null },
    closedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },

    /**
     * Handover. The reference's own two fields â€” who takes the work over, and
     * the notes that go with it. AD-5 excludes Projects, so this pair is the
     * whole of handover here, exactly as the reference models it on the request
     * itself; its project fan-out is a notification, not a handover record.
     */
    replacementEmployeeId: { type: Schema.Types.ObjectId, default: null },
    transferNotes: { type: String, default: null, maxlength: 4000 },

    /**
     * The employee id while this exit is LIVE, and null once it is not.
     *
     * Derived â€” never accepted from a caller. It exists so "one live exit per
     * employee" can be a unique index: a partial index cannot express
     * `status $nin [closed, cancelled]` (MongoDB supports only $eq, $exists,
     * the range operators and $type in a partial filter), but it can index the
     * rows where this field is an ObjectId. Maintained by the hook below.
     */
    activeEmployeeId: { type: Schema.Types.ObjectId, default: null },

    clearances: { type: [clearanceSchema], default: [] },
    fullAndFinal: { type: fullAndFinalSchema, default: null },
    relievingLetter: { type: relievingLetterSchema, default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'hrms_exit_requests' },
);

/** `activeEmployeeId` is a projection of status, recomputed rather than trusted. */
exitRequestSchema.pre('validate', function syncActiveKey(next) {
  const live = !TERMINAL_EXIT_STATUSES.includes(this.status) && !this.deletedAt;
  this.activeEmployeeId = live ? this.employeeId : null;
  next();
});

/**
 * At most one live exit per employee.
 *
 * The reference checks this in application code inside a transaction. That
 * check stays (it produces the good error message), but the index is what makes
 * it true under concurrency: two simultaneous initiate calls both pass the read
 * and one then fails on the write, rather than both succeeding.
 *
 * `$type` rather than `{ $ne: null }` for the same reason `sparse` is wrong
 * here: a partial filter must be one of the supported operators, and an
 * explicitly-null field is present, so a sparse index would still cover every
 * terminal row and collapse them all onto one key.
 */
exitRequestSchema.index(
  { activeEmployeeId: 1 },
  {
    unique: true,
    partialFilterExpression: { activeEmployeeId: { $type: 'objectId' } },
  },
);

/** The three reads: my exit, HR's queue, and an assignee's clearance queue. */
exitRequestSchema.index({ employeeId: 1, initiatedAt: -1 });
exitRequestSchema.index({ status: 1, initiatedAt: -1 });
exitRequestSchema.index({ deletedAt: 1, createdAt: -1 });
exitRequestSchema.index({ 'clearances.assigneeEmployeeId': 1, 'clearances.status': 1 });

export const ExitRequest =
  mongoose.models.ExitRequest || mongoose.model('ExitRequest', exitRequestSchema);
export default ExitRequest;
