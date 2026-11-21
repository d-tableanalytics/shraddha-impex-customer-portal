/**
 * Customer-level MOQ configuration.
 *
 * Three account shapes, one rule:
 *
 *   MSIL                            → no MOQ restriction, always
 *   Customer + MOQ Not Applicable   → no MOQ restriction
 *   Customer + MOQ Applicable       → multiples enforced
 *
 * The first half is pure (utils/moq.js, the one place the rule lives). The
 * second half runs the real handlers against a real database, because the
 * requirement is not "the rule function is correct" — it is "a booking made for
 * this customer is accepted or refused accordingly", and that passes through
 * the user controller, the reservation controller and the sales desk.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';

import { startTestMongo, stopTestMongo, clearCollections } from './helpers/mongo.js';

mock.module(new URL('../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});
mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: { sendEmail: async () => true },
});

const {
  MOQ_MODES, moqModeOf, moqAppliesTo, effectiveMoq, moqError, legacyMode, moqConfigFor,
} = await import('../utils/moq.js');
const { default: User } = await import('../models/User.js');
const { ProductKoken } = await import('../models/Product.js');
const { default: Order } = await import('../models/Order.js');
const { createUser, updateUser, resolveMoqConfig } = await import('../modules/users/user.controller.js');
const { createReservation, confirmBooking } = await import('../modules/reservations/reservation.controller.js');
const { updateBookingItems } = await import('../modules/sales/sales.controller.js');

const PRODUCT = { skuCode: 'SKU-M', moq: 10 };

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

describe('the MOQ rule reads the account configuration', () => {
  test('MSIL is exempt, whatever is stored on it', () => {
    const msil = { customerCategory: 'MSIL', email: 'x@maruti.com' };
    assert.equal(moqAppliesTo(msil), false);
    // Even with a stale APPLICABLE left over from before the switch to MSIL.
    assert.equal(moqAppliesTo({ ...msil, moqMode: MOQ_MODES.APPLICABLE, moqValue: 5 }), false);
    assert.equal(moqError({ ...msil, moqMode: MOQ_MODES.APPLICABLE }, PRODUCT, 3), null);
  });

  test('a Customer configured Not Applicable may order any quantity', () => {
    const user = { email: 'a@acme.com', customerCategory: 'Customer', moqMode: MOQ_MODES.NOT_APPLICABLE };
    assert.equal(moqAppliesTo(user), false);
    for (const q of [1, 3, 7, 101]) assert.equal(moqError(user, PRODUCT, q), null, `${q}`);
  });

  test('a Customer configured Applicable is held to the product Multiple', () => {
    const user = { email: 'a@acme.com', customerCategory: 'Customer', moqMode: MOQ_MODES.APPLICABLE };
    assert.equal(moqAppliesTo(user), true);
    assert.equal(effectiveMoq(user, PRODUCT), 10);
    assert.equal(moqError(user, PRODUCT, 20), null);
    assert.match(moqError(user, PRODUCT, 15), /multiple of 10/);
  });

  test('a configured MOQ value overrides the product Multiple', () => {
    const user = {
      email: 'a@acme.com', customerCategory: 'Customer',
      moqMode: MOQ_MODES.APPLICABLE, moqValue: 25,
    };
    assert.equal(effectiveMoq(user, PRODUCT), 25, 'the customer value wins over the product 10');
    assert.equal(moqError(user, PRODUCT, 50), null);
    assert.match(moqError(user, PRODUCT, 20), /multiple of 25/);
  });

  test('a blank value falls back to the product Multiple; an explicit 1 does not', () => {
    const base = { email: 'a@acme.com', customerCategory: 'Customer', moqMode: MOQ_MODES.APPLICABLE };
    assert.equal(effectiveMoq({ ...base, moqValue: null }, PRODUCT), 10, 'blank: the product decides');

    // An admin who TYPED 1 said "any quantity for this customer". Falling back
    // to the product's 10 would overrule a choice they made on purpose, so 1 is
    // honoured as the no-restriction value it literally is.
    assert.equal(effectiveMoq({ ...base, moqValue: 1 }, PRODUCT), 0);
    assert.equal(moqError({ ...base, moqValue: 1 }, PRODUCT, 7), null);

    assert.equal(effectiveMoq({ ...base, moqValue: 7 }, { moq: 0 }), 7, 'and works with no product Multiple');
  });

  test('the mode tolerates the spellings a form and an import each send', () => {
    for (const spelling of ['Not Applicable', 'not_applicable', ' NOT_APPLICABLE ', 'NA']) {
      assert.equal(
        moqModeOf({ email: 'a@acme.com', moqMode: spelling }),
        MOQ_MODES.NOT_APPLICABLE,
        spelling,
      );
    }
  });
});

describe('an account that has never been configured behaves exactly as before', () => {
  const cases = [
    ['an ordinary customer', { email: 'a@acme.com', customerCategory: 'Customer' }, true],
    ['an MSIL customer', { email: 'a@acme.com', customerCategory: 'MSIL' }, false],
    ['company staff', { email: 'desk@shraddhaimpex.net' }, false],
    ['a legacy SKIP override', { email: 'a@acme.com', moq: 'SKIP' }, false],
  ];

  for (const [label, user, expected] of cases) {
    test(`${label}: MOQ ${expected ? 'applies' : 'does not apply'}`, () => {
      assert.equal(user.moqMode, undefined, 'the fixture really is unconfigured');
      assert.equal(moqAppliesTo(user), expected);
      // And the backfill would stamp precisely that, so running it changes
      // nothing — which is what makes the migration safe.
      assert.equal(
        legacyMode(user),
        expected ? MOQ_MODES.APPLICABLE : MOQ_MODES.NOT_APPLICABLE,
      );
      assert.equal(moqAppliesTo({ ...user, moqMode: legacyMode(user) }), expected);
    });
  }

  test('moqConfigFor reports whether the answer was configured or derived', () => {
    assert.equal(moqConfigFor({ email: 'a@acme.com' }).source, 'derived');
    assert.equal(
      moqConfigFor({ email: 'a@acme.com', moqMode: MOQ_MODES.APPLICABLE }).source,
      'configured',
    );
  });
});

// ---------------------------------------------------------------------------
// What the write path stores
// ---------------------------------------------------------------------------

describe('resolveMoqConfig', () => {
  test('MSIL is stamped exempt whatever the form sent', () => {
    const { fields } = resolveMoqConfig({
      body: { moqMode: 'APPLICABLE', moqValue: 50 }, isMsil: true,
    });
    assert.deepEqual(fields, { moqMode: MOQ_MODES.NOT_APPLICABLE, moqValue: null });
  });

  test('an MSIL account already stamped is not rewritten', () => {
    const { fields } = resolveMoqConfig({
      body: {}, isMsil: true,
      existing: { moqMode: MOQ_MODES.NOT_APPLICABLE, moqValue: null },
    });
    assert.deepEqual(fields, {});
  });

  test('Not Applicable clears any value that was set', () => {
    const { fields } = resolveMoqConfig({
      body: { moqMode: 'NOT_APPLICABLE' }, isMsil: false,
      existing: { moqMode: MOQ_MODES.APPLICABLE, moqValue: 25 },
    });
    assert.deepEqual(fields, { moqMode: MOQ_MODES.NOT_APPLICABLE, moqValue: null });
  });

  test('a blank value under Applicable means "use the product Multiple"', () => {
    for (const blank of ['', null, undefined]) {
      const { fields } = resolveMoqConfig({
        body: { moqMode: 'APPLICABLE', moqValue: blank }, isMsil: false,
      });
      assert.deepEqual(fields, { moqMode: MOQ_MODES.APPLICABLE, moqValue: null }, String(blank));
    }
  });

  test('an unrecognised mode is refused rather than defaulted', () => {
    const result = resolveMoqConfig({ body: { moqMode: 'maybe' }, isMsil: false });
    assert.match(result.error, /Invalid MOQ configuration/);
    assert.equal(result.fields, undefined, 'nothing is offered to be written');
  });

  test('a value that is not a whole number above zero is refused', () => {
    for (const bad of [0, -5, 2.5, 'ten']) {
      const result = resolveMoqConfig({ body: { moqMode: 'APPLICABLE', moqValue: bad }, isMsil: false });
      assert.match(result.error, /whole number/, String(bad));
    }
  });

  test('sending a value alone keeps the mode the account already has', () => {
    const { fields } = resolveMoqConfig({
      body: { moqValue: 30 }, isMsil: false,
      existing: { moqMode: MOQ_MODES.APPLICABLE, moqValue: 10 },
    });
    assert.deepEqual(fields, { moqMode: MOQ_MODES.APPLICABLE, moqValue: 30 });
  });

  test('a body mentioning neither field writes nothing', () => {
    const { fields } = resolveMoqConfig({ body: { phone: '123' }, isMsil: false, existing: {} });
    assert.deepEqual(fields, {});
  });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

before(async () => { await startTestMongo(); });
after(async () => { await stopTestMongo(); });
beforeEach(async () => { await clearCollections(); });

const ADMIN = { _id: new mongoose.Types.ObjectId(), role: 'Super Admin', email: 'admin@example.com', permissions: ['*'] };
const DESK = { _id: new mongoose.Types.ObjectId(), role: 'Sales', email: 'desk@example.com' };

const call = async (handler, req) => {
  const res = { statusCode: 200, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.payload = b; return res; };
  let err = null;
  await handler({ body: {}, params: {}, query: {}, headers: {}, ...req }, res, (e) => { err = e; });
  if (err) throw err;
  return res;
};

/** The master details the server requires of every new customer. */
const MASTER = {
  customerName: 'Acme Ltd', phone: '9876543210', location: 'Pune',
  shopNumber: 'S-1', vendorNumber: 'V-1', gstNumber: '27AAAAA0000A1Z5',
};

const makeCustomer = async (overrides = {}) => {
  const res = await call(createUser, {
    user: ADMIN,
    body: {
      email: `c${Math.random().toString(36).slice(2, 8)}@acme.com`,
      password: 'secret123',
      role: 'Customer',
      brandAccess: { koken: true },
      ...MASTER,
      ...overrides,
    },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  return User.findById(res.payload.data._id);
};

const product = (moq = 10, stock = 1000) => ProductKoken.create({
  skuCode: `SKU-${Math.random().toString(36).slice(2, 8)}`,
  moq, availableForSale: stock, totalAvailableQuantity: stock, bookedQuantity: 0,
});

/** Try to put `quantity` of `p` into `user`'s selection list. */
const addToCart = async (user, p, quantity) => {
  try {
    const res = await call(createReservation, {
      user, body: { productId: String(p._id), quantity },
    });
    return { ok: res.statusCode < 300, message: res.payload?.message ?? null };
  } catch (err) {
    return { ok: false, message: err.message };
  }
};

describe('creating an account with each configuration', () => {
  test('MSIL: MOQ is disabled automatically, and a single unit books', async () => {
    const user = await makeCustomer({ customerCategory: 'MSIL' });
    assert.equal(user.moqMode, MOQ_MODES.NOT_APPLICABLE, 'stamped without being asked');
    assert.equal(user.moqValue, null);
    assert.equal(moqAppliesTo(user), false);

    const p = await product(10);
    assert.equal((await addToCart(user, p, 3)).ok, true, 'an awkward quantity is accepted');
  });

  test('MSIL ignores an MOQ configuration sent alongside it', async () => {
    const user = await makeCustomer({
      customerCategory: 'MSIL', moqMode: 'APPLICABLE', moqValue: 50,
    });
    assert.equal(user.moqMode, MOQ_MODES.NOT_APPLICABLE);
    assert.equal(user.moqValue, null);
  });

  test('Customer + MOQ Applicable: the multiple is enforced', async () => {
    const user = await makeCustomer({ customerCategory: 'Customer', moqMode: 'APPLICABLE' });
    assert.equal(user.moqMode, MOQ_MODES.APPLICABLE);

    const p = await product(10);
    const bad = await addToCart(user, p, 15);
    assert.equal(bad.ok, false);
    assert.match(bad.message, /multiple of 10/);
    assert.equal((await addToCart(user, p, 20)).ok, true);
  });

  test('Customer + MOQ Applicable with a configured value uses that value', async () => {
    const user = await makeCustomer({
      customerCategory: 'Customer', moqMode: 'APPLICABLE', moqValue: 25,
    });
    assert.equal(user.moqValue, 25);

    const p = await product(10);
    const bad = await addToCart(user, p, 20);
    assert.equal(bad.ok, false, 'a multiple of the PRODUCT value is not enough');
    assert.match(bad.message, /multiple of 25/);
    assert.equal((await addToCart(user, p, 50)).ok, true);
  });

  test('Customer + MOQ Not Applicable: anything books', async () => {
    const user = await makeCustomer({ customerCategory: 'Customer', moqMode: 'NOT_APPLICABLE' });
    const p = await product(10);
    assert.equal((await addToCart(user, p, 7)).ok, true);
  });

  test('a bad MOQ value is refused at creation and no account is written', async () => {
    const before = await User.countDocuments({});
    const res = await call(createUser, {
      user: ADMIN,
      body: {
        email: 'bad@acme.com', password: 'secret123', role: 'Customer',
        ...MASTER, moqMode: 'APPLICABLE', moqValue: -4,
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(await User.countDocuments({}), before);
  });
});

describe('updating the configuration on an existing customer', () => {
  test('turning MOQ on starts enforcing it', async () => {
    const user = await makeCustomer({ moqMode: 'NOT_APPLICABLE' });
    const p = await product(10);
    assert.equal((await addToCart(user, p, 7)).ok, true);

    await call(updateUser, {
      user: ADMIN, params: { id: String(user._id) },
      body: { moqMode: 'APPLICABLE', moqValue: 20 },
    });

    const after = await User.findById(user._id);
    assert.equal(after.moqMode, MOQ_MODES.APPLICABLE);
    assert.equal(after.moqValue, 20);
    const bad = await addToCart(after, await product(10), 7);
    assert.equal(bad.ok, false);
    assert.match(bad.message, /multiple of 20/);
  });

  test('turning MOQ off stops enforcing it, and clears the value', async () => {
    const user = await makeCustomer({ moqMode: 'APPLICABLE', moqValue: 20 });
    await call(updateUser, {
      user: ADMIN, params: { id: String(user._id) }, body: { moqMode: 'NOT_APPLICABLE' },
    });

    const after = await User.findById(user._id);
    assert.equal(after.moqValue, null, 'no dormant number left to be re-applied');
    assert.equal((await addToCart(after, await product(10), 7)).ok, true);
  });

  test('switching a customer to MSIL exempts them in the same request', async () => {
    const user = await makeCustomer({ moqMode: 'APPLICABLE', moqValue: 20 });
    await call(updateUser, {
      user: ADMIN, params: { id: String(user._id) }, body: { customerCategory: 'MSIL' },
    });

    const after = await User.findById(user._id);
    assert.equal(after.customerCategory, 'MSIL');
    assert.equal(after.moqMode, MOQ_MODES.NOT_APPLICABLE, 'no stale APPLICABLE left behind');
    assert.equal(after.moqValue, null);
    assert.equal((await addToCart(after, await product(10), 3)).ok, true);
  });

  test('an unrelated edit leaves the configuration alone', async () => {
    const user = await makeCustomer({ moqMode: 'APPLICABLE', moqValue: 20 });
    await call(updateUser, {
      user: ADMIN, params: { id: String(user._id) }, body: { company: 'Renamed Co' },
    });
    const after = await User.findById(user._id);
    assert.equal(after.company, 'Renamed Co');
    assert.equal(after.moqMode, MOQ_MODES.APPLICABLE);
    assert.equal(after.moqValue, 20);
  });

  test('an unconfigured customer stays unconfigured through an unrelated edit', async () => {
    // Written straight to the collection, as an account from before the fields
    // existed would be.
    const user = await User.create({
      email: 'legacy@acme.com', password: 'x', role: 'Customer',
      customerCategory: 'Customer', brandAccess: { koken: true },
    });
    assert.equal(user.moqMode, null);

    await call(updateUser, {
      user: ADMIN, params: { id: String(user._id) }, body: { company: 'Legacy Co' },
    });
    const after = await User.findById(user._id);
    assert.equal(after.moqMode, null, 'no mode invented for them');
    assert.equal(moqAppliesTo(after), true, 'and the behaviour is the one it always was');
  });

  test('a bad value is refused and the stored configuration does not move', async () => {
    const user = await makeCustomer({ moqMode: 'APPLICABLE', moqValue: 20 });
    const res = await call(updateUser, {
      user: ADMIN, params: { id: String(user._id) }, body: { moqValue: 0 },
    });
    assert.equal(res.statusCode, 400);
    const after = await User.findById(user._id);
    assert.equal(after.moqValue, 20);
  });
});

describe('the configuration reaches confirmation and the sales desk', () => {
  /** Cart → confirm. Returns the booking id. */
  const book = async (user, p, quantity) => {
    const added = await addToCart(user, p, quantity);
    assert.equal(added.ok, true, added.message ?? '');
    const res = await call(confirmBooking, { user });
    assert.equal(res.statusCode < 300, true, JSON.stringify(res.payload));
    return (await Order.findOne({}).lean()).orderId;
  };

  test('a configuration change between cart and confirm is caught at confirm', async () => {
    const user = await makeCustomer({ moqMode: 'NOT_APPLICABLE' });
    const p = await product(10);
    assert.equal((await addToCart(user, p, 7)).ok, true, 'legal when it went in the cart');

    await call(updateUser, {
      user: ADMIN, params: { id: String(user._id) }, body: { moqMode: 'APPLICABLE' },
    });

    const fresh = await User.findById(user._id);
    await assert.rejects(
      () => call(confirmBooking, { user: fresh }),
      /multiple of 10/,
      'confirmation is where stock is committed, so it is where the rule has to hold',
    );
    // Nothing was written, and no stock moved.
    assert.equal(await Order.countDocuments({}), 0);
    const stock = await ProductKoken.findById(p._id).lean();
    assert.equal(stock.availableForSale, 1000);
    assert.equal(stock.bookedQuantity, 0);
  });

  test('a desk quantity edit obeys the BOOKING customer, not the salesperson', async () => {
    const user = await makeCustomer({ moqMode: 'APPLICABLE' });
    const p = await product(10);
    const orderId = await book(user, p, 20);
    const line = await Order.findOne({ orderId }).lean();

    const bad = await call(updateBookingItems, {
      user: DESK, params: { orderId },
      body: { lines: [{ id: String(line._id), skuCode: p.skuCode, quantity: 25 }] },
    });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.payload.message, /multiple of 10/);

    const good = await call(updateBookingItems, {
      user: DESK, params: { orderId },
      body: { lines: [{ id: String(line._id), skuCode: p.skuCode, quantity: 30 }] },
    });
    assert.equal(good.statusCode, 200, JSON.stringify(good.payload));
    assert.equal((await Order.findById(line._id).lean()).confirmedQty, 30);
  });

  test('an MSIL booking is not held to a Multiple at the desk either', async () => {
    const user = await makeCustomer({ customerCategory: 'MSIL' });
    const p = await product(10);
    const orderId = await book(user, p, 3);
    const line = await Order.findOne({ orderId }).lean();

    const res = await call(updateBookingItems, {
      user: DESK, params: { orderId },
      body: { lines: [{ id: String(line._id), skuCode: p.skuCode, quantity: 7 }] },
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  });

  test('a line the edit does not move is not re-validated', async () => {
    // A booking made while the customer was exempt, carrying a quantity that
    // would fail the rule in force today. Editing the OTHER line must work.
    const user = await makeCustomer({ moqMode: 'NOT_APPLICABLE' });
    const a = await product(10);
    const b = await product(10);
    await addToCart(user, a, 7);
    await addToCart(user, b, 7);
    await call(confirmBooking, { user });
    const orderId = (await Order.findOne({}).lean()).orderId;
    const rows = await Order.find({ orderId }).sort({ lineSeq: 1 }).lean();

    await call(updateUser, {
      user: ADMIN, params: { id: String(user._id) }, body: { moqMode: 'APPLICABLE' },
    });

    const res = await call(updateBookingItems, {
      user: DESK, params: { orderId },
      body: {
        lines: [
          { id: String(rows[0]._id), skuCode: rows[0].skuCode, quantity: 7 },  // untouched
          { id: String(rows[1]._id), skuCode: rows[1].skuCode, quantity: 20 }, // moved, and legal
        ],
      },
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
    assert.equal((await Order.findById(rows[0]._id).lean()).confirmedQty, 7, 'left as it was');
    assert.equal((await Order.findById(rows[1]._id).lean()).confirmedQty, 20);
  });
});
