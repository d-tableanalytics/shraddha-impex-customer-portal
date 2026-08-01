import InventoryConfig from '../../models/InventoryConfig.js';

/**
 * Inventory configuration resolution (IMS Modules M1 + M4).
 *
 * Extracted from config.controller.js when the Health Engine landed. The
 * controller writes configuration and the Health Engine reads it, so leaving
 * resolution in the controller created a genuine import cycle:
 *
 *     config.controller → health.service → config.controller
 *
 * ESM tolerated it because nothing was called at module-evaluation time, but a
 * cycle that only works by accident is a defect waiting for the first top-level
 * call to expose it. This module is a leaf — it imports nothing but the model —
 * so both sides can depend on it and neither depends on the other.
 *
 * This is a MOVE, not a duplication: there remains exactly one definition of how
 * configuration resolves.
 */

/** Newest live configuration for a scope, or null. */
export const liveConfig = (scope, scopeValue = null) =>
  InventoryConfig.findOne({
    scope,
    scopeValue: scope === 'global' ? null : scopeValue,
    supersededAt: null,
    effectiveFrom: { $lte: new Date() },
  })
    .sort({ effectiveFrom: -1 })
    .lean();

/**
 * Resolve the effective configuration for a SKU context, walking the chain from
 * most specific to global: sku → category → brand → global.
 *
 * A global row always exists (seeded on first boot), so this resolves for every
 * SKU and a health band is never undefined for want of configuration.
 */
export const resolveConfig = async ({ skuCode = null, category = null, brand = null } = {}) => {
  const candidates = [
    skuCode ? ['sku', skuCode] : null,
    category ? ['category', category] : null,
    brand ? ['brand', brand] : null,
    ['global', null],
  ].filter(Boolean);

  for (const [scope, value] of candidates) {
    const found = await liveConfig(scope, value);
    if (found) return found;
  }
  return null;
};

export default { liveConfig, resolveConfig };
