#!/usr/bin/env node
/**
 * Phase 4 — inventory reconciliation.
 *
 * Reports where the four stock sources disagree, what the correct figure
 * appears to be, and which records a person must look at. With --apply it
 * corrects the mechanically-decidable ones and nothing else.
 *
 * The decisions live in lib/reconcileCore.js — see that file for why neither
 * the legacy fields nor the ledger is assumed correct, and why a customer
 * commitment is never treated as a figure to be fixed.
 *
 * WHAT AN APPLY RUN CAN AND CANNOT TOUCH
 * --------------------------------------
 * Writable: `products` (stock fields only), `stockmovements`, `stockbatches`,
 * `stockbalances`. Everything else stays sealed — orders, reservations, POs,
 * indents, customers and audit logs cannot be reached even by a bug in this
 * file. No booking is fulfilled, cancelled, reduced or reallocated, and no
 * customer mail is sent.
 *
 * EXCLUDED BY DEFAULT
 *   116 physically-ambiguous SKUs   until a client count arrives (--import-counts)
 *   20 malformed documents          quarantined, never touched
 *   genuinely-oversold SKUs         a person decides; an exception is raised
 *
 * SEQUENCING. Run Phase 3 (backfill) first. Reconciling against a ledger known
 * to be missing movements classifies healthy SKUs as broken.
 *
 * USAGE
 *   npm run stock:reconcile                               dry run (default)
 *   node scripts/reconcile-stock.js --json out.json --csv out.csv
 *   node scripts/reconcile-stock.js --import-counts counts.xlsx      validate + dry run
 *   node scripts/reconcile-stock.js --apply --approved-from corrections.xlsx
 *   node scripts/reconcile-stock.js --apply --skus 14305M-19,10099A
 *   node scripts/reconcile-stock.js --rollback b.json
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import mongoose from 'mongoose';
import { sealDatabase, resolveUri, makeArgs } from './lib/guard.js';
import {
  CLASS, DESCRIPTION, classifyAll, correctable, applyCorrection, recordCorrection,
  readVerifiedCounts, readApprovals, takeBackup, restoreBackup,
} from './lib/reconcileCore.js';

const args = makeArgs();
const APPLY = args.has('apply');
const ROLLBACK = args.val('rollback');
const IMPORT_COUNTS = args.val('import-counts');
const JSON_OUT = args.val('json');
const CSV_OUT = args.val('csv');
const BACKUP_OUT = args.val('backup');
const ONLY_SKU = args.val('sku');
const ONLY_BRAND = args.val('brand');
const MAX_DELTA = Number(args.val('max-delta')) || Infinity;
// An apply run must be told WHICH SKUs were approved. See readApprovals().
const APPROVED_FROM = args.val('approved-from');
const ONLY_SKUS = (args.val('skus') || '').split(',').map((x) => x.trim()).filter(Boolean);
const VERBOSE = args.has('verbose');

const WRITABLE = ['products', 'stockmovements', 'stockbatches', 'stockbalances'];
sealDatabase(APPLY || ROLLBACK ? WRITABLE : []);

// ─── CLI ─────────────────────────────────────────────────────────────────────
const main = async () => {
  await mongoose.connect(resolveUri());
  const db = mongoose.connection.db;
  const runId = args.val('run-id') || `RC-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;

  if (ROLLBACK) {
    const backup = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    console.log(`ROLLBACK of reconciliation ${backup.runId} (${backup.rows.length} SKU(s))`);
    const res = await restoreBackup(db, backup);
    console.log(`  restored : ${res.restored.length}`);
    console.log(`  skipped  : ${res.skipped.length}  (changed since — legitimate activity is preserved)`);
    for (const s of res.skipped.slice(0, 20)) console.log(`      ${s.sku}: ${s.why}`);
    console.log('  No order, reservation, PO, indent, customer record or audit log was touched.');
    await mongoose.disconnect();
    return;
  }

  let verifiedCounts = new Map();
  if (IMPORT_COUNTS) {
    const { counts, rejected, blank } = await readVerifiedCounts(IMPORT_COUNTS, db);
    console.log('VERIFIED PHYSICAL COUNTS');
    console.log(`  accepted  : ${counts.size}`);
    console.log(`  blank     : ${blank.length}  (not yet counted — left ambiguous)`);
    console.log(`  REJECTED  : ${rejected.length}`);
    for (const r of rejected.slice(0, 25)) console.log(`      row ${r.row}  ${r.sku}: ${r.why}`);
    if (rejected.length) {
      console.error('\n  REFUSING TO CONTINUE: fix the rejected rows and re-run.');
      console.error('  A count that cannot be read is not a count.');
      await mongoose.disconnect();
      process.exitCode = 1;
      return;
    }
    verifiedCounts = counts;
    console.log('');
  }

  const results = await classifyAll(db, { verifiedCounts, skuCode: ONLY_SKU, brand: ONLY_BRAND });
  const fixable = correctable(results).filter((r) => Math.abs(r.deltas.afs) <= MAX_DELTA);
  const tooBig = correctable(results).filter((r) => Math.abs(r.deltas.afs) > MAX_DELTA);

  report(results, fixable, tooBig, runId, APPLY);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), runId, results }, null, 1));
    console.log(`\nJSON: ${path.resolve(JSON_OUT)}`);
  }
  if (CSV_OUT) {
    const head = 'sku,brand,classification,before_total,before_booked,before_afs,ledger_onHand,ledger_reserved,register_committed,verified_count,proposed_total,proposed_booked,proposed_afs,oversold_by,open_indents\n';
    fs.writeFileSync(CSV_OUT, head + results.map((r) => [
      r.sku, r.brand, r.classification,
      r.before?.total ?? '', r.before?.booked ?? '', r.before?.afs ?? '',
      r.ledger.onHand, r.ledger.reserved, r.register.committed, r.verifiedCount ?? '',
      r.proposed?.total ?? '', r.proposed?.booked ?? '', r.proposed?.afs ?? '',
      r.proposed?.oversoldBy ?? '', r.openIndents.length,
    ].join(',')).join('\n') + '\n');
    console.log(`CSV:  ${path.resolve(CSV_OUT)}`);
  }

  if (!APPLY) {
    console.log('\n' + '='.repeat(72));
    console.log('DRY RUN — nothing was written. No product, order, reservation, PO,');
    console.log('indent, customer record or audit log was modified.');
    console.log('='.repeat(72));
    await mongoose.disconnect();
    return;
  }

  // ── Apply ────────────────────────────────────────────────────────────────
  //
  // NOTHING IS CORRECTED WITHOUT A NAMED APPROVAL. Every change here alters a
  // figure a customer can see, so "apply what the script worked out" is not a
  // decision the script may take on its own.
  let approvedSet = null;
  if (APPROVED_FROM) {
    const { approved, rejected, undecided } = await readApprovals(APPROVED_FROM);
    console.log(`\nAPPROVALS from ${path.basename(APPROVED_FROM)}`);
    console.log(`  approved  : ${approved.size}`);
    console.log(`  rejected  : ${rejected.length}`);
    console.log(`  undecided : ${undecided.length}  (treated as NOT approved)`);
    for (const u of undecided.slice(0, 20)) console.log(`      ${u.sku}: "${u.value}"`);
    approvedSet = approved;
  } else if (ONLY_SKUS.length) {
    approvedSet = new Set(ONLY_SKUS);
    console.log(`\nAPPROVALS given on the command line: ${ONLY_SKUS.join(", ")}`);
  } else {
    console.error("\n  REFUSING TO APPLY: no approvals were given.");
    console.error("  Pass --approved-from <workbook.xlsx> (the Approved? column), or");
    console.error("  --skus SKU-A,SKU-B to name them explicitly.");
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  const toApply = fixable.filter((r) => approvedSet.has(r.sku));
  const notApproved = fixable.filter((r) => !approvedSet.has(r.sku));
  const unknown = [...approvedSet].filter((sku) => !fixable.some((r) => r.sku === sku));

  console.log(`\n  correctable          : ${fixable.length}`);
  console.log(`  APPROVED, will apply : ${toApply.length}`);
  console.log(`  not approved, skipped: ${notApproved.length}`);
  for (const r of notApproved.slice(0, 20)) console.log(`      ${r.sku}`);
  if (unknown.length) {
    console.log(`  approved but NOT correctable (ignored): ${unknown.length}`);
    for (const sku of unknown.slice(0, 20)) console.log(`      ${sku}`);
  }
  if (toApply.length === 0) {
    console.log("\n  Nothing approved to apply. No write was made.");
    await mongoose.disconnect();
    return;
  }

  const backup = takeBackup(toApply, runId);
  const backupPath = BACKUP_OUT || path.join(process.cwd(), 'backups', `reconcile-${runId}.json`);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 1));
  console.log(`\nBackup written BEFORE any change: ${path.resolve(backupPath)}`);

  const applied = [];
  const skipped = [];
  for (const row of toApply) {
    const res = await applyCorrection(db, row, { runId });
    if (!res.ok) { skipped.push({ sku: row.sku, why: res.skipped }); continue; }
    try {
      await recordCorrection(row, { runId });
    } catch (e) {
      console.warn(`  [${row.sku}] corrected, but the ledger entry failed: ${e.message}`);
    }
    applied.push(row.sku);
  }

  console.log(`\nAPPLIED  : ${applied.length}`);
  console.log(`SKIPPED  : ${skipped.length}  (changed under us — never overwritten)`);
  for (const s of skipped.slice(0, 20)) console.log(`    ${s.sku}: ${s.why}`);

  if (applied.length) {
    const { rebuildBalances } = await import('../modules/inventory/balance.service.js');
    for (const sku of applied) await rebuildBalances({ skuCode: sku });
    console.log(`Projection rebuilt for ${applied.length} SKU(s).`);
  }

  console.log(`\nRun id ${runId}. To undo:`);
  console.log(`  node scripts/reconcile-stock.js --rollback ${path.resolve(backupPath)}`);
  console.log('No booking, reservation, PO or indent was modified; no mail was sent.');

  await mongoose.disconnect();
};

const report = (results, fixable, tooBig, runId, apply) => {
  const by = (c) => results.filter((r) => r.classification === c);
  console.log('='.repeat(72));
  console.log(`STOCK RECONCILIATION — ${apply ? `APPLY (run ${runId})` : 'DRY RUN'}`);
  console.log('='.repeat(72));
  console.log(`SKUs audited: ${results.length}`);
  for (const c of Object.values(CLASS)) {
    const n = by(c).length;
    if (n) console.log(`  ${String(n).padStart(5)}  ${c.padEnd(20)} ${DESCRIPTION[c]}`);
  }

  console.log('');
  console.log(`  would be corrected          : ${fixable.length}`);
  console.log(`  held back by --max-delta    : ${tooBig.length}`);
  console.log(`  excluded, needs a count     : ${by(CLASS.PHYSICAL_AMBIGUOUS).length}`);
  console.log(`  excluded, oversold          : ${by(CLASS.GENUINELY_OVERSOLD).length}`);
  console.log(`  excluded, malformed         : ${by(CLASS.MALFORMED).length}`);
  console.log(`  verified counts applied     : ${results.filter((r) => r.verifiedCount !== null).length}`);

  if (fixable.length) {
    console.log('\nCORRECTIONS (before -> after):');
    console.log('  SKU               brand    | T/B/A before     -> T/B/A after       | why');
    for (const r of fixable.slice(0, 40)) {
      const b = `${r.before.total}/${r.before.booked}/${r.before.afs}`;
      const a = `${r.proposed.total}/${r.proposed.booked}/${r.proposed.afs}`;
      console.log(`  ${String(r.sku).padEnd(17)} ${String(r.brand).padEnd(8)} | ${b.padEnd(16)} -> ${a.padEnd(16)} | ${r.classification}`);
    }
    if (fixable.length > 40) console.log(`  ... and ${fixable.length - 40} more`);
  }

  const oversold = by(CLASS.GENUINELY_OVERSOLD);
  if (oversold.length) {
    console.log('\nGENUINELY OVERSOLD — commitments exceed stock. NO booking is altered:');
    for (const r of oversold.slice(0, 25)) {
      console.log(`  ${String(r.sku).padEnd(17)} physical ${r.proposed.total}, committed ${r.register.committed}` +
        ` (short by ${r.proposed.oversoldBy}) — ${r.register.lines.map((l) => l.orderId).join(', ')}`);
    }
  }

  const unblocked = results.filter((r) => r.indentsUnblocked.length);
  console.log('\nPENDING INDENTS — REPORTED ONLY, NEVER MODIFIED:');
  console.log(`  open indents: ${results.reduce((n, r) => n + r.openIndents.length, 0)}`);
  console.log(`  would become fulfillable: ${unblocked.reduce((n, r) => n + r.indentsUnblocked.length, 0)}`);
  for (const r of unblocked) {
    for (const i of r.indentsUnblocked) {
      console.log(`    ${i.indentNumber}  ${String(r.sku).padEnd(16)} qty ${i.quantity} | available ${r.before.afs} -> ${r.proposed.afs}`);
    }
  }

  if (VERBOSE) {
    console.log('\nPER-SKU DETAIL:');
    for (const r of results.filter((x) => x.classification !== CLASS.CLEAN)) {
      console.log(`\n  ${r.sku} (${r.brand}) — ${r.classification}`);
      console.log(`    legacy     total=${r.before?.total} booked=${r.before?.booked} afs=${r.before?.afs}`);
      console.log(`    ledger     onHand=${r.ledger.onHand} reserved=${r.ledger.reserved}`);
      console.log(`    register   committed=${r.register.committed}`);
      if (r.verifiedCount !== null) console.log(`    VERIFIED   ${r.verifiedCount} (client count)`);
      console.log(r.proposed ? `    proposed   total=${r.proposed.total} booked=${r.proposed.booked} afs=${r.proposed.afs}`
        : '    proposed   none — the physical figure is not established');
    }
  }
};

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('reconcile-stock.js');
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
