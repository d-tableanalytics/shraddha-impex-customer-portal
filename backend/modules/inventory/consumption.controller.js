/**
 * Daily-average recalculation endpoint.
 *
 * A system operation rather than an inventory edit — it rewrites a planning
 * input across the catalogue — so it sits behind CONFIGURE_INVENTORY alongside
 * the projection rebuilds, not behind the ordinary master-edit permission.
 */

import { allowedBrands, canAccessBrand } from '../../utils/brandAccess.js';
import { recalculateDailyAverage } from './consumption.service.js';

const asString = (value) => {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
};

/** POST /api/v1/inventory/consumption/recalculate */
export const recalculate = async (req, res, next) => {
  try {
    const brand = asString(req.body?.brand);
    if (brand && !canAccessBrand(req.user, brand)) {
      return res.status(403).json({
        success: false, message: 'Access to this brand is restricted for your account.',
      });
    }

    // Default to a DRY RUN. This rewrites the figure every stock target is
    // derived from, so applying it has to be asked for explicitly rather than
    // being what happens when the flag is forgotten.
    const dryRun = req.body?.apply !== true;

    const result = await recalculateDailyAverage({
      brand: brand ?? null,
      skuCodes: Array.isArray(req.body?.skuCodes) ? req.body.skuCodes : null,
      dryRun,
      actor: req.user,
      req,
    });

    res.status(200).json({
      success: true,
      message: dryRun
        ? `${result.wouldUpdate} SKU(s) would change. Send apply:true to write them.`
        : `${result.updated} SKU(s) updated from sales.`,
      data: result,
    });
  } catch (error) { next(error); }
};

export default { recalculate };
