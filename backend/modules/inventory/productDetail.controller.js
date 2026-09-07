import fs from 'fs';

import {
  getProductDetail, findImage, saveProductDetail,
  addProductImages, replaceProductImage, removeProductImage, bulkAddProductImages,
  listProductDetails,
} from './productDetail.service.js';
import {
  MAX_IMAGE_BYTES, MAX_IMAGES_PER_SKU, MAX_IMAGES_PER_REQUEST,
  MAX_VIDEOS_PER_SKU, MAX_DESCRIPTION_LENGTH, ALLOWED_IMAGE_EXTENSIONS,
} from './productDetail.rules.js';
import { discardUploads, MAX_BULK_IMAGES_PER_REQUEST } from '../../middlewares/productImageUpload.js';
import { allowedBrands } from '../../utils/brandAccess.js';

/**
 * Product detail endpoints — descriptions, photographs and videos.
 *
 * Two audiences, and the split between them is the point:
 *
 *  • READING is open to anyone who may see inventory, because this is the
 *    content the slide-over shows a customer.
 *  • WRITING needs MANAGE_INVENTORY_MASTER, applied on the routes.
 *
 * Serving an image is a third case and is deliberately unauthenticated — see
 * serveImage() below for why, and for what makes that safe.
 */

const asString = (value) => {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
};

const asInt = (v, fallback, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
};

const handle = (error, res, next) => {
  if (error?.status) {
    return res.status(error.status).json({ success: false, message: error.message, code: error.code });
  }
  return next(error);
};

/** The limits the admin screen enforces before a request is worth making. */
export const limits = async (_req, res) => {
  res.status(200).json({
    success: true,
    data: {
      maxImageBytes: MAX_IMAGE_BYTES,
      maxImagesPerSku: MAX_IMAGES_PER_SKU,
      maxImagesPerRequest: MAX_IMAGES_PER_REQUEST,
      maxBulkImagesPerRequest: MAX_BULK_IMAGES_PER_REQUEST,
      maxVideosPerSku: MAX_VIDEOS_PER_SKU,
      maxDescriptionLength: MAX_DESCRIPTION_LENGTH,
      allowedImageExtensions: ALLOWED_IMAGE_EXTENSIONS,
    },
  });
};

/**
 * GET /api/v1/product-details/images/:imageId — UNAUTHENTICATED, on purpose.
 *
 * WHY IT HAS TO BE. The portal's session is a JWT in localStorage, sent as an
 * Authorization header by the API client. A browser loading `<img src=...>`
 * sends no such header and cannot be made to, so an authenticated image route
 * would return 401 for every image on the page. The alternatives are worse:
 * fetching each image as a blob costs the browser cache, breaks lazy loading,
 * and puts megabytes of base64 through the JS heap.
 *
 * WHY IT IS SAFE. The URL is the credential — a 128-bit random id that appears
 * nowhere except on the detail row of the SKU it belongs to. Nothing lists
 * them, nothing enumerates them, and the id says nothing about the SKU. What is
 * behind it is a product photograph: catalogue material, the same thing the
 * business puts in a brochure. Nothing here reveals stock, prices, customers or
 * anything else the session protects.
 *
 * The response is streamed and cached hard. The id changes whenever the image
 * does — a replacement mints a new one — so the URL genuinely is immutable and
 * a stale cached copy is impossible.
 */
export const serveImage = async (req, res, next) => {
  try {
    const image = await findImage(req.params.imageId);

    const stat = await fs.promises.stat(image.path).catch(() => null);
    if (!stat?.isFile()) {
      // The row survived its file — a half-finished delete, or a restore that
      // brought the database back without the image root. Reported as a plain
      // 404 so the browser shows the panel's placeholder.
      return res.status(404).json({ success: false, message: 'Image not found.' });
    }

    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Content-Length', stat.size);

    /**
     * This is the header that makes the picture actually appear.
     *
     * helmet() sets `Cross-Origin-Resource-Policy: same-origin` on every
     * response, which tells the browser to refuse the bytes to any page on a
     * different origin. For an `<img>` that means the request succeeds, the
     * image is discarded, and `onerror` fires — so the panel silently showed
     * its "no image" placeholder for a photograph that had uploaded perfectly.
     *
     * It bites wherever the app and the API are not the same origin: the dev
     * server on :5173 against the API on :5000, and any deployment that serves
     * them from different hosts. Production is same-origin today, which is
     * exactly why this is worth pinning rather than leaving to luck.
     *
     * Relaxed for THIS route only. Every other response keeps helmet's default.
     */
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    // Immutable: a changed image is a new id at a new URL.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // The bytes are only ever an image. Saying so stops a browser sniffing its
    // way to a different conclusion.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Never rendered as a document in its own right, whatever it turns out to
    // contain.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline');

    fs.createReadStream(image.path)
      .on('error', () => { if (!res.headersSent) res.status(404).end(); })
      .pipe(res);
  } catch (error) { handle(error, res, next); }
};

/**
 * GET /api/v1/product-details/:skuCode — what the slide-over shows.
 *
 * The user is passed down so the service can apply brand isolation. It is the
 * only thing gating this read: no permission is required beyond being signed
 * in, because customers are the audience for a product description.
 */
export const getOne = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await getProductDetail(req.params.skuCode, req.user) });
  } catch (error) { handle(error, res, next); }
};

/** GET /api/v1/product-details — the admin list, one row per catalogue SKU. */
export const list = async (req, res, next) => {
  try {
    const has = asString(req.query.hasContent);
    const result = await listProductDetails({
      search: asString(req.query.search) ?? '',
      brand: asString(req.query.brand) ?? '',
      hasContent: has === undefined ? null : has === 'true',
      page: asInt(req.query.page, 1, 1, 10_000),
      limit: asInt(req.query.limit, 25, 1, 100),
      // Brand isolation. A user may only list content for brands they can see.
      brands: allowedBrands(req.user),
    });
    res.status(200).json({ success: true, ...result });
  } catch (error) { handle(error, res, next); }
};

/**
 * PUT /api/v1/product-details/:skuCode
 * Body: { description?, videos?: [{ url, title } | url] }
 *
 * Text only. A field left out is left alone; a field sent empty is cleared.
 */
export const save = async (req, res, next) => {
  try {
    const detail = await saveProductDetail({
      skuCode: req.params.skuCode,
      // `undefined` and `null` mean different things here — see the service.
      description: 'description' in (req.body ?? {}) ? req.body.description : undefined,
      videos: 'videos' in (req.body ?? {}) ? req.body.videos : undefined,
      actor: req.user,
      req,
    });
    res.status(200).json({ success: true, data: detail });
  } catch (error) { handle(error, res, next); }
};

/** POST /api/v1/product-details/:skuCode/images — multipart, field `images`. */
export const addImages = async (req, res, next) => {
  try {
    const detail = await addProductImages({
      skuCode: req.params.skuCode, files: req.files, actor: req.user, req,
    });
    res.status(201).json({ success: true, data: detail });
  } catch (error) {
    // The service deletes what it refuses; this covers a throw from anywhere else.
    discardUploads(req);
    handle(error, res, next);
  }
};

/** PUT /api/v1/product-details/:skuCode/images/:imageId — multipart, field `image`. */
export const replaceImage = async (req, res, next) => {
  try {
    const detail = await replaceProductImage({
      skuCode: req.params.skuCode, imageId: req.params.imageId,
      file: req.file, actor: req.user, req,
    });
    res.status(200).json({ success: true, data: detail });
  } catch (error) {
    discardUploads(req);
    handle(error, res, next);
  }
};

/** DELETE /api/v1/product-details/:skuCode/images/:imageId */
export const deleteImage = async (req, res, next) => {
  try {
    const detail = await removeProductImage({
      skuCode: req.params.skuCode, imageId: req.params.imageId, actor: req.user, req,
    });
    res.status(200).json({ success: true, data: detail });
  } catch (error) { handle(error, res, next); }
};

/**
 * POST /api/v1/product-details/images/bulk — multipart, field `images`.
 *
 * Each file is filed against the SKU its filename names. Always 200 with a
 * per-file result: a folder where three names are wrong still files the other
 * seventeen, and the response says exactly which three and why.
 */
export const bulkImages = async (req, res, next) => {
  try {
    const result = await bulkAddProductImages({ files: req.files, actor: req.user, req });
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    discardUploads(req);
    handle(error, res, next);
  }
};

export default {
  limits, serveImage, getOne, list, save, addImages, replaceImage, deleteImage, bulkImages,
};
