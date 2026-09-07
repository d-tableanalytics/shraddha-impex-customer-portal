/**
 * AttendanceCorrection — an employee's request to fix a day's punches.
 *
 * Ported field for field from the reference's Prisma `AttendanceCorrection`.
 * Nothing is invented: `date`, `requestedClockIn`, `requestedClockOut`,
 * `reason`, `status`, `decidedById`, `decidedAt`, `comment` are its columns.
 *
 * ---------------------------------------------------------------------------
 * ONE PENDING REQUEST PER EMPLOYEE PER DAY, enforced by an index
 * ---------------------------------------------------------------------------
 * The reference tries to prevent duplicates in the BROWSER: `AttendancePage`
 * builds a `pendingByDate` map and swaps the "Add correction" link for a
 * "Correction pending" chip. Its API has no such rule, so a second POST — from
 * a stale tab, a double submit, or curl — creates a second pending row, and an
 * approver then sees two requests for the same day with no way to tell which
 * one is current.
 *
 * A partial unique index makes it a database guarantee instead. Partial so it
 * constrains only `pending` rows: a rejected request must not block a corrected
 * resubmission, and a long history of approved corrections for the same date is
 * perfectly normal.
 */

import mongoose from 'mongoose';

import { CORRECTION_STATUSES } from '../../shared/constants/attendance.js';

const { Schema } = mongoose;

const attendanceCorrectionSchema = new Schema(
  {
    /**
     * Whose attendance this corrects.
     *
     * Derived from the authenticated actor on submit, never accepted from the
     * request body — the reference does the same, and it is the difference
     * between a correction workflow and a way to forge someone else's hours.
     */
    employeeId: {
      type: Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
      index: true,
    },

    /** Midnight UTC of the attendance day, matching AttendanceRecord.date. */
    date: { type: Date, required: true },

    requestedClockIn: { type: Date, default: null },
    requestedClockOut: { type: Date, default: null },

    reason: { type: String, required: true, trim: true, minlength: 10, maxlength: 500 },

    status: {
      type: String,
      enum: CORRECTION_STATUSES,
      required: true,
      default: 'pending',
      index: true,
    },

    /** The USER who decided, as in the reference (`decidedById` -> user id). */
    decidedById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /**
     * The approver's EMPLOYEE id.
     *
     * The reference stores only the user id, so answering "which manager
     * approved this" later needs a join through User to Employee — and fails
     * for an approver whose employee record has since been soft-deleted.
     */
    decidedByEmployeeId: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    decidedAt: { type: Date, default: null },
    comment: { type: String, default: null, maxlength: 500 },

    createdById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** The approver's queue, and the employee's own list: pending first, newest first. */
attendanceCorrectionSchema.index({ employeeId: 1, status: 1, createdAt: -1 });

/** The company-wide approvals queue. */
attendanceCorrectionSchema.index({ status: 1, createdAt: -1 });

/** See the header note — one open request per employee per day. */
attendanceCorrectionSchema.index(
  { employeeId: 1, date: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'pending' },
    name: 'one_pending_correction_per_day',
  },
);

attendanceCorrectionSchema.set('toJSON', { virtuals: true });

export default mongoose.models.AttendanceCorrection ||
  mongoose.model('AttendanceCorrection', attendanceCorrectionSchema);
