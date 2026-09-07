/**
 * Document validation schemas (AD-6).
 *
 * Ported from the reference's `packages/shared-types/src/document.ts`. Imported
 * by the Express validator AND by the React forms, so a rule cannot drift.
 *
 * Deviations from the reference, each deliberate:
 *   - `uuid` becomes `objectId` (AD-2), `organizationId` is gone (AD-1)
 *   - `fileKey` is NOT part of any DTO. The reference returns the raw storage
 *     key to every browser and then reads files back with
 *     `path.resolve(uploadsRoot, fileKey)`.
 *   - `signatureImage` is capped far below the reference's 500,000 characters
 *     and is stored as an OBJECT rather than in the database.
 *   - list queries exist at all. The reference reads every document in the
 *     organisation on every call and filters in application memory.
 */

import { z } from 'zod';

import { objectId, isoDay as isoDayShape } from '../validation/common.js';
import { dayToUtcMs } from '../leave/dates.js';

/** Well-shaped AND real: the bare regex accepts 2026-02-31. */
const isoDay = isoDayShape.refine(
  (value) => {
    try {
      dayToUtcMs(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'That is not a real calendar date.' },
);

/**
 * Who a folder's contents are for.
 *
 * The reference declares a fourth value, `employee`, whose `canSee` returns
 * false unconditionally and which nothing else resolves — so a folder marked
 * that way is invisible to everyone but HR, permanently. Personal documents are
 * addressed by `employeeId` on the document itself, which is what actually
 * works, so the dead value is not carried over.
 */
export const FOLDER_VISIBILITIES = Object.freeze(['org', 'role', 'department']);

/** Where a document lives. Derived, not accepted from a caller. */
export const DOCUMENT_SCOPES = Object.freeze(['company', 'employee']);

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export const createFolderSchema = z
  .object({
    parentId: objectId.optional().nullable(),
    name: z.string().trim().min(1).max(120),
    visibility: z.enum(FOLDER_VISIBILITIES).default('org'),
    /** Meaningful only when visibility is `role`. */
    roleKeys: z.array(z.string().trim().max(60)).max(20).default([]),
    /** Meaningful only when visibility is `department`. */
    departmentIds: z.array(objectId).max(50).default([]),
  })
  .strict()
  .refine((v) => v.visibility !== 'role' || v.roleKeys.length > 0, {
    path: ['roleKeys'],
    message: 'Choose at least one role, or make the folder org-wide.',
  })
  .refine((v) => v.visibility !== 'department' || v.departmentIds.length > 0, {
    path: ['departmentIds'],
    message: 'Choose at least one department, or make the folder org-wide.',
  });

export const updateFolderSchema = z
  .object({
    parentId: objectId.optional().nullable(),
    name: z.string().trim().min(1).max(120).optional(),
    visibility: z.enum(FOLDER_VISIBILITIES).optional(),
    roleKeys: z.array(z.string().trim().max(60)).max(20).optional(),
    departmentIds: z.array(objectId).max(50).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * The metadata that rides alongside an upload.
 *
 * Sent as multipart text fields, so everything arrives as a string —
 * `tags` is a comma-separated list, exactly as the reference sends it.
 */
export const uploadDocumentSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    folderId: objectId.optional().nullable(),
    /** Absent means "the company library"; present means a personal document. */
    employeeId: objectId.optional().nullable(),
    tags: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((value) => {
        const list = Array.isArray(value) ? value : String(value ?? '').split(',');
        return [...new Set(list.map((t) => t.trim()).filter(Boolean))].slice(0, 20);
      })
      .pipe(z.array(z.string().max(40))),
  })
  .strict()
  .refine((v) => !(v.folderId && v.employeeId), {
    path: ['folderId'],
    message: 'A document belongs to a folder or to an employee, not to both.',
  });

/** Renaming, re-tagging and re-filing. The bytes are replaced separately. */
export const updateDocumentSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    folderId: objectId.optional().nullable(),
    tags: z.array(z.string().trim().max(40)).max(20).optional(),
  })
  .strict();

export const documentListQuerySchema = z
  .object({
    /** `company` or `employee`; absent means both, subject to scope. */
    scope: z.enum(DOCUMENT_SCOPES).optional(),
    folderId: objectId.optional(),
    employeeId: objectId.optional(),
    /** Matches the name and the tags. */
    search: z.string().trim().max(120).optional(),
    /** `true` narrows to documents published as policies. */
    policiesOnly: z.enum(['true', 'false']).optional(),
    /** `true` includes policies whose expiry has passed. */
    includeExpired: z.enum(['true', 'false']).optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
  })
  .strict();

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export const publishPolicySchema = z
  .object({
    requiresAcknowledgment: z.boolean().default(true),
    requiresSignature: z.boolean().default(false),
    effectiveFrom: isoDay,
    expiresAt: isoDay.optional().nullable(),
    /** Empty means everyone. */
    targetRoleKeys: z.array(z.string().trim().max(60)).max(20).default([]),
  })
  .strict()
  .refine((v) => !v.expiresAt || v.expiresAt >= v.effectiveFrom, {
    path: ['expiresAt'],
    message: 'A policy cannot expire before it takes effect.',
  });

// ---------------------------------------------------------------------------
// Acknowledgment
// ---------------------------------------------------------------------------

/**
 * A drawn signature, as a PNG data URL.
 *
 * Capped at ~200 KB of base64 rather than the reference's 500,000 characters,
 * and stored as an object rather than in the database — the reference keeps a
 * base64 blob in a JSON column for every user × every policy.
 */
const SIGNATURE_MAX_CHARS = 200_000;

export const acknowledgeDocumentSchema = z
  .object({
    /** The typed attestation. This is the signature of record. */
    signatureName: z.string().trim().max(120).optional().nullable(),
    signatureImage: z
      .string()
      .max(SIGNATURE_MAX_CHARS)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'Expected a PNG data URL.')
      .optional()
      .nullable(),
  })
  .strict();

export const SIGNATURE_MAX_BYTES = Math.floor((SIGNATURE_MAX_CHARS * 3) / 4);

export default {
  createFolderSchema,
  updateFolderSchema,
  uploadDocumentSchema,
  updateDocumentSchema,
  documentListQuerySchema,
  publishPolicySchema,
  acknowledgeDocumentSchema,
  FOLDER_VISIBILITIES,
  DOCUMENT_SCOPES,
  SIGNATURE_MAX_BYTES,
};
