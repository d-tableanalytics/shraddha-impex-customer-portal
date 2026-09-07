/**
 * Leave balance — one bucket per employee, per type, per year.
 *
 * Ported from the reference's `LeaveBalance`. `balance` is materialised
 * (`accrued - used - pending`) exactly as the reference does, so a balance
 * screen is one indexed read rather than an aggregation over every request.
 *
 * Days are stored as Numbers, not Decimal128. AD-2 reserves Decimal128 for
 * MONEY, where a fraction of a cent compounds; leave moves in halves and
 * quarter-days, which are exact in binary floating point. Every write still
 * goes through `round2` so a long run of additions cannot drift.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

/** Two decimals: halves and hour-fractions are the only values that occur. */
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const days = { type: Number, default: 0, min: 0, set: round2 };

const leaveBalanceSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, required: true, index: true },
    leaveTypeId: { type: Schema.Types.ObjectId, required: true },
    year: { type: Number, required: true, min: 2000, max: 2100 },

    /** Entitlement granted so far this year. */
    accrued: days,
    /** Spent on approved requests. */
    used: days,
    /** Committed to requests still awaiting a decision. */
    pending: days,

    /**
     * `accrued - used - pending`, kept for fast reads.
     *
     * Allowed to go negative: the reference does not refuse a request for
     * insufficient balance, and a bucket can legitimately be overdrawn when HR
     * approves beyond entitlement. Clamping it at zero here would hide that.
     */
    balance: { type: Number, default: 0, set: round2 },
  },
  { timestamps: true, collection: 'hrms_leave_balances' },
);

/** One bucket per employee/type/year — the reference's compound key. */
leaveBalanceSchema.index({ employeeId: 1, leaveTypeId: 1, year: 1 }, { unique: true });

/** `balance` is derived, so it is never set by hand. */
leaveBalanceSchema.pre('validate', function recompute(next) {
  this.balance = round2(Number(this.accrued) - Number(this.used) - Number(this.pending));
  next();
});

export const LeaveBalance =
  mongoose.models.LeaveBalance || mongoose.model('LeaveBalance', leaveBalanceSchema);
export default LeaveBalance;
