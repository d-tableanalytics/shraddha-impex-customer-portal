/**
 * Phases 3, 4 and 5 — backfill, reconciliation and the invariant guard.
 *
 * Every test runs against an in-memory replica set. The loopback fence in
 * tests/helpers/isolation.js makes that structural rather than a convention:
 * these tests WRITE, and the production connection string is one careless
 * import away in this repository.
 *
 * The properties under test are the ones that make a repair safe to run on a
 * live system:
 *
 *   accuracy      a reconstructed movement matches the record it came from
 *   idempotency   running twice changes nothing the second time
 *   containment   a repair cannot reach an order, reservation, PO or indent
 *   concurrency   a booking made mid-repair is never overwritten
 *   reversibility a rollback restores, without undoing what came after
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';

import { startTestReplSet, stopTestMongo, clearCollections } from './helpers/mongo.js';

const { default: Order } = await import('../models/Order.js');
const { default: Reservation } = await import('../models/Reservation.js');
const { default: StockMovement } = await import('../models/StockMovement.js');
const { default: StockBatch } = await import('../models/StockBatch.js');
const { default: StockBalance } = await import('../models/StockBalance.js');
const { default: StockOutbox } = await import('../models/StockOutbox.js');
const { default: Location } = await import('../models/Location.js');
const { Product, createProductModel } = await import('../models/Product.js');
const { seedBrands } = await import('../utils/brandRegistry.js');

const {
  buildPlan, applyPlan, rollbackRun, outboxBlockers, impliedMovements, backfillKey, rebuildFor,
} = await import('../scripts/lib/backfillCore.js');
const {
  CLASS, classifyAll, correctable, applyCorrection, recordCorrection,
  readVerifiedCounts, takeBackup, restoreBackup,
} = await import('../scripts/lib/reconcileCore.js');
const { VALIDATOR, assess, setValidation, currentValidation } = await import('../scripts/lib/stockValidator.js');
const { findOverCounted, correctOverCounted } = await import('../scripts/lib/duplicateCore.js');
const { cycleEvidence } = await import('../scripts/lib/backfillCore.js');
const {
  claimProjection, confirmProjection, releaseProjectionClaim,
  applyAndConfirmProjection, applyMovements,
} = await import('../modules/inventory/balance.service.js');
const { readApprovals } = await import('../scripts/lib/reconcileCore.js');

let db;
before(async () => { await startTestReplSet(); db = mongoose.connection.db; });
after(async () => { await stopTestMongo(); });

beforeEach(async () => {
  await clearCollections();
  await seedBrands();
  await Location.create({ code: 'MAIN', name: 'Main', isDefault: true, active: true });
});

const product = (sku, { total, booked = 0, afs = total - booked }) =>
  createProductModel('Koken').create({
    skuCode: sku, totalAvailableQuantity: total, bookedQuantity: booked, availableForSale: afs,
  });

/** An order line as the system would have written it. */
const line = (orderId, sku, over = {}) => Order.create({
  orderId, skuCode: sku, brand: 'Koken', user: new mongoose.Types.ObjectId(),
  status: 'PO Received', requestedQty: over.confirmedQty ?? 5, bookedQty: over.confirmedQty ?? 5,
  confirmedQty: over.confirmedQty ?? 5, pendingQty: 0,
  orderTimestamp: over.orderTimestamp ?? new Date('2026-08-01T10:00:00Z'),
  date: over.orderTimestamp ?? new Date('2026-08-01T10:00:00Z'),
  stockState: over.stockState ?? null,
  stockSettledAt: over.stockSettledAt ?? null,
  poNumber: over.poNumber ?? '-',
  ...over.extra,
});

const fresh = (sku) => Product.findOne({ skuCode: sku }).lean();

// ════════════════════════════════════════════════════════════════════════════
// PHASE 3 — HISTORICAL LEDGER BACKFILL
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 3 — ledger backfill', () => {
  test('BF-01 reconstructs exactly the movements the order line implies', async () => {
    const booked = new Date('2026-08-01T10:00:00Z');
    const settled = new Date('2026-08-03T11:00:00Z');
    const consumed = impliedMovements({
      confirmedQty: 7, stockState: 'consumed', orderTimestamp: booked, stockSettledAt: settled,
    });
    assert.deepEqual(consumed.map((m) => [m.movementType, m.quantity, m.effectiveDate]), [
      ['RESERVE', 7, booked],
      ['RELEASE', -7, settled],
      ['ISSUE', -7, settled],
    ]);

    const released = impliedMovements({
      confirmedQty: 4, stockState: 'released', orderTimestamp: booked, stockSettledAt: settled,
    });
    assert.deepEqual(released.map((m) => m.movementType), ['RESERVE', 'RELEASE']);

    // A line that never held stock implies nothing at all.
    assert.deepEqual(impliedMovements({ confirmedQty: 0, stockState: null }), []);
  });

  test('BF-02 preserves the original dates, quantities and references', async () => {
    await product('BF-2', { total: 20 });
    await line('BO-BF-2', 'BF-2', {
      confirmedQty: 6, stockState: 'consumed',
      orderTimestamp: new Date('2026-08-01T10:00:00Z'),
      stockSettledAt: new Date('2026-08-05T09:30:00Z'),
    });

    const { plan } = await buildPlan(db);
    await applyPlan(plan, { runId: 'BF-TEST-2' });

    const mv = await StockMovement.find({ skuCode: 'BF-2' }).sort({ effectiveDate: 1 }).lean();
    assert.equal(mv.length, 3);
    assert.equal(mv[0].movementType, 'RESERVE');
    assert.equal(mv[0].quantity, 6);
    assert.equal(mv[0].effectiveDate.toISOString(), '2026-08-01T10:00:00.000Z');
    assert.equal(mv[0].referenceId, 'BO-BF-2');
    assert.equal(mv[2].effectiveDate.toISOString(), '2026-08-05T09:30:00.000Z');
    // Dated in the past, so the ledger marks it as an entry made after the fact.
    assert.equal(mv[0].backdated, true);
  });

  test('BF-03 is idempotent — running twice posts one set of movements', async () => {
    await product('BF-3', { total: 20 });
    await line('BO-BF-3', 'BF-3', { confirmedQty: 5, stockState: 'consumed', stockSettledAt: new Date('2026-08-02T10:00:00Z') });

    const first = await buildPlan(db);
    await applyPlan(first.plan, { runId: 'BF-TEST-3' });
    const after1 = await StockMovement.countDocuments({ skuCode: 'BF-3' });

    // The second plan is empty, because the movements now exist.
    const second = await buildPlan(db);
    assert.equal(second.plan.length, 0, 'the plan did not notice its own work');

    // And forcing the first plan through again changes nothing.
    await applyPlan(first.plan, { runId: 'BF-TEST-3' });
    assert.equal(await StockMovement.countDocuments({ skuCode: 'BF-3' }), after1);
  });

  test('BF-04 the idempotency key is derived from the facts, not from chance', () => {
    assert.equal(backfillKey('BO-1', 'SKU-A', 'RESERVE'), 'backfill:BO-1:SKU-A:RESERVE');
    assert.notEqual(backfillKey('BO-1', 'SKU-A', 'RESERVE'), backfillKey('BO-1', 'SKU-A', 'RELEASE'));
  });

  test('BF-05 posts oldest first, so the history reads in the real order', async () => {
    await product('BF-5', { total: 50 });
    await line('BO-BF-5b', 'BF-5', { confirmedQty: 3, orderTimestamp: new Date('2026-09-01T10:00:00Z') });
    await line('BO-BF-5a', 'BF-5', { confirmedQty: 2, orderTimestamp: new Date('2026-08-01T10:00:00Z') });

    const { plan } = await buildPlan(db);
    assert.ok(plan[0].effectiveDate <= plan[1].effectiveDate, 'the plan is not in chronological order');
    assert.equal(plan[0].orderId, 'BO-BF-5a');
  });

  test('BF-06 reports ambiguous lines instead of inventing data', async () => {
    // No product and no brand on the row, so nothing can resolve it.
    await Order.collection.insertOne({
      orderId: 'BO-BF-6', skuCode: 'GHOST-SKU', confirmedQty: 4, status: 'PO Received',
      orderTimestamp: new Date('2026-08-01T10:00:00Z'),
    });
    const { plan, ambiguous } = await buildPlan(db);
    assert.equal(plan.length, 0);
    assert.equal(ambiguous.length, 1);
    assert.match(ambiguous[0].why, /brand/);
  });

  test('BF-07 refuses to run while the outbox still has work', async () => {
    await product('BF-7', { total: 20 });
    await StockOutbox.create({
      idempotencyKey: 'pending-1',
      payload: {
        skuCode: 'BF-7', brand: 'Koken', workflow: 'po-raise', effectiveDate: new Date(),
        movements: [{ movementType: 'ISSUE', quantity: -5 }],
      },
    });
    assert.equal(await outboxBlockers(db), 1, 'a pending posting was not detected');
  });

  test('BF-08 rebuilds the projection without touching product quantities', async () => {
    await product('BF-8', { total: 20, booked: 5 });
    await line('BO-BF-8', 'BF-8', { confirmedQty: 5 });
    const before = await fresh('BF-8');

    const { plan } = await buildPlan(db);
    await applyPlan(plan, { runId: 'BF-TEST-8' });
    await rebuildFor(['BF-8']);

    const after = await fresh('BF-8');
    assert.deepEqual(
      [after.totalAvailableQuantity, after.bookedQuantity, after.availableForSale],
      [before.totalAvailableQuantity, before.bookedQuantity, before.availableForSale],
      'the backfill changed product stock — it must only write history',
    );
    const bal = await StockBalance.findOne({ skuCode: 'BF-8' }).lean();
    assert.equal(bal.reserved, 5, 'the projection was not rebuilt from the new movements');
  });

  test('BF-09 rollback removes exactly what the run added', async () => {
    await product('BF-9', { total: 20 });
    await line('BO-BF-9', 'BF-9', { confirmedQty: 5 });

    // A genuine movement that predates the backfill must survive the rollback.
    const { postBatch } = await import('../modules/inventory/ledger.service.js');
    await postBatch({
      idempotencyKey: 'genuine-1', workflowType: 'stock-adjustment',
      referenceType: 'adjustment', referenceId: null,
      lines: [{ movementType: 'ADJUSTMENT', skuCode: 'BF-9', brand: 'Koken', quantity: 3, reasonCode: 'DATA_ENTRY' }],
    });

    const { plan } = await buildPlan(db);
    await applyPlan(plan, { runId: 'BF-TEST-9' });
    assert.equal(await StockMovement.countDocuments({ skuCode: 'BF-9' }), 2);

    const res = await rollbackRun(db, 'BF-TEST-9');
    assert.equal(res.movements, 1);
    const left = await StockMovement.find({ skuCode: 'BF-9' }).lean();
    assert.equal(left.length, 1);
    assert.equal(left[0].movementType, 'ADJUSTMENT', 'the rollback removed a genuine movement');
  });

  test('BF-10 a booking made during the backfill is picked up, not clobbered', async () => {
    await product('BF-10', { total: 50 });
    await line('BO-BF-10a', 'BF-10', { confirmedQty: 5 });

    const { plan } = await buildPlan(db);
    // A new booking lands after the plan was computed.
    await line('BO-BF-10b', 'BF-10', { confirmedQty: 7 });
    await applyPlan(plan, { runId: 'BF-TEST-10' });

    // The run posts only what it planned; the newcomer is simply still missing.
    assert.equal(await StockMovement.countDocuments({ referenceId: 'BO-BF-10a' }), 1);
    const next = await buildPlan(db);
    assert.equal(next.plan.length, 1);
    assert.equal(next.plan[0].orderId, 'BO-BF-10b', 'the later booking was lost rather than deferred');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PHASE 4 — RECONCILIATION
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 4 — reconciliation', () => {
  const ledgerFor = async (sku, { onHand, reserved = 0 }) => {
    const loc = await Location.findOne({ isDefault: true }).lean();
    await StockBalance.updateOne(
      { skuCode: sku },
      { $set: { skuCode: sku, brand: 'Koken', location: loc._id, locationCode: loc.code, onHand, reserved } },
      { upsert: true },
    );
    const { postBatch } = await import('../modules/inventory/ledger.service.js');
    if (onHand) {
      await postBatch({
        idempotencyKey: `seed-phys-${sku}`, workflowType: 'import',
        referenceType: 'import', referenceId: `IMP-${sku}`,
        lines: [{ movementType: 'OPENING', skuCode: sku, brand: 'Koken', quantity: onHand }],
      });
    }
    if (reserved) {
      await postBatch({
        idempotencyKey: `seed-alloc-${sku}`, workflowType: 'booking-confirm',
        referenceType: 'booking', referenceId: `BO-SEED-${sku}`,
        lines: [{ movementType: 'RESERVE', skuCode: sku, brand: 'Koken', quantity: reserved }],
      });
    }
  };

  test('RC-01 classifies each kind of breakage correctly', async () => {
    await product('RC-clean', { total: 10, booked: 0 });
    await ledgerFor('RC-clean', { onHand: 10 });

    await product('RC-phantom', { total: 4, booked: 0, afs: 7 });
    await ledgerFor('RC-phantom', { onHand: 4 });

    await product('RC-negative', { total: 10, booked: -5, afs: 15 });
    await ledgerFor('RC-negative', { onHand: 10 });

    await product('RC-ambig', { total: 10, booked: 0 });
    await ledgerFor('RC-ambig', { onHand: 40 });

    const results = await classifyAll(db);
    const by = (s) => results.find((r) => r.sku === s).classification;
    assert.equal(by('RC-clean'), CLASS.CLEAN);
    assert.equal(by('RC-phantom'), CLASS.PHANTOM_STOCK);
    assert.equal(by('RC-negative'), CLASS.NEGATIVE_FIELD);
    assert.equal(by('RC-ambig'), CLASS.PHYSICAL_AMBIGUOUS);
  });

  test('RC-02 bookedQuantity is restored from the commitment register', async () => {
    await product('RC-2', { total: 20, booked: 2, afs: 18 });
    await ledgerFor('RC-2', { onHand: 20 });
    await line('BO-RC-2', 'RC-2', { confirmedQty: 8, stockState: 'reserved' });

    const results = await classifyAll(db);
    const row = results.find((r) => r.sku === 'RC-2');
    assert.equal(row.classification, CLASS.BOOKED_CORRUPTED);
    assert.equal(row.proposed.booked, 8, 'the register was not used as the authority');
    assert.equal(row.proposed.afs, 12);
  });

  test('RC-03 a genuine oversell is reported, never corrected away', async () => {
    await product('RC-3', { total: 4, booked: 4, afs: 0 });
    await ledgerFor('RC-3', { onHand: 4 });
    await line('BO-RC-3', 'RC-3', { confirmedQty: 9, stockState: 'reserved' });

    const results = await classifyAll(db);
    const row = results.find((r) => r.sku === 'RC-3');
    assert.equal(row.classification, CLASS.GENUINELY_OVERSOLD);
    assert.equal(row.proposed.oversoldBy, 5);
    assert.equal(row.proposed.afs, 0, 'an oversold SKU must show zero, never a negative');
    assert.equal(correctable(results).some((r) => r.sku === 'RC-3'), false,
      'an oversold SKU was queued for automatic correction');
  });

  test('RC-04 ambiguous and malformed rows are excluded from correction', async () => {
    await product('RC-4', { total: 10, booked: 0 });
    await ledgerFor('RC-4', { onHand: 40 });
    await Product.collection.insertOne({ brand: 'Koken', description: 'no sku' });

    const results = await classifyAll(db);
    const fixable = correctable(results).map((r) => r.sku);
    assert.equal(fixable.includes('RC-4'), false, 'an ambiguous SKU was queued for correction');
    assert.ok(results.some((r) => r.classification === CLASS.MALFORMED));
    assert.equal(correctable(results).some((r) => r.classification === CLASS.MALFORMED), false);
  });

  test('RC-05 a client-verified count makes an ambiguous SKU correctable', async () => {
    await product('RC-5', { total: 10, booked: 0, afs: 10 });
    await ledgerFor('RC-5', { onHand: 40 });

    const without = await classifyAll(db);
    assert.equal(without.find((r) => r.sku === 'RC-5').classification, CLASS.PHYSICAL_AMBIGUOUS);

    const withCount = await classifyAll(db, { verifiedCounts: new Map([['RC-5', 25]]) });
    const row = withCount.find((r) => r.sku === 'RC-5');
    assert.equal(row.verifiedCount, 25);
    assert.equal(row.proposed.total, 25, 'the counted figure did not outrank legacy and ledger');
    assert.ok(correctable(withCount).some((r) => r.sku === 'RC-5'));
  });

  test('RC-06 applying a correction leaves bookings and indents untouched', async () => {
    await product('RC-6', { total: 10, booked: -4, afs: 14 });
    await ledgerFor('RC-6', { onHand: 10 });
    await line('BO-RC-6', 'RC-6', { confirmedQty: 3, stockState: 'reserved' });
    await Reservation.create({
      reservationId: 'RES-RC-6', customerId: new mongoose.Types.ObjectId(),
      productId: new mongoose.Types.ObjectId(), skuCode: 'RC-6', quantity: 4,
      expiryDate: new Date(Date.now() + 864e5), reservedBy: new mongoose.Types.ObjectId(),
      status: 'Pending', indentNumber: 'PI-RC-6',
    });

    const ordersBefore = await Order.find({}).lean();
    const resBefore = await Reservation.find({}).lean();

    const results = await classifyAll(db);
    const row = correctable(results).find((r) => r.sku === 'RC-6');
    assert.ok(row, 'the negative booked count was not queued for correction');
    const res = await applyCorrection(db, row, { runId: 'RC-TEST-6' });
    assert.equal(res.ok, true);

    const after = await fresh('RC-6');
    assert.equal(after.bookedQuantity, 3, 'booked was not restored from the register');
    assert.equal(after.availableForSale + after.bookedQuantity, after.totalAvailableQuantity);
    assert.deepEqual(await Order.find({}).lean(), ordersBefore, 'a booking was modified');
    assert.deepEqual(await Reservation.find({}).lean(), resBefore, 'a reservation was modified');
  });

  test('RC-07 a booking made mid-run is never overwritten', async () => {
    await product('RC-7', { total: 10, booked: -2, afs: 12 });
    await ledgerFor('RC-7', { onHand: 10 });

    const results = await classifyAll(db);
    const row = correctable(results).find((r) => r.sku === 'RC-7');

    // Stock moves between the plan and the apply.
    await Product.collection.updateOne({ skuCode: 'RC-7' }, { $set: { bookedQuantity: 5, availableForSale: 5 } });

    const res = await applyCorrection(db, row, { runId: 'RC-TEST-7' });
    assert.equal(res.ok, false, 'a stale plan overwrote a live change');
    assert.match(res.skipped, /changed/);
    const after = await fresh('RC-7');
    assert.equal(after.bookedQuantity, 5, 'the live value was lost');
  });

  test('RC-08 the correction appears in the ledger as an auditable adjustment', async () => {
    await product('RC-8', { total: 10, booked: 0, afs: 14 });
    await ledgerFor('RC-8', { onHand: 10 });
    const results = await classifyAll(db, { verifiedCounts: new Map([['RC-8', 14]]) });
    const row = correctable(results).find((r) => r.sku === 'RC-8');

    await applyCorrection(db, row, { runId: 'RC-TEST-8' });
    await recordCorrection(row, { runId: 'RC-TEST-8' });

    const mv = await StockMovement.findOne({ skuCode: 'RC-8', reasonCode: 'RECONCILIATION' }).lean();
    assert.ok(mv, 'the repair was made silently, with no entry in the stock history');
    assert.equal(mv.quantity, 4);
    assert.equal(mv.beforeQuantity, 10);
    assert.equal(mv.afterQuantity, 14);
  });

  test('RC-09 rollback restores, but never undoes later activity', async () => {
    await product('RC-9a', { total: 10, booked: -3, afs: 13 });
    await product('RC-9b', { total: 20, booked: -2, afs: 22 });
    await ledgerFor('RC-9a', { onHand: 10 });
    await ledgerFor('RC-9b', { onHand: 20 });

    const results = await classifyAll(db);
    const rows = correctable(results).filter((r) => r.sku.startsWith('RC-9'));
    assert.equal(rows.length, 2);
    const backup = takeBackup(rows, 'RC-TEST-9');
    for (const r of rows) await applyCorrection(db, r, { runId: 'RC-TEST-9' });

    // A genuine booking lands on one of them afterwards.
    await Product.collection.updateOne({ skuCode: 'RC-9b' }, { $set: { bookedQuantity: 6, availableForSale: 14 } });

    const res = await restoreBackup(db, backup);
    assert.deepEqual(res.restored, ['RC-9a']);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].sku, 'RC-9b');
    const b = await fresh('RC-9b');
    assert.equal(b.bookedQuantity, 6, 'the rollback destroyed a transaction made after it');
  });

  test('RC-10 the Excel importer refuses anything it cannot read', async () => {
    await product('XL-1', { total: 10 });
    await product('XL-2', { total: 10 });
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const s = wb.addWorksheet('Physical Verification');
    s.addRow(['SKU Code', 'Brand', 'VERIFIED PHYSICAL STOCK']);
    s.addRow(['XL-1', 'Koken', 12]);          // good
    s.addRow(['XL-2', 'Koken', '']);          // blank — not yet counted
    s.addRow(['XL-GHOST', 'Koken', 5]);       // not in the catalogue
    s.addRow(['XL-1', 'Koken', 'about 20']);  // not a number
    const file = path.join(os.tmpdir(), `counts-${Date.now()}.xlsx`);
    await wb.xlsx.writeFile(file);

    const { counts, rejected, blank } = await readVerifiedCounts(file, db);
    assert.equal(counts.get('XL-1'), 12);
    assert.deepEqual(blank, ['XL-2']);
    assert.equal(rejected.length, 2);
    assert.ok(rejected.some((r) => /catalogue/.test(r.why)));
    assert.ok(rejected.some((r) => /not a number/.test(r.why)));
    fs.unlinkSync(file);
  });

  test('RC-11 a negative or fractional count is refused, not rounded', async () => {
    await product('XL-3', { total: 10 });
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const s = wb.addWorksheet('x');
    s.addRow(['SKU Code', 'VERIFIED PHYSICAL STOCK']);
    s.addRow(['XL-3', -4]);
    s.addRow(['XL-3', 2.5]);
    const file = path.join(os.tmpdir(), `counts2-${Date.now()}.xlsx`);
    await wb.xlsx.writeFile(file);

    const { counts, rejected } = await readVerifiedCounts(file, db);
    assert.equal(counts.size, 0);
    assert.equal(rejected.length, 2);
    fs.unlinkSync(file);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PHASE 5 — THE INVARIANT GUARD
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 5 — invariant guard', () => {
  test('VA-01 the rule accepts healthy rows and rejects every broken shape', async () => {
    await product('VA-ok', { total: 10, booked: 4, afs: 6 });
    await product('VA-phantom', { total: 4, booked: 0, afs: 9 });
    await product('VA-negative', { total: 10, booked: -2, afs: 12 });
    // A catalogue row that has never carried stock is exempt by design.
    await Product.collection.insertOne({ skuCode: 'VA-catalogue', brand: 'Koken', description: 'no stock fields' });

    const passing = await Product.find(VALIDATOR, { skuCode: 1 }).lean();
    const names = passing.map((p) => p.skuCode).sort();
    assert.ok(names.includes('VA-ok'));
    assert.ok(names.includes('VA-catalogue'), 'a stockless catalogue row was refused');
    assert.ok(!names.includes('VA-phantom'));
    assert.ok(!names.includes('VA-negative'));
  });

  test('VA-02 enforcement is refused while any row still fails', async () => {
    await product('VA-bad', { total: 4, booked: 0, afs: 9 });
    const { failing } = await assess(db);
    assert.ok(failing > 0);
    await assert.rejects(() => setValidation(db, 'error'), /still fail the invariant/);
  });

  test('VA-03 warn mode may be enabled at any time and allows the write', async () => {
    await product('VA-warn', { total: 4, booked: 0, afs: 9 });
    const after = await setValidation(db, 'warn');
    assert.equal(after.validationAction, 'warn');

    // A write that breaks the rule is logged, not refused.
    await Product.collection.updateOne({ skuCode: 'VA-warn' }, { $set: { availableForSale: 11 } });
    assert.equal((await fresh('VA-warn')).availableForSale, 11);
    await setValidation(db, 'off');
  });

  test('VA-04 once clean, enforcement refuses a write that breaks the invariant', async () => {
    await product('VA-good', { total: 10, booked: 4, afs: 6 });
    const { failing } = await assess(db);
    assert.equal(failing, 0);

    const after = await setValidation(db, 'error');
    assert.equal(after.validationAction, 'error');

    await assert.rejects(
      () => Product.collection.updateOne({ skuCode: 'VA-good' }, { $set: { availableForSale: 99 } }),
      /validation/i,
      'an inconsistent write was accepted while enforcement was on',
    );
    // A consistent write still goes through.
    await Product.collection.updateOne(
      { skuCode: 'VA-good' },
      { $set: { totalAvailableQuantity: 12, bookedQuantity: 4, availableForSale: 8 } },
    );
    assert.equal((await fresh('VA-good')).totalAvailableQuantity, 12);
    await setValidation(db, 'off');
  });

  test('VA-05 the guard can be removed again', async () => {
    await product('VA-off', { total: 10, booked: 0 });
    await setValidation(db, 'warn');
    await setValidation(db, 'off');
    const current = await currentValidation(db);
    assert.equal(current.hasValidator, false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// OVER-COUNTED MOVEMENTS, CYCLES, AND THE PROJECTION CLAIM
// ════════════════════════════════════════════════════════════════════════════

describe('Over-counted ledger movements', () => {
  const post = async (key, sku, type, qty, referenceId) => {
    const { postBatch } = await import('../modules/inventory/ledger.service.js');
    return postBatch({
      idempotencyKey: key, workflowType: 'booking-confirm',
      referenceType: 'booking', referenceId,
      lines: [{ movementType: type, skuCode: sku, brand: 'Koken', quantity: qty }],
    });
  };

  test('DUP-01 a retried posting is detected as surplus', async () => {
    await product('DUP-1', { total: 50 });
    await line('BO-DUP-1', 'DUP-1', { confirmedQty: 10, stockState: 'reserved' });
    for (const n of [1, 2, 3]) await post(`k-dup1-${n}`, 'DUP-1', 'RESERVE', 10, 'BO-DUP-1');

    const groups = await findOverCounted(db);
    const g = groups.find((x) => x.referenceId === 'BO-DUP-1');
    assert.ok(g, 'three identical RESERVEs were not flagged');
    assert.equal(g.actual, 3);
    assert.equal(g.expected, 1, 'a line holding stock once should carry one RESERVE');
    assert.equal(g.surplusCount, 2);
  });

  test('DUP-02 a genuine confirm/cancel/reconfirm cycle is NOT flagged', async () => {
    await product('DUP-2', { total: 50 });
    await line('BO-DUP-2', 'DUP-2', { confirmedQty: 10, stockState: 'reserved' });
    // Held, released, held again: two RESERVEs and one RELEASE is correct.
    await post('k-dup2-r1', 'DUP-2', 'RESERVE', 10, 'BO-DUP-2');
    await post('k-dup2-x1', 'DUP-2', 'RELEASE', -10, 'BO-DUP-2');
    await post('k-dup2-r2', 'DUP-2', 'RESERVE', 10, 'BO-DUP-2');

    const groups = await findOverCounted(db);
    assert.equal(
      groups.some((x) => x.referenceId === 'BO-DUP-2'), false,
      'a legitimate re-confirmation was reported as a duplicate',
    );
  });

  test('DUP-03 correction reverses the surplus and never deletes history', async () => {
    await product('DUP-3', { total: 50 });
    await line('BO-DUP-3', 'DUP-3', { confirmedQty: 10, stockState: 'reserved' });
    for (const n of [1, 2, 3]) await post(`k-dup3-${n}`, 'DUP-3', 'RESERVE', 10, 'BO-DUP-3');
    const before = await StockMovement.countDocuments({ skuCode: 'DUP-3' });

    const res = await correctOverCounted(await findOverCounted(db), { runId: 'DUP-TEST-3' });
    assert.equal(res.reversed.length, 2);

    // Originals are still there — plus two contra-entries.
    const reserves = await StockMovement.find({ skuCode: 'DUP-3', movementType: 'RESERVE' }).lean();
    assert.equal(reserves.length, 3, 'a historical movement was deleted');
    assert.equal(reserves.filter((m) => m.reversedBy).length, 2);
    assert.equal(await StockMovement.countDocuments({ skuCode: 'DUP-3' }), before + 2);
    const rev = await StockMovement.findOne({ skuCode: 'DUP-3', movementType: 'REVERSAL' }).lean();
    assert.equal(rev.quantity, -10);
    assert.equal(rev.movementClass, 'ALLOCATION', 'the reversal did not inherit the allocation class');
  });

  test('DUP-04 correction is idempotent', async () => {
    await product('DUP-4', { total: 50 });
    await line('BO-DUP-4', 'DUP-4', { confirmedQty: 10, stockState: 'reserved' });
    for (const n of [1, 2, 3]) await post(`k-dup4-${n}`, 'DUP-4', 'RESERVE', 10, 'BO-DUP-4');

    await correctOverCounted(await findOverCounted(db), { runId: 'DUP-TEST-4a' });
    const after1 = await StockMovement.countDocuments({ skuCode: 'DUP-4' });

    const second = await findOverCounted(db);
    assert.equal(second.some((g) => g.referenceId === 'BO-DUP-4'), false, 'the surplus was reported twice');
    await correctOverCounted(second, { runId: 'DUP-TEST-4b' });
    assert.equal(await StockMovement.countDocuments({ skuCode: 'DUP-4' }), after1);
  });

  test('DUP-05 the rebuilt balance nets missing AND surplus movements together', async () => {
    await product('DUP-5', { total: 100 });
    // One line whose RESERVE was posted three times...
    await line('BO-DUP-5a', 'DUP-5', { confirmedQty: 10, stockState: 'reserved' });
    for (const n of [1, 2, 3]) await post(`k-dup5-${n}`, 'DUP-5', 'RESERVE', 10, 'BO-DUP-5a');
    // ...and another whose RESERVE was never posted at all.
    await line('BO-DUP-5b', 'DUP-5', { confirmedQty: 4, stockState: 'reserved' });

    await correctOverCounted(await findOverCounted(db), { runId: 'DUP-TEST-5' });
    const { plan } = await buildPlan(db);
    await applyPlan(plan.filter((p) => p.skuCode === 'DUP-5'), { runId: 'DUP-TEST-5' });
    await rebuildFor(['DUP-5']);

    const bal = await StockBalance.findOne({ skuCode: 'DUP-5' }).lean();
    // 10 held by the first line + 4 by the second = 14, not 34.
    assert.equal(bal.reserved, 14, 'the projection did not net both corrections');
  });
});

describe('Cycle-aware reconstruction', () => {
  test('CY-01 repeated confirm/cancel cycles are detected, not read from stockState', async () => {
    await product('CY-1', { total: 50 });
    await line('BO-CY-1', 'CY-1', { confirmedQty: 8, stockState: 'reserved' });
    await mongoose.connection.collection('bookingstatusevents').insertMany([
      { orderId: 'BO-CY-1', status: 'Cancelled', previousStatus: 'PO Received', createdAt: new Date('2026-09-01') },
      { orderId: 'BO-CY-1', status: 'PO Received', previousStatus: 'Cancelled', createdAt: new Date('2026-09-02') },
    ]);

    const evidence = await cycleEvidence(db, ['BO-CY-1']);
    assert.ok(evidence.has('BO-CY-1'), 'a line that held stock twice looked like it held it once');
    assert.ok(evidence.get('BO-CY-1').cycles > 1);
  });

  test('CY-02 the plan reports the compression instead of inventing dated pairs', async () => {
    await product('CY-2', { total: 50 });
    await line('BO-CY-2', 'CY-2', { confirmedQty: 8, stockState: 'reserved' });
    await mongoose.connection.collection('bookingstatusevents').insertMany([
      { orderId: 'BO-CY-2', status: 'Cancelled', previousStatus: 'PO Received', createdAt: new Date('2026-09-01') },
      { orderId: 'BO-CY-2', status: 'PO Received', previousStatus: 'Cancelled', createdAt: new Date('2026-09-02') },
    ]);

    const { plan, compressed } = await buildPlan(db);
    const rows = plan.filter((p) => p.orderId === 'BO-CY-2');
    assert.equal(rows.length, 1, 'cycles were invented rather than reported');
    assert.equal(rows[0].quantity, 8, 'the NET held position is what gets reconstructed');
    assert.ok(compressed.some((c) => c.orderId === 'BO-CY-2'));
  });

  test('CY-03 a single-cycle line is unaffected', async () => {
    await product('CY-3', { total: 50 });
    await line('BO-CY-3', 'CY-3', { confirmedQty: 5, stockState: 'reserved' });
    const { plan, compressed } = await buildPlan(db);
    assert.equal(plan.filter((p) => p.orderId === 'BO-CY-3').length, 1);
    assert.equal(compressed.some((c) => c.orderId === 'BO-CY-3'), false);
  });
});

describe('Projection claim recovery', () => {
  const batch = (batchId, over = {}) => StockBatch.create({
    batchId, idempotencyKey: `k-${batchId}`, workflowType: 'booking-confirm',
    status: 'posted', lineCount: 1, totalQuantity: 1, transactionIds: [`T-${batchId}`], ...over,
  });

  test('PC-01 only one of several workers may claim a batch', async () => {
    await batch('BAT-PC-1');
    const results = await Promise.all([
      claimProjection('BAT-PC-1'), claimProjection('BAT-PC-1'), claimProjection('BAT-PC-1'),
    ]);
    assert.equal(results.filter(Boolean).length, 1, 'two workers folded the same batch');
  });

  test('PC-02 a claim abandoned by a dead worker is recoverable', async () => {
    // Claimed long ago, never confirmed: exactly what a killed process leaves.
    await batch('BAT-PC-2', {
      projectionClaimedAt: new Date(Date.now() - 10 * 60000),
      projectionAppliedAt: null,
    });
    assert.equal(await claimProjection('BAT-PC-2'), true, 'the batch was stranded for ever');
  });

  test('PC-03 a confirmed fold is never re-claimed', async () => {
    await batch('BAT-PC-3');
    assert.equal(await claimProjection('BAT-PC-3'), true);
    await confirmProjection('BAT-PC-3');
    // Even long afterwards, an applied batch is off limits.
    await StockBatch.updateOne({ batchId: 'BAT-PC-3' },
      { $set: { projectionClaimedAt: new Date(Date.now() - 10 * 60000) } });
    assert.equal(await claimProjection('BAT-PC-3'), false, 'an applied batch was folded twice');
  });

  test('PC-04 a failed fold releases the claim immediately', async () => {
    await batch('BAT-PC-4');
    assert.equal(await claimProjection('BAT-PC-4'), true);
    await releaseProjectionClaim('BAT-PC-4');
    assert.equal(await claimProjection('BAT-PC-4'), true, 'a retry had to wait out the timeout');
  });

  test('PC-05 a fresh claim held by a live worker is not stolen', async () => {
    await batch('BAT-PC-5');
    assert.equal(await claimProjection('BAT-PC-5'), true);
    assert.equal(await claimProjection('BAT-PC-5'), false, 'a live claim was stolen');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// RELEASE SAFETY — the three questions asked before deployment
// ════════════════════════════════════════════════════════════════════════════

describe('Projection fold is atomic', () => {
  const seedBatch = async (batchId, sku) => {
    const { postBatch } = await import('../modules/inventory/ledger.service.js');
    const r = await postBatch({
      idempotencyKey: `k-${batchId}`, workflowType: 'booking-confirm',
      referenceType: 'booking', referenceId: `BO-${batchId}`,
      lines: [{ movementType: 'RESERVE', skuCode: sku, brand: 'Koken', quantity: 10 }],
    });
    // The posting path already folded it; undo that so each test starts clean.
    await StockBalance.deleteMany({ skuCode: sku });
    await StockBatch.updateOne({ batchId: r.batch.batchId },
      { $set: { projectionAppliedAt: null, projectionClaimedAt: null } });
    const posted = await StockMovement.find({ transactionId: { $in: r.batch.transactionIds } }).lean();
    return { batchId: r.batch.batchId, posted };
  };

  test('AT-01 the fold and the confirm commit together', async () => {
    await product('AT-1', { total: 50 });
    const { batchId, posted } = await seedBatch('AT-1', 'AT-1');

    await applyAndConfirmProjection(batchId, posted);

    const bal = await StockBalance.findOne({ skuCode: 'AT-1' }).lean();
    assert.equal(bal.reserved, 10);
    const batch = await StockBatch.findOne({ batchId }).lean();
    assert.ok(batch.projectionAppliedAt, 'the batch was folded but not marked');
  });

  test('AT-02 a reclaim after a successful fold CANNOT apply it twice', async () => {
    // The exact crash under question: balance updated, process dies before the
    // mark. The claim then expires, and another worker picks the batch up.
    await product('AT-2', { total: 50 });
    const { batchId, posted } = await seedBatch('AT-2', 'AT-2');

    await applyAndConfirmProjection(batchId, posted);
    const once = await StockBalance.findOne({ skuCode: 'AT-2' }).lean();
    assert.equal(once.reserved, 10);

    // Age the claim past the timeout, exactly as a dead worker would leave it.
    await StockBatch.updateOne({ batchId },
      { $set: { projectionClaimedAt: new Date(Date.now() - 10 * 60000) } });

    // The mark survived the crash with the fold, so the batch is off limits.
    assert.equal(
      await claimProjection(batchId), false,
      'an already-folded batch was reclaimed — the balance would be counted twice',
    );
    const twice = await StockBalance.findOne({ skuCode: 'AT-2' }).lean();
    assert.equal(twice.reserved, 10, 'the balance was applied a second time');
  });

  test('AT-03 a batch folded but NOT marked would double-count — which is why it cannot happen', async () => {
    // Demonstrates the hazard the atomic fold removes: if the mark could be
    // lost while the balance survived, a reclaim WOULD double it.
    await product('AT-3', { total: 50 });
    const { batchId, posted } = await seedBatch('AT-3', 'AT-3');

    await applyAndConfirmProjection(batchId, posted);
    // Force the state the transaction makes unreachable.
    await StockBatch.updateOne({ batchId },
      { $set: { projectionAppliedAt: null, projectionClaimedAt: null } });
    assert.equal(await claimProjection(batchId), true);
    await applyMovements(posted);

    const bal = await StockBalance.findOne({ skuCode: 'AT-3' }).lean();
    assert.equal(bal.reserved, 20, 'sanity: an unmarked re-fold does double the balance');
    // ...and AT-02 proves the real path never reaches this state.
  });
});

describe('Backfill does not conflict with live bookings', () => {
  test('BC-01 a SKU still moving during the rebuild is reported, not silently stale', async () => {
    await product('BC-1', { total: 100 });
    await line('BO-BC-1', 'BC-1', { confirmedQty: 5, stockState: 'reserved' });
    const { plan } = await buildPlan(db);
    await applyPlan(plan.filter((p) => p.skuCode === 'BC-1'), { runId: 'BC-TEST-1' });

    // A booking lands during every rebuild attempt.
    const { postBatch } = await import('../modules/inventory/ledger.service.js');
    let n = 0;
    const real = db.collection.bind(db);
    const spy = (name) => {
      const col = real(name);
      if (name !== 'stockmovements') return col;
      const orig = col.countDocuments.bind(col);
      col.countDocuments = async (...a) => {
        const out = await orig(...a);
        n += 1;
        // Between the before- and after-count, post a new movement.
        if (n % 2 === 1) {
          await postBatch({
            idempotencyKey: `live-${n}`, workflowType: 'booking-confirm',
            referenceType: 'booking', referenceId: `BO-LIVE-${n}`,
            lines: [{ movementType: 'RESERVE', skuCode: 'BC-1', brand: 'Koken', quantity: 1 }],
          });
        }
        return out;
      };
      return col;
    };
    db.collection = spy;
    try {
      const rb = await rebuildFor(['BC-1'], { db, attempts: 2 });
      assert.deepEqual(
        rb.unsettled, ['BC-1'],
        'a SKU that kept moving was reported as settled',
      );
    } finally {
      db.collection = real;
    }
  });

  test('BC-02 a quiet SKU settles on the first attempt', async () => {
    await product('BC-2', { total: 100 });
    await line('BO-BC-2', 'BC-2', { confirmedQty: 6, stockState: 'reserved' });
    const { plan } = await buildPlan(db);
    await applyPlan(plan.filter((p) => p.skuCode === 'BC-2'), { runId: 'BC-TEST-2' });

    const rb = await rebuildFor(['BC-2'], { db });
    assert.deepEqual(rb.unsettled, []);
    const bal = await StockBalance.findOne({ skuCode: 'BC-2' }).lean();
    assert.equal(bal.reserved, 6);
  });

  test('BC-03 duplicate correction cannot reverse the same movement twice', async () => {
    await product('BC-3', { total: 100 });
    await line('BO-BC-3', 'BC-3', { confirmedQty: 10, stockState: 'reserved' });
    const { postBatch } = await import('../modules/inventory/ledger.service.js');
    for (const k of [1, 2, 3]) {
      await postBatch({
        idempotencyKey: `bc3-${k}`, workflowType: 'booking-confirm',
        referenceType: 'booking', referenceId: 'BO-BC-3',
        lines: [{ movementType: 'RESERVE', skuCode: 'BC-3', brand: 'Koken', quantity: 10 }],
      });
    }
    const groups = await findOverCounted(db);
    // Two correctors racing on the same surplus.
    const [a, b] = await Promise.all([
      correctOverCounted(groups, { runId: 'BC-TEST-3a' }),
      correctOverCounted(groups, { runId: 'BC-TEST-3b' }),
    ]);
    assert.equal(
      a.reversed.length + b.reversed.length, 2,
      'the same movement was reversed by both runs',
    );
    const revs = await StockMovement.countDocuments({ skuCode: 'BC-3', movementType: 'REVERSAL' });
    assert.equal(revs, 2);
  });
});

describe('Reconciliation applies only approved SKUs', () => {
  const workbook = async (rows) => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const sh = wb.addWorksheet('Proposed Corrections');
    sh.addRow(['SKU Code', 'Brand', 'Approved? (Y/N)']);
    for (const [sku, v] of rows) sh.addRow([sku, 'Koken', v]);
    const file = path.join(os.tmpdir(), `approvals-${Date.now()}-${Math.random()}.xlsx`);
    await wb.xlsx.writeFile(file);
    return file;
  };

  test('AP-01 only affirmative answers count as approval', async () => {
    const file = await workbook([
      ['A-1', 'Y'], ['A-2', 'yes'], ['A-3', 'N'], ['A-4', ''], ['A-5', '?'], ['A-6', 'hold'],
    ]);
    const { approved, rejected, undecided } = await readApprovals(file);
    assert.deepEqual([...approved].sort(), ['A-1', 'A-2']);
    assert.deepEqual(rejected.sort(), ['A-3', 'A-6']);
    assert.deepEqual(undecided.map((u) => u.sku).sort(), ['A-4', 'A-5']);
    fs.unlinkSync(file);
  });

  test('AP-02 a blank cell is not consent', async () => {
    const file = await workbook([['B-1', '']]);
    const { approved } = await readApprovals(file);
    assert.equal(approved.has('B-1'), false, 'an unanswered row was treated as approved');
    fs.unlinkSync(file);
  });

  test('AP-03 a workbook without the Approved column is refused', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('x').addRow(['SKU Code', 'Brand']);
    const file = path.join(os.tmpdir(), `noapproval-${Date.now()}.xlsx`);
    await wb.xlsx.writeFile(file);
    await assert.rejects(() => readApprovals(file), /Approved/);
    fs.unlinkSync(file);
  });

  test('AP-04 an approval for a SKU with no correction changes nothing', async () => {
    await product('AP-4', { total: 10, booked: 0, afs: 10 });
    const file = await workbook([['AP-4', 'Y']]);
    const { approved } = await readApprovals(file);
    const results = await classifyAll(db);
    const fixable = correctable(results);
    const toApply = fixable.filter((r) => approved.has(r.sku));
    assert.equal(toApply.length, 0, 'a healthy SKU was queued for correction');
    fs.unlinkSync(file);
  });
});
