import mongoose from 'mongoose';
import StockMovement, { MOVEMENT_CLASS } from '../../models/StockMovement.js';
import StockBalance, { deriveBalance } from '../../models/StockBalance.js';
import Location from '../../models/Location.js';
import { Product } from '../../models/Product.js';
import { recordAudit } from '../../utils/auditLog.js';

/**
 * Balance Engine (IMS Module M3).
 *
 * Projects `stockbalances` from `stockmovements`. Two paths write a balance and
 * they share ONE reduction function, which is what makes replay and incremental
 * update provably agree:
 *
 *   incremental  applyMovements()  — folds newly posted movements in, O(lines)
 *   replay       rebuildBalances() — recomputes from the full ledger, authoritative
 *
 * `reduceMovements` is the single definition of what a movement does to a
 * balance. If the two paths ever disagree, it is because one of them stopped
 * using it — not because the rules drifted.
 *
 * DETERMINISM: reduction is pure. Same movements in, same deltas out,
 * regardless of order — every operation is commutative addition, and the
 * timestamp fields take a max rather than a last-write.
 *
 * Scope note: quantities only. No health, no targets, no percentages.
 */

// ─── The single reduction rule ───────────────────────────────────────────────

/**
 * Fold a set of movements into balance deltas, keyed by SKU+brand+location.
 *
 * PHYSICAL movements move `onHand`; ALLOCATION movements move `reserved`. That
 * separation is the whole reason `movementClass` exists — merging them would
 * make "how much is physically here" unanswerable and turn every stock-count
 * variance into a false positive.
 *
 * Pure: no I/O, no clock, no randomness. Callable from a test with plain objects.
 */
export const reduceMovements = (movements) => {
  const byKey = new Map();

  for (const m of movements) {
    const key = `${m.skuCode}::${m.brand}::${String(m.location)}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        skuCode: m.skuCode,
        brand: m.brand,
        location: m.location,
        locationCode: m.locationCode,
        product: m.product ?? null,
        onHand: 0,
        reserved: 0,
        incoming: 0,
        outgoing: 0,
        movementCount: 0,
        lastMovementAt: null,
        lastPhysicalMovementAt: null,
        lastIssuedAt: null,
        lastReceivedAt: null,
        lastCountedAt: null,
      });
    }
    const acc = byKey.get(key);
    const qty = m.quantity;
    const at = m.effectiveDate ? new Date(m.effectiveDate) : null;

    if (m.movementClass === MOVEMENT_CLASS.ALLOCATION) {
      acc.reserved += qty;
    } else {
      acc.onHand += qty;
    }

    acc.movementCount += 1;

    // Max, not last-write — so the result does not depend on the order the
    // movements happen to arrive in.
    const bump = (field, when) => {
      if (!when) return;
      if (!acc[field] || when > acc[field]) acc[field] = when;
    };
    bump('lastMovementAt', at);
    if (m.movementClass !== MOVEMENT_CLASS.ALLOCATION) {
      bump('lastPhysicalMovementAt', at);
      if (m.movementType === 'ISSUE') bump('lastIssuedAt', at);
      if (m.movementType === 'RECEIPT' || m.movementType === 'OPENING') bump('lastReceivedAt', at);
      if (m.movementType === 'COUNT') bump('lastCountedAt', at);
    }
  }

  return [...byKey.values()];
};

// ─── Incremental projection ──────────────────────────────────────────────────

/**
 * Fold newly posted movements into their balances.
 *
 * Called immediately after a successful ledger post. Uses `$inc` with upsert so
 * concurrent postings for the same SKU cannot lose an update — the increment is
 * atomic and order-independent.
 *
 * IMPORTANT: this is not idempotent. Applying the same movement twice would
 * double-count it. That is acceptable because it is invoked exactly once, in
 * the post path — and because `rebuildBalances()` is the authority that can
 * always correct it, and `reconcile()` is what detects it. See the technical
 * review for why a watermark cannot fix this under concurrency.
 */
export const applyMovements = async (movements, session = null) => {
  if (!Array.isArray(movements) || movements.length === 0) return [];

  const opts = session ? { session } : {};
  const deltas = reduceMovements(movements);

  const ops = deltas.map((d) => {
    const setOnInsert = {
      skuCode: d.skuCode,
      brand: d.brand,
      location: d.location,
      locationCode: d.locationCode,
      ...(d.product ? { product: d.product } : {}),
    };

    // $max on the timestamps keeps them monotonic, so a backdated movement
    // arriving late cannot pull `lastMovementAt` backwards.
    const max = {};
    for (const f of ['lastMovementAt', 'lastPhysicalMovementAt', 'lastIssuedAt', 'lastReceivedAt', 'lastCountedAt']) {
      if (d[f]) max[f] = d[f];
    }

    return {
      updateOne: {
        filter: { skuCode: d.skuCode, brand: d.brand, location: d.location },
        update: {
          $inc: {
            onHand: d.onHand,
            reserved: d.reserved,
            incoming: d.incoming,
            outgoing: d.outgoing,
            movementCount: d.movementCount,
          },
          $setOnInsert: setOnInsert,
          ...(Object.keys(max).length ? { $max: max } : {}),
        },
        upsert: true,
      },
    };
  });

  await StockBalance.bulkWrite(ops, { ordered: false, ...opts });
  return deltas;
};

// ─── Replay / rebuild ────────────────────────────────────────────────────────

/**
 * Rebuild balances from the ledger. This is the authoritative path.
 *
 * Aggregates `stockmovements` in the database rather than loading them into
 * memory, so rebuilding the whole catalogue does not depend on history size
 * fitting in the process.
 *
 * @param {object}  scope        Optional narrowing — { skuCode, brand, locationCode }
 * @param {object}  options
 * @param {boolean} options.dryRun  Compute and report without writing.
 * @param {Date}    options.asOf    Rebuild as at a point in time (effectiveDate ≤ asOf).
 */
export const rebuildBalances = async (scope = {}, { dryRun = false, asOf = null, actor = null, req = null } = {}) => {
  const match = {};
  if (scope.skuCode) match.skuCode = scope.skuCode;
  if (scope.brand) match.brand = scope.brand;
  if (scope.locationCode) match.locationCode = scope.locationCode;
  if (asOf) match.effectiveDate = { $lte: asOf };

  const allocation = MOVEMENT_CLASS.ALLOCATION;

  const aggregated = await StockMovement.aggregate([
    { $match: match },
    {
      $group: {
        _id: { skuCode: '$skuCode', brand: '$brand', location: '$location' },
        locationCode: { $first: '$locationCode' },
        product: { $first: '$product' },
        onHand: {
          $sum: { $cond: [{ $eq: ['$movementClass', allocation] }, 0, '$quantity'] },
        },
        reserved: {
          $sum: { $cond: [{ $eq: ['$movementClass', allocation] }, '$quantity', 0] },
        },
        movementCount: { $sum: 1 },
        lastMovementAt: { $max: '$effectiveDate' },
        lastPhysicalMovementAt: {
          $max: { $cond: [{ $eq: ['$movementClass', allocation] }, null, '$effectiveDate'] },
        },
        lastIssuedAt: {
          $max: { $cond: [{ $eq: ['$movementType', 'ISSUE'] }, '$effectiveDate', null] },
        },
        lastReceivedAt: {
          $max: {
            $cond: [{ $in: ['$movementType', ['RECEIPT', 'OPENING']] }, '$effectiveDate', null],
          },
        },
        lastCountedAt: {
          $max: { $cond: [{ $eq: ['$movementType', 'COUNT'] }, '$effectiveDate', null] },
        },
      },
    },
  ]);

  const rebuilt = aggregated.map((a) => ({
    skuCode: a._id.skuCode,
    brand: a._id.brand,
    location: a._id.location,
    locationCode: a.locationCode,
    product: a.product ?? null,
    onHand: a.onHand,
    reserved: a.reserved,
    movementCount: a.movementCount,
    lastMovementAt: a.lastMovementAt,
    lastPhysicalMovementAt: a.lastPhysicalMovementAt,
    lastIssuedAt: a.lastIssuedAt,
    lastReceivedAt: a.lastReceivedAt,
    lastCountedAt: a.lastCountedAt,
  }));

  // Compare against what is currently projected, so the caller can see what a
  // rebuild would change before committing to it.
  const currentDocs = await StockBalance.find(
    scope.skuCode || scope.brand || scope.locationCode ? match : {},
    'skuCode brand location onHand reserved movementCount',
  ).lean();
  const currentByKey = new Map(
    currentDocs.map((d) => [`${d.skuCode}::${d.brand}::${String(d.location)}`, d]),
  );

  const changes = [];
  for (const r of rebuilt) {
    const key = `${r.skuCode}::${r.brand}::${String(r.location)}`;
    const cur = currentByKey.get(key);
    if (!cur) {
      changes.push({ ...r, reason: 'missing', from: null });
    } else if (cur.onHand !== r.onHand || cur.reserved !== r.reserved) {
      changes.push({
        ...r,
        reason: 'drift',
        from: { onHand: cur.onHand, reserved: cur.reserved },
      });
    }
    currentByKey.delete(key);
  }
  // Anything left has a projection but no ledger history behind it.
  const orphaned = [...currentByKey.values()].filter((d) => d.onHand !== 0 || d.reserved !== 0);

  if (dryRun) {
    return {
      dryRun: true,
      scope,
      asOf,
      rebuiltCount: rebuilt.length,
      changed: changes.length,
      orphaned: orphaned.length,
      changes: changes.slice(0, 100),
      orphanedSamples: orphaned.slice(0, 50),
    };
  }

  if (rebuilt.length) {
    const ops = rebuilt.map((r) => ({
      updateOne: {
        filter: { skuCode: r.skuCode, brand: r.brand, location: r.location },
        update: {
          // A rebuild SETS rather than increments — it is the authoritative
          // recomputation, not a delta.
          $set: {
            locationCode: r.locationCode,
            product: r.product,
            onHand: r.onHand,
            reserved: r.reserved,
            movementCount: r.movementCount,
            lastMovementAt: r.lastMovementAt,
            lastPhysicalMovementAt: r.lastPhysicalMovementAt,
            lastIssuedAt: r.lastIssuedAt,
            lastReceivedAt: r.lastReceivedAt,
            lastCountedAt: r.lastCountedAt,
            lastRebuiltAt: new Date(),
            rebuiltFromLedger: true,
          },
        },
        upsert: true,
      },
    }));
    await StockBalance.bulkWrite(ops, { ordered: false });
  }

  // A projection with no ledger behind it is zeroed rather than deleted, so the
  // row's existence (and its markers) survive for investigation.
  if (orphaned.length) {
    await StockBalance.bulkWrite(
      orphaned.map((o) => ({
        updateOne: {
          filter: { _id: o._id },
          update: {
            $set: {
              onHand: 0, reserved: 0, movementCount: 0,
              lastRebuiltAt: new Date(), rebuiltFromLedger: true,
            },
          },
        },
      })),
      { ordered: false },
    );
  }

  await recordAudit(
    actor,
    'Stock Balances Rebuilt',
    `Rebuilt ${rebuilt.length} balance projection(s) from the ledger` +
    `${scope.skuCode ? ` for ${scope.skuCode}` : ''}. ${changes.length} changed, ${orphaned.length} zeroed.`,
    req,
    { meta: { scope, asOf, rebuiltCount: rebuilt.length, changed: changes.length, orphaned: orphaned.length } },
  );

  return {
    dryRun: false,
    scope,
    asOf,
    rebuiltCount: rebuilt.length,
    changed: changes.length,
    orphaned: orphaned.length,
    changes: changes.slice(0, 100),
  };
};

// ─── Reads ───────────────────────────────────────────────────────────────────

/** Shape a balance document for the API, with the derived figures attached. */
export const shapeBalance = (doc) => ({
  skuCode: doc.skuCode,
  brand: doc.brand,
  locationCode: doc.locationCode,
  ...deriveBalance(doc),
  movementCount: doc.movementCount ?? 0,
  lastMovementAt: doc.lastMovementAt ?? null,
  lastPhysicalMovementAt: doc.lastPhysicalMovementAt ?? null,
  lastIssuedAt: doc.lastIssuedAt ?? null,
  lastReceivedAt: doc.lastReceivedAt ?? null,
  lastCountedAt: doc.lastCountedAt ?? null,
  lastRebuiltAt: doc.lastRebuiltAt ?? null,
  rebuiltFromLedger: Boolean(doc.rebuiltFromLedger),
  updatedAt: doc.updatedAt,
});

/**
 * Balances for one SKU, one row per location, plus a network-wide total.
 * The total is computed here rather than stored — it is a sum over rows that
 * already exist, and storing it would be a fourth number able to disagree.
 */
export const getSkuBalance = async (skuCode, brands) => {
  const rows = await StockBalance.find({
    skuCode,
    ...(brands ? { brand: { $in: brands } } : {}),
  }).lean();

  if (rows.length === 0) return null;

  const locations = rows.map(shapeBalance);
  const total = locations.reduce(
    (acc, l) => ({
      onHand: acc.onHand + l.onHand,
      reserved: acc.reserved + l.reserved,
      incoming: acc.incoming + l.incoming,
      outgoing: acc.outgoing + l.outgoing,
      available: acc.available + l.available,
      projected: acc.projected + l.projected,
    }),
    { onHand: 0, reserved: 0, incoming: 0, outgoing: 0, available: 0, projected: 0 },
  );

  return { skuCode, brand: rows[0].brand, total, locations };
};

/** Batch availability lookup — the booking hot path. One indexed query. */
export const getAvailability = async (skuCodes, brands, locationCode = null) => {
  const filter = {
    skuCode: { $in: skuCodes },
    ...(brands ? { brand: { $in: brands } } : {}),
    ...(locationCode ? { locationCode } : {}),
  };
  const rows = await StockBalance.find(filter, 'skuCode brand onHand reserved incoming outgoing').lean();

  // Sum across locations per SKU — availability is a network figure unless a
  // location was named.
  const bySku = new Map();
  for (const r of rows) {
    const cur = bySku.get(r.skuCode) || { skuCode: r.skuCode, brand: r.brand, onHand: 0, reserved: 0, incoming: 0, outgoing: 0 };
    cur.onHand += r.onHand ?? 0;
    cur.reserved += r.reserved ?? 0;
    cur.incoming += r.incoming ?? 0;
    cur.outgoing += r.outgoing ?? 0;
    bySku.set(r.skuCode, cur);
  }
  return [...bySku.values()].map((b) => ({ ...b, ...deriveBalance(b) }));
};

export default {
  reduceMovements,
  applyMovements,
  rebuildBalances,
  getSkuBalance,
  getAvailability,
  shapeBalance,
};
