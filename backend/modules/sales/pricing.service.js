import Order from '../../models/Order.js';
import { Product } from '../../models/Product.js';
import {
  PRICE_TYPES, normalisePriceType, labelForPriceType, asPrice, lineAmount,
} from '../../config/pricing.js';
import { boxKey } from './booking.shape.js';

/**
 * Pricing a booking: what the four tiers say, and stamping the one that was
 * offered onto the order.
 *
 * TWO OPERATIONS, AND THE LINE BETWEEN THEM IS THE SECURITY BOUNDARY.
 *
 *   quoteBooking()  reads the tier prices from the product master and returns
 *                   ALL FOUR for each line. This is the internal view. It is
 *                   never stored and never reaches a customer — the only route
 *                   that calls it is behind view_pricing.
 *
 *   applyPricing()  copies ONE tier onto every row of the booking. From that
 *                   point the customer can see that number on their own PO, and
 *                   the other three are not on the order at all — not hidden by
 *                   a filter, not present.
 *
 * Which means a leak of the other tiers cannot happen by forgetting to filter a
 * response: there is nothing to filter, because the order row only ever holds
 * the price that was given.
 *
 * THE PRICE IS RESOLVED HERE, NOT ACCEPTED FROM THE CALLER. The desk sends a
 * price TYPE and the server looks the amount up. A client that could post an
 * amount could post any amount, and the picklist is a commercial document.
 */

/** The quantity a PO charges for: what stock actually covered. */
const chargeableQty = (row) => Number(row?.confirmedQty || 0);

/**
 * SKU -> product prices for a set of order rows, in one query.
 *
 * Keyed by SKU *and* brand for the same reason box numbers are: the same code
 * can exist under two brands and they are different products with different
 * prices. Only the Ko-ken pricelist is loaded today, so a BIX or IMADA line
 * resolves to a product with no prices — which is "no price on file", exactly
 * as it should read.
 */
const priceBookFor = async (rows) => {
  const skus = [...new Set(rows.map((r) => r.skuCode).filter(Boolean))];
  if (!skus.length) return new Map();
  const products = await Product.find(
    { skuCode: { $in: skus } },
    'skuCode brand prices',
  ).lean();
  return new Map(products.map((p) => [boxKey(p.skuCode, p.brand), p.prices || {}]));
};

/**
 * Every tier price for every line, with the totals each tier would produce.
 *
 * INTERNAL ONLY — the whole point is to show the desk what the alternatives
 * cost, which is precisely what the customer must not see.
 *
 * `unpricedLines` is reported per tier rather than left to be inferred from
 * nulls, because it is the number that decides whether a tier is usable at all:
 * offering MSIL on a booking where three of five SKUs are not in the MSIL
 * schedule produces a PO with three blank amounts, and the desk should find
 * that out while choosing rather than afterwards.
 */
export const quoteBooking = async (rows) => {
  const book = await priceBookFor(rows);

  const lines = rows.map((row) => {
    const prices = book.get(boxKey(row.skuCode, row.brand)) || {};
    const quantity = chargeableQty(row);
    return {
      id: row._id,
      skuCode: row.skuCode,
      msilCode: row.msilCode || null,
      brand: row.brand,
      boxNo: row.boxNo || null,
      quantity,
      pendingQty: Number(row.pendingQty || 0),
      prices: Object.fromEntries(
        PRICE_TYPES.map((t) => [t.key, asPrice(prices[t.key])]),
      ),
      amounts: Object.fromEntries(
        PRICE_TYPES.map((t) => [t.key, lineAmount(prices[t.key], quantity)]),
      ),
    };
  });

  const totals = Object.fromEntries(PRICE_TYPES.map((type) => {
    let amount = 0;
    let pricedLines = 0;
    let unpricedLines = 0;
    for (const line of lines) {
      const lineTotal = line.amounts[type.key];
      if (lineTotal === null) { unpricedLines += 1; continue; }
      amount += lineTotal;
      pricedLines += 1;
    }
    return [type.key, {
      amount: Math.round(amount * 100) / 100,
      pricedLines,
      unpricedLines,
    }];
  }));

  return {
    currency: 'INR',
    priceTypes: PRICE_TYPES.map(({ key, label, description }) => ({ key, label, description })),
    lines,
    totals,
  };
};

/**
 * Stamp one tier onto every row of a booking.
 *
 * EVERY row, including the ones with no price under that tier: those get a null
 * unitPrice and the type anyway, so the picklist can say "Trader price, no rate
 * on file for this SKU" rather than leaving the reader to guess whether the
 * line was missed or is genuinely unpriced.
 *
 * Passing `priceType: null` CLEARS the pricing — the way to undo a wrong choice
 * — and is a deliberate action rather than a side effect of omitting a field;
 * the callers only reach this with an explicit null.
 *
 * @returns {{ priceType, priceTypeLabel, pricedAt, lines, pricedLines, unpricedLines, totalAmount }}
 */
export const applyPricing = async ({ orderId, rows, priceType, actor = null }) => {
  const type = normalisePriceType(priceType);

  if (!type) {
    await Order.updateMany(
      { orderId },
      { $set: { priceType: null, unitPrice: null, pricedAt: null, pricedBy: null } },
    );
    return {
      priceType: null, priceTypeLabel: null, pricedAt: null,
      lines: rows.length, pricedLines: 0, unpricedLines: rows.length, totalAmount: null,
    };
  }

  const book = await priceBookFor(rows);
  const pricedAt = new Date();

  let pricedLines = 0;
  let unpricedLines = 0;
  let totalAmount = 0;

  for (const row of rows) {
    const prices = book.get(boxKey(row.skuCode, row.brand)) || {};
    const unitPrice = asPrice(prices[type]);
    if (unitPrice === null) unpricedLines += 1;
    else {
      pricedLines += 1;
      totalAmount += lineAmount(unitPrice, chargeableQty(row)) || 0;
    }
    await Order.updateOne(
      { _id: row._id },
      { $set: { priceType: type, unitPrice, pricedAt, pricedBy: actor?._id ?? null } },
    );
  }

  return {
    priceType: type,
    priceTypeLabel: labelForPriceType(type),
    pricedAt,
    lines: rows.length,
    pricedLines,
    unpricedLines,
    totalAmount: Math.round(totalAmount * 100) / 100,
  };
};

/**
 * What the booking was priced at, from the rows themselves.
 *
 * Re-exported from booking.shape.js, which owns it: it is pure row-shaping and
 * belongs beside the rest of it. Named here too so a reader following the
 * pricing feature finds it where they look for it.
 */
export { pricingSummary } from './booking.shape.js';

export default { quoteBooking, applyPricing };
