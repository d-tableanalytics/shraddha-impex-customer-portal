/**
 * Forward-looking invariant guards.
 *
 * Phase 0 verification requirements 5, 6, 7 and 12 concern code that later
 * phases will write - payroll, statutory configuration and money fields. These
 * guards exist NOW so the first commit that would violate one fails, rather
 * than the violation being discovered during a payroll run.
 *
 * They scan the HRMS source tree, so they keep holding as it grows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INDIAN_STATE_CODES,
  RETENTION_CATEGORIES,
} from '../shared/constants/hrms.js';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every HRMS source file: the shared module, HRMS modules, models and utils. */
async function hrmsSourceFiles() {
  const roots = [
    path.join(BACKEND, 'shared'),
    path.join(BACKEND, 'modules', 'hrms'),
    path.join(BACKEND, 'models', 'hrms'),
    path.join(BACKEND, 'utils', 'hrms'),
  ];

  const out = [];
  for (const root of roots) {
    const walk = async (dir) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.endsWith('.js')) out.push(full);
      }
    };
    await walk(root);
  }
  return out;
}

/** Source with comments and string literals in comments removed. */
const stripComments = (code) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const readStripped = async (file) => stripComments(await readFile(file, 'utf8'));

// ---------------------------------------------------------------------------
// Requirement 6: no hardcoded state fallback (AD-12)
// ---------------------------------------------------------------------------

test('AD-12: no HRMS source hardcodes a state as a fallback', async () => {
  const files = await hrmsSourceFiles();
  const offenders = [];

  for (const file of files) {
    const code = await readStripped(file);
    // The reference does `let stateCode = 'KA'` in three places, which makes
    // every employee Karnataka unless someone hand-edits a JSON blob.
    if (/\bstateCode\s*=\s*['"][A-Z]{2}['"]/.test(code)) {
      offenders.push(`${path.relative(BACKEND, file)}: assigns a literal stateCode`);
    }
    if (/\b(state|stateCode)\s*(\?\?|\|\|)\s*['"][A-Z]{2}['"]/.test(code)) {
      offenders.push(`${path.relative(BACKEND, file)}: defaults a state with ?? or ||`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `A hardcoded state silently produces the wrong professional tax for everyone:\n${offenders.join('\n')}`,
  );
});

test('AD-12: the state list is a format vocabulary, with nothing singled out', async () => {
  // A complete list is fine. A DEFAULT is not.
  assert.ok(INDIAN_STATE_CODES.length > 30);
  const constants = await readStripped(path.join(BACKEND, 'shared', 'constants', 'hrms.js'));
  assert.doesNotMatch(constants, /DEFAULT_STATE|FALLBACK_STATE|defaultStateCode\s*=/);
});

// ---------------------------------------------------------------------------
// Requirement 5: missing statutory configuration must BLOCK payroll (AD-12)
// ---------------------------------------------------------------------------

test('AD-12: no statutory engine exists yet, so nothing can silently return zero', async () => {
  const files = await hrmsSourceFiles();
  const statutory = files.filter((f) => /statutory|payroll/i.test(path.basename(f)));

  // Phase 3 builds these. The guard asserts the CURRENT state so that, when
  // they appear, this test is the natural place the blocking rule is asserted.
  assert.deepEqual(
    statutory.map((f) => path.relative(BACKEND, f)),
    [],
    'Payroll is Phase 3. When it lands, extend this guard to assert that an ' +
      'unconfigured state raises rather than deducting zero.',
  );
});

// ---------------------------------------------------------------------------
// Requirement 7: money uses Decimal128 (AD-2)
// ---------------------------------------------------------------------------

/** Field names that hold currency and must never be a JS Number. */
const MONEY_FIELDS = [
  'ctc', 'gross', 'netPay', 'totalDeductions', 'employerContributions',
  'amount', 'principal', 'outstanding', 'monthlyInstallment',
  'budgetMin', 'budgetMax', 'expectedSalary', 'total', 'dailyLimit',
  'monthlyLimit', 'autoApproveBelow', 'estimatedBudget', 'advanceRequested',
  'totalAmount', 'netPayable', 'purchasePrice', 'budgetPerHead', 'totalBudget',
];

test('AD-2: no HRMS schema types a money field as Number', async () => {
  const files = (await hrmsSourceFiles()).filter((f) => f.includes(`${path.sep}models${path.sep}`));
  const offenders = [];

  for (const file of files) {
    const code = await readStripped(file);
    for (const field of MONEY_FIELDS) {
      const pattern = new RegExp(`\\b${field}\\s*:\\s*\\{[^}]*type\\s*:\\s*Number`, 's');
      if (pattern.test(code)) {
        offenders.push(`${path.relative(BACKEND, file)}: "${field}" is typed Number`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `JavaScript Number is IEEE-754 and must never hold currency. Use Decimal128:\n${offenders.join('\n')}`,
  );
});

test('AD-2: the shared money schema yields a string, so Decimal128 never sees a float', async () => {
  const code = await readFile(path.join(BACKEND, 'shared', 'validation', 'common.js'), 'utf8');
  assert.match(code, /Decimal128/, 'the reasoning must be recorded where the schema lives');
  const { moneyString } = await import('../shared/validation/common.js');
  assert.equal(typeof moneyString.parse('10.50'), 'string');
  assert.equal(typeof moneyString.parse(10), 'string');
});

// ---------------------------------------------------------------------------
// Requirement 11 (extended): no hardcoded retention window
// ---------------------------------------------------------------------------

test('AD-16: no retention period is written into an HRMS service', async () => {
  const files = (await hrmsSourceFiles()).filter(
    (f) => !f.includes(`${path.sep}constants${path.sep}`),
  );
  const offenders = [];

  for (const file of files) {
    const code = await readStripped(file);
    if (/\b1095\b/.test(code)) offenders.push(`${path.relative(BACKEND, file)}: literal 1095`);
    if (/\b90\s*\*\s*24\s*\*\s*60/.test(code)) {
      offenders.push(`${path.relative(BACKEND, file)}: literal 90-day window`);
    }
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));
  // The seeded values live in constants, which is configuration, not logic.
  assert.ok(RETENTION_CATEGORIES.AUDIT_LOG);
});

// ---------------------------------------------------------------------------
// Requirement 12: the portal is unaffected
// ---------------------------------------------------------------------------

test('no HRMS module is imported by a portal module', async () => {
  const portalDirs = ['auth', 'inventory', 'notifications', 'orders', 'products', 'reservations', 'roles', 'sales', 'users'];
  const offenders = [];

  for (const dir of portalDirs) {
    const root = path.join(BACKEND, 'modules', dir);
    let entries;
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const name of entries.filter((n) => n.endsWith('.js'))) {
      const code = await readFile(path.join(root, name), 'utf8');
      // The shared module is fine - that is the point of it. Importing an HRMS
      // FEATURE module into the portal is not.
      if (/from ['"][^'"]*modules\/hrms\//.test(code)) {
        offenders.push(`modules/${dir}/${name}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `A portal module must not depend on an HRMS feature module:\n${offenders.join('\n')}`,
  );
});

test('the portal auth controller may use shared services - that is deliberate', async () => {
  // Hardening auth was Phase 0 work, so this direction IS expected. Asserted so
  // the guard above is understood as scoping to FEATURE modules, not utilities.
  const code = await readFile(
    path.join(BACKEND, 'modules', 'auth', 'auth.controller.js'),
    'utf8',
  );
  assert.match(code, /utils\/password\.js/);
  assert.match(code, /utils\/tokens\.js/);
  assert.doesNotMatch(code, /modules\/hrms\//);
});
