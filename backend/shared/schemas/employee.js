/**
 * Employee validation schemas (AD-6).
 *
 * Ported field-for-field from the reference's `packages/shared-types/employee.ts`
 * so the business meaning of every rule matches. Imported by the Express
 * validator AND by the React form, so a rule cannot drift between them.
 *
 * Deviations from the reference, each deliberate:
 *   - `uuid` becomes `objectId` (AD-2)
 *   - sensitive fields are declared explicitly instead of arriving inside
 *     customFieldValues (AD-10)
 *   - `managerChain` is absent; it is derived, never submitted (AD-11)
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
} from '../validation/common.js';
import {
  SENSITIVE_EMPLOYEE_FIELD_LIST,
  SENSITIVE_EMPLOYEE_FIELDS as F,
} from '../security/sensitive-fields.js';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../constants/hrms.js';

const optionalText = (max) => z.string().trim().max(max).optional().nullable();

/** The reference caps emergency contacts at two, and validates a 10-digit phone. */
export const MAX_EMERGENCY_CONTACTS = 2;

export const emergencyContactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  relationship: z.string().trim().min(1).max(50),
  phone: phone10,
  email: emailSchema.optional().nullable(),
});

export const dependentSchema = z.object({
  name: z.string().trim().min(1).max(100),
  relationship: z.string().trim().min(1).max(50),
  dateOfBirth: isoDay.optional().nullable(),
  isNominee: z.boolean().default(false),
});

/**
 * Sensitive values, supplied explicitly rather than through the blob.
 *
 * Every one is optional: an employee record is perfectly valid without a PAN,
 * and requiring one would block onboarding someone whose paperwork has not
 * arrived.
 */
const sensitiveShape = Object.fromEntries(
  SENSITIVE_EMPLOYEE_FIELD_LIST.map((f) => [f, optionalText(64)]),
);

/** Fields common to create and update. */
const employeeCoreShape = {
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),

  personalEmail: emailSchema.optional().nullable(),
  phone: optionalText(20),
  phone2: optionalText(20),

  dateOfBirth: isoDay.optional().nullable(),
  dateOfJoining: isoDay,

  employmentType,
  designation: optionalText(120),
  status: employeeStatus,

  departmentId: objectId.optional().nullable(),
  locationId: objectId.optional().nullable(),
  reportingManagerId: objectId.optional().nullable(),

  probationMonths: z.number().int().min(1).max(24).optional().nullable(),
  probationStartDate: isoDay.optional().nullable(),
  probationEndDate: isoDay.optional().nullable(),

  noticeStartDate: isoDay.optional().nullable(),
  noticeMonths: z.number().int().min(1).max(12).optional().nullable(),
  noticeEndDate: isoDay.optional().nullable(),

  fatherName: optionalText(120),
  motherName: optionalText(120),
  permanentAddress: optionalText(1000),
  temporaryAddress: optionalText(1000),

  emergencyContacts: z.array(emergencyContactSchema).max(MAX_EMERGENCY_CONTACTS).default([]),
  dependents: z.array(dependentSchema).default([]),

  customFieldValues,
  ...sensitiveShape,
};

/**
 * Create.
 *
 * `email` and `employeeCode` appear only here: the reference disables both on
 * the edit form, because the email is the login identity and employeeCode is
 * the natural key every other record joins on.
 */
export const createEmployeeSchema = z
  .object({
    ...employeeCoreShape,
    employeeCode: z.string().trim().min(1).max(30),
    email: emailSchema,
    status: employeeStatus.default('invited'),
    employmentType: employmentType.default('full_time'),
    probationMonths: z.number().int().min(1).max(24).default(3).nullable().optional(),
    /** HRMS role keys to grant. Defaults to plain employee access. */
    initialRoleKeys: z.array(z.string()).default(['hrms_employee']),
  })
  .strict();

/**
 * Update.
 *
 * Everything optional — the form PATCHes only what changed. `employeeCode` and
 * `email` are absent by construction, so an attempt to change either is
 * rejected by `.strict()` rather than silently ignored.
 */
export const updateEmployeeSchema = z
  .object({
    ...employeeCoreShape,
    displayName: z.string().trim().min(1).max(160),
  })
  .partial()
  .strict();

/** List query. Mirrors the reference's filters exactly. */
export const employeeListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  search: z.string().trim().max(200).optional(),
  departmentId: objectId.optional(),
  locationId: objectId.optional(),
  status: employeeStatus.optional(),
  managerId: objectId.optional(),
  /** Restrict to employees whose user holds this HRMS role key. */
  roleKey: z.string().trim().min(1).max(64).optional(),
  sortBy: z.enum(['firstName', 'employeeCode', 'dateOfJoining', 'status']).optional(),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});

/** Role assignment. At least one, matching the reference's rule. */
export const assignRolesSchema = z.object({
  roleKeys: z.array(z.string().trim().min(1)).min(1),
});

/**
 * Revealing a sensitive value.
 *
 * A deliberate, audited act rather than a query parameter on the read — see
 * AD-10. The field must be named, so "show me everything" is not expressible.
 */
export const revealSensitiveSchema = z.object({
  field: z.enum(SENSITIVE_EMPLOYEE_FIELD_LIST),
  reason: z.string().trim().max(300).optional(),
});

// ---------------------------------------------------------------------------
// Custom field definitions
// ---------------------------------------------------------------------------

export const customFieldTypeSchema = z.enum([
  'text',
  'textarea',
  'number',
  'date',
  'boolean',
  'select',
  'multiselect',
]);

export const createCustomFieldSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, 'lowercase snake_case'),
    label: z.string().trim().min(1).max(120),
    type: customFieldTypeSchema,
    options: z.array(z.string().trim().min(1)).default([]),
    required: z.boolean().default(false),
    order: z.number().int().default(0),
  })
  .strict();

/** `name` is immutable — renaming it would orphan every stored value. */
export const updateCustomFieldSchema = createCustomFieldSchema
  .omit({ name: true })
  .partial()
  .strict();

export { SENSITIVE_EMPLOYEE_FIELD_LIST, F as SENSITIVE_EMPLOYEE_FIELDS };
