import express from 'express';

import {
  limits, serveImage, getOne, list, save, addImages, replaceImage, deleteImage, bulkImages,
} from './productDetail.controller.js';
import {
  uploadProductImages, uploadProductImage, uploadBulkProductImages, handleImageUploadErrors,
} from '../../middlewares/productImageUpload.js';
import { protect } from '../../middlewares/auth.js';
import { authorize, PERMISSIONS } from '../../middlewares/rbac.js';

/**
 * Product detail routes — descriptions, photographs and videos.
 *
 * MOUNTED SEPARATELY FROM THE INVENTORY ROUTER, not folded into it, because
 * that router applies `protect` to everything under it and one route here must
 * NOT be authenticated: the image itself. A browser's `<img>` sends no
 * Authorization header, and the session is a localStorage token rather than a
 * cookie, so an authenticated image URL cannot load. See serveImage() for what
 * makes that safe — the id is a 128-bit capability and the payload is catalogue
 * photography.
 *
 * Everything else is authenticated, and the split is the usual one: reading is
 * for anyone who may see inventory, writing needs MANAGE_INVENTORY_MASTER —
 * the same permission that governs every other maintained field on a SKU.
 */
const router = express.Router();

// ── Public ────────────────────────────────────────────────────────────────
// FIRST, and before `router.use(protect)`. Declared after it, the image would
// be authenticated; declared after '/:skuCode', "images" would be read as a SKU.
router.get('/images/:imageId', serveImage);

// ── Authenticated from here down ──────────────────────────────────────────
router.use(protect);

// What the admin screen may send, so it can refuse a file before uploading it.
router.get('/limits', authorize(PERMISSIONS.VIEW_INVENTORY), limits);

// Bulk image upload. Static path, so it resolves before '/:skuCode/...'.
router.post(
  '/images/bulk',
  authorize(PERMISSIONS.MANAGE_INVENTORY_MASTER),
  uploadBulkProductImages,
  handleImageUploadErrors,
  bulkImages,
);

// The admin list: one row per catalogue SKU with whatever content it has.
router.get('/', authorize(PERMISSIONS.MANAGE_INVENTORY_MASTER), list);

// ── One SKU ───────────────────────────────────────────────────────────────
/**
 * Reading is open to EVERY signed-in user, with no permission beyond `protect`.
 *
 * It was gated on VIEW_INVENTORY, and that was wrong: the Customer role holds
 * only CREATE_ORDER, so every customer browsing the inventory list and opening
 * a product got a 403 and an empty panel — the exact audience the description
 * and photographs exist for.
 *
 * VIEW_INVENTORY is the permission for STOCK — ledger figures, reservations,
 * planning inputs. This endpoint returns none of that. It matches the catalogue
 * list itself (`inventoryRouter.get('/', protect, getInventory)`), which is also
 * open to any signed-in user, because a customer has to be able to see what
 * they are ordering.
 *
 * Brand isolation still applies, inside the service: a SKU outside the user's
 * brands reports as not in the catalogue rather than revealing that it exists.
 */
router.get('/:skuCode', getOne);

router.put('/:skuCode', authorize(PERMISSIONS.MANAGE_INVENTORY_MASTER), save);

router.post(
  '/:skuCode/images',
  authorize(PERMISSIONS.MANAGE_INVENTORY_MASTER),
  uploadProductImages,
  handleImageUploadErrors,
  addImages,
);

router.put(
  '/:skuCode/images/:imageId',
  authorize(PERMISSIONS.MANAGE_INVENTORY_MASTER),
  uploadProductImage,
  handleImageUploadErrors,
  replaceImage,
);

router.delete('/:skuCode/images/:imageId', authorize(PERMISSIONS.MANAGE_INVENTORY_MASTER), deleteImage);

export default router;
