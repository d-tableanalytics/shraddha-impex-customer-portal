/**
 * Asset validation schemas (AD-6).
 *
 * Ported from the reference's `packages/shared-types/src/asset.ts`. Imported by
 * the Express validator AND by the React forms, so a rule cannot drift.
 *
 * Deviations from the reference, each deliberate:
 *   - `uuid` becomes `objectId` (AD-2), `organizationId` is gone (AD-1)
 *   - `purchasePrice` is a STRING at the boundary so a float never reaches
 *     Decimal128 (AD-2). The reference uses `z.number()` against a
 *     `Decimal(12,2)` column, and treats a price of 0 as absent.
 *   - list queries exist at all. The reference ships the whole inventory and
 *     pages it in the browser.
 */

import { z } from 'zod';

import { objectId, isoDay as isoDayShape, money } from '../validation/common.js';
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

export const ASSET_STATUSES = Object.freeze([
  'available',
  'assigned',
  'in_repair',
  'retired',
  'lost',
]);

/**
 * Statuses an administrator may set directly.
 *
 * `assigned` is deliberately absent. It is reached by assigning and left by
 * returning; the reference accepts it here, which produces an item that reads
 * as issued while `currentAssignmentId` is null — and which `assign()` then
 * refuses to assign because it is no longer available.
 */
export const SETTABLE_ASSET_STATUSES = Object.freeze([
  'available',
  'in_repair',
  'retired',
  'lost',
]);

/** Statuses in which an item is out of circulation for good. */
export const TERMINAL_ASSET_STATUSES = Object.freeze(['retired', 'lost']);

export const ASSET_REQUEST_STATUSES = Object.freeze([
  'submitted',
  'approved',
  'rejected',
  'fulfilled',
  'cancelled',
]);

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const createAssetCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(1)
      .max(40)
      .regex(/^[A-Z0-9_]+$/, 'Use uppercase letters, digits or underscore only.'),
    requiresSerialNumber: z.boolean().default(true),
    /**
     * Expected service life. The reference stores it and reads it nowhere; it
     * is catalogue guidance here too, and nothing is depreciated or retired
     * automatically on the strength of it.
     */
    defaultLifespanMonths: z.coerce.number().int().min(1).max(600).default(36),
  })
  .strict();

/** The code identifies the category on every item booked to it; it is fixed. */
export const updateAssetCategorySchema = createAssetCategorySchema
  .omit({ code: true })
  .partial()
  .strict();

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const createAssetItemSchema = z
  .object({
    categoryId: objectId,
    serialNumber: z.string().trim().max(80).optional().nullable(),
    brand: z.string().trim().max(60).optional().nullable(),
    model: z.string().trim().max(80).optional().nullable(),
    purchaseDate: isoDay.optional().nullable(),
    warrantyEnd: isoDay.optional().nullable(),
    amcEnd: isoDay.optional().nullable(),
    purchasePrice: money({ allowNegative: false }).optional().nullable(),
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();

/** The category is fixed once set — an item's history is booked against it. */
export const updateAssetItemSchema = createAssetItemSchema
  .omit({ categoryId: true })
  .partial()
  .strict();

export const setAssetStatusSchema = z
  .object({
    status: z.enum(SETTABLE_ASSET_STATUSES),
    note: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

export const assetListQuerySchema = z
  .object({
    status: z.enum(ASSET_STATUSES).optional(),
    categoryId: objectId.optional(),
    /** Matches serial, brand or model. */
    search: z.string().trim().max(120).optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
  })
  .strict();

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export const assignAssetSchema = z
  .object({
    assetItemId: objectId,
    employeeId: objectId,
    conditionOnAssign: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

export const returnAssetSchema = z
  .object({
    conditionOnReturn: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const createAssetRequestSchema = z
  .object({
    categoryId: objectId,
    justification: z.string().trim().min(1).max(2000),
  })
  .strict();

export const decideAssetRequestSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    reason: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

export const fulfillAssetRequestSchema = z
  .object({
    assetItemId: objectId,
  })
  .strict();

export const assetRequestListQuerySchema = z
  .object({
    status: z.enum(ASSET_REQUEST_STATUSES).optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
  })
  .strict();

export default {
  createAssetCategorySchema,
  updateAssetCategorySchema,
  createAssetItemSchema,
  updateAssetItemSchema,
  setAssetStatusSchema,
  assetListQuerySchema,
  assignAssetSchema,
  returnAssetSchema,
  createAssetRequestSchema,
  decideAssetRequestSchema,
  fulfillAssetRequestSchema,
  assetRequestListQuerySchema,
  ASSET_STATUSES,
  SETTABLE_ASSET_STATUSES,
  TERMINAL_ASSET_STATUSES,
  ASSET_REQUEST_STATUSES,
};
