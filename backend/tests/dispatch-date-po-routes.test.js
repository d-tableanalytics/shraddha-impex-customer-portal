/**
 * THE DISPATCH DATE IS NEVER BLANK ON A LIVE LINE — whichever route raised the
 * purchase order.
 *
 * `raisePo` (the sales desk's PO dialog) has dated bookings since 2026-11-17 and
 * is covered by po-delivery-schedule-flow.test.js. `updateOrderPO` is the OTHER
 * PO route — `PUT /orders/:orderId/po`, which takes a PO number and nothing else
 * — and until 2026-11-24 it stamped no dispatch date at all. A booking that got
 * its PO that way kept whatever confirmation left behind, or null on a booking
 * taken before dispatch dates existed, and a null prints as an EMPTY cell in the
 * "DISPATCH DATE" column of the document the customer files their PO against.
 *
 * The last test is the one that matters to the customer: it reads the rendered
 * document and asserts that no live line has an empty dispatch cell and none has
 * an empty quantity-dispatched cell.
 *
 * The harness is the one po-delivery-schedule-flow.test.js explains: server.js
 * is stubbed because importing a controller would otherwise boot the production
 * server, and everything else — models, controller, document builders — is real.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

import { startTestMongo, stopTestMongo, clearCollections } from './helpers/mongo.js';
import { defaultDispatchDate } from '../utils/dispatchDate.js';

mock.module(new URL('../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});

mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: { sendEmail: async () => true },
});

const { default: Order } = await import('../models/Order.js');
const { default: User } = await import('../models/User.js');
const { updateOrderPO } = await import('../modules/orders/order.controller.js');
const { buildBookingScheduleDoc } = await import('../utils/deliverySchedule.js');
const { scheduleTableHtml } = await import('../modules/orders/deliverySchedule.render.js');

const ORDER_ID = 'BO-2026-000230';

const ADMIN = { _id: null, role: 'Super Admin', permissions: ['*'], user: 'Desk User', email: 'desk@shraddhaimpex.net' };

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

const makeCustomer = () => User.create({
  email: 'buyer@maruti.example.com',
  password: 'x',
  user: 'A Buyer',
  customerName: 'MARUTI SUZUKI INDIA LIMITED',
  customerCategory: 'MSIL',
  role: 'Customer',
});

/**
 * When this booking was confirmed: a fortnight ago.
 *
 * Deliberately not today. The dispatch date is the booking day + 3, and a
 * booking confirmed today would give the same answer as a rule counting from the
 * PO day — so a fixture dated today could not tell a correct implementation from
 * the one this replaced.
 */
const CONFIRMED_AT = new Date(Date.now() - 14 * 86_400_000);

/** A line as a pre-dispatch-date booking left it: confirmed, but never dated. */
const makeUndatedLine = (user, over = {}) => Order.create({
  orderId: ORDER_ID,
  brand: 'Koken',
  user,
  skuCode: '13146M.150-12',
  msilCode: 'MA0M4002000',
  requestedQty: 20,
  bookedQty: 20,
  confirmedQty: 20,
  status: 'PO Received',
  poNumber: '-',
  orderTimestamp: CONFIRMED_AT,
  scheduledDate: null,
  scheduledBy: null,
  ...over,
});

const ymd = (d) => new Date(d).toISOString().slice(0, 10);

before(async () => { await startTestMongo(); });
after(async () => { await stopTestMongo(); });
beforeEach(async () => { await clearCollections(); });

describe('raising a PO through PUT /orders/:orderId/po', () => {
  test('dates every open line three days after the booking, though the route sends no date', async () => {
    const customer = await makeCustomer();
    ADMIN._id = customer._id;
    await makeUndatedLine(customer._id, { lineSeq: 0 });
    await makeUndatedLine(customer._id, { lineSeq: 1, skuCode: '14300M-17', msilCode: 'MA0LU01M000', confirmedQty: 10 });

    const res = await run(updateOrderPO, {
      params: { orderId: ORDER_ID },
      body: { poNumber: '7000066744' },
      user: ADMIN,
    });
    assert.equal(res.payload.success, true);

    const rows = await Order.find({ orderId: ORDER_ID }).sort({ lineSeq: 1 }).lean();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.ok(row.scheduledDate, `${row.skuCode} carries a dispatch date`);
      // Booking confirmation + 3, which is what raisePo derives too — the two
      // routes must not date the same booking differently.
      assert.equal(ymd(row.scheduledDate), ymd(defaultDispatchDate(CONFIRMED_AT)));
      // Not the day the PO was raised, which is today.
      assert.notEqual(ymd(row.scheduledDate), ymd(defaultDispatchDate(new Date())));
      // null = derived by the system, so a later PO may re-derive it.
      assert.equal(row.scheduledBy, null);
    }
  });

  test('re-raising a PO recomputes the same date rather than pushing it out', async () => {
    const customer = await makeCustomer();
    ADMIN._id = customer._id;
    await makeUndatedLine(customer._id, { lineSeq: 0 });

    const raise = () => run(updateOrderPO, {
      params: { orderId: ORDER_ID },
      body: { poNumber: '7000066744' },
      user: { ...ADMIN, role: 'Super Admin' },
    });

    await raise();
    const first = (await Order.findOne({ orderId: ORDER_ID }).lean()).scheduledDate;
    await raise();
    const second = (await Order.findOne({ orderId: ORDER_ID }).lean()).scheduledDate;

    // A date counted from the booking day is a FUNCTION OF THE BOOKING, so it
    // cannot drift each time the booking is touched. One of the reasons the
    // booking day is a defensible basis at all.
    assert.equal(ymd(second), ymd(first));
  });

  test('every line of one booking gets the same date', async () => {
    const customer = await makeCustomer();
    ADMIN._id = customer._id;
    for (let i = 0; i < 4; i += 1) {
      await makeUndatedLine(customer._id, { lineSeq: i, skuCode: `SKU-${i}` });
    }

    await run(updateOrderPO, {
      params: { orderId: ORDER_ID },
      body: { poNumber: '7000066744' },
      user: ADMIN,
    });

    const dates = new Set(
      (await Order.find({ orderId: ORDER_ID }).lean()).map((r) => ymd(r.scheduledDate)),
    );
    assert.equal(dates.size, 1, `one date across the booking, got ${[...dates].join(', ')}`);
  });

  test('a date the desk picked by hand is left alone', async () => {
    const customer = await makeCustomer();
    ADMIN._id = customer._id;
    const picked = new Date(Date.UTC(2026, 11, 15));
    await makeUndatedLine(customer._id, {
      lineSeq: 0, scheduledDate: picked, scheduledBy: customer._id,
    });
    await makeUndatedLine(customer._id, { lineSeq: 1, skuCode: '14300M-19' });

    await run(updateOrderPO, {
      params: { orderId: ORDER_ID },
      body: { poNumber: '7000066744' },
      user: ADMIN,
    });

    const [deskPicked, derived] = await Order.find({ orderId: ORDER_ID }).sort({ lineSeq: 1 }).lean();
    assert.equal(ymd(deskPicked.scheduledDate), '2026-12-15', 'the human choice survived');
    assert.ok(derived.scheduledDate, 'and the undated line was still dated');
    assert.notEqual(ymd(derived.scheduledDate), '2026-12-15');
  });

  test('a cancelled line is not given a dispatch date', async () => {
    const customer = await makeCustomer();
    ADMIN._id = customer._id;
    await makeUndatedLine(customer._id, { lineSeq: 0 });
    await makeUndatedLine(customer._id, { lineSeq: 1, skuCode: 'DEAD-1', status: 'Cancelled' });

    await run(updateOrderPO, {
      params: { orderId: ORDER_ID },
      body: { poNumber: '7000066744' },
      user: ADMIN,
    });

    const cancelled = await Order.findOne({ orderId: ORDER_ID, status: 'Cancelled' }).lean();
    assert.equal(cancelled.scheduledDate, null, 'nothing is being dispatched, so there is no date');
  });
});

describe('the document the customer receives', () => {
  test('has no empty Qty Dispatch or Dispatch Date cell on any live line', async () => {
    const customer = await makeCustomer();
    ADMIN._id = customer._id;
    // The booking from the reported screenshot: nine confirmed lines, none of
    // them dated, three of them without a Maruti code.
    const quantities = [20, 10, 10, 10, 20, 13, 10, 20, 30];
    for (const [i, qty] of quantities.entries()) {
      await makeUndatedLine(customer._id, {
        lineSeq: i,
        skuCode: `SKU-${i}`,
        msilCode: i % 3 === 2 ? null : `MA0-${i}`,
        requestedQty: qty,
        bookedQty: qty,
        confirmedQty: qty,
      });
    }

    await run(updateOrderPO, {
      params: { orderId: ORDER_ID },
      body: { poNumber: '7000066744' },
      user: ADMIN,
    });

    const doc = await buildBookingScheduleDoc(ORDER_ID);
    assert.equal(doc.lines.length, 9);

    for (const line of doc.lines) {
      assert.ok(line.dispatchDate, `${line.skuCode} has a dispatch date`);
      assert.equal(line.qtyDispatched, line.qty, `${line.skuCode} commits its confirmed quantity`);
    }

    // Both totals, and they agree: 143, the figure on the screenshot.
    assert.equal(doc.totals.qty, 143);
    assert.equal(doc.totals.dispatched, 143);

    /*
     * The rendered table, read as the customer reads it. Each row's last two
     * cells are QTY DISPATCH and DISPATCH DATE, and the point of this test is
     * that neither is `<td ...></td>`.
     */
    const html = scheduleTableHtml(doc);
    const bodyRows = html
      .split('<tr>')
      .slice(1)
      .filter((row) => !row.includes('TOTAL') && row.includes('<td'));
    assert.equal(bodyRows.length, 9);
    for (const row of bodyRows) {
      const cells = [...row.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1].trim());
      const [qtyDispatch, dispatchDate] = cells.slice(-2);
      assert.notEqual(qtyDispatch, '', `Qty Dispatch filled in: ${row}`);
      assert.match(dispatchDate, /^\d{2}-\d{2}-\d{4}$/, `Dispatch Date filled in: ${row}`);
    }
  });

  test('the dispatch date in the system and the one on the document are the same date', async () => {
    const customer = await makeCustomer();
    ADMIN._id = customer._id;
    await makeUndatedLine(customer._id, { lineSeq: 0 });

    await run(updateOrderPO, {
      params: { orderId: ORDER_ID },
      body: { poNumber: '7000066744' },
      user: ADMIN,
    });

    const row = await Order.findOne({ orderId: ORDER_ID }).lean();
    const doc = await buildBookingScheduleDoc(ORDER_ID);
    assert.equal(ymd(doc.lines[0].dispatchDate), ymd(row.scheduledDate));
    assert.equal(ymd(doc.deliveryScheduleDate), ymd(row.scheduledDate));
  });
});
