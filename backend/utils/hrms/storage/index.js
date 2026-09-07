/**
 * HRMS object storage (AD-7).
 *
 * A driver interface, not direct SDK calls at each call site. That is what lets
 * local development run with no bucket, and it is the piece the DTA reference
 * left unfinished: its config declares `STORAGE_DRIVER=local|s3` and
 * `AWS_S3_BUCKET`, but every file path in that codebase writes to local disk.
 * The S3 driver was never built. This is net-new work.
 *
 * ---------------------------------------------------------------------------
 * Presigned URLs, not proxying
 * ---------------------------------------------------------------------------
 * The reference streams every file THROUGH its API. Carried to S3, that would
 * push every payslip and document byte through a process capped at 400 MB by
 * PM2. Instead the endpoint performs the permission check and returns a
 * short-lived presigned URL; bytes travel browser <-> S3 directly and never
 * touch this process.
 *
 * Object keys are random, never derived from user input, so a key cannot be
 * guessed from an employee id or a filename.
 */

import crypto from 'node:crypto';
import path from 'node:path';

import { createS3Driver } from './s3.js';
import { createLocalDriver } from './local.js';
import {
  STORAGE_PREFIXES,
  STORAGE_CATEGORY_LIST,
  PRESIGNED_URL_TTL,
  MAX_UPLOAD_BYTES,
} from '../../../shared/constants/hrms.js';

let driver = null;

/**
 * Select the driver.
 *
 * Defaults to `local` outside production and `s3` in production, so a
 * production deployment cannot silently fall back to writing on the instance's
 * own disk - which has no backup and disappears with the box.
 */
export function getStorageDriver() {
  if (driver) return driver;
  const configured =
    process.env.STORAGE_DRIVER || (process.env.NODE_ENV === 'production' ? 's3' : 'local');
  driver = configured === 's3' ? createS3Driver() : createLocalDriver();
  return driver;
}

/** Test seam. */
export function __resetStorage() {
  driver = null;
}

/**
 * Build an object key for a category.
 *
 * `<prefix>/<scope>/<uuid><ext>` - the uuid is what makes the key
 * unguessable. The original filename is NOT used: it is attacker-controlled,
 * may contain path separators, and often carries the person's name.
 */
export function buildStorageKey(category, { scope = 'general', filename = '' } = {}) {
  const prefix = STORAGE_PREFIXES[category];
  if (!prefix) {
    throw new Error(`buildStorageKey: unknown storage category "${category}"`);
  }
  const ext = path.extname(String(filename)).toLowerCase().slice(0, 10);
  const safeExt = /^\.[a-z0-9]+$/.test(ext) ? ext : '';
  const safeScope = String(scope).replace(/[^a-zA-Z0-9_-]/g, '') || 'general';
  return `${prefix}/${safeScope}/${crypto.randomUUID()}${safeExt}`;
}

/** The upload ceiling for a category, in bytes. */
export const maxUploadBytesFor = (category) =>
  MAX_UPLOAD_BYTES[category] ?? MAX_UPLOAD_BYTES.DEFAULT;

/** The presigned-URL lifetime for a category, in seconds. */
export function ttlFor(category) {
  if (category === 'attendance-selfie') return PRESIGNED_URL_TTL.SELFIE;
  if (category === 'bank-file') return PRESIGNED_URL_TTL.BANK_FILE;
  return PRESIGNED_URL_TTL.DEFAULT;
}

/**
 * Store an object.
 *
 * @param {object} params
 * @param {string} params.category    one of STORAGE_CATEGORIES
 * @param {Buffer|import('stream').Readable} params.body
 * @param {string} params.contentType
 * @param {string} [params.scope]     grouping segment, e.g. an employee id
 * @param {string} [params.filename]  used only for its extension
 * @param {number} [params.size]      checked against the category ceiling
 */
export async function putObject({ category, body, contentType, scope, filename, size }) {
  if (!STORAGE_CATEGORY_LIST.includes(category)) {
    throw new Error(`putObject: unknown storage category "${category}"`);
  }

  const limit = maxUploadBytesFor(category);
  if (typeof size === 'number' && size > limit) {
    const err = new Error(
      `File is too large for ${category}: ${size} bytes exceeds the ${limit}-byte limit.`,
    );
    err.statusCode = 413;
    throw err;
  }

  const key = buildStorageKey(category, { scope, filename });
  await getStorageDriver().put(key, body, { contentType });
  return { key, category, contentType, size: size ?? null };
}

/**
 * A short-lived URL for reading an object.
 *
 * The CALLER is responsible for authorising this and for writing the audit
 * entry - this layer has no request context. See modules/hrms/storage/.
 */
export async function getReadUrl(key, { category, ttlSeconds } = {}) {
  const ttl = ttlSeconds ?? ttlFor(category);
  return getStorageDriver().getSignedUrl(key, ttl);
}

export const getObjectStream = (key) => getStorageDriver().getStream(key);
export const deleteObject = (key) => getStorageDriver().delete(key);
export const objectExists = (key) => getStorageDriver().exists(key);

/**
 * Delete many objects, reporting per-key outcome.
 *
 * Used by the retention sweep, which must tolerate individual failures: an
 * object that cannot be deleted becomes an orphan for the S3 lifecycle rule to
 * reap, and must not abort the rest of the run.
 */
export async function deleteObjects(keys = []) {
  const results = { deleted: [], failed: [] };
  for (const key of keys) {
    try {
      await deleteObject(key);
      results.deleted.push(key);
    } catch (err) {
      results.failed.push({ key, error: err.message });
    }
  }
  return results;
}

export default {
  putObject,
  getReadUrl,
  getObjectStream,
  deleteObject,
  deleteObjects,
  objectExists,
  buildStorageKey,
  maxUploadBytesFor,
  ttlFor,
  getStorageDriver,
};
