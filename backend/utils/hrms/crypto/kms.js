/**
 * AWS KMS envelope-encryption key provider (AD-10).
 *
 * Credentials come from the EC2 instance role, never from environment
 * variables. That matters more than usual here: `backend/.env` is committed to
 * this repository, so anything placed in it is in version control.
 *
 * The instance role needs `kms:GenerateDataKey` and `kms:Decrypt` on the CMK.
 */

import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';

/**
 * How long a plaintext data key stays in memory.
 *
 * Without caching, a 200-employee payroll run would make thousands of KMS
 * calls; with it, that run costs ONE. Fifteen minutes bounds how long a key
 * sits in process memory while keeping the call count negligible.
 */
const DEK_TTL_MS = Number(process.env.HRMS_DEK_TTL_MS ?? 15 * 60 * 1000);

export function createKmsKeyProvider() {
  const region = process.env.AWS_REGION || 'ap-south-1';
  const keyId = process.env.HRMS_KMS_KEY_ID;

  if (!keyId) {
    throw new Error(
      'HRMS_KMS_KEY_ID is required when HRMS_CRYPTO_DRIVER=kms. ' +
        'It is the customer-managed CMK that wraps every employee data key.',
    );
  }

  // No `credentials` block: the SDK resolves the instance role itself.
  const client = new KMSClient({ region });

  /** The current data key for ENCRYPTION, refreshed on expiry. */
  let current = null;
  /** Decrypted data keys for READS, keyed by their encrypted form. */
  const decryptCache = new Map();

  const expired = (entry) => !entry || Date.now() > entry.expiresAt;

  return {
    name: 'kms',

    /**
     * A data key for encrypting. Generates a new one when the cached key has
     * expired, so key material is rotated periodically without any record
     * becoming unreadable - each ciphertext carries its own wrapped key.
     */
    async getDataKey() {
      if (!expired(current)) return current;

      const res = await client.send(
        new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: 'AES_256' }),
      );

      current = {
        plaintextKey: Buffer.from(res.Plaintext),
        encryptedKey: Buffer.from(res.CiphertextBlob).toString('base64'),
        expiresAt: Date.now() + DEK_TTL_MS,
      };
      return current;
    },

    /**
     * Unwrap a stored data key. Cached by its encrypted form, so re-reading a
     * batch of records written with the same key costs one KMS call rather
     * than one per record.
     */
    async decryptDataKey(encryptedKeyB64) {
      const hit = decryptCache.get(encryptedKeyB64);
      if (!expired(hit)) return hit.plaintextKey;

      const res = await client.send(
        new DecryptCommand({
          KeyId: keyId,
          CiphertextBlob: Buffer.from(encryptedKeyB64, 'base64'),
        }),
      );

      const plaintextKey = Buffer.from(res.Plaintext);
      decryptCache.set(encryptedKeyB64, {
        plaintextKey,
        expiresAt: Date.now() + DEK_TTL_MS,
      });

      // Bound the cache. A handful of keys is normal; anything more means
      // rotation is happening far faster than expected.
      if (decryptCache.size > 64) {
        const oldest = decryptCache.keys().next().value;
        decryptCache.delete(oldest);
      }

      return plaintextKey;
    },

    clearCache() {
      current = null;
      decryptCache.clear();
    },
  };
}
