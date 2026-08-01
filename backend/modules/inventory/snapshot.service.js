import InventorySnapshot from '../../models/InventorySnapshot.js';
import SnapshotRun from '../../models/SnapshotRun.js';
import StockBalance from '../../models/StockBalance.js';
import StockHealth from '../../models/StockHealth.js';
import { nextSequence } from '../../models/Counter.js';
import { recordAudit } from '../../utils/auditLog.js';
import { emitEvent, EVENTS } from '../../utils/eventBus.js';

/**
 * Snapshot Service (IMS Module M6).
 *
 * Freezes inventory state by COPYING from the balance (M3) and health (M4)
 * projections. It calculates nothing — no balance, no band, no target, no
 * coverage. If a figure is not already in a projection, it does not appear in a
 * snapshot.
 *
 * Generation is a left join from balances to health:
 *
 *     stockbalances (per SKU + location)  ──┐
 *                                           ├─► inventorysnapshots rows
 *     stockhealth   (per SKU, network)   ──┘
 *
 * Balances drive the row set because they carry the location dimension.
 * Health is SKU-scoped, so its values repeat across a SKU's location rows —
 * duplicated on purpose, so a snapshot row is readable on its own without
 * joining back to a projection that has since moved on.
 */

/** Midnight UTC for a date. Snapshots are identified by day, not instant. */
const dayOf = (date) => {
  const d = date ? new Date(date) : new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

/** The live run for a date and scope, or null. */
export const activeRun = (snapshotDate, scopeBrand = null) =>
  SnapshotRun.findOne({
    snapshotDate: dayOf(snapshotDate),
    scopeBrand: scopeBrand ?? null,
    status: 'complete',
    supersededAt: null,
  })
    .sort({ createdAt: -1 })
    .lean();

/**
 * Generate a snapshot.
 *
 * @param {object}  options
 * @param {Date}   [options.snapshotDate]  Defaults to today (UTC).
 * @param {string} [options.brand]         Narrow to one brand.
 * @param {string} [options.trigger]       manual | scheduled | rebuild
 * @param {string} [options.frequency]     daily | weekly | monthly | adhoc
 * @param {boolean}[options.rebuild]       Supersede an existing run for the date.
 * @param {number} [options.batchSize]     Rows per write batch.
 */
export const generateSnapshot = async ({
  snapshotDate = null,
  brand = null,
  trigger = 'manual',
  frequency = 'adhoc',
  rebuild = false,
  batchSize = 1000,
  actor = null,
  req = null,
} = {}) => {
  const date = dayOf(snapshotDate);
  const scopeBrand = brand ?? null;

  // ── Duplicate protection ────────────────────────────────────────────────
  // A second snapshot for the same date and scope is refused unless the caller
  // explicitly asks to rebuild. Without this, a scheduler firing twice would
  // silently double the history.
  const existing = await activeRun(date, scopeBrand);
  if (existing && !rebuild) {
    const err = new Error(
      `A snapshot for ${date.toISOString().slice(0, 10)}` +
      `${scopeBrand ? ` (${scopeBrand})` : ''} already exists as ${existing.runId}. ` +
      'Pass rebuild: true to supersede it.',
    );
    err.status = 409;
    err.code = 'SNAPSHOT_EXISTS';
    err.existingRunId = existing.runId;
    throw err;
  }

  const year = new Date().getFullYear();
  const seq = await nextSequence(`snapshot-${year}`);
  const runId = `SNP-${year}-${String(seq).padStart(6, '0')}`;
  const startedAt = new Date();

  const run = await SnapshotRun.create({
    runId,
    snapshotDate: date,
    trigger: rebuild ? 'rebuild' : trigger,
    frequency,
    status: 'running',
    scopeBrand,
    user: actor?._id || null,
    actorType: actor ? 'user' : 'system',
  });

  try {
    const balanceFilter = scopeBrand ? { brand: scopeBrand } : {};

    // Health for the scope, loaded once and indexed in memory. It is one row
    // per SKU — at catalogue scale that is thousands of small documents, not
    // the unbounded set a ledger would be, so a lookup map is cheaper than a
    // per-row query or a $lookup across every balance.
    const healthRows = await StockHealth.find(balanceFilter).lean();
    const healthBySku = new Map(healthRows.map((h) => [`${h.skuCode}::${h.brand}`, h]));

    const totals = { onHand: 0, reserved: 0, available: 0 };
    const bandCounts = {};
    const skus = new Set();
    let rowCount = 0;
    let missingHealthCount = 0;
    let healthComputedOldest = null;

    // Streamed with a cursor so a full-catalogue snapshot does not depend on
    // every balance row fitting in memory at once.
    const cursor = StockBalance.find(balanceFilter).lean().cursor();
    let buffer = [];

    const flush = async () => {
      if (buffer.length === 0) return;
      await InventorySnapshot.insertMany(buffer, { ordered: false });
      buffer = [];
    };

    for await (const bal of cursor) {
      const health = healthBySku.get(`${bal.skuCode}::${bal.brand}`) || null;
      if (!health) missingHealthCount++;
      else if (health.computedAt && (!healthComputedOldest || health.computedAt < healthComputedOldest)) {
        healthComputedOldest = health.computedAt;
      }

      // Copied, never recomputed. `available` is taken as the stored identity
      // so the frozen row matches what the projection reported at the time.
      const available = (bal.onHand ?? 0) - (bal.reserved ?? 0);

      buffer.push({
        run: run._id,
        runId,
        snapshotDate: date,
        skuCode: bal.skuCode,
        brand: bal.brand,
        location: bal.location ?? null,
        locationCode: bal.locationCode ?? null,
        product: bal.product ?? null,
        onHand: bal.onHand ?? 0,
        reserved: bal.reserved ?? 0,
        available,
        incoming: bal.incoming ?? 0,
        outgoing: bal.outgoing ?? 0,
        band: health?.band ?? null,
        coverageDays: health?.coverageDays ?? null,
        maxLevel: health?.maxLevel ?? null,
        reorderLevel: health?.reorderLevel ?? null,
        replenishmentPercent: health?.replenishmentPercent ?? null,
        plannable: health?.plannable ?? false,
        notPlannableReasons: health?.notPlannableReasons ?? [],
        formulaVersion: health?.formulaVersion ?? null,
        thresholds: health?.thresholds ?? { critical: null, low: null, healthy: null },
        lastMovementAt: bal.lastMovementAt ?? null,
        lastIssuedAt: bal.lastIssuedAt ?? null,
        lastReceivedAt: bal.lastReceivedAt ?? null,
      });

      rowCount++;
      skus.add(`${bal.skuCode}::${bal.brand}`);
      totals.onHand += bal.onHand ?? 0;
      totals.reserved += bal.reserved ?? 0;
      totals.available += available;
      if (health?.band) bandCounts[health.band] = (bandCounts[health.band] || 0) + 1;

      if (buffer.length >= batchSize) await flush();
    }
    await flush();

    const completedAt = new Date();

    // Supersede the previous run only AFTER this one is complete, so a failure
    // never leaves a date with no live snapshot.
    if (existing && rebuild) {
      await SnapshotRun.updateOne(
        { runId: existing.runId },
        { $set: { status: 'superseded', supersededAt: completedAt, supersededBy: runId } },
      );
    }

    await SnapshotRun.updateOne(
      { _id: run._id },
      {
        $set: {
          status: 'complete',
          rowCount,
          skuCount: skus.size,
          totals,
          bandCounts,
          healthComputedOldest,
          missingHealthCount,
          completedAt,
          durationMs: completedAt - startedAt,
        },
      },
    );

    await recordAudit(
      actor,
      rebuild ? 'Inventory Snapshot Rebuilt' : 'Inventory Snapshot Generated',
      `Snapshot ${runId} for ${date.toISOString().slice(0, 10)}` +
      `${scopeBrand ? ` (${scopeBrand})` : ''}: ${rowCount} row(s), ${skus.size} SKU(s).` +
      `${existing && rebuild ? ` Superseded ${existing.runId}.` : ''}`,
      req,
      { meta: { runId, snapshotDate: date, scopeBrand, rowCount, skuCount: skus.size, supersededRunId: existing?.runId ?? null } },
    );

    emitEvent(EVENTS.SNAPSHOT_COMPLETED, {
      runId,
      snapshotDate: date,
      scopeBrand,
      rowCount,
      skuCount: skus.size,
      missingHealthCount,
      durationMs: completedAt - startedAt,
      rebuild: Boolean(rebuild),
    });

    return {
      runId,
      snapshotDate: date,
      scopeBrand,
      rowCount,
      skuCount: skus.size,
      totals,
      bandCounts,
      missingHealthCount,
      healthComputedOldest,
      durationMs: completedAt - startedAt,
      supersededRunId: existing && rebuild ? existing.runId : null,
    };
  } catch (error) {
    // A failed run is marked, not deleted — its partial rows stay attached to
    // it and are excluded from reads because the run is not `complete`.
    await SnapshotRun.updateOne(
      { _id: run._id },
      { $set: { status: 'failed', failureReason: error.message, completedAt: new Date() } },
    ).catch(() => {});

    // A failed snapshot is silent otherwise — the scheduled job has no user
    // watching it, so nobody would learn that yesterday's history is missing
    // until someone tried to run a report against it.
    emitEvent(EVENTS.SNAPSHOT_FAILED, {
      runId, snapshotDate: date, scopeBrand, error: error.message,
    });

    throw error;
  }
};

/**
 * Validate a snapshot's integrity.
 *
 * Re-derives the run's own totals from its rows and compares them against the
 * figures recorded on the run. A mismatch means the run was interrupted or the
 * rows were tampered with — it does NOT compare against live projections,
 * because a snapshot is expected to differ from current state.
 */
export const validateSnapshot = async (runId) => {
  const run = await SnapshotRun.findOne({ runId }).lean();
  if (!run) {
    const err = new Error(`Snapshot run ${runId} not found.`);
    err.status = 404;
    throw err;
  }

  const [agg] = await InventorySnapshot.aggregate([
    { $match: { runId } },
    {
      $group: {
        _id: null,
        rowCount: { $sum: 1 },
        onHand: { $sum: '$onHand' },
        reserved: { $sum: '$reserved' },
        available: { $sum: '$available' },
        skus: { $addToSet: '$skuCode' },
      },
    },
  ]);

  const actual = agg || { rowCount: 0, onHand: 0, reserved: 0, available: 0, skus: [] };
  const issues = [];

  if (actual.rowCount !== run.rowCount) {
    issues.push({ field: 'rowCount', recorded: run.rowCount, actual: actual.rowCount });
  }
  for (const field of ['onHand', 'reserved', 'available']) {
    if ((run.totals?.[field] ?? 0) !== actual[field]) {
      issues.push({ field: `totals.${field}`, recorded: run.totals?.[field] ?? 0, actual: actual[field] });
    }
  }
  // Every row must carry the identity that was frozen at write time.
  const identityBroken = actual.rowCount > 0 && actual.available !== actual.onHand - actual.reserved;
  if (identityBroken) {
    issues.push({
      field: 'available identity',
      recorded: actual.available,
      actual: actual.onHand - actual.reserved,
    });
  }

  return {
    runId,
    snapshotDate: run.snapshotDate,
    status: run.status,
    intact: issues.length === 0,
    issues,
    recorded: { rowCount: run.rowCount, totals: run.totals },
    actual: {
      rowCount: actual.rowCount,
      totals: { onHand: actual.onHand, reserved: actual.reserved, available: actual.available },
      skuCount: (actual.skus || []).length,
    },
  };
};

/**
 * Scheduler entry point.
 *
 * SCHEDULE-READY, NOT SCHEDULED. Deliberately not wired into the cron in
 * server.js: whether snapshots run nightly, weekly or on demand is an
 * operational decision, and the retention this implies has not been settled.
 *
 * To enable, add one line beside the existing jobs in server.js:
 *
 *     cron.schedule('30 0 * * *', () => runScheduledSnapshot({ frequency: 'daily' }));
 *
 * Safe to call repeatedly — duplicate protection means a second run for the
 * same day is skipped rather than duplicating history.
 */
export const runScheduledSnapshot = async ({ frequency = 'daily', brand = null } = {}) => {
  try {
    const result = await generateSnapshot({
      trigger: 'scheduled',
      frequency,
      brand,
      rebuild: false,
    });
    console.log(`[Snapshot] ${result.runId}: ${result.rowCount} row(s) captured.`);
    return result;
  } catch (error) {
    if (error.code === 'SNAPSHOT_EXISTS') {
      console.log(`[Snapshot] Already captured for today (${error.existingRunId}) — skipped.`);
      return { skipped: true, existingRunId: error.existingRunId };
    }
    console.error('[Snapshot] Scheduled run failed:', error.message);
    return { failed: true, error: error.message };
  }
};

export default { generateSnapshot, validateSnapshot, activeRun, runScheduledSnapshot, dayOf };
