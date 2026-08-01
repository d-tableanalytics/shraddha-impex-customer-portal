import { ProductKoken, ProductBIX, ProductIMADA } from '../../models/Product.js';
import { canAccessBrand, allowedBrandModels } from '../../utils/brandAccess.js';
import { msilAppliesTo } from '../../utils/msilVisibility.js';
import { prefixMatch } from '../../utils/searchQuery.js';

// Map brand param → correct Mongoose model
const getModel = (brand) => {
  const b = String(brand || '').toLowerCase();
  if (b === 'koken')  return ProductKoken;
  if (b === 'bix')    return ProductBIX;
  if (b === 'imada')  return ProductIMADA;
  return null;
};

// Sort keys accepted by the inventory view, mapped to Mongo sort specs.
// Products have no separate name column, so "name" sorts on skuCode.
const SORT_SPECS = {
  'name-asc':   { skuCode: 1 },
  'name-desc':  { skuCode: -1 },
  'stock-asc':  { availableForSale: 1 },
  'stock-desc': { availableForSale: -1 },
};

// A SKU is low stock below twice its MOQ, falling back to 10 when no MOQ is
// set. Mirrors the per-row badge threshold on the Inventory page.
const LOW_STOCK_MATCH = {
  $or: [
    {
      moq: { $gt: 0 },
      $expr: {
        $lt: [
          '$availableForSale',
          { $multiply: ['$moq', 2] }
        ]
      }
    },
    {
      $or: [
        { moq: { $lte: 0 } },
        { moq: { $exists: false } }
      ],
      availableForSale: { $lt: 10 }
    }
  ]
};

// GET /api/v1/products?search=&sort=&page=&limit=
// The Inventory view spans all three brand collections. Search, sort, paging
// and the KPI counts all resolve server-side so they cover the whole catalogue
// rather than whatever subset the client happened to download.
export const getInventory = async (req, res, next) => {
  try {
    const { search, sort = 'name-asc', brand, category } = req.query;
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;
    const sortSpec = SORT_SPECS[sort] || SORT_SPECS['name-asc'];

    // Export mode returns the whole filtered catalogue in one shot (no paging),
    // capped so a runaway request can't pull unbounded rows.
    const exportAll = ['true', '1'].includes(String(req.query.all));
    const EXPORT_CAP = 10000;
    const fetchLimit = exportAll ? EXPORT_CAP : skip + limit;

    // Low Stock is an Admin-only tile, and the $expr count cannot use an index,
    // so it is only run for the users who actually see it.
    const wantsLowStock = req.user?.role === 'Admin';

    // MSIL Codes are only searchable by users they are shown to. Shared rule —
    // see utils/msilVisibility.js.
    const msilApplies = msilAppliesTo(req.user);

    const query = {};
    // Prefix-anchored so an index can serve it, and escaped so SKU
    // metacharacters match literally — see utils/searchQuery.js.
    const anchored = prefixMatch(search);
    if (anchored) {
      query.$or = [{ skuCode: anchored }];
      if (msilApplies) query.$or.push({ msilCode: anchored });
    }
    if (category) {
      query.category = category;
    }

    // MSIL customers do not carry the IMADA brand, so it is excluded from their
    // Inventory entirely — rows, counts and low-stock all follow from this list.
    // Admins always see every brand. Customers only see brands they have brandAccess to.
    // Brand names are upper-cased here because the inventory rows/filters use
    // that form; access itself is decided by the shared helper.
    let models = allowedBrandModels(req.user).map(([Model, brand]) => [Model, brand.toUpperCase()]);

    // Filter by brand parameter if supplied
    if (brand) {
      models = models.filter(([_, brandName]) => brandName.toLowerCase() === brand.toLowerCase());
    }

    // Global ordering across the brand collections: take the first fetchLimit
    // of each, merge, re-sort, then slice the requested page out of the merge.
    // The globally first (skip + limit) rows are always contained in that union.
    const perModel = await Promise.all(
      models.map(async ([Model, brand]) => {
        const [rows, total, catalogue, lowStock] = await Promise.all([
          Model.find(query).sort(sortSpec).limit(fetchLimit).lean(),
          Model.countDocuments(query),
          // Without a search the filtered count is already the catalogue count.
          search ? Model.countDocuments() : Promise.resolve(null),
          wantsLowStock ? Model.countDocuments(LOW_STOCK_MATCH) : Promise.resolve(0),
        ]);
        return { rows: rows.map((r) => ({ ...r, brand })), total, catalogue, lowStock };
      }),
    );

    const [sortField, sortDir] = Object.entries(sortSpec)[0];
    const sorted = perModel
      .flatMap((m) => m.rows)
      .sort((a, b) => {
        const av = a[sortField];
        const bv = b[sortField];
        if (sortField === 'skuCode') {
          return String(av ?? '').localeCompare(String(bv ?? '')) * sortDir;
        }
        return ((av ?? 0) - (bv ?? 0)) * sortDir;
      });
    const merged = exportAll ? sorted : sorted.slice(skip, skip + limit);

    const total = perModel.reduce((sum, m) => sum + m.total, 0);

    res.status(200).json({
      success: true,
      data: merged,
      pagination: { total, page, pages: Math.ceil(total / limit) || 1 },
      // KPI tiles describe the whole catalogue, so they ignore the search filter.
      totals: {
        catalogue: perModel.reduce((sum, m) => sum + (m.catalogue ?? m.total), 0),
        lowStock: perModel.reduce((sum, m) => sum + m.lowStock, 0),
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/products/:brand?search=&category=&page=&limit=
export const getProducts = async (req, res, next) => {
  try {
    const { brand } = req.params;
    const { search, category, limit = 50, page = 1 } = req.query;
    const Model = getModel(brand);

    if (!Model) {
      return res.status(400).json({ success: false, message: `Unknown brand: ${brand}` });
    }

    if (!canAccessBrand(req.user, brand)) {
      return res.status(403).json({ success: false, message: 'Access to this brand is restricted for your account.' });
    }

    const query = {};
    const anchored = prefixMatch(search);
    if (anchored) {
      query.$or = [{ skuCode: anchored }, { msilCode: anchored }];
    }
    if (category) query.category = category;

    const [products, total] = await Promise.all([
      Model.find(query).limit(Number(limit)).skip((Number(page) - 1) * Number(limit)),
      Model.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      data: products,
      pagination: { total, page: Number(page), pages: Math.ceil(total / Number(limit)) },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/products/:brand/:skuCode
export const getProductByCode = async (req, res, next) => {
  try {
    const { brand, skuCode } = req.params;
    const Model = getModel(brand);

    if (!Model) {
      return res.status(400).json({ success: false, message: `Unknown brand: ${brand}` });
    }

    if (!canAccessBrand(req.user, brand)) {
      return res.status(403).json({ success: false, message: 'Access to this brand is restricted for your account.' });
    }

    const product = await Model.findOne({
      $or: [{ skuCode: req.params.skuCode }, { msilCode: req.params.skuCode }]
    });

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    res.status(200).json({ success: true, data: product });
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/products/:brand — used internally / admin
export const createProduct = async (req, res, next) => {
  try {
    const { brand } = req.params;
    const Model = getModel(brand);

    if (!Model) {
      return res.status(400).json({ success: false, message: `Unknown brand: ${brand}` });
    }

    const product = await Model.create(req.body);
    res.status(201).json({ success: true, data: product });
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/products/categories
export const getCategories = async (req, res, next) => {
  try {
    // Categories are only offered for brands the user can actually see, so the
    // filter never lists a category that exists solely in a hidden brand.
    const allowedModels = allowedBrandModels(req.user).map(([Model]) => Model);

    const uniqueCategories = new Set();
    await Promise.all(
      allowedModels.map(async (model) => {
        const cats = await model.distinct('category');
        cats.forEach(c => {
          if (c) {
            if (Array.isArray(c)) {
              c.forEach(sub => sub && uniqueCategories.add(sub.trim()));
            } else {
              uniqueCategories.add(String(c).trim());
            }
          }
        });
      })
    );

    res.status(200).json({
      success: true,
      data: Array.from(uniqueCategories).sort()
    });
  } catch (error) {
    next(error);
  }
};
