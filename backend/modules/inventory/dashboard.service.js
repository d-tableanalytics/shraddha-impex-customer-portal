import StockHealth, { HEALTH_BAND_NAMES } from '../../models/StockHealth.js';
import StockBalance from '../../models/StockBalance.js';
import StockMovement from '../../models/StockMovement.js';
import { Product } from '../../models/Product.js';

/**
 * Inventory Dashboard read model (IMS Module M5).
 *
 * A PRESENTATION LAYER. It counts, sums and groups values that Modules M3 and
 * M4 already computed, and derives no inventory semantics of its own.
 *
 * The line is drawn precisely:
 *
 *   ALLOWED   count SKUs per band · sum onHand across rows · bucket a
 *             precomputed coverageDays into ranges · order by a projected
 *             percentage · express a count as a proportion of another count
 *
 *   FORBIDDEN compute Max Level · compute Available % · decide a band ·
 *             derive coverage days · apply a threshold · read a legacy field
 *
 * Every figure the dashboard returns is traceable to a stored projection field.
 * If a number here disagrees with the Health screen, the projection is stale —
 * not the dashboard, because the dashboard has no opinion of its own.
 *
 * Scope note: no trend, no snapshots, no alerts. Trend needs the nightly
 * `inventorysnapshots` job that belongs to M6.
 */

// ─── Filter resolution ───────────────────────────────────────────────────────

/**
 * `stockhealth` carries `brand` but not `category`, because health is derived
 * per SKU and category plays no part in the calculation. Filtering by category
 * therefore resolves to a SKU set first, against the indexed product master,
 * rather than joining every health row.
 *
 * Capped: a category covering more than the cap degrades to "no category
 * filter" rather than building a multi-thousand-element `$in`. Denormalising
 * category onto `stockhealth` would remove this entirely, but that is an M4
 * model change and out of scope here.
 */
const CATEGORY_SKU_CAP = 5000;

const resolveScope = async ({ brands, brand, category }) => {
  const scope = { brand: { $in: brands } };
  if (brand) scope.brand = brand;

  let categoryTruncated = false;
  if (category) {
    const skus = await Product.distinct('skuCode', {
      category,
      brand: brand ? brand : { $in: brands },
    });
    if (skus.length > CATEGORY_SKU_CAP) {
      categoryTruncated = true;
    } else {
      scope.skuCode = { $in: skus };
    }
  }

  return { scope, categoryTruncated };
};

// ─── Health facets ───────────────────────────────────────────────────────────

/**
 * Coverage buckets, in days. Chosen around the lead times actually present in
 * the data (180 and 365 days), so the buckets answer "will this outlast its
 * replenishment window" rather than being round numbers for their own sake.
 */
const COVERAGE_BOUNDARIES = [0, 7, 30, 90, 180, 365];

const COVERAGE_LABELS = {
  0: 'Under 7 days',
  7: '7 – 30 days',
  30: '30 – 90 days',
  90: '90 – 180 days',
  180: '180 – 365 days',
  365: 'Over 365 days',
  Other: 'Over 365 days',
};

/**
 * One pipeline over `stockhealth` producing every health-derived panel.
 *
 * `$facet` runs the sub-pipelines against a single pass of the matched set, so
 * the seven panels below cost one round trip rather than seven — and, more
 * importantly, they are guaranteed to describe the same snapshot rather than
 * seven reads that could disagree mid-update.
 */
const healthFacets = async (scope, { topCount = 10 } = {}) => {
  const [result] = await StockHealth.aggregate([
    { $match: scope },
    {
      $facet: {
        // KPI cards — one row per band.
        bands: [{ $group: { _id: '$band', count: { $sum: 1 } } }],

        // Planning completion. Counts a flag M4 set; the dashboard does not
        // decide what "plannable" means.
        planning: [{ $group: { _id: '$plannable', count: { $sum: 1 } } }],

        // Why the unplannable ones are unplannable — the data-cleanup worklist.
        planningGaps: [
          { $match: { plannable: false } },
          { $unwind: '$notPlannableReasons' },
          { $group: { _id: '$notPlannableReasons', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ],

        // Coverage distribution over the PRECOMPUTED coverageDays. Only the
        // grouping is presentational; the value itself comes from M4.
        coverage: [
          { $match: { plannable: true, coverageDays: { $ne: null } } },
          {
            $bucket: {
              groupBy: '$coverageDays',
              boundaries: COVERAGE_BOUNDARIES,
              default: 'Other',
              output: { count: { $sum: 1 } },
            },
          },
        ],

        // Health-side stock totals, so the band mix can be read by volume as
        // well as by SKU count.
        bandVolume: [
          { $group: { _id: '$band', onHand: { $sum: '$onHand' } } },
        ],

        // Worst-covered first. Ordered by a projected percentage — no ranking
        // logic of the dashboard's own.
        topCritical: [
          { $match: { band: { $in: ['Out of Stock', 'Critical'] }, plannable: true } },
          { $sort: { replenishmentPercent: 1, skuCode: 1 } },
          { $limit: topCount },
          {
            $project: {
              _id: 0, skuCode: 1, brand: 1, band: 1, onHand: 1, available: 1,
              maxLevel: 1, reorderLevel: 1, replenishmentPercent: 1, coverageDays: 1,
            },
          },
        ],

        // Furthest above target first.
        topOverstock: [
          { $match: { band: 'Overstock' } },
          { $sort: { replenishmentPercent: -1, skuCode: 1 } },
          { $limit: topCount },
          {
            $project: {
              _id: 0, skuCode: 1, brand: 1, band: 1, onHand: 1, available: 1,
              maxLevel: 1, replenishmentPercent: 1, coverageDays: 1,
            },
          },
        ],

        // Freshness of the projection itself, so a stale dashboard can say so.
        freshness: [
          { $group: { _id: null, oldest: { $min: '$computedAt' }, newest: { $max: '$computedAt' } } },
        ],

        total: [{ $count: 'n' }],
      },
    },
  ]);

  return result;
};

// ─── Shaping ─────────────────────────────────────────────────────────────────

const shapeBands = (rows) => {
  // Every band present with an explicit zero — a missing key renders as a gap
  // in the chart and reads as "no data" rather than "none in this state".
  const counts = Object.fromEntries(HEALTH_BAND_NAMES.map((b) => [b, 0]));
  for (const r of rows) if (r._id in counts) counts[r._id] = r.count;
  return counts;
};

const shapeCoverage = (rows) =>
  rows.map((r) => ({
    bucket: COVERAGE_LABELS[r._id] ?? String(r._id),
    lowerBound: r._id === 'Other' ? 365 : r._id,
    count: r.count,
  }));

// ─── Public read model ───────────────────────────────────────────────────────

/**
 * Build the complete dashboard payload.
 *
 * Four database round trips regardless of catalogue size: one faceted health
 * pipeline, one balance aggregation, one activity read, one catalogue count.
 * All four run concurrently.
 */
export const buildDashboard = async ({
  brands,
  brand = null,
  category = null,
  locationCode = null,
  from = null,
  to = null,
  activityLimit = 15,
  topCount = 10,
}) => {
  const { scope, categoryTruncated } = await resolveScope({ brands, brand, category });

  // Balances carry a location dimension; health does not, because planning
  // parameters are per-SKU. A location filter therefore narrows the stock
  // summary while the health panels stay network-wide — stated in the response
  // rather than silently applied to one and not the other.
  const balanceScope = { ...scope };
  if (locationCode) balanceScope.locationCode = locationCode;

  const activityScope = { brand: scope.brand };
  if (scope.skuCode) activityScope.skuCode = scope.skuCode;
  if (locationCode) activityScope.locationCode = locationCode;
  if (from || to) {
    activityScope.effectiveDate = {};
    if (from) activityScope.effectiveDate.$gte = from;
    if (to) activityScope.effectiveDate.$lte = to;
  }

  const [health, balanceRows, activity, catalogueTotal, movementWindow] = await Promise.all([
    healthFacets(scope, { topCount }),

    // Inventory summary. Sums of projected quantities — `available` is the
    // stored identity onHand − reserved, summed, not recomputed per row.
    StockBalance.aggregate([
      { $match: balanceScope },
      {
        $group: {
          _id: null,
          onHand: { $sum: '$onHand' },
          reserved: { $sum: '$reserved' },
          incoming: { $sum: '$incoming' },
          outgoing: { $sum: '$outgoing' },
          locations: { $addToSet: '$locationCode' },
          rows: { $sum: 1 },
        },
      },
    ]),

    // Recent activity, straight from the ledger. Nothing is inferred — if a
    // movement was not posted, it does not appear.
    StockMovement.find(activityScope)
      .sort({ effectiveDate: -1, transactionId: -1 })
      .limit(activityLimit)
      .populate('user', 'user email')
      .lean(),

    Product.countDocuments(brand ? { brand } : { brand: { $in: brands } }),

    // How much history exists, so activity panels can state their data window
    // instead of showing a confident-looking near-empty list.
    StockMovement.aggregate([
      { $match: { brand: scope.brand } },
      { $group: { _id: null, earliest: { $min: '$effectiveDate' }, count: { $sum: 1 } } },
    ]),
  ]);

  const bands = shapeBands(health.bands);
  const totalProjected = health.total?.[0]?.n ?? 0;

  const plannableRow = health.planning.find((p) => p._id === true);
  const unplannableRow = health.planning.find((p) => p._id === false);
  const plannable = plannableRow?.count ?? 0;
  const unplannable = unplannableRow?.count ?? 0;

  const balance = balanceRows[0] || {
    onHand: 0, reserved: 0, incoming: 0, outgoing: 0, locations: [], rows: 0,
  };

  const earliest = movementWindow[0]?.earliest ?? null;
  const movementCount = movementWindow[0]?.count ?? 0;

  return {
    asAt: new Date(),

    // Every KPI is a count of projected rows.
    kpis: {
      totalSkus: catalogueTotal,
      // SKUs that have a health record. Lower than totalSkus until the health
      // projection has been built for the whole catalogue.
      projectedSkus: totalProjected,
      healthy: bands.Healthy,
      low: bands.Low,
      critical: bands.Critical,
      outOfStock: bands['Out of Stock'],
      overstock: bands.Overstock,
      unknown: bands.Unknown,
      // A proportion of two counts, not an inventory calculation. The
      // `plannable` flag itself is M4's.
      planningCompletionPercent: totalProjected > 0
        ? Math.round((plannable / totalProjected) * 1000) / 10
        : null,
    },

    // Sums of the balance projection. `available` is summed from stored
    // quantities, never recomputed per row.
    summary: {
      onHand: balance.onHand ?? 0,
      reserved: balance.reserved ?? 0,
      available: (balance.onHand ?? 0) - (balance.reserved ?? 0),
      incoming: balance.incoming ?? 0,
      outgoing: balance.outgoing ?? 0,
      balanceRows: balance.rows ?? 0,
      locationCount: (balance.locations || []).filter(Boolean).length,
      // Inbound movement types are not produced by any approved workflow yet,
      // so these stay at zero until goods receipt ships. Flagged rather than
      // presented as a real measurement of zero.
      inboundTracked: false,
    },

    healthDistribution: {
      byCount: HEALTH_BAND_NAMES.map((band) => ({ band, count: bands[band] })),
      byVolume: HEALTH_BAND_NAMES.map((band) => ({
        band,
        onHand: health.bandVolume.find((v) => v._id === band)?.onHand ?? 0,
      })),
    },

    coverageDistribution: shapeCoverage(health.coverage),

    planning: {
      plannable,
      unplannable,
      total: totalProjected,
      completionPercent: totalProjected > 0
        ? Math.round((plannable / totalProjected) * 1000) / 10
        : null,
      gaps: health.planningGaps.map((g) => ({ reason: g._id, count: g.count })),
    },

    topCritical: health.topCritical,
    topOverstock: health.topOverstock,

    activity: {
      movements: activity.map((m) => ({
        transactionId: m.transactionId,
        batchId: m.batchId,
        skuCode: m.skuCode,
        brand: m.brand,
        locationCode: m.locationCode,
        movementType: m.movementType,
        movementClass: m.movementClass,
        quantity: m.quantity,
        effectiveDate: m.effectiveDate,
        referenceType: m.referenceType,
        referenceId: m.referenceId,
        actorType: m.actorType,
        user: m.user ? { name: m.user.user || m.user.email } : null,
      })),
      // The data window, so a thin feed explains itself instead of looking broken.
      totalMovements: movementCount,
      earliestMovement: earliest,
    },

    // Projection freshness. A dashboard that cannot say how current it is
    // invites the assumption that it is live.
    freshness: {
      healthComputedOldest: health.freshness?.[0]?.oldest ?? null,
      healthComputedNewest: health.freshness?.[0]?.newest ?? null,
    },

    filters: {
      brand, category, locationCode, from, to,
      // Surfaced so the UI can warn rather than silently showing unfiltered data.
      categoryTruncated,
      // Health is network-wide; only the stock summary and activity narrow by
      // location.
      locationAppliesTo: locationCode ? ['summary', 'activity'] : [],
    },
  };
};

export default { buildDashboard };
