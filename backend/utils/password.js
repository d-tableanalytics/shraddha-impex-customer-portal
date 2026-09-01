/**
 * Password hashing and verification.
 *
 * ONE implementation, used by every path that reads or writes a password:
 * login, change-password, admin reset and account creation. Before this, each
 * of those did its own thing and two of them stored plaintext.
 *
 * ---------------------------------------------------------------------------
 * Migrating away from plaintext without locking anyone out
 * ---------------------------------------------------------------------------
 * The portal historically stored passwords in plaintext - `models/User.js` and
 * `auth.controller.js` both said so, and `changePassword` wrote plaintext back
 * deliberately "to remain consistent with the current auth scheme". HRMS puts
 * salary, PAN and bank details behind the same login (AD-10, AD-14), so that
 * has to end.
 *
 * Refusing plaintext outright would lock out every existing account, so
 * `verifyPassword` still accepts a plaintext match and reports `needsRehash`.
 * The caller then re-stores the password as a bcrypt hash. Each account is
 * upgraded silently the next time its owner signs in, and no password is ever
 * written in plaintext again.
 *
 * `scripts/hrms/verify-password-hashing.js` reports how many accounts are still
 * on the legacy scheme, so the fallback can eventually be removed with evidence
 * rather than hope.
 */

import bcrypt from 'bcryptjs';

/** Cost factor. 10 is the bcryptjs default and a sane floor for a pure-JS impl. */
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS ?? 10);

/** Every bcrypt variant prefix, so a legacy hash is never mistaken for plaintext. */
const BCRYPT_PREFIX = /^\$2[aby]?\$\d{2}\$/;

/** Is this stored value a bcrypt hash rather than a plaintext password? */
export const isHashed = (stored) => typeof stored === 'string' && BCRYPT_PREFIX.test(stored);

/** Hash a plaintext password. The only way a password should ever be stored. */
export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new TypeError('hashPassword requires a non-empty string');
  }
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/**
 * Verify a candidate password against what is stored.
 *
 * @returns {Promise<{ ok: boolean, needsRehash: boolean }>}
 *   `needsRehash` is true when the stored value matched but is not a bcrypt
 *   hash - the caller must then re-store it via `hashPassword`.
 */
export async function verifyPassword(candidate, stored) {
  if (typeof candidate !== 'string' || typeof stored !== 'string' || stored.length === 0) {
    return { ok: false, needsRehash: false };
  }

  if (isHashed(stored)) {
    const ok = await bcrypt.compare(candidate, stored).catch(() => false);
    return { ok, needsRehash: false };
  }

  // Legacy plaintext. Compared with a constant-time check so this path does not
  // leak length or content through timing while it is still reachable.
  const ok = timingSafeEqualStrings(candidate, stored);
  return { ok, needsRehash: ok };
}

/**
 * Re-store a matched legacy password as a hash.
 *
 * Uses updateOne rather than doc.save() so it cannot trip unrelated validation
 * on an old document, and so it never fires the model's pre('validate') hooks
 * during a login.
 */
export async function upgradePasswordHash(Model, userId, plain) {
  const hash = await hashPassword(plain);
  await Model.updateOne({ _id: userId }, { $set: { password: hash } });
  return hash;
}

/** Length-independent string comparison. */
function timingSafeEqualStrings(a, b) {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Minimum length, kept at the existing rule so no current account is invalidated. */
export const MIN_PASSWORD_LENGTH = 5;

export function validatePasswordStrength(plain) {
  if (typeof plain !== 'string' || plain.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  return { ok: true };
}

export default {
  hashPassword,
  verifyPassword,
  upgradePasswordHash,
  isHashed,
  validatePasswordStrength,
  MIN_PASSWORD_LENGTH,
};
