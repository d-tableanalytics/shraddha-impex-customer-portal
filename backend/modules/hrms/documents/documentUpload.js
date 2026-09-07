/**
 * Document upload: multipart handling and content sniffing.
 *
 * The reference validates nothing. It accepts any file of any size, stores it
 * under the client's filename extension, keeps the client's declared MIME type,
 * and later serves that type back with `Content-Disposition: inline` — which
 * turns an uploaded `.html` into script execution on the API origin against a
 * live session cookie.
 *
 * Everything here exists to close that:
 *
 *   - the bytes are read into memory, never onto a path built from user input
 *   - the type is decided by the LEADING BYTES, not by what the client said
 *   - the whitelist is what an HR repository actually needs, and nothing that
 *     a browser will execute
 *   - the size is capped before any of it is parsed
 */

import multer from 'multer';

import { MAX_UPLOAD_BYTES } from '../../../shared/constants/hrms.js';
import { HrmsValidationError } from '../hrms.errors.js';

/** 10 MB — the storage layer's default ceiling for a document. */
export const MAX_DOCUMENT_BYTES = MAX_UPLOAD_BYTES.DEFAULT ?? 10 * 1024 * 1024;

const startsWith = (buffer, bytes) =>
  buffer.length >= bytes.length && buffer.subarray(0, bytes.length).equals(Buffer.from(bytes));

/**
 * The formats an HR document repository holds.
 *
 * Deliberately excludes SVG and HTML: both are documents to a human and
 * executable markup to a browser, and neither has a magic number that
 * distinguishes a safe one from a hostile one.
 */
const SIGNATURES = [
  {
    type: 'application/pdf',
    ext: 'pdf',
    match: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  },
  {
    type: 'image/png',
    ext: 'png',
    match: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    type: 'image/jpeg',
    ext: 'jpg',
    match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    type: 'image/webp',
    ext: 'webp',
    match: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  {
    type: 'image/tiff',
    ext: 'tif',
    match: (b) => startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]),
  },
];

/**
 * The modern Office formats are ZIP containers, and so is an ordinary archive.
 *
 * The leading bytes cannot tell them apart, so the DECLARED type decides which
 * of the three it is recorded as — but only after the bytes have proved it is a
 * ZIP at all, and only among types on this list. A renamed executable claiming
 * to be a .docx still fails the signature check.
 */
const ZIP_SUBTYPES = new Map([
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    { ext: 'docx' },
  ],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { ext: 'xlsx' }],
  [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    { ext: 'pptx' },
  ],
]);

const isZip = (b) =>
  startsWith(b, [0x50, 0x4b, 0x03, 0x04]) ||
  startsWith(b, [0x50, 0x4b, 0x05, 0x06]) ||
  startsWith(b, [0x50, 0x4b, 0x07, 0x08]);

/** The legacy Office formats share one OLE2 container signature. */
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const OLE2_SUBTYPES = new Map([
  ['application/msword', { ext: 'doc' }],
  ['application/vnd.ms-excel', { ext: 'xls' }],
  ['application/vnd.ms-powerpoint', { ext: 'ppt' }],
]);

/**
 * Plain text has no signature, so it is admitted only when the client says so
 * AND the bytes contain nothing a text file would not: no NULs, and valid
 * UTF-8. It is served as an attachment with a sniffed type either way.
 */
const looksLikeText = (b) => {
  if (b.includes(0x00)) return false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    decoder.decode(b.subarray(0, Math.min(b.length, 4096)));
    return true;
  } catch {
    return false;
  }
};

/**
 * Decide what a file really is.
 *
 * @param {Buffer} buffer the uploaded bytes
 * @param {string} declared the client's Content-Type, used only to disambiguate
 *   containers whose signature is shared
 * @returns {{ type: string, ext: string } | null} null when nothing matches
 */
export function sniffDocument(buffer, declared = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;

  for (const signature of SIGNATURES) {
    if (signature.match(buffer)) return { type: signature.type, ext: signature.ext };
  }

  if (isZip(buffer)) {
    const subtype = ZIP_SUBTYPES.get(declared);
    // A ZIP that does not claim to be an Office document is not one we accept.
    return subtype ? { type: declared, ext: subtype.ext } : null;
  }

  if (startsWith(buffer, OLE2)) {
    const subtype = OLE2_SUBTYPES.get(declared);
    return subtype ? { type: declared, ext: subtype.ext } : null;
  }

  if ((declared === 'text/plain' || declared === 'text/csv') && looksLikeText(buffer)) {
    return { type: declared, ext: declared === 'text/csv' ? 'csv' : 'txt' };
  }

  return null;
}

/** Every type the whitelist admits, for the browser's `accept` attribute. */
export const ACCEPTED_DOCUMENT_TYPES = Object.freeze([
  ...SIGNATURES.map((s) => s.type),
  ...ZIP_SUBTYPES.keys(),
  ...OLE2_SUBTYPES.keys(),
  'text/plain',
  'text/csv',
]);

/**
 * Multipart, into memory.
 *
 * Memory rather than disk because nothing is ever written to a path built from
 * user input — the bytes go to the storage layer, which mints its own key.
 */
export const uploadDocumentFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 },
}).single('file');

/** Turn multer's own errors into the HRMS error shape. */
export function handleDocumentUploadErrors(error, req, res, next) {
  if (error?.code === 'LIMIT_FILE_SIZE') {
    return next(
      new HrmsValidationError(
        `That file is larger than the ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB limit.`,
      ),
    );
  }
  if (error?.code === 'LIMIT_UNEXPECTED_FILE') {
    return next(new HrmsValidationError('Upload one file, in a field named "file".'));
  }
  return next(error);
}

export default {
  uploadDocumentFile,
  handleDocumentUploadErrors,
  sniffDocument,
  MAX_DOCUMENT_BYTES,
  ACCEPTED_DOCUMENT_TYPES,
};
