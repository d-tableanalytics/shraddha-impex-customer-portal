/**
 * migrate-customer-moq.js
 * -----------------------------------------------------------------------------
 * Stamp every account with the MOQ configuration it is ALREADY living under.
 *
 *   node scripts/migrate-customer-moq.js           # DRY RUN — reports, writes nothing
 *   node scripts/migrate-customer-moq.js --apply   # write the backfill
 *
 * WHAT THIS IS, AND WHY IT IS NOT LOAD-BEARING
 *
 * `User.moqMode` and `User.moqValue` are new. Every account that exists today
 * has neither, and utils/moq.js reads such an account through `legacyMode()` —
 * precisely the rule it was living under before the fields existed. So the
 * system is correct whether or not this script is ever run, which is the
 * property the requirement "existing customers must retain their current MOQ
 * behaviour during migration" actually asks for.
 *
 * What the script buys is VISIBILITY. Until it runs, Customer Management shows
 * every account as "not configured" and the admin cannot tell an exempt
 * customer from one nobody has looked at. After it runs, the stored record says
 * what the behaviour already was.
 *
 * BY CONSTRUCTION IT CANNOT CHANGE ANYONE'S BEHAVIOUR. The mode written is the
 * one `legacyMode()` derives, and each account is re-checked after the write:
 * if `moqAppliesTo` or `effectiveMoq` moved for any of them, the script says so
 * loudly rather than reporting success.
 *
 * It SKIPS an account that already carries a mode — a configuration an admin
 * has set by hand is not something a backfill gets to overwrite.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { connectDatabase } = await import('../config/database.js');
const { default: User } = await import('../models/User.js');
const {
  MOQ_MODES, legacyMode, normaliseMoqMode, moqAppliesTo, effectiveMoq, isMsilCustomer,
} = await import('../utils/moq.js');

const apply = process.argv.slice(2).includes('--apply');

await connectDatabase();

console.log('Customer MOQ backfill');
console.log('=====================');
console.log(apply ? 'MODE: apply\n' : 'MODE: dry run (pass --apply to write)\n');

/**
 * A representative product for the behaviour check below.
 *
 * `effectiveMoq` is a function of the user AND a product, so proving it has not
 * moved needs a product to ask it about. The Multiple used is arbitrary and
 * deliberately awkward — what matters is that the same number comes back before
 * and after, not what the number is.
 */
const PROBE = { skuCode: 'PROBE', moq: 7 };

const accounts = await User.find({}, 'email role customerCategory moq moqMode moqValue').lean();

const counts = { applicable: 0, notApplicable: 0, alreadyConfigured: 0, unchanged: 0 };
const writes = [];
const drifted = [];

for (const account of accounts) {
  if (normaliseMoqMode(account.moqMode)) {
    counts.alreadyConfigured += 1;
    continue;
  }

  const mode = legacyMode(account);
  // The behaviour this account has RIGHT NOW, read before anything is decided.
  const was = { applies: moqAppliesTo(account), multiple: effectiveMoq(account, PROBE) };
  // The same questions asked of the account as it would be after the write.
  const after = { ...account, moqMode: mode };
  const now = { applies: moqAppliesTo(after), multiple: effectiveMoq(after, PROBE) };

  if (was.applies !== now.applies || was.multiple !== now.multiple) {
    drifted.push({ email: account.email, was, now });
    continue;
  }

  if (mode === MOQ_MODES.APPLICABLE) counts.applicable += 1;
  else counts.notApplicable += 1;

  writes.push({
    updateOne: {
      filter: { _id: account._id },
      // `moqValue` is NOT written. Null is already its meaning — "use each
      // product's own Multiple" — and that is what every legacy account does.
      update: { $set: { moqMode: mode } },
    },
  });
}

console.log(`  accounts read .................. ${accounts.length}`);
console.log(`  already configured (skipped) ... ${counts.alreadyConfigured}`);
console.log(`  → MOQ Applicable ............... ${counts.applicable}`);
console.log(`  → MOQ Not Applicable ........... ${counts.notApplicable}`);

const msilApplicable = accounts.filter((a) => isMsilCustomer(a) && legacyMode(a) === MOQ_MODES.APPLICABLE);
if (msilApplicable.length) {
  // Should be unreachable — legacyMode() exempts MSIL first — and is reported
  // rather than assumed away, because an assertion nobody checks is a comment.
  console.log(`\n  !! ${msilApplicable.length} MSIL account(s) derived as APPLICABLE. This is a bug in legacyMode().`);
}

if (drifted.length) {
  console.error(`\n  !! ${drifted.length} account(s) would CHANGE behaviour. Nothing has been written.`);
  for (const d of drifted.slice(0, 20)) {
    console.error(`     ${d.email}: applies ${d.was.applies} → ${d.now.applies}, multiple ${d.was.multiple} → ${d.now.multiple}`);
  }
  console.error('\n  The backfill is meant to be behaviour-neutral; this means legacyMode() and');
  console.error('  moqModeOf() disagree. Fix utils/moq.js rather than forcing this through.');
  await mongoose.disconnect();
  process.exit(1);
}

if (!writes.length) {
  console.log('\nNothing to backfill.');
} else if (!apply) {
  console.log(`\n${writes.length} account(s) would be stamped. Re-run with --apply to write.`);
} else {
  const result = await User.bulkWrite(writes);
  console.log(`\n${result.modifiedCount} account(s) stamped.`);
}

await mongoose.disconnect();
