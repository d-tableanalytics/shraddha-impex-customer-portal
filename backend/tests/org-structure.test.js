/**
 * Org Structure — step 1: models, schemas and constants.
 *
 * The pure rules are tested directly. Paths that need a live MongoDB are not
 * exercised here; the index DECLARATIONS are asserted instead, because a
 * partial unique index that was silently dropped would only show up as
 * duplicate codes in production.
 *
 * Three of these tests exist because the reference gets the rule wrong, and
 * each says so where it matters.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import Department from '../models/hrms/Department.js';
import Location from '../models/hrms/Location.js';
import {
  createDepartmentSchema,
  updateDepartmentSchema,
  createLocationSchema,
  updateLocationSchema,
  orgListQuerySchema,
} from '../shared/schemas/org.js';
import {
  TIME_ZONES,
  DEFAULT_TIME_ZONE,
  isValidTimeZone,
} from '../shared/constants/timezones.js';
import { AUDIT_ACTIONS, ORG_CODE_PATTERN } from '../shared/constants/hrms.js';

const src = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');
const strip = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Index specs as `{ keys, options }`, which is what Mongoose stores. */
const indexes = (Model) =>
  Model.schema.indexes().map(([keys, options]) => ({ keys, options: options ?? {} }));

// ---------------------------------------------------------------------------
// Models — shape
// ---------------------------------------------------------------------------

test('both catalogues carry code, name and a soft-delete marker', () => {
  for (const Model of [Department, Location]) {
    assert.equal(Model.schema.path('code').isRequired, true);
    assert.equal(Model.schema.path('name').isRequired, true);
    assert.ok(Model.schema.path('deletedAt'), 'soft delete needs a marker (O-3)');
  }
});

test('AD-1: neither catalogue carries a tenant id', async () => {
  for (const rel of ['../models/hrms/Department.js', '../models/hrms/Location.js']) {
    assert.doesNotMatch(strip(await src(rel)), /organizationId/);
  }
  assert.equal(Department.schema.path('organizationId'), undefined);
  assert.equal(Location.schema.path('organizationId'), undefined);
});

test('code is upper-cased on write, so lookups need not care about case', () => {
  for (const Model of [Department, Location]) {
    assert.equal(Model.schema.path('code').options.uppercase, true);
    assert.equal(Model.schema.path('code').options.maxlength, 30);
  }
});

test('the code pattern is on the MODEL too, not only in Zod', () => {
  // Defence in depth: a service writing directly, or a future import, must not
  // be able to store `eng dept!` just because it bypassed the HTTP schema.
  for (const Model of [Department, Location]) {
    const [regex] = Model.schema.path('code').options.match;
    assert.deepEqual(regex, ORG_CODE_PATTERN);
  }
});

// ---------------------------------------------------------------------------
// Models — the partial unique index
// ---------------------------------------------------------------------------

test('code is unique among LIVE rows only', () => {
  // A plain unique index would make a retired code unusable forever. Retiring
  // ENG and later re-creating it is ordinary housekeeping, not a collision.
  for (const Model of [Department, Location]) {
    const codeIndex = indexes(Model).find(
      (i) => Object.keys(i.keys).join(',') === 'code',
    );
    assert.ok(codeIndex, `${Model.modelName} needs a unique index on code`);
    assert.equal(codeIndex.options.unique, true);
    assert.deepEqual(
      codeIndex.options.partialFilterExpression,
      { deletedAt: null },
      'without the partial filter, a retired code could never be reused',
    );
  }
});

test('the list ordering is indexed', () => {
  // "Every live row, ordered by name" is the only read the reference performs.
  for (const Model of [Department, Location]) {
    const keys = indexes(Model).map((i) => Object.keys(i.keys).join(','));
    assert.ok(keys.includes('deletedAt,name'), `${Model.modelName} list index missing`);
  }
});

// ---------------------------------------------------------------------------
// O-1 / O-2 — fields the reference carries but never exposes
// ---------------------------------------------------------------------------

test('O-1: parentId exists for imported data but no request can set it', async () => {
  // The reference's schema is hierarchical while its product is flat: no parent
  // picker, no tree, and no cycle check on update. Keeping the column costs
  // nothing; accepting it over HTTP would build a write path into a feature
  // that has no UI and no cycle guard.
  assert.ok(Department.schema.path('parentId'), 'kept for import compatibility');

  assert.equal(createDepartmentSchema.safeParse({ code: 'ENG', name: 'Eng', parentId: null }).success, false);
  assert.equal(updateDepartmentSchema.safeParse({ parentId: null }).success, false);

  const schemaSource = strip(await src('../shared/schemas/org.js'));
  assert.doesNotMatch(schemaSource, /parentId:/);
});

test('O-2: headEmployeeId is not modelled at all', () => {
  // The reference carries it in the DTO and exposes it nowhere. Unlike
  // parentId it is not hierarchy an import would lose, so there is nothing to
  // preserve — an always-null column is just a claim the product does not make.
  assert.equal(Department.schema.path('headEmployeeId'), undefined);
  assert.equal(createDepartmentSchema.safeParse({ code: 'ENG', name: 'Eng', headEmployeeId: null }).success, false);
});

// ---------------------------------------------------------------------------
// Schemas — codes
// ---------------------------------------------------------------------------

test('the uppercase code rule is enforced on the SERVER', () => {
  // The reference has this only as an Ant Design form rule; its server schema
  // is a bare z.string().min(1).max(30), so curl, a script or the CSV import
  // stores whatever it likes.
  for (const schema of [createDepartmentSchema, createLocationSchema]) {
    const base = { code: 'X', name: 'X', timezone: DEFAULT_TIME_ZONE };
    assert.equal(schema.safeParse({ ...base, code: 'eng dept!' }).success, false);
    assert.equal(schema.safeParse({ ...base, code: 'ENG/1' }).success, false);
    assert.equal(schema.safeParse({ ...base, code: '' }).success, false);
    assert.equal(schema.safeParse({ ...base, code: 'A'.repeat(31) }).success, false);
  }
});

test('a lowercase code is normalised rather than rejected', () => {
  // Case is not a mistake the user can see; a space is.
  const parsed = createDepartmentSchema.parse({ code: '  eng-1 ', name: ' Engineering ' });
  assert.equal(parsed.code, 'ENG-1');
  assert.equal(parsed.name, 'Engineering');
});

test('valid separators are accepted', () => {
  for (const code of ['ENG', 'BLR-01', 'HR_OPS', 'A1']) {
    assert.equal(createDepartmentSchema.safeParse({ code, name: 'x' }).success, true, code);
  }
});

// ---------------------------------------------------------------------------
// Schemas — the location optional-field defect
// ---------------------------------------------------------------------------

test('a location can be created without address, city or country', () => {
  // The reference derives its create schema with locationSchema.omit({id:true}),
  // which leaves these .nullable() but NOT .optional() — so an Ant form that
  // omits an untouched City sends undefined and gets a 400. Its department
  // schema .extend()s exactly this fix for its own two optional fields; the
  // location schema was missed.
  const result = createLocationSchema.safeParse({ code: 'BLR', name: 'Bangalore' });
  assert.equal(result.success, true, result.error?.issues?.[0]?.message);
  assert.equal(result.data.timezone, DEFAULT_TIME_ZONE, 'the reference default is kept');
});

test('null and empty string both mean "not supplied"', () => {
  const withNulls = createLocationSchema.parse({
    code: 'BLR',
    name: 'Bangalore',
    address: null,
    city: '',
    country: '   ',
  });
  assert.equal(withNulls.address, null);
  assert.equal(withNulls.city, null);
  assert.equal(withNulls.country, null);
});

test('over-long free text is refused', () => {
  const base = { code: 'BLR', name: 'Bangalore' };
  assert.equal(createLocationSchema.safeParse({ ...base, address: 'a'.repeat(501) }).success, false);
  assert.equal(createLocationSchema.safeParse({ ...base, city: 'a'.repeat(101) }).success, false);
  assert.equal(createLocationSchema.safeParse({ ...base, country: 'a'.repeat(101) }).success, false);
});

// ---------------------------------------------------------------------------
// Schemas — strictness
// ---------------------------------------------------------------------------

test('unknown keys are refused, not silently dropped', () => {
  assert.equal(createDepartmentSchema.safeParse({ code: 'ENG', name: 'E', employeeCount: 5 }).success, false);
  assert.equal(createLocationSchema.safeParse({ code: 'BLR', name: 'B', deletedAt: null }).success, false);
  assert.equal(updateLocationSchema.safeParse({ id: 'x' }).success, false);
});

test('update schemas are partial: one field is a valid patch', () => {
  assert.equal(updateDepartmentSchema.safeParse({ name: 'Engineering' }).success, true);
  assert.equal(updateLocationSchema.safeParse({ timezone: 'Europe/London' }).success, true);
  assert.equal(updateDepartmentSchema.safeParse({}).success, true);
});

test('the list query is a boolean, however the URL spells it', () => {
  assert.equal(orgListQuerySchema.parse({}).includeDeleted, false);
  assert.equal(orgListQuerySchema.parse({ includeDeleted: 'true' }).includeDeleted, true);
  assert.equal(orgListQuerySchema.parse({ includeDeleted: 'false' }).includeDeleted, false);
  assert.equal(orgListQuerySchema.safeParse({ includeDeleted: 'yes' }).success, false);
});

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

test('the reference default validates, even though ICU does not list it', () => {
  // The actual trap: Intl.supportedValuesOf('timeZone') on this Node build
  // returns Asia/Calcutta and omits both Asia/Kolkata and UTC, yet
  // Intl.DateTimeFormat resolves both. Validating by membership of that list
  // would reject the default on every location an Indian company creates, and
  // would make a Node upgrade a data-validation change.
  assert.equal(DEFAULT_TIME_ZONE, 'Asia/Kolkata');
  assert.equal(isValidTimeZone('Asia/Kolkata'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(createLocationSchema.safeParse({ code: 'X', name: 'X', timezone: 'Asia/Kolkata' }).success, true);
});

test('the picker offers the canonical list plus the default and UTC', () => {
  assert.ok(TIME_ZONES.length > 100, 'the real IANA list, not seven hardcoded entries');
  assert.ok(TIME_ZONES.includes(DEFAULT_TIME_ZONE), 'a stored value must stay selectable');
  assert.ok(TIME_ZONES.includes('UTC'));
  assert.deepEqual([...TIME_ZONES], [...new Set(TIME_ZONES)], 'no duplicates from the union');
  assert.deepEqual([...TIME_ZONES], [...TIME_ZONES].sort(), 'sorted for the picker');

  // Every zone the picker offers must survive validation, or the form could
  // present a choice the server refuses.
  for (const zone of TIME_ZONES) assert.equal(isValidTimeZone(zone), true, zone);
});

test('every zone the reference hardcoded is still accepted', () => {
  for (const zone of [
    'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London',
    'America/New_York', 'America/Los_Angeles', 'UTC',
  ]) {
    assert.equal(isValidTimeZone(zone), true, zone);
  }
});

test('a bad zone is refused instead of stored', () => {
  for (const bad of ['Mars/Base', 'Asia/Kolkatta', '', '   ', 'a'.repeat(61), null, 42, undefined]) {
    assert.equal(isValidTimeZone(bad), false, String(bad));
  }
  assert.equal(
    createLocationSchema.safeParse({ code: 'X', name: 'X', timezone: 'Mars/Base' }).success,
    false,
  );
});

test('the model refuses a bad zone too', async () => {
  const doc = new Location({ code: 'BLR', name: 'Bangalore', timezone: 'Mars/Base' });
  await assert.rejects(() => doc.validate(), /not a recognised IANA time zone/i);
});

test('a location document validates and takes the default zone', async () => {
  const doc = new Location({ code: 'BLR', name: 'Bangalore' });
  await doc.validate();
  assert.equal(doc.timezone, DEFAULT_TIME_ZONE);
  assert.equal(doc.deletedAt, null);
});

test('a department document validates', async () => {
  const doc = new Department({ code: 'eng', name: 'Engineering' });
  await doc.validate();
  assert.equal(doc.code, 'ENG', 'upper-cased by the model as well as the schema');
  assert.equal(doc.parentId, null);
  assert.equal(doc.deletedAt, null);
});

// ---------------------------------------------------------------------------
// Audit constants
// ---------------------------------------------------------------------------

test('all six org audit actions exist and are distinct', () => {
  const actions = [
    AUDIT_ACTIONS.DEPARTMENT_CREATED,
    AUDIT_ACTIONS.DEPARTMENT_UPDATED,
    AUDIT_ACTIONS.DEPARTMENT_DELETED,
    AUDIT_ACTIONS.LOCATION_CREATED,
    AUDIT_ACTIONS.LOCATION_UPDATED,
    AUDIT_ACTIONS.LOCATION_DELETED,
  ];
  for (const a of actions) assert.match(a, /^hrms\.(department|location)\.(created|updated|deleted)$/);
  assert.equal(new Set(actions).size, 6);

  // The pre-existing attendance action is a different thing with a similar name.
  assert.notEqual(AUDIT_ACTIONS.LOCATION_VIEWED, AUDIT_ACTIONS.LOCATION_CREATED);
});
