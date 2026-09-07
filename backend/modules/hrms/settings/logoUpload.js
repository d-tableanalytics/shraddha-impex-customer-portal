/**
 * Multer configuration for the company logo route.
 *
 * MEMORY storage, following the attendance selfie: the file is capped small and
 * goes straight back out to object storage, so writing it to the instance's
 * filesystem would buy nothing. The reference does the opposite — it
 * `fs.writeFile`s the logo to one fixed path on the API server's local disk,
 * which is lost on redeploy and diverges between replicas.
 *
 * The ceiling is the reference's own 512 KB. PNG only, because the payslip
 * renderer embeds this file with `pdf-lib.embedPng` and handles nothing else.
 */

import multer from 'multer';

import { LOGO_MAX_BYTES, LOGO_MIME } from '../../../shared/schemas/settings.js';

export const uploadLogoFile = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: LOGO_MAX_BYTES,
    files: 1,
    // A logo post carries no other fields.
    fields: 2,
  },
  fileFilter: (_req, file, cb) => {
    const declared = String(file.mimetype ?? '').split(';')[0].trim().toLowerCase();
    if (declared !== LOGO_MIME) {
      // Refused before a byte is buffered. The declared type is only the first
      // filter — the service checks the PNG magic bytes, because a
      // Content-Type header is written by the uploader and proves nothing.
      cb(new Error('LOGO_TYPE'));
      return;
    }
    cb(null, true);
  },
}).single('logo');

/**
 * Turn multer's own failures into the HRMS error shape.
 *
 * Without this a file one byte over the limit surfaces as a 500 from the
 * app-wide handler rather than the 400 it is.
 */
export function handleLogoUploadErrors(err, _req, res, next) {
  if (!err) return next();

  if (err.message === 'LOGO_TYPE') {
    return res.status(400).json({
      success: false,
      message: 'Logo must be a PNG file.',
      code: 'HRMS_VALIDATION_FAILED',
    });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      success: false,
      message: `Logo must be under ${LOGO_MAX_BYTES / 1024} KB.`,
      code: 'HRMS_VALIDATION_FAILED',
    });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({
      success: false,
      message: 'Send exactly one file, in a field named "logo".',
      code: 'HRMS_VALIDATION_FAILED',
    });
  }
  return next(err);
}

export default { uploadLogoFile, handleLogoUploadErrors };
