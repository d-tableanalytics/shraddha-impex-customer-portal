/**
 * Direct stock adjustment — IMS.
 *
 * The one place an operator can change a stock figure by hand.
 *
 * WHAT THIS DOES NOT DO: it never writes a quantity into `stockbalances`.
 * Balances are a projection of the ledger, so overwriting one would make the
 * balance disagree with the sum of its own movements — and the disagreement
 * would be invisible until a reconciliation run months later. Instead the
 * caller says what the figure SHOULD be, this computes the difference against
 * what the ledger currently says, and posts that difference as an ADJUSTMENT
 * movement. The operator gets "set it to 120"; the system gets an append-only,
 * attributable, reversible record of who changed what and why.
 *
 * The projection chain is the same one the stock-count post uses, in the same
 * order, so a hand adjustment and a counted variance land identically:
 *
 *     postBatch()              → ledger      (immutable truth)
 *     applyMovements()         → balances    (M3 projection)
 *     recomputeHealthForSkus() → health      (M4 projection, emits
 *                                             HEALTH_PROJECTED, which the
 *                                             alert subscriber consumes)
 */

import crypto from 'crypto';

import { Product } from '../../models/Product.js';
import Location from '../../models/Location.js';
import StockBalance from '../../models/StockBalance.js';
import StockHealth from '../../models/StockHealth.js';
import StockMovement from '../../models/StockMovement.js';

import { postBatch } from './ledger.service.js';
import { applyMovements, shapeBalance, syncLegacyStock } from './balance.service.js';
import { recomputeHealthForSkus } from './health.service.js';
import { processAvailableIndents } from './indentAvailability.service.js';
import { resolveConfig } from './config.service.js';

const fail = (message, status = 400, code = 'VALIDATION_ERROR') => {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
};

export const ADJUSTMENT_MODES = ['set', 'delta'];

/** Stamped on adjustments posted from the Update Stock dialog, which does not ask for a reason. */
export const DEFAULT_REASON_CODE = 'MANUAL_ADJUSTMENT';

/**
 * Reason codes come from InventoryConfig — the same list the count screen
 * uses. They are not redefined here, so adding a code in configuration makes it
 * available to both paths at once.
 */
export const adjustmentReasonCodes = async ({ brand = null } = {}) => {
  const config = await resolveConfig({ brand });
  return (config?.reasonCodes || [])
    .filter((r) => r.active)
    .map((r) => ({ code: r.code, label: r.label, group: r.group, direction: r.direction }));
};

/**
 * Preview an adjustment without writing anything.
 *
 * The modal calls this on open so the operator sees the CURRENT ledger position
 * rather than the figure cached in whatever list they clicked from — a stale
 * number here would be silently converted into a wrong delta.
 */
export const previewAdjustment = async ({ skuCode, brand, locationCode = null }) => {
  const product = await Product.findOne({ skuCode, brand }, 'skuCode brand itemDescription status').lean();
  if (!product) fail(`${skuCode} was not found for ${brand}.`, 404, 'NOT_FOUND');

  const location = locationCode
    ? await Location.findOne({ code: locationCode.toUpperCase() }).lean()
    : (await Location.findOne({ isDefault: true }).lean()) ?? (await Location.findOne({ active: true }).lean());
  if (!location) fail('No stock location is configured.', 409, 'NO_LOCATION');

  const row = await StockBalance.findOne({ skuCode, brand, locationCode: location.code }).lean();
  const health = await StockHealth.findOne({ skuCode, brand }, 'band replenishmentPercent maxLevel plannable').lean();

  return {
    skuCode: product.skuCode,
    brand: product.brand,
    itemDescription: product.itemDescription ?? null,
    locationCode: location.code,
    balance: row
      ? shapeBalance(row)
      : { skuCode, brand, locationCode: location.code, onHand: 0, reserved: 0, available: 0, incoming: 0, outgoing: 0, projected: 0 },
    health: health
      ? { band: health.band, replenishmentPercent: health.replenishmentPercent, maxLevel: health.maxLevel, plannable: health.plannable }
      : null,
    reasonCodes: await adjustmentReasonCodes({ brand }),
  };
};

/**
 * Post a stock adjustment.
 *
 * @param {string} mode      'set'   — `quantity` is the figure stock should end at
 *                           'delta' — `quantity` is the signed change to apply
 */
export const adjustStock = async ({
  skuCode,
  brand,
  locationCode = null,
  mode = 'set',
  quantity,
  reasonCode,
  note = null,
  actor,
  req = null,
}) => {
  // ── Shape ─────────────────────────────────────────────────────────────────
  const sku = String(skuCode || '').trim();
  if (!sku) fail('A SKU code is required.');
  if (!brand) fail('A brand is required.');
  if (!ADJUSTMENT_MODES.includes(mode)) {
    fail(`mode must be one of: ${ADJUSTMENT_MODES.join(', ')}.`);
  }
  if (typeof quantity !== 'number' || !Number.isFinite(quantity)) {
    fail('quantity must be a number.');
  }
  if (!Number.isInteger(quantity)) {
    fail('Stock is tracked in whole units — quantity must be a whole number.');
  }

  const product = await Product.findOne({ skuCode: sku, brand }, 'skuCode brand status').lean();
  if (!product) fail(`${sku} was not found for ${brand}.`, 404, 'NOT_FOUND');

  const location = locationCode
    ? await Location.findOne({ code: String(locationCode).toUpperCase() }).lean()
    : (await Location.findOne({ isDefault: true }).lean()) ?? (await Location.findOne({ active: true }).lean());
  if (!location) fail('No stock location is configured.', 409, 'NO_LOCATION');
  if (location.active === false) fail(`Location ${location.code} is not active.`, 409, 'INACTIVE_LOCATION');

  // ── Current position, read fresh from the projection ─────────────────────
  const row = await StockBalance.findOne({ skuCode: sku, brand, locationCode: location.code }).lean();
  const before = row?.onHand ?? 0;
  const reserved = row?.reserved ?? 0;

  const delta = mode === 'set' ? quantity - before : quantity;
  const after = before + delta;

  // ── Business guards ───────────────────────────────────────────────────────
  if (delta === 0) {
    fail(
      mode === 'set'
        ? `Stock is already ${before} — nothing to change.`
        : 'A delta of zero would not change anything.',
      409,
      'NO_CHANGE',
    );
  }

  // Physical stock cannot be negative. `set` guards this by rejecting a
  // negative target; `delta` needs the resulting figure checked, because
  // -30 against 10 on hand is only visible after the arithmetic.
  if (after < 0) {
    fail(
      `That would take ${sku} to ${after}. Stock cannot go negative — ` +
      `there ${before === 1 ? 'is' : 'are'} ${before} on hand.`,
      409,
      'NEGATIVE_RESULT',
    );
  }

  // Reserved stock is committed to live bookings. Cutting on-hand below it
  // does not un-commit anything, it just creates an oversell that surfaces at
  // dispatch — so it is refused here, where the operator can still see why.
  if (after < reserved) {
    fail(
      `${reserved} unit${reserved === 1 ? ' is' : 's are'} reserved against live bookings, so on hand ` +
      `cannot drop to ${after}. Release the reservations first, or adjust to ${reserved} or more.`,
      409,
      'BELOW_RESERVED',
    );
  }

  // ── Reason code ───────────────────────────────────────────────────────────
  // The dialog does not ask for one, so the movement is stamped MANUAL_ADJUSTMENT
  // by default. The field is not simply left null: the reason-code breakdown on
  // the reports screen is how a hand correction is told apart from a counted
  // variance or an imported receipt, and a null bucket would collapse that
  // distinction. Reusing an existing code such as DATA_ENTRY would be worse
  // still — it would assert a cause nobody stated.
  //
  // An explicit code is still honoured when one is passed, because the import
  // and count paths supply real reasons and their direction rules must hold.
  const code = String(reasonCode || '').trim().toUpperCase() || DEFAULT_REASON_CODE;

  const config = await resolveConfig({ brand });
  const active = (config?.reasonCodes || []).filter((r) => r.active);
  const chosen = active.find((r) => r.code === code);
  if (active.length > 0 && !chosen && code !== DEFAULT_REASON_CODE) {
    fail(`"${code}" is not an active reason code.`, 400, 'INVALID_REASON_CODE');
  }

  // A reason carries a direction, and honouring it is what stops "Damage" being
  // recorded against a stock INCREASE. Without this check the reason-code
  // breakdown on the reports screen means nothing.
  if (chosen?.direction === 'Positive' && delta < 0) {
    fail(`"${chosen.label}" only applies to stock increases.`, 400, 'REASON_DIRECTION');
  }
  if (chosen?.direction === 'Negative' && delta > 0) {
    fail(`"${chosen.label}" only applies to stock reductions.`, 400, 'REASON_DIRECTION');
  }

  // ── Ledger ────────────────────────────────────────────────────────────────
  // The idempotency key is random per request rather than derived from the
  // values. Two identical corrections on the same day are a legitimate thing to
  // want — deriving the key from {sku, location, delta} would silently swallow
  // the second one as a replay.
  const result = await postBatch({
    idempotencyKey: `adjust-${sku}-${location.code}-${crypto.randomUUID()}`,
    workflowType: 'stock-adjustment',
    referenceType: 'adjustment',
    referenceId: null,
    actor,
    note: note || `Manual stock adjustment at ${location.code}`,
    lines: [{
      movementType: 'ADJUSTMENT',
      skuCode: sku,
      brand,
      locationCode: location.code,
      quantity: delta,
      beforeQuantity: before,
      afterQuantity: after,
      reasonCode: code,
      note,
    }],
  }, req);

  // ── Projections — this SKU only, never a full rebuild ────────────────────
  const posted = await StockMovement.find({ batchId: result.batch.batchId }).lean();
  if (!result.replayed && posted.length) {
    await applyMovements(posted);
  }
  await recomputeHealthForSkus([sku], { brand });
  // Mirror outward, so the customer portal and the booking guard see this
  // stock too rather than only the IMS screens.
  await syncLegacyStock([sku]);
  // Stock just rose or fell — tell anyone whose indent this now covers.
  await processAvailableIndents([sku]);

  // ── Report the new position, read back rather than assumed ───────────────
  const updated = await StockBalance.findOne({ skuCode: sku, brand, locationCode: location.code }).lean();
  const health = await StockHealth.findOne(
    { skuCode: sku, brand },
    'band replenishmentPercent maxLevel plannable',
  ).lean();

  return {
    skuCode: sku,
    brand,
    locationCode: location.code,
    mode,
    before,
    after: updated?.onHand ?? after,
    delta,
    reasonCode: code,
    transactionId: posted[0]?.transactionId ?? null,
    batchId: result.batch.batchId,
    balance: updated ? shapeBalance(updated) : null,
    health: health
      ? { band: health.band, replenishmentPercent: health.replenishmentPercent, maxLevel: health.maxLevel, plannable: health.plannable }
      : null,
  };
};

export default { adjustStock, previewAdjustment, adjustmentReasonCodes, ADJUSTMENT_MODES };
