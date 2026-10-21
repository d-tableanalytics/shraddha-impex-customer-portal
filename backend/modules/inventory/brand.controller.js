import Brand from '../../models/Brand.js';
import User from '../../models/User.js';
import { Product } from '../../models/Product.js';
import Order from '../../models/Order.js';
import StockMovement from '../../models/StockMovement.js';
import StockBalance from '../../models/StockBalance.js';
import StockAdjustment from '../../models/StockAdjustment.js';
import StockCount from '../../models/StockCount.js';
import StockCountLine from '../../models/StockCountLine.js';
import StockHealth from '../../models/StockHealth.js';
import InventoryAlert from '../../models/InventoryAlert.js';
import InventorySnapshot from '../../models/InventorySnapshot.js';
import OversoldException from '../../models/OversoldException.js';
import ImportJob from '../../models/ImportJob.js';
import ImportRow from '../../models/ImportRow.js';
import ArchivedUser from '../../models/ArchivedUser.js';
import ProductDetail from '../../models/ProductDetail.js';
import {
  listBrands, findBrand, brandKeyFor, brandNameProblem, loadBrands,
} from '../../utils/brandRegistry.js';
import { recordAudit } from '../../utils/auditLog.js';
import { invalidateDashboardCache } from './dashboard.controller.js';

/**
 * Brand master — Inventory Configuration, beside Stock Locations.
 *
 * Creating a brand is all it takes for it to appear everywhere: every brand
 * dropdown, filter and access rule in both portals reads the list through
 * utils/brandRegistry.js. After each write this process reloads the list at
 * once and tells open browsers (`brands:updated`) to fetch it again; the
 * Employee Portal picks it up on its next refresh, within a minute.
 *
 * A brand is never renamed: its name is the value stored on every product,
 * order and movement filed under it. One created by mistake can be DELETED
 * while nothing refers to it, and created again correctly.
 */

/**
 * Everything that stores a brand. A brand any of these mention is in use and
 * cannot be deleted — the documents would be left naming a brand that no
 * longer exists, and no screen could select them again.
 */
const REFERENCES = [
  ['products', Product],
  ['orders', Order],
  ['stock movements', StockMovement],
  ['stock balances', StockBalance],
  ['stock adjustments', StockAdjustment],
  ['stock counts', StockCount],
  ['count lines', StockCountLine],
  ['health records', StockHealth],
  ['alerts', InventoryAlert],
  ['snapshots', InventorySnapshot],
  ['oversold exceptions', OversoldException],
  ['imports', ImportJob],
  ['product details', ProductDetail],
];

const referencesTo = async (name) => {
  const counts = await Promise.all([
    ...REFERENCES.map(([, Model]) => Model.countDocuments({ brand: name }).catch(() => 0)),
    // An import staged but not yet run names the brand on its ROWS (the sheet's
    // Brand column) or on a new SKU's answers, not on the job. Deleting the
    // brand under it would let the confirm create products no list can reach.
    ImportRow.countDocuments({ 'data.brand': name, status: 'pending' }).catch(() => 0),
    ImportJob.countDocuments({
      status: { $in: ['Pending', 'Validated', 'Processing'] }, 'newSkus.brand': name,
    }).catch(() => 0),
  ]);
  return [...REFERENCES.map(([label]) => label), 'staged import rows', 'staged imports']
    .map((label, i) => ({ label, count: counts[i] }))
    .filter((r) => r.count > 0);
};

/** Remove a brand's flag from every account, live or suspended. */
const clearFlags = async (key) => {
  const field = `brandAccess.${key}`;
  await Promise.all([
    User.updateMany({ [field]: { $exists: true } }, { $unset: { [field]: 1 } }),
    ArchivedUser.updateMany({ [field]: { $exists: true } }, { $unset: { [field]: 1 } }),
  ]);
};

/**
 * Tell every open browser to re-read the brand list.
 *
 * DELIBERATELY EMPTY. This reaches every connected socket, customers
 * included, and a customer is only ever told about their own brands — so the
 * event says "something changed" and each browser re-reads /auth/me, which
 * answers with the list that viewer is allowed.
 */
const broadcast = (req) => {
  invalidateDashboardCache();
  req.app?.get?.('io')?.emit('brands:updated', {});
};

/**
 * GET /api/v1/inventory/brands
 * Every brand, with how many products and users it has — what the settings
 * screen needs to show which brands are live and which can still be deleted.
 */
export const listBrandsHandler = async (req, res, next) => {
  try {
    await loadBrands();
    const brands = listBrands();
    const [productCounts, docs] = await Promise.all([
      Product.aggregate([{ $group: { _id: '$brand', n: { $sum: 1 } } }]),
      Brand.find({}, 'key createdAt createdBy').populate('createdBy', 'user email').lean(),
    ]);
    const products = new Map(productCounts.map((p) => [p._id, p.n]));
    const meta = new Map(docs.map((d) => [d.key, d]));

    const users = await Promise.all(brands.map((b) =>
      User.countDocuments({ [`brandAccess.${b.key}`]: true })));

    res.json({
      success: true,
      data: brands.map((b, i) => ({
        ...b,
        products: products.get(b.name) || 0,
        usersWithAccess: users[i],
        createdAt: meta.get(b.key)?.createdAt ?? null,
        createdBy: meta.get(b.key)?.createdBy ?? null,
      })),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/inventory/brands
 * Body: { name, hiddenFromMsil? }
 */
export const createBrand = async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? '').trim().replace(/\s+/g, ' ');
    const problem = brandNameProblem(name);
    if (problem) return res.status(400).json({ success: false, message: problem });

    const key = brandKeyFor(name);
    // Refreshed first, so a brand just added through the other portal is
    // caught here rather than by the unique index.
    await loadBrands();
    const clash = findBrand(name) || findBrand(key) || listBrands().find((b) => b.key === key);
    if (clash) {
      return res.status(409).json({
        success: false,
        message: clash.name.toLowerCase() === name.toLowerCase()
          ? `${clash.name} already exists.`
          : `"${name}" is too close to the existing brand ${clash.name}. Use a clearly different name.`,
      });
    }

    // A NEW brand starts with nobody ticked. A flag can linger under this key
    // from a brand deleted earlier (a suspended account, or a save from the
    // other portal before its brand list refreshed), and must not quietly grant
    // the new brand.
    await clearFlags(key);

    let brand;
    try {
      brand = await Brand.create({
        name, key, hiddenFromMsil: Boolean(req.body?.hiddenFromMsil), createdBy: req.user?._id ?? null,
      });
    } catch (error) {
      if (error?.code === 11000) {
        return res.status(409).json({ success: false, message: `${name} already exists.` });
      }
      throw error;
    }

    await loadBrands();
    broadcast(req);

    await recordAudit(req.user, 'Brand Created',
      `Brand ${name} created${brand.hiddenFromMsil ? ' (hidden from MSIL customers)' : ''}.`, req,
      { meta: { name, key, hiddenFromMsil: brand.hiddenFromMsil } });

    res.status(201).json({
      success: true,
      message: `${name} created. It is now available in every brand list. `
        + 'Customer and Sales accounts see it once it is ticked on their account in User Management.',
      data: { name, key, hiddenFromMsil: brand.hiddenFromMsil, system: false },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/v1/inventory/brands/:key
 * Body: { hiddenFromMsil }
 *
 * The one setting that may change on a live brand. The name may not: it is
 * the value stored on every document filed under it.
 */
export const updateBrand = async (req, res, next) => {
  try {
    const brand = await Brand.findOne({ key: String(req.params.key || '').toLowerCase() });
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found.' });
    if (typeof req.body?.hiddenFromMsil !== 'boolean') {
      return res.status(400).json({ success: false, message: 'hiddenFromMsil must be true or false.' });
    }
    if (brand.hiddenFromMsil === req.body.hiddenFromMsil) {
      return res.json({ success: true, data: brand.toObject() });
    }

    brand.hiddenFromMsil = req.body.hiddenFromMsil;
    await brand.save();
    await loadBrands();
    broadcast(req);

    await recordAudit(req.user, 'Brand Updated',
      `${brand.name} is now ${brand.hiddenFromMsil ? 'hidden from' : 'visible to'} MSIL customers.`, req,
      { meta: { key: brand.key, hiddenFromMsil: brand.hiddenFromMsil } });

    res.json({ success: true, data: brand.toObject() });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/v1/inventory/brands/:key
 *
 * Only for a brand created by mistake: never a built-in brand, and never one
 * anything has been filed under. Its flag is removed from every account too,
 * so a brand created later under the same name starts with nobody ticked.
 */
export const deleteBrand = async (req, res, next) => {
  try {
    const brand = await Brand.findOne({ key: String(req.params.key || '').toLowerCase() });
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found.' });
    if (brand.system || ['koken', 'bix', 'imada'].includes(brand.key)) {
      return res.status(409).json({ success: false, message: `${brand.name} is a built-in brand and cannot be deleted.` });
    }

    const used = await referencesTo(brand.name);
    if (used.length) {
      return res.status(409).json({
        success: false,
        message: `${brand.name} is in use (${used.map((u) => `${u.count} ${u.label}`).join(', ')}) `
          + 'and cannot be deleted.',
      });
    }

    /*
     * DELETE, THEN VERIFY. The reference check above and the delete are two
     * steps, so something could be filed under the brand in between. Removing
     * the brand first stops this process offering it; the references are then
     * checked again, and if anything arrived in that moment the brand is put
     * back exactly as it was and the delete is refused. Account flags are
     * cleared only once the delete is certain, so a rolled-back delete loses
     * nobody's access.
     */
    const original = brand.toObject();
    await Brand.deleteOne({ _id: brand._id });
    await loadBrands();
    const lateArrivals = await referencesTo(brand.name);
    if (lateArrivals.length) {
      await Brand.create(original);
      await loadBrands();
      return res.status(409).json({
        success: false,
        message: `${brand.name} was used a moment ago (${lateArrivals.map((u) => `${u.count} ${u.label}`).join(', ')}) `
          + 'and was not deleted.',
      });
    }
    await clearFlags(brand.key);
    broadcast(req);

    await recordAudit(req.user, 'Brand Deleted', `Brand ${brand.name} deleted (it was never used).`, req,
      { meta: { name: brand.name, key: brand.key } });

    res.json({ success: true, message: `${brand.name} deleted.` });
  } catch (error) {
    next(error);
  }
};

export default { listBrandsHandler, createBrand, updateBrand, deleteBrand };
