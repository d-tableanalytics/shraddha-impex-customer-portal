import mongoose from 'mongoose';
import os from 'node:os';

import StockOutbox from '../../models/StockOutbox.js';
import StockMovement from '../../models/StockMovement.js';
import { postBatch } from './ledger.service.js';
import { applyMovements, claimProjection, applyAndConfirmProjection, releaseProjectionClaim } from './balance.service.js';
import { recomputeHealthForSkus } from './health.service.js';

/**
 * Draining the stock-ledger outbox.
 *
 * Each row is an intent that was committed alongside a real stock mutation, so
 * it describes something that definitely happened. The worker's only job is to
 * get it into the ledger, however many attempts that takes.
 *
 * THE FOUR GUARANTEES, AND WHAT PROVIDES EACH
 *
 *   durable          the row was written inside the business transaction
 *                    (utils/dualWrite.js). A process that dies between the
 *                    stock mutation and the posting loses nothing.
 *
 *   never duplicated the row carries the idempotency key minted when it was
 *                    created. `stockbatches.idempotencyKey` is unique, so a
 *                    second attempt that reaches the database returns
 *                    `replayed` and applies no movements and no projection
 *                    update. This is what makes a crash between "posted" and
 *                    "marked applied" harmless.
 *
 *   one worker only  the claim is a single atomic findOneAndUpdate conditional
 *                    on `state: 'pending'`. Two workers racing produce one
 *                    winner and one null; nothing is processed twice. A claim
 *                    abandoned by a dead worker is reclaimed after
 *                    CLAIM_TIMEOUT_MS — safe precisely because of the point
 *                    above.
 *
 *   ordered enough   rows are drained oldest-first, and per SKU that preserves
 *                    the order the mutations actually happened in. Strict
 *                    global ordering is NOT required: the balance projection
 *                    folds movements by addition, which is commutative, and
 *                    the timestamp fields take a max rather than a last-write
 *                    (see reduceMovements in balance.service.js). What matters
 *                    is that every movement lands exactly once, which it does.
 *
 * IT NEVER TOUCHES STOCK. The legacy figures were already moved by the
 * workflow that wrote the row. This only writes history and the projection
 * derived from it, so a drain — or ten of them — cannot change what a customer
 * can book. It also sends no mail and fulfils no indent: the notification and
 * indent paths belong to the workflows, deliberately not to this.
 */

const WORKER_ID = `${os.hostname()}:${process.pid}`;

/** How long a claim may be held before another worker may take the row. */
const CLAIM_TIMEOUT_MS = Number(process.env.IMS_OUTBOX_CLAIM_TIMEOUT_MS) || 120_000;
/** Attempts before a row is parked as `failed` for a person to look at. */
const MAX_ATTEMPTS = Number(process.env.IMS_OUTBOX_MAX_ATTEMPTS) || 12;
/** Rows per drain pass. Bounded so a backlog cannot monopolise the process. */
const BATCH_SIZE = Number(process.env.IMS_OUTBOX_BATCH) || 50;
/** How often the scheduled drain runs. */
const INTERVAL_MS = Number(process.env.IMS_OUTBOX_INTERVAL_MS) || 15_000;

/** Backoff: ~2s, 4s, 8s … capped at 5 minutes. */
const backoffMs = (attempts) => Math.min(300_000, 2 ** Math.min(attempts, 8) * 1000);

/**
 * Hand rows abandoned by a dead worker back to the queue.
 *
 * Safe to be wrong about: if the original worker is in fact still alive and
 * both post the batch, the idempotency key means the second posting is a no-op.
 */
export const reclaimStale = async () => {
  const cutoff = new Date(Date.now() - CLAIM_TIMEOUT_MS);
  const res = await StockOutbox.updateMany(
    { state: 'claimed', claimedAt: { $lte: cutoff } },
    { $set: { state: 'pending', claimedBy: null, claimedAt: null } },
  );
  if (res.modifiedCount) {
    console.warn(`[Outbox] Reclaimed ${res.modifiedCount} row(s) from a worker that did not finish.`);
  }
  return res.modifiedCount ?? 0;
};

/** Atomically take the oldest due row. Returns null when there is nothing to do. */
const claimOne = async () => StockOutbox.findOneAndUpdate(
  { state: 'pending', nextAttemptAt: { $lte: new Date() } },
  {
    $set: { state: 'claimed', claimedBy: WORKER_ID, claimedAt: new Date() },
    $inc: { attempts: 1 },
  },
  { sort: { createdAt: 1 }, new: true },
);

/**
 * Post one claimed row.
 *
 * Mirrors what utils/dualWrite.js used to do inline, with one difference that
 * matters: the idempotency key comes from the row instead of being generated
 * per call, so this is safe to run again.
 */
export const applyOutboxRow = async (row) => {
  const p = row.payload;
  const auditReq = (p.method || p.endpoint || p.ipAddress || p.userAgent)
    ? { method: p.method ?? undefined, originalUrl: p.endpoint ?? undefined, ip: p.ipAddress ?? undefined, headers: p.userAgent ? { 'user-agent': p.userAgent } : {} }
    : null;
  const result = await postBatch({
    idempotencyKey: row.idempotencyKey,
    workflowType: p.workflow,
    referenceType: p.referenceType,
    referenceId: p.referenceId,
    actor: p.actor ? { _id: p.actor } : null,
    note: p.note,
    // The instant the stock moved, not the instant this worker ran.
    effectiveDate: p.effectiveDate ?? undefined,
    lines: p.movements.map((m) => ({
      movementType: m.movementType,
      skuCode: p.skuCode,
      brand: p.brand,
      quantity: m.quantity,
      beforeQuantity: m.beforeQuantity ?? null,
      afterQuantity: m.afterQuantity ?? null,
      reasonCode: m.reasonCode ?? null,
      note: m.note ?? null,
    })),
  }, auditReq);

  // Gated on whether the batch has been PROJECTED, not on whether it has been
  // posted. A process that died between the two leaves a posted batch with no
  // projection, and gating on `replayed` would skip the fold for ever. See
  // claimProjection in balance.service.js.
  if (result.batch?.transactionIds?.length && await claimProjection(result.batch.batchId)) {
    try {
      const posted = await StockMovement.find({
        transactionId: { $in: result.batch.transactionIds },
      }).lean();
        await applyAndConfirmProjection(result.batch.batchId, posted);
      await recomputeHealthForSkus([...new Set(posted.map((m) => m.skuCode))]);
    } catch (error) {
      await releaseProjectionClaim(result.batch.batchId);
      throw error;
    }
  }

  return result.batch?.batchId ?? null;
};

/** Drain up to `limit` rows. Returns what happened, for logs and tests. */
export const drainOutbox = async ({ limit = BATCH_SIZE } = {}) => {
  if (mongoose.connection.readyState !== 1) return { applied: 0, failed: 0, retried: 0, skipped: 'disconnected' };

  await reclaimStale();

  const out = { applied: 0, failed: 0, retried: 0 };
  for (let i = 0; i < limit; i += 1) {
    const row = await claimOne();
    if (!row) break;

    try {
      const batchId = await applyOutboxRow(row);
      await StockOutbox.updateOne(
        { _id: row._id },
        { $set: { state: 'applied', appliedAt: new Date(), batchId, lastError: null, claimedBy: null, claimedAt: null } },
      );
      out.applied += 1;
    } catch (error) {
      const giveUp = row.attempts >= MAX_ATTEMPTS;
      await StockOutbox.updateOne(
        { _id: row._id },
        {
          $set: {
            state: giveUp ? 'failed' : 'pending',
            lastError: String(error?.message ?? error).slice(0, 500),
            nextAttemptAt: new Date(Date.now() + backoffMs(row.attempts)),
            claimedBy: null,
            claimedAt: null,
          },
        },
      );
      if (giveUp) {
        out.failed += 1;
        console.error(
          `[Outbox] GIVING UP on ${row.idempotencyKey} after ${row.attempts} attempts: ${error?.message}. ` +
          'The stock figures are correct; the LEDGER is behind for this movement. ' +
          'Run the reconciliation report.',
        );
      } else {
        out.retried += 1;
      }
    }
  }
  return out;
};

/**
 * Drain only the rows for these SKUs, and wait for them.
 *
 * Used by syncLegacyStock(), which copies the ledger's physical position onto
 * the product document: reading that projection while a posting for the same
 * SKU is still queued would write a stale figure over a correct one. Scoped to
 * the SKUs in hand so a backlog on unrelated stock cannot delay an import.
 *
 * Bounded: a SKU with a large backlog drains what it can and the rest follows
 * on the normal schedule. Blocking an import indefinitely would be worse than
 * one more cycle of staleness, which reconciliation reports.
 */
export const drainOutboxForSkus = async (skuCodes, { limit = BATCH_SIZE } = {}) => {
  const skus = [...new Set((skuCodes || []).filter(Boolean))];
  if (skus.length === 0 || mongoose.connection.readyState !== 1) return { applied: 0, failed: 0 };

  const out = { applied: 0, failed: 0 };
  for (let i = 0; i < limit; i += 1) {
    const row = await StockOutbox.findOneAndUpdate(
      { state: 'pending', 'payload.skuCode': { $in: skus }, nextAttemptAt: { $lte: new Date() } },
      { $set: { state: 'claimed', claimedBy: WORKER_ID, claimedAt: new Date() }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, new: true },
    );
    if (!row) break;
    try {
      const batchId = await applyOutboxRow(row);
      await StockOutbox.updateOne({ _id: row._id }, {
        $set: {
          state: 'applied', appliedAt: new Date(), batchId,
          lastError: null, claimedBy: null, claimedAt: null,
        },
      });
      out.applied += 1;
    } catch (error) {
      await StockOutbox.updateOne({ _id: row._id }, {
        $set: {
          state: row.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          lastError: String(error?.message ?? error).slice(0, 500),
          nextAttemptAt: new Date(Date.now() + backoffMs(row.attempts)),
          claimedBy: null, claimedAt: null,
        },
      });
      out.failed += 1;
    }
  }
  return out;
};

/** Operational summary — what the health endpoint and a human would ask for. */
export const outboxStatus = async () => {
  const rows = await StockOutbox.aggregate([
    { $group: { _id: '$state', n: { $sum: 1 }, oldest: { $min: '$createdAt' } } },
  ]);
  const byState = Object.fromEntries(rows.map((r) => [r._id, { count: r.n, oldest: r.oldest }]));
  return {
    pending: byState.pending?.count ?? 0,
    claimed: byState.claimed?.count ?? 0,
    applied: byState.applied?.count ?? 0,
    failed: byState.failed?.count ?? 0,
    oldestPendingAt: byState.pending?.oldest ?? null,
    workerId: WORKER_ID,
  };
};

let timer = null;

/**
 * Start the scheduled drain. Idempotent: calling it twice does not start two.
 *
 * `unref()` so the timer never holds the process open — a drain in flight
 * finishes, and anything still queued is picked up by the next boot, which is
 * exactly what the outbox is for.
 */
export const startOutboxDrain = () => {
  if (timer) return timer;
  timer = setInterval(() => {
    drainOutbox().catch((e) => console.error(`[Outbox] Drain pass failed: ${e.message}`));
  }, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[Outbox] Drain scheduled every ${INTERVAL_MS / 1000}s as ${WORKER_ID}.`);
  return timer;
};

export const stopOutboxDrain = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

export default { drainOutbox, startOutboxDrain, stopOutboxDrain, outboxStatus, reclaimStale, applyOutboxRow };
