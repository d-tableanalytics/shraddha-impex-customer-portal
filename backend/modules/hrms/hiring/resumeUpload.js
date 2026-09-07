/**
 * Multer configuration for the résumé upload.
 *
 * MEMORY storage: the file goes straight back out to object storage, so writing
 * it to the instance's disk first would leave a plaintext CV — someone's home
 * address, phone number and employment history — sitting on the filesystem for
 * no gain. The same choice, for the same reason, as the attendance selfie.
 *
 * The declared type is only a first filter; the service checks the file's own
 * magic bytes, because a `Content-Type` header is written by the uploader.
 */

import multer from 'multer';

import { RESUME_MIME_TYPES, MAX_RESUME_BYTES } from '../../../shared/constants/hiring.js';

/**
 * Re-exported so callers here keep importing it from the upload module, while
 * the value itself lives in `shared/` — the browser's pre-check reads the same
 * constant, and a limit that differs between the two is a limit that surprises
 * somebody after a long upload.
 */
export { MAX_RESUME_BYTES };

export const uploadResumeFile = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_RESUME_BYTES,
    files: 1,
    // A résumé post carries no other fields. Anything else is a client that has
    // misunderstood the endpoint, or one probing it.
    fields: 2,
  },
  fileFilter: (_req, file, cb) => {
    const declared = String(file.mimetype ?? '').split(';')[0].trim().toLowerCase();
    if (!RESUME_MIME_TYPES.includes(declared)) {
      return cb(
        Object.assign(new Error('Résumés must be a PDF, DOC or DOCX file.'), {
          status: 400,
          code: 'UNSUPPORTED_FILE_TYPE',
        }),
      );
    }
    return cb(null, true);
  },
}).single('resume');

/**
 * Turn multer's own errors into the API's shape.
 *
 * Without this an oversized file surfaces as an unhandled MulterError and the
 * recruiter sees a 500 for an ordinary "that file is too big".
 */
export const handleResumeUploadErrors = (err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `That file is larger than ${Math.round(MAX_RESUME_BYTES / 1024 / 1024)} MB.`
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

export default { uploadResumeFile, handleResumeUploadErrors, MAX_RESUME_BYTES };
