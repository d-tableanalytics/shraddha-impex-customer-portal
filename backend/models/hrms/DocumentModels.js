/**
 * Documents: folders, files, policies and acknowledgments.
 *
 * Ported from the reference's `DocumentFolder`, `Document`, `PolicyDocument`
 * and `DocumentAcknowledgment`.
 *
 * ---------------------------------------------------------------------------
 * The POLICY is embedded; the ACKNOWLEDGMENT is not
 * ---------------------------------------------------------------------------
 * A policy is one-to-one with its document — `@unique document_id` in the
 * reference's own schema — is created with it, read with it and deleted with
 * it, so it is a subdocument here. Acknowledgments are the opposite: one row
 * per user per policy, queried by user ("what have I not signed?") as often as
 * by document ("who has not signed this?"), and unbounded in a way a document
 * array is not. They stay a collection.
 *
 * ---------------------------------------------------------------------------
 * Ownership is EXPLICIT and never nulled
 * ---------------------------------------------------------------------------
 * The reference's employee relation is `onDelete: SetNull`, and its list
 * treats a document with neither folder nor employee as org-visible — so
 * deleting an employee publishes every private document they had to the whole
 * company. Here `scope` is a stored, required field: an `employee` document is
 * personal forever, whatever later happens to the employee row.
 */

import mongoose from 'mongoose';

import { FOLDER_VISIBILITIES, DOCUMENT_SCOPES } from '../../shared/schemas/document.js';

const { Schema } = mongoose;

// ---------------------------------------------------------------------------
// Folder
// ---------------------------------------------------------------------------

const documentFolderSchema = new Schema(
  {
    parentId: { type: Schema.Types.ObjectId, default: null, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    visibility: { type: String, enum: FOLDER_VISIBILITIES, default: 'org' },
    roleKeys: { type: [String], default: [] },
    departmentIds: { type: [Schema.Types.ObjectId], default: [] },
    createdByEmployeeId: { type: Schema.Types.ObjectId, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'hrms_document_folders' },
);

documentFolderSchema.index({ deletedAt: 1, name: 1 });

// ---------------------------------------------------------------------------
// Policy — embedded in the document it governs
// ---------------------------------------------------------------------------

const policySchema = new Schema(
  {
    requiresAcknowledgment: { type: Boolean, default: true },
    requiresSignature: { type: Boolean, default: false },
    /** `YYYY-MM-DD`. A policy takes effect on a calendar day, not an instant. */
    effectiveFrom: { type: String, required: true },
    expiresAt: { type: String, default: null },
    /** Empty means everyone. */
    targetRoleKeys: { type: [String], default: [] },
    publishedAt: { type: Date, default: Date.now },
    publishedByEmployeeId: { type: Schema.Types.ObjectId, default: null },
  },
  { _id: false },
);

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

const documentSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },

    /**
     * `company` or `employee`. Required and stored, rather than inferred from
     * which of two nullable ids happens to be set — the inference is what makes
     * the reference publish a departed employee's private files.
     */
    scope: { type: String, enum: DOCUMENT_SCOPES, required: true, index: true },

    /** Set when scope is `employee`. Never cleared. */
    employeeId: { type: Schema.Types.ObjectId, default: null, index: true },
    /** Snapshot, so the row still reads correctly after the employee ages out. */
    employeeName: { type: String, default: '' },

    /** Set only when scope is `company`. Null means the library root. */
    folderId: { type: Schema.Types.ObjectId, default: null, index: true },

    tags: { type: [String], default: [] },

    /**
     * The storage layer's key. NEVER sent to a browser and never accepted from
     * one — the reference returns it in every DTO and reads files back with
     * `path.resolve(uploadsRoot, fileKey)`.
     */
    storageKey: { type: String, required: true },
    storageCategory: { type: String, required: true },

    /** The SNIFFED type, not the one the client declared. */
    mimeType: { type: String, required: true },
    fileSize: { type: Number, required: true, min: 0 },
    /** Kept for display only; never used to build a path. */
    originalFilename: { type: String, default: null, maxlength: 260 },

    uploadedByEmployeeId: { type: Schema.Types.ObjectId, default: null },
    uploadedByName: { type: String, default: '' },
    uploadedAt: { type: Date, default: Date.now },

    /** Present once the document has been published as a policy. */
    policy: { type: policySchema, default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'hrms_documents' },
);

/** The four reads: the library, a folder, one employee's repo, and policies. */
documentSchema.index({ deletedAt: 1, scope: 1, uploadedAt: -1 });
documentSchema.index({ deletedAt: 1, folderId: 1, uploadedAt: -1 });
documentSchema.index({ deletedAt: 1, employeeId: 1, uploadedAt: -1 });
documentSchema.index({ deletedAt: 1, 'policy.requiresAcknowledgment': 1 });
/** Name and tag search. */
documentSchema.index({ name: 'text', tags: 'text' });

// ---------------------------------------------------------------------------
// Acknowledgment
// ---------------------------------------------------------------------------

const acknowledgmentSchema = new Schema(
  {
    documentId: { type: Schema.Types.ObjectId, required: true, index: true },
    employeeId: { type: Schema.Types.ObjectId, required: true, index: true },
    employeeName: { type: String, default: '' },
    acknowledgedAt: { type: Date, default: Date.now },

    /**
     * The attestation of record: what the person typed, from where, and when.
     *
     * The drawn image is kept as an OBJECT and referenced by key. The reference
     * stores up to 500 KB of base64 in a JSON column for every user × every
     * policy.
     */
    signatureName: { type: String, default: null, maxlength: 120 },
    signatureKey: { type: String, default: null },
    signedFromIp: { type: String, default: null },

    /** The policy terms as they stood when this person agreed to them. */
    policySnapshot: {
      effectiveFrom: { type: String, default: null },
      expiresAt: { type: String, default: null },
      requiresSignature: { type: Boolean, default: false },
    },
  },
  { timestamps: true, collection: 'hrms_document_acknowledgments' },
);

/** One acknowledgment per person per document. */
acknowledgmentSchema.index({ documentId: 1, employeeId: 1 }, { unique: true });

// ---------------------------------------------------------------------------

export const DocumentFolder =
  mongoose.models.DocumentFolder ||
  mongoose.model('DocumentFolder', documentFolderSchema);

export const HrmsDocument =
  mongoose.models.HrmsDocument || mongoose.model('HrmsDocument', documentSchema);

export const DocumentAcknowledgment =
  mongoose.models.DocumentAcknowledgment ||
  mongoose.model('DocumentAcknowledgment', acknowledgmentSchema);

export default { DocumentFolder, HrmsDocument, DocumentAcknowledgment };
