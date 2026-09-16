import { pricingAppliesTo } from './pricingVisibility.js';
import { isPoGenerated } from './bookingLock.js';
import { openIndentsByOrder } from './bookingJourney.js';
import { valueBooking } from '../modules/sales/pricing.service.js';

/**
 * Attach each booking's open-indent value to its rows.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CUSTOMER'S OWN DOCUMENT NEEDS THIS
 * ---------------------------------------------------------------------------
 *
 * The PO preview prices what SHIPPED, and beside it now reports what is still
 * on indent and what that will cost, so the paper can be reconciled against the
 * sales desk's Total Amount card. Both sides have to read the same number, and
 * the only place that number exists is the reservations behind the booking -
 * `pendingQty` on the order row is the shortfall FROZEN at confirmation and
 * drifts as stock arrives, and a SKU that could not be fulfilled at all never
 * got a row to carry it.
 *
 * ---------------------------------------------------------------------------
 * IT PASSES THE SAME GATE AS THE UNIT RATE
 * ---------------------------------------------------------------------------
 *
 * An indent value is a price, so it is shown on exactly the terms a price is:
 * to a `view_pricing` reader, or to the OWNER of a booking whose PO has been
 * raised. Anyone else gets rows with no `bookingValue` on them at all, the same
 * way withPricingVisibility() leaves them with no `unitPrice`. Computed after
 * redaction and gated on the same two predicates, rather than added before it
 * and trusted to be stripped - a field that has to be removed later is one
 * refactor away from being kept.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT COSTS
 * ---------------------------------------------------------------------------
 *
 * One query for every indent across the whole result (openIndentsByOrder is
 * batched for this), and then valueBooking() only for bookings that actually
 * HAVE an open indent - which is the minority, and is what keeps this off the
 * hot path for an Admin whose result set is every booking in the system.
 */
export const attachBookingValues = async (rows, user, source) => {
  const privileged = pricingAppliesTo(user);

  // Which bookings may this reader see money on at all.
  const eligible = new Map(); // orderId -> source rows
  for (const row of source) {
    const orderId = row?.orderId;
    if (!orderId) continue;
    const owned = Boolean(row.user) && Boolean(user?._id)
      && String(row.user) === String(user._id);
    if (!privileged && !(isPoGenerated(row) && owned)) continue;
    if (!eligible.has(orderId)) eligible.set(orderId, []);
    eligible.get(orderId).push(row);
  }
  if (!eligible.size) return rows;

  const indents = await openIndentsByOrder([...eligible.keys()]);

  const valueByOrder = new Map();
  for (const [orderId, bookingRows] of eligible) {
    const indentBySku = indents.get(String(orderId)) ?? new Map();
    // No indent, nothing to report. Skipping here is also what keeps this from
    // firing a product lookup per booking on a list that is mostly fulfilled.
    if (indentBySku.size === 0) continue;
    valueByOrder.set(orderId, await valueBooking({ rows: bookingRows, indentBySku }));
  }
  if (!valueByOrder.size) return rows;

  // The rows handed back are the REDACTED copies, so stamp those.
  const list = Array.isArray(rows) ? rows : [rows];
  for (const row of list) {
    const value = valueByOrder.get(row?.orderId);
    if (value) row.value = value;
  }
  return rows;
};

export default { attachBookingValues };
