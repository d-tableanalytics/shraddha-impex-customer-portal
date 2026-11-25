/**
 * STANDALONE INDENTS, and the DISPATCH DATE that belongs to a SKU.
 *
 * ---------------------------------------------------------------------------
 * THE TWO THINGS THE CONFIRMATION MAIL WAS NOT SAYING
 * ---------------------------------------------------------------------------
 *
 * 1. A line stock could not cover AT ALL never becomes an order row — the
 *    confirmation only pushes one when `confirmedQty > 0`. The booking table is
 *    built from those rows, so such a line had nowhere to appear and the mail
 *    simply did not mention it. A customer who asked for five materials, three
 *    of them partly in stock, was told about the three and heard nothing about
 *    the two they got none of. The shortfall was counted in the totals, so the
 *    mail was not WRONG — it was unreadable: units were missing from a table
 *    that nonetheless added up.
 *
 * 2. The dispatch date was a single booking-level figure in the header. The
 *    desk schedules PER LINE (`Order.scheduledDate`), so the moment two SKUs
 *    leave on different days that one date was a promise nobody made — and
 *    nothing on the page said which SKU it belonged to.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE PIN
 * ---------------------------------------------------------------------------
 *
 * The rule that makes the two tables trustworthy is that they PARTITION the
 * indent: every open line appears in exactly one of them. A SKU in both would
 * double the customer's outstanding quantity on the page, which is worse than
 * the omission it replaced. The removed-line case below is the one that breaks
 * a naive implementation, and it is tested for that reason.
 *
 * The dispatch tests pin the mapping (date against its own SKU), the plural
 * case (different dates shown separately), and the absence case (an em dash,
 * never a borrowed date — a customer who waits in on the strength of another
 * line's date is the failure this column exists to prevent).
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startTestMongo, stopTestMongo, clearCollections, syncIndexes } from './helpers/mongo.js';
import AuditLog from '../models/AuditLog.js';
import Order from '../models/Order.js';
import Reservation from '../models/Reservation.js';
import { Product, ProductKoken } from '../models/Product.js';
import {
  indentIdFor, openIndentLinesFor, buildBookingJourney, journeyTablesHtml,
  indentOnlyJourney, dispatchDatesBySku, QTY_EDIT_ACTIONS, STANDALONE_HEADING,
} from '../utils/bookingJourney.js';

/**
 * Where the standalone-indent section begins, found by its HEADING ELEMENT.
 *
 * Deliberately not a search for the heading's TEXT. It now reads "Indent", and
 * the booking table above it already heads a column of exactly that name — so
 * a plain string search lands in the wrong table and every assertion built on
 * the offset silently measures the wrong half of the mail.
 */
const HEADING_EL = new RegExp(`<h4[^>]*>\\s*${STANDALONE_HEADING}\\s*</h4>`);
const hasIndentSection = (html) => HEADING_EL.test(html);
const indentSectionAt = (html) => {
  const at = html.search(HEADING_EL);
  assert.notEqual(at, -1, 'the mail has an indent section to split on');
  return at;
};
import { shapeBooking } from '../modules/sales/booking.shape.js';

const ORDER_ID = 'BO-2026-000501';
const INDENT_ID = 'PI-2026-000501';
const CUSTOMER = new mongoose.Types.ObjectId();
const BOOKED_ON = new Date('2026-11-20T06:30:00.000Z');

/** A dispatch date as both the default and the desk store it: UTC midnight. */
const day = (iso) => new Date(`${iso}T00:00:00.000Z`);

before(async () => {
  await startTestMongo();
  await syncIndexes(Order, Reservation, Product);
});
after(async () => { await stopTestMongo(); });
beforeEach(async () => { await clearCollections(); });

/**
 * One order row, as a confirmation that found stock writes it.
 *
 * `pendingQty` is the shortfall FROZEN on the row; the live balance is the
 * reservation, which is what every figure under test actually reads.
 */
const row = (skuCode, {
  confirmedQty = 10, pendingQty = 0, scheduledDate = day('2026-11-23'), lineSeq = 0,
} = {}) => ({
  orderId: ORDER_ID,
  brand: 'Koken',
  user: CUSTOMER,
  status: 'PO Received',
  lineSeq,
  skuCode,
  date: BOOKED_ON,
  orderTimestamp: BOOKED_ON,
  requestedQty: confirmedQty,
  bookedQty: confirmedQty + pendingQty,
  confirmedQty,
  pendingQty,
  poNumber: '-',
  scheduledDate,
});

/** One open indent line under this booking's indent number. */
const indent = (skuCode, quantity, over = {}) => ({
  reservationId: `RES-${skuCode}`,
  customerId: CUSTOMER,
  productId: new mongoose.Types.ObjectId(),
  skuCode,
  msilCode: `MSIL-${skuCode}`,
  quantity,
  expiryDate: new Date(Date.now() + 7 * 864e5),
  reservedBy: CUSTOMER,
  status: 'Pending',
  indentNumber: INDENT_ID,
  ...over,
});

const product = (skuCode, description) => ProductKoken.create({
  skuCode, brand: 'Koken', description, category: ['Tools'],
});

// ===========================================================================
// The classification
// ===========================================================================

describe('openIndentLinesFor — standalone vs partial', () => {
  test('a SKU with no order row is standalone; one with a row is not', async () => {
    await Order.create([row('SKU-A', { confirmedQty: 8, pendingQty: 4 })]);
    await Reservation.create([indent('SKU-A', 4), indent('SKU-B', 25)]);

    const { lines } = await openIndentLinesFor(ORDER_ID);
    const bySku = Object.fromEntries(lines.map((l) => [l.skuCode, l]));

    // SKU-A was partly covered — its shortfall already shows on the booking
    // row. SKU-B was covered not at all and exists only as this reservation.
    assert.equal(bySku['SKU-A'].standalone, false);
    assert.equal(bySku['SKU-B'].standalone, true);
  });

  test('the lines carry the material NAME, so a code need not be looked up', async () => {
    await product('SKU-B', 'Torque Wrench 1/2in');
    await Reservation.create([indent('SKU-B', 25)]);

    const { lines } = await openIndentLinesFor(ORDER_ID);
    assert.equal(lines[0].productName, 'Torque Wrench 1/2in');
  });

  test('a SKU the master has no name for stays NULL, never the code again', async () => {
    await Reservation.create([indent('SKU-GHOST', 3)]);

    const { lines } = await openIndentLinesFor(ORDER_ID);
    // The screen falls back to the SKU it is already showing. Echoing the code
    // here would make an empty master look populated.
    assert.equal(lines[0].productName, null);
  });

  test('the caller\'s already-loaded rows are used rather than queried again', async () => {
    await Reservation.create([indent('SKU-A', 4)]);
    // Nothing is in the Order collection, so a line is standalone by the
    // database — but the caller says it holds a row for it, and the caller is
    // the one mid-edit with the truth.
    const { lines } = await openIndentLinesFor(ORDER_ID, { rows: [{ skuCode: 'SKU-A' }] });
    assert.equal(lines[0].standalone, false);
  });
});

// ===========================================================================
// The journey — the two tables must PARTITION the indent
// ===========================================================================

describe('buildBookingJourney — standaloneIndentLines', () => {
  test('🔴 the line with no order row is reported, and only in the standalone list', async () => {
    await Order.create([row('SKU-A', { confirmedQty: 8, pendingQty: 4 })]);
    await product('SKU-B', 'Impact Socket Set');
    await Reservation.create([indent('SKU-A', 4), indent('SKU-B', 25)]);

    const journey = await buildBookingJourney({ orderId: ORDER_ID });

    // The booking table holds SKU-A and its live shortfall, exactly as before.
    assert.deepEqual(journey.summary.lines.map((l) => [l.skuCode, l.indent]), [['SKU-A', 4]]);
    // SKU-B could never have appeared there — it has no row to hang off.
    assert.deepEqual(
      journey.standaloneIndentLines.map((l) => [l.skuCode, l.quantity, l.productName]),
      [['SKU-B', 25, 'Impact Socket Set']],
    );
  });

  test('a booking whose indent is entirely PARTIAL reports no standalone lines', async () => {
    await Order.create([row('SKU-A', { confirmedQty: 8, pendingQty: 4 })]);
    await Reservation.create([indent('SKU-A', 4)]);

    const journey = await buildBookingJourney({ orderId: ORDER_ID });

    // Nothing new is added to this mail: it is the one it always was.
    assert.deepEqual(journey.standaloneIndentLines, []);
    assert.equal(journey.summary.totalIndent, 4);
  });

  test('a booking stock covered in full reports no standalone lines', async () => {
    await Order.create([row('SKU-A', { confirmedQty: 10 })]);

    const journey = await buildBookingJourney({ orderId: ORDER_ID });
    assert.deepEqual(journey.standaloneIndentLines, []);
  });

  test('🔴 a REMOVED line with an open indent is not listed twice', async () => {
    // The case that breaks the obvious implementation. SKU-R has no order row
    // — the desk deleted it — so "no order row" would call it standalone. But
    // the change replay pushes it back onto the booking table from the audit
    // trail, carrying its open indent in the Indent column. Listing it in both
    // places would double the quantity the customer is told they are waiting
    // for, which is worse than the omission this feature fixes.
    await Order.create([row('SKU-A', { confirmedQty: 8, pendingQty: 4 })]);
    await Reservation.create([indent('SKU-A', 4), indent('SKU-R', 12)]);
    await AuditLog.create({
      action: QTY_EDIT_ACTIONS.desk,
      method: 'PATCH',
      endpoint: `/api/v1/sales/${ORDER_ID}/items`,
      ipAddress: '127.0.0.1',
      userAgent: 'test',
      meta: {
        orderId: ORDER_ID,
        changes: [{ type: 'removed', skuCode: 'SKU-R', fromQty: 12 }],
      },
    });

    const journey = await buildBookingJourney({ orderId: ORDER_ID });

    const inBookingTable = journey.summary.lines.map((l) => l.skuCode);
    assert.ok(inBookingTable.includes('SKU-R'), 'the removed line still reports on the booking table');
    assert.deepEqual(journey.standaloneIndentLines, [], 'and must not be repeated below it');
  });

  test('🔴 a CONFIRMED or CANCELLED reservation is not a standalone indent', async () => {
    await Order.create([row('SKU-A', { confirmedQty: 10 })]);
    await Reservation.create([
      indent('SKU-C', 7, { status: 'Confirmed' }),
      indent('SKU-D', 9, { status: 'Cancelled' }),
    ]);

    const journey = await buildBookingJourney({ orderId: ORDER_ID });
    // One became stock, the other went away. Neither is something the customer
    // is still waiting for, and naming them would be a mail about nothing.
    assert.deepEqual(journey.standaloneIndentLines, []);
  });

  test('another booking\'s indent is never borrowed', async () => {
    await Order.create([row('SKU-A', { confirmedQty: 10 })]);
    await Reservation.create([
      indent('SKU-X', 50, { indentNumber: indentIdFor('BO-2026-000999') }),
    ]);

    const journey = await buildBookingJourney({ orderId: ORDER_ID });
    assert.deepEqual(journey.standaloneIndentLines, []);
  });
});

// ===========================================================================
// The dispatch date, per SKU
// ===========================================================================

describe('dispatchDatesBySku', () => {
  test('each SKU carries its OWN date', () => {
    const map = dispatchDatesBySku([
      row('SKU-A', { scheduledDate: day('2026-11-23') }),
      row('SKU-B', { scheduledDate: day('2026-12-01') }),
    ]);

    assert.deepEqual(map.get('SKU-A').map((d) => d.toISOString()), [day('2026-11-23').toISOString()]);
    assert.deepEqual(map.get('SKU-B').map((d) => d.toISOString()), [day('2026-12-01').toISOString()]);
  });

  test('an unscheduled line contributes NO date, not a null one', () => {
    const map = dispatchDatesBySku([row('SKU-A', { scheduledDate: null })]);
    // Empty, so the renderer shows an em dash. A null entry would print as a
    // date cell with nothing in it and read as a scheduling bug.
    assert.deepEqual(map.get('SKU-A'), []);
  });

  test('two rows of the same SKU on different days keep both dates', () => {
    // A desk-added line, or stock that arrived later and was allocated as its
    // own row. Collapsing these would drop a delivery already promised.
    const map = dispatchDatesBySku([
      row('SKU-A', { scheduledDate: day('2026-11-23') }),
      row('SKU-A', { scheduledDate: day('2026-12-05'), lineSeq: 1 }),
      row('SKU-A', { scheduledDate: day('2026-11-23'), lineSeq: 2 }),
    ]);

    assert.deepEqual(
      map.get('SKU-A').map((d) => d.toISOString().slice(0, 10)),
      ['2026-11-23', '2026-12-05'],
      'de-duplicated on the day, and in order',
    );
  });
});

// ===========================================================================
// What the customer actually reads
// ===========================================================================

describe('journeyTablesHtml', () => {
  const build = () => buildBookingJourney({ orderId: ORDER_ID });

  test('🔴 the indent table names the SKU, the material and the quantity', async () => {
    await Order.create([row('SKU-A', { confirmedQty: 8, pendingQty: 4 })]);
    await product('SKU-B', 'Impact Socket Set');
    await Reservation.create([indent('SKU-A', 4), indent('SKU-B', 25)]);

    const html = journeyTablesHtml(await build(), { audience: 'customer' });

    assert.ok(hasIndentSection(html));
    assert.match(html, /Impact Socket Set/);
    assert.match(html, /SKU-B/);
    assert.match(html, /25 pcs/);
    assert.match(html, /RES-SKU-B/, 'the line reference, so one line can be quoted back');
    assert.match(html, new RegExp(INDENT_ID), 'the indent it was raised under');
    assert.match(html, new RegExp(ORDER_ID), 'and the booking it belongs to');
  });

  test('🔴 the existing Booking Details table is left exactly as it was', async () => {
    await Order.create([row('SKU-A', { confirmedQty: 8, pendingQty: 4 })]);
    await Reservation.create([indent('SKU-A', 4), indent('SKU-B', 25)]);

    const html = journeyTablesHtml(await build(), { audience: 'customer' });
    const bookingTable = html.slice(0, indentSectionAt(html));

    // The partial indent still reports where it always did, and the standalone
    // line has not crept into the table above or into its totals.
    assert.match(bookingTable, /Booking Details/);
    assert.match(bookingTable, /SKU-A/);
    assert.ok(!bookingTable.includes('SKU-B'), 'the standalone SKU stays out of the booking table');
    assert.ok(!bookingTable.includes('25 pcs'), 'and out of its totals');
  });

  test('a booking with no standalone lines gets no second table', async () => {
    await Order.create([row('SKU-A', { confirmedQty: 8, pendingQty: 4 })]);
    await Reservation.create([indent('SKU-A', 4)]);

    const html = journeyTablesHtml(await build(), { audience: 'customer' });
    assert.ok(!hasIndentSection(html));
  });

  test('🔴 the dispatch date is printed against its own SKU', async () => {
    await Order.create([
      row('SKU-A', { scheduledDate: day('2026-11-23'), lineSeq: 0 }),
      row('SKU-B', { scheduledDate: day('2026-12-01'), lineSeq: 1 }),
    ]);

    const html = journeyTablesHtml(await build(), { audience: 'customer' });

    assert.match(html, /Dispatch Date/);
    // Each row carries its own, and the two are not interchangeable: the cell
    // that follows SKU-A must hold the 23rd and not the 1st.
    const rowA = html.slice(html.indexOf('SKU-A'), html.indexOf('SKU-B'));
    const rowB = html.slice(html.indexOf('SKU-B'));
    assert.match(rowA, /23 Nov 2026/);
    assert.ok(!rowA.includes('01 Dec 2026'));
    assert.match(rowB, /01 Dec 2026/);
  });

  test('🔴 an unscheduled line shows a dash, never another line\'s date', async () => {
    await Order.create([
      row('SKU-A', { scheduledDate: day('2026-11-23'), lineSeq: 0 }),
      row('SKU-B', { scheduledDate: null, lineSeq: 1 }),
    ]);

    const html = journeyTablesHtml(await build(), { audience: 'customer' });
    const rowB = html.slice(html.indexOf('SKU-B'));

    assert.ok(!rowB.includes('23 Nov 2026'), 'SKU-B must not inherit SKU-A\'s date');
    assert.match(rowB, /Not scheduled yet/);
  });

  test('a SKU with two dates shows both, separately', async () => {
    await Order.create([
      row('SKU-A', { scheduledDate: day('2026-11-23'), lineSeq: 0 }),
      row('SKU-A', { scheduledDate: day('2026-12-05'), lineSeq: 1 }),
    ]);

    const html = journeyTablesHtml(await build(), { audience: 'customer' });
    assert.match(html, /23 Nov 2026/);
    assert.match(html, /05 Dec 2026/);
  });

  test('the date is the day the desk picked, whatever zone the server runs in', async () => {
    // Stored as UTC midnight. Read in the server's zone it would render as the
    // day BEFORE on anything west of UTC, telling the customer to expect goods
    // a day early.
    await Order.create([row('SKU-A', { scheduledDate: day('2026-12-01') })]);

    const html = journeyTablesHtml(await build(), { audience: 'customer' });
    assert.match(html, /01 Dec 2026/);
    assert.ok(!html.includes('30 Nov 2026'));
  });

  test('🔴 the PO mail drops the column, because its schedule table carries the dates', async () => {
    await Order.create([
      row('SKU-A', { scheduledDate: day('2026-11-23'), lineSeq: 0 }),
      row('SKU-B', { scheduledDate: day('2026-12-01'), lineSeq: 1 }),
    ]);

    const journey = await build();
    const withColumn = journeyTablesHtml(journey, { audience: 'customer' });
    const withoutColumn = journeyTablesHtml(journey, { audience: 'customer', dispatchDates: false });

    assert.match(withColumn, /Dispatch Date/);
    assert.ok(!withoutColumn.includes('Dispatch Date'));
    // The dates go with the column — printing them twice on one mail is the
    // whole reason it is dropped there.
    assert.ok(!withoutColumn.includes('23 Nov 2026'));
    // And NOTHING ELSE moves: every other figure is the same table.
    assert.match(withoutColumn, /Booking Details/);
    assert.match(withoutColumn, /SKU-A/);
    assert.match(withoutColumn, /SKU-B/);
  });

  test('🔴 suppressing the column does not disturb the Total row', async () => {
    // The footer's cells have to match the header's. A column removed from one
    // and not the other is how a Total ends up under the wrong heading.
    await Order.create([row('SKU-A', { confirmedQty: 8, pendingQty: 4 })]);
    await Reservation.create([indent('SKU-A', 4)]);

    const journey = await build();
    const html = journeyTablesHtml(journey, { audience: 'support', dispatchDates: false });

    const headCells = (html.match(/<th /g) || []).length;
    const footRow = html.slice(html.indexOf('<tfoot>'), html.indexOf('</tfoot>'));
    // colspan="2" collapses two of them, so the cells account for every column.
    const footCells = (footRow.match(/<td /g) || []).length + 1;
    assert.equal(headCells, footCells);
  });

  test('the standalone table is untouched by the PO mail\'s suppression', async () => {
    // Only the booking table's column is in question. A standalone line has no
    // dispatch date at all and is not on the schedule table either, so dropping
    // it from the mail would lose it outright.
    await Order.create([row('SKU-A', { confirmedQty: 8, pendingQty: 4 })]);
    await product('SKU-B', 'Impact Socket Set');
    await Reservation.create([indent('SKU-A', 4), indent('SKU-B', 25)]);

    const html = journeyTablesHtml(await build(), { audience: 'customer', dispatchDates: false });

    assert.ok(hasIndentSection(html));
    assert.match(html, /Impact Socket Set/);
    assert.match(html, /25 pcs/);
  });

  test('🔴 a STANDALONE-indent mail is not given a second copy of its own lines', () => {
    // Every line on that mail is standalone in the literal sense, and its one
    // table is already built from them. A second table would print the same
    // indent twice and double the total on the page.
    const html = journeyTablesHtml(
      indentOnlyJourney({ indentId: INDENT_ID, lines: [{ skuCode: 'SKU-B', quantity: 25 }] }),
      { audience: 'customer' },
    );

    assert.match(html, /SKU-B/);
    assert.ok(!hasIndentSection(html));
    // Nothing is in hand, so there is no dispatch date column to show either.
    assert.ok(!html.includes('Dispatch Date'));
  });

  test('support keeps its MSIL column, and the footers stay in line with it', async () => {
    await Order.create([row('SKU-A', { confirmedQty: 8, pendingQty: 4 })]);
    await Reservation.create([indent('SKU-A', 4), indent('SKU-B', 25)]);

    const html = journeyTablesHtml(await build(), { audience: 'support' });

    assert.match(html, /MSIL Code/);
    assert.match(html, /MSIL-SKU-B/);
    // A stale colspan is how a Total ends up one cell out. Both tables widen by
    // one when the MSIL column is on.
    assert.match(html, /colspan="2"/, 'booking table total spans SKU + MSIL');
    assert.match(html, /colspan="3"/, 'standalone table total spans SKU + MSIL + name');
  });
});

// ===========================================================================
// The sales desk response
// ===========================================================================

describe('the shaped booking', () => {
  test('counts the standalone lines so the desk is told, not left to count', () => {
    const out = shapeBooking([row('SKU-A', { confirmedQty: 8, pendingQty: 4 })], new Map(), {
      indent: {
        indentNumber: INDENT_ID,
        lines: [
          { skuCode: 'SKU-A', quantity: 4, standalone: false },
          { skuCode: 'SKU-B', quantity: 25, standalone: true },
          { skuCode: 'SKU-C', quantity: 6, standalone: true },
        ],
      },
    });

    assert.equal(out.indent.totalQuantity, 35);
    assert.equal(out.indent.standaloneCount, 2);
    assert.equal(out.indent.standaloneQuantity, 31);
  });

  test('a booking whose indent is entirely partial reports none', () => {
    const out = shapeBooking([row('SKU-A', { confirmedQty: 8, pendingQty: 4 })], new Map(), {
      indent: {
        indentNumber: INDENT_ID,
        lines: [{ skuCode: 'SKU-A', quantity: 4, standalone: false }],
      },
    });

    assert.equal(out.indent.standaloneCount, 0);
    assert.equal(out.indent.standaloneQuantity, 0);
  });

  test('the counts are not pricing, so they survive a reader without view_pricing', () => {
    const out = shapeBooking([row('SKU-A')], new Map(), {
      includePricing: false,
      indent: {
        indentNumber: INDENT_ID,
        lines: [{ skuCode: 'SKU-B', quantity: 25, standalone: true }],
      },
    });

    // Which materials are missing from a booking is an operational fact, and
    // every role that can open the drawer needs it. Only the money is gated.
    assert.equal(out.indent.standaloneCount, 1);
    assert.equal('amount' in out.indent, false);
  });
});
