#!/usr/bin/env node
/**
 * Phase 3 — historical ledger backfill.
 *
 * 1,113 movements across 495 order lines were never recorded, because the old
 * dual-write dropped the posting whenever its 2-second timeout tripped the
 * circuit breaker. Phase 2 stopped new loss. This recovers the old loss.
 *
 * WHAT IT RECONSTRUCTS, AND FROM WHAT
 * -----------------------------------
 * Nothing is invented. Every movement is derived from an ORDER LINE — a
 * commitment document recording what was promised, when, and what happened to
 * it:
 *
 *     confirmedQty > 0          a RESERVE happened, dated at the booking
 *     stockState 'consumed'     a RELEASE and an ISSUE happened, at stockSettledAt
 *     stockState 'released'     a RELEASE happened, at stockSettledAt
 *
 * A line whose movement already exists is skipped, so a partial repair can be
 * resumed. A line with no date, or no resolvable brand, is REPORTED rather
 * than guessed at.
 *
 * WHAT IT DOES NOT TOUCH
 * ----------------------
 *   products        stock figures are Phase 4's question, not this one
 *   orders          the source of truth here; read only
 *   reservations, POs, indents, customer records, audit logs
 *
 * Writing history does not change what anyone can book. The seal enforces
 * that: even with --apply, only `stockmovements`, `stockbatches` and
 * `stockbalances` are writable.
 *
 * ORDERING. Movements are posted oldest-first by their real date, so the
 * reconstructed history reads in the order the events actually happened, and
 * a RESERVE always precedes the RELEASE that settled it.
 *
 * IDEMPOTENCY. Each movement's key is derived from the facts that identify it
 * — `backfill:<orderId>:<sku>:<movementType>` — so running twice produces one
 * movement. That is also what makes --rollback followed by a re-apply safe.
 *
 * SEQUENCING. Run this BEFORE Phase 4. Reconciliation compares the ledger
 * against the legacy figures, and comparing against a ledger known to be
 * missing 1,113 movements would classify healthy SKUs as broken.
 *
 * USAGE
 *   npm run stock:backfill-plan                      plan (default, read-only)
 *   node scripts/backfill-ledger.js --sku 14305M-19  one SKU
 *   node scripts/backfill-ledger.js --apply          post the movements
 *   node scripts/backfill-ledger.js --verify         confirm nothing is left
 *   node scripts/backfill-ledger.js --rollback <runId>
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import mongoose from 'mongoose';
import { sealDatabase, resolveUri, makeArgs } from './lib/guard.js';
import {
  BACKFILL_WORKFLOW, buildPlan, applyPlan, rebuildFor, rollbackRun, outboxBlockers,
} from './lib/backfillCore.js';
import { findOverCounted, correctOverCounted } from './lib/duplicateCore.js';

const args = makeArgs();
const APPLY = args.has('apply');
const VERIFY = args.has('verify');
const ROLLBACK = args.val('rollback');
const ONLY_SKU = args.val('sku');
const ONLY_ORDER = args.val('order');
const JSON_OUT = args.val('json');
const LIMIT = Number(args.val('limit')) || Infinity;
// Correct over-counted movements in the same run, so the rebuild that
// follows nets BOTH the missing and the surplus at once. Rebuilding for
// one and not the other would leave the projection wrong either way.
const FIX_DUPLICATES = args.has('fix-duplicates');

/** The ledger's own collections, and nothing else, even in apply mode. */
const WRITABLE = ['stockmovements', 'stockbatches', 'stockbalances'];
sealDatabase(APPLY || ROLLBACK ? WRITABLE : []);

// ─── CLI ─────────────────────────────────────────────────────────────────────
const main = async () => {
  const uri = resolveUri();
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const runId = args.val('run-id') || `BF-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;

  if (ROLLBACK) {
    console.log(`ROLLBACK of backfill run ${ROLLBACK}`);
    const res = await rollbackRun(db, ROLLBACK);
    console.log(`  movements removed : ${res.movements}`);
    console.log(`  batches removed   : ${res.batches}`);
    console.log(`  SKUs re-projected : ${res.skus.length}`);
    console.log('  No product, order, reservation, PO, indent or audit record was touched.');
    await mongoose.disconnect();
    return;
  }

  const { plan, ambiguous, compressed, linesExamined } = await buildPlan(db, { skuCode: ONLY_SKU, orderId: ONLY_ORDER });
  const overCounted = await findOverCounted(db, { skuCode: ONLY_SKU });

  if (VERIFY) {
    console.log('VERIFY — movements still missing after the backfill');
    console.log(`  order lines examined : ${linesExamined}`);
    console.log(`  still missing        : ${plan.length}`);
    console.log(`  ambiguous (expected) : ${ambiguous.length}`);
    console.log(plan.length === 0
      ? '\n  PASS — every reconstructable movement is now in the ledger.'
      : `\n  INCOMPLETE — ${plan.length} movement(s) remain. Re-run --apply.`);
    await mongoose.disconnect();
    process.exitCode = plan.length === 0 ? 0 : 1;
    return;
  }

  const byType = {};
  for (const p of plan) byType[p.movementType] = (byType[p.movementType] ?? 0) + 1;
  const skus = [...new Set(plan.map((p) => p.skuCode))];

  console.log('='.repeat(72));
  console.log(`LEDGER BACKFILL — ${APPLY ? `APPLY (run ${runId})` : 'PLAN ONLY (no writes possible)'}`);
  console.log('='.repeat(72));
  console.log(`  order lines examined          : ${linesExamined}`);
  console.log(`  movements that would be added : ${plan.length}`);
  for (const [t, n] of Object.entries(byType)) console.log(`      ${t.padEnd(10)} ${n}`);
  console.log(`  SKUs affected                 : ${skus.length}`);
  console.log(`  ambiguous — NOT planned       : ${ambiguous.length}`);
  console.log(`  over-counted groups           : ${overCounted.length}`    + (FIX_DUPLICATES ? ' (will be reversed)' : ' (use --fix-duplicates)'));
  console.log(`  net-reconstructed cycles      : ${compressed.length}`);
  for (const c of compressed.slice(0, 10)) {
    console.log(`      ${c.orderId}  ${String(c.skuCode).padEnd(16)} held stock ${c.cycles}x — net reconstructed`);
  }
  for (const g of overCounted.slice(0, 10)) {
    console.log(`      ${g.referenceId}  ${String(g.skuCode).padEnd(16)} ${g.movementType} x${g.actual},`
      + ` history accounts for ${g.expected} — ${g.surplusCount} surplus (${g.surplusQuantity} units)`);
  }

  for (const a of ambiguous.slice(0, 20)) {
    console.log(`      ${a.orderId}  ${String(a.skuCode).padEnd(16)} ${a.movementType.padEnd(8)} ${a.why}`);
  }

  if (!APPLY) {
    console.log('\n  FIRST 20 PLANNED:');
    for (const p of plan.slice(0, 20)) {
      console.log(`      ${p.orderId}  ${String(p.skuCode).padEnd(16)} ${p.movementType.padEnd(8)}` +
        ` ${String(p.quantity).padStart(5)} @ ${p.effectiveDate.toISOString().slice(0, 16)}`);
    }
    if (JSON_OUT) {
      fs.writeFileSync(JSON_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), runId, plan, ambiguous }, null, 1));
      console.log(`\n  Plan written to ${path.resolve(JSON_OUT)}`);
    }
    console.log('\n  NOTHING WAS WRITTEN. Re-run with --apply to post these movements.');
    await mongoose.disconnect();
    return;
  }

  const blockers = await outboxBlockers(db);
  if (blockers > 0) {
    console.error(`\n  REFUSING TO APPLY: ${blockers} outbox row(s) are still pending.`);
    console.error('  Those are movements that happened and have not reached the ledger yet.');
    console.error('  Wait for the drain (npm run outbox:status), then run this again.');
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  console.log(`\n  Posting ${Math.min(plan.length, LIMIT)} movement(s)...`);
  const { posted, failed } = await applyPlan(plan, {
    runId,
    limit: LIMIT,
    onProgress: (i, n) => console.log(`      ${i}/${n}`),
  });
  console.log(`  posted   : ${posted.length}${posted.filter((p) => p.replayed).length ? ` (${posted.filter((p) => p.replayed).length} already present)` : ''}`);
  console.log(`  failed   : ${failed.length}`);
  for (const f of failed.slice(0, 20)) console.log(`      ${f.orderId} ${f.skuCode} ${f.movementType}: ${f.error}`);

  let dupSkus = [];
  if (FIX_DUPLICATES && overCounted.length) {
    console.log(`
  Reversing ${overCounted.reduce((n, g) => n + g.surplusCount, 0)} surplus movement(s)...`);
    const dup = await correctOverCounted(overCounted, { runId });
    console.log(`  reversed : ${dup.reversed.length}`);
    console.log(`  failed   : ${dup.failed.length}`);
    for (const d of dup.failed.slice(0, 10)) console.log(`      ${d.transactionId}: ${d.error}`);
    dupSkus = dup.skus;
  }

  const touched = [...new Set([...posted.map((p) => p.skuCode), ...dupSkus])];
  console.log(`\n  Rebuilding the projection for ${touched.length} SKU(s)...`);
  const rb = await rebuildFor(touched, { db });
  if (rb.unsettled.length) {
    console.log(`  NOT SETTLED (still being booked while rebuilding): ${rb.unsettled.length}`);
    for (const sku of rb.unsettled.slice(0, 20)) console.log(`      ${sku}`);
    console.log('  Their projection is corrected by the next reconciliation.');
  }

  console.log(`\n  DONE. Run id ${runId} — keep it, it is what --rollback takes.`);
  console.log('  Product quantities were NOT changed. No order, reservation, PO,');
  console.log('  indent, customer record or audit log was modified.');
  console.log('  Next: node scripts/backfill-ledger.js --verify');

  await mongoose.disconnect();
};

// Only run the CLI when invoked directly, so the tests can import the pieces.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('backfill-ledger.js');
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
