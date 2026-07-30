import { ProductKoken, ProductBIX, ProductIMADA } from '../models/Product.js';

/**
 * Stock ledger for booked quantities.
 *
 * The invariant across the app is:
 *   availableForSale + bookedQuantity === totalAvailableQuantity
 *
 * Confirming a booking moves units available → booked. These helpers move them
 * back, and adjust an existing booking by a delta, so a Sales User edit keeps
 * inventory truthful in the same transaction as the booking change.
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
export const reserveStock = async (product, qty, session = null) => {
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
  return true;
};

/**
 * Release `qty` units: booked → available. The inverse of reserveStock, and the
 * operation the codebase previously had no path for.
 *
 * bookedQuantity is floored at 0 rather than guarded, so a legacy row whose
 * booked count is already understated cannot block a legitimate release.
 */
export const releaseStock = async (product, qty, session = null) => {
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
export const consumeStock = async (product, qty, session = null) => {
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
export const adjustConsumedQty = async (product, fromQty, toQty, session = null) => {
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
  return { ok: true };
};

/**
 * Move an existing reservation from `fromQty` to `toQty` on the same product.
 * Positive delta reserves more, negative releases the excess.
 * Returns { ok, available } — ok:false means insufficient stock, nothing changed.
 */
export const adjustReservedQty = async (product, fromQty, toQty, session = null) => {
  const delta = toQty - fromQty;
  if (delta === 0) return { ok: true, available: product.availableForSale };
  const ok = delta > 0
    ? await reserveStock(product, delta, session)
    : await releaseStock(product, -delta, session);
  return { ok, available: product.availableForSale };
};

export default {
  findProductBySku, reserveStock, releaseStock, consumeStock,
  adjustReservedQty, adjustConsumedQty,
};
