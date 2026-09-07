/**
 * Documents: the folder tree, the library, personal repositories, policies and
 * acknowledgments.
 *
 * Ported from the reference's `DocumentService` + `DocumentFolderService`.
 * The shape is its shape — folders carry visibility, documents inherit it,
 * personal documents belong to an employee, and a document may be published as
 * a policy that people acknowledge and optionally sign.
 *
 * Corrections to the reference, each deliberate and each covered by a test:
 *
 *   1. THE STORAGE KEY NEVER LEAVES THE SERVER. The reference puts `fileKey`
 *      in every DTO and then reads files back with
 *      `path.resolve(uploadsRoot, fileKey)`. Reads here go through a presigned
 *      URL, authorised against the document and again by the storage rule.
 *
 *   2. THE SERVED TYPE IS THE SNIFFED TYPE. The reference stores the client's
 *      declared MIME type and echoes it back with `Content-Disposition:
 *      inline` — an uploaded `.html` becomes script execution on the API
 *      origin. Uploads are sniffed; downloads are attachments.
 *
 *   3. A DEPARTED EMPLOYEE'S DOCUMENTS STAY PRIVATE. The reference's employee
 *      relation is `onDelete: SetNull` and its list treats a document with no
 *      folder and no employee as org-visible, so deleting somebody publishes
 *      everything personal they had. `scope` is stored and never inferred.
 *
 *   4. SCOPE IS APPLIED IN THE QUERY. The reference reads every document in the
 *      organisation on every call and filters the array in memory.
 *
 *   5. WRITES NEED A WRITE PERMISSION. Upload, delete, publish and all three
 *      folder mutations are gated on `documents:view:org` in the reference.
 *
 *   6. ONLY A TARGET MAY ACKNOWLEDGE, and only while the policy is live. The
 *      reference lets anyone acknowledge anything, before it takes effect and
 *      after it expires.
 *
 *   7. EXPIRY IS ENFORCED. The reference stores `expiresAt`, renders it, and
 *      never filters on it — while the announcements service beside it does.
 *
 *   8. DELETING A DOCUMENT REMOVES ITS OBJECT. The reference deletes the row
 *      and leaves the file on disk forever.
 */

import mongoose from 'mongoose';

import Employee from '../../../models/hrms/Employee.js';
import User from '../../../models/User.js';
import {
  DocumentFolder,
  HrmsDocument,
  DocumentAcknowledgment,
} from '../../../models/hrms/DocumentModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { notify } from '../inbox/notifier.service.js';
import { INBOX_TYPES } from '../../../shared/constants/inbox.js';
import { AUDIT_ACTIONS, STORAGE_CATEGORIES } from '../../../shared/constants/hrms.js';
import { hasHrmsPermission } from '../../../shared/permissions/has-permission.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';
import {
  createFolderSchema,
  updateFolderSchema,
  uploadDocumentSchema,
  updateDocumentSchema,
  documentListQuerySchema,
  publishPolicySchema,
  acknowledgeDocumentSchema,
  SIGNATURE_MAX_BYTES,
} from '../../../shared/schemas/document.js';
import { formatZodIssues } from '../../../shared/validation/common.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsValidationError,
  HrmsForbiddenError,
} from '../hrms.errors.js';
import { putObject, deleteObject } from '../../../utils/hrms/storage/index.js';
import { utcMsToDay } from '../../../shared/leave/dates.js';
import { sniffDocument } from './documentUpload.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));
const iso = (v) => (v ? new Date(v).toISOString() : null);
const today = () => utcMsToDay(Date.now());
const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parse(schema, input, what) {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw new HrmsValidationError(`Invalid ${what}.`, formatZodIssues(result.error));
  }
  return result.data;
}

const fullName = (e) => `${e?.firstName ?? ''} ${e?.lastName ?? ''}`.trim();

/** HR and above: the whole library, every personal repo, every folder. */
const isDocumentAdmin = (actor) => hasHrmsPermission(actor, M.DOCUMENTS, A.EDIT, S.ORG);
/** Reading beyond one's own repository. */
const canReadOrg = (actor) => hasHrmsPermission(actor, M.DOCUMENTS, A.VIEW, S.ORG);

/** A policy is live when it has taken effect and has not expired. */
export function isPolicyLive(policy, on = today()) {
  if (!policy) return false;
  if (policy.effectiveFrom && policy.effectiveFrom > on) return false;
  if (policy.expiresAt && policy.expiresAt < on) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/**
 * Whether this actor may see a folder's contents.
 *
 * The reference's three reachable rules, kept. Its fourth — `employee` — is not
 * carried over; `canSee` returns false for it unconditionally and nothing else
 * resolves it, so such a folder is invisible to everyone but HR forever.
 */
export function canSeeFolder(actor, folder) {
  if (!folder) return true;
  if (canReadOrg(actor)) return true;
  if (folder.visibility === 'org') return true;
  if (folder.visibility === 'role') {
    // `roleKeys` is what buildHrmsActor exposes; `roles` is the raw User field
    // and is not on the actor.
    const held = new Set(actor?.roleKeys ?? []);
    return (folder.roleKeys ?? []).some((k) => held.has(k));
  }
  if (folder.visibility === 'department') {
    const mine = idStr(actor?.departmentId);
    return Boolean(mine) && (folder.departmentIds ?? []).map(idStr).includes(mine);
  }
  return false;
}

/** The folders this actor may read, as a concrete id list. */
async function visibleFolderIds(actor) {
  const folders = await DocumentFolder.find({ deletedAt: null }).lean();
  return folders.filter((f) => canSeeFolder(actor, f)).map((f) => f._id);
}

/**
 * The query that limits a document list to what this actor may read.
 *
 * Applied to the QUERY, not to the results. The reference filters the whole
 * organisation's documents in application memory on every call.
 */
async function scopeFilter(actor) {
  if (canReadOrg(actor)) return {};

  const clauses = [];
  if (actor?.employeeId) {
    // My own repository.
    clauses.push({ scope: 'employee', employeeId: actor.employeeId });
  }
  // The company library, limited to folders I can see. A library document with
  // no folder is org-wide by definition — that is the library root, not the
  // reference's accident of two null columns.
  const folderIds = await visibleFolderIds(actor);
  clauses.push({
    scope: 'company',
    $or: [{ folderId: null }, { folderId: { $in: folderIds } }],
  });

  return { $or: clauses };
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

const folderToDto = (row, documentCount = 0) => ({
  id: idStr(row._id),
  parentId: idStr(row.parentId),
  name: row.name,
  visibility: row.visibility,
  roleKeys: row.roleKeys ?? [],
  departmentIds: (row.departmentIds ?? []).map(idStr),
  documentCount,
  createdAt: iso(row.createdAt),
});

const documentToDto = (row, { folder, actor, acknowledged, ackCount } = {}) => ({
  id: idStr(row._id),
  name: row.name,
  scope: row.scope,
  employeeId: idStr(row.employeeId),
  employeeName: row.employeeName || null,
  folderId: idStr(row.folderId),
  folderName: folder?.name ?? null,
  tags: row.tags ?? [],

  /**
   * Presence and shape only. `storageKey` is deliberately absent — the
   * reference returns it to every browser.
   */
  mimeType: row.mimeType,
  fileSize: row.fileSize,
  originalFilename: row.originalFilename ?? null,

  uploadedByName: row.uploadedByName || null,
  uploadedAt: iso(row.uploadedAt),

  policy: row.policy
    ? {
        requiresAcknowledgment: row.policy.requiresAcknowledgment,
        requiresSignature: row.policy.requiresSignature,
        effectiveFrom: row.policy.effectiveFrom,
        expiresAt: row.policy.expiresAt ?? null,
        targetRoleKeys: row.policy.targetRoleKeys ?? [],
        /** Computed, because the reference stores expiry and never reads it. */
        isLive: isPolicyLive(row.policy),
        isExpired: Boolean(row.policy.expiresAt && row.policy.expiresAt < today()),
      }
    : null,

  acknowledgedByMe: Boolean(acknowledged),
  acknowledgmentCount: ackCount ?? 0,
  /** Whether this document belongs to the person reading it. */
  isMine:
    Boolean(actor?.employeeId) && idStr(row.employeeId) === idStr(actor.employeeId),
});

/** Batch-resolve the folders, acknowledgments and counts a page needs. */
async function hydrate(rows, actor) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return [];

  const folderIds = list.map((r) => r.folderId).filter(Boolean);
  const folders = folderIds.length
    ? await DocumentFolder.find({ _id: { $in: folderIds } }).select('_id name').lean()
    : [];
  const folderById = new Map(folders.map((f) => [idStr(f._id), f]));

  const policyIds = list.filter((r) => r.policy).map((r) => r._id);
  let mine = new Set();
  let counts = new Map();
  if (policyIds.length > 0) {
    const [acks, grouped] = await Promise.all([
      actor?.employeeId
        ? DocumentAcknowledgment.find({
            documentId: { $in: policyIds },
            employeeId: actor.employeeId,
          })
            .select('documentId')
            .lean()
        : Promise.resolve([]),
      DocumentAcknowledgment.aggregate([
        { $match: { documentId: { $in: policyIds } } },
        { $group: { _id: '$documentId', n: { $sum: 1 } } },
      ]),
    ]);
    mine = new Set(acks.map((a) => idStr(a.documentId)));
    counts = new Map(grouped.map((g) => [idStr(g._id), g.n]));
  }

  return list.map((row) =>
    documentToDto(row, {
      folder: folderById.get(idStr(row.folderId)),
      actor,
      acknowledged: mine.has(idStr(row._id)),
      ackCount: counts.get(idStr(row._id)) ?? 0,
    }),
  );
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function listFolders(actor) {
  const rows = await DocumentFolder.find({ deletedAt: null }).sort({ name: 1 }).lean();
  const visible = rows.filter((f) => canSeeFolder(actor, f));
  if (visible.length === 0) return [];

  const counts = await HrmsDocument.aggregate([
    { $match: { deletedAt: null, folderId: { $in: visible.map((f) => f._id) } } },
    { $group: { _id: '$folderId', n: { $sum: 1 } } },
  ]);
  const byFolder = new Map(counts.map((c) => [idStr(c._id), c.n]));

  return visible.map((f) => folderToDto(f, byFolder.get(idStr(f._id)) ?? 0));
}

export async function createFolder(input, actor, context = {}) {
  if (!isDocumentAdmin(actor)) throw new HrmsForbiddenError('Only HR can manage folders.');
  const dto = parse(createFolderSchema, input, 'folder');

  if (dto.parentId) {
    const parent = await DocumentFolder.findOne({ _id: dto.parentId, deletedAt: null }).lean();
    if (!parent) throw new HrmsValidationError('That parent folder does not exist.');
  }

  const row = await DocumentFolder.create({
    ...dto,
    createdByEmployeeId: actor?.employeeId ?? null,
  });

  const folder = folderToDto(row.toObject(), 0);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.DOCUMENT_FOLDER_CREATED,
    `Created the document folder "${folder.name}" (${folder.visibility})`,
    context.req,
    { meta: { folderId: folder.id, visibility: folder.visibility } },
  );
  return folder;
}

export async function updateFolder(id, input, actor, context = {}) {
  if (!isDocumentAdmin(actor)) throw new HrmsForbiddenError('Only HR can manage folders.');
  const dto = parse(updateFolderSchema, input, 'folder');
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Folder');

  const row = await DocumentFolder.findOne({ _id: id, deletedAt: null });
  if (!row) throw new HrmsNotFoundError('Folder');

  // A folder cannot be its own parent, nor a descendant of itself.
  if (dto.parentId !== undefined && dto.parentId !== null) {
    if (idStr(dto.parentId) === idStr(id)) {
      throw new HrmsValidationError('A folder cannot be its own parent.');
    }
    let cursor = await DocumentFolder.findById(dto.parentId).select('parentId').lean();
    const seen = new Set();
    while (cursor) {
      if (idStr(cursor._id ?? '') === idStr(id) || seen.has(idStr(cursor.parentId))) break;
      if (idStr(cursor.parentId) === idStr(id)) {
        throw new HrmsValidationError('That would put the folder inside itself.');
      }
      seen.add(idStr(cursor.parentId));
      if (!cursor.parentId) break;
      // eslint-disable-next-line no-await-in-loop
      cursor = await DocumentFolder.findById(cursor.parentId).select('parentId').lean();
    }
  }

  Object.assign(row, dto);
  await row.save();

  const folder = folderToDto(row.toObject(), 0);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.DOCUMENT_FOLDER_UPDATED,
    `Updated the document folder "${folder.name}"`,
    context.req,
    { meta: { folderId: folder.id, fields: Object.keys(dto) } },
  );
  return folder;
}

/**
 * Retire a folder.
 *
 * Refused while it still holds documents or child folders. The reference
 * deletes unconditionally, leaving every document in it pointing at a folder
 * that is gone — and therefore, by its own visibility fallthrough, org-visible.
 */
export async function deleteFolder(id, actor, context = {}) {
  if (!isDocumentAdmin(actor)) throw new HrmsForbiddenError('Only HR can manage folders.');
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Folder');

  const row = await DocumentFolder.findOne({ _id: id, deletedAt: null }).lean();
  if (!row) throw new HrmsNotFoundError('Folder');

  const [documents, children] = await Promise.all([
    HrmsDocument.countDocuments({ folderId: id, deletedAt: null }),
    DocumentFolder.countDocuments({ parentId: id, deletedAt: null }),
  ]);
  if (documents > 0 || children > 0) {
    throw new HrmsConflictError(
      `"${row.name}" still holds ${documents} document${documents === 1 ? '' : 's'} and ${children} subfolder${children === 1 ? '' : 's'}. Move or remove those first.`,
      { code: 'DOCUMENT_FOLDER_IN_USE', details: { documents, children } },
    );
  }

  await DocumentFolder.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.DOCUMENT_FOLDER_DELETED,
    `Deleted the document folder "${row.name}"`,
    context.req,
    { meta: { folderId: idStr(row._id) } },
  );
  return { id: idStr(row._id), deleted: true };
}

// ---------------------------------------------------------------------------
// Documents — read
// ---------------------------------------------------------------------------

export async function listDocuments(actor, query = {}) {
  const dto = parse(documentListQuerySchema, query, 'document filter');
  const { page, pageSize } = dto;

  const filter = { deletedAt: null, ...(await scopeFilter(actor)) };
  if (dto.scope) filter.scope = dto.scope;
  if (dto.folderId) filter.folderId = dto.folderId;
  if (dto.employeeId) {
    if (
      idStr(dto.employeeId) !== idStr(actor?.employeeId) &&
      !canReadOrg(actor)
    ) {
      throw new HrmsForbiddenError('You cannot read another employee’s documents.');
    }
    filter.employeeId = dto.employeeId;
    filter.scope = 'employee';
  }
  if (dto.policiesOnly === 'true') filter['policy.requiresAcknowledgment'] = true;
  if (dto.search) {
    const rx = new RegExp(escapeRegex(dto.search), 'i');
    filter.$and = [...(filter.$and ?? []), { $or: [{ name: rx }, { tags: rx }] }];
  }
  // An expired policy drops out of the list unless it is asked for. The
  // reference never filters on expiry at all.
  if (dto.policiesOnly === 'true' && dto.includeExpired !== 'true') {
    filter.$and = [
      ...(filter.$and ?? []),
      { $or: [{ 'policy.expiresAt': null }, { 'policy.expiresAt': { $gte: today() } }] },
    ];
  }

  const [rows, total] = await Promise.all([
    HrmsDocument.find(filter)
      .sort({ uploadedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    HrmsDocument.countDocuments(filter),
  ]);

  return { data: await hydrate(rows, actor), total, page, pageSize };
}

/**
 * Load a document this actor may read.
 *
 * The scope filter is applied to the LOOKUP rather than checked afterwards, so
 * "what may be listed" and "what may be opened" are the same set by
 * construction.
 */
async function loadReadable(id, actor) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Document');
  const row = await HrmsDocument.findOne({
    _id: id,
    deletedAt: null,
    ...(await scopeFilter(actor)),
  }).lean();
  if (!row) throw new HrmsNotFoundError('Document');
  return row;
}

export async function getDocument(id, actor) {
  const row = await loadReadable(id, actor);
  const [dto] = await hydrate([row], actor);
  return dto;
}

/** The storage key behind a document this actor may read. Never sent onward. */
export async function documentStorageKey(id, actor) {
  const row = await loadReadable(id, actor);
  return { key: row.storageKey, category: row.storageCategory, name: row.name };
}

// ---------------------------------------------------------------------------
// Documents — write
// ---------------------------------------------------------------------------

/**
 * Store an uploaded file and record it.
 *
 * @param {object} file multer's in-memory file
 */
export async function uploadDocument(file, input, actor, context = {}) {
  if (!file?.buffer?.length) throw new HrmsValidationError('Attach a file to upload.');
  const dto = parse(uploadDocumentSchema, input, 'document');

  const admin = isDocumentAdmin(actor);
  const targetEmployeeId = dto.employeeId ?? null;
  const scope = targetEmployeeId ? 'employee' : 'company';

  // An ordinary employee may upload only into their own repository, and never
  // into the shared library. The reference's rule, kept.
  if (!admin) {
    if (scope !== 'employee' || idStr(targetEmployeeId) !== idStr(actor?.employeeId)) {
      throw new HrmsForbiddenError('You can only upload documents to your own repository.');
    }
    if (dto.folderId) {
      throw new HrmsForbiddenError('You cannot upload into a shared folder.');
    }
  }

  let employee = null;
  if (scope === 'employee') {
    employee = await Employee.findOne({ _id: targetEmployeeId, deletedAt: null }).lean();
    if (!employee) throw new HrmsValidationError('That employee does not exist.');
  }

  let folder = null;
  if (dto.folderId) {
    folder = await DocumentFolder.findOne({ _id: dto.folderId, deletedAt: null }).lean();
    if (!folder) throw new HrmsValidationError('That folder does not exist.');
  }

  // The bytes decide the type, not the client. The reference trusts the
  // declared type and serves it back inline.
  const sniffed = sniffDocument(file.buffer, file.mimetype);
  if (!sniffed) {
    throw new HrmsValidationError(
      'That file type is not accepted. Upload a PDF, an image, an Office document or plain text.',
    );
  }

  const category =
    scope === 'employee'
      ? STORAGE_CATEGORIES.EMPLOYEE_DOCUMENT
      : STORAGE_CATEGORIES.COMPANY_ASSET;

  const { key } = await putObject({
    category,
    body: file.buffer,
    contentType: sniffed.type,
    // The storage layer builds the key; the original filename is never part of
    // a path. The reference names the stored file with the client's extension.
    scope: scope === 'employee' ? idStr(targetEmployeeId) : 'library',
    filename: `document.${sniffed.ext}`,
    size: file.buffer.length,
  });

  const uploader = actor?.employeeId
    ? await Employee.findById(actor.employeeId).select('firstName lastName').lean()
    : null;

  const row = await HrmsDocument.create({
    name: dto.name,
    scope,
    employeeId: targetEmployeeId,
    employeeName: employee ? fullName(employee) : '',
    folderId: dto.folderId ?? null,
    tags: dto.tags,
    storageKey: key,
    storageCategory: category,
    mimeType: sniffed.type,
    fileSize: file.buffer.length,
    originalFilename: file.originalname ?? null,
    uploadedByEmployeeId: actor?.employeeId ?? null,
    uploadedByName: uploader ? fullName(uploader) : '',
    uploadedAt: new Date(),
  });

  const [dtoOut] = await hydrate([row.toObject()], actor);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.DOCUMENT_UPLOADED,
    `Uploaded "${dto.name}" to ${scope === 'employee' ? `${fullName(employee)}'s documents` : 'the company library'}`,
    context.req,
    {
      meta: {
        documentId: dtoOut.id,
        scope,
        employeeId: idStr(targetEmployeeId),
        mimeType: sniffed.type,
        fileSize: file.buffer.length,
      },
    },
  );
  return dtoOut;
}

/** Rename, re-tag or re-file. The bytes are immutable; replace uploads anew. */
export async function updateDocument(id, input, actor, context = {}) {
  const dto = parse(updateDocumentSchema, input, 'document');

  // Readability first, so somebody with no claim on the document gets a 404
  // rather than a 403 that confirms it exists.
  await loadReadable(id, actor);
  const row = await HrmsDocument.findOne({ _id: id, deletedAt: null });
  if (!row) throw new HrmsNotFoundError('Document');

  const admin = isDocumentAdmin(actor);
  const owns =
    row.scope === 'employee' && idStr(row.employeeId) === idStr(actor?.employeeId);
  if (!admin && !owns) {
    throw new HrmsForbiddenError('You cannot edit this document.');
  }
  if (!admin && dto.folderId !== undefined) {
    throw new HrmsForbiddenError('You cannot move a document into a shared folder.');
  }
  if (dto.folderId && row.scope === 'employee') {
    throw new HrmsValidationError('A personal document does not live in a shared folder.');
  }

  if (dto.name !== undefined) row.name = dto.name;
  if (dto.tags !== undefined) row.tags = dto.tags;
  if (dto.folderId !== undefined) {
    if (dto.folderId) {
      const folder = await DocumentFolder.findOne({
        _id: dto.folderId,
        deletedAt: null,
      }).lean();
      if (!folder) throw new HrmsValidationError('That folder does not exist.');
    }
    row.folderId = dto.folderId;
  }
  await row.save();

  const [dtoOut] = await hydrate([row.toObject()], actor);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.DOCUMENT_UPDATED,
    `Updated the document "${row.name}"`,
    context.req,
    { meta: { documentId: dtoOut.id, fields: Object.keys(dto) } },
  );
  return dtoOut;
}

/**
 * Remove a document and its object.
 *
 * The reference deletes the row and leaves the file on disk forever. The row is
 * soft-deleted here so the audit trail still resolves it, and the object is
 * purged because that is the part that actually holds the data.
 */
export async function deleteDocument(id, actor, context = {}) {
  await loadReadable(id, actor);
  const row = await HrmsDocument.findOne({ _id: id, deletedAt: null });
  if (!row) throw new HrmsNotFoundError('Document');

  const admin = isDocumentAdmin(actor);
  const owns =
    row.scope === 'employee' && idStr(row.employeeId) === idStr(actor?.employeeId);
  if (!admin && !owns) throw new HrmsForbiddenError('You cannot delete this document.');

  if (row.policy) {
    const acknowledgments = await DocumentAcknowledgment.countDocuments({ documentId: id });
    if (acknowledgments > 0) {
      throw new HrmsConflictError(
        `${acknowledgments} ${acknowledgments === 1 ? 'person has' : 'people have'} acknowledged this policy; it is now a record and cannot be deleted.`,
        { code: 'DOCUMENT_POLICY_ACKNOWLEDGED', details: { acknowledgments } },
      );
    }
  }

  const { storageKey, name } = row;
  row.deletedAt = new Date();
  await row.save();

  // The object is what holds the data; losing track of it is the leak.
  try {
    await deleteObject(storageKey);
  } catch {
    // A missing object is not a reason to leave the record standing.
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.DOCUMENT_DELETED,
    `Deleted the document "${name}"`,
    context.req,
    { meta: { documentId: idStr(row._id), scope: row.scope } },
  );
  return { id: idStr(row._id), deleted: true };
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export async function publishPolicy(id, input, actor, context = {}) {
  if (!isDocumentAdmin(actor)) throw new HrmsForbiddenError('Only HR can publish policies.');
  const dto = parse(publishPolicySchema, input, 'policy');
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Document');

  const row = await HrmsDocument.findOne({ _id: id, deletedAt: null });
  if (!row) throw new HrmsNotFoundError('Document');
  if (row.policy) {
    throw new HrmsConflictError('That document is already published as a policy.', {
      code: 'DOCUMENT_ALREADY_POLICY',
    });
  }
  // A policy is a company-wide instrument; a personal document is not one.
  if (row.scope !== 'company') {
    throw new HrmsValidationError('Only a company document can be published as a policy.');
  }

  row.policy = {
    ...dto,
    publishedAt: new Date(),
    publishedByEmployeeId: actor?.employeeId ?? null,
  };
  await row.save();

  const [dtoOut] = await hydrate([row.toObject()], actor);
  await recordAudit(
    context.user,
    AUDIT_ACTIONS.DOCUMENT_POLICY_PUBLISHED,
    `Published "${row.name}" as a policy, effective ${dto.effectiveFrom}`,
    context.req,
    {
      meta: {
        documentId: dtoOut.id,
        effectiveFrom: dto.effectiveFrom,
        expiresAt: dto.expiresAt ?? null,
        targetRoleKeys: dto.targetRoleKeys,
      },
    },
  );
  /**
   * The reference's policy fan-out — one inbox item per targeted person.
   *
   * The audience is the policy's OWN `targetRoleKeys`, applied by the same rule
   * `isPolicyTarget` below uses for reads, so a notification cannot reach
   * somebody the policy list would hide the policy from. Empty targets means
   * everybody, which is that function's rule too.
   */
  await notify({
    to: await policyAudience(dto.targetRoleKeys),
    type: INBOX_TYPES.POLICY_PUBLISHED,
    title: `New policy: ${row.name}`,
    body: dto.requiresAcknowledgment
      ? 'Review and acknowledge to comply.'
      : 'A new policy has been published.',
    entity: 'document',
    entityId: dtoOut.id,
  });

  return dtoOut;
}

/**
 * Everyone a policy is addressed to, as employee ids.
 *
 * Roles live on the User account, so a role-targeted policy resolves through
 * it. No targets means every live employee — `isPolicyTarget`'s own rule.
 */
async function policyAudience(targetRoleKeys = []) {
  const live = { deletedAt: null, status: { $nin: ['exited', 'inactive'] } };

  if (!targetRoleKeys || targetRoleKeys.length === 0) {
    const everyone = await Employee.find(live).select('_id').lean();
    return everyone.map((e) => idStr(e._id));
  }

  const users = await User.find({ roles: { $in: targetRoleKeys } }).select('_id').lean();
  if (users.length === 0) return [];

  const targeted = await Employee.find({ ...live, userId: { $in: users.map((u) => u._id) } })
    .select('_id')
    .lean();
  return targeted.map((e) => idStr(e._id));
}

/** Whether this actor is among a policy's targets. Empty targets means all. */
export function isPolicyTarget(actor, policy) {
  const targets = policy?.targetRoleKeys ?? [];
  if (targets.length === 0) return true;
  const held = new Set(actor?.roleKeys ?? []);
  return targets.some((k) => held.has(k));
}

/**
 * Acknowledge a policy.
 *
 * The reference checks only that a policy exists and that this user has not
 * already acknowledged it — so anyone can acknowledge anything, including a
 * policy aimed at another role, before it takes effect and after it expires.
 */
export async function acknowledgePolicy(id, input, actor, context = {}) {
  const dto = parse(acknowledgeDocumentSchema, input, 'acknowledgment');

  const row = await loadReadable(id, actor);
  const policy = row.policy;
  if (!policy?.requiresAcknowledgment) {
    throw new HrmsValidationError('That document does not require an acknowledgment.');
  }
  if (!actor?.employeeId) {
    throw new HrmsValidationError(
      'Your user account is not linked to an employee record, so you cannot acknowledge policies.',
    );
  }
  if (!isPolicyTarget(actor, policy)) {
    throw new HrmsForbiddenError('That policy is not addressed to you.');
  }
  if (policy.effectiveFrom > today()) {
    throw new HrmsConflictError(
      `That policy does not take effect until ${policy.effectiveFrom}.`,
      { code: 'POLICY_NOT_YET_EFFECTIVE' },
    );
  }
  if (policy.expiresAt && policy.expiresAt < today()) {
    throw new HrmsConflictError('That policy has expired and can no longer be acknowledged.', {
      code: 'POLICY_EXPIRED',
    });
  }

  let signatureKey = null;
  if (policy.requiresSignature) {
    if (!dto.signatureName) {
      throw new HrmsValidationError('Type your full name to sign this policy.');
    }
    if (dto.signatureImage) {
      const base64 = dto.signatureImage.split(',')[1] ?? '';
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length > SIGNATURE_MAX_BYTES) {
        throw new HrmsValidationError('That signature image is too large.');
      }
      // Really a PNG, whatever the data URL claims.
      const sniffed = sniffDocument(bytes, 'image/png');
      if (sniffed?.type !== 'image/png') {
        throw new HrmsValidationError('That signature is not a valid image.');
      }
      // Stored as an object. The reference keeps the base64 in a JSON column
      // for every user × every policy.
      const stored = await putObject({
        category: STORAGE_CATEGORIES.EMPLOYEE_DOCUMENT,
        body: bytes,
        contentType: 'image/png',
        scope: `${idStr(actor.employeeId)}/signatures`,
        filename: 'signature.png',
        size: bytes.length,
      });
      signatureKey = stored.key;
    }
  }

  const employee = await Employee.findById(actor.employeeId)
    .select('firstName lastName')
    .lean();

  let created;
  try {
    created = await DocumentAcknowledgment.create({
      documentId: row._id,
      employeeId: actor.employeeId,
      employeeName: employee ? fullName(employee) : '',
      acknowledgedAt: new Date(),
      signatureName: dto.signatureName ?? null,
      signatureKey,
      signedFromIp: context.req?.ip ?? null,
      policySnapshot: {
        effectiveFrom: policy.effectiveFrom,
        expiresAt: policy.expiresAt ?? null,
        requiresSignature: policy.requiresSignature,
      },
    });
  } catch (error) {
    // The unique index is what makes "once each" true under two clicks.
    if (error?.code === 11000) {
      throw new HrmsConflictError('You have already acknowledged this policy.', {
        code: 'POLICY_ALREADY_ACKNOWLEDGED',
      });
    }
    throw error;
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.DOCUMENT_ACKNOWLEDGED,
    `Acknowledged the policy "${row.name}"`,
    context.req,
    {
      meta: {
        documentId: idStr(row._id),
        acknowledgmentId: idStr(created._id),
        signed: Boolean(policy.requiresSignature),
      },
    },
  );

  const [dtoOut] = await hydrate([await HrmsDocument.findById(id).lean()], actor);
  return dtoOut;
}

/**
 * Who has and has not acknowledged a policy.
 *
 * The target set is resolved from EMPLOYEES holding the target roles, so the
 * denominator is people rather than user accounts.
 */
export async function acknowledgmentStatus(id, actor) {
  if (!canReadOrg(actor)) {
    throw new HrmsForbiddenError('Only HR can see who has acknowledged a policy.');
  }
  const row = await loadReadable(id, actor);
  if (!row.policy) throw new HrmsValidationError('That document is not a policy.');

  const User = (await import('../../../models/User.js')).default;

  const targets = row.policy.targetRoleKeys ?? [];
  const userFilter = { status: 'Active' };
  if (targets.length > 0) userFilter.roles = { $in: targets };
  const users = await User.find(userFilter).select('_id').lean();

  const employees = await Employee.find({
    userId: { $in: users.map((u) => u._id) },
    deletedAt: null,
    status: { $nin: ['exited', 'inactive'] },
  })
    .select('_id firstName lastName employeeCode')
    .lean();

  const acks = await DocumentAcknowledgment.find({ documentId: row._id })
    .select('employeeId employeeName acknowledgedAt signatureName')
    .lean();
  const ackByEmployee = new Map(acks.map((a) => [idStr(a.employeeId), a]));

  const outstanding = employees
    .filter((e) => !ackByEmployee.has(idStr(e._id)))
    .map((e) => ({
      employeeId: idStr(e._id),
      name: fullName(e),
      employeeCode: e.employeeCode ?? null,
    }));

  return {
    documentId: idStr(row._id),
    total: employees.length,
    completed: employees.length - outstanding.length,
    outstanding,
    acknowledged: acks.map((a) => ({
      employeeId: idStr(a.employeeId),
      name: a.employeeName || null,
      acknowledgedAt: iso(a.acknowledgedAt),
      signatureName: a.signatureName ?? null,
    })),
  };
}

/** The policies awaiting this employee's acknowledgment. */
export async function myPendingPolicies(actor) {
  if (!actor?.employeeId) return { data: [], pending: 0 };

  const now = today();
  // The scope filter carries its own `$or`, so the expiry clause goes under
  // `$and`. Spreading both as `$or` silently drops whichever is written first —
  // which is exactly how an expired policy would come back to haunt somebody.
  const rows = await HrmsDocument.find({
    deletedAt: null,
    'policy.requiresAcknowledgment': true,
    'policy.effectiveFrom': { $lte: now },
    $and: [
      { $or: [{ 'policy.expiresAt': null }, { 'policy.expiresAt': { $gte: now } }] },
      await scopeFilter(actor),
    ],
  })
    .sort({ 'policy.effectiveFrom': -1 })
    .lean();

  const mine = rows.filter((r) => isPolicyTarget(actor, r.policy));
  const acks = await DocumentAcknowledgment.find({
    documentId: { $in: mine.map((r) => r._id) },
    employeeId: actor.employeeId,
  })
    .select('documentId')
    .lean();
  const done = new Set(acks.map((a) => idStr(a.documentId)));

  const data = await hydrate(mine, actor);
  return { data, pending: data.filter((d) => !done.has(d.id)).length };
}

// ---------------------------------------------------------------------------
// Storage access rules
// ---------------------------------------------------------------------------

/**
 * Resolve a personal-document or signature object back to its owner.
 *
 * Registered for `EMPLOYEE_DOCUMENT`, which had no rule before. Resolving by
 * KEY means the rule holds even when a URL is requested through the generic
 * file endpoint rather than through a document.
 */
export async function resolveEmployeeDocumentAccess(key) {
  const row = await HrmsDocument.findOne({ storageKey: key, deletedAt: null })
    .select('employeeId scope')
    .lean();

  // A signature image belongs to whoever signed.
  const employeeId = row
    ? row.employeeId
    : (
        await DocumentAcknowledgment.findOne({ signatureKey: key })
          .select('employeeId')
          .lean()
      )?.employeeId;

  if (!employeeId) return null;

  const employee = await Employee.findById(employeeId)
    .select('_id userId departmentId managerChain reportingManagerId deletedAt')
    .lean();
  if (!employee) return null;

  return {
    owner: {
      ownerUserId: idStr(employee.userId) ?? undefined,
      ownerEmployeeId: idStr(employee._id),
      ownerDepartmentId: idStr(employee.departmentId) ?? undefined,
      ownerManagerChain: (employee.managerChain ?? []).map(idStr),
    },
    /**
     * Self or org — deliberately no TEAM scope. A personal document is a
     * contract or an ID proof; a reporting manager has no claim on it, and the
     * reference's own comment claims they do while its code does not.
     */
    permissions: [
      { module: M.DOCUMENTS, action: A.VIEW, scope: S.ORG },
      { module: M.DOCUMENTS, action: A.VIEW, scope: S.SELF },
    ],
  };
}

/**
 * Resolve a company-library object.
 *
 * Registered for `COMPANY_ASSET`, which had no rule before. A library document
 * has no owning employee, so the requirement is absolute: whatever folder
 * visibility admits, plus HR.
 */
export async function resolveCompanyDocumentAccess(key) {
  const row = await HrmsDocument.findOne({ storageKey: key, deletedAt: null })
    .select('folderId')
    .lean();
  if (!row) return null;

  return {
    owner: null,
    permissions: [
      { module: M.DOCUMENTS, action: A.VIEW, scope: S.ORG },
      { module: M.DOCUMENTS, action: A.VIEW, scope: S.SELF },
    ],
  };
}

export default {
  listFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  listDocuments,
  getDocument,
  documentStorageKey,
  uploadDocument,
  updateDocument,
  deleteDocument,
  publishPolicy,
  acknowledgePolicy,
  acknowledgmentStatus,
  myPendingPolicies,
  resolveEmployeeDocumentAccess,
  resolveCompanyDocumentAccess,
  canSeeFolder,
  isPolicyLive,
  isPolicyTarget,
};
