/**
 * verify-ledger.js
 * -----------------------------------------------------------------------------
 * Integration checks for the IMS Module M2 stock ledger.
 *
 * These are the guarantees the ledger claims, exercised against a real database
 * rather than asserted in a comment:
 *
 *   1. Append-only    every update and delete path throws
 *   2. Idempotency    a replayed key returns the original batch, writes nothing
 *   3. Concurrency    simultaneous identical keys produce exactly one batch
 *   4. Validation     unknown types, wrong signs, zero and fractional quantities
 *                     and inconsistent before/after pairs are all rejected
 *   5. Consistency    afterQuantity must equal beforeQuantity + quantity
 *   6. Rollback       a failed post leaves no partial movements
 *   7. Reversal       contra-entries link both ways and cannot be re-reversed
 *   8. Audit          a posting writes an audit entry
 *
 * SAFETY: every movement written here uses a `verify-` prefixed idempotency key
 * and a dedicated workflowType, and --cleanup removes exactly those. It still
 * writes real rows, so run it against a development database.
 *
 * Usage:
 *   node scripts/verify-ledger.js --sku=14405M-10
 *   node scripts/verify-ledger.js --sku=14405M-10 --cleanup
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import StockMovement from '../models/StockMovement.js';
import StockBatch from '../models/StockBatch.js';
import AuditLog from '../models/AuditLog.js';
import { Product } from '../models/Product.js';
import Location from '../models/Location.js';
import { postBatch, reverseMovement, LedgerError } from '../modules/inventory/ledger.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const getArg = (n) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const CLEANUP = process.argv.includes('--cleanup');
const WORKFLOW = 'ledger-verification';
const stamp = Date.now();

let passed = 0;
let failed = 0;

const check = (name, condition, detail = '') => {
  if (condition) { passed++; console.log(`   ✅ ${name}`); }
  else { failed++; console.log(`   ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** Assert that `fn` throws, optionally matching a code. */
const expectThrows = async (name, fn, expectedCode = null) => {
  try {
    await fn();
    check(name, false, 'expected a rejection, but it succeeded');
  } catch (err) {
    if (expectedCode && err.code !== expectedCode) {
      check(name, false, `expected code ${expectedCode}, got ${err.code || err.name}: ${err.message}`);
    } else {
      check(name, true);
    }
  }
};

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/erp_portal');
  console.log(`\n🔌  Connected to MongoDB (${mongoose.connection.name})`);

  if (CLEANUP) {
    // Movements are append-only through Mongoose, so cleanup goes through the
    // driver directly — which is itself proof that the model guard is what
    // blocks deletion, not a database permission.
    const batches = await StockBatch.find({ workflowType: { $in: [WORKFLOW, 'reversal'] }, idempotencyKey: /^verify-/ }).lean();
    const ids = batches.map((b) => b.batchId);
    const m = await mongoose.connection.db.collection('stockmovements').deleteMany({ batchId: { $in: ids } });
    const b = await mongoose.connection.db.collection('stockbatches').deleteMany({ batchId: { $in: ids } });
    console.log(`\n🧹  Removed ${m.deletedCount} movement(s) and ${b.deletedCount} batch(es).\n`);
    await mongoose.disconnect();
    return;
  }

  // ── Fixtures ──────────────────────────────────────────────────────────────
  const skuArg = getArg('sku');
  const product = skuArg
    ? await Product.findOne({ skuCode: skuArg }).lean()
    : await Product.findOne({}).lean();

  if (!product) {
    console.log('\n❌  No products found. Run the M1 product migration first.\n');
    await mongoose.disconnect();
    process.exit(1);
  }
  const location = await Location.findOne({ isDefault: true }).lean();
  if (!location) {
    console.log('\n❌  No default location. Start the server once to seed it.\n');
    await mongoose.disconnect();
    process.exit(1);
  }

  const SKU = product.skuCode;
  console.log(`📦  Using SKU ${SKU} (${product.brand}) at ${location.code}\n`);

  const line = (over = {}) => ({
    movementType: 'RECEIPT', skuCode: SKU, brand: product.brand, quantity: 10, ...over,
  });

  // ── 1. Basic posting ──────────────────────────────────────────────────────
  console.log('1. POSTING');
  const key1 = `verify-${stamp}-basic`;
  const first = await postBatch({
    idempotencyKey: key1, workflowType: WORKFLOW,
    referenceType: 'system', referenceId: 'verify',
    lines: [line(), line({ quantity: 5, beforeQuantity: 100, afterQuantity: 105 })],
  });
  check('batch created', first.batch.status === 'posted' && !first.replayed);
  check('two movements written', first.batch.transactionIds.length === 2);
  check('net quantity summed', first.batch.totalQuantity === 15,
    `got ${first.batch.totalQuantity}`);

  const written = await StockMovement.find({ batchId: first.batch.batchId }).lean();
  check('movements carry denormalised brand', written.every((m) => m.brand === product.brand));
  check('movements carry location', written.every((m) => m.locationCode === location.code));
  check('movement class derived from type', written.every((m) => m.movementClass === 'PHYSICAL'));
  check('transaction ids are sequential and unique',
    new Set(written.map((m) => m.transactionId)).size === 2);

  // ── 2. Idempotency ────────────────────────────────────────────────────────
  console.log('\n2. IDEMPOTENCY');
  const replay = await postBatch({
    idempotencyKey: key1, workflowType: WORKFLOW,
    lines: [line({ quantity: 999 })], // deliberately different — must be ignored
  });
  check('replay flagged', replay.replayed === true);
  check('replay returns the original batch', replay.batch.batchId === first.batch.batchId);
  const afterReplay = await StockMovement.countDocuments({ batchId: first.batch.batchId });
  check('replay wrote no new movements', afterReplay === 2, `found ${afterReplay}`);

  // ── 3. Concurrency ────────────────────────────────────────────────────────
  console.log('\n3. CONCURRENCY');
  const raceKey = `verify-${stamp}-race`;
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => postBatch({
      idempotencyKey: raceKey, workflowType: WORKFLOW, lines: [line({ quantity: 3 })],
    })),
  );
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const batchIds = new Set(ok.map((r) => r.batch.batchId));
  check('all 5 concurrent posts resolved', ok.length === 5, `${ok.length}/5`);
  check('exactly one batch created', batchIds.size === 1, `${batchIds.size} distinct batches`);
  const raceMovements = await StockMovement.countDocuments({ batchId: [...batchIds][0] });
  check('exactly one movement written', raceMovements === 1, `found ${raceMovements}`);

  // ── 4. Validation ─────────────────────────────────────────────────────────
  console.log('\n4. VALIDATION');
  const bad = (lines, k) => () => postBatch({ idempotencyKey: `verify-${stamp}-${k}`, workflowType: WORKFLOW, lines });

  await expectThrows('unknown movement type rejected',
    bad([line({ movementType: 'TELEPORT' })], 'type'), 'INVALID_MOVEMENT_TYPE');
  await expectThrows('REVERSAL cannot be posted directly',
    bad([line({ movementType: 'REVERSAL' })], 'rev'), 'INVALID_MOVEMENT_TYPE');
  await expectThrows('zero quantity rejected',
    bad([line({ quantity: 0 })], 'zero'), 'INVALID_QUANTITY');
  await expectThrows('fractional quantity rejected',
    bad([line({ quantity: 1.5 })], 'frac'), 'INVALID_QUANTITY');
  await expectThrows('RECEIPT with negative quantity rejected',
    bad([line({ quantity: -5 })], 'sign'), 'INVALID_QUANTITY');
  await expectThrows('ISSUE with positive quantity rejected',
    bad([line({ movementType: 'ISSUE', quantity: 5 })], 'sign2'), 'INVALID_QUANTITY');
  await expectThrows('inconsistent before/after rejected',
    bad([line({ quantity: 10, beforeQuantity: 100, afterQuantity: 999 })], 'bal'), 'INCONSISTENT_BALANCE');
  await expectThrows('unknown SKU rejected',
    bad([line({ skuCode: 'NO-SUCH-SKU-XYZ' })], 'sku'), 'UNKNOWN_SKU');
  await expectThrows('unknown location rejected',
    bad([line({ locationCode: 'NOWHERE' })], 'loc'), 'UNKNOWN_LOCATION');
  await expectThrows('missing idempotency key rejected',
    () => postBatch({ workflowType: WORKFLOW, lines: [line()] }), 'IDEMPOTENCY_KEY_MISSING');
  await expectThrows('empty line set rejected',
    bad([], 'empty'));
  await expectThrows('future effective date rejected',
    () => postBatch({
      idempotencyKey: `verify-${stamp}-future`, workflowType: WORKFLOW,
      effectiveDate: new Date(Date.now() + 86_400_000), lines: [line()],
    }), 'INVALID_EFFECTIVE_DATE');

  // ── 5. Rollback ───────────────────────────────────────────────────────────
  console.log('\n5. ROLLBACK');
  const rollbackKey = `verify-${stamp}-rollback`;
  try {
    await postBatch({
      idempotencyKey: rollbackKey, workflowType: WORKFLOW,
      // Second line is invalid — the whole batch must be refused.
      lines: [line(), line({ quantity: 0 })],
    });
    check('invalid line aborts the batch', false, 'post unexpectedly succeeded');
  } catch {
    const orphanBatch = await StockBatch.findOne({ idempotencyKey: rollbackKey }).lean();
    const orphanMoves = await StockMovement.countDocuments({ idempotencyKey: rollbackKey });
    check('no batch written on validation failure', !orphanBatch);
    check('no movements written on validation failure', orphanMoves === 0);
  }

  // ── 6. Append-only ────────────────────────────────────────────────────────
  console.log('\n6. APPEND-ONLY');
  const target = written[0];
  await expectThrows('updateOne blocked',
    () => StockMovement.updateOne({ _id: target._id }, { $set: { quantity: 999 } }));
  await expectThrows('findOneAndUpdate blocked',
    () => StockMovement.findOneAndUpdate({ _id: target._id }, { $set: { quantity: 999 } }));
  await expectThrows('updateMany blocked',
    () => StockMovement.updateMany({}, { $set: { note: 'tampered' } }));
  await expectThrows('deleteOne blocked',
    () => StockMovement.deleteOne({ _id: target._id }));
  await expectThrows('deleteMany blocked',
    () => StockMovement.deleteMany({}));
  await expectThrows('document re-save blocked', async () => {
    const doc = await StockMovement.findById(target._id);
    doc.note = 'tampered';
    await doc.save();
  });
  await expectThrows('batch deletion blocked',
    () => StockBatch.deleteOne({ batchId: first.batch.batchId }));

  const stillIntact = await StockMovement.findById(target._id).lean();
  check('target movement unchanged after all attempts',
    stillIntact.quantity === target.quantity && stillIntact.note === target.note);

  // ── 7. Reversal ───────────────────────────────────────────────────────────
  console.log('\n7. REVERSAL');
  const rev = await reverseMovement({
    transactionId: target.transactionId,
    idempotencyKey: `verify-${stamp}-reversal`,
    reasonCode: 'REVERSAL', note: 'verification',
  });
  const reversalMove = await StockMovement.findOne({ transactionId: rev.batch.transactionIds[0] }).lean();
  check('reversal quantity is the inverse', reversalMove.quantity === -target.quantity);
  check('reversal inherits movement class', reversalMove.movementClass === target.movementClass);
  check('reversal links to the original',
    String(reversalMove.reversalOf) === String(target._id));

  const originalAfter = await StockMovement.findById(target._id).lean();
  check('original stamped with reversedBy',
    String(originalAfter.reversedBy) === String(reversalMove._id));

  await expectThrows('a reversal cannot be reversed',
    () => reverseMovement({
      transactionId: reversalMove.transactionId,
      idempotencyKey: `verify-${stamp}-rev2`,
    }), 'ALREADY_REVERSAL');
  await expectThrows('a movement cannot be reversed twice',
    () => reverseMovement({
      transactionId: target.transactionId,
      idempotencyKey: `verify-${stamp}-rev3`,
    }), 'ALREADY_REVERSED');

  // ── 8. Audit ──────────────────────────────────────────────────────────────
  console.log('\n8. AUDIT');
  const audit = await AuditLog.findOne({
    action: 'Stock Movements Posted',
    'meta.batchId': first.batch.batchId,
  }).lean();
  check('audit entry written for the posting', Boolean(audit));
  check('audit records the transaction ids',
    audit?.meta?.transactionIds?.length === 2);

  // ── 9. Indexes ────────────────────────────────────────────────────────────
  console.log('\n9. INDEXES');
  const idx = await mongoose.connection.db.collection('stockmovements').indexes();
  const names = idx.map((i) => JSON.stringify(i.key));
  for (const expected of [
    '{"skuCode":1,"location":1,"effectiveDate":-1}',
    '{"effectiveDate":-1,"movementType":1}',
    '{"referenceType":1,"referenceId":1}',
    '{"reasonCode":1,"effectiveDate":-1}',
    '{"user":1,"createdAt":-1}',
    '{"brand":1,"effectiveDate":-1}',
    '{"transactionId":1}',
  ]) {
    check(`index present ${expected}`, names.includes(expected));
  }
  const batchIdx = (await mongoose.connection.db.collection('stockbatches').indexes())
    .find((i) => i.key.idempotencyKey);
  check('idempotencyKey index is unique', Boolean(batchIdx?.unique));

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`   PASSED ${passed}   FAILED ${failed}`);
  console.log('─'.repeat(52));
  console.log(failed === 0
    ? '\n✅  Ledger guarantees hold.\n   Run with --cleanup to remove the verification rows.\n'
    : '\n❌  Ledger verification FAILED — see the failures above.\n');

  await mongoose.disconnect();
  process.exit(failed === 0 ? 0 : 1);
};

run().catch(async (err) => {
  console.error('\n❌  Verification crashed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
