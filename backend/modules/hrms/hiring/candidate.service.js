/**
 * Candidates, and their résumés.
 *
 * Ported from the reference's `candidate.service.ts`.
 *
 * ---------------------------------------------------------------------------
 * 🔴 Résumés go through the storage abstraction, not through the API
 * ---------------------------------------------------------------------------
 * The reference writes the file to the instance's local disk and then streams
 * the bytes back through its own process on every download. AD-7 rules both
 * out: the file belongs in object storage, and the read is a short-lived
 * presigned URL so the bytes travel browser ↔ S3 and never occupy a process
 * capped at 400 MB.
 *
 * The key is unguessable and never derived from the candidate's name — a
 * résumé carries someone's address, employment history and phone number, and a
 * filename-addressable store is the same defect AD-15 found in the attendance
 * selfie endpoint.
 *
 * The declared MIME type is checked against the file's own magic bytes. A
 * `Content-Type` header is written by the uploader; a résumé inbox that trusts
 * it is a delivery mechanism.
 */

import mongoose from 'mongoose';

import { Candidate, Application } from '../../../models/hrms/HiringModels.js';
import { recordAudit } from '../../../utils/auditLog.js';
import {
  AUDIT_ACTIONS,
  PAGE_SIZE_DEFAULT,
  STORAGE_CATEGORIES,
} from '../../../shared/constants/hrms.js';
import { RESUME_MIME_TYPES, RESUME_MAGIC_BYTES } from '../../../shared/constants/hiring.js';
import { putObject, maxUploadBytesFor } from '../../../utils/hrms/storage/index.js';
import { issueReadUrl } from '../storage/storage.service.js';
import { toDecimalString, fromDecimal } from '../../../shared/payroll/money.js';
import {
  HrmsNotFoundError,
  HrmsConflictError,
  HrmsValidationError,
} from '../hrms.errors.js';

const CATEGORY = STORAGE_CATEGORIES.CANDIDATE_RESUME;
const idStr = (v) => (v === null || v === undefined ? null : String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const toDto = (row, extras = {}) => ({
  id: idStr(row._id),
  name: row.name,
  email: row.email,
  phone: row.phone ?? null,
  /**
   * `hasResume`, never the key.
   *
   * The browser asks for a presigned URL when it actually needs to open one, so
   * a storage key never leaves the server and a listing does not mint access to
   * every résumé on the page.
   */
  hasResume: Boolean(row.resumeKey),
  resumeFilename: row.resumeFilename ?? null,
  source: row.source ?? null,
  currentEmployer: row.currentEmployer ?? null,
  expectedSalary:
    row.expectedSalary === null || row.expectedSalary === undefined
      ? null
      : fromDecimal(row.expectedSalary),
  noticePeriodDays: row.noticePeriodDays ?? null,
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  applicationCount: extras.applicationCount ?? 0,
});

/** Application counts for a page of candidates, in one aggregate. */
async function withCounts(rows) {
  if (rows.length === 0) return [];
  const counts = await Application.aggregate([
    { $match: { candidateId: { $in: rows.map((r) => r._id) } } },
    { $group: { _id: '$candidateId', n: { $sum: 1 } } },
  ]);
  const byId = new Map(counts.map((c) => [idStr(c._id), c.n]));
  return rows.map((r) => toDto(r, { applicationCount: byId.get(idStr(r._id)) ?? 0 }));
}

export async function listCandidates(query = {}) {
  const { page = 1, pageSize = PAGE_SIZE_DEFAULT, search, source } = query;

  const filter = {
    deletedAt: null,
    ...(source ? { source } : {}),
    // A recruiter searches by name or email; anchored to the start so the
    // index is usable and a stray substring does not scan the collection.
    ...(search
      ? {
          $or: [
            { name: { $regex: `^${escapeRegex(search)}`, $options: 'i' } },
            { email: { $regex: `^${escapeRegex(search)}`, $options: 'i' } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    Candidate.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Candidate.countDocuments(filter),
  ]);

  return { data: await withCounts(rows), total, page, pageSize };
}

/** A user-supplied search term is data, not a pattern. */
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function getCandidate(id) {
  const row = await loadCandidate(id);
  return (await withCounts([row]))[0];
}

export async function createCandidate(input, context = {}) {
  try {
    const row = await Candidate.create({
      ...input,
      expectedSalary:
        input.expectedSalary === null || input.expectedSalary === undefined
          ? null
          : mongoose.Types.Decimal128.fromString(toDecimalString(input.expectedSalary)),
      createdByUserId: context.user?._id ?? null,
    });

    await recordAudit(
      context.user,
      AUDIT_ACTIONS.CANDIDATE_CREATED,
      `Added the candidate ${row.name}`,
      context.req,
      { meta: { candidateId: idStr(row._id), source: row.source } },
    );

    return toDto(row.toObject(), { applicationCount: 0 });
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError(
        `A candidate with the email ${input.email} already exists.`,
        { code: 'CANDIDATE_EMAIL_TAKEN' },
      );
    }
    throw error;
  }
}

export async function updateCandidate(id, input, context = {}) {
  await loadCandidate(id);

  const $set = { ...input };
  if (input.expectedSalary !== undefined) {
    $set.expectedSalary =
      input.expectedSalary === null
        ? null
        : mongoose.Types.Decimal128.fromString(toDecimalString(input.expectedSalary));
  }

  try {
    await Candidate.updateOne({ _id: id }, { $set });
  } catch (error) {
    if (error?.code === 11000) {
      throw new HrmsConflictError('Another candidate already uses that email.', {
        code: 'CANDIDATE_EMAIL_TAKEN',
      });
    }
    throw error;
  }

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.CANDIDATE_UPDATED,
    `Updated the candidate record for ${input.name ?? id}`,
    context.req,
    { meta: { candidateId: idStr(id), changed: Object.keys(input) } },
  );

  return getCandidate(id);
}

// ---------------------------------------------------------------------------
// Résumé
// ---------------------------------------------------------------------------

/**
 * Does the buffer actually start like the type it claims to be?
 *
 * The only statement about an uploaded file that its sender cannot author.
 */
export function looksLikeResume(buffer, mimeType) {
  const signatures = RESUME_MAGIC_BYTES[mimeType];
  if (!signatures || !Buffer.isBuffer(buffer)) return false;
  return signatures.some((sig) => sig.every((byte, i) => buffer[i] === byte));
}

export async function uploadResume(id, { buffer, mimeType, filename }, context = {}) {
  const candidate = await loadCandidate(id);

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HrmsValidationError('No file was uploaded.');
  }

  const declared = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
  if (!RESUME_MIME_TYPES.includes(declared)) {
    throw new HrmsValidationError('Résumés must be a PDF, DOC or DOCX file.');
  }

  const limit = maxUploadBytesFor(CATEGORY);
  if (buffer.length > limit) {
    throw new HrmsValidationError(
      `That file is larger than ${Math.round(limit / 1024 / 1024)} MB.`,
    );
  }

  if (!looksLikeResume(buffer, declared)) {
    throw new HrmsValidationError('That file is not a valid PDF, DOC or DOCX document.');
  }

  // The key carries the candidate id as its scope segment and a random uuid as
  // its name — never the original filename, which is attacker-controlled and
  // usually contains the person's own name.
  const { key } = await putObject({
    category: CATEGORY,
    body: buffer,
    contentType: declared,
    scope: idStr(candidate._id),
    filename: safeFilename(filename),
    size: buffer.length,
  });

  await Candidate.updateOne(
    { _id: id },
    {
      $set: {
        resumeKey: key,
        resumeFilename: safeFilename(filename),
        resumeContentType: declared,
      },
    },
  );

  await recordAudit(
    context.user,
    AUDIT_ACTIONS.RESUME_UPLOADED,
    `Uploaded a résumé for ${candidate.name}`,
    context.req,
    { meta: { candidateId: idStr(id), contentType: declared, bytes: buffer.length } },
  );

  return { candidateId: idStr(id), hasResume: true, resumeFilename: safeFilename(filename) };
}

/** Keep the extension for display; drop anything that could be a path. */
function safeFilename(name) {
  const base = String(name ?? 'resume').split(/[\\/]/).pop();
  return base.replace(/[^A-Za-z0-9._ -]/g, '').slice(0, 200) || 'resume';
}

/**
 * A short-lived presigned URL for a candidate's résumé.
 *
 * Authorisation, the audit entry and the TTL all live in the storage service —
 * re-implementing any of them here would give the codebase two answers to "who
 * may read this document".
 */
export async function issueResumeUrl(id, actor, req) {
  const candidate = await loadCandidate(id);
  if (!candidate.resumeKey) throw new HrmsNotFoundError('Résumé');
  return issueReadUrl({ category: CATEGORY, key: candidate.resumeKey, actor, req });
}

/**
 * Who a résumé belongs to, for the storage layer's access rule.
 *
 * A candidate is NOT an employee, so there is no owner context to evaluate a
 * self or team scope against: the permission spec returned alongside is
 * `hiring:view:org`, which is an absolute grant. Returning `owner: undefined`
 * is correct rather than lazy — a scope check against a non-employee would be
 * meaningless.
 */
export async function resolveResumeAccess(key) {
  const candidate = await Candidate.findOne({ resumeKey: key }).select('_id name').lean();
  if (!candidate) return null;
  return {
    owner: undefined,
    permissions: [{ module: 'hiring', action: 'view', scope: 'org' }],
    meta: { candidateId: idStr(candidate._id) },
  };
}

async function loadCandidate(id) {
  if (!mongoose.isValidObjectId(id)) throw new HrmsNotFoundError('Candidate');
  const row = await Candidate.findOne({ _id: id, deletedAt: null }).lean();
  if (!row) throw new HrmsNotFoundError('Candidate');
  return row;
}

/**
 * Find or create a candidate by email.
 *
 * The public apply flow's entry point. An UPSERT rather than a read-then-write:
 * two applications submitted at once from the same address would otherwise race
 * and one would fail on the unique index. `$setOnInsert` means a returning
 * applicant's existing record is never overwritten by whatever they typed this
 * time — a recruiter's notes and corrections survive.
 */
export async function upsertCandidateByEmail(input) {
  const email = String(input.email).toLowerCase().trim();
  await Candidate.updateOne(
    { email, deletedAt: null },
    {
      $setOnInsert: {
        email,
        name: input.name,
        phone: input.phone ?? null,
        source: 'careers',
        currentEmployer: input.currentEmployer ?? null,
        expectedSalary:
          input.expectedSalary === null || input.expectedSalary === undefined
            ? null
            : mongoose.Types.Decimal128.fromString(toDecimalString(input.expectedSalary)),
        noticePeriodDays: input.noticePeriodDays ?? null,
      },
    },
    { upsert: true },
  );
  return Candidate.findOne({ email, deletedAt: null }).lean();
}

export { toDto as candidateDto, loadCandidate, oid };

export default {
  listCandidates,
  getCandidate,
  createCandidate,
  updateCandidate,
  uploadResume,
  issueResumeUrl,
  resolveResumeAccess,
  upsertCandidateByEmail,
  looksLikeResume,
};
