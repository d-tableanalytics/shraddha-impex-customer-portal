import mongoose from 'mongoose';
import { postBatch } from '../modules/inventory/ledger.service.js';
import { applyMovements } from '../modules/inventory/balance.service.js';
import { recomputeHealthForSkus } from '../modules/inventory/health.service.js';
import StockMovement from '../models/StockMovement.js';

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
 * Record one legacy stock mutation in the ledger.
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
 * @returns {Promise<{ok: boolean, batchId?: string, error?: string}>} Never rejects.
 */
export const recordStockMovement = async (input) => {
  if (!ENABLED) return { ok: false, skipped: true };
  if (!input?.product?.skuCode) return { ok: false, error: 'no product' };

  const lines = (input.movements || []).filter((m) => m && m.quantity !== 0);
  if (lines.length === 0) return { ok: false, skipped: true };

  // Breaker open — skip immediately rather than paying the timeout again.
  if (breakerIsOpen()) return { ok: false, skipped: true, breakerOpen: true };

  const result = await withTimeout(
    post(input, lines),
    `${input.workflow} / ${input.product.skuCode}`,
  );
  recordOutcome(result.ok);
  return result;
};

/** The actual recording. Separated so the timeout wrapper stays readable. */
const post = async ({
  product,
  workflow,
  referenceType = null,
  referenceId = null,
  actor = null,
  req = null,
  note = null,
}, lines) => {
  try {
    const result = await postBatch({
      idempotencyKey: newKey(workflow),
      workflowType: workflow,
      referenceType,
      referenceId,
      actor,
      note,
      lines: lines.map((m) => ({
        movementType: m.movementType,
        skuCode: product.skuCode,
        // Derived from the product document rather than guessed, so a movement
        // can never be filed under the wrong brand.
        brand: product.brand,
        quantity: m.quantity,
        beforeQuantity: m.beforeQuantity ?? null,
        afterQuantity: m.afterQuantity ?? null,
        reasonCode: m.reasonCode ?? null,
        note: m.note ?? null,
      })),
    }, req);

    // Fold the new movements into the balance projection. Read back rather than
    // trusting the input, so the projection is built from what the ledger
    // actually stored.
    if (!result.replayed && result.batch?.transactionIds?.length) {
      const posted = await StockMovement.find({
        transactionId: { $in: result.batch.transactionIds },
      }).lean();
      await applyMovements(posted);

      // HEALTH TRIGGER 1 of 3 — the balance moved, so its classification may
      // have changed. Scoped to the SKUs this batch touched; a full recompute
      // for one booking would be absurd. Never throws (health is derived and
      // always rebuildable), so a projection failure cannot fail the booking.
      await recomputeHealthForSkus([...new Set(posted.map((m) => m.skuCode))]);
    }

    return { ok: true, batchId: result.batch.batchId };
  } catch (error) {
    // Deliberately swallowed. The legacy write already succeeded and is
    // authoritative; failing the request here would turn a ledger problem into
    // a customer-facing one. Reconciliation is what surfaces the gap.
    console.error(
      `[DualWrite] Failed to record ${workflow} movement for ` +
      `${product?.skuCode ?? 'unknown SKU'}: ${error.message}`,
    );
    return { ok: false, error: error.message };
  }
};

export default { recordStockMovement };
