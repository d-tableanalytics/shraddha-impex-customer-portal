/**
 * The delivery schedule a customer is sent — the document, and who gets which
 * columns.
 *
 * Four things here are worth a real database rather than a mock, and they are
 * the four the requirement actually turns on:
 *
 *   1. THE MARUTI COLUMN. An MSIL customer's schedule carries the Maruti part
 *      number; everyone else's does not carry the column at all. That decision
 *      is made from the CUSTOMER RECORD, so it cannot be tested without one.
 *   2. THE DERIVED DISPATCH FIGURES. There is no per-line dispatched quantity
 *      in this system — Qty Dispatch, Dispatch Date and Qty Pending are all
 *      read off the line's lifecycle status, and getting that wrong puts a
 *      number on a customer's document that nothing can reconcile.
 *   3. RAISING A PO WITH A DATE. The date has to land on every open SKU line
 *      and on none of the closed ones.
 *   4. THE ATTACHMENTS. Both formats have to build from the same document, and
 *      the .xlsx has to be a real workbook — which only reading it back proves.
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import Order from '../models/Order.js';
import User from '../models/User.js';
import {
  buildBookingScheduleDoc, buildScheduleAttachments, buildScheduleMailParts,
  showsMsilCode, OPEN_BOOKING_STATUSES,
} from '../utils/deliverySchedule.js';
import {
  scheduleColumns, buildScheduleXlsx, buildSchedulePdf, scheduleTableHtml,
} from '../modules/orders/deliverySchedule.render.js';
import { startTestMongo, stopTestMongo, clearCollections } from './helpers/mongo.js';

const require = createRequire(import.meta.url);

const ORDER_ID = 'BO-2026-000501';
const PO = '7000050930';

const makeCustomer = (over = {}) => User.create({
  email: over.email || `c${Math.random().toString(36).slice(2, 8)}@example.com`,
  password: 'x',
  user: 'Contact Person',
  company: 'Fallback Company',
  customerName: 'Maruti Suzuki India Ltd',
  customerCategory: 'MSIL',
  role: 'Customer',
  ...over,
});

/** One SKU line of a booking. Defaults to an open, PO-raised, undispatched line. */
const makeLine = (user, over = {}) => Order.create({
  orderId: ORDER_ID,
  brand: 'Koken',
  user,
  skuCode: '14145M.150-14',
  msilCode: 'MA0LW004000',
  requestedQty: 30,
  bookedQty: 30,
  confirmedQty: 30,
  status: 'PO Received',
  poNumber: PO,
  poGeneratedAt: new Date('2026-07-01T06:00:00Z'),
  poDate: new Date('2026-07-01T06:00:00Z'),
  ...over,
});

before(async () => { await startTestMongo(); });
after(async () => { await stopTestMongo(); });
beforeEach(async () => { await clearCollections(); });

/* ── Who sees the Maruti code ─────────────────────────────────────────────── */

describe('the Maruti Code column', () => {
  test('is present for an MSIL customer and carries the code', async () => {
    const customer = await makeCustomer();
    await makeLine(customer._id, { lineSeq: 0 });

    const doc = await buildBookingScheduleDoc(ORDER_ID);
    assert.equal(doc.showMsilCode, true);

    const headers = scheduleColumns(doc).map((c) => c.header);
    assert.ok(headers.includes('Maruti Code'));
    assert.equal(doc.lines[0].msilCode, 'MA0LW004000');
    assert.match(scheduleTableHtml(doc), /Maruti Code/);
  });

  test('is absent for a non-MSIL customer, even though the row carries a code', async () => {
    // The row genuinely has an msilCode — that is the case that matters. The
    // column must go because of WHO the document is for, not because the data
    // happened to be empty.
    const customer = await makeCustomer({ customerCategory: 'Regular Customer', customerName: 'Sharma Traders' });
    await makeLine(customer._id, { lineSeq: 0 });

    const doc = await buildBookingScheduleDoc(ORDER_ID);
    assert.equal(doc.showMsilCode, false);

    const headers = scheduleColumns(doc).map((c) => c.header);
    assert.ok(!headers.includes('Maruti Code'));
    assert.ok(!scheduleTableHtml(doc).includes('Maruti Code'));
  });

  test('the per-account override switches it on without the MSIL category', async () => {
    const customer = await makeCustomer({ customerCategory: 'Customer', showMsilCode: true });
    await makeLine(customer._id, { lineSeq: 0 });

    const doc = await buildBookingScheduleDoc(ORDER_ID);
    assert.equal(doc.showMsilCode, true);
  });

  test('is decided by the CUSTOMER, never by the staff member generating it', () => {
    // The trap this guards: msilVisibility.msilAppliesTo() says yes to every
    // Sales and inventory role, so reusing it here would put a Maruti column on
    // a non-MSIL customer's document whenever the desk raised the PO.
    assert.equal(showsMsilCode({ role: 'Sales', customerCategory: 'Regular Customer' }), false);
    assert.equal(showsMsilCode({ role: 'Admin' }), false);
    assert.equal(showsMsilCode({ customerCategory: 'MSIL' }), true);
  });

  test('the remaining columns are the same for both customers', async () => {
    const msil = scheduleColumns({ showMsilCode: true, skuLabel: 'Koken Code' }).map((c) => c.header);
    const other = scheduleColumns({ showMsilCode: false, skuLabel: 'Koken Code' }).map((c) => c.header);
    assert.deepEqual(msil.filter((h) => h !== 'Maruti Code'), other);
    assert.deepEqual(other, [
      'PO NO.', 'Sr. No.', 'Koken Code', 'Qty',
      'QTY DISPATCH', 'DISPATCH DATE', 'QTY PENDING', 'PENDING SCHEDULE',
    ]);
  });
});

/* ── The figures the document derives ─────────────────────────────────────── */

describe('the dispatch and pending figures', () => {
  test('an undispatched line reports nothing dispatched and everything pending', async () => {
    const customer = await makeCustomer();
    await makeLine(customer._id, { lineSeq: 0, confirmedQty: 22, scheduledDate: null });

    const [line] = (await buildBookingScheduleDoc(ORDER_ID)).lines;
    assert.equal(line.qty, 22);
    assert.equal(line.qtyDispatched, 0);
    assert.equal(line.dispatchDate, null);
    assert.equal(line.pendingSchedule, 'CHECKING WITH OEM');
  });

  test('a dispatched line reports its quantity and the date the stage was set', async () => {
    const customer = await makeCustomer();
    const dispatchedOn = new Date('2026-08-03T06:00:00Z');
    await makeLine(customer._id, {
      lineSeq: 0, confirmedQty: 30, status: 'Dispatched', statusTimestamp: dispatchedOn,
    });

    const [line] = (await buildBookingScheduleDoc(ORDER_ID)).lines;
    assert.equal(line.qtyDispatched, 30);
    assert.equal(new Date(line.dispatchDate).toISOString(), dispatchedOn.toISOString());
    // Fully dispatched: nothing outstanding, so no pending schedule to state.
    assert.equal(line.pendingSchedule, '');
  });

  test("'Delivered' counts as dispatched — it is a later stage, not a different one", async () => {
    const customer = await makeCustomer();
    await makeLine(customer._id, {
      lineSeq: 0, confirmedQty: 12, status: 'Delivered', statusTimestamp: new Date('2026-08-10T06:00:00Z'),
    });

    const [line] = (await buildBookingScheduleDoc(ORDER_ID)).lines;
    assert.equal(line.qtyDispatched, 12);
    assert.equal(line.qty - line.qtyDispatched, 0);
  });

  test('a scheduled pending line prints its date instead of the OEM placeholder', async () => {
    const customer = await makeCustomer();
    await makeLine(customer._id, { lineSeq: 0, scheduledDate: new Date('2026-08-03T00:00:00Z') });

    const [line] = (await buildBookingScheduleDoc(ORDER_ID)).lines;
    assert.match(line.pendingSchedule, /^\d{2}-\d{2}-2026$/);
  });

  test('a scheduling note stands in when there is a note but no date', async () => {
    const customer = await makeCustomer();
    await makeLine(customer._id, { lineSeq: 0, scheduleNote: 'Awaiting vessel' });

    const [line] = (await buildBookingScheduleDoc(ORDER_ID)).lines;
    assert.equal(line.pendingSchedule, 'Awaiting vessel');
  });

  test('the totals add up across a mixed booking', async () => {
    const customer = await makeCustomer();
    await makeLine(customer._id, {
      lineSeq: 0, confirmedQty: 30, status: 'Dispatched', statusTimestamp: new Date('2026-08-03T06:00:00Z'),
    });
    await makeLine(customer._id, { lineSeq: 1, skuCode: '13145M.200-12', confirmedQty: 22 });

    const doc = await buildBookingScheduleDoc(ORDER_ID);
    assert.deepEqual(doc.totals, { qty: 52, dispatched: 30, pending: 22 });
  });

  test('a cancelled line is left off entirely — nobody is sending those goods', async () => {
    const customer = await makeCustomer();
    await makeLine(customer._id, { lineSeq: 0 });
    await makeLine(customer._id, { lineSeq: 1, skuCode: 'CANCELLED-SKU', status: 'Cancelled', confirmedQty: 99 });

    const doc = await buildBookingScheduleDoc(ORDER_ID);
    assert.equal(doc.lines.length, 1);
    assert.equal(doc.totals.qty, 30);
    assert.ok(!doc.lines.some((l) => l.skuCode === 'CANCELLED-SKU'));
  });

  test('Sr. No. is renumbered densely, so a gap in lineSeq is never shown', async () => {
    // lineSeq is deliberately sparse: a line that became an indent leaves a gap.
    // A customer's document reading 1, 2, 4 invites a question about a row that
    // was never theirs.
    const customer = await makeCustomer();
    await makeLine(customer._id, { lineSeq: 0 });
    await makeLine(customer._id, { lineSeq: 3, skuCode: 'B-2' });
    await makeLine(customer._id, { lineSeq: 7, skuCode: 'C-3' });

    const doc = await buildBookingScheduleDoc(ORDER_ID);
    assert.deepEqual(doc.lines.map((l) => l.sr), [1, 2, 3]);
  });
});

/* ── The booking-level date ───────────────────────────────────────────────── */

describe('the delivery schedule date', () => {
  test('is the EARLIEST dated line, so it never overstates the wait', async () => {
    const customer = await makeCustomer();
    await makeLine(customer._id, { lineSeq: 0, scheduledDate: new Date('2026-09-20T00:00:00Z') });
    await makeLine(customer._id, { lineSeq: 1, skuCode: 'B-2', scheduledDate: new Date('2026-08-03T00:00:00Z') });

    const doc = await buildBookingScheduleDoc(ORDER_ID);
    assert.equal(new Date(doc.deliveryScheduleDate).toISOString(), new Date('2026-08-03T00:00:00Z').toISOString());
  });

  test('is null when nothing has been scheduled', async () => {
    const customer = await makeCustomer();
    await makeLine(customer._id, { lineSeq: 0 });
    assert.equal((await buildBookingScheduleDoc(ORDER_ID)).deliveryScheduleDate, null);
  });
});

/* ── Headings that depend on the booking ──────────────────────────────────── */

describe('the document heading', () => {
  test('a raised PO is titled and referenced as a purchase order', async () => {
    const customer = await makeCustomer();
    await makeLine(customer._id, { lineSeq: 0 });

    const doc = await buildBookingScheduleDoc(ORDER_ID);
    assert.equal(doc.reference, PO);
    assert.equal(doc.referenceLabel, 'Purchase Order No.');
    assert.match(doc.title, /Purchase Order/);
    assert.equal(doc.skuLabel, 'Koken Code');
  });

  test('a booking with no PO yet falls back to the booking id', async () => {
    const customer = await makeCustomer();
    await makeLine(customer._id, { lineSeq: 0, poNumber: '-', poGeneratedAt: null });

    const doc = await buildBookingScheduleDoc(ORDER_ID);
    assert.equal(doc.reference, ORDER_ID);
    assert.equal(doc.lines[0].poNumber, ORDER_ID);
    assert.match(doc.title, /Booking/);
  });

  test('a booking spanning brands gets the neutral SKU heading', async () => {
    const customer = await makeCustomer();
    await makeLine(customer._id, { lineSeq: 0, brand: 'Koken' });
    await makeLine(customer._id, { lineSeq: 1, brand: 'IMADA', skuCode: 'IM-1' });

    assert.equal((await buildBookingScheduleDoc(ORDER_ID)).skuLabel, 'SKU Code');
  });
});

/* ── The attachments ──────────────────────────────────────────────────────── */

describe('the Excel and PDF attachments', () => {
  test('both are produced, and the .xlsx reads back as a real workbook', async () => {
    const customer = await makeCustomer();
    await makeLine(customer._id, {
      lineSeq: 0, confirmedQty: 30, status: 'Dispatched', statusTimestamp: new Date('2026-08-03T06:00:00Z'),
    });
    await makeLine(customer._id, { lineSeq: 1, skuCode: '13145M.200-12', msilCode: 'MA0M1000000', confirmedQty: 22 });

    const { doc, attachments, tableHtml } = await buildScheduleMailParts(ORDER_ID);
    assert.equal(attachments.length, 2);
    assert.deepEqual(attachments.map((a) => a.filename), [
      `Delivery_Schedule_${PO}.xlsx`, `Delivery_Schedule_${PO}.pdf`,
    ]);
    assert.ok(attachments.every((a) => Buffer.isBuffer(a.content) && a.content.length > 0));

    // The PDF really is one.
    const pdf = attachments.find((a) => a.filename.endsWith('.pdf'));
    assert.equal(pdf.content.subarray(0, 4).toString(), '%PDF');

    // Read the workbook back and check the two-tier header and the data land
    // where the reference document puts them.
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(attachments[0].content);
    const sheet = wb.getWorksheet('Delivery Schedule');

    const rows = [];
    sheet.eachRow((row) => rows.push(row.values.slice(1).map((v) => v ?? '')));

    const bandRow = rows.find((r) => r[0] === 'FULL ORDER');
    assert.ok(bandRow, 'the FULL ORDER band is present');
    assert.ok(bandRow.includes('DELIVERY SCHEDULE'));

    const headRow = rows.find((r) => r[0] === 'PO NO.');
    assert.deepEqual(headRow, [
      'PO NO.', 'Sr. No.', 'Maruti Code', 'Koken Code', 'Qty',
      'QTY DISPATCH', 'DISPATCH DATE', 'QTY PENDING', 'PENDING SCHEDULE',
    ]);

    const first = rows[rows.indexOf(headRow) + 1];
    assert.deepEqual(first, [PO, 1, 'MA0LW004000', '14145M.150-14', 30, 30, '03-08-2026', 0, '']);

    const second = rows[rows.indexOf(headRow) + 2];
    assert.deepEqual(second, [PO, 2, 'MA0M1000000', '13145M.200-12', 22, '', '', 22, 'CHECKING WITH OEM']);

    const totals = rows[rows.indexOf(headRow) + 3];
    assert.equal(totals[0], 'TOTAL');
    assert.equal(totals[4], 52);

    // The body of the email carries the same table, so the mail is readable
    // without opening anything.
    assert.match(tableHtml, /14145M\.150-14/);
    assert.match(tableHtml, /13145M\.200-12/);
    assert.match(tableHtml, /CHECKING WITH OEM/);
    assert.equal(doc.totals.qty, 52);
  });

  test('a non-MSIL workbook drops the column and narrows the band', async () => {
    const customer = await makeCustomer({ customerCategory: 'Non-MSIL', customerName: 'Sharma Traders' });
    await makeLine(customer._id, { lineSeq: 0 });

    const doc = await buildBookingScheduleDoc(ORDER_ID);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildScheduleXlsx(doc)).content);
    const sheet = wb.getWorksheet('Delivery Schedule');

    const rows = [];
    sheet.eachRow((row) => rows.push(row.values.slice(1).map((v) => v ?? '')));
    const headRow = rows.find((r) => r[0] === 'PO NO.');
    assert.equal(headRow.length, 8);
    assert.ok(!headRow.includes('Maruti Code'));

    /*
     * The FULL ORDER band must shrink with it — a merge left one cell too wide
     * is not cosmetic, it is a sheet that opens looking corrupt.
     *
     * The band's ROW NUMBER is found rather than hard-coded: the meta block
     * above it only prints the facts a booking actually has, so a booking with
     * no delivery date yet pushes the table up a row. Asserting a literal row
     * would make this test fail for a reason that has nothing to do with the
     * merge it is about.
     */
    let bandRowNumber = null;
    sheet.eachRow((row, n) => { if (row.values[1] === 'FULL ORDER') bandRowNumber = n; });
    assert.ok(bandRowNumber, 'the FULL ORDER band row exists');
    const merges = sheet.model.merges.join(',');
    assert.ok(merges.includes(`A${bandRowNumber}:D${bandRowNumber}`), merges);
    assert.ok(merges.includes(`E${bandRowNumber}:H${bandRowNumber}`), merges);
  });

  test('an empty booking yields no document rather than a table of nothing', async () => {
    const customer = await makeCustomer();
    await makeLine(customer._id, { lineSeq: 0, status: 'Cancelled' });

    assert.equal(await buildBookingScheduleDoc(ORDER_ID), null);
    const parts = await buildScheduleMailParts(ORDER_ID);
    assert.equal(parts.doc, null);
    assert.deepEqual(parts.attachments, []);
    assert.equal(parts.tableHtml, '');
  });

  test('both renderers survive a booking with no lines at all', async () => {
    // Not reachable through buildBookingScheduleDoc, which returns null first —
    // but the renderers are exported and must not throw on an empty list.
    const bare = {
      reference: 'PO-1', orderId: 'BO-1', lines: [], totals: { qty: 0, dispatched: 0, pending: 0 },
      customer: { name: 'X' }, showMsilCode: false, skuLabel: 'SKU Code',
    };
    assert.ok((await buildScheduleXlsx(bare)).content.length > 0);
    assert.ok((await buildSchedulePdf(bare)).content.length > 0);
    assert.match(scheduleTableHtml(bare), /No items on this schedule/);
  });

  test('attachments are skipped, not fatal, when a renderer fails', async () => {
    // The email body already carries the whole table, so a format that will not
    // build is no reason to withhold the mail.
    const broken = { reference: 'PO-1', lines: null, totals: null, get customer() { throw new Error('boom'); } };
    assert.deepEqual(await buildScheduleAttachments(broken), []);
    assert.deepEqual(await buildScheduleAttachments(null), []);
  });
});

/* ── Which lines may carry a date ─────────────────────────────────────────── */

describe('the schedulable statuses', () => {
  test('are shared by the writers and the reader', () => {
    assert.deepEqual(OPEN_BOOKING_STATUSES, ['Booked', 'PO Received', 'Ready for Dispatch']);
    // Dispatched, Delivered and Cancelled lines have no delivery ahead of them.
    for (const closed of ['Dispatched', 'Delivered', 'Cancelled']) {
      assert.ok(!OPEN_BOOKING_STATUSES.includes(closed));
    }
  });
});
