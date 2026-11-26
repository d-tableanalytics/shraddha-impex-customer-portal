#!/usr/bin/env node
/**
 * Phase 5 — standing inventory monitor. READ-ONLY, always.
 *
 * The four defects behind this work were all invisible for months, and each
 * would have been caught in a day by a check that ran and said something. This
 * is that check. It answers, in one page:
 *
 *   1. Does any product violate the stock invariant?
 *   2. Is the ledger keeping up, or is the outbox backed up / stuck / failed?
 *   3. Are any movements MISSING — a stock mutation with no history?
 *   4. Are any movements DUPLICATED — the same event recorded twice?
 *   5. Are there open oversold exceptions nobody has resolved?
 *
 * Exit code is 0 when everything is clean and 1 when anything needs attention,
 * so it can be a cron line or a health probe without further wrapping.
 *
 * The seal makes read-only a property of the program, not a promise: every
 * mutating driver method throws before a connection is opened.
 *
 * USAGE
 *   npm run inventory:monitor
 *   node scripts/inventory-monitor.js --json status.json
 *   node scripts/inventory-monitor.js --quiet     only problems
 */

import fs from 'node:fs';
import process from 'node:process';
import mongoose from 'mongoose';
import { sealDatabase, resolveUri, makeArgs } from './lib/guard.js';
import { assess, currentValidation } from './lib/stockValidator.js';

const args = makeArgs();
const JSON_OUT = args.val('json');
const QUIET = args.has('quiet');
/** A pending row older than this is not "in flight", it is stuck. */
const STUCK_MS = Number(args.val('stuck-after')) || 120_000;

sealDatabase([]);

/** Order lines that moved stock but left no movement behind. */
export const missingMovements = async (db) => {
  const lines = await db.collection('orders').find(
    { $or: [{ confirmedQty: { $gt: 0 } }, { stockState: { $ne: null } }] },
    { projection: { orderId: 1, skuCode: 1, confirmedQty: 1, stockState: 1 } },
  ).toArray();

  const seen = new Set();
  for await (const m of db.collection('stockmovements').find(
    {}, { projection: { referenceId: 1, skuCode: 1, movementType: 1 } },
  )) {
    seen.add(`${m.referenceId}::${m.skuCode}::${m.movementType}`);
  }

  const out = [];
  for (const l of lines) {
    const want = [];
    if ((l.confirmedQty ?? 0) > 0) want.push('RESERVE');
    if (l.stockState === 'consumed') want.push('RELEASE', 'ISSUE');
    else if (l.stockState === 'released') want.push('RELEASE');
    const missing = want.filter((t) => !seen.has(`${l.orderId}::${l.skuCode}::${t}`));
    if (missing.length) out.push({ orderId: l.orderId, skuCode: l.skuCode, missing });
  }
  return out;
};

/**
 * Over-counted movements, using the SAME rule as the correction tool.
 *
 * Deliberately imported rather than reimplemented: two definitions of
 * "duplicate" would drift, and a monitor that disagrees with the tool meant
 * to act on it is worse than no monitor.
 */
export const duplicateMovements = async (db) => {
  const { findOverCounted } = await import('./lib/duplicateCore.js');
  return findOverCounted(db);
};
export const outboxHealth = async (db) => {
  const exists = (await db.listCollections({ name: 'stockoutboxes' }).toArray()).length > 0;
  if (!exists) return { exists: false, pending: 0, claimed: 0, failed: 0, stuck: 0, oldestPendingAt: null };

  const rows = await db.collection('stockoutboxes').aggregate([
    { $group: { _id: '$state', n: { $sum: 1 }, oldest: { $min: '$createdAt' } } },
  ]).toArray();
  const by = Object.fromEntries(rows.map((r) => [r._id, r]));
  const stuck = await db.collection('stockoutboxes').countDocuments({
    state: { $in: ['pending', 'claimed'] },
    createdAt: { $lte: new Date(Date.now() - STUCK_MS) },
  });
  return {
    exists: true,
    pending: by.pending?.n ?? 0,
    claimed: by.claimed?.n ?? 0,
    applied: by.applied?.n ?? 0,
    failed: by.failed?.n ?? 0,
    stuck,
    oldestPendingAt: by.pending?.oldest ?? null,
  };
};

export const collect = async (db) => {
  const [invariant, validation, outbox, missing, duplicates, oversold] = await Promise.all([
    assess(db, { limit: 20 }),
    currentValidation(db),
    outboxHealth(db),
    missingMovements(db),
    duplicateMovements(db),
    db.collection('oversoldexceptions').countDocuments({ status: 'Open' }).catch(() => 0),
  ]);
  return { invariant, validation, outbox, missing, duplicates, oversold, checkedAt: new Date().toISOString() };
};

const main = async () => {
  await mongoose.connect(resolveUri());
  const db = mongoose.connection.db;
  const s = await collect(db);

  const problems = [];
  if (s.invariant.failing > 0) problems.push(`${s.invariant.failing} product(s) violate the stock invariant`);
  if (s.outbox.failed > 0) problems.push(`${s.outbox.failed} outbox row(s) gave up after retrying`);
  if (s.outbox.stuck > 0) problems.push(`${s.outbox.stuck} outbox row(s) stuck for over ${STUCK_MS / 1000}s`);
  if (s.missing.length > 0) problems.push(`${s.missing.length} order line(s) have no ledger movement`);
  if (s.duplicates.length > 0) problems.push(`${s.duplicates.length} movement group(s) over-counted in the ledger`);
  if (s.oversold > 0) problems.push(`${s.oversold} open oversold exception(s) awaiting a decision`);

  if (!QUIET || problems.length) {
    console.log('='.repeat(72));
    console.log(`INVENTORY MONITOR — ${s.checkedAt}`);
    console.log('='.repeat(72));
    console.log(`  stock invariant   : ${s.invariant.passing}/${s.invariant.total} pass` +
      (s.invariant.failing ? `  ${s.invariant.failing} FAIL` : ''));
    console.log(`  validator         : ${s.validation.hasValidator ? `${s.validation.validationAction}/${s.validation.validationLevel}` : 'not enabled'}`);
    console.log(`  outbox            : ${s.outbox.exists
      ? `pending ${s.outbox.pending}, claimed ${s.outbox.claimed}, failed ${s.outbox.failed}, stuck ${s.outbox.stuck}`
      : 'collection does not exist (not deployed)'}`);
    console.log(`  missing movements : ${s.missing.length}`);
    console.log(`  over-counted groups: ${s.duplicates.length}`);
    console.log(`  open oversold     : ${s.oversold}`);

    if (s.invariant.failing) {
      console.log('\n  INVARIANT FAILURES:');
      for (const o of s.invariant.offenders) {
        console.log(`    ${String(o.skuCode ?? '-').padEnd(20)} total=${o.t} booked=${o.b} afs=${o.a}`);
      }
    }
    if (s.missing.length) {
      console.log('\n  MISSING MOVEMENTS (first 15) — run: npm run stock:backfill-plan');
      for (const m of s.missing.slice(0, 15)) {
        console.log(`    ${m.orderId}  ${String(m.skuCode).padEnd(16)} ${m.missing.join(', ')}`);
      }
      if (s.missing.length > 15) console.log(`    ... and ${s.missing.length - 15} more`);
    }
    if (s.duplicates.length) {
      console.log('\n  DUPLICATE MOVEMENTS — the same event recorded more than once:');
      for (const d of s.duplicates.slice(0, 15)) {
        console.log(`    ${d.referenceId}  ${String(d.skuCode).padEnd(16)} ${d.movementType} x${d.actual}` +
          `  expected ${d.expected}  surplus ${d.surplusCount} (${d.surplusQuantity} units)`);
      }
    }
    if (s.outbox.failed) console.log('\n  To retry parked rows: node scripts/outbox-status.js --requeue --dry-run');
  }

  console.log('');
  if (problems.length === 0) {
    console.log('  ALL CLEAR.');
  } else {
    console.log('  NEEDS ATTENTION:');
    for (const p of problems) console.log(`    - ${p}`);
  }

  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ ...s, problems }, null, 1));

  await mongoose.disconnect();
  process.exitCode = problems.length ? 1 : 0;
};

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('inventory-monitor.js');
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
