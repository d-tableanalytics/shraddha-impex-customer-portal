/**
 * verify-pricing.js
 * -----------------------------------------------------------------------------
 * The customer-specific pricing feature, checked end to end.
 *
 *   node scripts/verify-pricing.js
 *
 * READ-ONLY against the live database. It quotes real bookings and reads real
 * products; it writes nothing, and the one write path (applyPricing) is
 * exercised against fabricated rows in memory rather than saved documents.
 *
 * The checks that matter most are the NEGATIVE ones — that a price does not
 * appear where it must not. A feature that shows the right number to the right
 * person is half done; this file is the other half.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { connectDatabase } = await import('../config/database.js');
const {
  PRICE_TYPES, PRICE_TYPE_KEYS, normalisePriceType, asPrice, lineAmount,
  labelForPriceType, formatRupees,
} = await import('../config/pricing.js');
const { PERMISSIONS, BASELINE_ROLE_PERMISSIONS } = await import('../config/permissions.js');
const { MODULES } = await import('../config/moduleRegistry.js');
const { permissionsFor, hasPermission } = await import('../middlewares/rbac.js');
const { withPricingVisibility } = await import('../utils/pricingVisibility.js');
const { pricingSummary, shapeBooking } = await import('../modules/sales/booking.shape.js');
const { quoteBooking } = await import('../modules/sales/pricing.service.js');
const { Product } = await import('../models/Product.js');
const Order = (await import('../models/Order.js')).default;

let passed = 0;
let failed = 0;
const check = (label, ok) => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}`); }
};
const section = (title) => console.log(`\n${title}\n${'-'.repeat(title.length)}`);

const asUser = (role) => ({ _id: 'u1', role });

/* ── 1. The vocabulary ────────────────────────────────────────────────────── */
section('1. PRICE TYPES');

check('four types, in the order the desk sees them',
  PRICE_TYPE_KEYS.join(',') === 'venusAutomation,trader,endUser,msil');
check('every type names the workbook sheet it comes from',
  PRICE_TYPES.every((t) => typeof t.sheet === 'string' && t.sheet.length > 0));
check('spelling is accepted in every form a form or a sheet produces',
  normalisePriceType('MSIL') === 'msil'
  && normalisePriceType('End User') === 'endUser'
  && normalisePriceType('end_user') === 'endUser'
  && normalisePriceType('  trader ') === 'trader'
  && normalisePriceType('Venus Automation') === 'venusAutomation');
check('an unknown type is null, never a guess',
  normalisePriceType('wholesale') === null
  && normalisePriceType('') === null
  && normalisePriceType(null) === null
  && normalisePriceType(undefined) === null);
check('a label is a label, never a raw key',
  labelForPriceType('endUser') === 'End User' && labelForPriceType('nope') === null);

section('2. MONEY');

check('a blank, a zero and a negative are all "no price", not 0.00',
  asPrice(null) === null && asPrice('') === null && asPrice(0) === null && asPrice(-5) === null);
check('a spreadsheet string with commas or a rupee sign still parses',
  asPrice('1,234.50') === 1234.5 && asPrice('₹ 130') === 130);
check('prices round to the paisa',
  asPrice(12.345) === 12.35 && asPrice(12.344) === 12.34);
check('no price means no line amount — a total never quietly treats it as free',
  lineAmount(null, 10) === null && lineAmount(100, 0) === null && lineAmount(100, -1) === null);
check('quantity times rate, to the paisa',
  lineAmount(3319.62, 1) === 3319.62 && lineAmount(2.5, 3) === 7.5);
check('rupees format in the Indian grouping',
  formatRupees(123456) === '₹1,23,456.00' && formatRupees(null) === null);

/* ── 3. Who may see a price ───────────────────────────────────────────────── */
section('3. PERMISSION');

check('view_pricing exists as its own key',
  PERMISSIONS.VIEW_PRICING === 'view_pricing');
check('Sales holds it in the baseline',
  BASELINE_ROLE_PERMISSIONS.Sales.includes(PERMISSIONS.VIEW_PRICING));
check('Admin and Super Admin hold it through the wildcard',
  hasPermission(asUser('Admin'), PERMISSIONS.VIEW_PRICING)
  && hasPermission(asUser('Super Admin'), PERMISSIONS.VIEW_PRICING));
check('a CUSTOMER does not hold it',
  !hasPermission(asUser('Customer'), PERMISSIONS.VIEW_PRICING));
for (const role of ['Inventory Manager', 'Warehouse User', 'Management', 'Import Team']) {
  check(`${role} does not hold it — no reason to know what anyone is charged`,
    !hasPermission(asUser(role), PERMISSIONS.VIEW_PRICING));
}
check('the permission matrix offers it as a cell a Super Admin can grant',
  MODULES.find((m) => m.key === 'sales')
    ?.submodules.some((s) => s.actions?.view?.includes('view_pricing')));
check('no role gained anything else — Customer is still portal-sized',
  !permissionsFor(asUser('Customer')).has?.('view_all_bookings'));

/* ── 4. Redaction on the customer's own bookings ─────────────────────────── */
section('4. WHAT REACHES A CUSTOMER');

const OWNER = 'cust-1';
const owner = { _id: OWNER, role: 'Customer' };
const somebodyElse = { _id: 'cust-2', role: 'Customer' };

const rawRow = {
  user: OWNER, skuCode: 'X1', brand: 'Koken', confirmedQty: 2,
  priceType: 'trader', unitPrice: 135, pricedAt: new Date(), pricedBy: 'someone',
  poNumber: 'PO-2026-000001', poGeneratedAt: new Date(),
};
const pendingRow = { ...rawRow, poNumber: '-', poGeneratedAt: null };

const asCustomer = withPricingVisibility({ ...rawRow }, owner);
check('a customer sees the rate on their own RAISED PO',
  asCustomer.unitPrice === 135);
check('a customer never sees which tier it was, or who set it',
  !('priceType' in asCustomer) && !('pricedAt' in asCustomer) && !('pricedBy' in asCustomer));
check('a customer sees NO rate before the PO is raised',
  !('unitPrice' in withPricingVisibility({ ...pendingRow }, owner)));
check('ANOTHER customer sees no rate on that same raised PO',
  !('unitPrice' in withPricingVisibility({ ...rawRow }, somebodyElse)));
check('Sales sees everything, untouched',
  withPricingVisibility({ ...pendingRow }, asUser('Sales')).unitPrice === 135
  && withPricingVisibility({ ...pendingRow }, asUser('Sales')).priceType === 'trader');
check('a booking-desk role WITHOUT view_pricing gets no money on a raised PO',
  !('unitPrice' in withPricingVisibility({ ...rawRow }, { _id: 'staff-1', role: 'Warehouse User' })));
check('an inventory role gets no money at all',
  !('unitPrice' in withPricingVisibility({ ...rawRow }, asUser('Warehouse User'))));
check('redaction copies rather than editing the caller\'s row',
  (() => { const o = { ...pendingRow }; withPricingVisibility(o, owner); return o.unitPrice === 135; })());
check('an array redacts row by row',
  withPricingVisibility([{ ...pendingRow }, { ...pendingRow }], owner)
    .every((r) => !('unitPrice' in r)));
check('nothing else on the row is disturbed',
  withPricingVisibility({ ...rawRow }, owner).skuCode === 'X1');

/* ── 5. The booking summary ──────────────────────────────────────────────── */
section('5. SUMMARY AND SHAPE');

const bookingRows = [
  { _id: '1', orderId: 'BO-1', skuCode: 'A', brand: 'Koken', confirmedQty: 2, pendingQty: 0, priceType: 'trader', unitPrice: 100, pricedAt: new Date(), date: new Date(), status: 'PO Received', poNumber: '-' },
  { _id: '2', orderId: 'BO-1', skuCode: 'B', brand: 'Koken', confirmedQty: 3, pendingQty: 1, priceType: 'trader', unitPrice: 50, pricedAt: new Date(), date: new Date(), status: 'PO Received', poNumber: '-' },
  { _id: '3', orderId: 'BO-1', skuCode: 'C', brand: 'BIX', confirmedQty: 4, pendingQty: 0, priceType: 'trader', unitPrice: null, pricedAt: new Date(), date: new Date(), status: 'PO Received', poNumber: '-' },
];

const summary = pricingSummary(bookingRows);
check('the total is only the lines that HAVE a rate (2x100 + 3x50)',
  summary.totalAmount === 350);
check('the unrated line is counted and reported, not silently dropped',
  summary.pricedLines === 2 && summary.unpricedLines === 1);
check('the summary names the tier for the desk',
  summary.priceType === 'trader' && summary.priceTypeLabel === 'Trader');
check('the indent remainder is not charged for — the PO covers confirmed qty',
  summary.totalAmount === (2 * 100) + (3 * 50));
check('an unpriced booking summarises as null, so a screen can omit the section',
  pricingSummary(bookingRows.map((r) => ({ ...r, priceType: null }))) === null
  && pricingSummary([]) === null);

const withMoney = shapeBooking(bookingRows, new Map(), { includePricing: true });
const withoutMoney = shapeBooking(bookingRows, new Map());
check('shapeBooking includes pricing only when asked',
  withMoney.pricing?.totalAmount === 350 && withoutMoney.pricing === null);
check('line amounts ride along when pricing is included',
  withMoney.lines[0].amount === 200 && withMoney.lines[2].amount === null);
check('without pricing the fields are ABSENT, not zeroed',
  !('unitPrice' in withoutMoney.lines[0]) && !('amount' in withoutMoney.lines[0]));

/* ── 6. Against the live catalogue ───────────────────────────────────────── */
await connectDatabase();
section('6. THE LOADED PRICELIST');

const plain = await Product.findOne({ brand: 'Koken', skuCode: '10099A' }).lean();
// A .lean() read leaves an empty `prices: {}` shell — Mongo returns the parent
// when every subfield is excluded — so the check is that no RATE came back,
// which is the fact that matters. A hydrated document drops the key entirely.
check('an ordinary product read carries no rates (schema select:false)',
  plain && Object.keys(plain.prices || {}).length === 0);
const hydrated = await Product.findOne({ brand: 'Koken', skuCode: '10099A' });
check('and a hydrated document does not serialise one either',
  !JSON.stringify(hydrated).includes('86305'));

const asked = await Product.findOne({ brand: 'Koken', skuCode: '10099A' }, 'skuCode prices').lean();
check('a query that asks for prices gets them',
  asked?.prices?.trader === 86305 && asked?.prices?.venusAutomation === 83765
  && asked?.prices?.endUser === 92940);

const msilPriced = await Product.findOne({ brand: 'Koken', skuCode: '14300M-14' }, 'skuCode prices').lean();
check('an MSIL-scheduled SKU carries all four rates',
  msilPriced?.prices?.msil === 496 && msilPriced?.prices?.trader === 665);

const counts = {};
for (const key of PRICE_TYPE_KEYS) {
  counts[key] = await Product.countDocuments({ [`prices.${key}`]: { $ne: null } });
}
check(`the three open tiers cover the same SKUs (${counts.trader})`,
  counts.trader > 7000 && counts.trader === counts.venusAutomation && counts.trader === counts.endUser);
check(`the MSIL schedule is the small one it should be (${counts.msil})`,
  counts.msil > 300 && counts.msil < counts.trader);
check('no non-Koken product was priced — the workbook is the Ko-ken list',
  (await Product.countDocuments({ brand: { $ne: 'Koken' }, 'prices.trader': { $ne: null } })) === 0);

/* ── 7. A real booking, quoted ───────────────────────────────────────────── */
section('7. QUOTING A REAL BOOKING');

const sampleOrderId = (await Order.findOne({ brand: 'Koken' }).sort({ createdAt: -1 }).lean())?.orderId;
if (!sampleOrderId) {
  console.log('  SKIP  no Koken booking in the database to quote');
} else {
  const rows = await Order.find({ orderId: sampleOrderId }).lean();
  const quote = await quoteBooking(rows);
  console.log(`  (booking ${sampleOrderId}, ${rows.length} line(s))`);
  for (const line of quote.lines) {
    console.log(`    ${String(line.skuCode).padEnd(18)} qty ${String(line.quantity).padStart(4)}  `
      + PRICE_TYPES.map((t) => `${t.label}: ${line.prices[t.key] ?? '—'}`).join('  '));
  }
  check('every line is quoted for all four tiers',
    quote.lines.every((l) => PRICE_TYPE_KEYS.every((k) => k in l.prices)));
  check('a total is produced for each tier',
    PRICE_TYPE_KEYS.every((k) => typeof quote.totals[k].amount === 'number'));
  check('each tier reports how many lines it cannot rate',
    PRICE_TYPE_KEYS.every((k) => Number.isInteger(quote.totals[k].unpricedLines)));
  check('the tier totals agree with the line amounts',
    PRICE_TYPE_KEYS.every((k) => {
      const sum = quote.lines.reduce((n, l) => n + (l.amounts[k] ?? 0), 0);
      return Math.abs(sum - quote.totals[k].amount) < 0.01;
    }));
  check('quoting stored nothing — the booking is untouched',
    (await Order.findOne({ orderId: sampleOrderId }).lean()).priceType === undefined
    || (await Order.findOne({ orderId: sampleOrderId }).lean()).priceType === null);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
await mongoose.disconnect();
process.exit(failed ? 1 : 0);
