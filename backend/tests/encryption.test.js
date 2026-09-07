/**
 * Sensitive-field encryption (AD-10) and customFieldValues sanitisation (AD-11).
 *
 * Phase 0 verification requirements 3 and 4:
 *   3. Sensitive fields are masked by default.
 *   4. Sensitive fields cannot be written through customFieldValues.
 *
 * Runs against the `local` key provider. The KMS driver shares the interface
 * exactly, so everything above the provider is the same code in production.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import {
  encryptField,
  decryptField,
  isEncryptedEnvelope,
  blindIndex,
  maskSensitiveValue,
  readSensitiveField,
  sanitiseCustomFields,
  getKeyProvider,
  __resetCrypto,
} from '../utils/hrms/crypto/index.js';
import { createLocalKeyProvider } from '../utils/hrms/crypto/local.js';
import { sensitiveFields, encPath, idxPath } from '../models/hrms/plugins/sensitiveFields.js';
import {
  SENSITIVE_EMPLOYEE_FIELDS as F,
  SENSITIVE_EMPLOYEE_FIELD_LIST,
} from '../shared/security/sensitive-fields.js';

// ---------------------------------------------------------------------------
// Envelope encryption
// ---------------------------------------------------------------------------

test('a value round-trips through encryption', async () => {
  const envelope = await encryptField('ABCDE1234F');
  assert.equal(isEncryptedEnvelope(envelope), true);
  assert.equal(await decryptField(envelope), 'ABCDE1234F');
});

test('the ciphertext never contains the plaintext', async () => {
  const secret = '123456789012';
  const envelope = await encryptField(secret);
  const serialised = JSON.stringify(envelope);
  assert.ok(!serialised.includes(secret), 'plaintext must not survive in the envelope');
  assert.ok(!Buffer.from(envelope.ct, 'base64').toString('utf8').includes(secret));
});

test('encrypting the same value twice produces different ciphertext', async () => {
  // A random IV per write. This is exactly why an encrypted field cannot be
  // queried by equality, and why blind indexes exist.
  const a = await encryptField('SAME VALUE');
  const b = await encryptField('SAME VALUE');
  assert.notEqual(a.ct, b.ct);
  assert.notEqual(a.iv, b.iv);
  assert.equal(await decryptField(a), await decryptField(b));
});

test('empty values encrypt to null rather than to an envelope', async () => {
  for (const v of [null, undefined, '']) {
    assert.equal(await encryptField(v), null);
  }
  assert.equal(await decryptField(null), null);
});

test('a tampered ciphertext is rejected, not silently mis-decrypted', async () => {
  const envelope = await encryptField('ABCDE1234F');

  const flipped = { ...envelope, ct: Buffer.from('totally different', 'utf8').toString('base64') };
  await assert.rejects(() => decryptField(flipped), 'GCM must reject a modified ciphertext');

  const badTag = { ...envelope, tag: Buffer.alloc(16).toString('base64') };
  await assert.rejects(() => decryptField(badTag));
});

test('a malformed or future-versioned envelope is refused', async () => {
  await assert.rejects(() => decryptField({ ct: 'x' }), /malformed envelope/);
  await assert.rejects(() => decryptField({ v: 99, k: 'a', iv: 'b', tag: 'c', ct: 'd' }), /version/);
});

test('the encrypted data key travels with the ciphertext, so rotation is non-breaking', async () => {
  const envelope = await encryptField('ABCDE1234F');
  assert.ok(envelope.k, 'the wrapped key must be part of the envelope');
  // Cached provider dropped, as if the process restarted with a new data key.
  __resetCrypto();
  assert.equal(await decryptField(envelope), 'ABCDE1234F');
});

test('the local driver refuses to run in production', () => {
  const prev = process.env.NODE_ENV;
  const prevDriver = process.env.HRMS_CRYPTO_DRIVER;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.HRMS_CRYPTO_DRIVER;
    assert.throws(() => createLocalKeyProvider(), /Refusing to use the local crypto driver/);
  } finally {
    process.env.NODE_ENV = prev;
    if (prevDriver === undefined) delete process.env.HRMS_CRYPTO_DRIVER;
    else process.env.HRMS_CRYPTO_DRIVER = prevDriver;
  }
});

test('the active provider is the local one under test', () => {
  assert.equal(getKeyProvider().name, 'local');
});

// ---------------------------------------------------------------------------
// Blind index
// ---------------------------------------------------------------------------

test('a blind index is deterministic and normalises its input', () => {
  const a = blindIndex('abcde1234f');
  const b = blindIndex('ABCDE 1234 F');
  assert.equal(a, b, 'case and spacing must not produce a different index');
  assert.notEqual(blindIndex('ABCDE1234F'), blindIndex('ZZZZZ9999Z'));
  assert.equal(blindIndex(null), null);
  assert.equal(blindIndex(''), null);
});

test('a blind index does not reveal its input', () => {
  const idx = blindIndex('ABCDE1234F');
  assert.ok(!idx.includes('ABCDE'));
  assert.match(idx, /^[0-9a-f]{64}$/, 'HMAC-SHA256 hex');
});

test('blind indexing refuses a development key in production', () => {
  const prevEnv = process.env.NODE_ENV;
  const prevKey = process.env.HRMS_BLIND_INDEX_KEY;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.HRMS_BLIND_INDEX_KEY;
    assert.throws(() => blindIndex('ABCDE1234F'), /HRMS_BLIND_INDEX_KEY must be set/);
  } finally {
    process.env.NODE_ENV = prevEnv;
    if (prevKey === undefined) delete process.env.HRMS_BLIND_INDEX_KEY;
    else process.env.HRMS_BLIND_INDEX_KEY = prevKey;
  }
});

// ---------------------------------------------------------------------------
// Masking (verification requirement 3)
// ---------------------------------------------------------------------------

test('reading a sensitive field masks by default and reveals only on request', async () => {
  const envelope = await encryptField('123456789012');
  assert.equal(await readSensitiveField(envelope), '••••••••9012');
  assert.equal(await readSensitiveField(envelope, { reveal: true }), '123456789012');
  assert.equal(await readSensitiveField(null), null);
});

// ---------------------------------------------------------------------------
// The Mongoose plugin
// ---------------------------------------------------------------------------

/** A throwaway schema, so the plugin is tested without a business model. */
function makeModel(name) {
  const schema = new mongoose.Schema({ code: String, customFieldValues: {} });
  schema.plugin(sensitiveFields, {
    fields: [F.PAN_NUMBER, F.BANK_ACCOUNT_NUMBER],
    blindIndexed: [F.PAN_NUMBER],
  });
  return mongoose.model(name, schema);
}

test('plugin: a value is stored encrypted and read back masked', async () => {
  const M = makeModel('SensitiveTestA');
  const doc = new M({ code: 'E1' });

  await doc.setSensitive(F.PAN_NUMBER, 'ABCDE1234F');

  // What is actually stored is an envelope, not the value.
  const stored = doc.get(encPath(F.PAN_NUMBER));
  assert.equal(isEncryptedEnvelope(stored), true);
  assert.ok(!JSON.stringify(stored).includes('ABCDE1234F'));

  assert.equal(await doc.readSensitive(F.PAN_NUMBER), '••••••234F');
  assert.equal(await doc.readSensitive(F.PAN_NUMBER, { reveal: true }), 'ABCDE1234F');
  assert.equal(doc.hasSensitive(F.PAN_NUMBER), true);
  assert.equal(doc.hasSensitive(F.BANK_ACCOUNT_NUMBER), false);
});

test('plugin: toJSON never emits plaintext, ciphertext or the blind index', async () => {
  const M = makeModel('SensitiveTestB');
  const doc = new M({ code: 'E2' });
  await doc.setSensitive(F.PAN_NUMBER, 'ABCDE1234F');
  await doc.setSensitive(F.BANK_ACCOUNT_NUMBER, '123456789012');

  const json = JSON.stringify(doc.toJSON());

  assert.ok(!json.includes('ABCDE1234F'), 'PAN must not appear in JSON');
  assert.ok(!json.includes('123456789012'), 'account number must not appear in JSON');
  assert.ok(!json.includes(encPath(F.PAN_NUMBER)), 'the envelope path must be stripped');
  assert.ok(!json.includes(idxPath(F.PAN_NUMBER)), 'the blind index must be stripped');

  // What the client does see: presence, and nothing else.
  const obj = doc.toJSON();
  assert.equal(obj[F.PAN_NUMBER], true);
  assert.equal(obj[F.BANK_ACCOUNT_NUMBER], true);
});

test('plugin: an unset sensitive field serialises as null', async () => {
  const M = makeModel('SensitiveTestC');
  const doc = new M({ code: 'E3' });
  const obj = doc.toJSON();
  assert.equal(obj[F.PAN_NUMBER], null);
  assert.equal(obj[F.BANK_ACCOUNT_NUMBER], null);
});

test('plugin: writing plaintext directly to the field is refused loudly', async () => {
  const M = makeModel('SensitiveTestD');
  const doc = new M({ code: 'E4' });
  // Strict mode would normally drop this silently, and the value would appear
  // to save while vanishing.
  doc.set(F.PAN_NUMBER, 'ABCDE1234F', { strict: false });
  await assert.rejects(() => doc.validate(), /Refusing to store "panNumber" as plaintext/);
});

test('plugin: setSensitive rejects a field the schema did not declare', async () => {
  const M = makeModel('SensitiveTestE');
  const doc = new M({ code: 'E5' });
  await assert.rejects(
    () => doc.setSensitive('notADeclaredField', 'x'),
    /not a declared sensitive field/,
  );
});

test('plugin: a field without a blind index cannot be searched', () => {
  const M = makeModel('SensitiveTestF');
  assert.throws(
    () => M.findBySensitive(F.BANK_ACCOUNT_NUMBER, '123'),
    /has no blind index/,
  );
});

test('plugin: the envelope and index paths are select:false', () => {
  const M = makeModel('SensitiveTestG');
  assert.equal(M.schema.path(encPath(F.PAN_NUMBER)).options.select, false);
  assert.equal(M.schema.path(idxPath(F.PAN_NUMBER)).options.select, false);
});

// ---------------------------------------------------------------------------
// customFieldValues sanitisation (verification requirement 4)
// ---------------------------------------------------------------------------

test('AD-11: reserved keys are extracted out of customFieldValues', () => {
  const { clean, extracted, warnings } = sanitiseCustomFields({
    // The exact keys the DTA bank-file service reads.
    bank_account_number: '123456789012',
    bank_ifsc: 'HDFC0001234',
    // ...and one that is not sensitive.
    bank_name: 'HDFC Bank',
    tshirtSize: 'L',
  });

  assert.equal(extracted[F.BANK_ACCOUNT_NUMBER], '123456789012');
  assert.equal(extracted[F.BANK_IFSC], 'HDFC0001234');

  // The plaintext is GONE from what will be written.
  assert.equal('bank_account_number' in clean, false);
  assert.equal('bank_ifsc' in clean, false);
  assert.ok(!JSON.stringify(clean).includes('123456789012'));

  // Ordinary fields pass through untouched.
  assert.equal(clean.bank_name, 'HDFC Bank');
  assert.equal(clean.tshirtSize, 'L');

  assert.ok(warnings.length >= 2, 'the caller must be told what was moved');
});

test('AD-11: every reserved spelling is caught', () => {
  const { clean, extracted } = sanitiseCustomFields({
    'PAN Card': 'ABCDE1234F',
    'Aadhaar No': '123412341234',
    UAN: '100200300400',
    'esic number': '3100000000',
    passportNo: 'Z1234567',
    'IFSC Code': 'ICIC0000001',
    'Account Number': '999888777',
  });
  assert.equal(Object.keys(clean).length, 0, 'nothing sensitive may remain');
  assert.equal(extracted[F.PAN_NUMBER], 'ABCDE1234F');
  assert.equal(extracted[F.AADHAAR_NUMBER], '123412341234');
  assert.equal(extracted[F.UAN_NUMBER], '100200300400');
  assert.equal(extracted[F.ESI_NUMBER], '3100000000');
  assert.equal(extracted[F.PASSPORT_NUMBER], 'Z1234567');
  assert.equal(extracted[F.BANK_IFSC], 'ICIC0000001');
  assert.equal(extracted[F.BANK_ACCOUNT_NUMBER], '999888777');
});

test('AD-11: an empty reserved value is dropped, not carried as an empty string', () => {
  const { clean, extracted, warnings } = sanitiseCustomFields({ pan: '', tshirtSize: 'M' });
  assert.equal('pan' in clean, false);
  assert.equal(F.PAN_NUMBER in extracted, false);
  assert.deepEqual(Object.keys(clean), ['tshirtSize']);
  assert.match(warnings[0], /Dropped empty/);
});

test('AD-11: duplicate spellings do not silently overwrite each other', () => {
  const { extracted, warnings } = sanitiseCustomFields({
    pan: 'FIRST12345',
    'PAN Number': 'SECOND6789',
  });
  assert.equal(extracted[F.PAN_NUMBER], 'FIRST12345', 'first wins');
  assert.ok(warnings.some((w) => /duplicates/.test(w)), 'the conflict must be reported');
});

test('AD-11: sanitising does not mutate the caller input', () => {
  const input = { bank_ifsc: 'HDFC0001234', tshirtSize: 'L' };
  const snapshot = JSON.stringify(input);
  sanitiseCustomFields(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test('AD-11: an empty or missing blob is handled', () => {
  assert.deepEqual(sanitiseCustomFields({}), { clean: {}, extracted: {}, warnings: [] });
  assert.deepEqual(sanitiseCustomFields(), { clean: {}, extracted: {}, warnings: [] });
  assert.deepEqual(sanitiseCustomFields(null), { clean: {}, extracted: {}, warnings: [] });
});

test('AD-10: every declared sensitive field can be encrypted and masked', async () => {
  for (const field of SENSITIVE_EMPLOYEE_FIELD_LIST) {
    const envelope = await encryptField(`value-for-${field}`);
    assert.equal(isEncryptedEnvelope(envelope), true, `${field} must encrypt`);
    const masked = maskSensitiveValue(await decryptField(envelope));
    assert.ok(masked.startsWith('•'), `${field} must mask`);
  }
});
