import express from 'express';
import { getProducts, getInventory, createProduct, getProductByCode, getCategories, lookupProducts } from './product.controller.js';
import { protect } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/rbac.js';

// Mounted at /api/v1/products (no :brand) — the all-brands Inventory view.
// Requests carrying a brand segment fall through to the router below.
export const inventoryRouter = express.Router();
inventoryRouter.get('/categories', protect, getCategories);
// Bulk SKU lookup. Declared on the all-brands router so it resolves BEFORE the
// ':brand' router below — otherwise POST /products/lookup would be read as
// brand="lookup" and fall through to createProduct.
inventoryRouter.post('/lookup', protect, lookupProducts);
inventoryRouter.get('/', protect, getInventory);

const router = express.Router({ mergeParams: true }); // inherit :brand from parent

router.route('/')
  .get(protect, getProducts)
  .post(protect, authorize('*'), createProduct);

router.route('/:skuCode')
  .get(protect, getProductByCode);

export default router;
