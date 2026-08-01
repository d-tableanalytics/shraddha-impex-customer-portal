/**
 * verify-balance.js
 * -----------------------------------------------------------------------------
 * Integration checks for the IMS Module M3 Balance Engine.
 *
 * The claims this module makes, exercised against a real database:
 *
 *   1. Determinism      the reducer is pure and order-independent
 *   2. Incremental      applyMovements folds new movements in correctly
 *   3. Replay           rebuildBalances reproduces the same numbers
 *   4. Equivalence      incremental result === replay result (the core claim)
 *   5. Class separation PHYSICAL touches onHand, ALLOCATION touches reserved
 *   6. Identities       available = onHand - reserved, always
 *   7. Reconciliation   drift is detected, not silently corrected
 *   8. Dual-write       a legacy stock mutation produces ledger movements
 *   9. Indexes          the projection's indexes exist
 *
 * SAFETY: writes real ledger rows using `verify-balance-` keys and a dedicated
 * workflow type. --cleanup removes exactly those and rebuilds the affected
 * balances. Run against a development database.
 *
 * Usage:
 *   node scripts/verify-balance.js --sku=14405M-10
 *   node scripts/verify-balance.js --sku=14405M-10 --cleanup
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import StockMovement, { MOVEMENT_CLASS } from '../models/StockMovement.js';
import StockBatch from '../models/StockBatch.js';
import StockBalance, { deriveBalance } from '../models/StockBalance.js';
import { Product } from '../models/Product.js';
import Location from '../models/Location.js';
import { postBatch } from '../modules/inventory/ledger.service.js';
import {
  reduceMovements, applyMovements, rebuildBalances, getSkuBalance,
} from '../modules/inventory/balance.service.js';
import { reconcile } from '../modules/inventory/reconciliation.service.js';
import { reserveStock, releaseStock, findProductBySku } from '../utils/stockLedger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const getArg = (n) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const CLEANUP = process.argv.includes('--cleanup');
const WORKFLOW = 'balance-verification';
const stamp = Date.now();

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`   ✅ ${name}`); }
  else { failed++; console.log(`   ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/erp_portal');
  console.log(`\n🔌  Connected to MongoDB (${mongoose.connection.name})`);

  const skuArg = getArg('sku');
  const product = skuArg
    ? await Product.findOne({ skuCode: skuArg }).lean()
    : await Product.findOne({}).lean();
  if (!product) { console.log('\n❌  No products. Run the M1 migration first.\n'); process.exit(1); }

  const location = await Location.findOne({ isDefault: true }).lean();
  if (!location) { console.log('\n❌  No default location. Start the server once.\n'); process.exit(1); }

  const SKU = product.skuCode;
  const BRAND = product.brand;

  if (CLEANUP) {
    const batches = await StockBatch.find({ idempotencyKey: /^verify-balance-/ }).lean();
    const ids = batches.map((b) => b.batchId);
    const m = await mongoose.connection.db.collection('stockmovements').deleteMany({ batchId: { $in: ids } });
    const b = await mongoose.connection.db.collection('stockbatches').deleteMany({ batchId: { $in: ids } });
    // Also drop the dual-write rows this script produced.
    const dwBatches = await StockBatch.find({ workflowType: { $in: ['reserve', 'release'] }, idempotencyKey: /^dw-/ }).lean();
    console.log(`\n🧹  Removed ${m.deletedCount} movement(s), ${b.deletedCount} batch(es).`);
    console.log(`    ${dwBatches.length} dual-write batch(es) left in place (real history).`);
    await rebuildBalances({ skuCode: SKU }, { actor: null });
    console.log('    Rebuilt balances for the affected SKU.\n');
    await mongoose.disconnect();
    return;
  }

  console.log(`📦  Using SKU ${SKU} (${BRAND}) at ${location.code}\n`);

  // ── 1. Determinism of the reducer ─────────────────────────────────────────
  console.log('1. REDUCER DETERMINISM (pure, no I/O)');
  const synthetic = [
    { skuCode: 'A', brand: 'X', location: 'L1', locationCode: 'L1', movementClass: 'PHYSICAL', movementType: 'RECEIPT', quantity: 100, effectiveDate: new Date('2026-01-01') },
    { skuCode: 'A', brand: 'X', location: 'L1', locationCode: 'L1', movementClass: 'ALLOCATION', movementType: 'RESERVE', quantity: 30, effectiveDate: new Date('2026-01-02') },
    { skuCode: 'A', brand: 'X', location: 'L1', locationCode: 'L1', movementClass: 'PHYSICAL', movementType: 'ISSUE', quantity: -20, effectiveDate: new Date('2026-01-03') },
    { skuCode: 'A', brand: 'X', location: 'L1', locationCode: 'L1', movementClass: 'ALLOCATION', movementType: 'RELEASE', quantity: -10, effectiveDate: new Date('2026-01-04') },
  ];
  const forward = reduceMovements(synthetic)[0];
  const reversed = reduceMovements([...synthetic].reverse())[0];
  const shuffled = reduceMovements([synthetic[2], synthetic[0], synthetic[3], synthetic[1]])[0];

  check('onHand correct (100 - 20)', forward.onHand === 80, `got ${forward.onHand}`);
  check('reserved correct (30 - 10)', forward.reserved === 20, `got ${forward.reserved}`);
  check('order-independent (reversed)', reversed.onHand === forward.onHand && reversed.reserved === forward.reserved);
  check('order-independent (shuffled)', shuffled.onHand === forward.onHand && shuffled.reserved === forward.reserved);
  check('timestamps take max not last-write',
    forward.lastMovementAt.getTime() === new Date('2026-01-04').getTime() &&
    reversed.lastMovementAt.getTime() === forward.lastMovementAt.getTime());
  check('lastIssuedAt tracks ISSUE only',
    forward.lastIssuedAt.getTime() === new Date('2026-01-03').getTime());
  check('ALLOCATION never touches onHand',
    reduceMovements([synthetic[1]])[0].onHand === 0);
  check('PHYSICAL never touches reserved',
    reduceMovements([synthetic[0]])[0].reserved === 0);

  // ── 2 & 3. Incremental vs replay ──────────────────────────────────────────
  console.log('\n2. INCREMENTAL PROJECTION');
  const before = await StockBalance.findOne({ skuCode: SKU, brand: BRAND, location: location._id }).lean();
  const baseline = before ? { onHand: before.onHand, reserved: before.reserved } : { onHand: 0, reserved: 0 };

  const posted = await postBatch({
    idempotencyKey: `verify-balance-${stamp}-a`,
    workflowType: WORKFLOW,
    referenceType: 'system', referenceId: 'verify-balance',
    lines: [
      { movementType: 'RECEIPT', skuCode: SKU, brand: BRAND, quantity: 60 },
      { movementType: 'RESERVE', skuCode: SKU, brand: BRAND, quantity: 25 },
      { movementType: 'ISSUE', skuCode: SKU, brand: BRAND, quantity: -15 },
    ],
  });
  const postedDocs = await StockMovement.find({ batchId: posted.batch.batchId }).lean();
  await applyMovements(postedDocs);

  const incremental = await StockBalance.findOne({ skuCode: SKU, brand: BRAND, location: location._id }).lean();
  check('onHand incremented by +45', incremental.onHand === baseline.onHand + 45,
    `${baseline.onHand} -> ${incremental.onHand}`);
  check('reserved incremented by +25', incremental.reserved === baseline.reserved + 25,
    `${baseline.reserved} -> ${incremental.reserved}`);
  check('movementCount increased by 3',
    incremental.movementCount === (before?.movementCount ?? 0) + 3);

  console.log('\n3. REPLAY / REBUILD');
  const rebuiltReport = await rebuildBalances({ skuCode: SKU }, { actor: null });
  const replayed = await StockBalance.findOne({ skuCode: SKU, brand: BRAND, location: location._id }).lean();
  check('rebuild ran', rebuiltReport.rebuiltCount > 0);
  check('rebuild marks the row', replayed.rebuiltFromLedger === true && Boolean(replayed.lastRebuiltAt));

  console.log('\n4. EQUIVALENCE — the core claim');
  check('replay onHand === incremental onHand',
    replayed.onHand === incremental.onHand, `${incremental.onHand} vs ${replayed.onHand}`);
  check('replay reserved === incremental reserved',
    replayed.reserved === incremental.reserved, `${incremental.reserved} vs ${replayed.reserved}`);
  check('replay movementCount === incremental movementCount',
    replayed.movementCount === incremental.movementCount,
    `${incremental.movementCount} vs ${replayed.movementCount}`);

  // Independently recompute from the ledger, bypassing both paths.
  const allMoves = await StockMovement.find({ skuCode: SKU, brand: BRAND }).lean();
  const independent = allMoves.reduce((acc, m) => {
    if (m.movementClass === MOVEMENT_CLASS.ALLOCATION) acc.reserved += m.quantity;
    else acc.onHand += m.quantity;
    return acc;
  }, { onHand: 0, reserved: 0 });
  const projectedTotal = await getSkuBalance(SKU, [BRAND]);
  check('independent ledger sum === projection (onHand)',
    independent.onHand === projectedTotal.total.onHand,
    `ledger ${independent.onHand} vs projection ${projectedTotal.total.onHand}`);
  check('independent ledger sum === projection (reserved)',
    independent.reserved === projectedTotal.total.reserved,
    `ledger ${independent.reserved} vs projection ${projectedTotal.total.reserved}`);

  // ── 5. Identities ─────────────────────────────────────────────────────────
  console.log('\n5. DERIVED IDENTITIES');
  const d = deriveBalance(replayed);
  check('available === onHand - reserved', d.available === d.onHand - d.reserved);
  check('projected === onHand + incoming - outgoing',
    d.projected === d.onHand + d.incoming - d.outgoing);
  check('available not stored on the document', !('available' in replayed));
  check('projected not stored on the document', !('projected' in replayed));

  // ── 6. Drift detection ────────────────────────────────────────────────────
  console.log('\n6. RECONCILIATION');
  // Corrupt the projection directly, then confirm reconciliation notices.
  await StockBalance.updateOne(
    { _id: replayed._id },
    { $inc: { onHand: 777 } },
  );
  const drifted = await reconcile({ skuCode: SKU, brand: BRAND });
  check('projection drift detected', drifted.summary.projectionDrift > 0);
  check('report marked unhealthy', drifted.healthy === false);
  check('drift row identifies the field',
    drifted.mismatches.some((m) => m.issues.some((i) => i.kind === 'projection-drift' && i.field === 'onHand')));
  check('reconciliation did NOT auto-correct',
    (await StockBalance.findById(replayed._id).lean()).onHand === replayed.onHand + 777);

  await rebuildBalances({ skuCode: SKU }, { actor: null });
  const healed = await reconcile({ skuCode: SKU, brand: BRAND });
  check('rebuild clears the drift', healed.summary.projectionDrift === 0);

  // ── 7. Dual-write ─────────────────────────────────────────────────────────
  console.log('\n7. DUAL-WRITE (legacy mutation → ledger)');
  const liveProduct = await findProductBySku(SKU);
  const movesBefore = await StockMovement.countDocuments({ skuCode: SKU });
  const legacyBookedBefore = liveProduct.bookedQuantity;

  const reserved = await reserveStock(liveProduct, 2, null, {
    workflow: 'verify-dual-write', referenceType: 'system', referenceId: 'verify',
  });
  // Give the fire-and-forget recorder a moment; it is awaited internally but
  // the balance apply is a second write.
  await new Promise((r) => setTimeout(r, 250));
  const movesAfter = await StockMovement.countDocuments({ skuCode: SKU });

  if (!reserved) {
    console.log('   ⚠️  reserveStock returned false (insufficient availableForSale) — skipping');
  } else {
    check('legacy field mutated', liveProduct.bookedQuantity === legacyBookedBefore + 2);
    check('ledger recorded the movement', movesAfter === movesBefore + 1,
      `${movesBefore} -> ${movesAfter}`);
    const latest = await StockMovement.findOne({ skuCode: SKU }).sort({ createdAt: -1 }).lean();
    check('movement is RESERVE / ALLOCATION',
      latest.movementType === 'RESERVE' && latest.movementClass === 'ALLOCATION');
    check('movement carries provenance',
      latest.referenceType === 'system' && latest.referenceId === 'verify');
    check('before/after recorded',
      latest.afterQuantity === latest.beforeQuantity + latest.quantity);

    // Put it back so the SKU is left as found.
    await releaseStock(liveProduct, 2, null, { workflow: 'verify-dual-write-undo' });
    await new Promise((r) => setTimeout(r, 250));
  }

  // ── 8. Indexes ────────────────────────────────────────────────────────────
  console.log('\n8. INDEXES');
  const idx = (await mongoose.connection.db.collection('stockbalances').indexes());
  const names = idx.map((i) => JSON.stringify(i.key));
  for (const e of [
    '{"skuCode":1,"brand":1,"location":1}',
    '{"location":1,"skuCode":1}',
    '{"brand":1,"skuCode":1}',
    '{"lastIssuedAt":1}',
  ]) check(`index present ${e}`, names.includes(e));
  check('grain index is unique',
    Boolean(idx.find((i) => i.key.skuCode && i.key.brand && i.key.location)?.unique));

  // ── Summary ───────────────────────────────────────────────────────────────
  await rebuildBalances({ skuCode: SKU }, { actor: null });
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`   PASSED ${passed}   FAILED ${failed}`);
  console.log('─'.repeat(52));
  console.log(failed === 0
    ? '\n✅  Balance Engine guarantees hold.\n   Run with --cleanup to remove the verification rows.\n'
    : '\n❌  Balance Engine verification FAILED — see above.\n');

  await mongoose.disconnect();
  process.exit(failed === 0 ? 0 : 1);
};

run().catch(async (err) => {
  console.error('\n❌  Verification crashed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
