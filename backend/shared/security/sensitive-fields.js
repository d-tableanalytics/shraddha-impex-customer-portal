/**
 * Sensitive employee fields (AD-10) and the reserved keys that must never be
 * allowed to survive inside `customFieldValues` (AD-11).
 *
 * Dependency-free so the sanitiser, the Mongoose schema, the import pipeline and
 * a pre-install verification script can all import it.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * The DTA reference stores bank account numbers and IFSC codes in
 * `Employee.customFieldValues` - an unencrypted JSON blob that its
 * `GET /employees/:id` returns wholesale. `bank-file.service.ts` reads them
 * straight out of it:
 *
 *     const acct = String(cfv.bank_account_number ?? '').trim();
 *     const ifsc = String(cfv.bank_ifsc ?? '').trim();
 *
 * AD-10 closes that: these values move into dedicated encrypted fields, and the
 * plaintext must never reach a database write. The list below is what the
 * sanitiser scans for.
 */

/** Canonical sensitive field names on the employee record. */
export const SENSITIVE_EMPLOYEE_FIELDS = Object.freeze({
  PAN_NUMBER: 'panNumber',
  BANK_ACCOUNT_NUMBER: 'bankAccountNumber',
  BANK_IFSC: 'bankIfsc',
  AADHAAR_NUMBER: 'aadhaarNumber',
  UAN_NUMBER: 'uanNumber',
  ESI_NUMBER: 'esiNumber',
  PASSPORT_NUMBER: 'passportNumber',
});

export const SENSITIVE_EMPLOYEE_FIELD_LIST = Object.freeze(
  Object.values(SENSITIVE_EMPLOYEE_FIELDS),
);

/**
 * Fields whose uniqueness must be enforceable, so they carry a blind index
 * (HMAC of the normalised value) alongside the ciphertext.
 *
 * Encrypted values are not searchable: a random IV makes the ciphertext differ
 * on every write, so equality lookups fail. The blind index is deterministic,
 * uniquely indexable, and not reversible.
 */
export const BLIND_INDEXED_FIELDS = Object.freeze([
  SENSITIVE_EMPLOYEE_FIELDS.PAN_NUMBER,
  SENSITIVE_EMPLOYEE_FIELDS.AADHAAR_NUMBER,
]);

/**
 * How many trailing characters stay visible when a value is masked.
 * `••••1234` for an account number, `••••••234F` for a PAN.
 */
export const MASK_VISIBLE_SUFFIX = 4;

/**
 * Reserved keys the sanitiser strips out of `customFieldValues`.
 *
 * Written in the loosest form the comparison needs: matching is done on a
 * normalised key (lowercased, with every non-alphanumeric character removed),
 * so `bank_account_number`, `Bank Account Number`, `bankAccountNumber` and
 * `BANK-ACCOUNT-NUMBER` all collapse to the same entry.
 */
const RESERVED_CUSTOM_FIELD_KEYS = Object.freeze({
  // bank
  bankaccountnumber: SENSITIVE_EMPLOYEE_FIELDS.BANK_ACCOUNT_NUMBER,
  bankaccount: SENSITIVE_EMPLOYEE_FIELDS.BANK_ACCOUNT_NUMBER,
  bankacct: SENSITIVE_EMPLOYEE_FIELDS.BANK_ACCOUNT_NUMBER,
  accountnumber: SENSITIVE_EMPLOYEE_FIELDS.BANK_ACCOUNT_NUMBER,
  accountno: SENSITIVE_EMPLOYEE_FIELDS.BANK_ACCOUNT_NUMBER,
  acno: SENSITIVE_EMPLOYEE_FIELDS.BANK_ACCOUNT_NUMBER,
  bankifsc: SENSITIVE_EMPLOYEE_FIELDS.BANK_IFSC,
  ifsc: SENSITIVE_EMPLOYEE_FIELDS.BANK_IFSC,
  ifsccode: SENSITIVE_EMPLOYEE_FIELDS.BANK_IFSC,

  // tax / government identifiers
  pan: SENSITIVE_EMPLOYEE_FIELDS.PAN_NUMBER,
  pannumber: SENSITIVE_EMPLOYEE_FIELDS.PAN_NUMBER,
  panno: SENSITIVE_EMPLOYEE_FIELDS.PAN_NUMBER,
  pancard: SENSITIVE_EMPLOYEE_FIELDS.PAN_NUMBER,
  // Both spellings, and both the `number` and `no` suffixes, because HR
  // spreadsheets use all four interchangeably.
  aadhaar: SENSITIVE_EMPLOYEE_FIELDS.AADHAAR_NUMBER,
  aadhar: SENSITIVE_EMPLOYEE_FIELDS.AADHAAR_NUMBER,
  aadhaarnumber: SENSITIVE_EMPLOYEE_FIELDS.AADHAAR_NUMBER,
  aadharnumber: SENSITIVE_EMPLOYEE_FIELDS.AADHAAR_NUMBER,
  aadhaarno: SENSITIVE_EMPLOYEE_FIELDS.AADHAAR_NUMBER,
  aadharno: SENSITIVE_EMPLOYEE_FIELDS.AADHAAR_NUMBER,
  aadhaarcard: SENSITIVE_EMPLOYEE_FIELDS.AADHAAR_NUMBER,
  aadharcard: SENSITIVE_EMPLOYEE_FIELDS.AADHAAR_NUMBER,

  uan: SENSITIVE_EMPLOYEE_FIELDS.UAN_NUMBER,
  uannumber: SENSITIVE_EMPLOYEE_FIELDS.UAN_NUMBER,
  uanno: SENSITIVE_EMPLOYEE_FIELDS.UAN_NUMBER,

  esi: SENSITIVE_EMPLOYEE_FIELDS.ESI_NUMBER,
  esinumber: SENSITIVE_EMPLOYEE_FIELDS.ESI_NUMBER,
  esino: SENSITIVE_EMPLOYEE_FIELDS.ESI_NUMBER,
  esic: SENSITIVE_EMPLOYEE_FIELDS.ESI_NUMBER,
  esicnumber: SENSITIVE_EMPLOYEE_FIELDS.ESI_NUMBER,

  passport: SENSITIVE_EMPLOYEE_FIELDS.PASSPORT_NUMBER,
  passportnumber: SENSITIVE_EMPLOYEE_FIELDS.PASSPORT_NUMBER,
  passportno: SENSITIVE_EMPLOYEE_FIELDS.PASSPORT_NUMBER,
});

/** Lowercase and drop every non-alphanumeric character. */
export const normaliseFieldKey = (key) =>
  String(key ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * The sensitive field a custom-field key maps to, or `null` if it is ordinary.
 * @returns {string|null}
 */
export function reservedFieldFor(key) {
  return RESERVED_CUSTOM_FIELD_KEYS[normaliseFieldKey(key)] ?? null;
}

/** Is this custom-field key reserved? */
export const isReservedCustomFieldKey = (key) => reservedFieldFor(key) !== null;

/** Every reserved key, normalised. Exposed for verification scripts and tests. */
export const RESERVED_CUSTOM_FIELD_KEY_LIST = Object.freeze(
  Object.keys(RESERVED_CUSTOM_FIELD_KEYS),
);

/**
 * Mask a sensitive value for display, keeping the last few characters.
 * `null` / `undefined` / empty stay `null` so the UI can render a dash.
 */
export function maskSensitiveValue(value, visible = MASK_VISIBLE_SUFFIX) {
  if (value === null || value === undefined) return null;
  const str = String(value);
  if (str.length === 0) return null;
  if (str.length <= visible) return '•'.repeat(str.length);
  return '•'.repeat(str.length - visible) + str.slice(-visible);
}

/**
 * Normalise a sensitive value before hashing it into a blind index, so that
 * `abcde1234f`, `ABCDE1234F` and `ABCDE 1234 F` produce the same index and the
 * uniqueness constraint actually holds.
 */
export const normaliseSensitiveValue = (value) =>
  String(value ?? '')
    .toUpperCase()
    .replace(/\s+/g, '');
