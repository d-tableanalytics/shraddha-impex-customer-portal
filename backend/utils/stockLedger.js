import { allBrandModels } from './brandAccess.js';
import { recordStockMovement } from './dualWrite.js';
import { reportStockDiscrepancy, committedElsewhere } from './stockInvariant.js';

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

/** Find a product by SKU across every brand collection. */
export const findProductBySku = async (skuCode, session = null) => {
  const opts = session ? { session } : {};
  for (const [Model] of allBrandModels()) {
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
 * Release `qty` units: booked → available. The inverse of reserveStock.
 *
 * SYMMETRY IS THE WHOLE POINT. This used to credit `availableForSale` with the
 * full `qty` while giving `bookedQuantity` back only what it actually held:
 *
 *     $inc: { availableForSale: qty, bookedQuantity: -giveBack }
 *
 * On a row whose booked count was understated — which a dropped ledger posting
 * plus syncLegacyStock made routine — that minted stock out of nothing. A
 * cancellation of 7 units against a booked count of 4 left `availableForSale`
 * three units above anything physically present, and the portal sold them.
 *
 * Both sides now move by `giveBack`, so the invariant
 * `availableForSale + bookedQuantity === totalAvailableQuantity` survives every
 * release. When a booking holds more than inventory admits to, the difference
 * is REPORTED (utils/stockInvariant.js) rather than credited — a discrepancy is
 * a question for a person, not a reason to invent stock.
 *
 * For a healthy row (booked >= qty) this is byte-for-byte the old behaviour.
 *
 * The guarded update plus retry replaces a blind $inc: two settlements racing
 * on the same product can no longer drive `bookedQuantity` negative.
 */
export const releaseStock = async (product, qty, session = null, ctx = null) => {
  if (qty <= 0) return true;
  const Model = product.constructor;
  const opts = session ? { session } : {};

  for (let attempt = 0; attempt < 5; attempt++) {
    const fresh = await Model.findById(product._id, null, opts);
    if (!fresh) return false;

    // A corrupted negative reads as zero. Treating -18 as a credit of 18 is
    // how a bad row propagates into a worse one.
    const booked = Math.max(0, fresh.bookedQuantity ?? 0);
    let giveBack = Math.min(qty, booked);

    // OTHER CUSTOMERS' UNITS ARE NOT THIS BOOKING'S TO RELEASE.
    //
    // `bookedQuantity` is an aggregate across every booking for the SKU, so on
    // an understated row this release would take back more than its own share
    // and leave another customer's hold unreserved — their order intact, their
    // stock sellable to someone else.
    //
    // Reached only when the row is ALREADY inconsistent (`giveBack < qty`). On
    // a healthy row the cap equals `qty` by arithmetic, so the query is skipped
    // and the path is byte-for-byte what it was.
    if (giveBack < qty) {
      const held = await committedElsewhere(fresh.skuCode, ctx?.referenceId ?? null, session);
      giveBack = Math.min(giveBack, Math.max(0, booked - held));
    }

    if (giveBack === 0) {
      // Nothing is held for these units. Crediting `qty` here is exactly the
      // phantom-stock bug; leave inventory untouched and raise the exception.
      product.availableForSale = fresh.availableForSale;
      product.bookedQuantity = fresh.bookedQuantity;
      await reportStockDiscrepancy({
        product: fresh, requested: qty, applied: 0, operation: 'release', ctx, session,
      });
      return true;
    }

    const updated = await Model.findOneAndUpdate(
      { _id: product._id, bookedQuantity: { $gte: giveBack } },
      { $inc: { availableForSale: giveBack, bookedQuantity: -giveBack } },
      { new: true, ...opts },
    );
    // Booked moved under us between the read and the write — re-read and retry.
    if (!updated) continue;

    product.availableForSale = updated.availableForSale;
    product.bookedQuantity = updated.bookedQuantity;

    // De-allocation. `giveBack`, because the ledger records what actually
    // moved, not what was asked for.
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

    await reportStockDiscrepancy({
      product: updated, requested: qty, applied: giveBack, operation: 'release', ctx, session,
    });
    return true;
  }
  return false;
};

/**
 * Consume `qty` units permanently: the goods are sold, so they leave inventory
 * entirely. Called once per line when a PO is raised.
 *
 * EXACTLY ONCE. This helper does not guard against being called twice — the
 * guard is one level up, in settleBooking() (utils/stockSettlement.js), which
 * claims each line with an update conditional on `stockState` still being
 * 'reserved' and acts only when `modifiedCount === 1`. A line already consumed
 * is skipped before it reaches here, so a repeated PO request moves no stock.
 *
 * THE THREE-WAY SPLIT. The old version decremented BOTH totals by
 * `min(qty, booked)`, which is right only while `booked` is accurate. On a row
 * whose booked count was understated, goods shipped but `totalAvailableQuantity`
 * fell by less than shipped — leaving physical stock permanently overstated,
 * the mirror image of the release bug.
 *
 * Units leaving are therefore accounted for against the two places they can
 * come from, in order:
 *
 *     allocTake = min(qty, booked)                    units this booking held
 *     fromAfs   = min(qty - allocTake, available)     units never allocated
 *     physical  = min(allocTake + fromAfs, onHand)    what actually leaves
 *
 * and on a consistent row the invariant is preserved by construction:
 *
 *     (afs - fromAfs) + (booked - allocTake) === total - physical
 *
 * When `booked >= qty` — every healthy booking — `fromAfs` is 0, `physical` is
 * `qty`, and this is exactly the previous behaviour.
 *
 * THE FINAL CLAMP AGAINST `onHand` matters on a row that is ALREADY broken.
 * Where `availableForSale` carries phantom units, a booking can be confirmed
 * for more than physically exists; without the clamp, raising its PO drove
 * `totalAvailableQuantity` negative — turning one bad row into a worse one and
 * breaking the floor every downstream reader assumes. Physical stock stops at
 * zero and the uncovered remainder is REPORTED.
 *
 * Phase 1 deliberately does NOT repair such a row here. Rewriting
 * `availableForSale` mid-PO would silently change what customers can see, which
 * is a reconciliation decision with a person behind it. This stops the row
 * getting worse and makes every use of it visible.
 */
export const consumeStock = async (product, qty, session = null, ctx = null) => {
  if (qty <= 0) return true;
  const Model = product.constructor;
  const opts = session ? { session } : {};

  for (let attempt = 0; attempt < 5; attempt++) {
    const fresh = await Model.findById(product._id, null, opts);
    if (!fresh) return false;

    const booked = Math.max(0, fresh.bookedQuantity ?? 0);
    const afs = Math.max(0, fresh.availableForSale ?? 0);
    let allocTake = Math.min(qty, booked);

    // The same protection as releaseStock, for the same reason: on an
    // understated row the de-allocation would otherwise eat another live
    // booking's share. The goods still leave — `fromAfs` below covers the
    // difference — so this changes WHERE the units are drawn from, never how
    // many ship. Healthy rows never reach it.
    if (allocTake < qty) {
      const held = await committedElsewhere(fresh.skuCode, ctx?.referenceId ?? null, session);
      allocTake = Math.min(allocTake, Math.max(0, booked - held));
    }

    const fromAfs = Math.min(qty - allocTake, afs);
    // Clamped at what is physically there: stock may reach zero, never below.
    const onHand = Math.max(0, fresh.totalAvailableQuantity ?? 0);
    const physical = Math.min(allocTake + fromAfs, onHand);

    if (physical === 0) {
      product.totalAvailableQuantity = fresh.totalAvailableQuantity;
      product.bookedQuantity = fresh.bookedQuantity;
      await reportStockDiscrepancy({
        product: fresh, requested: qty, applied: 0, operation: 'consume', ctx, session,
      });
      return true;
    }

    // Each guard is included ONLY when that counter is actually being drawn on.
    // A blanket `$gte: 0` looks harmless but never matches a row whose stored
    // value is already negative — the update then failed every attempt and the
    // helper returned false, which settleBooking turns into a thrown error. A
    // corrupted row would have blocked its own PO.
    const guard = { _id: product._id };
    if (allocTake > 0) guard.bookedQuantity = { $gte: allocTake };
    if (fromAfs > 0) guard.availableForSale = { $gte: fromAfs };
    if (physical > 0) guard.totalAvailableQuantity = { $gte: physical };

    const updated = await Model.findOneAndUpdate(
      guard,
      {
        $inc: {
          totalAvailableQuantity: -physical,
          bookedQuantity: -allocTake,
          availableForSale: -fromAfs,
        },
      },
      { new: true, ...opts },
    );
    // Someone else moved this product between the read and the write — retry.
    if (!updated) continue;

    product.totalAvailableQuantity = updated.totalAvailableQuantity;
    product.bookedQuantity = updated.bookedQuantity;
    product.availableForSale = updated.availableForSale;

    // TWO movements, not one. The legacy helper collapsed de-allocation and
    // physical issue into a single $inc, which hides that two distinct things
    // happened. Splitting them is what makes the ledger truthful — and what
    // lets an issue be reported independently of a release.
    await recordStockMovement({
      product,
      workflow: ctx?.workflow || 'consume',
      referenceType: ctx?.referenceType, referenceId: ctx?.referenceId,
      actor: ctx?.actor, req: ctx?.req,
      movements: [
        {
          movementType: 'RELEASE',
          quantity: -allocTake,
          beforeQuantity: updated.bookedQuantity + allocTake,
          afterQuantity: updated.bookedQuantity,
          reasonCode: ctx?.reasonCode,
        },
        {
          movementType: 'ISSUE',
          quantity: -physical,
          beforeQuantity: updated.totalAvailableQuantity + physical,
          afterQuantity: updated.totalAvailableQuantity,
          reasonCode: ctx?.reasonCode,
        },
      ],
    });

    await reportStockDiscrepancy({
      product: updated, requested: qty, applied: physical, operation: 'consume', ctx, session,
    });
    return true;
  }
  return false;
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
