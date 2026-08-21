import { Product } from '../../models/Product.js';
import { lockState, poDueAt, PO_DEADLINE_DAYS } from '../../utils/bookingLock.js';

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
 * Collapse the flat Order rows into one booking object for the review screen.
 *
 * `boxNumbers` is the map from currentBoxNumbers(). Passing an empty map (the
 * default) falls back to each row's stored snapshot, which is what the locked
 * bookings use anyway.
 *
 * PURE — rows and a Map in, a plain object out. Nothing here queries.
 */
export const shapeBooking = (rows, boxNumbers = new Map()) => {
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
    shippingAddress: first.shippingAddress || first.location || null,
    billingAddress: first.billingAddress || null,
    shopNumber: first.shopNumber || null,
    gstCode: first.gstCode || null,
    vendorCode: first.vendorCode || null,
    poDate: first.poDate || null,
    paymentTerm: first.paymentTerm || null,
    promiseDate: first.promiseDate || first.supplyByDate || null,
    ...lock,
    totalQuantity: rows.reduce((n, r) => n + (r.confirmedQty || 0), 0),
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
    })),
  };
};

export default { boxKey, currentBoxNumbers, shapeBooking };
