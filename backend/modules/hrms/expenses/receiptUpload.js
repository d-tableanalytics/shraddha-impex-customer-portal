/**
 * Multer configuration for the expense receipt route.
 *
 * MEMORY storage, matching the attendance selfie route and for the same
 * reason: a receipt is capped, goes straight back out to S3, and writing it to
 * the instance's filesystem would leave someone's restaurant bill at rest,
 * unencrypted, for no gain.
 *
 * The reference writes receipts to a local uploads directory with the client's
 * own filename extension, and validates nothing.
 *
 * The declared Content-Type is only a first filter here. The service checks the
 * file's MAGIC BYTES, because a Content-Type header is written by the uploader
 * and proves nothing about the bytes behind it.
 */

import multer from 'multer';

import { STORAGE_CATEGORIES } from '../../../shared/constants/hrms.js';
import { maxUploadBytesFor } from '../../../utils/hrms/storage/index.js';

export const RECEIPT_MIME_TYPES = Object.freeze([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export const MAX_RECEIPT_BYTES = maxUploadBytesFor(STORAGE_CATEGORIES.EXPENSE_RECEIPT);

export const uploadReceiptFile = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_RECEIPT_BYTES,
    files: 1,
    // A receipt post carries no other fields.
    fields: 2,
  },
  fileFilter: (_req, file, cb) => {
    const declared = String(file.mimetype ?? '').split(';')[0].trim().toLowerCase();
    if (!RECEIPT_MIME_TYPES.includes(declared)) {
      return cb(
        Object.assign(
          new Error(`A receipt must be one of: ${RECEIPT_MIME_TYPES.join(', ')}.`),
          { status: 400, code: 'UNSUPPORTED_FILE_TYPE' },
        ),
      );
    }
    return cb(null, true);
  },
}).single('receipt');

/** Turn multer's own errors into the API's error shape rather than a 500. */
export const handleReceiptUploadErrors = (err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `That receipt is larger than the ${Math.floor(MAX_RECEIPT_BYTES / 1024 / 1024)} MB limit.`
        : 'That upload could not be accepted.';
    return res.status(400).json({ success: false, message, code: err.code });
  }
  if (err?.code === 'UNSUPPORTED_FILE_TYPE') {
    return res.status(400).json({ success: false, message: err.message, code: err.code });
  }
  return next(err);
};
