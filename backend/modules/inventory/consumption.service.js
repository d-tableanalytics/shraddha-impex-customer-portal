/**
 * Daily average consumption, measured from what actually sold.
 *
 *     Daily Average (Normal) = quantity sold during the lead time ÷ days observed
 *
 * A SKU with a 30-day lead time that sold 300 units in the last 30 days
 * consumes 10 a day. The window is the SKU's OWN lead time, because that is
 * the period the figure has to cover: Max Level asks "how much will I get
 * through while a replacement order is in transit".
 *
 * THE DIVISOR IS DAYS OBSERVED, NOT LEAD TIME — and the two are the same thing
 * once enough history exists. Dividing by a window you have not lived through
 * yet does not measure a slower rate, it measures the same sales against a
 * bigger denominator: 30 units sold in 8 days reads as 0.08/day against a
 * 365-day lead time, when the SKU is plainly selling nearer 3.75/day. That
 * understates every rate by (days observed ÷ lead time), shrinks Max Level by
 * the same factor, and files healthy stock as overstock.
 *
 * So the divisor is the shorter of the lead time and the sales history that
 * actually exists. As history lengthens the two converge, and past a full lead
 * time this IS "sold during lead time ÷ lead time".
 *
 * WHAT COUNTS AS SOLD
 * Confirmed order quantities, not ledger ISSUE movements. Both describe the
 * same event — a PO is raised, stock is consumed — so counting both would
 * double every sale. Orders are used because they are the customer-facing
 * record and they predate the ledger, which only began at go-live. Cancelled
 * orders are excluded: stock that came back was never consumed.
 *
 * WHAT IT WILL NOT DO
 * It never writes a zero. A SKU with no sales in its window keeps whatever rate
 * it already has, because "nothing sold in the last 8 days" is not evidence
 * that a SKU with a 365-day lead time consumes nothing — it is evidence that
 * the history is shorter than the question. Writing zero there would erase the
 * target, the reorder point and the band on a SKU nobody has stopped selling.
 */

import Order from '../../models/Order.js';
import { Product, createProductModel } from '../../models/Product.js';
import { recomputeHealthForSkus } from './health.service.js';
import { recordAudit } from '../../utils/auditLog.js';

/** Order states in which stock genuinely left. Cancelled is not one of them. */
const SOLD_STATUSES = ['PO Received', 'Ready for Dispatch', 'Dispatched', 'Delivered'];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Recalculate the Normal daily average for every SKU that sold in its window.
 *
 * @param {object}  opts
 * @param {string}  [opts.brand]      limit to one brand
 * @param {string[]}[opts.skuCodes]   limit to specific SKUs
 * @param {boolean} [opts.dryRun]     compute and report, write nothing
 */
export const recalculateDailyAverage = async ({
  brand = null, skuCodes = null, dryRun = false, actor = null, req = null,
} = {}) => {
  const filter = {
    skuCode: { $nin: [null, ''] },
    leadTime: { $gt: 0 },
    ...(brand ? { brand } : {}),
    ...(skuCodes?.length ? { skuCode: { $in: skuCodes } } : {}),
  };

  const products = await Product.find(filter, 'skuCode brand leadTime dailyAvgConsumption').lean();
  if (products.length === 0) {
    return { considered: 0, withSales: 0, updated: 0, unchanged: 0, skippedNoSales: 0, changes: [] };
  }

  // The window differs per SKU, so the widest one bounds a single query and the
  // per-SKU cut-off is applied in memory. One round trip instead of 8,000.
  const widest = Math.max(...products.map((p) => p.leadTime));
  const since = new Date(Date.now() - widest * DAY_MS);

  const sales = await Order.find(
    { status: { $in: SOLD_STATUSES }, confirmedQty: { $gt: 0 }, date: { $gte: since } },
    'skuCode confirmedQty date',
  ).lean();

  const bySku = new Map();
  for (const s of sales) {
    if (!s.skuCode) continue;
    if (!bySku.has(s.skuCode)) bySku.set(s.skuCode, []);
    bySku.get(s.skuCode).push(s);
  }

  const changes = [];
  const opsByBrand = new Map();
  let withSales = 0;
  let unchanged = 0;

  // How far back sales records go at all. Nothing before this can be observed,
  // so no SKU's window can honestly be longer.
  const earliestSale = sales.reduce(
    (min, s) => Math.min(min, new Date(s.date).getTime()), Date.now(),
  );
  const historyDays = Math.max(1, Math.ceil((Date.now() - earliestSale) / DAY_MS));

  for (const p of products) {
    const cutoff = Date.now() - p.leadTime * DAY_MS;
    const lines = (bySku.get(p.skuCode) || []).filter((s) => new Date(s.date).getTime() >= cutoff);
    const soldQty = lines.reduce((n, s) => n + (s.confirmedQty || 0), 0);
    const observedDays = Math.min(p.leadTime, historyDays);

    // No sales in the window: leave the SKU exactly as it is. See the note at
    // the top — this is the difference between "consumes nothing" and "we have
    // not been watching long enough to say".
    if (soldQty <= 0) continue;
    withSales += 1;

    // Rounded to six places: the rate feeds Max Level, and carrying full
    // float precision only reproduces the 0.3333333333 artefacts already in
    // the source data.
    const rate = Math.round((soldQty / observedDays) * 1e6) / 1e6;
    const current = p.dailyAvgConsumption?.normal ?? 0;
    if (rate === current) { unchanged += 1; continue; }

    changes.push({
      skuCode: p.skuCode,
      brand: p.brand,
      leadTime: p.leadTime,
      observedDays,
      soldQty,
      orderCount: lines.length,
      from: current,
      to: rate,
    });

    if (!opsByBrand.has(p.brand)) opsByBrand.set(p.brand, []);
    opsByBrand.get(p.brand).push({
      updateOne: {
        filter: { skuCode: p.skuCode },
        // The dotted path writes ONLY the Normal season. Low and Peak are
        // separate figures nobody measured here, and $set-ing the parent
        // object would wipe them.
        update: { $set: { 'dailyAvgConsumption.normal': rate } },
      },
    });
  }

  const result = {
    considered: products.length,
    withSales,
    updated: dryRun ? 0 : changes.length,
    wouldUpdate: changes.length,
    unchanged,
    skippedNoSales: products.length - withSales,
    historyDays,
    windowNote: historyDays < widest
      ? `Sales history is ${historyDays} day(s) long, shorter than the longest lead time `
        + `(${widest} days), so rates are measured over the history that exists. They become `
        + 'lead-time rates as history accumulates.'
      : `Each SKU measured over its own lead time, the longest being ${widest} days.`,
    changes: changes.slice(0, 200),
    dryRun,
  };

  if (dryRun || changes.length === 0) return result;

  for (const [b, ops] of opsByBrand) {
    // The brand discriminator stamps `brand` on write, so the branded model is
    // used rather than the base one.
    const Model = createProductModel(b);
    await Model.bulkWrite(ops, { ordered: false });
  }

  // Max Level is derived from this rate, so the band, reorder point and
  // coverage all move with it.
  await recomputeHealthForSkus(changes.map((c) => c.skuCode));

  if (actor) {
    await recordAudit(actor, 'Daily Average Recalculated',
      `Daily average consumption recalculated from sales for ${changes.length} SKU(s).`,
      req, { meta: { updated: changes.length, considered: products.length, brand } });
  }

  return result;
};

export default { recalculateDailyAverage, SOLD_STATUSES };
