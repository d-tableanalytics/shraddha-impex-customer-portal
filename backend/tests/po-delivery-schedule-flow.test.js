/**
 * THE COMPLETE FLOW: raise a PO with a delivery date → the customer is emailed
 * the schedule with both attachments → the date is changed → they are emailed
 * again.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HANDLERS ARE CALLED DIRECTLY RATHER THAN OVER HTTP
 * ---------------------------------------------------------------------------
 *
 * `server.js` calls `startServer()` at module scope — it connects to the
 * configured database, schedules three cron jobs and binds a port the moment it
 * is imported. Both controllers import `io` from it, so importing either one in
 * a test boots the production server. It is stubbed here (see `mock.module`
 * below) and everything else is the genuine article: the real Mongoose models
 * against a real in-memory MongoDB, the real controller, the real document
 * builders and the real mailer contract.
 *
 * The mailer itself is captured rather than stubbed out, because WHAT IS SENT is
 * most of what this feature is: the address it goes to, the two attachments, and
 * the table in the body.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { startTestMongo, stopTestMongo, clearCollections } from './helpers/mongo.js';

const require = createRequire(import.meta.url);

/** Every mail the code under test tried to send, in order. */
const sent = [];

/*
 * Stubbed BEFORE the controllers are imported — a module already in the graph
 * cannot be replaced afterwards. `io.emit` is the only thing either controller
 * uses from server.js.
 */
mock.module(new URL('../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});

mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: {
    sendEmail: async (to, subject, html, options = {}) => {
      sent.push({ to, subject, html, cc: options.cc ?? [], attachments: options.attachments ?? [] });
      return true;
    },
  },
});

const { default: Order } = await import('../models/Order.js');
const { default: User } = await import('../models/User.js');
const { raisePo } = await import('../modules/sales/sales.controller.js');
const { scheduleBooking } = await import('../modules/orders/order.controller.js');

const ORDER_ID = 'BO-2026-000777';

/** A Super Admin — passes every permission gate the two handlers apply. */
const ADMIN = { _id: null, role: 'Super Admin', permissions: ['*'], user: 'Desk User', email: 'desk@shraddhaimpex.net' };

/** Minimal Express doubles. `res` records rather than writes. */
const makeRes = () => {
  const res = { statusCode: null, payload: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.payload = body; return res; };
  return res;
};

const run = async (handler, req) => {
  const res = makeRes();
  let thrown = null;
  await handler(req, res, (err) => { thrown = err; });
  if (thrown) throw thrown;
  return res;
};

const makeCustomer = (over = {}) => User.create({
  email: 'buyer@maruti.example.com',
  password: 'x',
  user: 'A Buyer',
  company: 'Fallback Co',
  customerName: 'Maruti Suzuki India Ltd',
  customerCategory: 'MSIL',
  role: 'Customer',
  bookingCcEmails: ['purchase@maruti.example.com'],
  ...over,
});

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
  poNumber: '-',
  ...over,
});

/** Tomorrow, as the "YYYY-MM-DD" the browser sends. */
const futureYmd = (days = 30) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/**
 * The mails are sent fire-and-forget so a slow render cannot fail a committed
 * purchase order. That means waiting for them rather than asserting immediately.
 */
const waitForMail = async (count = 1, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (sent.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return sent.length >= count;
};

before(async () => { await startTestMongo(); });
after(async () => { await stopTestMongo(); });
beforeEach(async () => { await clearCollections(); sent.length = 0; });

describe('raising a PO with a delivery schedule date', () => {
  test('stamps the date on every open line and emails the customer both documents', async () => {
    const customer = await makeCustomer();
    ADMIN._id = customer._id; // any ObjectId will do for poGeneratedBy
    await makeLine(customer._id, { lineSeq: 0 });
    await makeLine(customer._id, { lineSeq: 1, skuCode: '13145M.200-12', msilCode: 'MA0M1000000', confirmedQty: 22 });

    const scheduleDate = futureYmd(30);
    const res = await run(raisePo, {
      params: { orderId: ORDER_ID },
      body: { poNumber: '7000050930', poDate: '2026-07-01', deliveryScheduleDate: scheduleDate },
      user: ADMIN,
    });

    assert.equal(res.payload.success, true);

    // ── The write ────────────────────────────────────────────────────────
    const rows = await Order.find({ orderId: ORDER_ID }).sort({ lineSeq: 1 }).lean();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.poNumber, '7000050930');
      assert.ok(row.scheduledDate, `${row.skuCode} carries a delivery date`);
      assert.equal(row.scheduledDate.toISOString().slice(0, 10), scheduleDate);
      assert.ok(row.scheduledAt, 'and when it was set');
    }

    // ── The mail ─────────────────────────────────────────────────────────
    assert.ok(await waitForMail(1), 'the customer was emailed');
    const [mail] = sent;
    assert.equal(mail.to, 'buyer@maruti.example.com');
    assert.match(mail.subject, /7000050930/);
    // The customer's own configured extra contacts are copied.
    assert.ok(mail.cc.includes('purchase@maruti.example.com'), mail.cc.join(','));

    // Both formats, named for the PO.
    assert.equal(mail.attachments.length, 2);
    assert.deepEqual(mail.attachments.map((a) => a.filename), [
      'Delivery_Schedule_7000050930.xlsx', 'Delivery_Schedule_7000050930.pdf',
    ]);

    // The body carries the PO number, both SKUs, the ordered quantities and
    // the Maruti codes — so it is readable without opening an attachment.
    assert.match(mail.html, /7000050930/);
    assert.match(mail.html, /14145M\.150-14/);
    assert.match(mail.html, /13145M\.200-12/);
    assert.match(mail.html, /Maruti Code/);
    assert.match(mail.html, /MA0LW004000/);
    assert.match(mail.html, /Delivery Schedule/);
    assert.match(mail.html, /FULL ORDER/);
    // The ordered quantities and the schedule total.
    assert.match(mail.html, /\b30\b/);
    assert.match(mail.html, /\b52\b/);

    // The spreadsheet really is one, and holds the same two lines.
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(mail.attachments[0].content);
    const sheet = wb.getWorksheet('Delivery Schedule');
    const flat = [];
    sheet.eachRow((row) => flat.push(row.values.slice(1)));
    assert.ok(flat.some((r) => r[3] === '14145M.150-14' && r[4] === 30));
    assert.ok(flat.some((r) => r[3] === '13145M.200-12' && r[4] === 22));
    assert.equal(mail.attachments[1].content.subarray(0, 4).toString(), '%PDF');
  });

  test('a PO raised without a date still goes out, with the lines marked pending', async () => {
    const customer = await makeCustomer();
    ADMIN._id = customer._id;
    await makeLine(customer._id, { lineSeq: 0 });

    await run(raisePo, {
      params: { orderId: ORDER_ID },
      body: { poNumber: 'PO-NO-DATE' },
      user: ADMIN,
    });

    const [row] = await Order.find({ orderId: ORDER_ID }).lean();
    assert.equal(row.scheduledDate, null);

    assert.ok(await waitForMail(1));
    assert.equal(sent[0].attachments.length, 2);
    assert.match(sent[0].html, /CHECKING WITH OEM/);
  });

  test('a date in the past is refused before anything is written', async () => {
    const customer = await makeCustomer();
    ADMIN._id = customer._id;
    await makeLine(customer._id, { lineSeq: 0 });

    const res = await run(raisePo, {
      params: { orderId: ORDER_ID },
      body: { poNumber: 'PO-PAST', deliveryScheduleDate: '2020-01-01' },
      user: ADMIN,
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.payload.message, /cannot be in the past/);

    // Nothing was committed — the PO must not be half-raised by a bad date.
    const [row] = await Order.find({ orderId: ORDER_ID }).lean();
    assert.equal(row.poNumber, '-');
    assert.equal(row.scheduledDate, null);
    assert.equal(sent.length, 0);
  });

  test('an unreadable date is refused too', async () => {
    const customer = await makeCustomer();
    ADMIN._id = customer._id;
    await makeLine(customer._id, { lineSeq: 0 });

    const res = await run(raisePo, {
      params: { orderId: ORDER_ID },
      body: { poNumber: 'PO-BAD', deliveryScheduleDate: 'not a date' },
      user: ADMIN,
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.message, /could not be read/);
  });

  test('a closed line is not given a delivery date it cannot honour', async () => {
    const customer = await makeCustomer();
    ADMIN._id = customer._id;
    await makeLine(customer._id, { lineSeq: 0 });
    await makeLine(customer._id, {
      lineSeq: 1, skuCode: 'DELIVERED-SKU', status: 'Delivered', stockState: 'consumed',
    });

    await run(raisePo, {
      params: { orderId: ORDER_ID },
      body: { poNumber: 'PO-MIXED', deliveryScheduleDate: futureYmd(20) },
      user: ADMIN,
    });

    // Waited for, not ignored: this mail is sent fire-and-forget, and a mail
    // still in flight when the next test clears the log would land in ITS
    // results and be read as a mail that test caused.
    assert.ok(await waitForMail(1));

    const rows = await Order.find({ orderId: ORDER_ID }).lean();
    const open = rows.find((r) => r.skuCode === '14145M.150-14');
    const done = rows.find((r) => r.skuCode === 'DELIVERED-SKU');
    assert.ok(open.scheduledDate, 'the open line is scheduled');
    assert.equal(done.scheduledDate, null, 'the delivered line is not');
    // The PO number itself still lands on BOTH — that is the record of what was
    // ordered, and a delivered line is part of it.
    assert.equal(done.poNumber, 'PO-MIXED');
  });
});

describe('changing the delivery schedule afterwards', () => {
  test('re-emails the customer the updated schedule with fresh attachments', async () => {
    const customer = await makeCustomer();
    ADMIN._id = customer._id;
    await makeLine(customer._id, { lineSeq: 0 });
    await makeLine(customer._id, { lineSeq: 1, skuCode: '13145M.200-12', confirmedQty: 22 });

    await run(raisePo, {
      params: { orderId: ORDER_ID },
      body: { poNumber: '7000050930', deliveryScheduleDate: futureYmd(30) },
      user: ADMIN,
    });
    assert.ok(await waitForMail(1), 'the PO mail went');

    // The desk now pushes ONE line out to a later date.
    const rows = await Order.find({ orderId: ORDER_ID }).sort({ lineSeq: 1 }).lean();
    const moved = futureYmd(60);
    const res = await run(scheduleBooking, {
      params: { orderId: ORDER_ID },
      body: { items: [{ id: String(rows[1]._id), scheduledDate: moved, note: 'Awaiting vessel' }] },
      user: ADMIN,
    });

    assert.equal(res.payload.success, true);
    assert.equal(res.payload.data.emailed, true);

    const after = await Order.findById(rows[1]._id).lean();
    assert.equal(after.scheduledDate.toISOString().slice(0, 10), moved);
    assert.equal(after.scheduleNote, 'Awaiting vessel');
    // The other line is untouched — a per-line edit must not disturb its
    // neighbour.
    const untouched = await Order.findById(rows[0]._id).lean();
    assert.equal(untouched.scheduledDate.toISOString().slice(0, 10), futureYmd(30));

    // ── The second mail ──────────────────────────────────────────────────
    assert.ok(await waitForMail(2), 'a schedule-update mail followed');
    // Found by subject rather than by index. Both mails are sent without being
    // awaited by the handler, so their ARRIVAL order is not guaranteed to match
    // the order the actions were taken in.
    const update = sent.find((m) => /Delivery Schedule Update/.test(m.subject));
    assert.ok(update, sent.map((m) => m.subject).join(' | '));
    assert.equal(update.to, 'buyer@maruti.example.com');
    assert.match(update.subject, /Delivery Schedule Update/);
    assert.equal(update.attachments.length, 2);
    assert.deepEqual(update.attachments.map((a) => a.filename), [
      'Delivery_Schedule_7000050930.xlsx', 'Delivery_Schedule_7000050930.pdf',
    ]);

    // It carries the COMPLETE SKU table, not just the line that moved.
    assert.match(update.html, /14145M\.150-14/);
    assert.match(update.html, /13145M\.200-12/);
    assert.match(update.html, /FULL ORDER/);
    assert.match(update.html, /Awaiting vessel/);
  });

  test('clearing the last date sends nothing rather than an empty table', async () => {
    const customer = await makeCustomer();
    ADMIN._id = customer._id;
    await makeLine(customer._id, { lineSeq: 0 });

    await run(raisePo, {
      params: { orderId: ORDER_ID },
      body: { poNumber: 'PO-CLEAR', deliveryScheduleDate: futureYmd(30) },
      user: ADMIN,
    });
    assert.ok(await waitForMail(1));
    const afterPo = sent.length;

    const [row] = await Order.find({ orderId: ORDER_ID }).lean();
    const res = await run(scheduleBooking, {
      params: { orderId: ORDER_ID },
      body: { items: [{ id: String(row._id), scheduledDate: null }] },
      user: ADMIN,
    });

    assert.equal(res.payload.data.emailed, false);
    assert.equal((await Order.findById(row._id).lean()).scheduledDate, null);
    // Give any stray async mail a chance to arrive before asserting none did.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sent.length, afterPo, 'no further mail was sent');
  });

  test('a non-MSIL customer gets the same schedule without the Maruti column', async () => {
    const customer = await makeCustomer({
      email: 'buyer@sharma.example.com',
      customerName: 'Sharma Traders',
      customerCategory: 'Regular Customer',
      bookingCcEmails: [],
    });
    ADMIN._id = customer._id;
    await makeLine(customer._id, { lineSeq: 0 });

    await run(raisePo, {
      params: { orderId: ORDER_ID },
      body: { poNumber: 'PO-NONMSIL', deliveryScheduleDate: futureYmd(15) },
      user: ADMIN,
    });

    assert.ok(await waitForMail(1));
    const [mail] = sent;
    assert.equal(mail.to, 'buyer@sharma.example.com');
    assert.equal(mail.attachments.length, 2);
    // No Maruti column anywhere — and the rest of the table is unchanged.
    assert.ok(!mail.html.includes('Maruti Code'));
    assert.match(mail.html, /PENDING SCHEDULE/);
    assert.match(mail.html, /QTY DISPATCH/);
    assert.match(mail.html, /Koken Code/);
  });

  test('a customer with no email on file is skipped without failing the save', async () => {
    // The account has an address, so it is created; it is removed underneath to
    // reach the branch a legacy record would hit.
    const customer = await makeCustomer({ email: 'temp@example.com' });
    ADMIN._id = customer._id;
    await makeLine(customer._id, { lineSeq: 0 });
    await User.updateOne({ _id: customer._id }, { $unset: { email: 1 } });

    const [row] = await Order.find({ orderId: ORDER_ID }).lean();
    const res = await run(scheduleBooking, {
      params: { orderId: ORDER_ID },
      body: { items: [{ id: String(row._id), scheduledDate: futureYmd(10) }] },
      user: ADMIN,
    });

    // The date is still saved — the write must never depend on the mail.
    assert.equal(res.payload.success, true);
    assert.ok((await Order.findById(row._id).lean()).scheduledDate);
    assert.equal(res.payload.data.emailed, false);
  });
});
