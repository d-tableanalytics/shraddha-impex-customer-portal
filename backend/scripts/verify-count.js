/**
 * verify-count.js
 * -----------------------------------------------------------------------------
 * Checks for IMS Module M7 — Stock Verification & Physical Inventory.
 *
 *   1. State machine     every illegal transition is refused
 *   2. No direct writes  no balance is written outside the ledger path
 *   3. Full lifecycle    create → count → submit → approve → post
 *   4. Separation        the counter/submitter cannot approve their own work
 *   5. Double-post       structurally impossible (status gate + idempotency key)
 *   6. Immutability      posted counts and lines cannot be edited
 *   7. Overlap guard     one open count per SKU + location
 *   8. Projections       only affected SKUs updated; no full rebuild
 *   9. Ledger            variance posted as a signed COUNT movement
 *  10. Audit             every transition recorded
 *
 * Sections 1–2 are static. The rest require --db.
 *
 * Usage:
 *   node scripts/verify-count.js
 *   node scripts/verify-count.js --db --sku=14405M-10
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import StockCount, { COUNT_TRANSITIONS } from '../models/StockCount.js';
import StockCountLine from '../models/StockCountLine.js';
import StockAdjustment from '../models/StockAdjustment.js';
import StockMovement from '../models/StockMovement.js';
import StockBalance from '../models/StockBalance.js';
import StockHealth from '../models/StockHealth.js';
import User from '../models/User.js';
import {
  createCount, startCount, recordCounts, submitCount, reviewCount, postCount, cancelCount,
} from '../modules/inventory/count.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const WITH_DB = process.argv.includes('--db');
const getArg = (n) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`   ✅ ${name}`); }
  else { failed++; console.log(`   ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const expectFail = async (name, fn, code = null) => {
  try { await fn(); check(name, false, 'it succeeded'); }
  catch (err) {
    check(name, code ? err.code === code : true, `${err.code || err.name}: ${err.message.slice(0, 55)}`);
  }
};

const run = async () => {
  // ── 1. State machine ──────────────────────────────────────────────────────
  console.log('\n1. STATE MACHINE');
  check('Posted is terminal', COUNT_TRANSITIONS.Posted.length === 0);
  check('Cancelled is terminal', COUNT_TRANSITIONS.Cancelled.length === 0);
  check('only Approved may post',
    Object.entries(COUNT_TRANSITIONS).filter(([, to]) => to.includes('Posted')).map(([f]) => f).join() === 'Approved');
  check('Rejected returns to Counting', COUNT_TRANSITIONS.Rejected.includes('Counting'));
  check('Draft cannot jump to Approved', !COUNT_TRANSITIONS.Draft.includes('Approved'));
  check('Counting cannot jump to Posted', !COUNT_TRANSITIONS.Counting.includes('Posted'));
  check('Submitted cannot post without approval', !COUNT_TRANSITIONS.Submitted.includes('Posted'));

  // ── 2. No direct inventory writes ─────────────────────────────────────────
  console.log('\n2. NO DIRECT INVENTORY WRITES');
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'inventory', 'count.service.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');

  check('never writes StockBalance directly',
    !/StockBalance\.(updateOne|updateMany|bulkWrite|findOneAndUpdate|create|insertMany)/.test(code));
  check('never writes StockHealth directly',
    !/StockHealth\.(updateOne|updateMany|bulkWrite|findOneAndUpdate|create|insertMany)/.test(code));
  check('never writes StockMovement directly',
    !/StockMovement\.(create|insertMany|updateOne|bulkWrite)/.test(code));
  check('never touches legacy inventory fields',
    !/totalAvailableQuantity|bookedQuantity|availableForSale/.test(code));
  check('posts through LedgerService.postBatch', code.includes('postBatch('));
  check('updates balances through applyMovements', code.includes('applyMovements('));
  check('updates health through recomputeHealthForSkus', code.includes('recomputeHealthForSkus('));
  check('uses a deterministic idempotency key', /idempotencyKey:\s*`count-\$\{countId\}-post`/.test(code));

  if (!WITH_DB) {
    console.log(`\n${'─'.repeat(52)}`);
    console.log(`   PASSED ${passed}   FAILED ${failed}   (static checks only)`);
    console.log('─'.repeat(52));
    console.log('\n   Re-run with --db to exercise the full lifecycle.\n');
    process.exit(failed === 0 ? 0 : 1);
  }

  // ── Database-backed lifecycle ─────────────────────────────────────────────
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/erp_portal');
  console.log(`\n🔌  Connected to MongoDB (${mongoose.connection.name})`);

  const sku = getArg('sku');
  const balance = sku
    ? await StockBalance.findOne({ skuCode: sku, onHand: { $gt: 0 } }).lean()
    : await StockBalance.findOne({ onHand: { $gt: 0 } }).lean();
  if (!balance) {
    console.log('\n❌  No SKU with stock. Post some movements first.\n');
    process.exit(1);
  }

  // Two distinct actors — separation of duties cannot be tested with one.
  const users = await User.find({ role: { $in: ['Admin', 'Inventory Manager', 'Management'] } }).limit(2).lean();
  if (users.length < 2) {
    console.log('\n❌  Need at least two Admin/Inventory Manager/Management users to test approval.\n');
    process.exit(1);
  }
  const [counter, approver] = users;
  const SKU = balance.skuCode;
  console.log(`📦  SKU ${SKU} (${balance.brand}) onHand=${balance.onHand}`);
  console.log(`👤  counter=${counter.email}  approver=${approver.email}\n`);

  console.log('3. LIFECYCLE');
  const created = await createCount({
    scope: 'spot', skuCodes: [SKU], brand: balance.brand,
    locationCode: balance.locationCode, notes: 'verify-count', actor: counter,
  });
  check('session created', Boolean(created.countId));
  check('expected quantity frozen from the balance projection', created.lineCount === 1);

  const line0 = await StockCountLine.findOne({ countId: created.countId }).lean();
  check('frozen expected matches the live balance', line0.expectedQuantity === balance.onHand);

  // Cannot count before starting.
  await expectFail('entering counts before Counting is refused',
    () => recordCounts({ countId: created.countId, lines: [{ skuCode: SKU, countedQuantity: 1 }], actor: counter }),
    'INVALID_STATE');

  await startCount({ countId: created.countId, actor: counter });
  check('Draft → Counting', (await StockCount.findOne({ countId: created.countId }).lean()).status === 'Counting');

  await expectFail('a variance without a reason code is refused',
    () => recordCounts({ countId: created.countId, lines: [{ skuCode: SKU, countedQuantity: balance.onHand - 3 }], actor: counter }),
    'LINE_VALIDATION_FAILED');

  const counted = balance.onHand - 3;
  await recordCounts({
    countId: created.countId,
    lines: [{ skuCode: SKU, countedQuantity: counted, reasonCode: 'COUNT_SHORTAGE' }],
    actor: counter,
  });
  const lineAfter = await StockCountLine.findOne({ countId: created.countId }).lean();
  check('difference = counted − expected', lineAfter.difference === counted - balance.onHand,
    `${lineAfter.difference}`);
  check('marked as needing adjustment', lineAfter.adjustmentRequired === true);

  const submitted = await submitCount({ countId: created.countId, actor: counter });
  check('Counting → Submitted', submitted.status === 'Submitted');
  check('variance counted in the roll-up', submitted.varianceLines === 1);

  console.log('\n4. SEPARATION OF DUTIES');
  await expectFail('the submitter cannot approve their own count',
    () => reviewCount({ countId: created.countId, decision: 'approve', actor: counter }),
    'SELF_APPROVAL_BLOCKED');
  await reviewCount({ countId: created.countId, decision: 'approve', actor: approver });
  check('a different user can approve',
    (await StockCount.findOne({ countId: created.countId }).lean()).status === 'Approved');

  console.log('\n5. POSTING');
  const movesBefore = await StockMovement.countDocuments({ skuCode: SKU });
  const healthBefore = await StockHealth.findOne({ skuCode: SKU, brand: balance.brand }).lean();

  const posted = await postCount({ countId: created.countId, actor: approver });
  check('posted to the ledger', posted.status === 'Posted' && Boolean(posted.ledgerBatchId));
  check('adjustment record created', Boolean(posted.adjustmentId));

  const movesAfter = await StockMovement.countDocuments({ skuCode: SKU });
  check('exactly one movement written', movesAfter === movesBefore + 1, `${movesBefore} → ${movesAfter}`);

  const mv = await StockMovement.findOne({ batchId: posted.ledgerBatchId }).lean();
  check('movement type is COUNT', mv.movementType === 'COUNT');
  check('movement class is PHYSICAL', mv.movementClass === 'PHYSICAL');
  check('quantity is the signed variance', mv.quantity === counted - balance.onHand);
  check('before/after recorded', mv.beforeQuantity === balance.onHand && mv.afterQuantity === counted);
  check('references the count', mv.referenceType === 'count' && mv.referenceId === created.countId);

  const balAfter = await StockBalance.findOne({ _id: balance._id }).lean();
  check('balance projection reflects the variance', balAfter.onHand === counted,
    `${balance.onHand} → ${balAfter.onHand}`);

  const healthAfter = await StockHealth.findOne({ skuCode: SKU, brand: balance.brand }).lean();
  check('health recomputed for the affected SKU',
    !healthBefore || healthAfter.computedAt > healthBefore.computedAt);

  console.log('\n6. DOUBLE POSTING');
  await expectFail('a posted count cannot be posted again',
    () => postCount({ countId: created.countId, actor: approver }), 'INVALID_TRANSITION');
  const movesFinal = await StockMovement.countDocuments({ skuCode: SKU });
  check('no extra movement written', movesFinal === movesAfter, `${movesAfter} → ${movesFinal}`);

  console.log('\n7. IMMUTABILITY AFTER POSTING');
  await expectFail('a posted count cannot be cancelled',
    () => cancelCount({ countId: created.countId, reason: 'nope', actor: approver }), 'INVALID_TRANSITION');
  await expectFail('a posted count cannot re-enter Counting',
    () => startCount({ countId: created.countId, actor: counter }), 'INVALID_TRANSITION');
  await expectFail('a posted line cannot be edited', async () => {
    const l = await StockCountLine.findOne({ countId: created.countId });
    l.countedQuantity = 999;
    await l.save();
  });

  console.log('\n8. OVERLAP GUARD');
  const second = await createCount({
    scope: 'spot', skuCodes: [SKU], brand: balance.brand,
    locationCode: balance.locationCode, notes: 'verify-count', actor: counter,
  });
  check('SKU countable again after posting released the lock', Boolean(second.countId));
  await expectFail('a third overlapping count is refused',
    () => createCount({
      scope: 'spot', skuCodes: [SKU], brand: balance.brand,
      locationCode: balance.locationCode, notes: 'verify-count', actor: counter,
    }), 'COUNT_IN_PROGRESS');
  await cancelCount({ countId: second.countId, reason: 'verification cleanup', actor: approver });
  check('cancelling releases the lock',
    (await StockCountLine.countDocuments({ countId: second.countId, openLock: true })) === 0);

  console.log('\n9. AUDIT TRAIL');
  const AuditLog = (await import('../models/AuditLog.js')).default;
  const events = await AuditLog.find({ 'meta.countId': created.countId }).lean();
  const actions = events.map((e) => e.action);
  for (const expected of [
    'Stock Count Created', 'Stock Count Started', 'Stock Count Submitted',
    'Stock Count Approved', 'Stock Adjustment Posted',
  ]) check(`audited: ${expected}`, actions.includes(expected));

  const postEvent = events.find((e) => e.action === 'Stock Adjustment Posted');
  check('audit records before/counted/difference and the transaction id',
    Boolean(postEvent?.meta?.lines?.[0]?.beforeQuantity !== undefined &&
      postEvent?.meta?.lines?.[0]?.transactionId));

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`   PASSED ${passed}   FAILED ${failed}`);
  console.log('─'.repeat(52));
  console.log(failed === 0
    ? '\n✅  Verification workflow guarantees hold.\n'
    : '\n❌  M7 verification FAILED — see above.\n');

  await mongoose.disconnect();
  process.exit(failed === 0 ? 0 : 1);
};

run().catch(async (err) => {
  console.error('\n❌  Verification crashed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
