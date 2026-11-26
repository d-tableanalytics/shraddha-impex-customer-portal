#!/usr/bin/env node
/**
 * Outbox health and failed-row recovery.
 *
 * Two jobs, deliberately in one place: the question "is the ledger keeping up?"
 * and the action "retry the ones that gave up" are asked by the same person at
 * the same moment, and splitting them across two tools makes it easy to look at
 * one and forget the other.
 *
 * READ-ONLY BY DEFAULT. With no flags it reports and writes nothing — every
 * mutating driver method is replaced with a thrower before a connection is
 * opened, exactly as the other report scripts do. `--requeue` lifts that seal
 * for ONE narrowly scoped operation: moving `failed` rows in `stockoutbox`
 * back to `pending`.
 *
 * WHAT --requeue CAN AND CANNOT TOUCH
 * -----------------------------------
 * It writes to `stockoutbox` and nothing else. It cannot alter a product,
 * order, reservation, PO, indent, customer or audit record — those collections
 * stay sealed even with the flag. A requeued row is re-posted by the worker,
 * and the idempotency key means a row that in fact succeeded before being
 * parked is a no-op on retry. So requeueing is safe even when you are not sure
 * whether the original attempt landed.
 *
 * WHY ROWS GIVE UP AT ALL. After 12 attempts a row is parked as `failed`
 * rather than retried forever, so a permanently bad row (a movement type the
 * ledger refuses, a brand that no longer exists) cannot occupy the worker
 * indefinitely. Parked is not discarded: the row keeps its payload and its
 * last error, and this is how it comes back once the cause is fixed.
 *
 * USAGE
 *   node scripts/outbox-status.js                     report (read-only)
 *   node scripts/outbox-status.js --failed            list the parked rows in full
 *   node scripts/outbox-status.js --requeue --dry-run what --requeue would do
 *   node scripts/outbox-status.js --requeue           park -> pending (writes stockoutbox only)
 *   node scripts/outbox-status.js --requeue --sku 14305M-19
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { MongoClient, Collection } from 'mongodb';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const val = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : null;
};
const REQUEUE = has('requeue');
const DRY_RUN = has('dry-run');
const SHOW_FAILED = has('failed');
const ONLY_SKU = val('sku');

/**
 * The seal. `stockoutbox` is exempt only when --requeue was asked for and
 * --dry-run was not; everything else is sealed unconditionally, so a mistake
 * in this file cannot reach a business record.
 */
const WRITE_METHODS = [
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne',
  'deleteOne', 'deleteMany', 'bulkWrite', 'findOneAndUpdate', 'findOneAndDelete',
  'findOneAndReplace', 'drop', 'rename', 'createIndex', 'createIndexes',
  'dropIndex', 'dropIndexes', 'initializeOrderedBulkOp', 'initializeUnorderedBulkOp',
];
const WRITABLE = REQUEUE && !DRY_RUN ? new Set(['stockoutboxes']) : new Set();
for (const m of WRITE_METHODS) {
  const original = Collection.prototype[m];
  Collection.prototype[m] = function sealed(...args) {
    if (WRITABLE.has(this?.collectionName) && m === 'updateMany') {
      return original.apply(this, args);
    }
    throw new Error(
      `outbox-status.js refused Collection.${m}() on "${this?.collectionName ?? 'unknown'}". ` +
      'This tool reports; the only write it can make is requeueing failed rows in stockoutbox.',
    );
  };
}

const uri = fs.readFileSync(path.join(HERE, '..', '.env'), 'utf8').match(/MONGODB_URI\s*=\s*(\S+)/)[1];

const ago = (d) => {
  if (!d) return '-';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

const main = async () => {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const outbox = db.collection('stockoutboxes');

  const exists = (await db.listCollections({ name: 'stockoutboxes' }).toArray()).length > 0;
  if (!exists) {
    console.log('stockoutboxes does not exist yet — the outbox has never been written to.');
    console.log('Before deployment this is the expected answer.');
    await client.close();
    return;
  }

  const states = await outbox.aggregate([
    { $group: { _id: '$state', n: { $sum: 1 }, oldest: { $min: '$createdAt' } } },
  ]).toArray();
  const by = Object.fromEntries(states.map((s) => [s._id, s]));

  console.log('='.repeat(72));
  console.log('STOCK LEDGER OUTBOX');
  console.log('='.repeat(72));
  for (const state of ['pending', 'claimed', 'applied', 'failed']) {
    const row = by[state];
    console.log(`  ${state.padEnd(9)} ${String(row?.n ?? 0).padStart(7)}` +
      (row?.oldest ? `    oldest ${ago(row.oldest)}` : ''));
  }

  const backlog = (by.pending?.n ?? 0) + (by.claimed?.n ?? 0);
  const oldestPending = by.pending?.oldest ?? null;
  console.log('');
  if (backlog === 0) console.log('  VERDICT: the ledger is up to date.');
  else if (oldestPending && Date.now() - new Date(oldestPending).getTime() < 120_000) {
    console.log(`  VERDICT: ${backlog} row(s) in flight — normal, the drain runs every 15s.`);
  } else {
    console.log(`  VERDICT: ${backlog} row(s) waiting, oldest ${ago(oldestPending)}.`);
    console.log('  The drain is behind or not running. Check: pm2 logs shraddha-backend | grep Outbox');
  }

  const failedFilter = { state: 'failed', ...(ONLY_SKU ? { 'payload.skuCode': ONLY_SKU } : {}) };
  const failed = await outbox.find(failedFilter).sort({ createdAt: 1 }).toArray();

  if (failed.length) {
    console.log('');
    console.log('-'.repeat(72));
    console.log(`PARKED ROWS (${failed.length}) — the ledger is behind for these movements.`);
    console.log('The STOCK FIGURES for them are correct; only the history is missing.');
    console.log('-'.repeat(72));
    const limit = SHOW_FAILED ? failed.length : Math.min(failed.length, 15);
    for (const r of failed.slice(0, limit)) {
      const types = r.payload.movements.map((m) => `${m.movementType}:${m.quantity}`).join(' ');
      console.log(`  ${String(r.payload.skuCode).padEnd(16)} ${String(r.payload.referenceId ?? '-').padEnd(18)}` +
        ` ${types.padEnd(28)} attempts=${r.attempts}`);
      console.log(`      ${ago(r.createdAt)} — ${String(r.lastError ?? 'no error recorded').slice(0, 110)}`);
    }
    if (limit < failed.length) console.log(`  ... and ${failed.length - limit} more (--failed to list all)`);
  }

  if (REQUEUE) {
    console.log('');
    console.log('-'.repeat(72));
    if (!failed.length) {
      console.log('REQUEUE: nothing is parked. No action taken.');
    } else if (DRY_RUN) {
      console.log(`REQUEUE (dry run): ${failed.length} row(s) would move failed -> pending.`);
      console.log('No write was made. Re-run without --dry-run to apply.');
    } else {
      const res = await outbox.updateMany(failedFilter, {
        $set: { state: 'pending', nextAttemptAt: new Date(), attempts: 0, claimedBy: null, claimedAt: null },
      });
      console.log(`REQUEUE: ${res.modifiedCount} row(s) moved failed -> pending.`);
      console.log('The worker will retry them within one drain interval. Re-posting a movement');
      console.log('that already landed is a no-op — the idempotency key makes it safe.');
      console.log('No product, order, reservation, PO, indent or audit record was touched.');
    }
  } else if (failed.length) {
    console.log('');
    console.log('To retry them:  node scripts/outbox-status.js --requeue --dry-run');
  }

  await client.close();
};

main().catch((e) => { console.error(e); process.exit(1); });
