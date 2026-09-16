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
 * The FULL value of a booking: what stock covered, plus what is still on indent.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `pricingSummary`
 * ---------------------------------------------------------------------------
 *
 * `pricingSummary` deliberately values `confirmedQty` only, because that is what
 * the PURCHASE ORDER charges for - an indent remainder has not shipped and does
 * not belong on the document the customer pays against. That is correct for the
 * PO and wrong for the question the desk is asking here, which is "what is this
 * whole order worth?".
 *
 * So this is a second, wider figure rather than a change to the first. Moving
 * `pricingSummary` to include the indent would silently re-value every PO.
 *
 * ---------------------------------------------------------------------------
 * WHERE AN INDENT LINE'S RATE COMES FROM
 * ---------------------------------------------------------------------------
 *
 * A reservation carries no price - only a quantity - so a rate has to be found:
 *
 *   1. THE BOOKING'S OWN ROW for that SKU, when it has one. This is the rate
 *      this customer was actually given, snapshotted by applyPricing, and it is
 *      what they will be charged when the indent is fulfilled.
 *   2. THE PRODUCT MASTER at the booking's price type, for a SKU that never got
 *      an order row (nothing could be fulfilled, so confirmation created none).
 *      Resolved at the booking's own brand, since a booking is single-brand and
 *      the same code can exist under two with different prices.
 *   3. NOTHING. The SKU has no rate on file, and it is counted as unpriced
 *      rather than silently valued at zero.
 *
 * An UNPRICED booking values nothing at all: with no price type chosen there is
 * no rate to apply, and a total of 0 would read as "this order is worth nothing"
 * rather than "nobody has priced it yet".
 *
 * ---------------------------------------------------------------------------
 * NO GST HERE
 * ---------------------------------------------------------------------------
 *
 * Subtotals only. The rate and the rounding rule live in ONE place -
 * frontend/src/constants/pricing.js - where the picklist, the PDF and the screen
 * all read them. A second copy on this side is how a portal ends up quoting two
 * different tax figures for one order.
 *
 * @param {object[]} rows          the booking's Order rows
 * @param {Map<string,number>} indentBySku  open indent quantity per SKU
 */
/**
 * The rate that applies to each of `skus`, under the booking's own price type.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT JUST A PRODUCT LOOKUP
 * ---------------------------------------------------------------------------
 * A SKU the booking already carries is rated at the price THAT CUSTOMER WAS
 * GIVEN, snapshotted on the order row by `applyPricing`. Re-reading it from the
 * product master would quietly re-rate a booking at today's price, which is the
 * one thing a raised purchase order must never do.
 *
 * The master is consulted only for the ORPHANS — indent SKUs that never became
 * an order row, so the booking holds no rate for them. Those are exactly the
 * lines that could not be fulfilled at all (see the note on `bookingTotals` in
 * booking.shape.js), and they have no snapshot to prefer.
 *
 * Extracted from `valueBooking`, which did this inline, because the indent
 * LINES now need the same answer. Two copies of "what does this SKU cost" is
 * how a total and the lines under it come to disagree.
 *
 * @returns {Promise<Map<string, number>>} sku -> rate. A SKU with no rate
 *   anywhere is ABSENT rather than zero: "we do not know" and "it is free" are
 *   different facts and the callers count them separately.
 */
export const ratesForSkus = async ({ rows = [], skus = [] } = {}) => {
  const rateBySku = new Map();
  if (!rows.length) return rateBySku;

  const type = normalisePriceType(rows[0]?.priceType);
  if (!type) return rateBySku;

  // What the customer was actually given, per line.
  for (const row of rows) {
    const rate = asPrice(row.unitPrice);
    if (rate !== null) rateBySku.set(row.skuCode, rate);
  }

  // Only the SKUs the booking cannot rate itself need the master.
  const orphans = [...new Set(skus)].filter((sku) => !rateBySku.has(sku));
  if (orphans.length) {
    const brand = rows[0].brand;
    const products = await Product.find(
      { skuCode: { $in: orphans } },
      'skuCode brand prices',
    ).lean();
    const book = new Map(products.map((pr) => [boxKey(pr.skuCode, pr.brand), pr.prices || {}]));
    for (const sku of orphans) {
      const rate = asPrice((book.get(boxKey(sku, brand)) || {})[type]);
      if (rate !== null) rateBySku.set(sku, rate);
    }
  }

  return rateBySku;
};

/**
 * The open indent, as LINES rather than a total.
 *
 * The desk cross-checks a booking against the customer's paper PO, and the
 * indent is the half of it that has no order row to look at — a line stock
 * could not cover at all exists ONLY as a reservation. A summed quantity says
 * how much is outstanding; it cannot say which SKUs, which is what makes the
 * two documents comparable.
 *
 * Rates come from `ratesForSkus`, so an indent line shows the same money the
 * booking's own total was built from. A line with no rate keeps `unitPrice:
 * null` and `amount: null` rather than zero, and the caller reports it as
 * unpriced.
 */
export const valueIndentLines = async ({ rows = [], lines = [] } = {}) => {
  if (!lines.length) return [];

  const rateBySku = await ratesForSkus({ rows, skus: lines.map((l) => l.skuCode) });

  return lines.map((line) => {
    const unitPrice = rateBySku.get(line.skuCode) ?? null;
    return { ...line, unitPrice, amount: lineAmount(unitPrice, line.quantity || 0) };
  });
};

export const valueBooking = async ({ rows = [], indentBySku = new Map() } = {}) => {
  const empty = {
    booking: { amount: null, pricedLines: 0, unpricedLines: 0 },
    indent: { amount: null, quantity: 0, pricedSkus: 0, unpricedSkus: 0 },
    subtotal: null,
  };
  if (!rows.length) return empty;

  const type = normalisePriceType(rows[0]?.priceType);
  const indentQty = [...indentBySku.values()].reduce((n, q) => n + (q || 0), 0);

  // No price type on the booking means no rate was ever chosen. Report the
  // indent's QUANTITY, which is still a fact, and nothing about its value.
  if (!type) return { ...empty, indent: { ...empty.indent, quantity: indentQty } };

  // ── What stock covered ──────────────────────────────────────────────────
  let bookingAmount = 0;
  let pricedLines = 0;
  let unpricedLines = 0;
  for (const row of rows) {
    const amount = lineAmount(row.unitPrice, row.confirmedQty || 0);
    if (amount === null) { unpricedLines += 1; continue; }
    bookingAmount += amount;
    pricedLines += 1;
  }

  // ── What is still on indent ─────────────────────────────────────────────
  // One rate table, shared with the indent LINES the detail response carries,
  // so the section under Booking Items and this total cannot disagree.
  const rateBySku = await ratesForSkus({ rows, skus: [...indentBySku.keys()] });

  let indentAmount = 0;
  let pricedSkus = 0;
  let unpricedSkus = 0;
  for (const [sku, qty] of indentBySku) {
    const amount = lineAmount(rateBySku.get(sku) ?? null, qty);
    if (amount === null) { unpricedSkus += 1; continue; }
    indentAmount += amount;
    pricedSkus += 1;
  }

  const round = (n) => Math.round(n * 100) / 100;
  const booking = {
    amount: pricedLines ? round(bookingAmount) : null,
    pricedLines,
    unpricedLines,
  };
  const indent = {
    amount: pricedSkus ? round(indentAmount) : null,
    quantity: indentQty,
    pricedSkus,
    unpricedSkus,
  };

  return {
    booking,
    indent,
    // Null only when NEITHER side could be valued - otherwise the sum of
    // whatever was rated, with the counts above saying what it left out.
    subtotal:
      booking.amount === null && indent.amount === null
        ? null
        : round((booking.amount ?? 0) + (indent.amount ?? 0)),
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
