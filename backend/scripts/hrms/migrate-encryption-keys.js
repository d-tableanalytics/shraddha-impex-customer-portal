#!/usr/bin/env node
/**
 * Re-encrypt every sensitive field from one key configuration to another.
 *
 *   node scripts/hrms/migrate-encryption-keys.js                  # dry run
 *   node scripts/hrms/migrate-encryption-keys.js --verify         # check only
 *   node scripts/hrms/migrate-encryption-keys.js --execute        # writes
 *
 * DRY RUN IS THE DEFAULT. `--execute` is the only thing that opens a write.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The client employee import ran with no HRMS crypto variables set. Outside
 * production `getKeyProvider()` defaults to the LOCAL driver and
 * `blindIndexKey()` returns a development constant, and both of those values
 * live in this repository:
 *
 *   utils/hrms/crypto/local.js   'shraddha-hrms-local-development-key'
 *   utils/hrms/crypto/index.js   'development-blind-index-key-not-for-production'
 *
 * So the PAN, bank account, IFSC and Aadhaar of 17 real employees are encrypted
 * with a key anyone holding the source can derive. Setting production keys does
 * not fix that on its own - it makes the existing records UNREADABLE, because
 * the envelopes carry a data key the new provider cannot unwrap and the blind
 * indexes were computed under a different HMAC key.
 *
 * The data has to be carried across:
 *
 *   old envelope -> decrypt with OLD config -> plaintext, in memory only
 *               -> encrypt with NEW config -> new envelope
 *               -> recompute blind index with the NEW index key
 *               -> persist the new representation
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * It is not a new encryption implementation. Every cryptographic operation goes
 * through `utils/hrms/crypto/index.js` exactly as the application does -
 * `encryptField`, `decryptField`, `blindIndex`. What this file adds is the
 * ability to point that module at one configuration for reads and another for
 * writes, which it does by swapping the environment and resetting the module's
 * cached provider through its existing `__resetCrypto()` test seam.
 *
 * Nothing is written to disk. There is no export, no backup file, no dump: a
 * plaintext copy of 17 PANs sitting in a file is a worse outcome than the
 * problem being fixed. Recovery is by re-running with the configurations
 * swapped (see --help).
 */

import process from 'node:process';
import mongoose from 'mongoose';
import 'dotenv/config';

import { connectDatabase } from '../../config/database.js';
import Employee from '../../models/hrms/Employee.js';
import { SsoConfig, IntegrationConfig } from '../../models/hrms/SettingsModels.js';
import {
  encryptField,
  decryptField,
  blindIndex,
  isEncryptedEnvelope,
  __resetCrypto,
} from '../../utils/hrms/crypto/index.js';
import { encPath, idxPath } from '../../models/hrms/plugins/sensitiveFields.js';
import {
  SENSITIVE_EMPLOYEE_FIELD_LIST,
  BLIND_INDEXED_FIELDS,
} from '../../shared/security/sensitive-fields.js';

export const MIGRATION_VERSION = '1.0.0';

/**
 * The development fallbacks, named here so the OLD configuration needs no
 * secret handling: they are already in the repository, and repeating them is
 * what lets an operator run this without pasting a key anywhere.
 *
 * They are also what the refusals below compare against, so a production
 * configuration that accidentally equals one of them cannot be used as the
 * TARGET of a migration.
 */
export const DEV_FALLBACKS = Object.freeze({
  localEncryptionKey: 'shraddha-hrms-local-development-key',
  blindIndexKey: 'development-blind-index-key-not-for-production',
});

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export function parseArgs(argv = []) {
  const args = { execute: false, verify: false, help: false, batchSize: 50 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--execute') args.execute = true;
    else if (a === '--dry-run') args.execute = false;
    else if (a === '--verify') args.verify = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--batch-size') args.batchSize = Number(argv[++i]) || 50;
  }
  return args;
}

// ---------------------------------------------------------------------------
// Key configuration
// ---------------------------------------------------------------------------

/**
 * The two configurations, read from the environment.
 *
 * NEW is the ordinary set of variables - the ones the server will hold once it
 * is configured for production. OLD is the `HRMS_OLD_*` set, which defaults to
 * the development fallbacks because that is what the data was written with.
 */
export function readConfigs(env = process.env) {
  return {
    old: {
      driver: env.HRMS_OLD_CRYPTO_DRIVER || 'local',
      kmsKeyId: env.HRMS_OLD_KMS_KEY_ID || null,
      localKey: env.HRMS_OLD_LOCAL_ENCRYPTION_KEY || DEV_FALLBACKS.localEncryptionKey,
      blindIndexKey: env.HRMS_OLD_BLIND_INDEX_KEY || DEV_FALLBACKS.blindIndexKey,
    },
    next: {
      driver: env.HRMS_CRYPTO_DRIVER || (env.NODE_ENV === 'production' ? 'kms' : 'local'),
      kmsKeyId: env.HRMS_KMS_KEY_ID || null,
      localKey: env.HRMS_LOCAL_ENCRYPTION_KEY || null,
      blindIndexKey: env.HRMS_BLIND_INDEX_KEY || null,
    },
  };
}

/**
 * Everything that must be true before a single byte is re-encrypted.
 *
 * Returns the reasons to refuse rather than throwing, so a dry run can report
 * all of them at once instead of one per attempt.
 */
export function validateConfigs({ old, next }, { nodeEnv } = {}) {
  const refusals = [];

  if (!next.blindIndexKey) {
    refusals.push(
      'HRMS_BLIND_INDEX_KEY is not set. It is the target index key; without it there is ' +
        'nothing to migrate the blind indexes TO.',
    );
  }

  if (next.driver === 'kms' && !next.kmsKeyId) {
    refusals.push(
      'HRMS_CRYPTO_DRIVER=kms but HRMS_KMS_KEY_ID is not set. It is the customer-managed ' +
        'CMK that wraps every data key.',
    );
  }

  if (next.driver === 'local' && !next.localKey) {
    refusals.push(
      'HRMS_CRYPTO_DRIVER=local but HRMS_LOCAL_ENCRYPTION_KEY is not set, so the target ' +
        'would be the development passphrase compiled into local.js.',
    );
  }

  if (next.driver === 'local' && nodeEnv === 'production') {
    refusals.push(
      'HRMS_CRYPTO_DRIVER=local in production. The local driver derives its key from a ' +
        'passphrase in the environment; production is what KMS envelope encryption is for.',
    );
  }

  // A migration whose source and target are the same key is a no-op that would
  // report success. Worse, it would let "we migrated" be said about data that
  // is still under the development key.
  if (next.blindIndexKey && next.blindIndexKey === old.blindIndexKey) {
    refusals.push(
      'The target blind-index key is identical to the source one. Nothing would change, ' +
        'and the migration would report success over unmigrated data.',
    );
  }

  if (next.blindIndexKey === DEV_FALLBACKS.blindIndexKey) {
    refusals.push(
      'HRMS_BLIND_INDEX_KEY is the development fallback that is committed to this ' +
        'repository. It cannot be the target of a migration away from itself.',
    );
  }

  if (next.driver === 'local' && next.localKey === DEV_FALLBACKS.localEncryptionKey) {
    refusals.push(
      'HRMS_LOCAL_ENCRYPTION_KEY is the development passphrase committed to this repository.',
    );
  }

  if (
    next.driver === old.driver &&
    next.driver === 'local' &&
    next.localKey === old.localKey
  ) {
    refusals.push('The target encryption key is identical to the source one.');
  }

  if (
    next.driver === old.driver &&
    next.driver === 'kms' &&
    next.kmsKeyId &&
    next.kmsKeyId === old.kmsKeyId
  ) {
    refusals.push('The target KMS key is identical to the source one.');
  }

  return refusals;
}

// ---------------------------------------------------------------------------
// Running the crypto module under a chosen configuration
// ---------------------------------------------------------------------------

/**
 * Run `fn` with the crypto module configured as `cfg`.
 *
 * The module caches its key provider in a module-level variable and reads the
 * environment when it builds one, so switching configuration means setting the
 * variables and dropping that cache - which is exactly what `__resetCrypto()`
 * exists for. The environment is restored afterwards whatever happens, so a
 * throw cannot leave the process holding the wrong key.
 *
 * This is the whole reason the migration can reuse `encryptField` and
 * `decryptField` unchanged rather than reimplementing AES-GCM beside them.
 */
export async function withCryptoConfig(cfg, fn, env = process.env) {
  const KEYS = [
    'HRMS_CRYPTO_DRIVER',
    'HRMS_KMS_KEY_ID',
    'HRMS_LOCAL_ENCRYPTION_KEY',
    'HRMS_BLIND_INDEX_KEY',
  ];
  const saved = Object.fromEntries(KEYS.map((k) => [k, env[k]]));

  const apply = (values) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  };

  apply({
    HRMS_CRYPTO_DRIVER: cfg.driver,
    HRMS_KMS_KEY_ID: cfg.kmsKeyId ?? undefined,
    HRMS_LOCAL_ENCRYPTION_KEY: cfg.localKey ?? undefined,
    HRMS_BLIND_INDEX_KEY: cfg.blindIndexKey ?? undefined,
  });
  __resetCrypto();

  try {
    return await fn();
  } finally {
    apply(saved);
    __resetCrypto();
  }
}

// ---------------------------------------------------------------------------
// What has to move
// ---------------------------------------------------------------------------

/**
 * Every encrypted field this system holds, and where.
 *
 * Declared rather than discovered so that a collection gaining an encrypted
 * field is a visible edit here, not something a migration silently misses. The
 * two settings collections are empty today; they are listed because they will
 * not always be, and a migration that only knew about Employee would leave an
 * SSO client secret behind under the old key.
 */
export const ENCRYPTED_SOURCES = Object.freeze([
  {
    name: 'employees',
    model: () => Employee,
    kind: 'fields',
    fields: SENSITIVE_EMPLOYEE_FIELD_LIST,
    indexed: BLIND_INDEXED_FIELDS,
  },
  {
    name: 'hrms_sso_configs',
    model: () => SsoConfig,
    kind: 'fields',
    fields: ['clientSecret'],
    indexed: [],
  },
  {
    name: 'hrms_integration_configs',
    model: () => IntegrationConfig,
    kind: 'map',
    mapPath: 'secretsEnc',
    indexed: [],
  },
]);

// ---------------------------------------------------------------------------
// The migration itself
// ---------------------------------------------------------------------------

/**
 * Decrypt one envelope under OLD, re-encrypt under NEW.
 *
 * `alreadyNew` is attempted FIRST, which is what makes a re-run idempotent: a
 * record that already reads under the target configuration is left exactly as
 * it is rather than being rewritten with a fresh IV every time the script runs.
 *
 * The plaintext exists only as a local binding inside this function and is
 * never returned, logged or stored.
 */
export async function moveEnvelope(envelope, { old, next }) {
  if (!isEncryptedEnvelope(envelope)) {
    throw new Error('not an encrypted envelope');
  }

  let plaintext = null;
  let wasAlreadyMigrated = false;

  try {
    plaintext = await withCryptoConfig(next, () => decryptField(envelope));
    wasAlreadyMigrated = true;
  } catch {
    // Expected for anything still under the old key - that is the work.
    plaintext = await withCryptoConfig(old, () => decryptField(envelope));
  }

  if (plaintext === null || plaintext === '') {
    throw new Error('decrypted to an empty value');
  }

  /**
   * An envelope that already reads under the target key is returned UNCHANGED.
   *
   * Re-encrypting it would produce a fresh IV and therefore a different
   * ciphertext, so every re-run would rewrite every record - the collection
   * would churn, and "nothing changed" would stop being an observable fact
   * about a second pass. The blind index is still recomputed, because a
   * half-migrated record can have a moved envelope beside a stale index.
   */
  const migrated = await withCryptoConfig(next, async () => ({
    envelope: wasAlreadyMigrated ? envelope : await encryptField(plaintext),
    index: blindIndex(plaintext),
  }));

  // Drop the reference promptly. V8 decides when this is actually collected,
  // so this is hygiene rather than a guarantee - the real control is that the
  // value never leaves this scope.
  plaintext = null;

  return { ...migrated, wasAlreadyMigrated };
}

/** Plan (and optionally apply) the migration of one document. */
async function migrateDocument(doc, source, configs, { execute, session }) {
  const $set = {};
  /** Fields holding an envelope - whether or not it needed moving. */
  const encryptedFields = [];
  /** Fields whose stored representation actually changes. */
  const changedFields = [];
  let alreadyMigrated = 0;
  let moved = 0;

  if (source.kind === 'fields') {
    for (const field of source.fields) {
      const envelope = doc[encPath(field)];
      if (!envelope) continue;

      const result = await moveEnvelope(envelope, configs);

      // Only what actually differs. A record already on the target key with a
      // correct index contributes nothing to `$set`, so the second run of a
      // completed migration issues no write at all.
      let changed = false;
      if (!result.wasAlreadyMigrated) {
        $set[encPath(field)] = result.envelope;
        changed = true;
      }
      if (source.indexed.includes(field) && doc[idxPath(field)] !== result.index) {
        $set[idxPath(field)] = result.index;
        changed = true;
      }

      encryptedFields.push(field);
      if (changed) changedFields.push(field);
      if (result.wasAlreadyMigrated) alreadyMigrated += 1;
      else moved += 1;
    }
  } else {
    const map = doc[source.mapPath] ?? {};
    const rebuilt = {};
    for (const [key, envelope] of Object.entries(map)) {
      if (!isEncryptedEnvelope(envelope)) continue;
      const result = await moveEnvelope(envelope, configs);
      rebuilt[key] = result.envelope;
      encryptedFields.push(`${source.mapPath}.${key}`);
      if (!result.wasAlreadyMigrated) changedFields.push(`${source.mapPath}.${key}`);
      if (result.wasAlreadyMigrated) alreadyMigrated += 1;
      else moved += 1;
    }
    // The map is rewritten whole, so it is only written when at least one of
    // its entries actually moved.
    if (changedFields.length > 0) $set[source.mapPath] = rebuilt;
  }

  if (execute && changedFields.length > 0) {
    // One update per document: every field of a record changes together, so a
    // half-migrated employee is not a state this can produce.
    await source.model().collection.updateOne(
      { _id: doc._id },
      { $set },
      session ? { session } : {},
    );
  }

  return { encryptedFields, changedFields, alreadyMigrated, moved };
}

/**
 * The fields a document must be read with.
 *
 * `Enc` and `Idx` paths are `select: false`, so an ordinary find returns none
 * of them - a migration reading through the model without asking would see
 * nothing to migrate and report success.
 */
function projectionFor(source) {
  if (source.kind === 'map') return { [source.mapPath]: 1 };
  const p = { _id: 1 };
  for (const f of source.fields) {
    p[encPath(f)] = 1;
    if (source.indexed.includes(f)) p[idxPath(f)] = 1;
  }
  return p;
}

export async function migrateSource(source, configs, { execute = false, session = null } = {}) {
  const model = source.model();
  const docs = await model.collection.find({}, { projection: projectionFor(source) }).toArray();

  const stats = {
    collection: source.name,
    documents: docs.length,
    documentsWithEncryptedData: 0,
    envelopesMoved: 0,
    envelopesAlreadyMigrated: 0,
    blindIndexesRecomputed: 0,
    failures: [],
  };

  for (const doc of docs) {
    try {
      const r = await migrateDocument(doc, source, configs, { execute, session });
      if (r.encryptedFields.length === 0) continue;
      stats.documentsWithEncryptedData += 1;
      stats.envelopesMoved += r.moved;
      stats.envelopesAlreadyMigrated += r.alreadyMigrated;
      if (source.kind === 'fields') {
        stats.blindIndexesRecomputed += r.changedFields.filter((f) =>
          source.indexed.includes(f),
        ).length;
      }
    } catch (error) {
      // The id, never the field's content.
      stats.failures.push({ id: String(doc._id), reason: error.message });
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Prove the data reads under the TARGET configuration and nothing else.
 *
 * Decrypting is the only honest check: a field that looks like an envelope but
 * cannot be opened is worse than one that is obviously missing. The old
 * configuration is then tried as well, and anything that still reads under it
 * is reported - that is unmigrated data, whatever the counters said.
 */
export async function verifySource(source, configs) {
  const model = source.model();
  const docs = await model.collection.find({}, { projection: projectionFor(source) }).toArray();

  const out = {
    collection: source.name,
    documents: docs.length,
    envelopes: 0,
    decryptUnderNew: 0,
    decryptUnderOld: 0,
    blindIndexMatches: 0,
    blindIndexMismatches: 0,
    failures: [],
  };

  for (const doc of docs) {
    const entries =
      source.kind === 'fields'
        ? source.fields
            .filter((f) => doc[encPath(f)])
            .map((f) => ({ label: f, envelope: doc[encPath(f)], index: doc[idxPath(f)], indexed: source.indexed.includes(f) }))
        : Object.entries(doc[source.mapPath] ?? {})
            .filter(([, e]) => isEncryptedEnvelope(e))
            .map(([k, e]) => ({ label: k, envelope: e, index: null, indexed: false }));

    for (const entry of entries) {
      out.envelopes += 1;
      let plaintext = null;
      try {
        plaintext = await withCryptoConfig(configs.next, () => decryptField(entry.envelope));
        out.decryptUnderNew += 1;
      } catch {
        out.failures.push({ id: String(doc._id), field: entry.label, reason: 'does not decrypt under the target configuration' });
        // Does it still read under the old one? Then it was never migrated.
        try {
          await withCryptoConfig(configs.old, () => decryptField(entry.envelope));
          out.decryptUnderOld += 1;
        } catch {
          /* readable under neither - reported above */
        }
        continue;
      }

      if (entry.indexed) {
        const expected = await withCryptoConfig(configs.next, () => blindIndex(plaintext));
        if (expected === entry.index) out.blindIndexMatches += 1;
        else {
          out.blindIndexMismatches += 1;
          out.failures.push({ id: String(doc._id), field: entry.label, reason: 'blind index does not match the target key' });
        }
      }
      plaintext = null;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `
HRMS sensitive-field key migration (v${MIGRATION_VERSION})

  node scripts/hrms/migrate-encryption-keys.js [--verify] [--execute]

  (no flag)   DRY RUN - reports what would move, writes nothing
  --verify    check only: does every envelope read under the TARGET config
  --execute   perform the migration

TARGET configuration (the production keys), read from the environment:
  HRMS_CRYPTO_DRIVER          kms in production
  HRMS_KMS_KEY_ID             required when the driver is kms
  HRMS_LOCAL_ENCRYPTION_KEY   required when the driver is local
  HRMS_BLIND_INDEX_KEY        required always

SOURCE configuration (what the data is encrypted with NOW). Defaults to the
development fallbacks, which is what an unconfigured import used, so normally
none of these needs to be set:
  HRMS_OLD_CRYPTO_DRIVER      default local
  HRMS_OLD_KMS_KEY_ID
  HRMS_OLD_LOCAL_ENCRYPTION_KEY
  HRMS_OLD_BLIND_INDEX_KEY

ROLLBACK: re-run with the two configurations exchanged - put the production
values in the HRMS_OLD_* names and the previous values in the ordinary ones.
Nothing is deleted and no plaintext is ever written to disk, so the data can be
carried back the same way it was carried forward.
`;

export async function main({
  argv = process.argv.slice(2),
  connect = connectDatabase,
  disconnect = () => mongoose.disconnect(),
  env = process.env,
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return { help: true };
  }

  const configs = readConfigs(env);
  const mode = args.verify ? 'VERIFY' : args.execute ? 'EXECUTE' : 'DRY RUN';

  console.log(`\n=== HRMS encryption key migration - ${mode} ===`);
  console.log(`migration: v${MIGRATION_VERSION}`);
  // Names and drivers only. No key material is printed at any verbosity.
  console.log(`source: driver=${configs.old.driver}`);
  console.log(`target: driver=${configs.next.driver}\n`);

  const refusals = validateConfigs(configs, { nodeEnv: env.NODE_ENV });
  if (refusals.length > 0) {
    console.error('REFUSED. Nothing was read and nothing was written:\n');
    for (const r of refusals) console.error(`  - ${r}`);
    console.error('');
    return { refused: true, reasons: refusals };
  }

  await connect();

  try {
    if (args.verify) {
      const results = [];
      for (const source of ENCRYPTED_SOURCES) {
        results.push(await verifySource(source, configs));
      }
      printVerify(results);
      const ok = results.every((r) => r.failures.length === 0 && r.decryptUnderOld === 0);
      return { verified: true, ok, results };
    }

    const results = [];
    for (const source of ENCRYPTED_SOURCES) {
      results.push(await migrateSource(source, configs, { execute: args.execute }));
    }
    printMigrate(results, args.execute);

    const failures = results.reduce((n, r) => n + r.failures.length, 0);
    if (!args.execute) {
      console.log('\nDRY RUN - nothing was written. Re-run with --execute to migrate.');
      return { dryRun: true, executed: false, results, failures };
    }
    console.log('\nMIGRATED. Run again with --verify to confirm.');
    return { executed: true, results, failures };
  } finally {
    await disconnect();
  }
}

function printMigrate(results, executed) {
  for (const r of results) {
    console.log(`${r.collection}:`);
    console.log(`  documents                    ${r.documents}`);
    console.log(`  with encrypted data          ${r.documentsWithEncryptedData}`);
    console.log(`  envelopes to re-encrypt      ${r.envelopesMoved}`);
    console.log(`  already on the target key    ${r.envelopesAlreadyMigrated}`);
    console.log(`  blind indexes recomputed     ${r.blindIndexesRecomputed}`);
    if (r.failures.length) {
      console.log(`  FAILURES                     ${r.failures.length}`);
      for (const f of r.failures) console.log(`    - ${f.id}: ${f.reason}`);
    }
  }
  console.log(`\nmode: ${executed ? 'EXECUTE' : 'dry run'}`);
}

function printVerify(results) {
  for (const r of results) {
    console.log(`${r.collection}:`);
    console.log(`  envelopes                    ${r.envelopes}`);
    console.log(`  decrypt under TARGET         ${r.decryptUnderNew}`);
    console.log(`  still readable under SOURCE  ${r.decryptUnderOld}${r.decryptUnderOld ? '   *** UNMIGRATED ***' : ''}`);
    console.log(`  blind index matches          ${r.blindIndexMatches}`);
    console.log(`  blind index mismatches       ${r.blindIndexMismatches}`);
    if (r.failures.length) {
      console.log(`  FAILURES                     ${r.failures.length}`);
      for (const f of r.failures) console.log(`    - ${f.id} ${f.field}: ${f.reason}`);
    }
  }
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('migrate-encryption-keys.js');

if (invokedDirectly) {
  main()
    .then((verdict) => {
      if (verdict?.refused) process.exitCode = 1;
      if (verdict?.failures) process.exitCode = 1;
      if (verdict?.verified && !verdict.ok) process.exitCode = 1;
    })
    .catch(async (error) => {
      console.error(`\nMIGRATION FAILED: ${error.message}`);
      process.exitCode = 1;
      await mongoose.disconnect().catch(() => {});
    });
}
