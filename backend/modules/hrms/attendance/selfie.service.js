/**
 * Attendance selfie upload and authorised read.
 *
 * ---------------------------------------------------------------------------
 * What this replaces (AD-15, defect 1)
 * ---------------------------------------------------------------------------
 * The reference writes selfies to local disk under a random filename and serves
 * them from:
 *
 *     @Get('selfie/:filename')
 *     @Public()
 *
 * An UNAUTHENTICATED endpoint returning photographs of employees. The filename
 * is a v4 UUID so it is not trivially guessable, but the moment one URL leaks —
 * a screenshot, a browser history, a proxy log, a shared link — it is readable
 * by anyone on the internet, forever, with no record that it happened.
 *
 * Nothing here is public. An upload is authenticated and its bytes are checked;
 * a read goes through the storage service, which resolves the owner, evaluates
 * the caller's scope against that owner, writes an audit entry, and returns a
 * 60-second presigned URL.
 */

import mongoose from 'mongoose';

import AttendanceRecord from '../../../models/hrms/AttendanceRecord.js';
import {
  putObject,
  maxUploadBytesFor,
  buildStorageKey,
} from '../../../utils/hrms/storage/index.js';
import {
  registerFileAccessRule,
  issueReadUrl,
} from '../storage/storage.service.js';
import {
  STORAGE_CATEGORIES,
  STORAGE_PREFIXES,
  AUDIT_ACTIONS,
} from '../../../shared/constants/hrms.js';
import {
  SELFIE_MIME_TYPES,
  SELFIE_MAGIC_BYTES,
} from '../../../shared/constants/attendance.js';
import {
  HrmsValidationError,
  HrmsNotFoundError,
  HrmsForbiddenError,
} from '../hrms.errors.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../../../shared/permissions/constants.js';

const CATEGORY = STORAGE_CATEGORIES.ATTENDANCE_SELFIE;
const PREFIX = STORAGE_PREFIXES[CATEGORY];

const idStr = (v) => (v === null || v === undefined ? null : String(v));

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Does the buffer actually start like the type it claims to be?
 *
 * The reference trusts `part.mimetype`, which is a header the client writes.
 * `Content-Type: image/jpeg` on an HTML file is a stored-XSS delivery
 * mechanism the moment anything serves it back with that type. Checking the
 * bytes is the only statement about the file that the uploader cannot author.
 */
export function looksLikeImage(buffer, mimeType) {
  const signatures = SELFIE_MAGIC_BYTES[mimeType];
  if (!signatures || !Buffer.isBuffer(buffer)) return false;

  const matches = signatures.some((sig) =>
    sig.every((byte, i) => buffer[i] === byte),
  );
  if (!matches) return false;

  // RIFF is also the container for WAV and AVI, so the format tag at offset 8
  // is what actually distinguishes a WebP image.
  if (mimeType === 'image/webp') {
    return buffer.length > 12 && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return true;
}

/**
 * Store a selfie for the punching employee.
 *
 * The key is `hrms/attendance/selfies/<employeeId>/<uuid>.<ext>`. The employee
 * id in the path is not decoration: it is what lets the punch verify, without a
 * database read, that the key handed back to it was minted for the caller and
 * not for somebody else.
 *
 * @param {object} params
 * @param {string} params.employeeId  the AUTHENTICATED actor's employee id
 * @param {Buffer} params.buffer
 * @param {string} params.mimeType
 * @returns {Promise<{ key: string, size: number, contentType: string }>}
 */
export async function storeSelfie({ employeeId, buffer, mimeType }) {
  if (!employeeId) {
    throw new HrmsForbiddenError('Only an employee may upload an attendance selfie.');
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HrmsValidationError('No image was uploaded.');
  }

  const declared = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
  if (!SELFIE_MIME_TYPES.includes(declared)) {
    throw new HrmsValidationError(
      `Selfies must be one of: ${SELFIE_MIME_TYPES.join(', ')}.`,
    );
  }

  // Size is checked here as well as by multer's own limit: multer guards the
  // route, this guards the function, and a future caller that is not a route
  // must not be able to bypass the ceiling.
  const limit = maxUploadBytesFor(CATEGORY);
  if (buffer.length > limit) {
    throw new HrmsValidationError(
      `The selfie is larger than ${Math.round(limit / 1024)} KB.`,
    );
  }

  if (!looksLikeImage(buffer, declared)) {
    throw new HrmsValidationError(
      'That file is not a valid JPEG, PNG or WebP image.',
    );
  }

  const extension =
    declared === 'image/png' ? '.png' : declared === 'image/webp' ? '.webp' : '.jpg';

  const { key } = await putObject({
    category: CATEGORY,
    body: buffer,
    contentType: declared,
    scope: String(employeeId),
    filename: `selfie${extension}`,
    size: buffer.length,
  });

  return { key, size: buffer.length, contentType: declared };
}

/**
 * Is this key one that was minted for this employee?
 *
 * Called by the punch before it stores a client-supplied key. Without it, an
 * employee could pass the key of a colleague's selfie — the shape schema alone
 * would accept it — and attach someone else's photograph to their own punch.
 *
 * A prefix comparison rather than a storage read: the employee id is baked into
 * the key at upload time, so the answer needs no I/O and cannot be raced.
 */
export function selfieKeyBelongsTo(key, employeeId) {
  if (!key || !employeeId) return false;
  return String(key).startsWith(`${PREFIX}/${String(employeeId)}/`);
}

/** The key for one punch of a record, or null. */
export const selfieKeyForPunch = (record, punch) =>
  (punch === 'in' ? record?.clockInCapture?.selfieKey : record?.clockOutCapture?.selfieKey) ?? null;

// ---------------------------------------------------------------------------
// Authorised read
// ---------------------------------------------------------------------------

/**
 * Who owns the employee behind an attendance selfie key, as a ResourceContext.
 *
 * Populated from the Employee document rather than from the key's own path
 * segment: the path is a convenience for the upload check above, and trusting
 * it here would mean a key's own text decided who may read it.
 *
 * Returns null for a key no record references, which the storage service turns
 * into a 404 — an orphan upload (someone photographed themselves and then
 * abandoned the punch) is not readable by anyone.
 */
async function resolveSelfieOwner(key) {
  const record = await AttendanceRecord.findOne({
    $or: [{ 'clockInCapture.selfieKey': key }, { 'clockOutCapture.selfieKey': key }],
  })
    .select('employeeId')
    .lean();

  if (!record) return null;

  // Imported lazily so this module does not depend on the Employee model at
  // load time, which keeps the storage rule registerable in isolation.
  const Employee = (await import('../../../models/hrms/Employee.js')).default;
  const employee = await Employee.findById(record.employeeId)
    .select('_id userId departmentId managerChain deletedAt')
    .lean();

  // A soft-deleted employee's photographs stay readable by HR — the punches
  // are still payroll evidence — but the owner context is what the scope check
  // needs either way, so it is returned regardless of deletedAt.
  if (!employee) return null;

  return {
    ownerUserId: idStr(employee.userId) ?? undefined,
    ownerEmployeeId: idStr(employee._id),
    ownerDepartmentId: idStr(employee.departmentId) ?? undefined,
    ownerManagerChain: (employee.managerChain ?? []).map(idStr),
  };
}

/**
 * The ANY-OF specs that may read an attendance selfie.
 *
 * Exactly AD-15's list: the subject themselves, their manager through the
 * chain, or anyone with company-wide attendance view. Note what is absent —
 * `employees:view`. Being able to read a colleague's profile is not being able
 * to look at photographs of them arriving at work.
 */
export const SELFIE_READ_PERMISSIONS = Object.freeze([
  { module: M.ATTENDANCE, action: A.VIEW, scope: S.ORG },
  { module: M.ATTENDANCE, action: A.VIEW, scope: S.TEAM },
  { module: M.ATTENDANCE, action: A.VIEW, scope: S.SELF },
]);

/**
 * Register the category with the storage service.
 *
 * Until this runs, `GET /hrms/files/url?category=attendance-selfie` is REFUSED
 * — the storage service fails closed for an unregistered category. Registering
 * here means the generic file endpoint and the attendance-specific one below
 * share one authorization implementation rather than two that can drift.
 */
export function registerSelfieAccessRule() {
  registerFileAccessRule(CATEGORY, {
    resolve: async (key) => {
      const owner = await resolveSelfieOwner(key);
      if (!owner) return null;
      return { owner, permissions: SELFIE_READ_PERMISSIONS };
    },
    // Not FILE_URL_ISSUED: AD-15 requires a photograph read to be
    // distinguishable from an ordinary document read in the audit trail.
    auditAction: AUDIT_ACTIONS.SELFIE_VIEWED,
  });
}

/**
 * A short-lived URL for one punch's selfie on one record.
 *
 * The route the UI uses. It takes a record id and a punch rather than a raw
 * key, so the browser never handles or has to guard a storage key at all, and
 * so a caller cannot ask about a key that no record references.
 *
 * @param {object} params
 * @param {string} params.recordId
 * @param {'in'|'out'} params.punch
 * @param {object} params.actor  the HRMS actor
 * @param {object} params.req
 */
export async function issueSelfieUrl({ recordId, punch, actor, req }) {
  if (!mongoose.isValidObjectId(recordId)) throw new HrmsNotFoundError('Attendance record');

  const record = await AttendanceRecord.findById(recordId)
    .select('clockInCapture.selfieKey clockOutCapture.selfieKey')
    .lean();
  if (!record) throw new HrmsNotFoundError('Attendance record');

  const key = selfieKeyForPunch(record, punch);
  if (!key) throw new HrmsNotFoundError('Selfie');

  // Authorisation, the audit entry and the TTL all live in the storage
  // service. Re-implementing any of them here would give the codebase two
  // answers to "who may see this photograph".
  return issueReadUrl({ category: CATEGORY, key, actor, req });
}

export default {
  storeSelfie,
  selfieKeyBelongsTo,
  selfieKeyForPunch,
  issueSelfieUrl,
  registerSelfieAccessRule,
  looksLikeImage,
  SELFIE_READ_PERMISSIONS,
};
