import { Product } from '../../models/Product.js';
import { lockState, poDueAt, PO_DEADLINE_DAYS } from '../../utils/bookingLock.js';
import { lineAmount, labelForPriceType, normalisePriceType, asPrice } from '../../config/pricing.js';

/**
 * Turning Order rows into the booking object the sales desk renders.
 *
 * Split out of sales.controller.js because that module imports the socket
 * server, and importing it pulls the whole app up with it — routes, jobs and
 * all. This file depends on nothing but the Product model and the lock rules,
 * so the live/snapshot decision below can be loaded and tested on its own.
 * See scripts/verify-box-numbers.js.
 */

export const boxKey = (skuCode, brand) => `${skuCode}::${brand}`;

/**
 * Current SKU → box number mapping for a set of order rows, in one query.
 *
 * The box number stored on an Order row is a SNAPSHOT taken when the line was
 * created. That snapshot is the right thing to keep once the PO is raised — it
 * records what the warehouse was actually told to pick. Before that point it is
 * merely stale: if an admin has re-boxed the SKU in the meantime, the desk
 * should be looking at the box the goods are in NOW, because that is what the
 * PO about to be raised will quote.
 *
 * Keyed by SKU *and* brand: the same SKU code can exist under more than one
 * brand, and they are separate products with separate boxes.
 */
export const currentBoxNumbers = async (rows) => {
  const skus = [...new Set(rows.map((r) => r.skuCode).filter(Boolean))];
  if (skus.length === 0) return new Map();
  const products = await Product.find(
    { skuCode: { $in: skus } },
    'skuCode brand boxNo',
  ).lean();
  return new Map(products.map((p) => [boxKey(p.skuCode, p.brand), p.boxNo || null]));
};

/**
 * What this booking was priced at — the tier that was offered, and the money.
 *
 * PURE, and it reads ONLY the order rows. It cannot reach the product master,
 * so it cannot surface a price the customer was not given: the row carries the
 * one tier that was chosen and no trace of the other three. That is what makes
 * the same summary safe to send to the sales desk and to the customer whose
 * booking it is.
 *
 * Null when nothing has been priced, so a caller can omit the section entirely
 * rather than render an empty one.
 *
 * `unpricedLines` counts lines the chosen tier has no rate for. It is reported
 * rather than hidden because a total that quietly skips three lines is a wrong
 * total, and the document has to be able to say so.
 */
export const pricingSummary = (rows = []) => {
  const priced = rows.filter((r) => r?.priceType);
  if (!priced.length) return null;

  let totalAmount = 0;
  let pricedLines = 0;
  let unpricedLines = 0;

  for (const row of rows) {
    // The PO charges for what stock covered; an indent remainder is not on it.
    const amount = lineAmount(row.unitPrice, row.confirmedQty || 0);
    if (amount === null) { unpricedLines += 1; continue; }
    totalAmount += amount;
    pricedLines += 1;
  }

  const type = normalisePriceType(priced[0].priceType);
  return {
    priceType: type,
    priceTypeLabel: labelForPriceType(type),
    currency: 'INR',
    pricedAt: priced[0].pricedAt || null,
    pricedLines,
    unpricedLines,
    totalAmount: pricedLines ? Math.round(totalAmount * 100) / 100 : null,
  };
};

/**
 * What the customer is actually waiting for on this booking.
 *
 * ---------------------------------------------------------------------------
 * CONFIRMED + INDENT, AND WHY IT IS NOT `confirmedQty + pendingQty`
 * ---------------------------------------------------------------------------
 *
 * `pendingQty` is the shortfall FROZEN onto the order row when the booking was
 * confirmed. The reservation behind it is the live balance, and the two part
 * company as soon as stock arrives and auto-books against the indent: the row
 * still claims 20 outstanding when only 15 are. They are also the same units
 * recorded twice (`resItem.quantity = pendingQty` at the split), so adding both
 * would count the shortfall twice over.
 *
 * ---------------------------------------------------------------------------
 * THE INDENT IS SUMMED WHOLE, NOT MATCHED PER LINE
 * ---------------------------------------------------------------------------
 *
 * A line that could not be fulfilled AT ALL gets no order row - the confirmation
 * only pushes one when `confirmedQty > 0` - so it exists solely as a
 * reservation. Summing the indent per order row would miss those units
 * entirely, which is the exact mismatch this card is meant to expose. Summing
 * the booking's whole open indent counts them.
 *
 * ---------------------------------------------------------------------------
 * UNKNOWN IS NULL, NEVER ZERO
 * ---------------------------------------------------------------------------
 *
 * A caller that does not supply the indent map gets `null`, not `0`. This is a
 * figure the desk uses to decide whether a booking matches the customer's PO;
 * reporting a confident total that silently omits the indent would be worse
 * than reporting nothing, because nobody re-checks a number that looks fine.
 */
const bookingTotals = (rows, indentBySku) => {
  const booked = rows.reduce((n, r) => n + (r.confirmedQty || 0), 0);
  if (!indentBySku) return { booked, indent: null, total: null };

  const indent = [...indentBySku.values()].reduce((n, q) => n + (q || 0), 0);
  return { booked, indent, total: booked + indent };
};

/**
 * Collapse the flat Order rows into one booking object for the review screen.
 *
 * `boxNumbers` is the map from currentBoxNumbers(). Passing an empty map (the
 * default) falls back to each row's stored snapshot, which is what the locked
 * bookings use anyway.
 *
 * `includePricing` decides whether the money is in the answer at all. It is OFF
 * by default and switched on from the caller's permission, so a role that can
 * work the booking desk without holding view_pricing gets a response with no
 * prices in it rather than a response it is trusted not to render. Same reason
 * the box number is filtered server-side rather than hidden in the table.
 *
 * PURE — rows and a Map in, a plain object out. Nothing here queries.
 */
export const shapeBooking = (
  rows,
  boxNumbers = new Map(),
  { includePricing = false, indentBySku = null, value = null } = {},
) => {
  const first = rows[0];
  const bookingDate = first.date || first.orderTimestamp || first.createdAt;
  const lock = lockState(rows);
  return {
    orderId: first.orderId,
    customer: first.company || null,
    user: first.user,
    brand: first.brand,
    date: bookingDate,
    // Deadline for raising the PO. Sent as an absolute timestamp so the UI can
    // tick a live countdown without refetching; null once the PO exists, since
    // the booking is no longer at risk of auto-cancellation.
    poDueAt: lock.locked ? null : poDueAt(bookingDate),
    poDeadlineDays: PO_DEADLINE_DAYS,
    status: first.status,
    remarks: first.remarks || null,
    emailId: first.emailId || null,
    phoneNumber: first.phoneNumber || null,
    // The raw location, distinct from shippingAddress below — the pick list
    // prints "location + phone" as a pair for the person carrying it.
    location: first.location || null,
    /*
     * The address SNAPSHOTTED on the booking, or null. No fallback here.
     *
     * This used to read `first.shippingAddress || first.location`, quietly
     * substituting the delivery TOWN when no address had been snapshotted. That
     * was harmless while the picklist printed a single "Place of supply" line —
     * every consumer had its own `|| location` anyway — but it becomes a bug the
     * moment shipping and billing are printed as separate, labelled addresses:
     * the collapse made this field ALWAYS truthy, so a picklist could never tell
     * "we snapshotted an address" from "we only know the town", and the
     * client-side fallback to the customer's profile address was unreachable.
     * A legacy booking printed "Pune" under Shipping Address while the
     * customer's real warehouse address sat unused on their record.
     *
     * So this now reports the FACT and the picklist owns the display policy —
     * in one place, shared by both adapters, instead of half here and half
     * there. `location` is still exposed on its own line above for the
     * consumers that want the town.
     *
     * Safe for every existing reader: PoConfirmModal, OrderToolbar and the
     * picklist's own `location` field each already carry their own
     * `|| booking.location`.
     */
    shippingAddress: first.shippingAddress || null,
    billingAddress: first.billingAddress || null,
    shopNumber: first.shopNumber || null,
    gstCode: first.gstCode || null,
    vendorCode: first.vendorCode || null,
    poDate: first.poDate || null,
    paymentTerm: first.paymentTerm || null,
    promiseDate: first.promiseDate || first.supplyByDate || null,
    ...lock,
    pricing: includePricing ? pricingSummary(rows) : null,
    // Confirmed units only. Left exactly as it was: several readers treat it
    // as "what is on the booking", and widening it in place would silently
    // change what they report. The whole picture is `totals` below.
    totalQuantity: rows.reduce((n, r) => n + (r.confirmedQty || 0), 0),
    totals: bookingTotals(rows, indentBySku),
    /*
     * The FULL order value - booked plus indent - computed by valueBooking()
     * in pricing.service.js, which has to query the product master for any
     * indent SKU the booking cannot rate from its own rows.
     *
     * Passed IN rather than computed here because this function is pure and
     * must stay that way: it is called once per booking in the list response,
     * and a query hidden inside it would be an N+1 that nothing at the call
     * site could see.
     *
     * Behind `includePricing`, like `pricing` above - an order's value is a
     * commercial figure and follows the same permission.
     */
    value: includePricing ? value : null,
    lineCount: rows.length,
    lines: rows.map((r) => ({
      id: r._id,
      skuCode: r.skuCode,
      msilCode: r.msilCode || null,
      // Live mapping while the PO is still pending, the stamped snapshot once
      // it is raised — see currentBoxNumbers().
      //
      // has() rather than `?? snapshot`, because the map holds null for a
      // product that exists with NO box mapped, and that is a different fact
      // from a product the lookup could not resolve at all. `??` collapses the
      // two: an admin who CLEARS a mapping would leave the desk still reading
      // the box number captured at booking time, which is the stale value this
      // whole live lookup exists to avoid. Absent key → fall back; present key
      // → trust it, null included.
      boxNo: (() => {
        if (lock.locked) return r.boxNo || null;
        const key = boxKey(r.skuCode, r.brand);
        return boxNumbers.has(key) ? boxNumbers.get(key) : (r.boxNo || null);
      })(),
      brand: r.brand,
      category: r.category || null,
      bookedQty: r.bookedQty || 0,
      confirmedQty: r.confirmedQty || 0,
      pendingQty: r.pendingQty || 0,
      /*
       * PER-LINE status and delivery schedule.
       *
       * The booking-level `status` above is `first.status`, which cannot answer
       * "does THIS line still have a delivery ahead of it" for a booking whose
       * lines have diverged — and that is the question both the schedule panel
       * and the PO screen have to ask before offering a date control.
       *
       * The dates are what the customer has already been promised, so the PO
       * screen seeds from them rather than from a default: a delivery date
       * nobody chose must never be confirmed by not being noticed. Order
       * History's own adapter already exposed these; the sales desk read a
       * different shape and did not.
       */
      status: r.status,
      scheduledDate: r.scheduledDate || null,
      scheduleNote: r.scheduleNote || null,
      // The rate this customer was given for this line and what it comes to.
      // Present only when the viewer may see pricing; absent, not zeroed, so a
      // template cannot mistake "not allowed to know" for "free".
      ...(includePricing ? {
        unitPrice: asPrice(r.unitPrice),
        amount: lineAmount(r.unitPrice, r.confirmedQty || 0),
      } : {}),
    })),
  };
};

export default { boxKey, currentBoxNumbers, shapeBooking, pricingSummary };
