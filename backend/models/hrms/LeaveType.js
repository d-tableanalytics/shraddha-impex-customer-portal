/**
 * Leave type — the catalogue of what someone can take (CL, SL, EL, ...).
 *
 * Ported from the reference's `LeaveType`. `organizationId` is gone (AD-1), so
 * its `@@unique([organizationId, code])` becomes a unique index on `code`,
 * partial over live rows exactly as Department and Location are: retiring a
 * type and later re-creating its code is ordinary housekeeping.
 *
 * `adminOnly` replaces a hardcoded rule. The reference's service filters the
 * catalogue in code - `CL` for everyone, `AL` only for an admin or for an
 * employee whose free-text DESIGNATION reads "EA" - which puts a customer's
 * policy inside a service and matches on a job title. Here it is a property of
 * the type, which is where a policy belongs.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

const leaveTypeSchema = new Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 20,
      match: [/^[A-Z0-9_-]+$/, 'Use uppercase letters, numbers, hyphen or underscore only.'],
    },
    name: { type: String, required: true, trim: true, maxlength: 80 },

    /** Unpaid leave still records days; payroll reads this to compute loss of pay. */
    paid: { type: Boolean, default: true },
    allowsHalfDay: { type: Boolean, default: true },
    requiresProof: { type: Boolean, default: false },

    /** Offered only to someone who can administer leave (`leave:edit:org`). */
    adminOnly: { type: Boolean, default: false },

    color: { type: String, default: '#1E5FB8', match: [/^#[0-9a-fA-F]{6}$/, 'Expected #rrggbb'] },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'hrms_leave_types' },
);

leaveTypeSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
leaveTypeSchema.index({ deletedAt: 1, code: 1 });

export const LeaveType = mongoose.models.LeaveType || mongoose.model('LeaveType', leaveTypeSchema);
export default LeaveType;
