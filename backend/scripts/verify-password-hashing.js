/**
 * Reports how many accounts are still on the legacy plaintext password scheme.
 *
 *   node scripts/verify-password-hashing.js
 *
 * `utils/password.js` accepts a plaintext match and upgrades it to bcrypt on the
 * next successful sign-in, so this number falls on its own as people log in.
 * The fallback can be removed once this reports zero — with evidence, rather
 * than by guessing that everyone has been back.
 *
 * Read-only. It never prints a password, only counts and email addresses.
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';

import { connectDatabase } from '../config/database.js';
import User from '../models/User.js';
import ArchivedUser from '../models/ArchivedUser.js';
import { isHashed } from '../utils/password.js';

dotenv.config();

const summarise = async (Model, label) => {
  /**
   * `+password` alone, not mixed with plain inclusions.
   *
   * `password` is `select: false`, and combining `+password` with bare field
   * names in one string makes Mongoose build an INCLUSION projection from the
   * bare names - which drops `password` again. Every account then reads as
   * unhashed, and this script reported 28 legacy accounts on a database that
   * had 15 hashed ones. The other fields come back by default anyway.
   */
  const docs = await Model.find({}).select('+password').lean();
  const legacy = docs.filter((d) => !isHashed(d.password));
  const hashed = docs.length - legacy.length;

  console.log(`\n${label}`);
  console.log(`  total   : ${docs.length}`);
  console.log(`  hashed  : ${hashed}`);
  console.log(`  legacy  : ${legacy.length}`);

  if (legacy.length > 0) {
    console.log('\n  Accounts still on the legacy scheme (upgrade on next sign-in):');
    for (const d of legacy.slice(0, 50)) {
      const seen = d.lastLogin ? new Date(d.lastLogin).toISOString().slice(0, 10) : 'never';
      console.log(`    - ${d.email}  (last sign-in: ${seen})`);
    }
    if (legacy.length > 50) console.log(`    ... and ${legacy.length - 50} more`);
  }

  return legacy.length;
};

const run = async () => {
  await connectDatabase();

  const remaining =
    (await summarise(User, 'Active accounts')) +
    (await summarise(ArchivedUser, 'Archived (suspended) accounts'));

  console.log('');
  if (remaining === 0) {
    console.log('✅ Every stored password is a bcrypt hash.');
    console.log('   The plaintext fallback in utils/password.js can now be removed.');
  } else {
    console.log(`⚠️  ${remaining} account(s) still hold a plaintext password.`);
    console.log('   Each upgrades automatically the next time its owner signs in.');
  }

  await mongoose.disconnect();
  process.exit(remaining === 0 ? 0 : 1);
};

run().catch(async (err) => {
  console.error('[verify-password-hashing] failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(2);
});
