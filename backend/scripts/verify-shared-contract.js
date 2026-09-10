/**
 * Drift detector for the files the two portals MUST agree on.
 *
 *   node scripts/verify-shared-contract.js            # check
 *   node scripts/verify-shared-contract.js --update   # re-record the manifest
 *
 * Runs with NO database and no network. That is the point: it answers a
 * question about source files, and it has to answer it in CI, on a laptop, and
 * in a repository that has never been able to see the other one.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * The Customer Portal and the Employee Portal are separate repositories sharing
 * ONE database — one `users` collection, one `roles` collection. A handful of
 * files decide how the documents in those collections are INTERPRETED:
 *
 *   config/permissions.js      the permission vocabulary and the role baseline
 *   config/moduleRegistry.js   the matrix cells a Role.grants row compiles to
 *   utils/roleResolver.js      how a User + Role becomes a permission set
 *   utils/hrmsRoleGuard.js     the fence stopping a portal-only role holding
 *                              an hrms_* key
 *   shared/permissions/*       the HRMS matrix and its evaluator
 *
 * If one repository's copy drifts, the two do not merely disagree — one of them
 * silently DESTROYS the other's data. The concrete failure: drop the `hrms`
 * module block from moduleRegistry.js in the Customer Portal, and the next time
 * anyone saves a role through its Roles & Permissions screen, `compileGrants()`
 * writes back a grants array with every HRMS cell missing. Nobody sees an
 * error; HRMS access simply disappears for every account on that role.
 *
 * So these files are a CONTRACT rather than shared convenience code, and this
 * script is how you find out it has been broken — before a Super Admin does.
 *
 * The manifest is committed to BOTH repositories with the same contents. A
 * deliberate change to the contract means editing both repositories and
 * re-running --update in both; a mismatch here means exactly one of them was
 * edited, which is the situation worth being loud about.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = path.join(ROOT, 'shared-contract.manifest.json');

/**
 * Individually named files, plus one whole directory.
 *
 * `shared/permissions/` is taken as a tree rather than a list so that ADDING a
 * file to it in one repository is caught too — a new evaluator that only one
 * portal has is the same class of bug as an edited one.
 */
const FILES = [
  'config/permissions.js',
  'config/moduleRegistry.js',
  'utils/roleResolver.js',
  'utils/hrmsRoleGuard.js',
  'utils/tokens.js',
  'middlewares/rbac.js',
  'middlewares/auth.js',
  'middlewares/portalGuard.js',
  'models/User.js',
  'models/Role.js',
];

/*
 * TWO FILES LEFT THIS LIST, AND ONE IS DELIBERATELY ABSENT.
 *
 *   utils/hrmsAccessBridge.js, middlewares/hrmsAuth.js
 *     Went with HRMS. Only the Employee Portal has them now, so they are not a
 *     contract between two repositories any more.
 *
 *   config/portal.js
 *     Never in this list and must never be. Its whole job is to declare WHICH
 *     domain the deployment serves, so two identical copies would mean one of
 *     them is lying.
 *
 * And two joined:
 *
 *   utils/tokens.js        both repos mint and verify sessions for the same
 *                          accounts, and store them in the same `refreshSessions`
 *                          array. A divergence here means one portal cannot read
 *                          the other's sessions — or, worse, revokes them.
 *   middlewares/portalGuard.js
 *                          the domain fence itself.
 */

const DIRS = ['shared/permissions'];

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function collect() {
  const entries = [...FILES];

  for (const dir of DIRS) {
    const abs = path.join(ROOT, dir);
    for (const name of (await readdir(abs)).sort()) {
      if (name.endsWith('.js')) entries.push(`${dir}/${name}`);
    }
  }

  const out = {};
  for (const rel of entries.sort()) {
    out[rel] = sha(await readFile(path.join(ROOT, rel)));
  }
  return out;
}

async function main() {
  const current = await collect();
  const update = process.argv.includes('--update');

  if (update) {
    await writeFile(MANIFEST, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    console.log(`Recorded ${Object.keys(current).length} files to shared-contract.manifest.json`);
    console.log('\n⚠  Copy this manifest into the OTHER repository as well, or the next');
    console.log('   run there will report drift that is really just an un-propagated change.');
    return;
  }

  let expected;
  try {
    expected = JSON.parse(await readFile(MANIFEST, 'utf8'));
  } catch {
    console.error('No shared-contract.manifest.json. Run with --update to create one.');
    process.exitCode = 1;
    return;
  }

  const problems = [];
  for (const [rel, hash] of Object.entries(expected)) {
    if (!(rel in current)) problems.push(`MISSING  ${rel}`);
    else if (current[rel] !== hash) problems.push(`CHANGED  ${rel}`);
  }
  for (const rel of Object.keys(current)) {
    if (!(rel in expected)) problems.push(`ADDED    ${rel}`);
  }

  console.log('Shared RBAC contract');
  console.log('====================');
  for (const rel of Object.keys(expected)) {
    const status = !(rel in current)
      ? 'MISSING'
      : current[rel] === expected[rel]
        ? 'ok'
        : 'CHANGED';
    console.log(`  ${status === 'ok' ? 'ok     ' : status.padEnd(7)} ${rel}`);
  }

  if (problems.length === 0) {
    console.log(`\n${Object.keys(expected).length} files match the recorded contract.`);
    return;
  }

  console.error('\nCONTRACT DRIFT:');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nThese files decide how the SHARED users and roles collections are read and\n' +
      'written. A change that exists in only one repository will make one portal\n' +
      'strip grants the other wrote. Propagate the change to the other repository,\n' +
      'run this script with --update in BOTH, and commit the identical manifest.',
  );
  process.exitCode = 1;
}

main();
