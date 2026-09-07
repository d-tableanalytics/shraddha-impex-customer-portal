/**
 * Asserts that no sensitive value is sitting in plaintext inside any
 * `customFieldValues` blob (AD-10 / AD-11).
 *
 *   node scripts/hrms/verify-no-plaintext-sensitive.js
 *
 * ---------------------------------------------------------------------------
 * This is a STANDING guard, not a one-off migration check
 * ---------------------------------------------------------------------------
 * The sanitiser closes the API and import paths, but `CustomFieldDefinition`
 * lets an administrator create a field called "PAN" at any time and start
 * collecting exactly what AD-10 removed. Run this on a schedule, not once.
 *
 * It also cannot un-write history: if a plaintext value ever DID reach a write,
 * deleting it now removes it from the current document and not from the oplog,
 * the replicas, or any backup taken in between. That is why the sanitiser runs
 * in memory before the first write, and why this script exists to prove it kept
 * working.
 *
 * Read-only. Reports the field and document id; never prints the value.
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';

import { connectDatabase } from '../../config/database.js';
import { reservedFieldFor } from '../../shared/security/sensitive-fields.js';

dotenv.config();

/**
 * Collections that carry a `customFieldValues` blob. Employee arrives in
 * Phase 1; the list is read from the live database so a new one cannot be
 * added without this script noticing.
 */
const findCandidateCollections = async () => {
  const collections = await mongoose.connection.db.listCollections().toArray();
  const named = [];
  for (const { name } of collections) {
    const hit = await mongoose.connection.db
      .collection(name)
      .findOne({ customFieldValues: { $exists: true, $ne: null } });
    if (hit) named.push(name);
  }
  return named;
};

const run = async () => {
  await connectDatabase();

  const collections = await findCandidateCollections();
  if (collections.length === 0) {
    console.log('No collection currently stores customFieldValues. Nothing to check.');
    await mongoose.disconnect();
    process.exit(0);
  }

  let violations = 0;

  for (const name of collections) {
    const cursor = mongoose.connection.db
      .collection(name)
      .find({ customFieldValues: { $exists: true, $ne: null } })
      .project({ customFieldValues: 1 });

    let scanned = 0;
    for await (const doc of cursor) {
      scanned += 1;
      for (const key of Object.keys(doc.customFieldValues ?? {})) {
        const reserved = reservedFieldFor(key);
        if (!reserved) continue;
        violations += 1;
        console.error(
          `  ✖ ${name}/${doc._id}: custom field "${key}" holds a ${reserved} value in plaintext`,
        );
      }
    }
    console.log(`Scanned ${scanned} document(s) in "${name}".`);
  }

  console.log('');
  if (violations === 0) {
    console.log('✅ No sensitive value found in any customFieldValues blob.');
  } else {
    console.error(`❌ ${violations} plaintext sensitive value(s) found.`);
    console.error('   Move each into its encrypted field and remove it from the blob.');
    console.error('   Note: deleting them now does NOT remove them from the oplog or from');
    console.error('   existing backups. Treat those values as exposed.');
  }

  await mongoose.disconnect();
  process.exit(violations === 0 ? 0 : 1);
};

run().catch(async (err) => {
  console.error('[verify-no-plaintext-sensitive] failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(2);
});
