/**
 * Shared constants, sensitive-field helpers and Zod building blocks.
 *
 * Covers Phase 0 verification requirements 3, 6, 7 and 11 at the shared layer;
 * the enforcement points are tested alongside their own milestones.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RETENTION_CATEGORY_LIST,
  RETENTION_ACTIONS,
  DEFAULT_RETENTION_POLICY,
  RETENTION_EXEMPT_AUDIT_ACTIONS,
  AUDIT_ACTIONS,
  STORAGE_CATEGORY_LIST,
  STORAGE_PREFIXES,
  PRESIGNED_URL_TTL,
  MAX_UPLOAD_BYTES,
  STORAGE_CATEGORIES,
  INDIAN_STATE_CODES,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  HRMS_API_PREFIX,
  HRMS_ROUTE_PREFIX,
  CONSENT_PURPOSE_LIST,
} from '../shared/constants/hrms.js';

import {
  SENSITIVE_EMPLOYEE_FIELD_LIST,
  SENSITIVE_EMPLOYEE_FIELDS,
  BLIND_INDEXED_FIELDS,
  reservedFieldFor,
  isReservedCustomFieldKey,
  normaliseFieldKey,
  normaliseSensitiveValue,
  maskSensitiveValue,
} from '../shared/security/sensitive-fields.js';

import {
  objectId,
  isoDay,
  phone10,
  stateCode,
  moneyString,
  money,
  paginationQuery,
  retentionRule,
  customFieldValues,
  formatZodIssues,
} from '../shared/validation/common.js';

// ---------------------------------------------------------------------------
// AD-16 retention constants
// ---------------------------------------------------------------------------

test('AD-16: the two decided categories carry their decided values', () => {
  assert.deepEqual(DEFAULT_RETENTION_POLICY.attendanceSelfies, {
    days: 90,
    action: RETENTION_ACTIONS.DELETE,
  });
  assert.deepEqual(DEFAULT_RETENTION_POLICY.auditLog, {
    days: 1095,
    action: RETENTION_ACTIONS.ARCHIVE,
  });
});

test('AD-16: an undecided category retains rather than deletes', () => {
  const decided = ['attendanceSelfies', 'auditLog'];
  for (const category of RETENTION_CATEGORY_LIST) {
    const rule = DEFAULT_RETENTION_POLICY[category];
    assert.ok(rule, `${category} must have a seed rule`);
    if (decided.includes(category)) continue;
    assert.equal(rule.days, null, `${category} must default to indefinite retention`);
    assert.equal(
      rule.action,
      RETENTION_ACTIONS.RETAIN,
      `${category} must fail toward keeping data, never deleting`,
    );
  }
});

test('AD-16: the retention sweep audit trail is exempt from its own window', () => {
  assert.ok(RETENTION_EXEMPT_AUDIT_ACTIONS.includes(AUDIT_ACTIONS.RETENTION_SWEEP));
  assert.ok(RETENTION_EXEMPT_AUDIT_ACTIONS.includes(AUDIT_ACTIONS.RETENTION_CONFIG_CHANGED));
});

// ---------------------------------------------------------------------------
// AD-7 storage constants
// ---------------------------------------------------------------------------

test('AD-7: every storage category has a key prefix', () => {
  for (const c of STORAGE_CATEGORY_LIST) {
    assert.ok(STORAGE_PREFIXES[c], `${c} needs a prefix`);
    assert.ok(STORAGE_PREFIXES[c].startsWith('hrms/'), `${c} prefix must be namespaced`);
  }
});

test('AD-15: a selfie URL is shorter-lived, and a selfie upload is capped tighter', () => {
  assert.ok(PRESIGNED_URL_TTL.SELFIE < PRESIGNED_URL_TTL.DEFAULT);
  assert.equal(PRESIGNED_URL_TTL.SELFIE, 60);
  assert.ok(
    MAX_UPLOAD_BYTES[STORAGE_CATEGORIES.ATTENDANCE_SELFIE] < MAX_UPLOAD_BYTES.DEFAULT,
    'the global 10 MB cap is far too generous for a selfie',
  );
});

// ---------------------------------------------------------------------------
// AD-12: no hardcoded state
// ---------------------------------------------------------------------------

test('AD-12: state codes are a format vocabulary, not a configuration', () => {
  // The full set of Indian states/UTs, with nothing singled out as a default.
  assert.ok(INDIAN_STATE_CODES.length > 30);
  assert.ok(INDIAN_STATE_CODES.includes('KA'));
  assert.ok(INDIAN_STATE_CODES.includes('MP'));
  assert.equal(new Set(INDIAN_STATE_CODES).size, INDIAN_STATE_CODES.length);
});

// ---------------------------------------------------------------------------
// AD-14 route prefixes
// ---------------------------------------------------------------------------

test('AD-14: HRMS lives under the existing domain on /hrms', () => {
  assert.equal(HRMS_ROUTE_PREFIX, '/hrms');
  assert.equal(HRMS_API_PREFIX, '/api/v1/hrms');
});

// ---------------------------------------------------------------------------
// AD-10 / AD-11 sensitive fields
// ---------------------------------------------------------------------------

test('AD-10: the sensitive field set covers the decided list', () => {
  for (const f of ['panNumber', 'bankAccountNumber', 'bankIfsc', 'aadhaarNumber']) {
    assert.ok(SENSITIVE_EMPLOYEE_FIELD_LIST.includes(f), `${f} must be sensitive`);
  }
  // Only the fields whose uniqueness must hold get a blind index.
  assert.deepEqual(BLIND_INDEXED_FIELDS, [
    SENSITIVE_EMPLOYEE_FIELDS.PAN_NUMBER,
    SENSITIVE_EMPLOYEE_FIELDS.AADHAAR_NUMBER,
  ]);
});

test('AD-11: reserved key matching ignores case and separators', () => {
  const variants = [
    'bank_account_number',
    'Bank Account Number',
    'bankAccountNumber',
    'BANK-ACCOUNT-NUMBER',
    'bank account number',
  ];
  for (const v of variants) {
    assert.equal(
      reservedFieldFor(v),
      SENSITIVE_EMPLOYEE_FIELDS.BANK_ACCOUNT_NUMBER,
      `${v} must map to bankAccountNumber`,
    );
  }
  assert.equal(reservedFieldFor('bank_ifsc'), SENSITIVE_EMPLOYEE_FIELDS.BANK_IFSC);
  assert.equal(reservedFieldFor('IFSC'), SENSITIVE_EMPLOYEE_FIELDS.BANK_IFSC);
  assert.equal(reservedFieldFor('pan'), SENSITIVE_EMPLOYEE_FIELDS.PAN_NUMBER);
  assert.equal(reservedFieldFor('Aadhar No'), SENSITIVE_EMPLOYEE_FIELDS.AADHAAR_NUMBER);
  assert.equal(reservedFieldFor('uan'), SENSITIVE_EMPLOYEE_FIELDS.UAN_NUMBER);
});

test('AD-11: the exact keys the DTA reference reads are covered', () => {
  // bank-file.service.ts reads cfv.bank_account_number / cfv.bank_ifsc / bank_name.
  assert.equal(isReservedCustomFieldKey('bank_account_number'), true);
  assert.equal(isReservedCustomFieldKey('bank_ifsc'), true);
  // bank_name is not sensitive and must pass through untouched.
  assert.equal(isReservedCustomFieldKey('bank_name'), false);
});

test('AD-11: ordinary custom fields are not treated as reserved', () => {
  for (const k of ['tshirtSize', 'favourite_colour', 'blood_group', 'notes', '', null, undefined]) {
    assert.equal(isReservedCustomFieldKey(k), false, `${k} must not be reserved`);
  }
});

test('normaliseFieldKey and normaliseSensitiveValue behave predictably', () => {
  assert.equal(normaliseFieldKey('Bank_Account No.'), 'bankaccountno');
  assert.equal(normaliseFieldKey(null), '');
  // Blind indexes must agree across spacing and case, or uniqueness fails.
  assert.equal(normaliseSensitiveValue('abcde1234f'), 'ABCDE1234F');
  assert.equal(normaliseSensitiveValue('ABCDE 1234 F'), 'ABCDE1234F');
  assert.equal(normaliseSensitiveValue(null), '');
});

test('AD-10: masking keeps only the last four characters', () => {
  assert.equal(maskSensitiveValue('123456789012'), '••••••••9012');
  assert.equal(maskSensitiveValue('ABCDE1234F'), '••••••234F');
  assert.equal(maskSensitiveValue('123'), '•••'); // too short to reveal anything
  assert.equal(maskSensitiveValue(null), null);
  assert.equal(maskSensitiveValue(''), null);
  // The full value never appears in the mask.
  assert.ok(!maskSensitiveValue('123456789012').includes('12345'));
});

// ---------------------------------------------------------------------------
// AD-6 / AD-2 validation
// ---------------------------------------------------------------------------

test('AD-2: an ObjectId is validated, not a UUID', () => {
  assert.equal(objectId.safeParse('507f1f77bcf86cd799439011').success, true);
  assert.equal(objectId.safeParse('not-an-id').success, false);
  assert.equal(objectId.safeParse('3f2504e0-4f89-11d3-9a0c-0305e82c3301').success, false);
});

test('AD-2: money parses to a STRING so Decimal128 never sees a float', () => {
  const ok = moneyString.safeParse('1234.56');
  assert.equal(ok.success, true);
  assert.equal(typeof ok.data, 'string');
  assert.equal(ok.data, '1234.56');

  // A number is accepted for ergonomics but still yields a string.
  const fromNumber = moneyString.safeParse(1000);
  assert.equal(fromNumber.success, true);
  assert.equal(fromNumber.data, '1000');
  assert.equal(typeof fromNumber.data, 'string');

  // Rejections.
  assert.equal(moneyString.safeParse('1234.567').success, false, 'too many decimal places');
  assert.equal(moneyString.safeParse('-5').success, false, 'negative not allowed by default');
  assert.equal(moneyString.safeParse('abc').success, false);
  assert.equal(moneyString.safeParse(Number.NaN).success, false);
  assert.equal(moneyString.safeParse(Infinity).success, false);

  // Signed amounts are opt-in (payroll adjustments).
  const signed = money({ allowNegative: true });
  assert.equal(signed.safeParse('-250.00').success, true);
});

test('AD-13: pagination has defaults and a hard ceiling', () => {
  const d = paginationQuery.parse({});
  assert.equal(d.page, 1);
  assert.equal(d.pageSize, PAGE_SIZE_DEFAULT);
  assert.equal(d.sortDir, 'asc');
  // Query strings arrive as text and must coerce.
  assert.equal(paginationQuery.parse({ page: '3', pageSize: '50' }).pageSize, 50);
  // The ceiling is enforced rather than silently clamped.
  assert.equal(paginationQuery.safeParse({ pageSize: String(PAGE_SIZE_MAX + 1) }).success, false);
  assert.equal(paginationQuery.safeParse({ page: '0' }).success, false);
});

test('AD-16: a retention rule accepts null days and a valid action', () => {
  assert.equal(retentionRule.safeParse({ days: 90, action: 'delete' }).success, true);
  assert.equal(retentionRule.safeParse({ days: null, action: 'retain' }).success, true);
  assert.equal(retentionRule.safeParse({ days: 0, action: 'delete' }).success, false);
  assert.equal(retentionRule.safeParse({ days: 90, action: 'incinerate' }).success, false);
});

test('AD-11: customFieldValues stays permissive - the sanitiser cleans, not the schema', () => {
  // Rejecting here would tell a caller which keys are sensitive and fail the
  // request rather than cleaning it.
  const parsed = customFieldValues.parse({ bank_account_number: '123', tshirtSize: 'L' });
  assert.equal(parsed.bank_account_number, '123');
  assert.deepEqual(customFieldValues.parse(undefined), {});
});

test('assorted field schemas', () => {
  assert.equal(isoDay.safeParse('2026-09-01').success, true);
  assert.equal(isoDay.safeParse('2026-13-01').success, false);
  assert.equal(isoDay.safeParse('01-09-2026').success, false);
  assert.equal(phone10.safeParse('9876543210').success, true);
  assert.equal(phone10.safeParse('98765').success, false);
  assert.equal(stateCode.safeParse('MP').success, true);
  assert.equal(stateCode.safeParse('XX').success, false);
});

test('Zod issues flatten into a stable API shape', () => {
  const r = paginationQuery.safeParse({ page: '0' });
  assert.equal(r.success, false);
  const issues = formatZodIssues(r.error);
  assert.ok(Array.isArray(issues));
  assert.ok(issues.length > 0);
  assert.equal(typeof issues[0].path, 'string');
  assert.equal(typeof issues[0].message, 'string');
  assert.deepEqual(formatZodIssues(undefined), []);
});

test('consent purposes cover selfie and location separately (AD-15)', () => {
  assert.equal(CONSENT_PURPOSE_LIST.length, 2);
  assert.ok(CONSENT_PURPOSE_LIST.includes('attendance_selfie'));
  assert.ok(CONSENT_PURPOSE_LIST.includes('attendance_location'));
});
