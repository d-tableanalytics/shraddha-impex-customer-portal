/**
 * Mongoose plugin: encrypted-at-rest sensitive fields with masked serialization.
 *
 * Applying this to a schema:
 *   - stores each named field as an AES-256-GCM envelope, never plaintext
 *   - adds a blind-index path for fields whose uniqueness must be enforceable
 *   - makes toJSON / toObject emit a MASK by default
 *
 * ---------------------------------------------------------------------------
 * Masking is the default, and that is the whole point
 * ---------------------------------------------------------------------------
 * The failure being designed out is precise. In the DTA reference, bank details
 * live in `Employee.customFieldValues` and `GET /employees/:id` returns the
 * document - so account numbers appear in an ordinary API response. Adding
 * dedicated fields without changing serialization would reproduce that exactly.
 *
 * So the document's default JSON form carries `••••1234`, and a full value is
 * only ever produced by an explicit `readSensitive()` call, which the caller
 * must gate on `employees:compensation:view:org` and audit.
 *
 * Usage:
 *   schema.plugin(sensitiveFields, { fields: ['panNumber', 'bankAccountNumber'] })
 *   await doc.setSensitive('panNumber', 'ABCDE1234F')
 *   await doc.readSensitive('panNumber')              // '••••234F'
 *   await doc.readSensitive('panNumber', { reveal: true })  // 'ABCDE1234F'
 */

import mongoose from 'mongoose';

import {
  encryptField,
  decryptField,
  blindIndex,
  maskSensitiveValue,
} from '../../../utils/hrms/crypto/index.js';
import {
  SENSITIVE_EMPLOYEE_FIELD_LIST,
  BLIND_INDEXED_FIELDS,
} from '../../../shared/security/sensitive-fields.js';

/** Suffix for the stored envelope path, e.g. `panNumber` -> `panNumberEnc`. */
export const encPath = (field) => `${field}Enc`;
/** Suffix for the blind-index path, e.g. `panNumber` -> `panNumberIdx`. */
export const idxPath = (field) => `${field}Idx`;

export function sensitiveFields(schema, options = {}) {
  const fields = options.fields ?? SENSITIVE_EMPLOYEE_FIELD_LIST;
  const indexed = options.blindIndexed ?? BLIND_INDEXED_FIELDS;

  for (const field of fields) {
    // The ciphertext envelope. `select: false` keeps it out of every query that
    // does not explicitly ask, so an ordinary find() cannot even load it.
    schema.add({
      [encPath(field)]: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
        select: false,
      },
    });

    if (indexed.includes(field)) {
      schema.add({
        [idxPath(field)]: {
          type: String,
          default: null,
          select: false,
          // Sparse: most documents have no value, and null must not collide.
          index: { unique: true, sparse: true },
        },
      });
    }
  }

  /**
   * Encrypt and store a value, updating its blind index.
   * Passing null clears both.
   */
  schema.methods.setSensitive = async function setSensitive(field, plaintext) {
    if (!fields.includes(field)) {
      throw new Error(`setSensitive: "${field}" is not a declared sensitive field`);
    }
    this.set(encPath(field), await encryptField(plaintext));
    if (indexed.includes(field)) {
      this.set(idxPath(field), blindIndex(plaintext));
    }
    return this;
  };

  /**
   * Read a value back. MASKED unless `reveal` is passed explicitly.
   *
   * The caller is responsible for authorising a reveal and writing the
   * AUDIT_ACTIONS.SENSITIVE_FIELD_VIEWED entry - this layer has no request
   * context and cannot make that decision.
   */
  schema.methods.readSensitive = async function readSensitive(field, { reveal = false } = {}) {
    const envelope = this.get(encPath(field));
    if (!envelope) return null;
    const plain = await decryptField(envelope);
    return reveal ? plain : maskSensitiveValue(plain);
  };

  /** Is a value stored for this field? Answers without decrypting. */
  schema.methods.hasSensitive = function hasSensitive(field) {
    return Boolean(this.get(encPath(field)));
  };

  /**
   * Find by an exact sensitive value, via the blind index.
   *
   * This is the ONLY way to look one up: the ciphertext differs on every write,
   * so an equality query against the envelope can never match.
   */
  schema.statics.findBySensitive = function findBySensitive(field, value) {
    if (!indexed.includes(field)) {
      throw new Error(`findBySensitive: "${field}" has no blind index, so it cannot be searched`);
    }
    return this.findOne({ [idxPath(field)]: blindIndex(value) });
  };

  /**
   * Serialization.
   *
   * The envelope paths are removed outright, and each field is replaced by a
   * mask derived from the ciphertext's LENGTH - so the response shows that a
   * value exists, and roughly how long it is, without decrypting anything.
   * Producing a real mask would mean decrypting on every list request, and the
   * exact character count of a PAN is not worth that.
   */
  const transform = (doc, ret) => {
    for (const field of fields) {
      const envelope = ret[encPath(field)];
      delete ret[encPath(field)];
      delete ret[idxPath(field)];
      // `true` when set, `null` when not: enough for a UI to show "on file" and
      // offer a reveal action, and nothing more.
      ret[field] = envelope ? true : null;
    }
    return ret;
  };

  schema.set('toJSON', { ...(schema.get('toJSON') ?? {}), transform });
  schema.set('toObject', { ...(schema.get('toObject') ?? {}), transform });

  /**
   * Guard against a plaintext write.
   *
   * `doc.panNumber = 'ABCDE1234F'` is the obvious mistake - it looks like it
   * should work. There is no such schema path, so Mongoose would silently drop
   * it in strict mode and the value would appear to save while vanishing. This
   * makes it loud.
   */
  schema.pre('validate', function rejectPlaintextSensitiveWrites(next) {
    for (const field of fields) {
      const direct = this.get(field, null, { getters: false });
      if (direct !== undefined && direct !== null && typeof direct === 'string') {
        return next(
          new Error(
            `Refusing to store "${field}" as plaintext. Use doc.setSensitive('${field}', value).`,
          ),
        );
      }
    }
    return next();
  });
}

export default sensitiveFields;
