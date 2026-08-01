import { ProductKoken, ProductBIX, ProductIMADA } from '../models/Product.js';
import { recordStockMovement } from './dualWrite.js';

/**
 * Stock ledger for booked quantities.
 *
 * The invariant across the app is:
 *   availableForSale + bookedQuantity === totalAvailableQuantity
 *
 * Confirming a booking moves units available → booked. These helpers move them
 * back, and adjust an existing booking by a delta, so a Sales User edit keeps
 * inventory truthful in the same transaction as the booking change.
 *
 * DUAL-WRITE (Module M3)
 * ----------------------
 * Every function below now ALSO records its mutation in the stock ledger. This
 * is the single funnel through which all twelve stock call sites pass, so
 * wiring it here rather than at each caller makes it structurally impossible to
 * miss one.
 *
 * The legacy $inc remains authoritative and is completely unchanged. Ledger
 * recording happens only AFTER it succeeds, never throws, and is passed an
 * optional `ctx` carrying provenance:
 *
 *     ctx = { workflow, referenceType, referenceId, actor, req, reasonCode }
 *
 * Omitting ctx still records the movement, just with less provenance — so an
 * unmigrated caller degrades rather than silently dropping history.
 */

const MODELS = [ProductKoken, ProductBIX, ProductIMADA];

/** Find a product by SKU across every brand collection. */
export const findProductBySku = async (skuCode, session = null) => {
  const opts = session ? { session } : {};
  for (const Model of MODELS) {
    const p = await Model.findOne({ skuCode }, null, opts);
    if (p) return p;
  }
  return null;
};

/**
 * Reserve `qty` units: available → booked.
 * Guarded so concurrent writers cannot oversell; returns false when stock is
 * insufficient, leaving the document untouched.
 */
export const reserveStock = async (product, qty, session = null, ctx = null) => {
  if (qty <= 0) return true;
  const Model = product.constructor;
  const opts = session ? { session } : {};
  const updated = await Model.findOneAndUpdate(
    { _id: product._id, availableForSale: { $gte: qty } },
    { $inc: { availableForSale: -qty, bookedQuantity: qty } },
    { new: true, ...opts },
  );
  if (!updated) return false;
  product.availableForSale = updated.availableForSale;
  product.bookedQuantity = updated.bookedQuantity;

  // Allocation: units become spoken for. On-hand is unchanged, so the before/
  // after pair tracks the RESERVED balance.
  await recordStockMovement({
    product,
    workflow: ctx?.workflow || 'reserve',
    referenceType: ctx?.referenceType, referenceId: ctx?.referenceId,
    actor: ctx?.actor, req: ctx?.req,
    movements: [{
      movementType: 'RESERVE',
      quantity: qty,
      beforeQuantity: updated.bookedQuantity - qty,
      afterQuantity: updated.bookedQuantity,
      reasonCode: ctx?.reasonCode,
    }],
  });
  return true;
};

/**
 * Release `qty` units: booked → available. The inverse of reserveStock, and the
 * operation the codebase previously had no path for.
 *
 * bookedQuantity is floored at 0 rather than guarded, so a legacy row whose
 * booked count is already understated cannot block a legitimate release.
 */
export const releaseStock = async (product, qty, session = null, ctx = null) => {
  if (qty <= 0) return true;
  const Model = product.constructor;
  const opts = session ? { session } : {};
  const fresh = await Model.findById(product._id, null, opts);
  if (!fresh) return false;
  const giveBack = Math.min(qty, Math.max(0, fresh.bookedQuantity));
  const updated = await Model.findByIdAndUpdate(
    product._id,
    { $inc: { availableForSale: qty, bookedQuantity: -giveBack } },
    { new: true, ...opts },
  );
  if (!updated) return false;
  product.availableForSale = updated.availableForSale;
  product.bookedQuantity = updated.bookedQuantity;

  // De-allocation. `giveBack` rather than `qty`, because the legacy helper
  // floors at the booked count — the ledger records what actually moved, not
  // what was asked for.
  await recordStockMovement({
    product,
    workflow: ctx?.workflow || 'release',
    referenceType: ctx?.referenceType, referenceId: ctx?.referenceId,
    actor: ctx?.actor, req: ctx?.req,
    movements: [{
      movementType: 'RELEASE',
      quantity: -giveBack,
      beforeQuantity: updated.bookedQuantity + giveBack,
      afterQuantity: updated.bookedQuantity,
      reasonCode: ctx?.reasonCode,
    }],
  });
  return true;
};

/**
 * Consume `qty` units permanently: the goods are sold, so they leave inventory
 * entirely. Booked drops and the grand total drops with it; availableForSale is
 * untouched because it was already reduced when the booking was confirmed.
 *
 * This preserves the invariant:
 *   before  available = total − booked
 *   after   available = (total − qty) − (booked − qty)   ← same value
 */
export const consumeStock = async (product, qty, session = null, ctx = null) => {
  if (qty <= 0) return true;
  const Model = product.constructor;
  const opts = session ? { session } : {};
  const fresh = await Model.findById(product._id, null, opts);
  if (!fresh) return false;
  // Floor at the booked count so a legacy row whose booked figure is already
  // understated cannot drive bookedQuantity negative.
  const take = Math.min(qty, Math.max(0, fresh.bookedQuantity));
  const updated = await Model.findByIdAndUpdate(
    product._id,
    { $inc: { totalAvailableQuantity: -take, bookedQuantity: -take } },
    { new: true, ...opts },
  );
  if (!updated) return false;
  product.totalAvailableQuantity = updated.totalAvailableQuantity;
  product.bookedQuantity = updated.bookedQuantity;

  // TWO movements, not one. The legacy helper collapses de-allocation and
  // physical issue into a single $inc, which hides that two distinct things
  // happened. Splitting them is what makes the ledger truthful — and what lets
  // an issue be reported independently of a release.
  await recordStockMovement({
    product,
    workflow: ctx?.workflow || 'consume',
    referenceType: ctx?.referenceType, referenceId: ctx?.referenceId,
    actor: ctx?.actor, req: ctx?.req,
    movements: [
      {
        movementType: 'RELEASE',
        quantity: -take,
        beforeQuantity: updated.bookedQuantity + take,
        afterQuantity: updated.bookedQuantity,
        reasonCode: ctx?.reasonCode,
      },
      {
        movementType: 'ISSUE',
        quantity: -take,
        beforeQuantity: updated.totalAvailableQuantity + take,
        afterQuantity: updated.totalAvailableQuantity,
        reasonCode: ctx?.reasonCode,
      },
    ],
  });
  return true;
};

/**
 * Adjust a line whose stock has already been CONSUMED (PO raised). Those units
 * are gone from inventory, so a change has to move both figures together:
 *   more  → take the extra permanently  (available −N, total −N)
 *   less  → give the difference back    (available +N, total +N)
 *
 * Using the reserved-state helpers here would corrupt bookedQuantity, which no
 * longer carries this booking's units.
 */
export const adjustConsumedQty = async (product, fromQty, toQty, session = null, ctx = null) => {
  const delta = toQty - fromQty;
  if (delta === 0) return { ok: true };
  const Model = product.constructor;
  const opts = session ? { session } : {};

  if (delta > 0) {
    const updated = await Model.findOneAndUpdate(
      { _id: product._id, availableForSale: { $gte: delta } },
      { $inc: { availableForSale: -delta, totalAvailableQuantity: -delta } },
      { new: true, ...opts },
    );
    if (!updated) return { ok: false };
    product.availableForSale = updated.availableForSale;
    product.totalAvailableQuantity = updated.totalAvailableQuantity;

    // Already-consumed line increased: more goods leave inventory.
    await recordStockMovement({
      product,
      workflow: ctx?.workflow || 'adjust-consumed',
      referenceType: ctx?.referenceType, referenceId: ctx?.referenceId,
      actor: ctx?.actor, req: ctx?.req,
      movements: [{
        movementType: 'ISSUE',
        quantity: -delta,
        beforeQuantity: updated.totalAvailableQuantity + delta,
        afterQuantity: updated.totalAvailableQuantity,
        reasonCode: ctx?.reasonCode,
      }],
    });
    return { ok: true };
  }

  const give = -delta;
  const updated = await Model.findByIdAndUpdate(
    product._id,
    { $inc: { availableForSale: give, totalAvailableQuantity: give } },
    { new: true, ...opts },
  );
  if (!updated) return { ok: false };
  product.availableForSale = updated.availableForSale;
  product.totalAvailableQuantity = updated.totalAvailableQuantity;

  // Already-consumed line reduced: goods come back into stock. Recorded as a
  // signed ADJUSTMENT rather than a RECEIPT — nothing was received from a
  // supplier, a commitment was walked back.
  await recordStockMovement({
    product,
    workflow: ctx?.workflow || 'adjust-consumed',
    referenceType: ctx?.referenceType, referenceId: ctx?.referenceId,
    actor: ctx?.actor, req: ctx?.req,
    movements: [{
      movementType: 'ADJUSTMENT',
      quantity: give,
      beforeQuantity: updated.totalAvailableQuantity - give,
      afterQuantity: updated.totalAvailableQuantity,
      reasonCode: ctx?.reasonCode || 'DATA_ENTRY',
    }],
  });
  return { ok: true };
};

/**
 * Move an existing reservation from `fromQty` to `toQty` on the same product.
 * Positive delta reserves more, negative releases the excess.
 * Returns { ok, available } — ok:false means insufficient stock, nothing changed.
 */
export const adjustReservedQty = async (product, fromQty, toQty, session = null, ctx = null) => {
  const delta = toQty - fromQty;
  if (delta === 0) return { ok: true, available: product.availableForSale };
  // Delegates, so ledger recording is inherited from reserveStock/releaseStock —
  // ctx is threaded through to keep the provenance of the delegated movement.
  const ok = delta > 0
    ? await reserveStock(product, delta, session, ctx)
    : await releaseStock(product, -delta, session, ctx);
  return { ok, available: product.availableForSale };
};

export default {
  findProductBySku, reserveStock, releaseStock, consumeStock,
  adjustReservedQty, adjustConsumedQty,
};
