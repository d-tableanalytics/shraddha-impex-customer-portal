/**
 * SKU pricing endpoints — the Pricing side of Inventory Master's Update Stock
 * dialog.
 *
 * Thin, like the adjustment endpoints beside it: brand access, then the
 * service. Both routes are behind MANAGE_PRICING. Reading the current figures
 * is part of changing them, and the dialog is never offered to anyone without
 * the permission, so there is no separate read-only grant here — the sales desk
 * reads the schedule through its own quote, behind VIEW_PRICING.
 */

import { resolveBrand } from './adjustment.controller.js';
import { getSkuPricing, updateSkuPricing } from './skuPricing.service.js';
import { canonicalBrand } from '../../utils/brandRegistry.js';

/** GET /api/v1/inventory/items/:sku/pricing?brand= */
export const getPricing = async (req, res, next) => {
  try {
    const brand = canonicalBrand(resolveBrand(req, req.query.brand)) ?? req.query.brand;
    res.json({ success: true, data: await getSkuPricing({ skuCode: req.params.sku, brand }) });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/v1/inventory/items/:sku/pricing
 * Body: { brand, prices: { venusAutomation?, trader?, endUser?, msil? } }
 *
 * Only the tiers named are touched; a blank clears that tier. Stock is never
 * read or written.
 */
export const putPricing = async (req, res, next) => {
  try {
    const brand = canonicalBrand(resolveBrand(req, req.body?.brand)) ?? req.body?.brand;
    const data = await updateSkuPricing({
      skuCode: req.params.sku,
      brand,
      prices: req.body?.prices,
      actor: req.user,
      req,
    });
    res.json({
      success: true,
      message: `${data.skuCode}: ${data.changed.length} price${data.changed.length === 1 ? '' : 's'} updated.`,
      data,
    });
  } catch (error) {
    next(error);
  }
};

export default { getPricing, putPricing };
