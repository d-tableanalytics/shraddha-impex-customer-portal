/**
 * Removes every blocklisted address (see utils/mailRecipients.js) from the
 * `bookingCcEmails` of existing user records.
 *
 * The code-level blocklist stops these addresses being mailed, but leaving them
 * in the database means they keep showing up in the admin UI and in exports.
 * This clears them out for good.
 *
 * Usage:  node scripts/purge-blocked-emails.js [--dry-run]
 */
import mongoose from 'mongoose';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import User from '../models/User.js';
import { BLOCKED_RECIPIENTS, isBlockedRecipient } from '../utils/mailRecipients.js';

const dryRun = process.argv.includes('--dry-run');

const run = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(process.env.MONGODB_URI);

  console.log(`Blocked addresses: ${[...BLOCKED_RECIPIENTS].join(', ')}\n`);

  const users = await User.find({ bookingCcEmails: { $exists: true, $ne: [] } })
    .select('email bookingCcEmails');

  let changed = 0;
  for (const user of users) {
    const kept = user.bookingCcEmails.filter((a) => !isBlockedRecipient(a));
    if (kept.length === user.bookingCcEmails.length) continue;

    const removed = user.bookingCcEmails.filter(isBlockedRecipient);
    console.log(`${user.email}: removing ${removed.join(', ')}`);
    changed++;

    if (!dryRun) {
      user.bookingCcEmails = kept;
      await user.save();
    }
  }

  console.log(
    changed === 0
      ? '\nNo user records carried a blocked address.'
      : `\n${dryRun ? 'Would update' : 'Updated'} ${changed} user record(s).`,
  );

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
