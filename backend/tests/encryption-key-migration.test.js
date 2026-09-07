/**
 * The key migration.
 *
 * This one moves REAL sensitive data between two keys, so the tests are about
 * the two ways that can go wrong: leaving data behind under the old key, and
 * losing it entirely under the new one. Both are checked by decrypting, not by
 * trusting a counter — a field that looks like an envelope but cannot be opened
 * is worse than one that is obviously missing.
 *
 * Everything runs against the in-memory database with local-driver keys on both
 * sides. No production key, no KMS call, and no real employee data.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import Employee from '../models/hrms/Employee.js';
import { IntegrationConfig } from '../models/hrms/SettingsModels.js';
import {
  encryptField,
  decryptField,
  blindIndex,
  isEncryptedEnvelope,
  __resetCrypto,
} from '../utils/hrms/crypto/index.js';
import { encPath, idxPath } from '../models/hrms/plugins/sensitiveFields.js';
import {
  main as runMigration,
  parseArgs,
  readConfigs,
  validateConfigs,
  withCryptoConfig,
  migrateSource,
  moveEnvelope,
  verifySource,
  ENCRYPTED_SOURCES,
  DEV_FALLBACKS,
} from '../scripts/hrms/migrate-encryption-keys.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

// Two local configurations that are genuinely different from each other and
// from the development fallbacks.
const OLD = {
  driver: 'local',
  kmsKeyId: null,
  localKey: DEV_FALLBACKS.localEncryptionKey,
  blindIndexKey: DEV_FALLBACKS.blindIndexKey,
};
const NEW = {
  driver: 'local',
  kmsKeyId: null,
  localKey: 'test-production-encryption-key-not-the-dev-one',
  blindIndexKey: 'test-production-blind-index-key-not-the-dev-one',
};
const CONFIGS = { old: OLD, next: NEW };

/** What each seeded code was given, so a test can assert the round trip. */
const seededValues = new Map();

const employeeSource = ENCRYPTED_SOURCES.find((s) => s.name === 'employees');
const integrationSource = ENCRYPTED_SOURCES.find((s) => s.name === 'hrms_integration_configs');

before(async () => {
  await startTestMongo();
  await syncIndexes(Employee);
});

after(async () => {
  await stopTestMongo();
  __resetCrypto();
});

beforeEach(async () => {
  await clearCollections();
  __resetCrypto();
});

/**
 * An employee whose sensitive fields are encrypted under the OLD config.
 *
 * PAN and Aadhaar are derived from the employee code because BOTH carry a
 * unique blind index - seeding two people with the same PAN collides on it,
 * which is the index doing exactly what it is for.
 */
async function seedOldEmployee(code = 'SI0001', overrides = {}) {
  const n = code.slice(-1);
  const pan = overrides.pan ?? `ABCDE123${n}F`;
  const aadhaar = overrides.aadhaar ?? `003${n}`;
  const built = await withCryptoConfig(OLD, async () => ({
    panNumberEnc: await encryptField(pan),
    panNumberIdx: blindIndex(pan),
    aadhaarNumberEnc: await encryptField(aadhaar),
    aadhaarNumberIdx: blindIndex(aadhaar),
    bankAccountNumberEnc: await encryptField('123456789012'),
  }));
  seededValues.set(code, { pan, aadhaar });

  await Employee.collection.insertOne({
    employeeCode: code,
    firstName: 'Test',
    lastName: 'Person',
    dateOfJoining: new Date('2025-01-01'),
    employmentType: 'full_time',
    status: 'active',
    userId: new mongoose.Types.ObjectId(),
    managerChain: [],
    deletedAt: null,
    ...built,
  });
}

const rawEmployee = (code) =>
  Employee.collection.findOne({ employeeCode: code });

// ---------------------------------------------------------------------------
// The migration itself
// ---------------------------------------------------------------------------

test('a development-encrypted record becomes a production-encrypted one', async () => {
  await seedOldEmployee();
  const before_ = await rawEmployee('SI0001');

  const stats = await migrateSource(employeeSource, CONFIGS, { execute: true });
  assert.equal(stats.envelopesMoved, 3, 'PAN, Aadhaar and bank account');
  assert.equal(stats.failures.length, 0);

  const after = await rawEmployee('SI0001');

  // The ciphertext actually changed.
  assert.notDeepEqual(after.panNumberEnc, before_.panNumberEnc);

  // It reads under the NEW config...
  const { pan } = seededValues.get('SI0001');
  const readBack = await withCryptoConfig(NEW, () => decryptField(after.panNumberEnc));
  assert.equal(readBack, pan);

  // ...and no longer under the OLD one. That is the whole point.
  await assert.rejects(withCryptoConfig(OLD, () => decryptField(after.panNumberEnc)));
});

test('blind indexes are recomputed under the new key', async () => {
  await seedOldEmployee();
  const before_ = await rawEmployee('SI0001');

  await migrateSource(employeeSource, CONFIGS, { execute: true });
  const after = await rawEmployee('SI0001');

  const { pan, aadhaar } = seededValues.get('SI0001');
  assert.notEqual(after.panNumberIdx, before_.panNumberIdx, 'the index must change');
  assert.equal(
    after.panNumberIdx,
    await withCryptoConfig(NEW, () => blindIndex(pan)),
    'and must equal the HMAC under the new key',
  );
  assert.equal(after.aadhaarNumberIdx, await withCryptoConfig(NEW, () => blindIndex(aadhaar)));
});

test('a field with no value is left alone rather than given an empty envelope', async () => {
  await seedOldEmployee();
  const after = await (async () => {
    await migrateSource(employeeSource, CONFIGS, { execute: true });
    return rawEmployee('SI0001');
  })();

  // uanNumber was never set on the fixture.
  assert.equal(after.uanNumberEnc, undefined);
  assert.equal(after.bankIfscEnc, undefined);
});

test('the secrets MAP in an integration config migrates too', async () => {
  const secrets = await withCryptoConfig(OLD, async () => ({
    apiKey: await encryptField('an-api-key'),
    webhookSecret: await encryptField('a-webhook-secret'),
  }));
  await IntegrationConfig.collection.insertOne({
    kind: 'biometric',
    config: {},
    secretsEnc: secrets,
    active: true,
  });

  const stats = await migrateSource(integrationSource, CONFIGS, { execute: true });
  assert.equal(stats.envelopesMoved, 2);

  const row = await IntegrationConfig.collection.findOne({ kind: 'biometric' });
  assert.equal(await withCryptoConfig(NEW, () => decryptField(row.secretsEnc.apiKey)), 'an-api-key');
  assert.equal(
    await withCryptoConfig(NEW, () => decryptField(row.secretsEnc.webhookSecret)),
    'a-webhook-secret',
  );
});

// ---------------------------------------------------------------------------
// Dry run, execute, idempotency
// ---------------------------------------------------------------------------

test('a dry run writes nothing at all', async () => {
  await seedOldEmployee();
  const before_ = await rawEmployee('SI0001');

  const stats = await migrateSource(employeeSource, CONFIGS, { execute: false });
  assert.equal(stats.envelopesMoved, 3, 'it still reports what it WOULD do');

  const after = await rawEmployee('SI0001');
  assert.deepEqual(after.panNumberEnc, before_.panNumberEnc, 'unchanged');
  assert.equal(after.panNumberIdx, before_.panNumberIdx, 'unchanged');
});

test('re-running is idempotent: the second pass moves nothing and rewrites nothing', async () => {
  await seedOldEmployee();

  const first = await migrateSource(employeeSource, CONFIGS, { execute: true });
  assert.equal(first.envelopesMoved, 3);
  assert.equal(first.envelopesAlreadyMigrated, 0);
  const afterFirst = await rawEmployee('SI0001');

  const second = await migrateSource(employeeSource, CONFIGS, { execute: true });
  assert.equal(second.envelopesMoved, 0, 'nothing left to move');
  assert.equal(second.envelopesAlreadyMigrated, 3);

  const afterSecond = await rawEmployee('SI0001');
  // Not merely readable - byte-identical. A re-run that re-encrypted with a
  // fresh IV every time would churn the collection for no reason.
  assert.deepEqual(afterSecond.panNumberEnc, afterFirst.panNumberEnc);
  assert.equal(afterSecond.panNumberIdx, afterFirst.panNumberIdx);
});

test('a half-migrated collection is finished by a re-run', async () => {
  await seedOldEmployee('SI0001');
  await seedOldEmployee('SI0002');

  // Migrate one by hand, leaving the other on the old key.
  const one = await rawEmployee('SI0001');
  const { pan } = seededValues.get('SI0001');
  const moved = await withCryptoConfig(NEW, async () => ({
    enc: await encryptField(pan),
    idx: blindIndex(pan),
  }));
  await Employee.collection.updateOne(
    { _id: one._id },
    { $set: { panNumberEnc: moved.enc, panNumberIdx: moved.idx } },
  );

  const stats = await migrateSource(employeeSource, CONFIGS, { execute: true });
  assert.equal(stats.envelopesAlreadyMigrated, 1, 'the hand-migrated PAN');
  assert.equal(stats.envelopesMoved, 5, 'the rest');
  assert.equal(stats.failures.length, 0);

  const verified = await verifySource(employeeSource, CONFIGS);
  assert.equal(verified.decryptUnderOld, 0);
  assert.equal(verified.failures.length, 0);
});

// ---------------------------------------------------------------------------
// Verification mode
// ---------------------------------------------------------------------------

test('verification reports unmigrated data instead of passing over it', async () => {
  await seedOldEmployee();

  const before_ = await verifySource(employeeSource, CONFIGS);
  assert.equal(before_.envelopes, 3);
  assert.equal(before_.decryptUnderNew, 0);
  assert.equal(before_.decryptUnderOld, 3, 'still readable under the old key');
  assert.ok(before_.failures.length > 0);

  await migrateSource(employeeSource, CONFIGS, { execute: true });

  const after = await verifySource(employeeSource, CONFIGS);
  assert.equal(after.decryptUnderNew, 3);
  assert.equal(after.decryptUnderOld, 0);
  assert.equal(after.blindIndexMatches, 2, 'PAN and Aadhaar');
  assert.equal(after.blindIndexMismatches, 0);
  assert.equal(after.failures.length, 0);
});

test('verification catches a blind index that was not recomputed', async () => {
  await seedOldEmployee();
  await migrateSource(employeeSource, CONFIGS, { execute: true });

  // Put the OLD index back, as a partial migration would have left it.
  const stale = await withCryptoConfig(OLD, () => blindIndex(seededValues.get('SI0001').pan));
  await Employee.collection.updateOne({ employeeCode: 'SI0001' }, { $set: { panNumberIdx: stale } });

  const result = await verifySource(employeeSource, CONFIGS);
  assert.equal(result.blindIndexMismatches, 1);
  assert.ok(result.failures.some((f) => /blind index/.test(f.reason)));
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('it refuses when the target blind-index key is missing', () => {
  const refusals = validateConfigs({
    old: OLD,
    next: { ...NEW, blindIndexKey: null },
  });
  assert.ok(refusals.some((r) => /HRMS_BLIND_INDEX_KEY is not set/.test(r)));
});

test('it refuses when the KMS driver has no key id', () => {
  const refusals = validateConfigs({
    old: OLD,
    next: { driver: 'kms', kmsKeyId: null, localKey: null, blindIndexKey: 'x' },
  });
  assert.ok(refusals.some((r) => /HRMS_KMS_KEY_ID/.test(r)));
});

test('it refuses the local driver in production', () => {
  const refusals = validateConfigs({ old: OLD, next: NEW }, { nodeEnv: 'production' });
  assert.ok(refusals.some((r) => /local driver|HRMS_CRYPTO_DRIVER=local in production/.test(r)));
});

test('it refuses when the source and target keys are identical', () => {
  const same = validateConfigs({ old: OLD, next: { ...OLD } });
  assert.ok(same.some((r) => /identical/.test(r)), 'a no-op migration must not report success');

  /**
   * The same check, with keys that are NOT the development fallbacks.
   *
   * Without this the assertion above passes on the "target is the committed
   * dev key" refusal instead, and the identical-keys rule could be deleted
   * without a test noticing.
   */
  const bothCustom = { ...NEW };
  const refusals = validateConfigs({ old: bothCustom, next: { ...bothCustom } });
  assert.ok(
    refusals.some((r) => /identical/.test(r)),
    'two identical non-development keys must still be refused',
  );
  assert.ok(
    !refusals.some((r) => /development/.test(r)),
    'and for the identical-key reason, not the development-key one',
  );

  /**
   * The blind-index key on its own.
   *
   * Rotating the encryption key while leaving the index key alone still leaves
   * every PAN and Aadhaar searchable under the old HMAC, so it is its own
   * refusal - and needs its own case, because a pair that shares BOTH keys is
   * caught by the encryption-key rule first.
   */
  const indexOnly = validateConfigs({
    old: { ...NEW, localKey: 'an-older-encryption-key' },
    next: { ...NEW },
  });
  assert.ok(
    indexOnly.some((r) => /blind-index key is identical/.test(r)),
    'a shared blind-index key must be refused even when the encryption key differs',
  );
});

test('an already-migrated envelope is returned unchanged, not re-encrypted', async () => {
  // Asserted on the mechanism directly. The document-level `changed` guard
  // would mask a re-encryption here, so a test that only watched the database
  // could not tell the difference.
  const original = await withCryptoConfig(NEW, () => encryptField('ABCDE1234F'));
  const moved = await moveEnvelope(original, CONFIGS);

  assert.equal(moved.wasAlreadyMigrated, true);
  assert.deepEqual(moved.envelope, original, 'the same bytes, not a fresh IV');
  assert.equal(moved.index, await withCryptoConfig(NEW, () => blindIndex('ABCDE1234F')));
});

test('it refuses a target that IS the committed development key', () => {
  const refusals = validateConfigs({
    old: { ...OLD, blindIndexKey: 'something-else' },
    next: { ...NEW, blindIndexKey: DEV_FALLBACKS.blindIndexKey },
  });
  assert.ok(refusals.some((r) => /development fallback/.test(r)));

  const enc = validateConfigs({
    old: { ...OLD, localKey: 'something-else' },
    next: { ...NEW, localKey: DEV_FALLBACKS.localEncryptionKey },
  });
  assert.ok(enc.some((r) => /development passphrase/.test(r)));
});

test('a valid pair produces no refusals', () => {
  assert.deepEqual(validateConfigs(CONFIGS, { nodeEnv: 'test' }), []);
});

test('the CLI refuses before touching the database when the configuration is wrong', async () => {
  let connected = false;
  const verdict = await runMigration({
    argv: ['--execute'],
    connect: async () => {
      connected = true;
    },
    disconnect: async () => {},
    env: {}, // nothing configured at all
  });

  assert.equal(verdict.refused, true);
  assert.equal(connected, false, 'it must not even connect');
  assert.ok(verdict.reasons.length > 0);
});

test('--execute is required: the default is a dry run', async () => {
  await seedOldEmployee();
  const before_ = await rawEmployee('SI0001');

  const verdict = await runMigration({
    argv: [],
    connect: async () => {},
    disconnect: async () => {},
    env: {
      HRMS_CRYPTO_DRIVER: NEW.driver,
      HRMS_LOCAL_ENCRYPTION_KEY: NEW.localKey,
      HRMS_BLIND_INDEX_KEY: NEW.blindIndexKey,
    },
  });

  assert.equal(verdict.dryRun, true);
  assert.equal(verdict.executed, false);
  assert.deepEqual((await rawEmployee('SI0001')).panNumberEnc, before_.panNumberEnc);
});

// ---------------------------------------------------------------------------
// Failing safely
// ---------------------------------------------------------------------------

test('a malformed envelope fails that record and leaves the rest alone', async () => {
  await seedOldEmployee('SI0001');
  await seedOldEmployee('SI0002');
  await Employee.collection.updateOne(
    { employeeCode: 'SI0001' },
    { $set: { panNumberEnc: { v: 1, k: 'local-dev-key-v1', iv: 'x', tag: 'y', ct: 'rubbish' } } },
  );

  const stats = await migrateSource(employeeSource, CONFIGS, { execute: true });

  assert.equal(stats.failures.length, 1, 'the broken record is reported');
  assert.equal(stats.documentsWithEncryptedData, 1, 'the healthy one still migrated');

  // The healthy employee is fully migrated...
  const ok = await rawEmployee('SI0002');
  assert.equal(
    await withCryptoConfig(NEW, () => decryptField(ok.panNumberEnc)),
    seededValues.get('SI0002').pan,
  );

  // ...and the broken one was not partially rewritten.
  const broken = await rawEmployee('SI0001');
  assert.equal(broken.panNumberEnc.ct, 'rubbish', 'left exactly as found');
  assert.ok(
    await withCryptoConfig(OLD, () => decryptField(broken.aadhaarNumberEnc)),
    'its other fields are untouched too',
  );
});

test('the failure report names the record and never the field content', async () => {
  await seedOldEmployee('SI0001');
  await Employee.collection.updateOne(
    { employeeCode: 'SI0001' },
    { $set: { panNumberEnc: { v: 1, k: 'local-dev-key-v1', iv: 'x', tag: 'y', ct: 'rubbish' } } },
  );

  const stats = await migrateSource(employeeSource, CONFIGS, { execute: false });
  const text = JSON.stringify(stats);
  assert.doesNotMatch(text, new RegExp(seededValues.get('SI0001').pan));
  assert.doesNotMatch(text, /ABCDE|123456789012/);
});

// ---------------------------------------------------------------------------
// No plaintext escapes
// ---------------------------------------------------------------------------

test('nothing the migration prints or returns contains a decrypted value', async () => {
  await seedOldEmployee();

  const lines = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));

  let verdict;
  try {
    verdict = await runMigration({
      argv: ['--execute'],
      connect: async () => {},
      disconnect: async () => {},
      env: {
        HRMS_CRYPTO_DRIVER: NEW.driver,
        HRMS_LOCAL_ENCRYPTION_KEY: NEW.localKey,
        HRMS_BLIND_INDEX_KEY: NEW.blindIndexKey,
      },
    });
  } finally {
    console.log = realLog;
    console.error = realError;
  }

  const output = lines.join('\n') + JSON.stringify(verdict);
  const seeded = seededValues.get('SI0001');
  for (const secret of [seeded.pan, seeded.aadhaar, '123456789012', NEW.localKey, NEW.blindIndexKey, OLD.localKey]) {
    assert.doesNotMatch(output, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `"${secret.slice(0, 6)}…" must not be printed`);
  }
});

test('no plaintext is left in the database after migration', async () => {
  await seedOldEmployee();
  await migrateSource(employeeSource, CONFIGS, { execute: true });

  const raw = await rawEmployee('SI0001');
  const { pan } = seededValues.get('SI0001');
  const asText = JSON.stringify(raw);
  assert.doesNotMatch(asText, new RegExp(pan), 'the PAN must not appear anywhere in the document');
  // And no bare field beside the envelope.
  for (const f of ['panNumber', 'aadhaarNumber', 'bankAccountNumber']) {
    assert.equal(raw[f], undefined, `${f} must not exist as plaintext`);
    assert.ok(isEncryptedEnvelope(raw[encPath(f)]));
  }
});

// ---------------------------------------------------------------------------
// What the migration must NOT touch
// ---------------------------------------------------------------------------

test('identity, linkage and every non-sensitive field are left exactly as they were', async () => {
  await seedOldEmployee('SI0001');
  const before_ = await rawEmployee('SI0001');

  await migrateSource(employeeSource, CONFIGS, { execute: true });
  const after = await rawEmployee('SI0001');

  const SENSITIVE = new Set([
    encPath('panNumber'), idxPath('panNumber'),
    encPath('aadhaarNumber'), idxPath('aadhaarNumber'),
    encPath('bankAccountNumber'),
  ]);
  for (const key of Object.keys(before_)) {
    if (SENSITIVE.has(key)) continue;
    assert.deepEqual(after[key], before_[key], `${key} must not change`);
  }
  assert.equal(String(after.userId), String(before_.userId), 'the login linkage is untouched');
  assert.equal(after.employeeCode, 'SI0001');
});

test('an employee with no login keeps userId null through the migration', async () => {
  const built = await withCryptoConfig(OLD, async () => ({
    panNumberEnc: await encryptField('ZZZZZ9999Z'),
    panNumberIdx: blindIndex('ZZZZZ9999Z'),
  }));
  await Employee.collection.insertOne({
    employeeCode: 'SI0017',
    firstName: 'No',
    lastName: 'Login',
    dateOfJoining: new Date('2025-01-01'),
    employmentType: 'full_time',
    status: 'active',
    userId: null,
    managerChain: [],
    deletedAt: null,
    ...built,
  });

  await migrateSource(employeeSource, CONFIGS, { execute: true });

  const after = await rawEmployee('SI0017');
  assert.equal(after.userId, null, 'SI0017 must still have no login');
  assert.equal(await withCryptoConfig(NEW, () => decryptField(after.panNumberEnc)), 'ZZZZZ9999Z');
});

test('the employee count is unchanged and nothing is duplicated', async () => {
  for (const code of ['SI0001', 'SI0002', 'SI0003']) await seedOldEmployee(code);

  const before_ = await Employee.collection.countDocuments();
  await migrateSource(employeeSource, CONFIGS, { execute: true });

  assert.equal(await Employee.collection.countDocuments(), before_);
  const codes = (await Employee.collection.find({}).project({ employeeCode: 1 }).toArray())
    .map((e) => e.employeeCode);
  assert.deepEqual([...new Set(codes)].sort(), ['SI0001', 'SI0002', 'SI0003']);
});

// ---------------------------------------------------------------------------
// Configuration plumbing
// ---------------------------------------------------------------------------

test('the environment is restored even when the work throws', async () => {
  process.env.HRMS_BLIND_INDEX_KEY = 'sentinel-value';
  try {
    await assert.rejects(
      withCryptoConfig(NEW, async () => {
        throw new Error('boom');
      }),
    );
    assert.equal(process.env.HRMS_BLIND_INDEX_KEY, 'sentinel-value', 'restored after a throw');
  } finally {
    delete process.env.HRMS_BLIND_INDEX_KEY;
  }
});

test('the source configuration defaults to the committed development fallbacks', () => {
  const { old } = readConfigs({});
  assert.equal(old.driver, 'local');
  assert.equal(old.localKey, DEV_FALLBACKS.localEncryptionKey);
  assert.equal(old.blindIndexKey, DEV_FALLBACKS.blindIndexKey);
});

test('the target defaults to kms in production, so an unset driver cannot mean local', () => {
  const { next } = readConfigs({ NODE_ENV: 'production' });
  assert.equal(next.driver, 'kms');
});

test('argument parsing: dry run is the default', () => {
  assert.deepEqual(parseArgs([]).execute, false);
  assert.deepEqual(parseArgs(['--execute']).execute, true);
  assert.deepEqual(parseArgs(['--verify']).verify, true);
  assert.deepEqual(parseArgs(['--execute', '--dry-run']).execute, false);
});
