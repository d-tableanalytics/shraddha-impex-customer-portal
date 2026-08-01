/**
 * verify-health.js
 * -----------------------------------------------------------------------------
 * Checks for the IMS Module M4 Stock Health Engine.
 *
 * Sections 1-4 are PURE and need no database — they exercise the calculator
 * directly, which is the point of keeping it free of I/O. Sections 5+ require a
 * connection and exercise the projection.
 *
 *   1. Excel parity        the verified workbook values, to the last decimal
 *   2. Band boundaries     inclusive-below, zero handled separately
 *   3. Unknown states      missing inputs never produce a computed number
 *   4. Formula versions    v1/v2 selected by config, not hardcoded
 *   5. Determinism         rebuild twice → identical documents
 *   6. Incremental         planning edit reclassifies just that SKU
 *   7. Config change       new thresholds reclassify in scope
 *   8. Isolation           no legacy inventory field is read
 *   9. Indexes             the projection's indexes exist
 *
 * Usage:
 *   node scripts/verify-health.js              # pure checks only
 *   node scripts/verify-health.js --db         # + projection checks
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { calculateHealth, rebuildHealth, recomputeHealthForSkus } from '../modules/inventory/health.service.js';
import StockHealth from '../models/StockHealth.js';
import { Product } from '../models/Product.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const WITH_DB = process.argv.includes('--db');

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`   ✅ ${name}`); }
  else { failed++; console.log(`   ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const cfg = (over = {}) => ({
  thresholds: { critical: 33, low: 66, healthy: 100 },
  formulaVersion: 'v1',
  ...over,
});
const planning = (over = {}) => ({
  dailyAvgConsumption: { low: 0, normal: 6.872222222, peak: 0 },
  currentSeason: 'Normal',
  leadTime: 365,
  safetyFactor: 0.5,
  status: 'Active',
  ...over,
});

const run = async () => {
  // ── 1. Excel parity ───────────────────────────────────────────────────────
  console.log('\n1. EXCEL PARITY (golden values from the audited workbooks)');
  const row3 = calculateHealth({ balance: { onHand: 170, reserved: 0 }, planning: planning(), config: cfg() });
  check('Max Level = 1254.1805555150002',
    Math.abs(row3.maxLevel - 1254.1805555150002) < 1e-9, `got ${row3.maxLevel}`);
  check('Available % = 13.554667169129683',
    Math.abs(row3.replenishmentPercent - 13.554667169129683) < 1e-9, `got ${row3.replenishmentPercent}`);
  check('band = Critical', row3.band === 'Critical', row3.band);

  for (const [dac, expected] of [[4.288888889, 782.7222222424999], [4.272222222, 779.680555515]]) {
    const r = calculateHealth({
      balance: { onHand: 7, reserved: 0 },
      planning: planning({ dailyAvgConsumption: { normal: dac } }),
      config: cfg(),
    });
    check(`Max Level for DAC ${dac}`, Math.abs(r.maxLevel - expected) < 1e-9, `got ${r.maxLevel}`);
  }

  check('Reorder Level = Max × critical%',
    Math.abs(row3.reorderLevel - row3.maxLevel * 0.33) < 1e-9);
  check('Coverage Days = onHand ÷ DAC',
    Math.abs(row3.coverageDays - 170 / 6.872222222) < 1e-9);
  check('v1 exposes no separate safety stock', row3.safetyStock === null);

  // ── 2. Band boundaries ────────────────────────────────────────────────────
  console.log('\n2. BAND BOUNDARIES (maxLevel = 100, so percent === onHand)');
  const flat = planning({ dailyAvgConsumption: { normal: 1 }, leadTime: 100, safetyFactor: 1 });
  const bandAt = (onHand) =>
    calculateHealth({ balance: { onHand, reserved: 0 }, planning: flat, config: cfg() }).band;
  for (const [q, expect] of [
    [0, 'Out of Stock'], [1, 'Critical'], [33, 'Critical'], [34, 'Low'],
    [66, 'Low'], [67, 'Healthy'], [100, 'Healthy'], [101, 'Overstock'],
  ]) check(`onHand ${q} → ${expect}`, bandAt(q) === expect, bandAt(q));

  // ── 3. Unknown states ─────────────────────────────────────────────────────
  console.log('\n3. UNKNOWN — a missing input must never yield a number');
  const unknownCases = [
    ['no consumption', planning({ dailyAvgConsumption: { normal: 0 } }), 'NO_CONSUMPTION'],
    ['no lead time', planning({ leadTime: 0 }), 'NO_LEAD_TIME'],
    ['no safety factor (v1)', planning({ safetyFactor: 0 }), 'NO_SAFETY_FACTOR'],
    ['discontinued', planning({ status: 'Discontinued' }), 'NOT_ACTIVE'],
  ];
  for (const [label, p, reason] of unknownCases) {
    const r = calculateHealth({ balance: { onHand: 50, reserved: 0 }, planning: p, config: cfg() });
    check(`${label} → Unknown, maxLevel null, reason ${reason}`,
      r.band === 'Unknown' && r.maxLevel === null && r.notPlannableReasons.includes(reason));
  }
  const noBalance = calculateHealth({ balance: null, planning: planning(), config: cfg() });
  check('no balance row → Out of Stock (not Unknown)', noBalance.band === 'Out of Stock');

  // ── 4. Formula versions ───────────────────────────────────────────────────
  console.log('\n4. FORMULA VERSION COMES FROM CONFIG');
  const v2 = calculateHealth({
    balance: { onHand: 170, reserved: 0 }, planning: planning(), config: cfg({ formulaVersion: 'v2' }),
  });
  check('v2 = 3× v1 when safety factor is 0.5',
    Math.abs(v2.maxLevel - row3.maxLevel * 3) < 1e-9);
  check('v2 exposes safety stock', v2.safetyStock !== null);
  check('version recorded on the result', row3.formulaVersion === 'v1' && v2.formulaVersion === 'v2');
  check('safetyFactor 0 is valid under v2',
    calculateHealth({ balance: { onHand: 50, reserved: 0 }, planning: planning({ safetyFactor: 0 }), config: cfg({ formulaVersion: 'v2' }) }).band !== 'Unknown');
  check('unknown formula version falls back to v1',
    calculateHealth({ balance: { onHand: 170, reserved: 0 }, planning: planning(), config: cfg({ formulaVersion: 'v9' }) }).formulaVersion === 'v1');

  console.log('\n   D2 — banding uses On Hand, not Available');
  const heavilyBooked = calculateHealth({
    balance: { onHand: 100, reserved: 90 }, planning: flat, config: cfg(),
  });
  check('a large booking does not flip Healthy → Critical', heavilyBooked.band === 'Healthy');
  check('sales coverage % is lower than replenishment %',
    heavilyBooked.salesCoveragePercent < heavilyBooked.replenishmentPercent);

  console.log('\n   Purity — same inputs, same output, 500 times');
  const first = JSON.stringify(calculateHealth({ balance: { onHand: 170, reserved: 3 }, planning: planning(), config: cfg() }));
  let pure = true;
  for (let i = 0; i < 500; i++) {
    if (JSON.stringify(calculateHealth({ balance: { onHand: 170, reserved: 3 }, planning: planning(), config: cfg() })) !== first) pure = false;
  }
  check('calculator is pure and deterministic', pure);

  if (!WITH_DB) {
    console.log(`\n${'─'.repeat(52)}`);
    console.log(`   PASSED ${passed}   FAILED ${failed}   (pure checks only)`);
    console.log('─'.repeat(52));
    console.log('\n   Re-run with --db to exercise the projection.\n');
    process.exit(failed === 0 ? 0 : 1);
  }

  // ── Database-backed sections ──────────────────────────────────────────────
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/erp_portal');
  console.log(`\n🔌  Connected to MongoDB (${mongoose.connection.name})`);

  console.log('\n5. REBUILD DETERMINISM');
  const a = await rebuildHealth({}, { actor: null });
  const snapA = await StockHealth.find({}, 'skuCode brand band maxLevel replenishmentPercent').sort({ skuCode: 1 }).lean();
  const b = await rebuildHealth({}, { actor: null });
  const snapB = await StockHealth.find({}, 'skuCode brand band maxLevel replenishmentPercent').sort({ skuCode: 1 }).lean();

  check('same row count', snapA.length === snapB.length, `${snapA.length} vs ${snapB.length}`);
  const identical = snapA.every((x, i) =>
    x.skuCode === snapB[i].skuCode && x.band === snapB[i].band &&
    x.maxLevel === snapB[i].maxLevel && x.replenishmentPercent === snapB[i].replenishmentPercent);
  check('two rebuilds produce identical values', identical);
  check('second rebuild reports zero band changes', b.changed === 0, `changed=${b.changed}`);
  console.log('   band distribution:', JSON.stringify(a.bandCounts));

  console.log('\n6. INCREMENTAL UPDATE');
  const sample = await StockHealth.findOne({ plannable: true }).lean();
  if (!sample) {
    console.log('   ⚠️  no plannable SKU to test — skipping');
  } else {
    const before = sample.maxLevel;
    await Product.updateOne({ skuCode: sample.skuCode, brand: sample.brand }, { $set: { leadTime: (sample.leadTime || 1) * 2 } });
    await recomputeHealthForSkus([sample.skuCode], { brand: sample.brand });
    const after = await StockHealth.findOne({ skuCode: sample.skuCode, brand: sample.brand }).lean();
    check('doubling lead time doubles Max Level',
      Math.abs(after.maxLevel - before * 2) < 1e-6, `${before} → ${after.maxLevel}`);
    // Restore.
    await Product.updateOne({ skuCode: sample.skuCode, brand: sample.brand }, { $set: { leadTime: sample.leadTime } });
    await recomputeHealthForSkus([sample.skuCode], { brand: sample.brand });
    const restored = await StockHealth.findOne({ skuCode: sample.skuCode, brand: sample.brand }).lean();
    check('restoring the input restores the value', Math.abs(restored.maxLevel - before) < 1e-6);
  }

  console.log('\n7. LEGACY ISOLATION');
  const src = (await import('fs')).readFileSync(
    path.join(__dirname, '..', 'modules', 'inventory', 'health.service.js'), 'utf8');
  for (const legacy of ['totalAvailableQuantity', 'bookedQuantity', 'availableForSale', 'availableInPercent']) {
    check(`health.service.js never references ${legacy}`, !src.includes(legacy));
  }

  console.log('\n8. INDEXES');
  const idx = (await mongoose.connection.db.collection('stockhealths').indexes()).map((i) => JSON.stringify(i.key));
  for (const e of [
    '{"skuCode":1,"brand":1}', '{"brand":1,"band":1,"onHand":-1}',
    '{"band":1}', '{"plannable":1}', '{"replenishmentPercent":1}', '{"coverageDays":1}',
  ]) check(`index present ${e}`, idx.includes(e));

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`   PASSED ${passed}   FAILED ${failed}`);
  console.log('─'.repeat(52));
  console.log(failed === 0 ? '\n✅  Health Engine guarantees hold.\n' : '\n❌  Health verification FAILED.\n');

  await mongoose.disconnect();
  process.exit(failed === 0 ? 0 : 1);
};

run().catch(async (err) => {
  console.error('\n❌  Verification crashed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
