import express from 'express';
import { getProducts, getInventory, createProduct, getProductByCode, getCategories, lookupProducts, searchProducts } from './product.controller.js';
import { protect } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/rbac.js';

// Mounted at /api/v1/products (no :brand) — the all-brands Inventory view.
// Requests carrying a brand segment fall through to the router below.
export const inventoryRouter = express.Router();
/*
 * Browsing the catalogue is the Product Catalogue's View cell (view_catalogue),
 * or any role whose work needs the product list: inventory staff, anyone who
 * books, the sales desk. The SKU search and lookup below stay open to every
 * signed-in user: they back the SKU pickers on many screens, and each result
 * is brand-scoped in the controller.
 */
const canBrowseCatalogue = authorize('view_catalogue', 'view_inventory', 'create_order', 'view_all_bookings');

inventoryRouter.get('/categories', protect, canBrowseCatalogue, getCategories);
// SKU picker search across every brand the user may see. On the all-brands
// router for the same reason as /lookup: declared here it resolves before the
// ':brand' router would read "search" as a brand name.
inventoryRouter.get('/search', protect, searchProducts);
// Bulk SKU lookup. Declared on the all-brands router so it resolves BEFORE the
// ':brand' router below — otherwise POST /products/lookup would be read as
// brand="lookup" and fall through to createProduct.
inventoryRouter.post('/lookup', protect, lookupProducts);
inventoryRouter.get('/', protect, canBrowseCatalogue, getInventory);

const router = express.Router({ mergeParams: true }); // inherit :brand from parent

router.route('/')
  .get(protect, canBrowseCatalogue, getProducts)
  .post(protect, authorize('*'), createProduct);

router.route('/:skuCode')
  .get(protect, canBrowseCatalogue, getProductByCode);

export default router;
