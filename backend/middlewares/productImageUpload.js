import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { fileURLToPath } from 'url';

import {
  MAX_IMAGE_BYTES, MAX_IMAGES_PER_REQUEST, ALLOWED_IMAGE_EXTENSIONS,
  problemWithImage, extensionFor,
} from '../modules/inventory/productDetail.rules.js';

/**
 * Where product photographs live, and how they get there.
 *
 * UNLIKE THE IMPORT UPLOADS, THESE ARE PERMANENT. An imported spreadsheet is
 * consumed and deleted within the request; a product image has to survive
 * restarts and deploys, because the slide-over serves it months later. So it
 * does not go under the OS temp directory — it goes to a root that outlives the
 * process.
 *
 * The default root is `backend/uploads/product-images`, which is gitignored:
 * deploys run `git reset --hard`, and reset leaves ignored files alone, so the
 * gallery survives every deploy. Set PRODUCT_IMAGE_DIR to move it somewhere
 * backed up or shared — a volume, an NFS mount — without touching code. What it
 * must NOT be is anywhere nginx serves statically: nothing here is safe to hand
 * out without going through the serving route, which is what decides the
 * Content-Type rather than trusting the file.
 *
 * Files are named ONLY by a generated id plus an accepted extension. The
 * uploader's filename never reaches the filesystem — it is the classic
 * path-traversal vector, and it is kept on the document as data instead.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const IMAGE_ROOT = process.env.PRODUCT_IMAGE_DIR
  ? path.resolve(process.env.PRODUCT_IMAGE_DIR)
  : path.join(__dirname, '..', 'uploads', 'product-images');

fs.mkdirSync(IMAGE_ROOT, { recursive: true });

/** A fresh, unguessable name. Also the URL segment the image is served under. */
export const newImageId = () => crypto.randomBytes(16).toString('hex');

/**
 * The absolute path of a stored image.
 *
 * Rebuilt from the id and extension held on the document, never from anything
 * in the request — and then checked to be inside the root regardless, so a
 * stored value that somehow contained a separator still cannot escape.
 */
export const imagePath = (imageId, extension) => {
  const name = `${imageId}${extension}`;
  const full = path.join(IMAGE_ROOT, name);
  const resolved = path.resolve(full);
  if (resolved !== path.join(IMAGE_ROOT, path.basename(resolved))) {
    throw Object.assign(new Error('Refusing a product image path outside the image root.'), { status: 400 });
  }
  return resolved;
};

/** Remove a stored file. Missing is success — the caller wanted it gone. */
export const removeImageFile = async (imageId, extension) => {
  try {
    await fs.promises.unlink(imagePath(imageId, extension));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[ProductImages] Could not delete:', error.message);
  }
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, IMAGE_ROOT),
  filename: (_req, file, cb) => {
    const ext = extensionFor(file.mimetype, file.originalname) ?? '.bin';
    const id = newImageId();
    // Handed back to the controller so it can record the row without having to
    // re-derive either half from the path.
    file.imageId = id;
    file.storedExtension = ext;
    cb(null, `${id}${ext}`);
  },
});

/**
 * Refuse a file before a single byte reaches the disk.
 *
 * Size is NOT checked here — multer only knows it while streaming, so the limit
 * below is what enforces it and `handleImageUploadErrors` reports it.
 */
const fileFilter = (_req, file, cb) => {
  const problem = problemWithImage({ mimeType: file.mimetype, originalName: file.originalname });
  if (problem) return cb(Object.assign(new Error(problem), { status: 400, code: 'UNSUPPORTED_IMAGE_TYPE' }));
  cb(null, true);
};

const limits = { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_REQUEST, fields: 12 };

/** One SKU's images: `POST /product-details/:skuCode/images`, field `images`. */
export const uploadProductImages = multer({ storage, fileFilter, limits }).array('images', MAX_IMAGES_PER_REQUEST);

/** A single replacement: `PUT /product-details/:skuCode/images/:imageId`, field `image`. */
export const uploadProductImage = multer({ storage, fileFilter, limits }).single('image');

/**
 * Files one BULK upload may carry: `POST /product-details/images/bulk`.
 *
 * Higher than the per-SKU limit because the whole point of that endpoint is
 * dropping a folder of photographs in at once, each named after the SKU it
 * belongs to. The real ceiling is nginx's 30 MB per request, not this — twenty
 * ordinary product photographs sit well inside it, twenty camera originals do
 * not, and the error when they do not says so.
 */
export const MAX_BULK_IMAGES_PER_REQUEST = 20;

export const uploadBulkProductImages = multer({
  storage,
  fileFilter,
  limits: { ...limits, files: MAX_BULK_IMAGES_PER_REQUEST },
}).array('images', MAX_BULK_IMAGES_PER_REQUEST);

/**
 * Delete whatever a rejected request already wrote.
 *
 * multer writes each file as it arrives, so a request refused on its third file
 * has already stored the first two. Without this they stay on disk forever with
 * nothing referencing them — invisible, because only the database knows what an
 * image is.
 */
export const discardUploads = (req) => {
  const files = [
    ...(Array.isArray(req.files) ? req.files : []),
    ...(req.file ? [req.file] : []),
  ];
  for (const f of files) {
    if (f?.path) fs.promises.unlink(f.path).catch(() => {});
  }
};

/** Turn multer's own errors into the API's error shape. */
export const handleImageUploadErrors = (err, req, res, next) => {
  discardUploads(req);

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        code: err.code,
        message: `That image is larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB. `
          + 'Resize it and try again.',
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      // The two endpoints have different ceilings, so the message names the one
      // the request actually hit rather than a number it never had.
      const ceiling = req.path?.endsWith('/images/bulk') ? MAX_BULK_IMAGES_PER_REQUEST : MAX_IMAGES_PER_REQUEST;
      return res.status(400).json({
        success: false,
        code: err.code,
        message: `Upload at most ${ceiling} images at a time.`,
      });
    }
    return res.status(400).json({ success: false, code: err.code, message: `Upload rejected: ${err.message}` });
  }

  if (err?.status) {
    return res.status(err.status).json({ success: false, message: err.message, code: err.code });
  }
  return next(err);
};

export {
  MAX_IMAGE_BYTES, MAX_IMAGES_PER_REQUEST, ALLOWED_IMAGE_EXTENSIONS,
};

export default {
  IMAGE_ROOT, newImageId, imagePath, removeImageFile,
  uploadProductImages, uploadProductImage, uploadBulkProductImages,
  discardUploads, handleImageUploadErrors,
};
