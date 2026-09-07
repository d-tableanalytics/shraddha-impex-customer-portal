/**
 * S3 storage driver (AD-7), with SSE-KMS (AD-10).
 *
 * Credentials come from the EC2 instance role. There is deliberately no
 * `credentials` block: `backend/.env` is committed to this repository, so an
 * access key placed there would be in version control.
 *
 * The instance role needs s3:PutObject, s3:GetObject, s3:DeleteObject and
 * s3:HeadObject on the bucket, plus kms:GenerateDataKey and kms:Decrypt on the
 * CMK - SSE-KMS writes need both.
 *
 * Bucket configuration this driver assumes:
 *   - Block Public Access ON, no public ACLs
 *   - default encryption aws:kms with a customer-managed CMK
 *   - S3 Bucket Keys enabled (cuts KMS request cost substantially)
 *   - a lifecycle rule at a LONGER window than the application's retention
 *     policy, as a backstop only - the application sweep is authoritative
 *     (AD-16)
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';

export function createS3Driver() {
  const region = process.env.AWS_REGION || 'ap-south-1';
  const bucket = process.env.AWS_S3_BUCKET;
  const kmsKeyId = process.env.HRMS_S3_KMS_KEY_ID || process.env.HRMS_KMS_KEY_ID;

  if (!bucket) {
    throw new Error('AWS_S3_BUCKET is required when STORAGE_DRIVER=s3.');
  }
  if (!kmsKeyId) {
    throw new Error(
      'HRMS_S3_KMS_KEY_ID (or HRMS_KMS_KEY_ID) is required when STORAGE_DRIVER=s3. ' +
        'AD-10 requires SSE-KMS with a customer-managed key, not SSE-S3.',
    );
  }

  const client = new S3Client({ region });

  return {
    name: 's3',
    bucket,

    async put(key, body, { contentType } = {}) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType || 'application/octet-stream',
          // Explicit rather than relying on the bucket default, so an object is
          // encrypted with the intended key even if the bucket policy changes.
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: kmsKeyId,
        }),
      );
      return { key };
    },

    /**
     * A presigned GET URL.
     *
     * The requester needs no KMS permission of their own: S3 decrypts on their
     * behalf when serving the object.
     */
    async getSignedUrl(key, ttlSeconds) {
      return presign(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: ttlSeconds,
      });
    },

    /**
     * A readable stream.
     *
     * Present for the rare case that needs bytes server-side - generating a
     * PDF from a stored template, say. Ordinary downloads must use
     * getSignedUrl: streaming through this process is what the 400 MB cap
     * cannot afford.
     */
    async getStream(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return res.Body;
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (err) {
        if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return false;
        throw err;
      }
    },
  };
}
