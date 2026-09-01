/**
 * The CanonicalEmployeeRecord (AD-11).
 *
 * The boundary between an UNKNOWN source and the import pipeline.
 *
 * ---------------------------------------------------------------------------
 * No source is assumed
 * ---------------------------------------------------------------------------
 * AD-11 defers the migration source: not the DTA PostgreSQL database, not an
 * Excel or CSV file, not another HR system, not manual entry. Everything to the
 * right of this shape is built now; when the source is chosen, only a thin
 * adapter that produces this shape has to be written.
 *
 * ---------------------------------------------------------------------------
 * Two fields are deliberately ABSENT
 * ---------------------------------------------------------------------------
 *   managerChain   DERIVED, never imported. It is a denormalised ancestry that
 *                  every `team`-scope permission check reads. Importing it
 *                  would bake in whatever hierarchy the source happened to
 *                  hold and silently break authorization the moment it drifts.
 *
 *   _id            Assigned by us. An external source cannot know it, which is
 *                  why `employeeCode` is the natural key instead.
 *
 * Manager references arrive as `reportingManagerCode` - a CODE, not an id -
 * because the manager may not exist yet when this row is read. That is what
 * makes the three-pass import necessary.
 */

import { z } from 'zod';

import {
  objectId,
  isoDay,
  email as emailSchema,
  phone10,
  employmentType,
  employeeStatus,
  customFieldValues,
} from '../../../shared/validation/common.js';
import { SENSITIVE_EMPLOYEE_FIELD_LIST } from '../../../shared/security/sensitive-fields.js';

const trimmed = (max) => z.string().trim().min(1).max(max);
const optionalText = (max) => z.string().trim().max(max).optional().nullable();

export const emergencyContactSchema = z.object({
  name: trimmed(100),
  relationship: trimmed(50),
  phone: phone10,
  email: emailSchema.optional().nullable(),
});

export const dependentSchema = z.object({
  name: trimmed(100),
  relationship: trimmed(50),
  dateOfBirth: isoDay.optional().nullable(),
  isNominee: z.boolean().default(false),
});

/** Sensitive values may be supplied directly, as an alternative to the blob. */
const sensitiveShape = Object.fromEntries(
  SENSITIVE_EMPLOYEE_FIELD_LIST.map((f) => [f, optionalText(64)]),
);

export const canonicalEmployeeRecordSchema = z
  .object({
    // ---- identity -------------------------------------------------------
    /** THE natural key. Upserts match on this, so re-running an import is safe. */
    employeeCode: trimmed(30),
    firstName: trimmed(80),
    lastName: trimmed(80),

    // ---- contact --------------------------------------------------------
    email: emailSchema,
    personalEmail: emailSchema.optional().nullable(),
    phone: optionalText(20),
    phone2: optionalText(20),

    // ---- dates ----------------------------------------------------------
    dateOfBirth: isoDay.optional().nullable(),
    dateOfJoining: isoDay,

    // ---- job ------------------------------------------------------------
    employmentType: employmentType.default('full_time'),
    designation: optionalText(120),
    status: employeeStatus.default('invited'),

    /** Looked up by CODE, because an external source cannot know our ids. */
    departmentCode: optionalText(50),
    locationCode: optionalText(50),

    /**
     * The manager's employeeCode. Resolved to an id in pass 2, after every
     * employee exists - a manager may appear later in the same file than the
     * person reporting to them.
     */
    reportingManagerCode: optionalText(30),

    // ---- family and address --------------------------------------------
    fatherName: optionalText(120),
    motherName: optionalText(120),
    permanentAddress: optionalText(1000),
    temporaryAddress: optionalText(1000),

    emergencyContacts: z.array(emergencyContactSchema).max(2).default([]),
    dependents: z.array(dependentSchema).default([]),

    // ---- extensible -----------------------------------------------------
    customFieldValues,

    // ---- sensitive (AD-10) ---------------------------------------------
    ...sensitiveShape,
  })
  // Unknown keys are an error rather than silently dropped: a column the
  // adapter forgot to map is a data-loss bug, and it should surface in the
  // preview rather than after the commit.
  .strict();

/** @typedef {z.infer<typeof canonicalEmployeeRecordSchema>} CanonicalEmployeeRecord */

/**
 * Fields the pipeline REFUSES to accept, with the reason. Checked before
 * parsing so the message explains the design rather than reading as a typo.
 */
export const FORBIDDEN_IMPORT_FIELDS = Object.freeze({
  managerChain:
    'managerChain is derived from reportingManagerCode after every employee exists. Importing it would bake in a stale hierarchy that every team-scope permission check reads.',
  _id: 'Ids are assigned here. Use employeeCode as the natural key.',
  id: 'Ids are assigned here. Use employeeCode as the natural key.',
  reportingManagerId:
    'Use reportingManagerCode. An external source cannot know our ids, and the manager may not exist yet when this row is read.',
  password: 'Passwords are never imported. Accounts are created invited, and the person sets their own.',
});

export const objectIdSchema = objectId;
export default canonicalEmployeeRecordSchema;
