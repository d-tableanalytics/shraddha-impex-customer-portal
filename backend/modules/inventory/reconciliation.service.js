import StockMovement, { MOVEMENT_CLASS } from '../../models/StockMovement.js';
import StockBalance, { deriveBalance } from '../../models/StockBalance.js';
import { Product } from '../../models/Product.js';

/**
 * Reconciliation (IMS Module M3).
 *
 * During dual-write there are THREE numbers for the same stock, and this is
 * what compares them:
 *
 *   LEGACY      products.totalAvailableQuantity / bookedQuantity
 *               Still authoritative. Every existing workflow reads and writes it.
 *   LEDGER      the sum of stockmovements — the eventual source of truth
 *   PROJECTION  stockbalances — what the Balance Engine has folded in so far
 *
 * Two independent comparisons matter, and conflating them would hide which
 * half is broken:
 *
 *   projection vs ledger  → the Balance Engine missed or double-counted an
 *                           update. Fixed by rebuildBalances().
 *   ledger vs legacy      → dual-write missed a mutation, or the ledger has a
 *                           movement the legacy path never made. This is the
 *                           number that must reach zero before the legacy path
 *                           can be retired.
 *
 * NOTHING HERE WRITES. Reconciliation reports; it never silently corrects a
 * legacy value, because a mismatch is a question about which side is wrong and
 * that is not a decision a report may take.
 */

/**
 * A SKU's legacy figures carry no location dimension — the legacy schema has
 * one balance per product. Ledger and projection are per-location, so they are
 * summed to the SKU level before comparison. While a single DEFAULT location is
 * in use this is exact; once multi-location is enabled the legacy side simply
 * has no equivalent to compare against, which the report states rather than
 * papering over.
 */
const EPSILON = 0; // integer quantities — any difference is a real difference

const compare = (legacy, ledger, projection) => {
  const issues = [];

  if (Math.abs((ledger.onHand ?? 0) - (projection.onHand ?? 0)) > EPSILON) {
    issues.push({
      kind: 'projection-drift',
      field: 'onHand',
      ledger: ledger.onHand,
      projection: projection.onHand,
      delta: (projection.onHand ?? 0) - (ledger.onHand ?? 0),
    });
  }
  if (Math.abs((ledger.reserved ?? 0) - (projection.reserved ?? 0)) > EPSILON) {
    issues.push({
      kind: 'projection-drift',
      field: 'reserved',
      ledger: ledger.reserved,
      projection: projection.reserved,
      delta: (projection.reserved ?? 0) - (ledger.reserved ?? 0),
    });
  }

  if (legacy) {
    if (Math.abs((legacy.onHand ?? 0) - (ledger.onHand ?? 0)) > EPSILON) {
      issues.push({
        kind: 'legacy-mismatch',
        field: 'onHand',
        legacy: legacy.onHand,
        ledger: ledger.onHand,
        delta: (ledger.onHand ?? 0) - (legacy.onHand ?? 0),
      });
    }
    if (Math.abs((legacy.reserved ?? 0) - (ledger.reserved ?? 0)) > EPSILON) {
      issues.push({
        kind: 'legacy-mismatch',
        field: 'reserved',
        legacy: legacy.reserved,
        ledger: ledger.reserved,
        delta: (ledger.reserved ?? 0) - (legacy.reserved ?? 0),
      });
    }
  }

  return issues;
};

/**
 * Run reconciliation.
 *
 * @param {object}  scope   { skuCode, brand } — omit for the whole catalogue.
 * @param {object}  options
 * @param {boolean} options.includeUntracked  Report SKUs with legacy stock but
 *                  no ledger history at all. During dual-write that is the
 *                  normal state for everything that has not moved yet, so it is
 *                  off by default — otherwise the report is 8,000 rows of noise.
 * @param {number}  options.limit  Cap on returned detail rows.
 */
export const reconcile = async (scope = {}, { includeUntracked = false, limit = 200 } = {}) => {
  const productFilter = {};
  if (scope.skuCode) productFilter.skuCode = scope.skuCode;
  if (scope.brand) productFilter.brand = scope.brand;

  // ── Ledger truth, aggregated to SKU level ────────────────────────────────
  const ledgerMatch = {};
  if (scope.skuCode) ledgerMatch.skuCode = scope.skuCode;
  if (scope.brand) ledgerMatch.brand = scope.brand;

  const ledgerRows = await StockMovement.aggregate([
    ...(Object.keys(ledgerMatch).length ? [{ $match: ledgerMatch }] : []),
    {
      $group: {
        _id: { skuCode: '$skuCode', brand: '$brand' },
        onHand: {
          $sum: { $cond: [{ $eq: ['$movementClass', MOVEMENT_CLASS.ALLOCATION] }, 0, '$quantity'] },
        },
        reserved: {
          $sum: { $cond: [{ $eq: ['$movementClass', MOVEMENT_CLASS.ALLOCATION] }, '$quantity', 0] },
        },
        movementCount: { $sum: 1 },
      },
    },
  ]);
  const ledgerBySku = new Map(
    ledgerRows.map((r) => [`${r._id.skuCode}::${r._id.brand}`, r]),
  );

  // ── Projection, aggregated to SKU level ──────────────────────────────────
  const projectionRows = await StockBalance.aggregate([
    ...(Object.keys(ledgerMatch).length ? [{ $match: ledgerMatch }] : []),
    {
      $group: {
        _id: { skuCode: '$skuCode', brand: '$brand' },
        onHand: { $sum: '$onHand' },
        reserved: { $sum: '$reserved' },
        movementCount: { $sum: '$movementCount' },
      },
    },
  ]);
  const projectionBySku = new Map(
    projectionRows.map((r) => [`${r._id.skuCode}::${r._id.brand}`, r]),
  );

  // ── Legacy values ────────────────────────────────────────────────────────
  // Only the SKUs that appear on either derived side, unless the caller asked
  // for the untracked ones too.
  const touchedKeys = new Set([...ledgerBySku.keys(), ...projectionBySku.keys()]);
  const legacyQuery = includeUntracked
    ? productFilter
    : { ...productFilter, skuCode: { $in: [...touchedKeys].map((k) => k.split('::')[0]) } };

  const legacyRows = await Product.find(
    legacyQuery,
    'skuCode brand totalAvailableQuantity bookedQuantity availableForSale',
  ).lean();
  const legacyBySku = new Map(
    legacyRows.map((p) => [
      `${p.skuCode}::${p.brand}`,
      {
        onHand: p.totalAvailableQuantity ?? 0,
        reserved: p.bookedQuantity ?? 0,
        availableForSale: p.availableForSale ?? 0,
      },
    ]),
  );

  // ── Compare ──────────────────────────────────────────────────────────────
  const keys = new Set([...touchedKeys, ...(includeUntracked ? legacyBySku.keys() : [])]);

  const mismatches = [];
  let projectionDrift = 0;
  let legacyMismatch = 0;
  let untracked = 0;
  let matched = 0;

  for (const key of keys) {
    const [skuCode, brand] = key.split('::');
    const ledger = ledgerBySku.get(key) || { onHand: 0, reserved: 0, movementCount: 0 };
    const projection = projectionBySku.get(key) || { onHand: 0, reserved: 0, movementCount: 0 };
    const legacy = legacyBySku.get(key) || null;

    // No ledger history at all. Expected during dual-write for anything that
    // has not moved since the ledger was switched on.
    if (ledger.movementCount === 0) {
      if (legacy && (legacy.onHand !== 0 || legacy.reserved !== 0)) {
        untracked++;
        if (includeUntracked && mismatches.length < limit) {
          mismatches.push({
            skuCode, brand, status: 'untracked',
            legacy, ledger: null, projection: null,
            issues: [{ kind: 'no-ledger-history', field: 'onHand', legacy: legacy.onHand }],
          });
        }
      }
      continue;
    }

    const issues = compare(legacy, ledger, projection);
    if (issues.length === 0) { matched++; continue; }

    if (issues.some((i) => i.kind === 'projection-drift')) projectionDrift++;
    if (issues.some((i) => i.kind === 'legacy-mismatch')) legacyMismatch++;

    if (mismatches.length < limit) {
      mismatches.push({
        skuCode, brand,
        status: 'mismatch',
        legacy,
        ledger: { onHand: ledger.onHand, reserved: ledger.reserved, movementCount: ledger.movementCount },
        projection: { onHand: projection.onHand, reserved: projection.reserved, movementCount: projection.movementCount },
        issues,
      });
    }
  }

  const trackedTotal = matched + projectionDrift + legacyMismatch;

  return {
    scope,
    checkedAt: new Date(),
    summary: {
      // SKUs with at least one ledger movement — the only ones comparable.
      tracked: trackedTotal,
      matched,
      // The Balance Engine disagrees with the ledger. Fix: rebuildBalances().
      projectionDrift,
      // Dual-write and the legacy path disagree. Must reach zero before the
      // legacy stock update can be retired.
      legacyMismatch,
      // Legacy stock exists but nothing has moved through the ledger yet.
      // Normal during dual-write; not a defect.
      untracked,
    },
    // Empty means the projection is a faithful reduction of the ledger AND
    // dual-write has kept pace with every legacy mutation.
    healthy: projectionDrift === 0 && legacyMismatch === 0,
    mismatches,
    truncated: mismatches.length >= limit,
  };
};

export default { reconcile };
