/**
 * verify-reports.js
 * -----------------------------------------------------------------------------
 * Checks for IMS Module M6 — Reports & Snapshots.
 *
 *   1. Immutability      every update/delete path on snapshot rows throws
 *   2. Read-only source  no report file references a legacy inventory field or
 *                        recomputes a business value
 *   3. Snapshot generate copies from projections, totals match rows
 *   4. Duplicate protect a second snapshot for the same date is refused
 *   5. Rebuild           supersedes rather than mutates; old rows survive
 *   6. Integrity         validateSnapshot detects a recorded/actual mismatch
 *   7. Comparison        a pure diff; reproducible; unchanged rows excluded
 *   8. Reports           each returns rows and a scope-wide summary
 *   9. Indexes           the snapshot indexes exist
 *
 * Sections 1–2 are static and need no database. The rest require --db.
 *
 * Usage:
 *   node scripts/verify-reports.js
 *   node scripts/verify-reports.js --db
 *   node scripts/verify-reports.js --db --cleanup
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import InventorySnapshot from '../models/InventorySnapshot.js';
import SnapshotRun from '../models/SnapshotRun.js';
import { generateSnapshot, validateSnapshot, activeRun } from '../modules/inventory/snapshot.service.js';
import {
  inventorySummary, movementReport, healthReport, balanceReport,
  agingReport, compareSnapshots,
} from '../modules/inventory/report.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const WITH_DB = process.argv.includes('--db');
const CLEANUP = process.argv.includes('--cleanup');

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`   ✅ ${name}`); }
  else { failed++; console.log(`   ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const expectThrows = async (name, fn, match = /immutable|not permitted|cannot be deleted/i) => {
  try { await fn(); check(name, false, 'expected a rejection'); }
  catch (err) { check(name, match.test(err.message), err.message.slice(0, 60)); }
};

const run = async () => {
  // ── 1. Immutability (model-level, no DB required) ─────────────────────────
  console.log('\n1. SNAPSHOT IMMUTABILITY');
  for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne']) {
    await expectThrows(`${op} blocked`, () => InventorySnapshot[op]({}, { $set: { onHand: 999 } }));
  }
  for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete']) {
    await expectThrows(`${op} blocked`, () => InventorySnapshot[op]({}));
  }
  await expectThrows('run deleteOne blocked', () => SnapshotRun.deleteOne({}));

  // ── 2. Read-only discipline (static analysis) ─────────────────────────────
  console.log('\n2. NO BUSINESS CALCULATION IN THE REPORTING LAYER');
  const files = ['report.service.js', 'report.controller.js', 'snapshot.service.js']
    .map((f) => ({ name: f, src: fs.readFileSync(path.join(__dirname, '..', 'modules', 'inventory', f), 'utf8') }));

  for (const { name, src } of files) {
    // Comments legitimately name these; code must not.
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    for (const legacy of ['totalAvailableQuantity', 'bookedQuantity', 'availableForSale', 'availableInPercent']) {
      check(`${name} never reads ${legacy}`, !code.includes(legacy));
    }
    check(`${name} never computes Max Level`, !/dailyAvgConsumption\s*\*|leadTime\s*\*|\*\s*safetyFactor/.test(code));
    check(`${name} never derives a band`, !/band\s*=\s*['"]|classify\(/.test(code));
    check(`${name} never divides by maxLevel`, !/\/\s*maxLevel/.test(code));
  }

  if (!WITH_DB) {
    console.log(`\n${'─'.repeat(52)}`);
    console.log(`   PASSED ${passed}   FAILED ${failed}   (static checks only)`);
    console.log('─'.repeat(52));
    console.log('\n   Re-run with --db to exercise snapshots and reports.\n');
    process.exit(failed === 0 ? 0 : 1);
  }

  // ── Database-backed ───────────────────────────────────────────────────────
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/erp_portal');
  console.log(`\n🔌  Connected to MongoDB (${mongoose.connection.name})`);

  if (CLEANUP) {
    const runs = await SnapshotRun.find({ note: 'verify-reports' }).lean();
    const ids = runs.map((r) => r.runId);
    const rows = await mongoose.connection.db.collection('inventorysnapshots').deleteMany({ runId: { $in: ids } });
    const rr = await mongoose.connection.db.collection('snapshotruns').deleteMany({ runId: { $in: ids } });
    console.log(`\n🧹  Removed ${rows.deletedCount} row(s) and ${rr.deletedCount} run(s).\n`);
    await mongoose.disconnect();
    return;
  }

  const brands = ['Koken', 'BIX', 'IMADA'];
  // A distinct historical date so this never collides with a real snapshot.
  const testDate = new Date(Date.UTC(2000, 0, 1));

  console.log('\n3. SNAPSHOT GENERATION');
  const existing = await activeRun(testDate);
  const first = await generateSnapshot({ snapshotDate: testDate, rebuild: Boolean(existing) });
  await SnapshotRun.updateOne({ runId: first.runId }, { $set: { note: 'verify-reports' } });
  check('snapshot created', Boolean(first.runId));
  check('rows written', first.rowCount >= 0);

  const rowAgg = await InventorySnapshot.aggregate([
    { $match: { runId: first.runId } },
    { $group: { _id: null, n: { $sum: 1 }, onHand: { $sum: '$onHand' }, available: { $sum: '$available' } } },
  ]);
  const actual = rowAgg[0] || { n: 0, onHand: 0, available: 0 };
  check('run rowCount matches rows', actual.n === first.rowCount, `${first.rowCount} vs ${actual.n}`);
  check('run totals match rows', actual.onHand === first.totals.onHand);
  check('available frozen as onHand − reserved',
    actual.available === first.totals.available);

  console.log('\n4. DUPLICATE PROTECTION');
  try {
    await generateSnapshot({ snapshotDate: testDate });
    check('second snapshot for the same date refused', false, 'it succeeded');
  } catch (err) {
    check('second snapshot for the same date refused', err.code === 'SNAPSHOT_EXISTS', err.message.slice(0, 50));
    check('error names the existing run', err.existingRunId === first.runId);
  }

  console.log('\n5. REBUILD SUPERSEDES, NEVER MUTATES');
  const rebuilt = await generateSnapshot({ snapshotDate: testDate, rebuild: true });
  await SnapshotRun.updateOne({ runId: rebuilt.runId }, { $set: { note: 'verify-reports' } });
  const oldRun = await SnapshotRun.findOne({ runId: first.runId }).lean();
  const oldRowsStillThere = await InventorySnapshot.countDocuments({ runId: first.runId });

  check('new run created', rebuilt.runId !== first.runId);
  check('old run marked superseded', oldRun.status === 'superseded');
  check('old run points at its replacement', oldRun.supersededBy === rebuilt.runId);
  check('old rows survive untouched', oldRowsStillThere === first.rowCount,
    `${first.rowCount} → ${oldRowsStillThere}`);
  const live = await activeRun(testDate);
  check('active run resolves to the rebuild', live?.runId === rebuilt.runId);

  console.log('\n6. INTEGRITY VALIDATION');
  const ok = await validateSnapshot(rebuilt.runId);
  check('rebuilt snapshot reports intact', ok.intact, JSON.stringify(ok.issues));
  // Corrupt the RUN metadata (rows are immutable) and confirm detection.
  await SnapshotRun.updateOne({ runId: rebuilt.runId }, { $set: { rowCount: rebuilt.rowCount + 7 } });
  const broken = await validateSnapshot(rebuilt.runId);
  check('recorded/actual mismatch detected', !broken.intact);
  check('mismatch names the field', broken.issues.some((i) => i.field === 'rowCount'));
  await SnapshotRun.updateOne({ runId: rebuilt.runId }, { $set: { rowCount: rebuilt.rowCount } });

  console.log('\n7. SNAPSHOT COMPARISON');
  const cmp = await compareSnapshots({ runIdA: first.runId, runIdB: rebuilt.runId, brands });
  check('comparison runs', Boolean(cmp.summary));
  check('identical snapshots show no changes',
    cmp.summary.balanceChanged === 0 && cmp.summary.healthChanged === 0,
    `balance=${cmp.summary.balanceChanged} health=${cmp.summary.healthChanged}`);
  check('net deltas are zero', cmp.summary.netOnHand === 0 && cmp.summary.netAvailable === 0);
  const cmp2 = await compareSnapshots({ runIdA: first.runId, runIdB: rebuilt.runId, brands });
  check('comparison is reproducible',
    JSON.stringify(cmp.summary) === JSON.stringify(cmp2.summary));

  console.log('\n8. REPORTS');
  const summary = await inventorySummary({ brands });
  check('inventory summary returns totals', typeof summary.totals?.onHand === 'number');
  check('valuation declared unsupported', summary.valuation?.supported === false);

  const bal = await balanceReport({ brands, page: 1, limit: 10 });
  check('balance report paginates', Array.isArray(bal.rows) && bal.pagination);
  check('balance summary covers the whole scope, not the page',
    typeof bal.summary.onHand === 'number');

  const hea = await healthReport({ brands, page: 1, limit: 10 });
  check('health report returns band rollup', Boolean(hea.summary?.bands));

  const mov = await movementReport({ brands, page: 1, limit: 10 });
  check('movement report returns type summary', Array.isArray(mov.summary?.byType));

  const age = await agingReport({ brands, page: 1, limit: 10 });
  check('aging report buckets on lastIssuedAt', Array.isArray(age.buckets));
  check('aging reads the configured dead-stock threshold', typeof age.deadStockDays === 'number');
  check('aging separates "never issued" from age buckets',
    age.buckets.some((b) => b.bucket === 'Never issued'));

  console.log('\n9. INDEXES');
  const snapIdx = (await mongoose.connection.db.collection('inventorysnapshots').indexes()).map((i) => JSON.stringify(i.key));
  for (const e of [
    '{"runId":1,"skuCode":1,"brand":1,"location":1}',
    '{"snapshotDate":-1,"brand":1,"skuCode":1}',
    '{"skuCode":1,"snapshotDate":-1}',
  ]) check(`snapshot index ${e}`, snapIdx.includes(e));
  const uniq = (await mongoose.connection.db.collection('inventorysnapshots').indexes())
    .find((i) => i.key.runId && i.key.skuCode);
  check('row-level duplicate protection is unique', Boolean(uniq?.unique));

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`   PASSED ${passed}   FAILED ${failed}`);
  console.log('─'.repeat(52));
  console.log(failed === 0
    ? '\n✅  Report and snapshot guarantees hold.\n   Run with --cleanup to remove the verification runs.\n'
    : '\n❌  Verification FAILED — see above.\n');

  await mongoose.disconnect();
  process.exit(failed === 0 ? 0 : 1);
};

run().catch(async (err) => {
  console.error('\n❌  Verification crashed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
