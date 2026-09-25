/**
 * fms-port.mjs
 * -----------------------------------------------------------------------------
 * Keep the FMS screens in src/fms/ identical to the Employee Portal's.
 *
 *   node scripts/fms-port.mjs            # CHECK — no local copy was edited (no upstream needed)
 *   node scripts/fms-port.mjs diff       # which upstream files changed since the last sync
 *   node scripts/fms-port.mjs sync       # copy them across and re-record the hashes
 *   ... --from "<path to Employee portal module/frontend>"
 *
 * WHY A COPY AT ALL
 *
 * FMS runs on ONE server, the Employee Portal's: its engine, its crons, its
 * Work Queue mirrors. This portal only draws the screens, calling that server
 * with the session it already has. The screens themselves are the Employee
 * Portal's own files, copied verbatim so the two portals show the same thing
 * and the Employee Portal's O2D tests run here unmodified.
 *
 * The files listed in fms-port.manifest.json are those verbatim copies. Do not
 * edit them here: change them in the Employee Portal and run `sync`. The three
 * ADAPTERS that make them work in this portal (src/fms/services/api.js,
 * src/fms/services/apiBase.js, src/fms/store/userStore.js) are deliberately
 * NOT listed, and are this repository's to change.
 *
 * Hashes are taken with CRLF normalised to LF, so a checkout's line-ending
 * setting is not reported as drift.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, '..');
const MANIFEST = path.join(FRONTEND, 'fms-port.manifest.json');

const args = process.argv.slice(2);
const command = ['check', 'diff', 'sync'].find((c) => args.includes(c)) ?? 'check';
const fromIndex = args.indexOf('--from');
const upstreamRoot = fromIndex >= 0 && args[fromIndex + 1]
  ? path.resolve(args[fromIndex + 1])
  : path.resolve(FRONTEND, '..', '..', 'Employee portal module', 'frontend');

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const entries = Object.entries(manifest.files);

const hashOf = (file) =>
  crypto.createHash('sha256')
    .update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
    .digest('hex');

const local = (rel) => path.join(FRONTEND, rel);
const upstream = (entry) => path.join(upstreamRoot, entry.from);

if (command !== 'check' && !fs.existsSync(upstreamRoot)) {
  console.error(`Upstream not found: ${upstreamRoot}\nPass --from "<Employee portal module/frontend>".`);
  process.exit(1);
}

let problems = 0;

if (command === 'check') {
  console.log('FMS port — local copies\n======================');
  for (const [rel, entry] of entries) {
    const file = local(rel);
    if (!fs.existsSync(file)) {
      console.log(`  MISSING  ${rel}`);
      problems += 1;
    } else if (hashOf(file) !== entry.sha256) {
      console.log(`  EDITED   ${rel}`);
      problems += 1;
    } else {
      console.log(`  ok       ${rel}`);
    }
  }
  console.log(problems
    ? `\n${problems} file(s) differ from the recorded port. Make the change in the Employee Portal and run \`npm run fms:sync\`.`
    : `\n${entries.length} files match the recorded port.`);
  process.exit(problems ? 1 : 0);
}

if (command === 'diff') {
  console.log(`FMS port — upstream (${upstreamRoot})\n======================`);
  for (const [rel, entry] of entries) {
    const file = upstream(entry);
    if (!fs.existsSync(file)) {
      console.log(`  GONE     ${entry.from}`);
      problems += 1;
    } else if (hashOf(file) !== entry.sha256) {
      console.log(`  CHANGED  ${entry.from}`);
      problems += 1;
    }
  }
  console.log(problems
    ? `\n${problems} upstream file(s) changed since the last sync. Run \`npm run fms:sync\`, then the tests.`
    : `\nUpstream matches all ${entries.length} ported files.`);
  process.exit(problems ? 1 : 0);
}

// sync
for (const [rel, entry] of entries) {
  const src = upstream(entry);
  if (!fs.existsSync(src)) {
    console.error(`  GONE     ${entry.from} — remove it from the manifest or restore it upstream.`);
    problems += 1;
    continue;
  }
  const dest = local(rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  const sha256 = hashOf(dest);
  if (sha256 !== entry.sha256) console.log(`  synced   ${rel}`);
  manifest.files[rel] = { ...entry, sha256 };
}
if (problems) process.exit(1);
manifest.syncedAt = new Date().toISOString();
fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\n${entries.length} files in step with ${upstreamRoot}.`);
