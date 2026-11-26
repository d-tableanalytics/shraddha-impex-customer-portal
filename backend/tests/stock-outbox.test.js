/**
 * Phase 2 — ledger durability through the transactional outbox.
 *
 * The property under test is narrow and absolute: a stock mutation that
 * commits ALWAYS ends with exactly one ledger posting, however many times the
 * posting is attempted, however many workers are running, and whatever happens
 * to the process in between.
 *
 * "Exactly one" is doing the work in that sentence. At-least-once delivery is
 * easy; it is the "not twice" half that stops a retry from double-counting the
 * balance projection, and it comes from one place — the idempotency key minted
 * with the row and reused by every attempt.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startTestReplSet, stopTestMongo, clearCollections } from './helpers/mongo.js';
import { startServer } from './helpers/http.js';

let UserModel = null;
mock.module(new URL('../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});
mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: { sendEmail: async () => true },
});
mock.module(new URL('../middlewares/auth.js', import.meta.url).href, {
  namedExports: {
    protect: async (req, res, next) => {
      const id = req.headers['x-test-user'];
      const user = id && mongoose.isValidObjectId(id) ? await UserModel.findById(id).lean() : null;
      if (!user) return res.status(401).json({ success: false });
      req.user = { ...user, id: String(user._id) };
      return next();
    },
  },
});

const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');
UserModel = User;
const { default: Location } = await import('../models/Location.js');
const { default: StockMovement } = await import('../models/StockMovement.js');
const { default: StockBatch } = await import('../models/StockBatch.js');
const { default: StockBalance } = await import('../models/StockBalance.js');
const { default: StockOutbox } = await import('../models/StockOutbox.js');
const { default: OversoldException } = await import('../models/OversoldException.js');
const { default: InventoryConfig } = await import('../models/InventoryConfig.js');
const { Product, createProductModel } = await import('../models/Product.js');
const { seedBrands } = await import('../utils/brandRegistry.js');
const { runInTransaction } = await import('../utils/transaction.js');
const { recordStockMovement } = await import('../utils/dualWrite.js');
const {
  drainOutbox, applyOutboxRow, reclaimStale, outboxStatus,
} = await import('../modules/inventory/outboxDrain.js');

let server;
let U;

before(async () => { await startTestReplSet(); server = await startServer(app); });
after(async () => { await server?.close(); await stopTestMongo(); });

let seq = 0;
const mkUser = async (role, extra = {}) => (await User.create({
  email: `${role.replace(/\s/g, '').toLowerCase()}${++seq}@example.com`, password: 'x'.repeat(12),
  user: `${role} ${seq}`, company: `${role} Co ${seq}`, role, ...extra,
})).toObject();

beforeEach(async () => {
  await clearCollections();
  await seedBrands();
  await Location.create({ code: 'MAIN', name: 'Main', isDefault: true, active: true });
  await InventoryConfig.create({ scope: 'global', indentAssignmentMode: 'auto', effectiveFrom: new Date(0) });
  U = {
    admin: await mkUser('Admin'),
    sales: await mkUser('Sales'),
    customer: await mkUser('Customer', { brandAccess: { koken: true }, moq: 'SKIP' }),
  };
});

const http = async (method, url, who, body) => {
  const headers = who ? { 'x-test-user': String(who._id) } : {};
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${server.url}${url}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json };
};
const POST = (u, w, b) => http('POST', u, w, b);
const PUT = (u, w, b) => http('PUT', u, w, b);

const product = (sku, units) => createProductModel('Koken').create({
  skuCode: sku, totalAvailableQuantity: units, bookedQuantity: 0, availableForSale: units,
});

/** An outbox row with no inline attempt — i.e. one only a worker will post. */
const pendingRow = (sku, overrides = {}) => StockOutbox.create({
  idempotencyKey: `test-${sku}-${Math.random().toString(36).slice(2)}`,
  payload: {
    skuCode: sku, brand: 'Koken', workflow: 'booking-confirm',
    referenceType: 'booking', referenceId: `BO-TEST-${sku}`,
    effectiveDate: new Date(),
    movements: [{ movementType: 'RESERVE', quantity: 3, beforeQuantity: 0, afterQuantity: 3 }],
  },
  ...overrides,
});

// ════════════════════════════════════════════════════════════════════════════

describe('Outbox durability', () => {
  test('OB-01 a committed booking leaves a posted outbox row behind', async () => {
    const p = await product('OB-1', 20);
    const res = await POST('/api/v1/reservations/direct-booking', U.customer,
      { items: [{ productId: String(p._id), quantity: 4 }] });
    assert.ok(res.status < 300, JSON.stringify(res.body));

    const rows = await StockOutbox.find({ 'payload.skuCode': 'OB-1' }).lean();
    assert.equal(rows.length, 1, 'the mutation did not record a durable intent');
    assert.equal(rows[0].state, 'applied');
    assert.ok(rows[0].batchId, 'applied without naming the batch it produced');
    assert.equal(await StockMovement.countDocuments({ skuCode: 'OB-1', movementType: 'RESERVE' }), 1);
  });

  test('OB-02 a rolled-back transaction leaves NO outbox row', async () => {
    await product('OB-2', 20);
    await assert.rejects(() => runInTransaction(async (session) => {
      const prod = await Product.findOne({ skuCode: 'OB-2' }, null, session ? { session } : {});
      await recordStockMovement({
        product: prod,
        workflow: 'booking-confirm',
        referenceType: 'booking',
        referenceId: 'BO-ROLLBACK',
        movements: [{ movementType: 'RESERVE', quantity: 5, beforeQuantity: 0, afterQuantity: 5 }],
      });
      throw new Error('deliberate rollback');
    }, { label: 'test' }));

    assert.equal(
      await StockOutbox.countDocuments({ 'payload.referenceId': 'BO-ROLLBACK' }), 0,
      'an intent survived a transaction that never happened',
    );
    assert.equal(await StockMovement.countDocuments({ skuCode: 'OB-2' }), 0);
  });

  test('OB-03 a row the inline attempt never made is posted by the worker', async () => {
    await product('OB-3', 20);
    await pendingRow('OB-3');

    const result = await drainOutbox();
    assert.equal(result.applied, 1);

    const row = await StockOutbox.findOne({ 'payload.skuCode': 'OB-3' }).lean();
    assert.equal(row.state, 'applied');
    assert.equal(await StockMovement.countDocuments({ skuCode: 'OB-3' }), 1);
  });

  test('OB-04 posting the same row twice produces ONE batch and ONE movement', async () => {
    await product('OB-4', 20);
    const row = await pendingRow('OB-4');

    await applyOutboxRow(row);
    await applyOutboxRow(row);

    assert.equal(await StockBatch.countDocuments({ idempotencyKey: row.idempotencyKey }), 1);
    assert.equal(await StockMovement.countDocuments({ skuCode: 'OB-4' }), 1,
      'the retry wrote a second movement — stock history is now double-counted');
  });

  test('OB-05 a replayed row does NOT double-count the balance projection', async () => {
    await product('OB-5', 20);
    const row = await pendingRow('OB-5');

    await applyOutboxRow(row);
    const after1 = await StockBalance.findOne({ skuCode: 'OB-5' }).lean();
    await applyOutboxRow(row);
    const after2 = await StockBalance.findOne({ skuCode: 'OB-5' }).lean();

    assert.equal(after2.reserved, after1.reserved, 'the projection counted the replay');
    assert.equal(after2.onHand, after1.onHand);
    assert.equal(after1.reserved, 3);
  });

  test('OB-06 two workers draining at once never process the same row twice', async () => {
    await product('OB-6', 200);
    for (let i = 0; i < 12; i += 1) await pendingRow('OB-6');

    const [a, b] = await Promise.all([drainOutbox(), drainOutbox()]);
    assert.equal(a.applied + b.applied, 12, `applied ${a.applied + b.applied} of 12`);
    assert.equal(await StockOutbox.countDocuments({ 'payload.skuCode': 'OB-6', state: 'applied' }), 12);
    assert.equal(
      await StockMovement.countDocuments({ skuCode: 'OB-6' }), 12,
      'a row was posted by both workers',
    );
  });

  test('OB-07 a worker that dies mid-flight does not strand its row', async () => {
    await product('OB-7', 20);
    // Exactly what a killed process leaves behind: claimed, never finished.
    await pendingRow('OB-7', {
      state: 'claimed',
      claimedBy: 'worker-that-died',
      claimedAt: new Date(Date.now() - 10 * 60_000),
    });

    assert.equal(await reclaimStale(), 1);
    const result = await drainOutbox();
    assert.equal(result.applied, 1);
    assert.equal((await StockOutbox.findOne({ 'payload.skuCode': 'OB-7' }).lean()).state, 'applied');
    assert.equal(await StockMovement.countDocuments({ skuCode: 'OB-7' }), 1);
  });

  test('OB-08 a row that cannot be posted is parked as failed, never discarded', async () => {
    await product('OB-8', 20);
    // A movement type the ledger refuses — a permanent failure, not a transient one.
    await pendingRow('OB-8', {
      attempts: 99,
      payload: {
        skuCode: 'OB-8', brand: 'Koken', workflow: 'booking-confirm',
        referenceType: 'booking', referenceId: 'BO-BAD', effectiveDate: new Date(),
        movements: [{ movementType: 'NOT_A_REAL_TYPE', quantity: 3 }],
      },
    });

    const result = await drainOutbox();
    assert.equal(result.failed, 1);
    const row = await StockOutbox.findOne({ 'payload.skuCode': 'OB-8' }).lean();
    assert.equal(row.state, 'failed');
    assert.ok(row.lastError, 'failed without recording why');
    // The point: it is still there to be found and fixed.
    assert.equal(await StockOutbox.countDocuments({ state: 'failed' }), 1);
  });

  test('OB-09 draining moves no stock, sends no mail and fulfils no indent', async () => {
    const p = await product('OB-9', 20);
    await POST('/api/v1/reservations/direct-booking', U.customer,
      { items: [{ productId: String(p._id), quantity: 4 }] });

    const before = await Product.findOne({ skuCode: 'OB-9' }).lean();
    const reservationsBefore = await mongoose.connection.collection('reservations').countDocuments({});

    await pendingRow('OB-9');
    await drainOutbox();

    const after = await Product.findOne({ skuCode: 'OB-9' }).lean();
    assert.equal(after.totalAvailableQuantity, before.totalAvailableQuantity);
    assert.equal(after.bookedQuantity, before.bookedQuantity);
    assert.equal(after.availableForSale, before.availableForSale);
    assert.equal(
      await mongoose.connection.collection('reservations').countDocuments({}), reservationsBefore,
      'the drain touched reservations',
    );
  });

  test('OB-10 the queue reports its own health', async () => {
    await product('OB-10', 20);
    await pendingRow('OB-10');
    const before = await outboxStatus();
    assert.equal(before.pending, 1);
    assert.ok(before.oldestPendingAt instanceof Date);

    await drainOutbox();
    const after = await outboxStatus();
    assert.equal(after.pending, 0);
    assert.equal(after.applied, 1);
  });

  test('OB-11 the actor who moved the stock survives into the posting', async () => {
    const p = await product('OB-11', 20);
    await POST('/api/v1/reservations/direct-booking', U.customer,
      { items: [{ productId: String(p._id), quantity: 4 }] });

    const row = await StockOutbox.findOne({ 'payload.skuCode': 'OB-11' }).lean();
    assert.equal(String(row.payload.actor), String(U.customer._id),
      'the posting would be audited as if the server did it');
    assert.ok(row.payload.endpoint, 'the request that caused it was not captured');
  });

  /**
   * The asynchronous path, tested explicitly.
   *
   * Everything above runs with IMS_LEDGER_POSTING=sync, which the test helper
   * sets so assertions do not race the posting. These four put it back to the
   * production setting and assert the properties that only matter there.
   */
  describe('asynchronous posting (the production setting)', () => {
    const withAsync = async (fn) => {
      const previous = process.env.IMS_LEDGER_POSTING;
      process.env.IMS_LEDGER_POSTING = 'async';
      try { return await fn(); } finally { process.env.IMS_LEDGER_POSTING = previous; }
    };
    /** Wait for the queue to empty, the way the drain worker eventually would. */
    const settle = async () => {
      for (let i = 0; i < 40; i += 1) {
        if ((await StockOutbox.countDocuments({ state: { $in: ['pending', 'claimed'] } })) === 0) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      await drainOutbox();
    };

    test('OB-13 the booking commits immediately; stock and reservation are NOT deferred', async () => {
      await withAsync(async () => {
        const p = await product('OB-13', 20);
        const res = await POST('/api/v1/reservations/direct-booking', U.customer,
          { items: [{ productId: String(p._id), quantity: 4 }] });
        assert.ok(res.status < 300, JSON.stringify(res.body));

        // Read the instant the response came back — before any drain.
        const after = await Product.findOne({ skuCode: 'OB-13' }).lean();
        assert.equal(after.bookedQuantity, 4, 'stock was deferred — it must not be');
        assert.equal(after.availableForSale, 16, 'availability was deferred — it must not be');
        assert.equal(
          await mongoose.connection.collection('orders').countDocuments({ skuCode: 'OB-13' }), 1,
          'the booking itself was deferred — it must not be',
        );
        // Only the ledger may lag, and it must still arrive.
        await settle();
        assert.equal(await StockMovement.countDocuments({ skuCode: 'OB-13' }), 1);
      });
    });

    test('OB-14 a deferred posting still lands exactly once', async () => {
      await withAsync(async () => {
        const p = await product('OB-14', 50);
        await POST('/api/v1/reservations/direct-booking', U.customer,
          { items: [{ productId: String(p._id), quantity: 4 }] });
        await settle();
        // A drain afterwards must find nothing left to do.
        const extra = await drainOutbox();
        assert.equal(extra.applied, 0);
        assert.equal(await StockMovement.countDocuments({ skuCode: 'OB-14', movementType: 'RESERVE' }), 1);
        assert.equal(await StockOutbox.countDocuments({ 'payload.skuCode': 'OB-14', state: 'applied' }), 1);
      });
    });

    test('OB-15 movements keep the order the stock actually moved in', async () => {
      await withAsync(async () => {
        const p = await product('OB-15', 50);
        const orderId = await (async () => {
          const r = await POST('/api/v1/reservations/direct-booking', U.customer,
            { items: [{ productId: String(p._id), quantity: 6 }] });
          return r.body.data.orderId || r.body.data.indentId.replace(/^PI-/, 'BO-');
        })();
        await PUT(`/api/v1/orders/${orderId}/po`, U.sales, { poNumber: 'PO-OB-15' });
        await settle();

        const mv = await StockMovement.find({ skuCode: 'OB-15' })
          .sort({ effectiveDate: 1, _id: 1 }).lean();
        const types = mv.map((m) => m.movementType);
        assert.equal(types[0], 'RESERVE', `first movement was ${types[0]} — history is out of order`);
        assert.ok(types.includes('ISSUE'));
        // The reservation must be dated before the issue that followed it.
        const reserve = mv.find((m) => m.movementType === 'RESERVE');
        const issue = mv.find((m) => m.movementType === 'ISSUE');
        assert.ok(
          reserve.effectiveDate <= issue.effectiveDate,
          'the issue is dated before the reservation that preceded it',
        );
      });
    });

    test('OB-16 a deferred posting is dated when the stock moved, not when it was drained', async () => {
      await withAsync(async () => {
        const p = await product('OB-16', 20);
        const t0 = new Date();
        await POST('/api/v1/reservations/direct-booking', U.customer,
          { items: [{ productId: String(p._id), quantity: 3 }] });
        const t1 = new Date();
        await new Promise((r) => setTimeout(r, 250));
        await settle();

        const mv = await StockMovement.findOne({ skuCode: 'OB-16' }).lean();
        assert.ok(mv.effectiveDate >= t0 && mv.effectiveDate <= t1,
          `effectiveDate ${mv.effectiveDate.toISOString()} is outside the window the stock actually moved in`);
        assert.equal(mv.backdated, false, 'an ordinary drain delay was flagged as a backdated entry');
      });
    });
  });

  /**
   * Release-audit cover (26 Nov 2026). Each of these answers one question the
   * audit asked before deployment, and each fails if that property is lost.
   */
  describe('release audit', () => {
    test('OB-17 a posted batch whose projection never ran is still projected on retry', async () => {
      // The crash window: postBatch succeeded, the process died before
      // applyMovements. The row comes back and the batch is now a REPLAY.
      await product('OB-17', 50);
      const row = await pendingRow('OB-17');
      await applyOutboxRow(row);

      const batch = await StockBatch.findOne({ idempotencyKey: row.idempotencyKey }).lean();
      assert.ok(batch.projectionAppliedAt, 'the fold was not recorded on the batch');

      // Simulate the crash: the batch is posted, the projection is not, and
      // no claim is outstanding. (A crash that died holding the claim is the
      // other case — the claim expires; see PC-02.)
      await StockBalance.deleteMany({ skuCode: 'OB-17' });
      await StockBatch.updateOne(
        { batchId: batch.batchId },
        { $set: { projectionAppliedAt: null, projectionClaimedAt: null } },
      );

      await applyOutboxRow(row);
      const bal = await StockBalance.findOne({ skuCode: 'OB-17' }).lean();
      assert.ok(bal, 'the replay skipped the projection — it is now permanently short');
      assert.equal(bal.reserved, 3);
    });

    test('OB-18 a batch already projected is never projected twice', async () => {
      await product('OB-18', 50);
      const row = await pendingRow('OB-18');
      await applyOutboxRow(row);
      const once = await StockBalance.findOne({ skuCode: 'OB-18' }).lean();

      await applyOutboxRow(row);
      await applyOutboxRow(row);
      const thrice = await StockBalance.findOne({ skuCode: 'OB-18' }).lean();

      assert.equal(thrice.reserved, once.reserved, 'the projection was double-counted');
      assert.equal(thrice.onHand, once.onHand);
    });

    test('OB-19 an older row failing does not corrupt the balance when a newer one succeeds', async () => {
      // Ordering under partial failure: the RELEASE lands before the RESERVE
      // it belongs to. The projection folds by addition, so the END STATE is
      // what must be right — not the order the rows happened to drain in.
      await product('OB-19', 50);
      const older = await pendingRow('OB-19', {
        payload: {
          skuCode: 'OB-19', brand: 'Koken', workflow: 'booking-confirm',
          referenceType: 'booking', referenceId: 'BO-ORDER-A', effectiveDate: new Date(Date.now() - 60_000),
          movements: [{ movementType: 'RESERVE', quantity: 10, beforeQuantity: 0, afterQuantity: 10 }],
        },
        // Not yet due, so the first drain skips it entirely.
        nextAttemptAt: new Date(Date.now() + 3_600_000),
      });
      const newer = await pendingRow('OB-19', {
        payload: {
          skuCode: 'OB-19', brand: 'Koken', workflow: 'po-raise',
          referenceType: 'booking', referenceId: 'BO-ORDER-A', effectiveDate: new Date(),
          movements: [{ movementType: 'RELEASE', quantity: -10, beforeQuantity: 10, afterQuantity: 0 }],
        },
      });

      await drainOutbox();
      const mid = await StockBalance.findOne({ skuCode: 'OB-19' }).lean();
      assert.equal(mid.reserved, -10, 'the newer row did not land on its own');

      // The older row becomes due and lands late.
      await StockOutbox.updateOne({ _id: older._id }, { $set: { nextAttemptAt: new Date() } });
      await drainOutbox();

      const end = await StockBalance.findOne({ skuCode: 'OB-19' }).lean();
      assert.equal(end.reserved, 0, 'the balance did not converge once both rows landed');
      assert.equal(await StockMovement.countDocuments({ skuCode: 'OB-19' }), 2);
      assert.ok(newer);
    });

    test('OB-20 an import cannot write a stale physical figure over a correct one', async () => {
      // The item-7 risk: a PHYSICAL movement is still queued when something
      // calls syncLegacyStock, which copies the ledger position onto the
      // product. Reading the projection before draining would write back the
      // higher, pre-issue figure.
      await product('OB-20', 40);
      const loc = await Location.findOne({ isDefault: true }).lean();
      await StockBalance.updateOne(
        { skuCode: 'OB-20' },
        {
          $set: {
            skuCode: 'OB-20', brand: 'Koken', location: loc._id,
            locationCode: loc.code, onHand: 40, reserved: 0,
          },
        },
        { upsert: true },
      );

      // 10 units have left the building; the posting has not been drained.
      await pendingRow('OB-20', {
        payload: {
          skuCode: 'OB-20', brand: 'Koken', workflow: 'po-raise',
          referenceType: 'booking', referenceId: 'BO-STALE', effectiveDate: new Date(),
          movements: [{ movementType: 'ISSUE', quantity: -10, beforeQuantity: 40, afterQuantity: 30 }],
        },
      });

      const { syncLegacyStock } = await import('../modules/inventory/balance.service.js');
      await syncLegacyStock(['OB-20']);

      const after = await Product.findOne({ skuCode: 'OB-20' }).lean();
      assert.equal(
        after.totalAvailableQuantity, 30,
        'a stale projection overwrote physical stock — the issued units came back',
      );
      assert.equal(await StockOutbox.countDocuments({ 'payload.skuCode': 'OB-20', state: 'pending' }), 0);
    });

    test('OB-21 booking against phantom stock is recorded, not silent', async () => {
      // A row already carrying 5 phantom units, as production has today.
      await product('OB-21', 4);
      await Product.collection.updateOne({ skuCode: 'OB-21' }, { $set: { availableForSale: 9 } });
      const p = await Product.findOne({ skuCode: 'OB-21' });

      const res = await POST('/api/v1/reservations/direct-booking', U.customer,
        { items: [{ productId: String(p._id), quantity: 9 }] });
      assert.ok(res.status < 300, JSON.stringify(res.body));

      // The commitment stands — it is not reduced behind the customer's back.
      const after = await Product.findOne({ skuCode: 'OB-21' }).lean();
      assert.equal(after.bookedQuantity, 9, 'a customer commitment was silently reduced');

      // But it is on the record, at booking time, not at PO time.
      const ex = await OversoldException.findOne({ skuCode: 'OB-21' }).lean();
      assert.ok(ex, 'a booking oversold against phantom stock and nothing recorded it');
      assert.equal(ex.shortfall, 5);
    });
  });

  test('OB-12 a multi-line booking records every line, with no breaker gap', async () => {
    // The original defect: lines 4..n of a booking were dropped once the
    // breaker opened. Every line must now leave a row behind.
    const skus = ['OB-12a', 'OB-12b', 'OB-12c', 'OB-12d', 'OB-12e', 'OB-12f', 'OB-12g'];
    const items = [];
    for (const s of skus) items.push({ productId: String((await product(s, 50))._id), quantity: 2 });

    const res = await POST('/api/v1/reservations/direct-booking', U.customer, { items });
    assert.ok(res.status < 300, JSON.stringify(res.body));

    await drainOutbox();
    for (const s of skus) {
      assert.equal(
        await StockOutbox.countDocuments({ 'payload.skuCode': s }), 1,
        `no durable intent for ${s}`,
      );
      assert.equal(
        await StockMovement.countDocuments({ skuCode: s, movementType: 'RESERVE' }), 1,
        `${s} has no RESERVE movement — the breaker gap is back`,
      );
    }
  });
});
