/**
 * The company HRMS operates for (AD-1: single tenant).
 *
 * ---------------------------------------------------------------------------
 * This is what replaces DTA's Organization
 * ---------------------------------------------------------------------------
 * The reference system is multi-tenant: `Organization` is the tenant root, every
 * business table carries `organization_id`, and Postgres row-level security
 * enforces isolation. AD-1 makes this single-tenant, so none of that applies -
 * there is no organizationId on any schema, no tenancy middleware, no
 * AsyncLocalStorage, no withOrg wrapper, and no RLS to emulate.
 *
 * What survives from Organization is the part that was never about tenancy:
 * the company's own name, branding and statutory identifiers. There is exactly
 * ONE of these documents, pinned by a fixed key rather than a "find the newest"
 * query.
 *
 * `defaultStateCode` lives here because AD-12 needs it: statutory resolution
 * runs employee override -> location -> COMPANY DEFAULT -> block. It is
 * nullable, and null means "not configured", which blocks payroll rather than
 * silently defaulting to a state. The reference system hardcodes 'KA' in three
 * places instead, which silently produces the wrong professional tax for
 * everyone.
 */

import mongoose from 'mongoose';

import { INDIAN_STATE_CODES } from '../../shared/constants/hrms.js';

const companyProfileSchema = new mongoose.Schema(
  {
    /** Fixed discriminator: there can only ever be one company (AD-1). */
    key: { type: String, default: 'company-profile', unique: true, immutable: true },

    legalName: { type: String, required: true, trim: true, default: 'Shraddha Impex' },
    displayName: { type: String, trim: true, default: 'Shraddha Impex' },

    /** Object key in the HRMS bucket, not a URL. Served via a presigned URL. */
    logoKey: { type: String, default: null },

    registeredAddress: { type: String, default: null },
    city: { type: String, default: null },

    /**
     * AD-12. Null means NOT CONFIGURED, and payroll must block rather than
     * assume. Never give this a default state.
     */
    defaultStateCode: {
      type: String,
      default: null,
      enum: [...INDIAN_STATE_CODES, null],
    },

    /**
     * Statutory registration identifiers.
     *
     * These belong to the COMPANY, not to a person, so they are not covered by
     * AD-10's employee field encryption - a PAN on a payslip identifies an
     * individual, whereas a company PAN is printed on every invoice.
     */
    statutory: {
      pan: { type: String, default: null, trim: true, uppercase: true },
      tan: { type: String, default: null, trim: true, uppercase: true },
      gstin: { type: String, default: null, trim: true, uppercase: true },
      pfEstablishmentCode: { type: String, default: null, trim: true },
      esiEstablishmentCode: { type: String, default: null, trim: true },
    },

    /** Working-week configuration. Used by the leave duration rules later. */
    weekendDays: {
      type: [Number], // 0 = Sunday ... 6 = Saturday
      default: [0],
      validate: {
        validator: (v) => (v ?? []).every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
        message: 'weekendDays must contain integers 0-6 (0 = Sunday).',
      },
    },

    financialYearStartMonth: { type: Number, default: 4, min: 1, max: 12 }, // April, India

    /** Free-form branding overrides, mirroring Organization.brand. */
    brand: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

/**
 * Read the profile, creating it from defaults on first use.
 *
 * Idempotent, so it is safe from a request, a seeder or a script.
 */
companyProfileSchema.statics.load = async function load() {
  const existing = await this.findOne({ key: 'company-profile' });
  if (existing) return existing;
  return this.create({ key: 'company-profile' });
};

/**
 * Whether payroll's statutory prerequisites are satisfiable at company level.
 *
 * Reported rather than assumed: AD-12 requires that an unresolved state BLOCKS
 * a payroll run, so the UI needs to be able to say what is missing before
 * someone tries.
 */
companyProfileSchema.methods.statutoryReadiness = function statutoryReadiness() {
  const missing = [];
  if (!this.defaultStateCode) {
    missing.push('defaultStateCode - required unless every location sets its own state');
  }
  if (!this.statutory?.pan) missing.push('statutory.pan');
  if (!this.statutory?.tan) missing.push('statutory.tan');
  return { ready: missing.length === 0, missing };
};

export default mongoose.models.CompanyProfile ||
  mongoose.model('CompanyProfile', companyProfileSchema);
