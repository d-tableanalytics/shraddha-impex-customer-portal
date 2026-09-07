/**
 * Assets: the category catalogue, the inventory, and the request queue.
 *
 * Ported from the reference's `AssetCategory`, `AssetItem`, `AssetAssignment`
 * and `AssetRequest`.
 *
 * ---------------------------------------------------------------------------
 * Assignment HISTORY is embedded; the ACTIVE assignment is a pointer
 * ---------------------------------------------------------------------------
 * The reference keeps assignments in their own table and hangs a
 * `currentAssignmentId` off the item — a self-referential unique FK that has to
 * be written in step with `status` on every transition, and which its own
 * `setStatus` gets wrong (it can leave `status: 'assigned'` with a null
 * pointer). Here the assignment log lives on the item as an ordered subdocument
 * array and "current" is derived: the one entry with no `returnedAt`. A single
 * document write moves both, so the two can never disagree.
 *
 * The array is bounded in practice — an asset is issued a handful of times over
 * its life — and every read of an item wants its history anyway.
 *
 * ---------------------------------------------------------------------------
 * Money is Decimal128
 * ---------------------------------------------------------------------------
 * AD-2 forbids floats for money. The reference declares `Decimal(12,2)` and
 * then passes a JavaScript number through `z.number()` and `Number()`.
 */

import mongoose from 'mongoose';

import {
  ASSET_STATUSES,
  ASSET_REQUEST_STATUSES,
} from '../../shared/schemas/asset.js';

const { Schema } = mongoose;

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

const assetCategorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 40 },
    requiresSerialNumber: { type: Boolean, default: true },
    /** Catalogue guidance. Nothing retires an item on the strength of it. */
    defaultLifespanMonths: { type: Number, default: 36, min: 1, max: 600 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'hrms_asset_categories' },
);

/**
 * The code is unique among LIVE categories.
 *
 * Partial rather than plain, so retiring `LAPTOP` does not block a later
 * `LAPTOP` — and `$type` rather than a null test, because a soft-deleted row
 * still has the field.
 */
assetCategorySchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
assetCategorySchema.index({ deletedAt: 1, name: 1 });

// ---------------------------------------------------------------------------
// Item + assignment history
// ---------------------------------------------------------------------------

/**
 * One issue-and-return cycle.
 *
 * `returnedAt === null` is what makes an entry the current assignment. The
 * condition on BOTH ends is recorded: the reference has the field and its own
 * return control never sends it, so its "Condition on return" column can only
 * ever render a dash.
 */
const assignmentSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, required: true },
    /** Snapshot: a returned assignment must still read correctly later. */
    employeeName: { type: String, default: '' },

    assignedAt: { type: Date, default: Date.now },
    assignedByEmployeeId: { type: Schema.Types.ObjectId, default: null },
    assignedByName: { type: String, default: '' },
    conditionOnAssign: { type: String, default: null, maxlength: 500 },

    returnedAt: { type: Date, default: null },
    returnedByEmployeeId: { type: Schema.Types.ObjectId, default: null },
    conditionOnReturn: { type: String, default: null, maxlength: 500 },

    /**
     * Set when the item was taken back by a status change rather than by an
     * ordinary return — retired, lost or sent for repair while still issued.
     */
    closedByStatus: { type: String, default: null },
  },
  { _id: true, timestamps: false },
);

const assetItemSchema = new Schema(
  {
    categoryId: { type: Schema.Types.ObjectId, required: true, index: true },

    serialNumber: { type: String, default: null, trim: true, maxlength: 80 },
    brand: { type: String, default: null, trim: true, maxlength: 60 },
    model: { type: String, default: null, trim: true, maxlength: 80 },

    /** `YYYY-MM-DD`. A purchase or warranty date is a calendar day. */
    purchaseDate: { type: String, default: null },
    warrantyEnd: { type: String, default: null },
    amcEnd: { type: String, default: null },

    purchasePrice: { type: Schema.Types.Decimal128, default: null },

    status: { type: String, enum: ASSET_STATUSES, default: 'available', index: true },
    notes: { type: String, default: null, maxlength: 2000 },

    assignments: { type: [assignmentSchema], default: [] },

    /**
     * The employee currently holding this item, and null when nobody does.
     *
     * Derived from `assignments` — never accepted from a caller. It exists so
     * "what is Priya holding?" is one indexed query rather than a scan of every
     * item's history, and so the one-active-assignment rule is a real index.
     */
    assignedToEmployeeId: { type: Schema.Types.ObjectId, default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'hrms_asset_items' },
);

/** `assignedToEmployeeId` and `status` are projections of the history. */
assetItemSchema.pre('validate', function syncAssignment(next) {
  const active = (this.assignments ?? []).find((a) => !a.returnedAt);
  this.assignedToEmployeeId = active ? active.employeeId : null;

  // An item with somebody holding it is `assigned`, and an item that is
  // `assigned` has somebody holding it. The reference lets these drift.
  if (active && this.status !== 'assigned') this.status = 'assigned';
  if (!active && this.status === 'assigned') this.status = 'available';
  next();
});

/**
 * A serial number identifies one physical thing.
 *
 * Unique among live items that actually have one — the reference has no
 * constraint and no check, so two laptops can share a serial and a return can
 * be booked against the wrong one.
 */
assetItemSchema.index(
  { serialNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { serialNumber: { $type: 'string' }, deletedAt: null },
  },
);

/** The three reads: the inventory grid, an employee's kit, and a category's items. */
assetItemSchema.index({ deletedAt: 1, status: 1, createdAt: -1 });
assetItemSchema.index({ assignedToEmployeeId: 1, deletedAt: 1 });
assetItemSchema.index({ categoryId: 1, status: 1 });

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

const assetRequestSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, required: true, index: true },
    employeeName: { type: String, default: '' },
    categoryId: { type: Schema.Types.ObjectId, required: true },

    justification: { type: String, required: true, trim: true, maxlength: 2000 },
    status: {
      type: String,
      enum: ASSET_REQUEST_STATUSES,
      default: 'submitted',
      index: true,
    },

    decidedByEmployeeId: { type: Schema.Types.ObjectId, default: null },
    decidedByName: { type: String, default: '' },
    decidedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null, maxlength: 500 },

    fulfilledAssetItemId: { type: Schema.Types.ObjectId, default: null },
    fulfilledAt: { type: Date, default: null },

    cancelledAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'hrms_asset_requests' },
);

assetRequestSchema.index({ deletedAt: 1, status: 1, createdAt: -1 });
assetRequestSchema.index({ employeeId: 1, createdAt: -1 });

// ---------------------------------------------------------------------------

export const AssetCategory =
  mongoose.models.AssetCategory || mongoose.model('AssetCategory', assetCategorySchema);

export const AssetItem =
  mongoose.models.AssetItem || mongoose.model('AssetItem', assetItemSchema);

export const AssetRequest =
  mongoose.models.AssetRequest || mongoose.model('AssetRequest', assetRequestSchema);

export default { AssetCategory, AssetItem, AssetRequest };
