import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';

/**
 * Upload handling for inventory imports (IMS Module M9).
 *
 * DISK STORAGE, NOT MEMORY. multer's memory storage would hold the whole
 * workbook as a Buffer, which defeats the streaming parser downstream — a
 * 40 MB upload would sit in the heap for the entire parse. On disk, the file
 * streams in and streams out again, and memory stays flat regardless of size.
 *
 * Files are temporary in the strictest sense: the import service deletes each
 * one as soon as its rows are staged, and the sweeper below clears anything an
 * interrupted request left behind.
 */

// Under the OS temp directory rather than inside the repo, so an upload can
// never be served as a static file and nothing lands in a deploy artefact.
const UPLOAD_DIR = path.join(os.tmpdir(), 'erp-inventory-imports');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** 40 MB. Roughly 250,000 spreadsheet rows — well past the 50,000-row ceiling. */
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    // The original name is NEVER used on disk. A user-supplied filename is
    // attacker-controlled and is the classic path-traversal vector; the real
    // name is kept on the job record, where it is data rather than a path.
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ALLOWED_EXTENSIONS.includes(ext) ? ext : '.dat'}`);
  },
});

export const uploadImportFile = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 12 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      // Checked here as well as in the controller so a rejected type never
      // reaches the disk at all.
      return cb(Object.assign(
        new Error(
          `"${file.originalname}" is ${ext ? `a ${ext} file` : 'a file with no extension'}. ` +
          'Imports must be .xlsx, .xls or .csv — open it in Excel and use Save As to convert it.',
        ),
        { status: 400, code: 'UNSUPPORTED_FILE_TYPE' },
      ));
    }
    cb(null, true);
  },
}).single('file');

/**
 * Turn multer's own errors into the API's error shape.
 *
 * Without this a file over the limit surfaces as an unhandled MulterError and
 * the user sees a 500 for what is a perfectly ordinary "your file is too big".
 */
export const handleUploadErrors = (err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `The file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB. Split it and import in parts.`
      : `Upload rejected: ${err.message}`;
    return res.status(413).json({ success: false, message, code: err.code });
  }
  if (err?.status) {
    return res.status(err.status).json({ success: false, message: err.message, code: err.code });
  }
  return next(err);
};

/**
 * Delete stale uploads.
 *
 * The service removes each file once staged, so anything still here is the
 * remains of a request that died mid-flight. Without a sweep those accumulate
 * until the disk fills — quietly, since nothing reads the directory.
 */
export const sweepUploads = async (maxAgeMs = 6 * 60 * 60 * 1000) => {
  try {
    const names = await fs.promises.readdir(UPLOAD_DIR);
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;

    for (const name of names) {
      const full = path.join(UPLOAD_DIR, name);
      const stat = await fs.promises.stat(full).catch(() => null);
      if (stat?.isFile() && stat.mtimeMs < cutoff) {
        await fs.promises.unlink(full).catch(() => {});
        removed += 1;
      }
    }

    if (removed) console.log(`[Import] Swept ${removed} stale upload(s).`);
    return removed;
  } catch (error) {
    console.error('[Import] Upload sweep failed:', error.message);
    return 0;
  }
};

export { UPLOAD_DIR };
export default { uploadImportFile, handleUploadErrors, sweepUploads, MAX_UPLOAD_BYTES, UPLOAD_DIR };
