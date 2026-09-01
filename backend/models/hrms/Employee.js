/**
 * Employee — the HRMS master record.
 *
 * Ported from the DTA reference's Prisma `Employee` model, adapted to Mongoose
 * and to the accepted decisions:
 *
 *   AD-1   single tenant, so no organizationId anywhere
 *   AD-2   Mongoose; ObjectId keys; no foreign-key constraints, so referential
 *          integrity is enforced in the service
 *   AD-10  PAN, bank details and government identifiers are encrypted at rest
 *          and MASKED in every default serialization
 *   AD-11  employeeCode is the stable natural key, so an import can re-run
 *          idempotently
 *   AD-13  server-side pagination, so the indexes below matter
 *
 * ---------------------------------------------------------------------------
 * The reference has NO dedicated sensitive fields
 * ---------------------------------------------------------------------------
 * It keeps bank account numbers and IFSC codes inside `customFieldValues`, an
 * unencrypted blob its own `GET /employees/:id` returns whole. The dedicated
 * encrypted paths below are what AD-10 replaces that with, and the sanitiser
 * strips those keys out of the blob before any write.
 */

import mongoose from 'mongoose';

import { sensitiveFields } from './plugins/sensitiveFields.js';
import {
  EMPLOYMENT_TYPES,
  EMPLOYEE_STATUSES,
} from '../../shared/constants/hrms.js';

const { Schema } = mongoose;

/** Free-text contact block. The reference caps this at two (§ its own comment). */
export const MAX_EMERGENCY_CONTACTS = 2;

const emergencyContactSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    relationship: { type: String, required: true, trim: true, maxlength: 50 },
    // Exactly ten digits, matching the reference's rule on both sides.
    phone: { type: String, required: true, match: /^\d{10}$/ },
    email: { type: String, default: null, lowercase: true, trim: true },
  },
  { _id: false },
);

const dependentSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    relationship: { type: String, required: true, trim: true, maxlength: 50 },
    dateOfBirth: { type: Date, default: null },
    isNominee: { type: Boolean, default: false },
  },
  { _id: false },
);

const employeeSchema = new Schema(
  {
    // ---- identity -------------------------------------------------------
    /**
     * The stable natural key (AD-11). Unique and indexed: imports upsert on it,
     * and every future module references an employee by it rather than by an
     * ObjectId an external system cannot know.
     */
    employeeCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 30,
      index: true,
    },

    /** The login this employee signs in with. One user, one employee. */
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },

    firstName: { type: String, required: true, trim: true, maxlength: 80 },
    lastName: { type: String, required: true, trim: true, maxlength: 80 },

    // ---- contact --------------------------------------------------------
    personalEmail: { type: String, default: null, lowercase: true, trim: true },
    /** "Phone 1 (Personal)" in the form. Kept as `phone` for wire compatibility. */
    phone: { type: String, default: null, trim: true, maxlength: 20 },
    phone2: { type: String, default: null, trim: true, maxlength: 20 },

    // ---- dates ----------------------------------------------------------
    dateOfBirth: { type: Date, default: null },
    dateOfJoining: { type: Date, required: true },

    // ---- job ------------------------------------------------------------
    employmentType: {
      type: String,
      enum: EMPLOYMENT_TYPES,
      default: 'full_time',
      required: true,
    },
    /**
     * FREE TEXT, not a reference.
     *
     * The reference schema does define a Designation lookup table, but its
     * employee form renders designation as a plain <Input> and the column is a
     * nullable string. Modelling it as a reference here would be a deviation
     * dressed up as an improvement, and would make Employee depend on a module
     * that does not exist.
     */
    designation: { type: String, default: null, trim: true, maxlength: 120 },

    status: {
      type: String,
      enum: EMPLOYEE_STATUSES,
      default: 'invited',
      required: true,
      index: true,
    },

    /**
     * Optional references to Org Structure.
     *
     * AD-2 removed foreign keys, so a dangling id would not be caught by the
     * database. The service validates them through the reference provider, and
     * REFUSES the write when a value is supplied while Org Structure is not
     * built — rather than storing an id nothing can resolve.
     */
    departmentId: { type: Schema.Types.ObjectId, default: null, index: true },
    locationId: { type: Schema.Types.ObjectId, default: null },

    reportingManagerId: {
      type: Schema.Types.ObjectId,
      ref: 'Employee',
      default: null,
      index: true,
    },

    /**
     * Denormalised ancestry: [directManager, skipLevel, …], nearest first.
     *
     * DERIVED from reportingManagerId — never accepted from a caller and never
     * imported (AD-11). Every `team`-scope permission check reads it, so a
     * stale chain is a silent authorization bug: a manager quietly stops being
     * able to see or approve for their own reports.
     */
    managerChain: {
      type: [Schema.Types.ObjectId],
      default: [],
      index: true,
    },

    // ---- probation ------------------------------------------------------
    // probationStartDate defaults to dateOfJoining and probationEndDate to
    // start + probationMonths; all three then move independently.
    probationMonths: { type: Number, default: null, min: 1, max: 24 },
    probationStartDate: { type: Date, default: null },
    probationEndDate: { type: Date, default: null },
    confirmedAt: { type: Date, default: null },

    // ---- notice period --------------------------------------------------
    // Populated when status becomes 'notice'. Nullable, because most employees
    // never go through one.
    noticeStartDate: { type: Date, default: null },
    noticeMonths: { type: Number, default: null, min: 1, max: 12 },
    noticeEndDate: { type: Date, default: null },

    // ---- family and address --------------------------------------------
    fatherName: { type: String, default: null, trim: true, maxlength: 120 },
    motherName: { type: String, default: null, trim: true, maxlength: 120 },
    permanentAddress: { type: String, default: null, maxlength: 1000 },
    temporaryAddress: { type: String, default: null, maxlength: 1000 },

    emergencyContacts: {
      type: [emergencyContactSchema],
      default: [],
      validate: {
        validator: (v) => (v ?? []).length <= MAX_EMERGENCY_CONTACTS,
        message: `At most ${MAX_EMERGENCY_CONTACTS} emergency contacts.`,
      },
    },
    dependents: { type: [dependentSchema], default: [] },

    /**
     * Admin-defined extra fields, keyed by EmployeeCustomField.name.
     *
     * Mixed, so schema-less — which is exactly why the sanitiser runs before
     * every write. A reserved key here would reopen the hole AD-10 closes.
     */
    customFieldValues: { type: Schema.Types.Mixed, default: () => ({}) },

    // ---- lifecycle ------------------------------------------------------
    /**
     * Soft delete. The reference deletes softly on purpose: a hard delete would
     * strand attendance, leave and payroll rows that reference this employee,
     * and AD-2 has no cascade to catch it.
     */
    deletedAt: { type: Date, default: null, index: true },

    createdById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

/**
 * AD-10. Adds `<field>Enc` (the ciphertext envelope) and, where uniqueness must
 * hold, `<field>Idx` (the blind index) — both `select: false` — and makes
 * toJSON emit presence rather than any value.
 */
employeeSchema.plugin(sensitiveFields);

// ---------------------------------------------------------------------------
// Indexes (AD-13: every list is server-paginated and filtered)
// ---------------------------------------------------------------------------

// The directory's default ordering, matching the reference: status then name.
employeeSchema.index({ deletedAt: 1, status: 1, firstName: 1 });
// The three filters the list screen offers.
employeeSchema.index({ deletedAt: 1, departmentId: 1 });
employeeSchema.index({ deletedAt: 1, locationId: 1 });
employeeSchema.index({ deletedAt: 1, reportingManagerId: 1 });
// Team-scope reads: "is the actor anywhere in this employee's chain".
employeeSchema.index({ deletedAt: 1, managerChain: 1 });
// Free-text search across the fields the reference searches.
employeeSchema.index(
  { firstName: 'text', lastName: 'text', employeeCode: 'text' },
  { name: 'employee_search' },
);

// ---------------------------------------------------------------------------
// Virtuals and helpers
// ---------------------------------------------------------------------------

employeeSchema.virtual('displayName').get(function displayName() {
  return `${this.firstName ?? ''} ${this.lastName ?? ''}`.trim();
});

employeeSchema.set('toJSON', {
  ...(employeeSchema.get('toJSON') ?? {}),
  virtuals: true,
});

/** Only non-deleted rows. Every read path starts here. */
employeeSchema.statics.alive = function alive(filter = {}) {
  return this.find({ ...filter, deletedAt: null });
};

export default mongoose.models.Employee || mongoose.model('Employee', employeeSchema);
