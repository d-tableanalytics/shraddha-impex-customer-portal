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

/**
 * Payroll has now landed, so this guard does what its previous version asked
 * the first payroll commit to make it do.
 *
 * It used to assert that NO statutory or payroll source existed, with the note
 * "when it lands, extend this guard to assert that an unconfigured state raises
 * rather than deducting zero". That is exactly what the three tests below now
 * assert. The placeholder is replaced rather than deleted — the requirement it
 * stood for is stronger now, not weaker.
 */

test('AD-12: an unconfigured statutory setup BLOCKS payroll rather than deducting zero', async () => {
  const files = await hrmsSourceFiles();
  const statutory = files.filter((f) => /statutory|payroll/i.test(path.basename(f)));

  // The module exists now; the guard's job is to check HOW it behaves.
  assert.ok(statutory.length > 0, 'payroll source is present');

  // 1. A run with no effective configuration must refuse, not proceed.
  const runService = await readStripped(
    path.join(BACKEND, 'modules', 'hrms', 'payroll', 'run.service.js'),
  );
  assert.match(
    runService,
    /resolveEffectiveConfig/,
    'the run must resolve the configuration in force for its month',
  );
  assert.match(
    runService,
    /if\s*\(!config\)[\s\S]{0,400}throw/,
    'a run with no effective statutory configuration must throw, not compute zeros',
  );

  // 2. An employee whose state cannot be resolved must be skipped and
  //    reported, never silently assigned one.
  assert.match(
    runService,
    /if\s*\(!stateCode\)[\s\S]{0,400}skipped\.push/,
    'an unresolved state must skip the employee and report it',
  );

  // 3. The engines must say so explicitly when a state has no rule, rather
  //    than a bare zero that reads identically to "nobody configured this".
  const engines = await readStripped(path.join(BACKEND, 'shared', 'payroll', 'statutory.js'));
  assert.match(engines, /appliesInState:\s*false/, 'PT and LWF report non-applicability');
});

test('AD-12: no statutory rate, ceiling or slab is written into payroll code', async () => {
  // Every one of these is configuration on a versioned StatutoryConfig row.
  // A literal here would be one year's Indian rules frozen into a service.
  const sources = [
    path.join(BACKEND, 'shared', 'payroll', 'statutory.js'),
    path.join(BACKEND, 'shared', 'payroll', 'salaryEngine.js'),
    path.join(BACKEND, 'modules', 'hrms', 'payroll', 'run.service.js'),
    path.join(BACKEND, 'modules', 'hrms', 'payroll', 'statutory.service.js'),
  ];

  // The PF wage ceiling, the ESI threshold and the PF/ESI rates as they stood
  // in 2025-26 — the values the reference hardcodes as schema defaults.
  const forbidden = [/\b15000\b/, /\b21000\b/, /0\.12\b/, /0\.0075\b/, /0\.0325\b/];
  const offenders = [];

  for (const file of sources) {
    const code = await readStripped(file);
    for (const pattern of forbidden) {
      if (pattern.test(code)) {
        offenders.push(`${path.relative(BACKEND, file)} contains ${pattern}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Statutory values are configuration (AD-12), never literals:\n${offenders.join('\n')}`,
  );
});

test('AD-12: payroll rounding is a named rule, not a scattered Math.round', async () => {
  const sources = [
    path.join(BACKEND, 'shared', 'payroll', 'statutory.js'),
    path.join(BACKEND, 'shared', 'payroll', 'salaryEngine.js'),
    path.join(BACKEND, 'shared', 'payroll', 'formula.js'),
    path.join(BACKEND, 'modules', 'hrms', 'payroll', 'run.service.js'),
  ];
  const offenders = [];

  for (const file of sources) {
    const code = await readStripped(file);
    // `round2`, `ceilRupee` and `roundRupee` are the documented rules; a bare
    // `Math.round(x * 100) / 100` inline is the thing the brief rules out.
    if (/Math\.round\s*\([^)]*\*\s*100\s*\)\s*\/\s*100/.test(code)) {
      offenders.push(`${path.relative(BACKEND, file)}: inline two-decimal rounding`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Use the named helpers in shared/payroll/money.js:\n${offenders.join('\n')}`,
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

// ---------------------------------------------------------------------------
// Final audit: query safety (AD-13)
// ---------------------------------------------------------------------------

/**
 * The names a list endpoint takes from the caller and puts into a query.
 *
 * A regex built from one of these, unescaped, is two bugs at once: searching
 * for "C++" matches nothing and searching for "." matches everything, and a
 * crafted pattern like `(a+)+$` makes the database do exponential work on an
 * endpoint anybody can call.
 */
const USER_SUPPLIED = ['search', 'q', 'term', 'name'];

/** An escape on the same line — the shared helper, or the inline equivalent. */
const ESCAPE_CALL = /escapeRegex\(|\.replace\(\s*\/\[\./;

/**
 * Regexes built from caller-supplied text without an escape.
 *
 * Scoped to interpolations that can carry request data: a pattern built from a
 * server constant (`SELFIE_PREFIX`, a ticket-number prefix, a decimal-place
 * count) is not user input and is deliberately not flagged.
 *
 * The rule is structural. The escape lives in five modules as a local
 * `escapeRegex` and in two more inline; rather than consolidating seven
 * identical one-line helpers at the final gate, this asserts the property they
 * exist to provide, so a NEW call site cannot skip it.
 *
 * Exported so the guard can be tested against a known-bad input below. A guard
 * nobody has seen fail is a guard nobody knows works.
 */
export function unescapedRegexSites(code, label = '') {
  const offenders = [];

  for (const line of code.split('\n')) {
    if (!/new RegExp\(|\$regex\s*:/.test(line)) continue;
    if (ESCAPE_CALL.test(line)) continue;

    const interpolated = [...line.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
    // `\\b`, not `\b`: inside a template literal `\b` is a BACKSPACE
    // character, so the word-boundary anchors have to survive one level of
    // string escaping before the RegExp constructor ever sees them.
    const carriesUserText = interpolated.some((expr) =>
      USER_SUPPLIED.some((n) => new RegExp(`\\b${n}\\b`).test(expr)),
    );
    const rawField = new RegExp(
      `\\$regex\\s*:\\s*(${USER_SUPPLIED.join('|')})\\b`,
    ).test(line);

    if (carriesUserText || rawField) offenders.push(`${label}${line.trim()}`);
  }
  return offenders;
}

test('AD-13: no HRMS regex is built from unescaped caller text', async () => {
  const offenders = [];
  for (const file of await hrmsSourceFiles()) {
    offenders.push(
      ...unescapedRegexSites(await readStripped(file), `${path.relative(BACKEND, file)}: `),
    );
  }
  assert.deepEqual(
    offenders,
    [],
    `these build a regex from unescaped caller text:\n  ${offenders.join('\n  ')}`,
  );
});

test('AD-13: the regex guard detects what it claims to', () => {
  // Known-bad.
  assert.equal(unescapedRegexSites('const rx = new RegExp(`^${search}`, "i");').length, 1);
  assert.equal(unescapedRegexSites('{ $regex: search, $options: "i" }').length, 1);
  // Known-good: escaped on the same line, or built from a server constant.
  assert.deepEqual(unescapedRegexSites('const rx = new RegExp(`^${escapeRegex(search)}`);'), []);
  assert.deepEqual(unescapedRegexSites('new RegExp(`^${prefix}`)'), []);
});

/**
 * Every page size a caller can set is BOUNDED.
 *
 * That is the property that matters, not which constant supplies the ceiling.
 * Several lists cap tighter than the shared `PAGE_SIZE_MAX` — 100 for assets
 * and documents, 50 for the knowledge base — which is stricter than the shared
 * bound, not looser, and is a deliberate per-list choice. What must never ship
 * is a `pageSize` with no `.max()` at all: an unbounded query wearing a
 * paginated shape.
 */
test('AD-13: every caller-settable page size is bounded', async () => {
  const offenders = [];

  for (const file of await hrmsSourceFiles()) {
    if (!file.includes(path.join('shared', 'schemas'))) continue;
    const code = await readStripped(file);
    for (const line of code.split('\n')) {
      if (!/^\s*pageSize\s*:/.test(line)) continue;
      if (!/\.max\(/.test(line)) offenders.push(`${path.relative(BACKEND, file)}: ${line.trim()}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `an unbounded page size is an unbounded query:\n  ${offenders.join('\n  ')}`,
  );
});

/**
 * Every HRMS controller returns its payload UNDER `data`.
 *
 * `res.json({ success: true, ...payload })` spreads the payload BESIDE the
 * envelope instead of inside it. That shipped once and broke the employee
 * directory, because every client reads `body.data`. It is invisible in review,
 * and invisible in a unit test that asserts on the service rather than the
 * response.
 */
test('no HRMS controller spreads its payload beside the envelope', async () => {
  const offenders = [];

  for (const file of await hrmsSourceFiles()) {
    if (!file.endsWith('.controller.js')) continue;
    const code = await readStripped(file);
    for (const line of code.split('\n')) {
      if (/success:\s*true\s*,\s*\.\.\./.test(line)) {
        offenders.push(`${path.relative(BACKEND, file)}: ${line.trim()}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `the payload goes under data, never beside it:\n  ${offenders.join('\n  ')}`,
  );
});
