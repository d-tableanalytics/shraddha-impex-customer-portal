/**
 * Development key provider (AD-10).
 *
 * Same interface as ./kms.js, so every code path above it is identical and no
 * `if (isDev)` branch leaks into the encryption logic. Local development needs
 * no AWS account, and the production path stays the one that is actually
 * exercised in production.
 *
 * The "envelope" here is a fixed key with the wrapped form being a constant
 * label. That is deliberately NOT secure and must never run in production - the
 * provider selector in ./index.js defaults to `kms` when NODE_ENV=production,
 * and the guard below refuses to construct this driver there regardless.
 */

import crypto from 'node:crypto';

const LOCAL_WRAPPED_KEY = 'local-dev-key-v1';

export function createLocalKeyProvider() {
  if (process.env.NODE_ENV === 'production' && process.env.HRMS_CRYPTO_DRIVER !== 'local') {
    throw new Error(
      'Refusing to use the local crypto driver in production. ' +
        'Set HRMS_CRYPTO_DRIVER=kms and HRMS_KMS_KEY_ID.',
    );
  }

  // Derived from a passphrase so a developer's data survives a restart, and so
  // two developers sharing a seed database can read each other's rows.
  const passphrase =
    process.env.HRMS_LOCAL_ENCRYPTION_KEY || 'shraddha-hrms-local-development-key';
  const plaintextKey = crypto.createHash('sha256').update(passphrase).digest();

  return {
    name: 'local',

    async getDataKey() {
      return { plaintextKey, encryptedKey: LOCAL_WRAPPED_KEY };
    },

    async decryptDataKey(encryptedKey) {
      if (encryptedKey !== LOCAL_WRAPPED_KEY) {
        throw new Error(
          'This value was encrypted with a different key provider (probably KMS). ' +
            'The local driver cannot decrypt it.',
        );
      }
      return plaintextKey;
    },

    clearCache() {
      /* nothing cached */
    },
  };
}
