import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Collection } from 'mongodb';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The write seal shared by the remediation scripts.
 *
 * Every one of these tools reads production and most of them only report. The
 * seal makes "only reports" a property of the program rather than a promise in
 * a comment: each mutating method on the driver's Collection prototype is
 * replaced with a thrower before a connection is opened, so a stray update
 * anywhere — in this file, in something it imports, in a future edit — fails
 * loudly instead of touching live data.
 *
 * An apply mode does not remove the seal. It names the collections that one
 * run may write and leaves every other collection sealed, so a reconciliation
 * that is allowed to correct `products` still cannot reach an order, a
 * reservation, a PO, an indent or an audit record. That containment is the
 * point: the restriction these scripts operate under is not "be careful", it
 * is "cannot".
 */
const WRITE_METHODS = [
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne',
  'deleteOne', 'deleteMany', 'bulkWrite', 'findOneAndUpdate', 'findOneAndDelete',
  'findOneAndReplace', 'drop', 'rename', 'createIndex', 'createIndexes',
  'dropIndex', 'dropIndexes', 'initializeOrderedBulkOp', 'initializeUnorderedBulkOp',
];

let installed = false;
let allowed = new Set();

/**
 * Install the seal. Call once, before connecting.
 *
 * @param {string[]} writableCollections  collections this run may write.
 *        Empty (the default) means the run cannot write at all.
 */
export const sealDatabase = (writableCollections = []) => {
  allowed = new Set(writableCollections);
  if (installed) return;
  installed = true;

  for (const method of WRITE_METHODS) {
    const original = Collection.prototype[method];
    Collection.prototype[method] = function sealed(...args) {
      if (allowed.has(this?.collectionName)) return original.apply(this, args);
      throw new Error(
        `Refused Collection.${method}() on "${this?.collectionName ?? 'unknown'}". ` +
        (allowed.size
          ? `This run may only write: ${[...allowed].join(', ')}.`
          : 'This run is read-only. Pass --apply to enable a scoped write mode.'),
      );
    };
  }
};

/** Widen the seal mid-run (e.g. once a confirmation step has passed). */
export const allowCollections = (names) => {
  for (const n of names) allowed.add(n);
};

/** What the seal currently permits, for the run header. */
export const sealedExcept = () => [...allowed];

/**
 * The database to work against.
 *
 * `--uri` exists so the tests can point these scripts at an in-memory replica
 * set. Without it they read `backend/.env`, which on this deployment is the
 * production cluster — which is exactly why no test may be allowed to fall
 * back to it by accident.
 */
export const resolveUri = (argv = process.argv) => {
  const i = argv.indexOf('--uri');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const envPath = path.join(HERE, '..', '..', '.env');
  const text = fs.readFileSync(envPath, 'utf8');
  const m = text.match(/MONGODB_URI\s*=\s*(\S+)/);
  if (!m) throw new Error(`MONGODB_URI not found in ${envPath}`);
  return m[1];
};

/** Simple flag helpers, shared so the scripts parse arguments the same way. */
export const makeArgs = (argv = process.argv.slice(2)) => ({
  has: (name) => argv.includes(`--${name}`),
  val: (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  },
  raw: argv,
});

export default { sealDatabase, allowCollections, sealedExcept, resolveUri, makeArgs };
