import OversoldException from '../models/OversoldException.js';
import Order from '../models/Order.js';

/**
 * Reporting stock a movement could not account for — instead of inventing it.
 *
 * THE RULE THIS FILE EXISTS TO HOLD
 * ---------------------------------
 *     availableForSale + bookedQuantity === totalAvailableQuantity
 *     all three >= 0
 *
 * Before this, a release of 7 units against a `bookedQuantity` of 4 credited
 * `availableForSale` with the full 7 while giving back only 4 — so three units
 * that existed nowhere became sellable. The fix is not to credit the
 * difference. But a difference is still a fact about the data, and silently
 * dropping it is how the original problem stayed invisible for three months.
 *
 * So the shortfall is written down. `OversoldException` already exists for
 * exactly this question — "stock has been promised that does not exist, which
 * bookings are affected, a person must decide" — and already drives a worklist.
 * This reuses it rather than inventing a second place to look.
 *
 * NEVER THROWS. These helpers run inside the booking, cancellation and PO
 * transactions. A reporting failure must not fail a customer's request, for
 * the same reason the dual-write swallows its own errors: the stock mutation
 * has already been decided, and refusing it now would turn a bookkeeping
 * problem into a customer-facing one.
 */

/** The bookings whose units are implicated, oldest confirmation first. */
const affectedBookings = async (skuCode, session) => {
  const opts = session ? { session } : {};
  const rows = await Order.find(
    { skuCode, stockState: { $in: ['reserved', null] }, status: { $ne: 'Cancelled' } },
    'orderId company skuCode confirmedQty orderTimestamp createdAt',
    opts,
  ).sort({ orderTimestamp: 1, createdAt: 1 }).limit(50).lean();
  return rows.map((r) => ({
    orderId: r.orderId,
    company: r.company || null,
    skuCode: r.skuCode,
    confirmedQty: r.confirmedQty || 0,
    confirmedAt: r.orderTimestamp || r.createdAt || null,
  }));
};

/**
 * How many units OTHER live bookings hold for this SKU.
 *
 * WHY THIS IS NEEDED. `bookedQuantity` is one number per SKU, summed across
 * every booking — the legacy schema has no per-booking allocation. So when the
 * aggregate is understated, settling one booking can take back more than that
 * booking's own share and drain the units another customer is holding. The
 * second customer's ORDER is untouched, so the commitment survives on paper;
 * but the counter no longer reserves anything for them, and their stock becomes
 * sellable to someone else. That is the defect this answers.
 *
 * The commitment register (`orders`) is the only source that still knows who
 * holds what, so it is what the cap is computed from.
 *
 * `excludeReferenceId` is the booking being settled. settleBooking() claims a
 * line — flipping `stockState` away from 'reserved' — BEFORE moving stock, so
 * the booking being settled is normally excluded already; the filter is belt
 * and braces, and makes the helper correct when called directly.
 *
 * Deliberately consulted ONLY on the corrupted path (see stockLedger.js). On a
 * healthy row the cap is arithmetically equal to the quantity being settled, so
 * computing it would cost a query to learn nothing.
 */
export const committedElsewhere = async (skuCode, excludeReferenceId, session = null) => {
  const opts = session ? { session } : {};
  const [row] = await Order.aggregate([
    {
      $match: {
        skuCode,
        status: { $ne: 'Cancelled' },
        stockState: { $in: ['reserved', null] },
        ...(excludeReferenceId ? { orderId: { $ne: excludeReferenceId } } : {}),
      },
    },
    { $group: { _id: null, held: { $sum: { $ifNull: ['$confirmedQty', 0] } } } },
  ], opts);
  return Math.max(0, row?.held ?? 0);
};

/**
 * Record that `requested` units were asked for and only `applied` could be
 * accounted for. The remainder is a discrepancy, not stock.
 *
 * @param {object}  input
 * @param {object}  input.product    the product document being mutated
 * @param {number}  input.requested  what the workflow asked to move
 * @param {number}  input.applied    what inventory could actually account for
 * @param {'release'|'consume'|'sync'} input.operation
 * @param {object}  [input.ctx]      ledger provenance ({ workflow, referenceId })
 * @param {object}  [input.session]
 */
export const reportStockDiscrepancy = async ({
  product, requested, applied, operation, ctx = null, session = null,
}) => {
  const shortfall = (requested ?? 0) - (applied ?? 0);
  if (shortfall <= 0) return null;

  try {
    const opts = session ? { session } : {};
    const [doc] = await OversoldException.create([{
      skuCode: product.skuCode,
      brand: product.brand,
      onHand: product.totalAvailableQuantity ?? 0,
      reserved: product.bookedQuantity ?? 0,
      shortfall,
      source: operation,
      transactionId: ctx?.referenceId ?? null,
      affectedBookings: await affectedBookings(product.skuCode, session),
    }], opts);

    console.warn(
      `[StockInvariant] ${operation} on ${product.skuCode}: asked for ${requested}, ` +
      `inventory could account for ${applied}. ${shortfall} unit(s) NOT credited ` +
      `(ref ${ctx?.referenceId ?? 'n/a'}). Raised ${doc?._id}.`,
    );
    return doc;
  } catch (error) {
    // See the header: reporting may not fail the workflow it reports on.
    console.error(
      `[StockInvariant] Could not record a ${operation} discrepancy for ` +
      `${product?.skuCode ?? 'unknown SKU'}: ${error.message}`,
    );
    return null;
  }
};

export default { reportStockDiscrepancy, committedElsewhere };
