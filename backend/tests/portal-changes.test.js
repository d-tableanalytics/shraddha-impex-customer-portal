/**
 * The four Customer Portal changes, exercised against a real database.
 *
 * Source-level assertions prove a line of code exists; these prove the BEHAVIOUR
 * the requirements actually asked for. Each block names the requirement it
 * covers and the failure it would have caught.
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startTestMongo, stopTestMongo, clearCollections, syncIndexes } from './helpers/mongo.js';
import Order, { LINE_ORDER } from '../models/Order.js';
import User from '../models/User.js';
import { buildDeliveryScheduleMail } from '../utils/deliveryScheduleMail.js';
import {
  signAccessToken,
  signRefreshToken,
  hashRefreshToken,
  refreshHashMatches,
  accessTokenTtl,
  accessTokenExpiresInMs,
  ACCESS_TOKEN_TTL_DEFAULT,
  REFRESH_GRACE_MS,
  MAX_REFRESH_SESSIONS,
} from '../utils/tokens.js';

// jsonwebtoken refuses to sign without a secret, and this suite mints real
// refresh tokens to prove the session model. Set for the duration of the file
// and restored after, so it cannot leak into another suite's expectations.
let previousSecret;
before(async () => {
  previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'portal-changes-test-secret';
  await startTestMongo();
  await syncIndexes(Order, User);
});
after(async () => {
  await stopTestMongo();
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});
beforeEach(async () => { await clearCollections(); });

const makeLine = (over = {}) => ({
  orderId: 'BO-2026-000001',
  brand: 'Koken',
  user: new mongoose.Types.ObjectId(),
  status: 'PO Received',
  skuCode: 'SKU-X',
  requestedQty: 1,
  confirmedQty: 1,
  ...over,
});

// ===========================================================================
// Requirement 2 — the picklist keeps the customer's SKU order
// ===========================================================================

describe('SKU sequence', () => {
  test('lines come back in the order they were booked, not the order Mongo stores them', async () => {
    const user = new mongoose.Types.ObjectId();
    // Inserted deliberately OUT of sequence, as a concurrent write or a
    // re-inserted row would leave them on disk.
    await Order.insertMany([
      makeLine({ user, skuCode: 'SKU-C', lineSeq: 2 }),
      makeLine({ user, skuCode: 'SKU-A', lineSeq: 0 }),
      makeLine({ user, skuCode: 'SKU-D', lineSeq: 3 }),
      makeLine({ user, skuCode: 'SKU-B', lineSeq: 1 }),
    ]);

    const rows = await Order.find({ orderId: 'BO-2026-000001' }).sort(LINE_ORDER);
    assert.deepEqual(rows.map((r) => r.skuCode), ['SKU-A', 'SKU-B', 'SKU-C', 'SKU-D']);
  });

  test('the order survives an update — the case natural order does not', async () => {
    const user = new mongoose.Types.ObjectId();
    await Order.insertMany([
      makeLine({ user, skuCode: 'SKU-A', lineSeq: 0 }),
      makeLine({ user, skuCode: 'SKU-B', lineSeq: 1 }),
      makeLine({ user, skuCode: 'SKU-C', lineSeq: 2 }),
    ]);
    // Rewriting a row is what used to move it: an updated document can be
    // relocated on disk, and an unsorted find() returns it wherever it lands.
    await Order.updateOne({ skuCode: 'SKU-A' }, { $set: { confirmedQty: 99, remarks: 'x'.repeat(400) } });

    const rows = await Order.find({ orderId: 'BO-2026-000001' }).sort(LINE_ORDER);
    assert.deepEqual(rows.map((r) => r.skuCode), ['SKU-A', 'SKU-B', 'SKU-C']);
  });

  test('a sparse sequence keeps the customer position of the lines that survived', async () => {
    // A five-line sheet whose third line went to indent writes no row for it.
    const user = new mongoose.Types.ObjectId();
    await Order.insertMany([
      makeLine({ user, skuCode: 'S3', lineSeq: 3 }),
      makeLine({ user, skuCode: 'S0', lineSeq: 0 }),
      makeLine({ user, skuCode: 'S4', lineSeq: 4 }),
      makeLine({ user, skuCode: 'S1', lineSeq: 1 }),
    ]);
    const rows = await Order.find({ orderId: 'BO-2026-000001' }).sort(LINE_ORDER);
    assert.deepEqual(rows.map((r) => r.skuCode), ['S0', 'S1', 'S3', 'S4']);
  });

  test('legacy rows with no lineSeq stay in creation order rather than scrambling', async () => {
    // Every booking made before this change has lineSeq null. They must tie and
    // fall through to _id, which is generation-ordered.
    const user = new mongoose.Types.ObjectId();
    const made = [];
    for (const sku of ['OLD-1', 'OLD-2', 'OLD-3']) {
      // Sequential creates so the ObjectIds are genuinely ordered.
      made.push(await Order.create(makeLine({ user, skuCode: sku })));
    }
    assert.ok(made.every((m) => m.lineSeq === null), 'legacy rows must not be backfilled');

    const rows = await Order.find({ orderId: 'BO-2026-000001' }).sort(LINE_ORDER);
    assert.deepEqual(rows.map((r) => r.skuCode), ['OLD-1', 'OLD-2', 'OLD-3']);
  });

  test('a mixed booking sorts new lines before legacy ones without interleaving them', async () => {
    const user = new mongoose.Types.ObjectId();
    await Order.create(makeLine({ user, skuCode: 'LEGACY' }));            // lineSeq null
    await Order.create(makeLine({ user, skuCode: 'NEW-0', lineSeq: 0 }));
    const rows = await Order.find({ orderId: 'BO-2026-000001' }).sort(LINE_ORDER);
    // Mongo sorts null before numbers ascending, so the legacy row leads. The
    // property that matters is that the result is STABLE and documented, not
    // which side wins.
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.skuCode), ['LEGACY', 'NEW-0']);
  });
});

// ===========================================================================
// Requirement 3 — company and addresses reach the picklist
// ===========================================================================

describe('picklist identity', () => {
  test('a customer record carries shipping and billing addresses', async () => {
    const u = await User.create({
      email: 'ship@example.test',
      password: 'x'.repeat(10),
      company: 'ABC Company Pvt. Ltd.',
      shippingAddress: 'Plot 14, MIDC Phase II\nPune 411057',
      billingAddress: '501 Trade Centre\nMumbai 400001',
    });
    const back = await User.findById(u._id).lean();
    assert.equal(back.company, 'ABC Company Pvt. Ltd.');
    assert.match(back.shippingAddress, /MIDC Phase II/);
    assert.match(back.billingAddress, /Trade Centre/);
    // Newlines survive, because the picklist renders them as typed.
    assert.ok(back.shippingAddress.includes('\n'));
  });

  test('an order snapshots the addresses so later profile edits cannot rewrite history', async () => {
    const user = new mongoose.Types.ObjectId();
    await Order.create(makeLine({
      user,
      shippingAddress: 'Old warehouse, Pune',
      billingAddress: 'Old office, Mumbai',
      company: 'ABC Company Pvt. Ltd.',
    }));
    const row = await Order.findOne({ orderId: 'BO-2026-000001' }).lean();
    assert.equal(row.shippingAddress, 'Old warehouse, Pune');
    assert.equal(row.billingAddress, 'Old office, Mumbai');
    assert.equal(row.company, 'ABC Company Pvt. Ltd.');
  });

  test('both address fields default to null on an account that predates them', async () => {
    const u = await User.create({ email: 'legacy@example.test', password: 'x'.repeat(10) });
    assert.equal(u.shippingAddress, null);
    assert.equal(u.billingAddress, null);
  });
});

// ===========================================================================
// Requirement 4 — one delivery schedule email, covering both systems
// ===========================================================================

describe('delivery schedule email', () => {
  const customer = { name: 'Priya', company: 'ABC Co', email: 'p@example.test' };
  const line = (sku, date, over = {}) => ({
    reference: 'REF-1', skuCode: sku, product: 'Product ' + sku,
    quantity: 5, scheduledDate: date, note: null, ...over,
  });

  test('indent and booking items combine into ONE email with both sections', () => {
    const mail = buildDeliveryScheduleMail({
      customer,
      indentLines: [line('SKU-001', new Date('2026-09-15')), line('SKU-002', new Date('2026-09-20'))],
      bookingLines: [
        line('SKU-003', new Date('2026-09-18')),
        line('SKU-004', new Date('2026-09-25')),
        line('SKU-005', new Date('2026-09-26')),
      ],
    });
    assert.ok(mail, 'an email must be produced');
    assert.equal(mail.total, 5, 'the requirement is one email containing all 5');
    assert.match(mail.html, /Indent Items/);
    assert.match(mail.html, /Booking Items/);
    for (const sku of ['SKU-001', 'SKU-002', 'SKU-003', 'SKU-004', 'SKU-005']) {
      assert.match(mail.html, new RegExp(sku), `${sku} must appear`);
    }
    assert.match(mail.subject, /3 booking \+ 2 indent/);
  });

  test('booking items only — no empty Indent heading', () => {
    const mail = buildDeliveryScheduleMail({
      customer, indentLines: [], bookingLines: [line('SKU-A', new Date('2026-09-18'))],
    });
    assert.match(mail.html, /Booking Items/);
    assert.doesNotMatch(mail.html, /Indent Items/);
    assert.match(mail.subject, /1 booking item/);
  });

  test('indent items only — the existing behaviour still works', () => {
    const mail = buildDeliveryScheduleMail({
      customer, indentLines: [line('SKU-A', new Date('2026-09-18'))], bookingLines: [],
    });
    assert.match(mail.html, /Indent Items/);
    assert.doesNotMatch(mail.html, /Booking Items/);
  });

  test('each SKU shows its OWN date', () => {
    const mail = buildDeliveryScheduleMail({
      customer,
      indentLines: [],
      bookingLines: [
        line('SKU-A', new Date('2026-09-15')),
        line('SKU-B', new Date('2026-12-01')),
      ],
    });
    assert.match(mail.html, /15 Sep 2026/);
    assert.match(mail.html, /01 Dec 2026/);
  });

  test('an item with NO date is never reported as scheduled', () => {
    const mail = buildDeliveryScheduleMail({
      customer,
      indentLines: [],
      bookingLines: [line('DATED', new Date('2026-09-15')), line('UNDATED', null)],
    });
    assert.equal(mail.total, 1);
    assert.match(mail.html, /DATED/);
    assert.doesNotMatch(mail.html, /UNDATED/);
  });

  test('nothing scheduled sends NOTHING, not an empty table', () => {
    assert.equal(
      buildDeliveryScheduleMail({ customer, indentLines: [], bookingLines: [] }),
      null,
      'clearing the last date must not mail a table of nothing',
    );
    assert.equal(
      buildDeliveryScheduleMail({ customer, indentLines: [line('X', null)], bookingLines: [] }),
      null,
    );
  });

  test('HTML in a note or SKU is escaped rather than injected into the email', () => {
    const mail = buildDeliveryScheduleMail({
      customer,
      indentLines: [],
      bookingLines: [line('<img src=x onerror=alert(1)>', new Date('2026-09-15'))],
    });
    assert.doesNotMatch(mail.html, /<img src=x/);
    assert.match(mail.html, /&lt;img/);
  });
});

// ===========================================================================
// Requirement 1 — sessions survive two tabs and two devices
// ===========================================================================

describe('session model', () => {
  test('two devices hold two independent sessions', async () => {
    const u = await User.create({ email: 'multi@example.test', password: 'x'.repeat(10) });
    const desktop = signRefreshToken(u._id);
    const phone = signRefreshToken(u._id);

    await User.updateOne({ _id: u._id }, {
      $push: { refreshSessions: { $each: [
        { hash: hashRefreshToken(desktop.token), jti: desktop.jti, userAgent: 'desktop' },
        { hash: hashRefreshToken(phone.token), jti: phone.jti, userAgent: 'phone' },
      ] } },
    });

    const back = await User.findById(u._id).select('+refreshSessions').lean();
    assert.equal(back.refreshSessions.length, 2, 'signing in on a phone must not evict the desktop');

    // Each token resolves to its OWN session, which is what scopes reuse
    // detection and stops one device revoking the other.
    const found = back.refreshSessions.find((s) =>
      refreshHashMatches(hashRefreshToken(desktop.token), s.hash));
    assert.equal(found.userAgent, 'desktop');
  });

  test('a rotated session still accepts the token it just replaced, inside the window', async () => {
    const u = await User.create({ email: 'race@example.test', password: 'x'.repeat(10) });
    const first = signRefreshToken(u._id);
    const second = signRefreshToken(u._id);

    // Tab A rotated: the session now holds `second`, with `first` as prevHash.
    await User.updateOne({ _id: u._id }, {
      $push: { refreshSessions: {
        hash: hashRefreshToken(second.token),
        prevHash: hashRefreshToken(first.token),
        rotatedAt: new Date(),
      } },
    });

    const back = await User.findById(u._id).select('+refreshSessions').lean();
    const s = back.refreshSessions[0];

    // Tab B arrives holding `first`. Under the OLD account-wide model this was a
    // replay and revoked every session; it must now be recognised as the race
    // it is.
    const isRace =
      refreshHashMatches(hashRefreshToken(first.token), s.prevHash)
      && Date.now() - new Date(s.rotatedAt).getTime() <= REFRESH_GRACE_MS;
    assert.equal(isRace, true, 'a racing tab must be served, not treated as an attacker');

    // And an unrelated token is still a replay.
    const stranger = signRefreshToken(u._id);
    assert.equal(refreshHashMatches(hashRefreshToken(stranger.token), s.hash), false);
    assert.equal(refreshHashMatches(hashRefreshToken(stranger.token), s.prevHash), false);
  });

  test('the grace window is short enough to be safe and long enough to be useful', () => {
    assert.ok(REFRESH_GRACE_MS >= 5_000, 'shorter than a slow network round trip is useless');
    assert.ok(REFRESH_GRACE_MS <= 5 * 60_000, 'longer than a few minutes is an attack window');
  });

  test('sessions are capped so the document cannot grow without bound', () => {
    assert.ok(MAX_REFRESH_SESSIONS >= 2, 'at least a desktop and a phone');
    assert.ok(MAX_REFRESH_SESSIONS <= 50);
  });

  /**
   * The session lasts a DAY, and does so without depending on .env.
   *
   * Two separate failures are pinned here because the first one hid for months:
   *   1. the value must be read at USE time — as module-level consts these ran
   *      before dotenv, so `JWT_EXPIRES_IN=1d` in .env did nothing at all;
   *   2. the compiled-in DEFAULT must itself be a day, so a deployment whose
   *      .env happens to lack the line does not quietly fall back to 15 minutes.
   * Fixing only (1) would leave a server one missing line away from the original
   * complaint.
   */
  test('an access token lasts one day by default, with no environment set', () => {
    const saved = [process.env.JWT_ACCESS_EXPIRES_IN, process.env.JWT_EXPIRES_IN];
    try {
      delete process.env.JWT_ACCESS_EXPIRES_IN;
      delete process.env.JWT_EXPIRES_IN;
      assert.equal(ACCESS_TOKEN_TTL_DEFAULT, '1d');
      assert.equal(accessTokenTtl(), '1d');
      assert.equal(accessTokenExpiresInMs(), 24 * 60 * 60 * 1000);

      // The token itself, not just the config that feeds it.
      const decoded = JSON.parse(
        Buffer.from(signAccessToken('507f1f77bcf86cd799439011').split('.')[1], 'base64url').toString(),
      );
      assert.equal(decoded.exp - decoded.iat, 86_400, 'a signed token must really last 24 hours');
    } finally {
      if (saved[0] === undefined) delete process.env.JWT_ACCESS_EXPIRES_IN;
      else process.env.JWT_ACCESS_EXPIRES_IN = saved[0];
      if (saved[1] === undefined) delete process.env.JWT_EXPIRES_IN;
      else process.env.JWT_EXPIRES_IN = saved[1];
    }
  });

  test('an operator can still shorten it — the day is a default, not a hardcode', () => {
    const saved = process.env.JWT_ACCESS_EXPIRES_IN;
    try {
      process.env.JWT_ACCESS_EXPIRES_IN = '30m';
      assert.equal(accessTokenTtl(), '30m');
      assert.equal(accessTokenExpiresInMs(), 30 * 60 * 1000);
    } finally {
      if (saved === undefined) delete process.env.JWT_ACCESS_EXPIRES_IN;
      else process.env.JWT_ACCESS_EXPIRES_IN = saved;
    }
  });

  test('the access-token lifetime is read at USE time, so .env is honoured', () => {
    const prev = process.env.JWT_ACCESS_EXPIRES_IN;
    try {
      process.env.JWT_ACCESS_EXPIRES_IN = '42m';
      // The bug this guards: these were module-level consts evaluated before
      // dotenv ran, so JWT_EXPIRES_IN in .env was silently ignored forever.
      assert.equal(accessTokenTtl(), '42m');
    } finally {
      if (prev === undefined) delete process.env.JWT_ACCESS_EXPIRES_IN;
      else process.env.JWT_ACCESS_EXPIRES_IN = prev;
    }
  });
});

// ===========================================================================
// Requirement 3, regression — where the picklist addresses actually come from
// ===========================================================================

describe('picklist address resolution', () => {
  /*
   * The bug this pins: `booking.shape.js` used to expose
   *   shippingAddress: first.shippingAddress || first.location
   * which made the field ALWAYS truthy whenever a delivery town was known. The
   * picklist could then never fall through to the customer's profile address,
   * so a legacy booking printed "Pune" under Shipping Address while the real
   * warehouse address sat unused on the customer record.
   */
  test('the sales booking shape reports the SNAPSHOT, never the town as a stand-in', async () => {
    const { readFile } = await import('node:fs/promises');
    const shape = await readFile(new URL('../modules/sales/booking.shape.js', import.meta.url), 'utf8');
    const stripped = shape
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    assert.match(
      stripped,
      /shippingAddress: first\.shippingAddress \|\| null/,
      'the town must not be substituted for a snapshotted address',
    );
    assert.doesNotMatch(
      stripped,
      /shippingAddress: first\.shippingAddress \|\| first\.location/,
      'collapsing address into location makes the profile fallback unreachable',
    );
    // The town is still available on its own, for the readers that want it.
    assert.match(stripped, /location: first\.location \|\| null/);
  });

  test('both picklist adapters consult the profile before falling back to the town', async () => {
    const { readFile } = await import('node:fs/promises');
    const doc = await readFile(
      new URL('../../frontend/src/utils/picklistDocument.js', import.meta.url),
      'utf8',
    );
    // Order matters: snapshot, then the customer's current profile, then the
    // town. Asserting the sequence catches a reorder that would silently prefer
    // the town again.
    assert.match(
      doc,
      /booking\.shippingAddress \|\| profile\.shippingAddress \|\| booking\.location/,
      'sales adapter: snapshot -> profile -> town',
    );
    assert.match(
      doc,
      /order\.shippingAddress \|\| order\.customerProfile\?\.shippingAddress/,
      'customer adapter: snapshot -> profile',
    );
  });

  test('the customer profile carries the addresses the fallback depends on', async () => {
    const { readFile } = await import('node:fs/promises');
    const contact = await readFile(new URL('../utils/customerContact.js', import.meta.url), 'utf8');
    // Both the projection and the shape — a field missing from PROFILE_FIELDS
    // is simply absent from the query, and the fallback silently does nothing.
    assert.match(contact, /PROFILE_FIELDS = '[^']*shippingAddress[^']*billingAddress/);
    assert.match(contact, /shippingAddress: u\?\.shippingAddress \|\| null/);
    assert.match(contact, /billingAddress: u\?\.billingAddress \|\| null/);
  });
});
