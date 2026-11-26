#!/usr/bin/env node
/**
 * Phase 5 — the stock invariant guard, as a command.
 *
 * Reports whether the data is ready for the rule and, with --set, turns it on
 * in stages. The rule itself and the staging argument live in
 * lib/stockValidator.js.
 *
 * WHY TWO STAGES. `warn` logs violations and allows the write; `error` refuses
 * it. Running in `warn` for a full business cycle surfaces any write path
 * nobody remembered — a cron, a script, an integration — without the first
 * discovery being a customer-facing failure.
 *
 * `--set error` is REFUSED while any document still fails, unless --force. The
 * order is: Phase 3, Phase 4, confirm zero failures, then warn, then error.
 *
 * USAGE
 *   npm run stock:validator-plan            assess + print the commands
 *   node scripts/plan-stock-validator.js --set warn
 *   node scripts/plan-stock-validator.js --set error
 *   node scripts/plan-stock-validator.js --set off
 */

import process from 'node:process';
import mongoose from 'mongoose';
import { sealDatabase, resolveUri, makeArgs } from './lib/guard.js';
import { collModCommand, assess, currentValidation, setValidation } from './lib/stockValidator.js';

const args = makeArgs();
const SET = args.val('set');
const FORCE = args.has('force');

// collMod is a database command, not a collection write, so the seal does not
// gate it — but nothing here writes a document either way, and the seal keeps
// it that way.
sealDatabase([]);

const main = async () => {
  await mongoose.connect(resolveUri());
  const db = mongoose.connection.db;

  const { total, passing, failing, offenders } = await assess(db);
  const current = await currentValidation(db);

  console.log('='.repeat(72));
  console.log('STOCK INVARIANT VALIDATOR');
  console.log('='.repeat(72));
  console.log(`  product documents        : ${total}`);
  console.log(`  satisfy the invariant    : ${passing}`);
  console.log(`  FAIL the invariant       : ${failing}`);
  console.log(`  currently enforced       : ${current.hasValidator ? `${current.validationAction} / ${current.validationLevel}` : 'no validator'}`);

  if (failing) {
    console.log('\n  These must be repaired by Phase 4 BEFORE enforcement:');
    for (const o of offenders) {
      console.log(`      ${String(o.skuCode ?? '(no skuCode)').padEnd(20)} ${String(o.brand ?? '-').padEnd(12)}` +
        ` total=${String(o.t).padStart(6)} booked=${String(o.b).padStart(6)} afs=${String(o.a).padStart(6)}`);
    }
    if (failing > offenders.length) console.log(`      ... and ${failing - offenders.length} more`);
  }

  if (SET) {
    console.log('');
    try {
      const after = await setValidation(db, SET, { force: FORCE });
      console.log(`  VALIDATION SET: ${after.validationAction} / ${after.validationLevel}`);
      if (SET === 'warn') {
        console.log('  Violations are now logged by MongoDB and allowed. Watch the server log');
        console.log('  for a full business cycle before moving to --set error.');
      } else if (SET === 'error') {
        console.log('  A write that would break the invariant is now REFUSED.');
      } else {
        console.log('  The validator has been removed.');
      }
    } catch (e) {
      console.error(`  REFUSED: ${e.message}`);
      process.exitCode = 1;
    }
    await mongoose.disconnect();
    return;
  }

  console.log('\n' + '-'.repeat(72));
  console.log(failing === 0 ? 'READY. Stage 1 — warn only:' : 'NOT READY. When the failures are repaired, stage 1 — warn only:');
  console.log('-'.repeat(72));
  console.log('  node scripts/plan-stock-validator.js --set warn');
  console.log(JSON.stringify(collModCommand('warn'), null, 1));

  console.log('\n' + '-'.repeat(72));
  console.log('Stage 2 — enforce, only after stage 1 has been quiet:');
  console.log('-'.repeat(72));
  console.log('  node scripts/plan-stock-validator.js --set error');

  console.log('\n' + '-'.repeat(72));
  console.log('Rollback — remove the validator:');
  console.log('-'.repeat(72));
  console.log('  node scripts/plan-stock-validator.js --set off');

  console.log('\nvalidationLevel "moderate" is deliberate: the rule applies to inserts and to');
  console.log('updates of documents that already satisfy it, leaving known-bad rows editable.');

  await mongoose.disconnect();
};

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('plan-stock-validator.js');
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
