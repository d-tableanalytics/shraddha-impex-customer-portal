/**
 * Department — one of the two Org Structure catalogues.
 *
 * Ported from the reference's `Department` model (`schema.prisma:249-268`).
 * `organizationId` is gone (AD-1, single tenant), so its
 * `@@unique([organizationId, code])` becomes a unique index on `code` alone.
 *
 * ---------------------------------------------------------------------------
 * Soft delete, and why the unique index is partial
 * ---------------------------------------------------------------------------
 * The reference hard-deletes and lets a Postgres foreign key refuse when
 * employees still point at the row. AD-2 removed foreign keys, so nothing in
 * MongoDB would refuse — the delete would succeed and every employee holding
 * that `departmentId` would render a blank field with no way to discover what
 * it used to say. Deletion is therefore soft, and the service layer performs
 * the reference check the database no longer can (O-3).
 *
 * A plain unique index on `code` would then make a retired code unusable
 * forever, which is wrong: retiring `ENG` and later re-creating it is ordinary
 * housekeeping. The index is `unique` only over live rows, so a code is free
 * again once its department is retired, while two live departments still cannot
 * share one.
 */

import mongoose from 'mongoose';

import {
  ORG_CODE_PATTERN,
  ORG_CODE_MAX_LENGTH,
  ORG_NAME_MAX_LENGTH,
} from '../../shared/constants/hrms.js';

const { Schema } = mongoose;

const departmentSchema = new Schema(
  {
    /**
     * The stable code an import matches on, and what the reference shows in
     * tables and dropdowns (`CODE · Name`). Upper-cased on write so lookups
     * never have to care about case.
     */
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: ORG_CODE_MAX_LENGTH,
      match: [ORG_CODE_PATTERN, 'Use uppercase letters, numbers, hyphen or underscore only.'],
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: ORG_NAME_MAX_LENGTH,
    },

    /**
     * Reserved for imported hierarchy. NOT a feature (O-1).
     *
     * The reference's schema is hierarchical — `parentId`, a `DeptTree`
     * self-relation, and DTO support — but its product is flat: there is no
     * parent picker, no tree rendering, and no cycle check anywhere. Its
     * `update()` writes whatever `parentId` arrives, so `A → B → A` is
     * accepted, which is the same class of defect already corrected in
     * `managerChain`.
     *
     * The field is kept so a later import of reference data does not have to
     * discard the hierarchy it carries. No Zod schema accepts it, so no request
     * can set it and no cycle can be introduced through the API. If department
     * trees ever become a real feature, that is the point at which they need
     * `assertNoCycle` — not before.
     */
    parentId: { type: Schema.Types.ObjectId, default: null },

    /** Soft delete (O-3). Null means live. */
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'hrms_departments' },
);

// Unique among LIVE rows only — see the note above.
departmentSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

// The list endpoint is "every live department, ordered by name" and nothing else.
departmentSchema.index({ deletedAt: 1, name: 1 });

export const Department =
  mongoose.models.Department || mongoose.model('Department', departmentSchema);

export default Department;
