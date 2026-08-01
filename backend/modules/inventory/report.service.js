import StockBalance from '../../models/StockBalance.js';
import StockHealth, { HEALTH_BAND_NAMES } from '../../models/StockHealth.js';
import StockMovement, { MOVEMENT_TYPE_NAMES } from '../../models/StockMovement.js';
import InventorySnapshot from '../../models/InventorySnapshot.js';
import SnapshotRun from '../../models/SnapshotRun.js';
import { Product } from '../../models/Product.js';
import { resolveConfig } from './config.service.js';

/**
 * Report Service (IMS Module M6).
 *
 * READ-ONLY. Every report aggregates values that Modules M2, M3 and M4 already
 * computed and stores nothing. The same line M5 drew applies here:
 *
 *   ALLOWED   group · count · sum · sort · compare two stored values ·
 *             bucket a stored timestamp into age ranges
 *
 *   FORBIDDEN compute a balance · compute Available % · decide a band ·
 *             derive Max Level or coverage · invent a threshold
 *
 * Where a report needs a threshold — the aging report's dead-stock cut-off — it
 * READS the configured value rather than choosing one, so reporting and the
 * rest of the system cannot disagree about what "dead" means.
 */

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Whole-page result shape used by every paginated report. */
const paginate = async (model, filter, { page, limit, sort }) => {
  const [rows, total] = await Promise.all([
    model.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
    model.countDocuments(filter),
  ]);
  return { rows, total, page, pages: Math.ceil(total / limit) || 1, limit };
};

/**
 * `stockhealth` and `stockmovements` carry brand but not category, because
 * neither derivation involves it. A category filter therefore resolves against
 * the indexed product master first. Capped, and the cap is reported rather than
 * silently applied — the same approach M5 takes.
 */
const CATEGORY_SKU_CAP = 5000;

const applyCategory = async (filter, { category, brands, brand }) => {
  if (!category) return { filter, categoryTruncated: false };
  const skus = await Product.distinct('skuCode', {
    category,
    brand: brand || { $in: brands },
  });
  if (skus.length > CATEGORY_SKU_CAP) return { filter, categoryTruncated: true };
  return { filter: { ...filter, skuCode: { $in: skus } }, categoryTruncated: false };
};

const brandScope = ({ brands, brand }) => (brand ? { brand } : { brand: { $in: brands } });

// ─── 1. Inventory Summary ────────────────────────────────────────────────────

/**
 * Current position, rolled up by brand and by location.
 *
 * Value/valuation is NOT included: no cost or price field exists anywhere in
 * the schema, so any monetary figure would be invented. The report says so
 * explicitly rather than showing a zero that reads as "nothing is worth
 * anything".
 */
export const inventorySummary = async ({ brands, brand = null, category = null }) => {
  const base = brandScope({ brands, brand });
  const { filter, categoryTruncated } = await applyCategory(base, { category, brands, brand });

  const [byBrand, byLocation, healthRollup, catalogue] = await Promise.all([
    StockBalance.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$brand',
          onHand: { $sum: '$onHand' },
          reserved: { $sum: '$reserved' },
          incoming: { $sum: '$incoming' },
          outgoing: { $sum: '$outgoing' },
          skus: { $addToSet: '$skuCode' },
        },
      },
      { $sort: { _id: 1 } },
    ]),

    StockBalance.aggregate([
      { $match: filter },
      {
        $group: {
          _id: { locationCode: '$locationCode', brand: '$brand' },
          onHand: { $sum: '$onHand' },
          reserved: { $sum: '$reserved' },
          skus: { $addToSet: '$skuCode' },
        },
      },
      { $sort: { '_id.locationCode': 1, '_id.brand': 1 } },
    ]),

    StockHealth.aggregate([
      { $match: filter },
      { $group: { _id: { brand: '$brand', band: '$band' }, count: { $sum: 1 } } },
    ]),

    Product.countDocuments(brand ? { brand } : { brand: { $in: brands } }),
  ]);

  const bandsByBrand = {};
  for (const r of healthRollup) {
    const b = r._id.brand;
    if (!bandsByBrand[b]) bandsByBrand[b] = Object.fromEntries(HEALTH_BAND_NAMES.map((x) => [x, 0]));
    bandsByBrand[b][r._id.band] = r.count;
  }

  const brandRows = byBrand.map((r) => ({
    brand: r._id,
    skuCount: r.skus.length,
    onHand: r.onHand,
    reserved: r.reserved,
    available: r.onHand - r.reserved,
    incoming: r.incoming,
    outgoing: r.outgoing,
    bands: bandsByBrand[r._id] || Object.fromEntries(HEALTH_BAND_NAMES.map((x) => [x, 0])),
  }));

  const grand = brandRows.reduce(
    (a, r) => ({
      skuCount: a.skuCount + r.skuCount,
      onHand: a.onHand + r.onHand,
      reserved: a.reserved + r.reserved,
      available: a.available + r.available,
      incoming: a.incoming + r.incoming,
      outgoing: a.outgoing + r.outgoing,
    }),
    { skuCount: 0, onHand: 0, reserved: 0, available: 0, incoming: 0, outgoing: 0 },
  );

  return {
    generatedAt: new Date(),
    catalogueSkus: catalogue,
    totals: grand,
    byBrand: brandRows,
    byLocation: byLocation.map((r) => ({
      locationCode: r._id.locationCode,
      brand: r._id.brand,
      skuCount: r.skus.length,
      onHand: r.onHand,
      reserved: r.reserved,
      available: r.onHand - r.reserved,
    })),
    // Stated, not silently omitted.
    valuation: {
      supported: false,
      reason: 'No unit cost is recorded on the product master, so stock cannot be valued.',
    },
    categoryTruncated,
  };
};

// ─── 2. Stock Movement Report ────────────────────────────────────────────────

export const movementReport = async ({
  brands, brand = null, category = null, skuCode = null, movementType = null,
  reasonCode = null, referenceId = null, referenceType = null, userId = null,
  locationCode = null, from = null, to = null,
  page = 1, limit = 50, sort = { effectiveDate: -1, transactionId: -1 },
}) => {
  const base = brandScope({ brands, brand });
  const { filter: scoped, categoryTruncated } = await applyCategory(base, { category, brands, brand });

  const filter = { ...scoped };
  if (skuCode) filter.skuCode = skuCode;
  if (movementType) filter.movementType = movementType;
  if (reasonCode) filter.reasonCode = reasonCode;
  if (referenceId) filter.referenceId = referenceId;
  if (referenceType) filter.referenceType = referenceType;
  if (userId) filter.user = userId;
  if (locationCode) filter.locationCode = locationCode;
  if (from || to) {
    filter.effectiveDate = {};
    if (from) filter.effectiveDate.$gte = from;
    if (to) filter.effectiveDate.$lte = to;
  }

  const [{ rows, total, pages }, summary] = await Promise.all([
    paginate(StockMovement, filter, { page, limit, sort }),
    // Totals for the whole filtered set, not just the visible page — a report
    // whose summary describes only page one is misleading.
    StockMovement.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$movementType',
          count: { $sum: 1 },
          quantityIn: { $sum: { $cond: [{ $gt: ['$quantity', 0] }, '$quantity', 0] } },
          quantityOut: { $sum: { $cond: [{ $lt: ['$quantity', 0] }, '$quantity', 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  return {
    generatedAt: new Date(),
    rows: rows.map((m) => ({
      transactionId: m.transactionId,
      batchId: m.batchId,
      effectiveDate: m.effectiveDate,
      postedAt: m.postedAt,
      backdated: m.backdated,
      skuCode: m.skuCode,
      brand: m.brand,
      locationCode: m.locationCode,
      movementType: m.movementType,
      movementClass: m.movementClass,
      quantity: m.quantity,
      beforeQuantity: m.beforeQuantity,
      afterQuantity: m.afterQuantity,
      reasonCode: m.reasonCode,
      referenceType: m.referenceType,
      referenceId: m.referenceId,
      actorType: m.actorType,
    })),
    pagination: { total, page, pages, limit },
    summary: {
      byType: summary.map((s) => ({
        movementType: s._id,
        count: s.count,
        quantityIn: s.quantityIn,
        quantityOut: s.quantityOut,
        net: s.quantityIn + s.quantityOut,
      })),
      totalMovements: summary.reduce((n, s) => n + s.count, 0),
    },
    categoryTruncated,
  };
};

// ─── 3. Stock Health Report ──────────────────────────────────────────────────

export const healthReport = async ({
  brands, brand = null, category = null, band = null, plannable = null,
  maxCoverageDays = null,
  page = 1, limit = 50, sort = { replenishmentPercent: 1, skuCode: 1 },
}) => {
  const base = brandScope({ brands, brand });
  const { filter: scoped, categoryTruncated } = await applyCategory(base, { category, brands, brand });

  const filter = { ...scoped };
  if (band) filter.band = band;
  if (plannable !== null) filter.plannable = plannable;
  if (maxCoverageDays !== null) {
    filter.plannable = true;
    filter.coverageDays = { $lte: maxCoverageDays };
  }

  // Band and planning-gap rollups describe the SCOPE, not the current band
  // filter — otherwise picking "Critical" would report every other band as zero.
  const rollupFilter = { ...filter };
  delete rollupFilter.band;

  const [{ rows, total, pages }, bandRollup, gapRollup] = await Promise.all([
    paginate(StockHealth, filter, { page, limit, sort }),
    StockHealth.aggregate([
      { $match: rollupFilter },
      { $group: { _id: '$band', count: { $sum: 1 }, onHand: { $sum: '$onHand' } } },
    ]),
    StockHealth.aggregate([
      { $match: { ...rollupFilter, plannable: false } },
      { $unwind: '$notPlannableReasons' },
      { $group: { _id: '$notPlannableReasons', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ]);

  const bands = Object.fromEntries(HEALTH_BAND_NAMES.map((b) => [b, { count: 0, onHand: 0 }]));
  for (const r of bandRollup) {
    if (r._id in bands) bands[r._id] = { count: r.count, onHand: r.onHand };
  }

  return {
    generatedAt: new Date(),
    rows: rows.map((h) => ({
      skuCode: h.skuCode,
      brand: h.brand,
      band: h.band,
      onHand: h.onHand,
      reserved: h.reserved,
      available: h.available,
      maxLevel: h.maxLevel,
      reorderLevel: h.reorderLevel,
      replenishmentPercent: h.replenishmentPercent,
      coverageDays: h.coverageDays,
      plannable: h.plannable,
      notPlannableReasons: h.notPlannableReasons,
      formulaVersion: h.formulaVersion,
      computedAt: h.computedAt,
    })),
    pagination: { total, page, pages, limit },
    summary: {
      bands,
      planningGaps: gapRollup.map((g) => ({ reason: g._id, count: g.count })),
    },
    categoryTruncated,
  };
};

// ─── 4. Stock Balance Report ─────────────────────────────────────────────────

export const balanceReport = async ({
  brands, brand = null, category = null, skuCode = null, locationCode = null,
  nonZeroOnly = false,
  page = 1, limit = 50, sort = { skuCode: 1, locationCode: 1 },
}) => {
  const base = brandScope({ brands, brand });
  const { filter: scoped, categoryTruncated } = await applyCategory(base, { category, brands, brand });

  const filter = { ...scoped };
  if (skuCode) filter.skuCode = skuCode;
  if (locationCode) filter.locationCode = locationCode;
  if (nonZeroOnly) filter.$or = [{ onHand: { $ne: 0 } }, { reserved: { $ne: 0 } }];

  const [{ rows, total, pages }, totals] = await Promise.all([
    paginate(StockBalance, filter, { page, limit, sort }),
    StockBalance.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          onHand: { $sum: '$onHand' },
          reserved: { $sum: '$reserved' },
          incoming: { $sum: '$incoming' },
          outgoing: { $sum: '$outgoing' },
          rows: { $sum: 1 },
        },
      },
    ]),
  ]);

  const t = totals[0] || { onHand: 0, reserved: 0, incoming: 0, outgoing: 0, rows: 0 };

  return {
    generatedAt: new Date(),
    rows: rows.map((b) => ({
      skuCode: b.skuCode,
      brand: b.brand,
      locationCode: b.locationCode,
      onHand: b.onHand,
      reserved: b.reserved,
      available: b.onHand - b.reserved,
      incoming: b.incoming,
      outgoing: b.outgoing,
      movementCount: b.movementCount,
      lastMovementAt: b.lastMovementAt,
      lastIssuedAt: b.lastIssuedAt,
    })),
    pagination: { total, page, pages, limit },
    summary: {
      onHand: t.onHand,
      reserved: t.reserved,
      available: t.onHand - t.reserved,
      incoming: t.incoming,
      outgoing: t.outgoing,
      balanceRows: t.rows,
    },
    categoryTruncated,
  };
};

// ─── 5. Inventory Aging Report ───────────────────────────────────────────────

/**
 * Age buckets, in days since the SKU was last ISSUED.
 *
 * Keyed on `lastIssuedAt`, not `lastMovementAt`: a SKU repeatedly reserved and
 * released by expiring bookings looks busy on last-movement while never
 * physically leaving the shelf. That distinction is exactly why M3 tracks the
 * two timestamps separately.
 *
 * The dead-stock cut-off is READ from configuration rather than chosen here, so
 * reporting cannot disagree with the rest of the system about what "dead" means.
 */
const AGE_BOUNDARIES = [0, 30, 90, 180, 365];
const AGE_LABELS = {
  0: '0 – 30 days',
  30: '30 – 90 days',
  90: '90 – 180 days',
  180: '180 – 365 days',
  365: 'Over 365 days',
  Other: 'Over 365 days',
};

export const agingReport = async ({
  brands, brand = null, category = null, locationCode = null,
  page = 1, limit = 50,
}) => {
  const base = brandScope({ brands, brand });
  const { filter: scoped, categoryTruncated } = await applyCategory(base, { category, brands, brand });

  const filter = { ...scoped };
  if (locationCode) filter.locationCode = locationCode;
  // Only stock that exists can age.
  filter.onHand = { $gt: 0 };

  const config = await resolveConfig({ brand });
  const deadStockDays = config?.deadStockDays ?? 180;
  const now = new Date();

  const [buckets, neverIssued, dead, listing] = await Promise.all([
    StockBalance.aggregate([
      { $match: { ...filter, lastIssuedAt: { $ne: null } } },
      { $addFields: { daysSinceIssue: { $dateDiff: { startDate: '$lastIssuedAt', endDate: now, unit: 'day' } } } },
      {
        $bucket: {
          groupBy: '$daysSinceIssue',
          boundaries: AGE_BOUNDARIES,
          default: 'Other',
          output: { count: { $sum: 1 }, onHand: { $sum: '$onHand' } },
        },
      },
    ]),

    // Stock that has never been issued at all. Not an age bucket — an absence
    // of history, which is a different thing and must not be folded in.
    StockBalance.aggregate([
      { $match: { ...filter, lastIssuedAt: null } },
      { $group: { _id: null, count: { $sum: 1 }, onHand: { $sum: '$onHand' } } },
    ]),

    StockBalance.aggregate([
      { $match: { ...filter, lastIssuedAt: { $ne: null } } },
      { $addFields: { daysSinceIssue: { $dateDiff: { startDate: '$lastIssuedAt', endDate: now, unit: 'day' } } } },
      { $match: { daysSinceIssue: { $gte: deadStockDays } } },
      { $group: { _id: null, count: { $sum: 1 }, onHand: { $sum: '$onHand' } } },
    ]),

    // Oldest first — the rows a buyer would actually act on.
    StockBalance.aggregate([
      { $match: filter },
      { $addFields: { daysSinceIssue: { $cond: [{ $eq: ['$lastIssuedAt', null] }, null, { $dateDiff: { startDate: '$lastIssuedAt', endDate: now, unit: 'day' } }] } } },
      { $sort: { daysSinceIssue: -1, onHand: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      {
        $project: {
          _id: 0, skuCode: 1, brand: 1, locationCode: 1, onHand: 1, reserved: 1,
          lastIssuedAt: 1, lastMovementAt: 1, lastReceivedAt: 1, daysSinceIssue: 1,
        },
      },
    ]),
  ]);

  const total = await StockBalance.countDocuments(filter);

  return {
    generatedAt: new Date(),
    deadStockDays,
    buckets: [
      ...buckets.map((b) => ({
        bucket: AGE_LABELS[b._id] ?? String(b._id),
        lowerBoundDays: b._id === 'Other' ? 365 : b._id,
        count: b.count,
        onHand: b.onHand,
      })),
      {
        bucket: 'Never issued',
        lowerBoundDays: null,
        count: neverIssued[0]?.count ?? 0,
        onHand: neverIssued[0]?.onHand ?? 0,
      },
    ],
    deadStock: {
      thresholdDays: deadStockDays,
      count: dead[0]?.count ?? 0,
      onHand: dead[0]?.onHand ?? 0,
    },
    rows: listing,
    pagination: { total, page, pages: Math.ceil(total / limit) || 1, limit },
    categoryTruncated,
  };
};

// ─── 6. Snapshot Comparison ──────────────────────────────────────────────────

/**
 * Compare two snapshot runs.
 *
 * A pure diff of stored values — subtraction and equality, nothing more. No
 * value is recomputed, so comparing two historical snapshots yields the same
 * result today as it will next year, even if formulas change in between.
 */
export const compareSnapshots = async ({ runIdA, runIdB, brands, brand = null, changedOnly = true, limit = 500 }) => {
  const [runA, runB] = await Promise.all([
    SnapshotRun.findOne({ runId: runIdA }).lean(),
    SnapshotRun.findOne({ runId: runIdB }).lean(),
  ]);
  if (!runA || !runB) {
    const err = new Error(`Snapshot run ${!runA ? runIdA : runIdB} not found.`);
    err.status = 404;
    throw err;
  }

  const scope = brandScope({ brands, brand });
  const [rowsA, rowsB] = await Promise.all([
    InventorySnapshot.find({ runId: runIdA, ...scope }).lean(),
    InventorySnapshot.find({ runId: runIdB, ...scope }).lean(),
  ]);

  const key = (r) => `${r.skuCode}::${r.brand}::${r.locationCode ?? ''}`;
  const mapA = new Map(rowsA.map((r) => [key(r), r]));
  const mapB = new Map(rowsB.map((r) => [key(r), r]));
  const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);

  const changes = [];
  const summary = {
    compared: 0, unchanged: 0, added: 0, removed: 0,
    balanceChanged: 0, healthChanged: 0, coverageChanged: 0, planningChanged: 0,
    netOnHand: 0, netReserved: 0, netAvailable: 0,
  };

  for (const k of allKeys) {
    const a = mapA.get(k);
    const b = mapB.get(k);
    summary.compared++;

    if (!a) { summary.added++; }
    if (!b) { summary.removed++; }

    const onHandDelta = (b?.onHand ?? 0) - (a?.onHand ?? 0);
    const reservedDelta = (b?.reserved ?? 0) - (a?.reserved ?? 0);
    const availableDelta = (b?.available ?? 0) - (a?.available ?? 0);
    const coverageDelta = (b?.coverageDays ?? null) === null || (a?.coverageDays ?? null) === null
      ? null
      : b.coverageDays - a.coverageDays;

    const balanceChanged = onHandDelta !== 0 || reservedDelta !== 0;
    const healthChanged = (a?.band ?? null) !== (b?.band ?? null);
    const planningChanged = (a?.plannable ?? false) !== (b?.plannable ?? false);
    const coverageChanged = coverageDelta !== null && coverageDelta !== 0;

    if (balanceChanged) summary.balanceChanged++;
    if (healthChanged) summary.healthChanged++;
    if (coverageChanged) summary.coverageChanged++;
    if (planningChanged) summary.planningChanged++;

    summary.netOnHand += onHandDelta;
    summary.netReserved += reservedDelta;
    summary.netAvailable += availableDelta;

    const changed = balanceChanged || healthChanged || planningChanged || coverageChanged || !a || !b;
    if (!changed) { summary.unchanged++; if (changedOnly) continue; }

    if (changes.length < limit) {
      const source = b || a;
      changes.push({
        skuCode: source.skuCode,
        brand: source.brand,
        locationCode: source.locationCode,
        status: !a ? 'added' : !b ? 'removed' : 'changed',
        onHand: { from: a?.onHand ?? null, to: b?.onHand ?? null, delta: onHandDelta },
        reserved: { from: a?.reserved ?? null, to: b?.reserved ?? null, delta: reservedDelta },
        available: { from: a?.available ?? null, to: b?.available ?? null, delta: availableDelta },
        band: { from: a?.band ?? null, to: b?.band ?? null, changed: healthChanged },
        coverageDays: { from: a?.coverageDays ?? null, to: b?.coverageDays ?? null, delta: coverageDelta },
        maxLevel: { from: a?.maxLevel ?? null, to: b?.maxLevel ?? null },
        plannable: { from: a?.plannable ?? null, to: b?.plannable ?? null, changed: planningChanged },
        // A band can move because the FORMULA changed rather than the stock —
        // surfaced so a reader is not left guessing which.
        formulaVersion: { from: a?.formulaVersion ?? null, to: b?.formulaVersion ?? null },
      });
    }
  }

  return {
    generatedAt: new Date(),
    from: { runId: runA.runId, snapshotDate: runA.snapshotDate, rowCount: runA.rowCount, totals: runA.totals },
    to: { runId: runB.runId, snapshotDate: runB.snapshotDate, rowCount: runB.rowCount, totals: runB.totals },
    summary,
    changes,
    truncated: changes.length >= limit,
  };
};

export const REPORT_KEYS = [
  'inventory-summary', 'movements', 'health', 'balances', 'aging', 'snapshot-comparison',
];

export const MOVEMENT_TYPES = MOVEMENT_TYPE_NAMES;
export const BANDS = HEALTH_BAND_NAMES;

export default {
  inventorySummary, movementReport, healthReport, balanceReport,
  agingReport, compareSnapshots, REPORT_KEYS,
};
