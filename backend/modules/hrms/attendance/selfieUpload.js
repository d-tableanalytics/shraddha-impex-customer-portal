/**
 * Multer configuration for the attendance selfie route.
 *
 * MEMORY storage, not disk — the opposite choice from `middlewares/importUpload.js`,
 * for the opposite reason. An import is a 40 MB workbook that must be streamed
 * so the heap stays flat; a selfie is capped at 2 MB and goes straight back out
 * to S3, so writing it to disk would create a plaintext photograph of an
 * employee on the instance's filesystem for no gain. Nothing about a selfie
 * should ever be at rest unencrypted, and the shortest path to the bucket is
 * the one that guarantees it.
 *
 * The 2 MB ceiling is AD-15's: the global 10 MB multer limit is far too
 * generous for a 640-pixel JPEG the browser has already downscaled.
 */

import multer from 'multer';

import {
  STORAGE_CATEGORIES,
} from '../../../shared/constants/hrms.js';
import { maxUploadBytesFor } from '../../../utils/hrms/storage/index.js';
import { SELFIE_MIME_TYPES } from '../../../shared/constants/attendance.js';

export const MAX_SELFIE_BYTES = maxUploadBytesFor(STORAGE_CATEGORIES.ATTENDANCE_SELFIE);

export const uploadSelfieFile = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_SELFIE_BYTES,
    files: 1,
    // A selfie post carries no other fields. Anything else is a client that
    // has misunderstood the endpoint, or one probing it.
    fields: 2,
  },
  fileFilter: (_req, file, cb) => {
    const declared = String(file.mimetype ?? '').split(';')[0].trim().toLowerCase();
    if (!SELFIE_MIME_TYPES.includes(declared)) {
      // Refused before a byte is buffered. The declared type is only a first
      // filter — the service checks the file's own magic bytes, because a
      // Content-Type header is written by the uploader and proves nothing.
      return cb(
        Object.assign(new Error(`Selfies must be one of: ${SELFIE_MIME_TYPES.join(', ')}.`), {
          status: 400,
          code: 'UNSUPPORTED_FILE_TYPE',
        }),
      );
    }
    return cb(null, true);
  },
}).single('selfie');

/**
 * Turn multer's own errors into the API's error shape.
 *
 * Without this, an oversized file surfaces as an unhandled MulterError and the
 * employee sees a 500 for what is an ordinary "that photo is too big".
 */
export const handleSelfieUploadErrors = (err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `The selfie is larger than ${Math.round(MAX_SELFIE_BYTES / 1024)} KB. ` +
          'Your browser should downscale it before uploading.'
        : `Upload rejected: ${err.message}`;
    return res
      .status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
      .json({ success: false, message, code: err.code });
  }
  if (err?.status) {
    return res.status(err.status).json({ success: false, message: err.message, code: err.code });
  }
  return next(err);
};

export default { uploadSelfieFile, handleSelfieUploadErrors, MAX_SELFIE_BYTES };
