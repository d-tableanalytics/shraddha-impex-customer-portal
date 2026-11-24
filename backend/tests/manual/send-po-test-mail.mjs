/**
 * ONE-OFF: send a real Purchase Order mail to a test address.
 *
 * Run:
 *   node --test --experimental-test-module-mocks tests/manual/send-po-test-mail.mjs
 *
 * WHY IT IS A TEST FILE AND NOT A SCRIPT. The PO mail is assembled by
 * `raisePo`, which imports `io` from server.js - and importing server.js for
 * real connects to whatever MONGO_URI is in .env, which here is PRODUCTION
 * Atlas. `mock.module` is the only thing in this repo that stubs it, and it is
 * available under the test runner. So the controller runs for real against an
 * in-memory replica set, and nothing touches the live database.
 *
 * The MAILER, by contrast, is deliberately NOT stubbed: the whole point is that
 * a real message arrives. The wrapper below delegates to the real module (via a
 * query-suffixed specifier, which the mock does not intercept) and records what
 * went out so this file can assert on it.
 */

/* Suppress the company Cc BEFORE anything reads it - mailRecipients resolves
 * these at module load. This is a dummy PO for a fictional customer; copying it
 * to Contact@ and kinjal@ would put a fake purchase order in real inboxes. */
process.env.BOOKING_CC_EMAILS = '';
process.env.ALWAYS_CC_EMAILS = '';

import test, { before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

import { startTestMongo, stopTestMongo, clearCollections } from '../helpers/mongo.js';
import { defaultDispatchDate } from '../../utils/dispatchDate.js';

const TO = process.env.PO_MAIL_TO || 'angelsharmajiya@gmail.com';
const OUT = process.env.PO_MAIL_HTML_OUT || null;

const sent = [];

mock.module(new URL('../../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});

const realMailerUrl = new URL('../../utils/mailer.js?real=1', import.meta.url).href;
mock.module(new URL('../../utils/mailer.js', import.meta.url).href, {
  namedExports: {
    sendEmail: async (to, subject, html, options = {}) => {
      const real = await import(realMailerUrl);
      const ok = await real.sendEmail(to, subject, html, options);
      sent.push({ to, subject, html, cc: options.cc ?? [], attachments: options.attachments ?? [], ok });
      return ok;
    },
  },
});

const { default: Order } = await import('../../models/Order.js');
const { default: User } = await import('../../models/User.js');
const { raisePo } = await import('../../modules/sales/sales.controller.js');

const ORDER_ID = 'BO-2026-009001';
const ADMIN = { _id: null, role: 'Super Admin', permissions: ['*'], user: 'Sales Desk', email: 'desk@shraddhaimpex.net' };

const makeRes = () => {
  const res = { statusCode: null, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.payload = b; return res; };
  return res;
};

const run = async (handler, req) => {
  const res = makeRes();
  let thrown = null;
  await handler(req, res, (e) => { thrown = e; });
  if (thrown) throw thrown;
  return res;
};

/** The mail is fire-and-forget inside the controller, so wait for it. */
const waitForMail = async (n = 1, ms = 30_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (sent.length >= n) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

before(async () => { await startTestMongo(); await clearCollections(); });
after(async () => { await stopTestMongo(); });

test('a real Purchase Order mail goes to the test address', async () => {
  const customer = await User.create({
    email: TO,
    password: 'x',
    user: 'Angel Sharma',
    company: 'Test Buyer Pvt Ltd',
    customerName: 'Test Buyer Pvt Ltd',
    customerCategory: 'MSIL',
    role: 'Customer',
    bookingCcEmails: [],
  });
  ADMIN._id = customer._id;

  const line = (over) => Order.create({
    orderId: ORDER_ID,
    brand: 'Koken',
    user: customer._id,
    status: 'PO Received',
    poNumber: '-',
    ...over,
  });

  // Three lines, deliberately mixed:
  //  - two confirmed in full
  //  - one CUT BACK by the desk, so Qty Dispatch must show 18, not the 40 asked
  await line({ lineSeq: 0, skuCode: '14145M.150-14', msilCode: 'MA0LW004000', requestedQty: 30, bookedQty: 30, confirmedQty: 30 });
  await line({ lineSeq: 1, skuCode: '13145M.200-12', msilCode: 'MA0M1000000', requestedQty: 22, bookedQty: 22, confirmedQty: 22 });
  await line({ lineSeq: 2, skuCode: '16110M.075-08', msilCode: 'MA0P2250000', requestedQty: 40, bookedQty: 40, confirmedQty: 18 });

  // NO deliveryScheduleDate: this is the path that must now derive PO day + 3.
  const res = await run(raisePo, {
    params: { orderId: ORDER_ID },
    body: { poNumber: 'PO-TEST-2026-0001' },
    user: ADMIN,
  });
  assert.equal(res.payload?.success, true);

  assert.ok(await waitForMail(1), 'the mail was handed to SMTP');
  const mail = sent[0];

  const rows = await Order.find({ orderId: ORDER_ID }).sort({ lineSeq: 1 }).lean();
  const expected = defaultDispatchDate(rows[0].poGeneratedAt);

  /* ── The two things the client asked to see verified ─────────────────── */
  for (const r of rows) {
    assert.equal(r.scheduledDate.toISOString(), expected.toISOString());
  }
  assert.equal(rows[0].scheduledBy, null, 'a derived date is attributed to the system');

  // Qty Dispatch = CONFIRMED qty, including the line that was cut back.
  const { buildBookingScheduleDoc } = await import('../../utils/deliverySchedule.js');
  const doc = await buildBookingScheduleDoc(ORDER_ID, { customer, rows });
  assert.deepEqual(doc.lines.map((l) => l.qtyDispatched), [30, 22, 18]);
  assert.deepEqual(doc.lines.map((l) => l.qty), [30, 22, 18]);
  assert.equal(doc.totals.dispatched, 70);

  assert.equal(mail.to, TO);
  assert.equal(mail.ok, true, 'SMTP accepted the message');
  assert.equal(mail.cc.length, 0, 'no real company mailbox was copied');
  assert.equal(mail.attachments.length, 2, 'xlsx + pdf attached');
  assert.match(mail.html, /Dispatch Date:/);

  if (OUT) writeFileSync(OUT, mail.html, 'utf8');

  const ist = (d) => new Date(d).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
  console.log('\n──────────── PO TEST MAIL ────────────');
  console.log('To              :', mail.to);
  console.log('Cc              :', mail.cc.length ? mail.cc.join(', ') : '(none)');
  console.log('Subject         :', mail.subject);
  console.log('PO raised (IST) :', ist(rows[0].poGeneratedAt));
  console.log('Dispatch date   :', ist(expected), `(+${3} days)`);
  console.log('Qty Dispatch    :', doc.lines.map((l) => `${l.skuCode}=${l.qtyDispatched}`).join('  '));
  console.log('Attachments     :', mail.attachments.map((a) => a.filename).join(', '));
  console.log('──────────────────────────────────────\n');
});
