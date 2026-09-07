/**
 * Leave request, and its approval chain.
 *
 * Ported from the reference's `LeaveRequest`. Statuses are exactly the four it
 * uses - there is no draft and no withdrawn state, and none is invented.
 *
 * Dates are `YYYY-MM-DD` strings rather than Dates, for the same reason as
 * Holiday: leave is a calendar concept, and storing an instant is how the 1st
 * becomes the 30th for a server in a negative offset.
 *
 * `durationValue` is always IN DAYS. The reference writes raw hours into this
 * field for an hourly request and then subtracts it from a days-denominated
 * balance, so two hours off costs two days of entitlement; the service converts
 * hours to a day fraction before it reaches here.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

export const LEAVE_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'cancelled']);
export const LEAVE_DURATION_UNITS = Object.freeze(['full_day', 'half_day', 'hour', 'mixed']);

const isoDay = {
  type: String,
  required: true,
  match: [/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date'],
};

/**
 * One approval step. The reference stores the approver's NAME alongside the id
 * so a decided request still reads correctly after the approver leaves; that is
 * kept, as a snapshot rather than a live join.
 */
const approvalStepSchema = new Schema(
  {
    level: { type: Number, required: true, min: 1 },
    approverEmployeeId: { type: Schema.Types.ObjectId, required: true },
    approverName: { type: String, default: '' },
    decision: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    decidedAt: { type: Date, default: null },
    comment: { type: String, default: null, maxlength: 500 },
  },
  { _id: false },
);

const leaveRequestSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, required: true, index: true },
    leaveTypeId: { type: Schema.Types.ObjectId, required: true },

    startDate: isoDay,
    endDate: isoDay,

    durationUnit: { type: String, enum: LEAVE_DURATION_UNITS, default: 'full_day' },
    /** Always in days, computed server-side. Never accepted from a client. */
    durationValue: { type: Number, required: true, min: 0 },

    /** One period for the whole request (the single-day case). */
    halfDayPeriod: { type: String, enum: ['first', 'second', null], default: null },
    /** Per-day periods, once a half-day request spans more than one day. */
    halfDaySlots: {
      type: [{ _id: false, date: String, period: String }],
      default: undefined,
    },
    /** Per-day full/half breakdown, for `mixed`. */
    dayBreakdown: {
      type: [{ _id: false, date: String, kind: String }],
      default: undefined,
    },

    hourFrom: { type: String, default: null },
    hourTo: { type: String, default: null },

    reason: { type: String, required: true, trim: true, maxlength: 500 },
    status: { type: String, enum: LEAVE_STATUSES, default: 'pending', index: true },

    approvalChain: { type: [approvalStepSchema], default: [] },
  },
  { timestamps: true, collection: 'hrms_leave_requests' },
);

/** The three reads this collection serves: my leave, an approver's queue, the calendar. */
leaveRequestSchema.index({ employeeId: 1, status: 1, startDate: -1 });
leaveRequestSchema.index({ status: 1, startDate: 1 });
leaveRequestSchema.index({ startDate: 1, endDate: 1 });

export const LeaveRequest =
  mongoose.models.LeaveRequest || mongoose.model('LeaveRequest', leaveRequestSchema);
export default LeaveRequest;
