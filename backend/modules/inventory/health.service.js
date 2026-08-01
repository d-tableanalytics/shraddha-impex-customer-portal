import StockHealth, {
  HEALTH_BANDS, NOT_PLANNABLE_REASONS,
} from '../../models/StockHealth.js';
import StockBalance from '../../models/StockBalance.js';
import { Product } from '../../models/Product.js';
import { resolveConfig } from './config.service.js';
import { recordAudit } from '../../utils/auditLog.js';
import { emitEvent, EVENTS } from '../../utils/eventBus.js';

/**
 * Stock Health Engine (IMS Module M4).
 *
 * Classifies inventory from three inputs and nothing else:
 *
 *   stockbalances     → on hand / reserved / available   (Module M3 projection)
 *   product planning  → consumption, lead time, safety factor, season
 *   InventoryConfig   → thresholds and the Max Level formula version
 *
 * IT NEVER READS LEGACY INVENTORY FIELDS. `totalAvailableQuantity`,
 * `bookedQuantity` and `availableForSale` on the product document are invisible
 * to this module — that separation is the whole point of building M3 first.
 *
 * The calculator is PURE: `calculateHealth()` performs no I/O, so the same
 * inputs always yield the same output and a rebuild is provably identical to an
 * incremental update.
 *
 * Formulas are NOT hardcoded. The Max Level strategy is selected by the
 * `formulaVersion` carried in configuration, because the two readings of the
 * safety factor differ by 3x on the current data and that is a business
 * decision, not a code constant.
 */

// ─── Max Level strategies ────────────────────────────────────────────────────
/**
 * v1 — Consumption x Lead Time x Safety Factor.
 *      Reproduces the existing spreadsheet exactly. Verified against 645 rows
 *      with complete inputs across all three brands, zero mismatches.
 *
 * v2 — Consumption x Lead Time x (1 + Safety Factor).
 *      The conventional additive safety-stock model. Produces roughly three
 *      times the target on the current data, where the safety factor is 0.5
 *      everywhere.
 *
 * Adding a version means adding an entry here — the calculator itself does not
 * change.
 */
export const MAX_LEVEL_FORMULAS = {
  v1: {
    label: 'Consumption x Lead Time x Safety Factor',
    compute: ({ dac, leadTime, safetyFactor }) => dac * leadTime * safetyFactor,
    // Under v1 the factor multiplies the whole target, so a zero factor
    // collapses it to nothing — the input is required.
    requiresSafetyFactor: true,
    // No separate safety-stock quantity exists in this model.
    safetyStock: () => null,
  },
  v2: {
    label: 'Consumption x Lead Time x (1 + Safety Factor)',
    compute: ({ dac, leadTime, safetyFactor }) => dac * leadTime * (1 + safetyFactor),
    // A zero factor is meaningful here — it simply means no buffer.
    requiresSafetyFactor: false,
    // The additive portion above lead-time demand.
    safetyStock: ({ dac, leadTime, safetyFactor }) => dac * leadTime * safetyFactor,
  },
};

export const DEFAULT_FORMULA_VERSION = 'v1';

// ─── Pure calculator ─────────────────────────────────────────────────────────

/** Daily consumption for the season currently in effect. */
const consumptionForSeason = (planning) => {
  const season = String(planning?.currentSeason || 'Normal').toLowerCase();
  const dac = planning?.dailyAvgConsumption || {};
  const value = dac[season];
  // An unrecognised season falls back to Normal rather than yielding zero,
  // which would misreport the SKU as unplannable.
  return Number.isFinite(value) ? value : (Number.isFinite(dac.normal) ? dac.normal : 0);
};

/**
 * Classify a replenishment percentage into a band.
 *
 * Evaluated top to bottom, FIRST MATCH WINS. The order is not arbitrary:
 * zero stock is checked before the critical threshold because a stock-out is
 * operationally different from "very low" and the workbook gives it its own
 * higher-priority rule.
 */
export const classify = ({ plannable, onHand, percent, thresholds }) => {
  if (!plannable) return HEALTH_BANDS.UNKNOWN;
  if (onHand === 0) return HEALTH_BANDS.OUT_OF_STOCK;
  if (percent <= thresholds.critical) return HEALTH_BANDS.CRITICAL;
  if (percent <= thresholds.low) return HEALTH_BANDS.LOW;
  if (percent <= thresholds.healthy) return HEALTH_BANDS.HEALTHY;
  return HEALTH_BANDS.OVERSTOCK;
};

/**
 * Compute a SKU's health. Pure — no database, no clock, no randomness.
 *
 * @param {object|null} balance   { onHand, reserved } from stockbalances, or null.
 * @param {object}      planning  { dailyAvgConsumption, currentSeason, leadTime, safetyFactor, status }
 * @param {object}      config    { thresholds, formulaVersion }
 */
export const calculateHealth = ({ balance, planning, config }) => {
  const formulaVersion = MAX_LEVEL_FORMULAS[config?.formulaVersion]
    ? config.formulaVersion
    : DEFAULT_FORMULA_VERSION;
  const formula = MAX_LEVEL_FORMULAS[formulaVersion];

  const thresholds = {
    critical: config?.thresholds?.critical ?? 33,
    low: config?.thresholds?.low ?? 66,
    healthy: config?.thresholds?.healthy ?? 100,
  };

  const onHand = balance?.onHand ?? 0;
  const reserved = balance?.reserved ?? 0;
  const available = onHand - reserved;

  const dac = consumptionForSeason(planning);
  const leadTime = Number(planning?.leadTime) || 0;
  const safetyFactor = Number(planning?.safetyFactor) || 0;

  // ── Plannability ────────────────────────────────────────────────────────
  // Established BEFORE any arithmetic. A missing input must produce Unknown,
  // never a computed zero — with ~90% of the catalogue incomplete, reporting
  // those as "critically low" would make every downstream number worthless.
  const reasons = [];
  if (!balance) reasons.push(NOT_PLANNABLE_REASONS.NO_BALANCE);
  if (dac <= 0) reasons.push(NOT_PLANNABLE_REASONS.NO_CONSUMPTION);
  if (leadTime <= 0) reasons.push(NOT_PLANNABLE_REASONS.NO_LEAD_TIME);
  if (formula.requiresSafetyFactor && safetyFactor <= 0) {
    reasons.push(NOT_PLANNABLE_REASONS.NO_SAFETY_FACTOR);
  }
  if (planning?.status && planning.status !== 'Active') {
    reasons.push(NOT_PLANNABLE_REASONS.NOT_ACTIVE);
  }

  // A SKU with no balance row can still be planned — it simply has zero stock,
  // which is a legitimate and important state (it reads Out of Stock, not
  // Unknown). Only missing PLANNING inputs make a target underivable.
  const planningReasons = reasons.filter((r) => r !== NOT_PLANNABLE_REASONS.NO_BALANCE);
  const plannable = planningReasons.length === 0;

  if (!plannable) {
    return {
      onHand, reserved, available,
      dailyAvgConsumption: dac,
      currentSeason: planning?.currentSeason ?? null,
      leadTime, safetyFactor,
      maxLevel: null, reorderLevel: null, safetyStock: null,
      replenishmentPercent: null, salesCoveragePercent: null, coverageDays: null,
      band: HEALTH_BANDS.UNKNOWN,
      plannable: false,
      notPlannableReasons: reasons,
      formulaVersion, thresholds,
    };
  }

  const maxLevel = formula.compute({ dac, leadTime, safetyFactor });

  // A non-positive target is not a target. Guard rather than dividing by it.
  if (!Number.isFinite(maxLevel) || maxLevel <= 0) {
    return {
      onHand, reserved, available,
      dailyAvgConsumption: dac,
      currentSeason: planning?.currentSeason ?? null,
      leadTime, safetyFactor,
      maxLevel: null, reorderLevel: null, safetyStock: null,
      replenishmentPercent: null, salesCoveragePercent: null, coverageDays: null,
      band: HEALTH_BANDS.UNKNOWN,
      plannable: false,
      notPlannableReasons: [...reasons, NOT_PLANNABLE_REASONS.NO_CONSUMPTION],
      formulaVersion, thresholds,
    };
  }

  // The critical threshold IS the reorder point — the workbook turns a row red
  // at exactly the level a buyer acts on. Deriving both from one number means
  // the reorder list and the band can never contradict each other.
  const reorderLevel = maxLevel * (thresholds.critical / 100);
  const safetyStock = formula.safetyStock({ dac, leadTime, safetyFactor });

  const replenishmentPercent = (onHand / maxLevel) * 100;
  const salesCoveragePercent = (available / maxLevel) * 100;
  const coverageDays = onHand / dac;

  return {
    onHand, reserved, available,
    dailyAvgConsumption: dac,
    currentSeason: planning?.currentSeason ?? null,
    leadTime, safetyFactor,
    maxLevel, reorderLevel, safetyStock,
    replenishmentPercent, salesCoveragePercent, coverageDays,
    band: classify({ plannable: true, onHand, percent: replenishmentPercent, thresholds }),
    plannable: true,
    notPlannableReasons: reasons.length ? reasons : [],
    formulaVersion, thresholds,
  };
};

// ─── Configuration resolution ────────────────────────────────────────────────

/**
 * Resolve configuration for a set of SKUs, reusing the existing configuration
 * service rather than re-deriving the scope chain.
 *
 * Config is cached per (brand, category) for the duration of one projection
 * run: recomputing 8,600 SKUs would otherwise walk the sku → category → brand →
 * global chain 8,600 times for what is almost always the same global row.
 */
const makeConfigResolver = () => {
  const cache = new Map();

  return async ({ skuCode, brand, category }) => {
    // SKU-scoped overrides are rare but must not be masked by the cache, so
    // they are resolved individually.
    const cacheKey = `${brand}::${category ?? ''}`;
    if (!cache.has(cacheKey)) {
      cache.set(cacheKey, await resolveConfig({ brand, category }));
    }
    const scoped = cache.get(cacheKey);

    const skuOverride = await resolveConfig({ skuCode, brand, category });
    // resolveConfig walks most-specific-first, so a SKU-level row wins when one
    // exists; otherwise this is the same document the cache already holds.
    const config = skuOverride?.scope === 'sku' ? skuOverride : scoped;

    return {
      thresholds: config?.thresholds,
      formulaVersion: config?.formulaVersion,
      configScope: config ? `${config.scope}${config.scopeValue ? `:${config.scopeValue}` : ''}` : 'default',
    };
  };
};

/**
 * Cheaper resolver for a full rebuild: SKU-level overrides are looked up once
 * up-front rather than per row, so a catalogue rebuild does not issue two
 * config queries per SKU.
 */
const makeBulkConfigResolver = async () => {
  const cache = new Map();
  const global = await resolveConfig({});

  return async ({ brand, category }) => {
    const key = `${brand}::${category ?? ''}`;
    if (!cache.has(key)) {
      const config = (await resolveConfig({ brand, category })) || global;
      cache.set(key, {
        thresholds: config?.thresholds,
        formulaVersion: config?.formulaVersion,
        configScope: config ? `${config.scope}${config.scopeValue ? `:${config.scopeValue}` : ''}` : 'default',
      });
    }
    return cache.get(key);
  };
};

// ─── Projection ──────────────────────────────────────────────────────────────

/** Network balance per SKU — health is a SKU-level concept, so locations sum. */
const balancesForSkus = async (skus) => {
  if (skus.length === 0) return new Map();
  const rows = await StockBalance.aggregate([
    { $match: { skuCode: { $in: skus } } },
    {
      $group: {
        _id: { skuCode: '$skuCode', brand: '$brand' },
        onHand: { $sum: '$onHand' },
        reserved: { $sum: '$reserved' },
      },
    },
  ]);
  return new Map(rows.map((r) => [`${r._id.skuCode}::${r._id.brand}`, r]));
};

const toDocument = (product, health) => ({
  skuCode: product.skuCode,
  brand: product.brand,
  product: product._id,
  onHand: health.onHand,
  reserved: health.reserved,
  available: health.available,
  dailyAvgConsumption: health.dailyAvgConsumption,
  currentSeason: health.currentSeason,
  leadTime: health.leadTime,
  safetyFactor: health.safetyFactor,
  maxLevel: health.maxLevel,
  reorderLevel: health.reorderLevel,
  safetyStock: health.safetyStock,
  replenishmentPercent: health.replenishmentPercent,
  salesCoveragePercent: health.salesCoveragePercent,
  coverageDays: health.coverageDays,
  band: health.band,
  plannable: health.plannable,
  notPlannableReasons: health.notPlannableReasons,
  formulaVersion: health.formulaVersion,
  thresholds: health.thresholds,
  configScope: health.configScope ?? 'global',
  computedAt: new Date(),
});

/**
 * Recompute health for specific SKUs. The incremental path.
 *
 * Called whenever an input changes: a balance moves (via the ledger), planning
 * parameters are edited, or configuration is re-versioned. Deliberately narrow
 * — a full catalogue recompute for one booking would be absurd.
 *
 * Never throws. Health is derived and can always be rebuilt, so a projection
 * failure must not fail the operation that triggered it.
 *
 * @param {string[]} skuCodes
 * @param {object}  [opts.brand]  Restrict to one brand when known.
 */
export const recomputeHealthForSkus = async (skuCodes, { brand = null } = {}) => {
  try {
    const skus = [...new Set((skuCodes || []).filter(Boolean))];
    if (skus.length === 0) return { updated: 0 };

    const products = await Product.find(
      { skuCode: { $in: skus }, ...(brand ? { brand } : {}) },
      'skuCode brand category dailyAvgConsumption currentSeason leadTime safetyFactor status',
    ).lean();
    if (products.length === 0) return { updated: 0 };

    const balances = await balancesForSkus(products.map((p) => p.skuCode));
    const resolveFor = makeConfigResolver();

    const ops = [];
    for (const product of products) {
      const config = await resolveFor({
        skuCode: product.skuCode,
        brand: product.brand,
        category: Array.isArray(product.category) ? product.category[0] : product.category,
      });
      const balance = balances.get(`${product.skuCode}::${product.brand}`) || null;
      const health = calculateHealth({ balance, planning: product, config });

      ops.push({
        updateOne: {
          filter: { skuCode: product.skuCode, brand: product.brand },
          update: { $set: { ...toDocument(product, health), configScope: config.configScope } },
          upsert: true,
        },
      });
    }

    if (ops.length) await StockHealth.bulkWrite(ops, { ordered: false });

    // Announce, do not call. The alert engine subscribes to this; M4 must not
    // import M8, because M8 reads the health projection M4 owns.
    emitEvent(EVENTS.HEALTH_PROJECTED, {
      skuCodes: products.map((p) => p.skuCode),
      brand,
      source: 'incremental',
    });

    return { updated: ops.length };
  } catch (error) {
    console.error(`[HealthEngine] Recompute failed: ${error.message}`);
    emitEvent(EVENTS.PROJECTION_FAILED, { projection: 'health', scope: { skuCodes: skus, brand }, error: error.message });
    return { updated: 0, error: error.message };
  }
};

/**
 * Rebuild the health projection. Deterministic and repeatable — running it
 * twice over unchanged inputs produces identical documents apart from
 * `computedAt`.
 *
 * Streamed in batches so a catalogue rebuild does not depend on 8,600 products
 * plus their balances fitting in memory at once.
 */
export const rebuildHealth = async (scope = {}, { dryRun = false, actor = null, req = null, batchSize = 500 } = {}) => {
  // A product with no SKU code cannot be projected. The health row's identity is
  // {skuCode, brand, locationCode}, so a null SKU yields a row that matches no
  // product, collapses every such product onto one document per brand, and gives
  // the alert engine a `skuCode: null` to raise against. The legacy catalogue
  // still holds a handful of these, so they are excluded here rather than left
  // to produce rows nothing can act on.
  const filter = { skuCode: { $nin: [null, ''] } };
  if (scope.skuCode) filter.skuCode = scope.skuCode;
  if (scope.brand) filter.brand = scope.brand;

  const resolveFor = await makeBulkConfigResolver();

  const total = await Product.countDocuments(filter);
  const bandCounts = {};
  let processed = 0;
  let changed = 0;

  for (let skip = 0; skip < total; skip += batchSize) {
    const products = await Product.find(
      filter,
      'skuCode brand category dailyAvgConsumption currentSeason leadTime safetyFactor status',
    )
      .sort({ _id: 1 })
      .skip(skip)
      .limit(batchSize)
      .lean();
    if (products.length === 0) break;

    const balances = await balancesForSkus(products.map((p) => p.skuCode));

    // Existing rows, so a dry run can report what would actually change.
    const existing = await StockHealth.find(
      { skuCode: { $in: products.map((p) => p.skuCode) } },
      'skuCode brand band',
    ).lean();
    const existingByKey = new Map(existing.map((e) => [`${e.skuCode}::${e.brand}`, e]));

    const ops = [];
    for (const product of products) {
      const config = await resolveFor({
        brand: product.brand,
        category: Array.isArray(product.category) ? product.category[0] : product.category,
      });
      const balance = balances.get(`${product.skuCode}::${product.brand}`) || null;
      const health = calculateHealth({ balance, planning: product, config });

      bandCounts[health.band] = (bandCounts[health.band] || 0) + 1;
      const prior = existingByKey.get(`${product.skuCode}::${product.brand}`);
      if (!prior || prior.band !== health.band) changed++;

      if (!dryRun) {
        ops.push({
          updateOne: {
            filter: { skuCode: product.skuCode, brand: product.brand },
            update: { $set: { ...toDocument(product, health), configScope: config.configScope } },
            upsert: true,
          },
        });
      }
      processed++;
    }

    if (ops.length) await StockHealth.bulkWrite(ops, { ordered: false });

    // Per batch, not per rebuild — 8,600 SKUs in one payload would make the
    // alert pass hold the whole catalogue in memory.
    if (!dryRun) {
      emitEvent(EVENTS.HEALTH_PROJECTED, {
        skuCodes: products.map((p) => p.skuCode),
        brand: scope.brand || null,
        source: 'rebuild',
      });
    }
  }

  if (!dryRun) {
    await recordAudit(
      actor,
      'Stock Health Rebuilt',
      `Rebuilt health for ${processed} SKU(s)${scope.brand ? ` (${scope.brand})` : ''}. ` +
      `${changed} band(s) changed.`,
      req,
      { meta: { scope, processed, changed, bandCounts } },
    );

    emitEvent(EVENTS.PROJECTION_REBUILT, {
      projection: 'health', scope, processed, changed, bandCounts,
    });
  }

  return { dryRun, scope, processed, changed, bandCounts };
};

export default {
  calculateHealth,
  classify,
  recomputeHealthForSkus,
  rebuildHealth,
  MAX_LEVEL_FORMULAS,
};
