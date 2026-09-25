/**
 * seed-role-baselines.js
 * -----------------------------------------------------------------------------
 * Give each built-in role row back the baseline keys it is missing.
 *
 *   node scripts/seed-role-baselines.js                  # DRY RUN — reports, writes nothing
 *   node scripts/seed-role-baselines.js --apply          # write the top-ups
 *   node scripts/seed-role-baselines.js --role Sales     # one role only (repeatable)
 *
 * roleResolver.js makes a role's database row the whole answer; the compiled-in
 * baseline (config/permissions.js) applies only to a role with no row. A row
 * seeded before a key joined its baseline therefore lacks that key - which is
 * how Sales lost VIEW_PRICING, and with it every price, the Total Amount card
 * and the priced picklist on the Sales Desk. See utils/roleBaseline.js.
 *
 * ONLY ADDS. Nothing a row already grants is removed.
 *
 * DRY RUN IS THE DEFAULT because the script cannot tell a key that was never
 * written from one a Super Admin deliberately unticked. Read the report; if a
 * role is listed that was narrowed on purpose, leave it out with --role.
 *
 * The running server mirrors roles in memory. After --apply, restart it, or save
 * any role in the permission matrix, which reloads the mirror.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { connectDatabase } = await import('../config/database.js');
const { default: Role } = await import('../models/Role.js');
const { SYSTEM_ROLE_NAMES, baselineFor } = await import('../config/permissions.js');
const { baselineTopUp } = await import('../utils/roleBaseline.js');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const only = args.flatMap((arg, i) => (arg === '--role' && args[i + 1] ? [args[i + 1]] : []));

const unknown = only.filter((name) => !SYSTEM_ROLE_NAMES.includes(name));
if (unknown.length) {
  console.error(`Not a built-in role: ${unknown.join(', ')}. Expected one of: ${SYSTEM_ROLE_NAMES.join(', ')}`);
  process.exit(1);
}

await connectDatabase();

console.log(apply ? '\nAPPLYING role baseline top-ups\n' : '\nDRY RUN — nothing will be written (pass --apply to write)\n');

let changedRoles = 0;
for (const name of only.length ? only : SYSTEM_ROLE_NAMES) {
  const role = await Role.findOne({ name }).lean();
  if (!role) {
    console.log(`  ${name.padEnd(18)} no row — the compiled-in baseline already applies`);
    continue;
  }

  const topUp = baselineTopUp(role, baselineFor(name));
  if (!topUp.changed) {
    console.log(`  ${name.padEnd(18)} complete`);
    continue;
  }

  changedRoles += 1;
  console.log(`  ${name.padEnd(18)} missing ${topUp.missing.length}: ${topUp.missing.join(', ')}`);
  if (apply) {
    await Role.updateOne(
      { _id: role._id },
      { $set: { grants: topUp.grants, permissions: topUp.permissions } },
    );
    console.log(`  ${''.padEnd(18)} restored`);
  }
}

console.log(`\n${changedRoles} role(s) ${apply ? 'updated' : 'would be updated'}.`);
if (apply && changedRoles) {
  console.log('Restart the server (or save any role in the permission matrix) so it reloads roles.');
}

await mongoose.disconnect();
