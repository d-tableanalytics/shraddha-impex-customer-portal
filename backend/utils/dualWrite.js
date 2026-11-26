import mongoose from 'mongoose';
import { postBatch } from '../modules/inventory/ledger.service.js';
import { applyMovements, claimProjection, applyAndConfirmProjection, releaseProjectionClaim } from '../modules/inventory/balance.service.js';
import { recomputeHealthForSkus } from '../modules/inventory/health.service.js';
import StockMovement from '../models/StockMovement.js';
import { activeLedgerQueue, activeLedgerSession, ledgerPostingMode } from './ledgerDeferral.js';
import StockOutbox from '../models/StockOutbox.js';

/**
 * Dual-write adapter (IMS Module M3).
 *
 * Bridges the LEGACY stock engine to the ledger:
 *
 *     Existing workflow
 *          │
 *          ├─► legacy $inc on the product document   (authoritative, unchanged)
 *          └─► recordStockMovement()  →  ledger  →  balance projection  (shadow)
 *
 * THE GOVERNING RULE: this must never break a booking.
 *
 * The legacy update is authoritative and has already succeeded by the time this
 * runs. Every failure here is swallowed and logged — a ledger outage must not
 * fail a customer's order. The cost of that choice is that the ledger can fall
 * behind, which is precisely what reconciliation measures, and why the legacy
 * path stays in place until `legacyMismatch` reaches zero.
 *
 * Recording happens AFTER the legacy mutation, never before, so the ledger can
 * only ever under-report — never claim a movement that did not happen.
 *
 * This file is the entire dual-write surface. Retiring the legacy engine means
 * deleting it and calling the ledger directly; nothing else has to change.
 */

/** Set false to disable ledger recording without touching any workflow. */
const ENABLED = process.env.IMS_DUAL_WRITE !== 'off';

/**
 * Hard ceiling on how long ledger recording may delay the calling workflow.
 *
 * This matters more than it looks. Recording is awaited inside the stock
 * primitives, and `runConfirmBooking` calls them once per line — so without a
 * bound, a database that is merely SLOW (not down) would add Mongoose's default
 * 10-second buffering timeout to every line of a customer's booking. A ten-line
 * order would hang for over a minute before succeeding.
 *
 * Two seconds is far above a healthy write and far below anything a person
 * would wait for. On timeout the caller continues immediately; the write may
 * still land afterwards, and if it does not, reconciliation reports the gap.
 * Either way the legacy path — the authoritative one — is unaffected.
 */
const TIMEOUT_MS = Number(process.env.IMS_DUAL_WRITE_TIMEOUT_MS) || 2000;

/**
 * Resolve `promise`, or give up after TIMEOUT_MS.
 *
 * Deliberately does NOT cancel the underlying work — MongoDB writes cannot be
 * recalled mid-flight, and abandoning a half-written batch would be worse than
 * letting it finish unobserved.
 */
/**
 * Circuit breaker.
 *
 * The timeout bounds a SINGLE call, but a multi-line booking makes one call per
 * line — so a sustained ledger outage would still add TIMEOUT_MS × lines to the
 * customer's request. After a few consecutive failures the breaker opens and
 * recording is skipped outright until the cooldown expires, taking the added
 * latency to zero.
 *
 * Skipped movements are a reconciliation gap, not data loss: the legacy write
 * is authoritative, and `rebuildBalances()` plus the reconciliation report are
 * how the ledger is brought back into line once the underlying problem is
 * fixed. A degraded ledger must never become a degraded storefront.
 */
const BREAKER_THRESHOLD = Number(process.env.IMS_DUAL_WRITE_BREAKER) || 3;
const BREAKER_COOLDOWN_MS = Number(process.env.IMS_DUAL_WRITE_COOLDOWN_MS) || 30_000;

const breaker = { failures: 0, openedAt: 0 };

const breakerIsOpen = () => {
  if (breaker.failures < BREAKER_THRESHOLD) return false;
  if (Date.now() - breaker.openedAt < BREAKER_COOLDOWN_MS) return true;
  // Cooldown elapsed — half-open: let the next call through to probe.
  breaker.failures = 0;
  breaker.openedAt = 0;
  return false;
};

const recordOutcome = (ok) => {
  if (ok) {
    breaker.failures = 0;
    breaker.openedAt = 0;
    return;
  }
  breaker.failures += 1;
  if (breaker.failures === BREAKER_THRESHOLD) {
    breaker.openedAt = Date.now();
    console.error(
      `[DualWrite] ${BREAKER_THRESHOLD} consecutive failures — pausing ledger ` +
      `recording for ${BREAKER_COOLDOWN_MS / 1000}s. Legacy stock updates are ` +
      'unaffected. Run reconciliation once the ledger is healthy again.',
    );
  }
};

/** Current breaker state, for the reconciliation report and health checks. */
export const dualWriteStatus = () => ({
  enabled: ENABLED,
  breakerOpen: breaker.failures >= BREAKER_THRESHOLD &&
    Date.now() - breaker.openedAt < BREAKER_COOLDOWN_MS,
  consecutiveFailures: breaker.failures,
  timeoutMs: TIMEOUT_MS,
});

const withTimeout = (promise, label) => {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `[DualWrite] ${label} exceeded ${TIMEOUT_MS}ms — continuing without waiting. ` +
        'Reconciliation will report any resulting gap.',
      );
      resolve({ ok: false, timedOut: true });
    }, TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Legacy operations have no natural idempotency key — they are not retried at
 * this layer — so a collision-free token is generated per call. A genuine retry
 * of the surrounding workflow would produce a second movement, which shows up
 * as `legacyMismatch` in reconciliation rather than corrupting anything.
 */
const newKey = (prefix) => `dw-${prefix}-${new mongoose.Types.ObjectId().toString()}`;

/**
 * Record one legacy stock mutation in the ledger — DURABLY.
 *
 * WHAT CHANGED IN PHASE 2, AND WHY
 * --------------------------------
 * This used to post straight to the ledger, racing a 2-second timeout behind a
 * circuit breaker that SKIPPED postings outright after three consecutive
 * failures. On this deployment every posting exceeded that budget, so the
 * breaker opened partway through most multi-line bookings and the remaining
 * lines were dropped in silence — 495 order lines have no movements because of
 * it, and two of the three data defects that followed came from other code
 * trusting the resulting gaps.
 *
 * Now the INTENT is written to `stockoutbox` first, inside the caller's
 * transaction when there is one, so the intent and the stock mutation commit
 * together. Posting is then a separate retryable step that a worker finishes
 * however long it takes (modules/inventory/outboxDrain.js).
 *
 * The timeout and breaker still bound how long a customer waits. What they no
 * longer do is discard anything: a skipped or timed-out attempt leaves the row
 * pending. The ledger can lag; it cannot lose.
 *
 * @param {object}   input
 * @param {object}   input.product      The product document that was mutated.
 * @param {Array}    input.movements    [{ movementType, quantity, beforeQuantity, afterQuantity, reasonCode }]
 * @param {string}   input.workflow     e.g. 'booking-confirm', 'po-raise'.
 * @param {string}  [input.referenceType]
 * @param {string}  [input.referenceId]
 * @param {object}  [input.actor]       User document; omit for system jobs.
 * @param {object}  [input.req]         Express request, for the audit trail.
 * @param {string}  [input.note]
 *
 * @returns {Promise<{ok: boolean, outboxId?: string, batchId?: string, deferred?: boolean, error?: string}>}
 *          Never rejects.
 */
export const recordStockMovement = async (input) => {
  if (!ENABLED) return { ok: false, skipped: true };
  if (!input?.product?.skuCode) return { ok: false, error: 'no product' };

  const lines = (input.movements || []).filter((m) => m && m.quantity !== 0);
  if (lines.length === 0) return { ok: false, skipped: true };

  const session = activeLedgerSession();
  const queue = activeLedgerQueue();

  let row;
  try {
    // THE DURABLE INTENT, written before anything is posted. Inside a
    // transaction it uses that transaction's session, so this row and the stock
    // mutation commit together or not at all.
    //
    // Values are COPIED, never referenced: the caller's product document keeps
    // changing, and a retry an hour later must post what was true at the moment
    // of the mutation.
    [row] = await StockOutbox.create([{
      idempotencyKey: newKey(input.workflow),
      payload: {
        skuCode: input.product.skuCode,
        brand: input.product.brand,
        workflow: input.workflow,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        note: input.note ?? null,
        actor: input.actor?._id ?? null,
        // The instant the stock moved. See models/StockOutbox.js.
        effectiveDate: new Date(),
        method: input.req?.method ?? null,
        endpoint: input.req?.originalUrl ?? null,
        ipAddress: input.req?.ip ?? null,
        userAgent: input.req?.headers?.['user-agent'] ?? null,
        movements: lines.map((m) => ({
          movementType: m.movementType,
          quantity: m.quantity,
          beforeQuantity: m.beforeQuantity ?? null,
          afterQuantity: m.afterQuantity ?? null,
          reasonCode: m.reasonCode ?? null,
          note: m.note ?? null,
        })),
      },
    }], session ? { session } : {});
  } catch (error) {
    // The legacy write already succeeded and is authoritative. Failing the
    // request now would turn a bookkeeping problem into a customer-facing one.
    // This is the ONLY path on which a movement can still be lost, and it needs
    // the database to be refusing writes entirely.
    console.error(
      `[DualWrite] Could not record the ledger intent for ${input.product.skuCode} ` +
      `(${input.workflow}): ${error.message}`,
    );
    return { ok: false, error: error.message };
  }

  // Inside a transaction the row is invisible to everyone else until commit, so
  // the posting waits. runInTransaction drains the queue once it has committed,
  // and drops it if the transaction aborts — in which case this row rolled back
  // with it and never existed.
  if (queue) {
    queue.push(row._id);
    return { ok: true, deferred: true, outboxId: String(row._id) };
  }

  // No transaction to wait for. The intent is durable either way; whether the
  // caller waits for the posting is the same decision runInTransaction makes
  // after a commit, so it is made the same way here.
  if (ledgerPostingMode() === 'sync') return attemptOutboxRow(row._id);

  setImmediate(() => {
    attemptOutboxRow(row._id).catch((e) => {
      console.error(`[Ledger] Background posting failed for ${row._id}: ${e.message}`);
    });
  });
  return { ok: true, scheduled: true, outboxId: String(row._id) };
};

/**
 * Try to post one outbox row now, bounded by the timeout and the breaker.
 *
 * Called straight after a commit (utils/transaction.js) so the ledger screens
 * are fresh for the person who just acted. FAILURE IS NOT AN ERROR: the row
 * stays pending and the drain worker takes it. That is the whole point of the
 * outbox, and why this returns rather than throws.
 */
export const attemptOutboxRow = async (outboxId) => {
  if (!outboxId) return { ok: false, skipped: true };

  // Breaker open — do not pay the timeout again. The worker will get to it.
  if (breakerIsOpen()) {
    return { ok: false, skipped: true, breakerOpen: true, outboxId: String(outboxId) };
  }

  // Claim it, exactly as the worker does, so an inline attempt and a drain pass
  // running at the same moment cannot both post the same row.
  const row = await StockOutbox.findOneAndUpdate(
    { _id: outboxId, state: 'pending' },
    { $set: { state: 'claimed', claimedBy: 'inline', claimedAt: new Date() }, $inc: { attempts: 1 } },
    { new: true },
  );
  // Already claimed or applied by the worker — nothing to do, and not a failure.
  if (!row) return { ok: true, skipped: true, outboxId: String(outboxId) };

  const result = await withTimeout(
    postOutbox(row),
    `${row.payload.workflow} / ${row.payload.skuCode}`,
  );
  recordOutcome(result.ok);

  if (result.ok) {
    await StockOutbox.updateOne(
      { _id: row._id },
      {
        $set: {
          state: 'applied', appliedAt: new Date(), batchId: result.batchId,
          claimedBy: null, claimedAt: null, lastError: null,
        },
      },
    );
  } else {
    // Hand it back. A timeout means the write MAY still be in flight; the
    // idempotency key makes a second attempt harmless either way.
    await StockOutbox.updateOne(
      { _id: row._id },
      {
        $set: {
          state: 'pending',
          lastError: result.timedOut ? 'inline attempt timed out' : String(result.error ?? 'unknown'),
          nextAttemptAt: new Date(Date.now() + 2000),
          claimedBy: null, claimedAt: null,
        },
      },
    );
  }
  return { ...result, outboxId: String(row._id) };
};

/**
 * Rebuild just enough of the original request for the audit entry.
 *
 * recordAudit() reads four fields off a request (method, originalUrl, ip,
 * user-agent) and falls back to 'SYSTEM'/'ERP SYSTEM' when they are missing.
 * Without this, every posting made by the drain worker would be audited as if
 * the server had done it on its own, erasing who actually moved the stock.
 */
const auditContext = (p) => (
  p.method || p.endpoint || p.ipAddress || p.userAgent
    ? {
      method: p.method ?? undefined,
      originalUrl: p.endpoint ?? undefined,
      ip: p.ipAddress ?? undefined,
      headers: p.userAgent ? { 'user-agent': p.userAgent } : {},
    }
    : null
);

/**
 * The actual posting, driven entirely by the stored row.
 *
 * The idempotency key comes FROM THE ROW rather than being generated per call,
 * which is what makes this safe to run again: `stockbatches.idempotencyKey` is
 * unique, so a second attempt returns `replayed` and writes nothing.
 */
const postOutbox = async (row) => {
  const p = row.payload;
  try {
    const result = await postBatch({
      idempotencyKey: row.idempotencyKey,
      workflowType: p.workflow,
      referenceType: p.referenceType,
      referenceId: p.referenceId,
      actor: p.actor ? { _id: p.actor } : null,
      note: p.note,
      // Fixes the movement to when it happened, not when it was drained.
      effectiveDate: p.effectiveDate ?? undefined,
      lines: p.movements.map((m) => ({
        movementType: m.movementType,
        skuCode: p.skuCode,
        // Captured from the product document at mutation time rather than
        // guessed, so a movement can never be filed under the wrong brand.
        brand: p.brand,
        quantity: m.quantity,
        beforeQuantity: m.beforeQuantity ?? null,
        afterQuantity: m.afterQuantity ?? null,
        reasonCode: m.reasonCode ?? null,
        note: m.note ?? null,
      })),
    }, auditContext(p));

    /**
     * Fold the new movements into the balance projection.
     *
     * GATED ON THE PROJECTION, NOT ON THE POST. This used to skip whenever the
     * batch was a replay, on the assumption that a posted batch had already
     * been projected. It has not, if the process died between the two — and
     * the retry would then skip the fold for ever, leaving the projection
     * permanently short. `claimProjection` asks the question that matters and
     * answers it for exactly one caller, so a batch is folded once however
     * many times it is posted.
     */
    if (result.batch?.transactionIds?.length && await claimProjection(result.batch.batchId)) {
      try {
        const posted = await StockMovement.find({
          transactionId: { $in: result.batch.transactionIds },
        }).lean();
        await applyAndConfirmProjection(result.batch.batchId, posted);

        // HEALTH TRIGGER 1 of 3 — the balance moved, so its classification may
        // have changed. Scoped to the SKUs this batch touched; a full recompute
        // for one booking would be absurd. Never throws (health is derived and
        // always rebuildable), so a projection failure cannot fail the booking.
        await recomputeHealthForSkus([...new Set(posted.map((m) => m.skuCode))]);
      } catch (error) {
        // Hand the claim back so the next attempt may fold it.
        await releaseProjectionClaim(result.batch.batchId);
        throw error;
      }
    }

    return { ok: true, batchId: result.batch.batchId };
  } catch (error) {
    // Returned, not thrown. The caller hands the row back to the queue and the
    // drain worker retries it — the failure is a delay now, not a loss.
    console.error(
      `[DualWrite] Failed to post ${p.workflow} movement for ${p.skuCode}: ${error.message}`,
    );
    return { ok: false, error: error.message };
  }
};

export default { recordStockMovement, attemptOutboxRow };
