/**
 * Application-level encryption for sensitive employee fields (AD-10).
 *
 * AES-256-GCM with AWS KMS envelope encryption. The driver is swappable so
 * local development needs no AWS access, mirroring the storage driver in
 * ../storage/.
 *
 * ---------------------------------------------------------------------------
 * What this replaces
 * ---------------------------------------------------------------------------
 * The DTA reference has no dedicated fields for PAN, bank account or IFSC at
 * all. `payroll/bank-file.service.ts` reads them out of the employee's
 * `customFieldValues` JSON blob - which `GET /employees/:id` returns wholesale.
 * So bank account numbers travel in a plain API response, and its own spec's
 * promise of "field-level encryption for PAN/bank details" was never built.
 *
 * AD-10 therefore does two things: it creates the fields, and it encrypts them.
 *
 * ---------------------------------------------------------------------------
 * Envelope format
 * ---------------------------------------------------------------------------
 *   { v: 1, k: <KMS-encrypted DEK, base64>, iv, tag, ct }
 *
 * The encrypted data key travels WITH each ciphertext. That is what makes key
 * rotation non-breaking: a new DEK (or a rotated CMK) does not invalidate
 * anything already written, because each record carries what it needs to be
 * decrypted.
 *
 * GCM, not CBC: it authenticates as well as encrypts, so tampering is detected
 * on decrypt rather than silently yielding rubbish.
 */

import crypto from 'node:crypto';

import { createKmsKeyProvider } from './kms.js';
import { createLocalKeyProvider } from './local.js';
import {
  normaliseSensitiveValue,
  maskSensitiveValue,
  reservedFieldFor,
} from '../../../shared/security/sensitive-fields.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const ENVELOPE_VERSION = 1;

/** The active key provider. Chosen once, lazily, from the environment. */
let provider = null;

/**
 * Select the driver.
 *
 *   HRMS_CRYPTO_DRIVER=kms    production - AWS KMS, credentials from the
 *                             instance role (AD-7: never access keys in .env,
 *                             which is committed to this repository)
 *   HRMS_CRYPTO_DRIVER=local  development - a key from the environment
 *
 * Defaults to `local` OUTSIDE production and `kms` IN production, so a
 * production deployment cannot silently fall back to a development key.
 */
export function getKeyProvider() {
  if (provider) return provider;

  const configured =
    process.env.HRMS_CRYPTO_DRIVER ||
    (process.env.NODE_ENV === 'production' ? 'kms' : 'local');

  provider = configured === 'kms' ? createKmsKeyProvider() : createLocalKeyProvider();
  return provider;
}

/** Test seam: drop the cached provider and its cached data keys. */
export function __resetCrypto() {
  provider?.clearCache?.();
  provider = null;
}

// ---------------------------------------------------------------------------
// Field encryption
// ---------------------------------------------------------------------------

/**
 * Encrypt one sensitive value.
 *
 * @param {string|null|undefined} plaintext
 * @returns {Promise<object|null>} the envelope, or null for an empty value
 */
export async function encryptField(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;

  const { plaintextKey, encryptedKey } = await getKeyProvider().getDataKey();

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, plaintextKey, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: ENVELOPE_VERSION,
    k: encryptedKey,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

/**
 * Decrypt one envelope back to plaintext.
 *
 * Throws on a tampered ciphertext - GCM's auth tag will not verify - rather
 * than returning corrupted data.
 *
 * @param {object|null} envelope
 * @returns {Promise<string|null>}
 */
export async function decryptField(envelope) {
  if (!envelope) return null;
  if (typeof envelope !== 'object' || !envelope.ct || !envelope.iv || !envelope.tag || !envelope.k) {
    throw new Error('decryptField: malformed envelope');
  }
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new Error(`decryptField: unsupported envelope version ${envelope.v}`);
  }

  const plaintextKey = await getKeyProvider().decryptDataKey(envelope.k);

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    plaintextKey,
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ct, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Is this value a stored envelope rather than plaintext? */
export const isEncryptedEnvelope = (v) =>
  Boolean(v && typeof v === 'object' && v.v === ENVELOPE_VERSION && v.ct && v.iv && v.tag && v.k);

// ---------------------------------------------------------------------------
// Blind index
// ---------------------------------------------------------------------------

/**
 * A deterministic, non-reversible index over a sensitive value.
 *
 * Encrypted fields cannot be searched: a random IV means the ciphertext differs
 * on every write, so an equality query never matches. Where uniqueness must be
 * enforceable - PAN, Aadhaar - this HMAC goes in a separate indexed field.
 *
 * The value is normalised first (uppercased, whitespace removed) so that
 * `abcde1234f` and `ABCDE 1234 F` produce the same index and the uniqueness
 * constraint actually holds.
 *
 * The index key is SEPARATE from the data-encryption path: PAN and Aadhaar are
 * low-entropy formats, so anyone holding this key could brute-force the index
 * offline. Compromising one must not hand over the other.
 */
export function blindIndex(value) {
  if (value === null || value === undefined || value === '') return null;
  const key = blindIndexKey();
  return crypto
    .createHmac('sha256', key)
    .update(normaliseSensitiveValue(value))
    .digest('hex');
}

function blindIndexKey() {
  const configured = process.env.HRMS_BLIND_INDEX_KEY;
  if (configured) return Buffer.from(configured, 'utf8');

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'HRMS_BLIND_INDEX_KEY must be set in production. Without it, blind indexes ' +
        'would be computed from a development key and uniqueness checks would be meaningless.',
    );
  }
  return Buffer.from('development-blind-index-key-not-for-production', 'utf8');
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

export { maskSensitiveValue };

/**
 * Decrypt a value for display, masked unless the caller is explicitly
 * authorised to see it in full.
 *
 * The default is masked. Revealing a full PAN or account number is a distinct,
 * auditable act - see AUDIT_ACTIONS.SENSITIVE_FIELD_VIEWED - and callers must
 * ask for it deliberately.
 *
 * @param {object|null} envelope
 * @param {object}  [options]
 * @param {boolean} [options.reveal=false]
 */
export async function readSensitiveField(envelope, { reveal = false } = {}) {
  if (!envelope) return null;
  const plain = await decryptField(envelope);
  return reveal ? plain : maskSensitiveValue(plain);
}

// ---------------------------------------------------------------------------
// customFieldValues sanitisation (AD-11)
// ---------------------------------------------------------------------------

/**
 * Strip reserved sensitive keys out of a `customFieldValues` object and return
 * them separately, so the caller can encrypt them into their proper fields.
 *
 * ---------------------------------------------------------------------------
 * THIS RUNS IN MEMORY, BEFORE THE FIRST DATABASE WRITE. Not afterwards.
 * ---------------------------------------------------------------------------
 * Writing the blob and deleting the key later would leave the plaintext in the
 * MongoDB oplog, on every replica that applied the write, in any backup taken
 * between the two steps, and in Atlas point-in-time-restore history. Deleting
 * the field afterwards removes it from the current document and from nothing
 * else. "Remove plaintext after migration" is necessary but not sufficient - it
 * must never be written at all.
 *
 * Every write path that accepts customFieldValues must call this: create,
 * update, CSV import and migration alike. Sanitising only on the migration path
 * would leave the ordinary API as an open door.
 *
 * @param {object} customFieldValues  the raw incoming blob (not mutated)
 * @returns {{ clean: object, extracted: object, warnings: string[] }}
 */
export function sanitiseCustomFields(customFieldValues = {}) {
  const clean = {};
  const extracted = {};
  const warnings = [];

  for (const [key, value] of Object.entries(customFieldValues ?? {})) {
    const reserved = reservedFieldFor(key);
    if (!reserved) {
      clean[key] = value;
      continue;
    }

    if (value === null || value === undefined || value === '') {
      warnings.push(`Dropped empty reserved custom field "${key}".`);
      continue;
    }

    if (extracted[reserved] !== undefined) {
      warnings.push(
        `Custom field "${key}" duplicates ${reserved}, which was already supplied. Ignored.`,
      );
      continue;
    }

    extracted[reserved] = String(value);
    warnings.push(
      `Moved custom field "${key}" into the encrypted ${reserved} field and removed the plaintext.`,
    );
  }

  return { clean, extracted, warnings };
}

export default {
  encryptField,
  decryptField,
  isEncryptedEnvelope,
  blindIndex,
  maskSensitiveValue,
  readSensitiveField,
  sanitiseCustomFields,
  getKeyProvider,
};
