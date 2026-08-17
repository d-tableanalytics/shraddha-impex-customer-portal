/**
 * verify-box-numbers.js
 * -----------------------------------------------------------------------------
 * Checks for the SKU → Box Number feature, and for the customer-mail Cc list.
 *
 *   1. Permission model      who may edit, who may see, front/back in step
 *   2. Line-item visibility  boxNo stripped from the payload, not just hidden
 *   3. Booking shaping       live mapping while pending, snapshot once raised
 *   4. Import templates      the column, its coercion, and the Admin-only rule
 *   5. Mail recipients       the always-Cc list across env permutations
 *   6. Wiring                source-level checks for the paths that need a DB
 *
 * Every section is static — nothing here touches the database, and nothing
 * sends mail. Section 6 exists because the remaining behaviour (raisePo
 * re-stamping, applyBoxNumbers, the import processors) only runs against a live
 * MongoDB; those checks assert the wiring is present rather than exercising it.
 *
 * Usage:
 *   node scripts/verify-box-numbers.js
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(__dirname, '..');
const REPO = path.join(BACKEND, '..');
dotenv.config({ path: path.join(BACKEND, '.env') });

// ── Harness ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

const check = (name, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`   ✅ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`   ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const eq = (name, actual, expected) =>
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

const src = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// ── Subjects ─────────────────────────────────────────────────────────────────
const { PERMISSIONS, hasPermission } = await import('../middlewares/rbac.js');
const {
  boxNoAppliesTo, catalogueBoxNoAppliesTo,
  withBoxNoVisibility, withCatalogueBoxNoVisibility,
} = await import('../utils/boxNoVisibility.js');
const { IMPORT_TEMPLATES, headersFor, matchHeaders, coerce } =
  await import('../modules/inventory/import.templates.js');
const { suppliesBoxNo, boxRowKey, boxNumberChanges } =
  await import('../modules/inventory/boxNumber.rules.js');
const { shapeBooking } = await import('../modules/sales/booking.shape.js');

// The frontend mirror. Plain ESM with no imports of its own, so it loads here
// directly — which is the point: the two permission tables are meant to agree,
// and the only way to know they do is to evaluate both.
// pathToFileURL, not a bare path: on Windows an absolute path starts with a
// drive letter, which the ESM loader reads as an unknown URL scheme.
const fe = await import(
  pathToFileURL(path.join(REPO, 'frontend', 'src', 'utils', 'permissions.js')).href
);

const ROLES = [
  'Admin', 'Sales', 'Inventory Manager', 'Warehouse User', 'Management', 'Customer',
];
const asUser = (role) => ({ role, _id: `id-${role}` });

console.log('\nBOX NUMBER — VERIFICATION\n' + '='.repeat(60));

// ── 1. Permission model ──────────────────────────────────────────────────────
console.log('\n1. PERMISSION MODEL');

check('Admin may edit a box number', hasPermission(asUser('Admin'), PERMISSIONS.MANAGE_BOX_NUMBER));
for (const role of ROLES.filter((r) => r !== 'Admin')) {
  check(
    `${role} may NOT edit a box number`,
    !hasPermission(asUser(role), PERMISSIONS.MANAGE_BOX_NUMBER),
  );
}
// The one that would silently regress: Inventory Manager holds the planning
// permission, so a box number left inside PLANNING_FIELDS would be editable.
check(
  'Inventory Manager still holds MANAGE_INVENTORY_MASTER (so the split is real)',
  hasPermission(asUser('Inventory Manager'), PERMISSIONS.MANAGE_INVENTORY_MASTER),
);

console.log('\n   frontend ↔ backend mirror');
for (const role of ROLES) {
  const user = asUser(role);
  check(
    `${role}: canEditBoxNo agrees with MANAGE_BOX_NUMBER`,
    fe.canEditBoxNo(user) === hasPermission(user, PERMISSIONS.MANAGE_BOX_NUMBER),
  );
  check(
    `${role}: canViewLineItemBoxNo agrees with boxNoAppliesTo`,
    fe.canViewLineItemBoxNo(user) === boxNoAppliesTo(user),
  );
  check(
    `${role}: canViewBoxNo agrees with catalogueBoxNoAppliesTo`,
    fe.canViewBoxNo(user) === catalogueBoxNoAppliesTo(user),
  );
}

console.log('\n   line-item rule is narrower than the inventory rule');
eq(
  'inventory screens show the box to Admin, Sales and inventory roles',
  ROLES.filter((r) => fe.canViewBoxNo(asUser(r))),
  ['Admin', 'Sales', 'Inventory Manager', 'Warehouse User', 'Management'],
);
eq(
  'line items show the box to Sales and Admin only',
  ROLES.filter((r) => fe.canViewLineItemBoxNo(asUser(r))),
  ['Admin', 'Sales'],
);
check('a customer sees it on neither',
  !fe.canViewBoxNo(asUser('Customer')) && !fe.canViewLineItemBoxNo(asUser('Customer')));

// ── 2. Line-item visibility is enforced on the payload ───────────────────────
console.log('\n2. LINE-ITEM VISIBILITY (payload, not just the column)');

const orderRow = { _id: 'o1', skuCode: 'SKU1', msilCode: 'M1', boxNo: 'B-12', confirmedQty: 5 };

check('Sales receives boxNo',
  withBoxNoVisibility({ ...orderRow }, asUser('Sales')).boxNo === 'B-12');
check('Admin receives boxNo',
  withBoxNoVisibility({ ...orderRow }, asUser('Admin')).boxNo === 'B-12');
check('Customer does NOT receive boxNo',
  !('boxNo' in withBoxNoVisibility({ ...orderRow }, asUser('Customer'))));
check('Warehouse User does NOT receive boxNo on a line item',
  !('boxNo' in withBoxNoVisibility({ ...orderRow }, asUser('Warehouse User'))));
check('the rest of the row survives stripping',
  withBoxNoVisibility({ ...orderRow }, asUser('Customer')).skuCode === 'SKU1');

const arr = [{ ...orderRow }, { ...orderRow, _id: 'o2' }];
check('an array is stripped element-wise',
  withBoxNoVisibility(arr, asUser('Customer')).every((o) => !('boxNo' in o)));
check('an array is passed through intact for Sales',
  withBoxNoVisibility(arr, asUser('Sales')).every((o) => o.boxNo === 'B-12'));

// A Mongoose document cannot have a path deleted, so the helper must convert.
const asDoc = (o) => ({ ...o, toObject: () => ({ ...o }) });
check('a Mongoose-style document is converted before stripping',
  !('boxNo' in withBoxNoVisibility(asDoc(orderRow), asUser('Customer'))));
check('null / undefined do not throw',
  withBoxNoVisibility(null, asUser('Customer')) === null
  && withBoxNoVisibility(undefined, asUser('Customer')) === undefined);
check('a row that never had a boxNo is unchanged',
  withBoxNoVisibility({ skuCode: 'X' }, asUser('Customer')).skuCode === 'X');

// Stripping must not edit the caller's object. Mongoose hands back a copy from
// toObject(), but a .lean() query — which the catalogue list uses — returns
// plain objects, and deleting the key off those would corrupt them in place.
const original = { ...orderRow };
withBoxNoVisibility(original, asUser('Customer'));
check('stripping does not mutate the caller\'s object', original.boxNo === 'B-12');

console.log('\n   catalogue rows (inventory screens, wider audience)');
const productRow = { skuCode: 'SKU1', msilCode: 'M1', boxNo: 'B-12', availableForSale: 3 };
for (const role of ['Admin', 'Sales', 'Inventory Manager', 'Warehouse User', 'Management']) {
  check(`${role} receives boxNo on a catalogue row`,
    withCatalogueBoxNoVisibility({ ...productRow }, asUser(role)).boxNo === 'B-12');
}
check('Customer does NOT receive boxNo on a catalogue row',
  !('boxNo' in withCatalogueBoxNoVisibility({ ...productRow }, asUser('Customer'))));
check('a customer browsing the catalogue still gets the rest of the row',
  withCatalogueBoxNoVisibility({ ...productRow }, asUser('Customer')).availableForSale === 3);

// ── 3. Booking shaping — live vs snapshot ────────────────────────────────────
console.log('\n3. BOOKING SHAPING (live while pending, snapshot once raised)');

const row = (over = {}) => ({
  _id: 'r1', orderId: 'BK-1', skuCode: 'SKU1', brand: 'Koken', msilCode: 'M1',
  boxNo: 'OLD-1', company: 'Acme', status: 'PO Received',
  date: new Date('2026-01-01'), poNumber: '-', poGeneratedAt: null,
  bookedQty: 5, confirmedQty: 5, pendingQty: 0,
  ...over,
});
const liveMap = new Map([['SKU1::Koken', 'NEW-9']]);
const lineOf = (rows, map) => shapeBooking(rows, map).lines[0];

check('pending booking shows the CURRENT mapping, not the booked snapshot',
  lineOf([row()], liveMap).boxNo === 'NEW-9');
check('raised booking (poGeneratedAt) keeps the stamped snapshot',
  lineOf([row({ poGeneratedAt: new Date(), poNumber: 'PO-1' })], liveMap).boxNo === 'OLD-1');
check('raised booking detected by poNumber alone also keeps its snapshot',
  lineOf([row({ poNumber: 'PO-2026-000001' })], liveMap).boxNo === 'OLD-1');

// The `??` vs `||` decision: an admin who CLEARS a mapping must not have the
// screen quietly fall back to the stale snapshot.
check('a cleared mapping reads as none, not as the stale snapshot',
  lineOf([row()], new Map([['SKU1::Koken', null]])).boxNo === null);
// undefined means the product could not be resolved at all — different case.
check('an unresolvable product falls back to the row snapshot',
  lineOf([row()], new Map()).boxNo === 'OLD-1');
check('no snapshot and no mapping reads as null',
  lineOf([row({ boxNo: null })], new Map()).boxNo === null);

// Same SKU code under two brands is two products with two boxes.
const twoBrands = [row(), row({ _id: 'r2', brand: 'BIX', boxNo: 'OLD-2' })];
const brandMap = new Map([['SKU1::Koken', 'K-1'], ['SKU1::BIX', 'B-1']]);
eq('box numbers are keyed by SKU *and* brand',
  shapeBooking(twoBrands, brandMap).lines.map((l) => l.boxNo), ['K-1', 'B-1']);

check('the default empty map keeps shapeBooking callable with one argument',
  shapeBooking([row()]).lines[0].boxNo === 'OLD-1');
check('lines still carry skuCode, msilCode and quantity alongside the box',
  (() => {
    const l = lineOf([row()], liveMap);
    return l.skuCode === 'SKU1' && l.msilCode === 'M1' && l.confirmedQty === 5;
  })());

// ── 4. Import templates ──────────────────────────────────────────────────────
console.log('\n4. IMPORT TEMPLATES');

const SHEETS = ['inventory-master', 'fresh-inventory'];
for (const type of SHEETS) {
  const col = IMPORT_TEMPLATES[type].columns.find((c) => c.field === 'boxNo');
  check(`${type}: has a Box No column`, Boolean(col) && col.header === 'Box No');
  check(`${type}: the column is optional`, col && !col.required);
  check(`${type}: declares tracksBoxNo`, IMPORT_TEMPLATES[type].tracksBoxNo === true);
  check(`${type}: sample row covers Box No`, 'Box No' in IMPORT_TEMPLATES[type].sample);
}
check('planning sheet does NOT carry the column',
  !IMPORT_TEMPLATES.planning.columns.some((c) => c.field === 'boxNo')
  && !IMPORT_TEMPLATES.planning.tracksBoxNo);

console.log('\n   the Admin-only rule, per row');
const ctx = (canSet) => ({
  canSetBoxNo: canSet,
  skuToBoxNo: new Map([['SKU1::Koken', 'B-12']]),
});
const errsFor = (type, r, canSet) => IMPORT_TEMPLATES[type].validate(r, ctx(canSet));
const base = { skuCode: 'SKU1', brand: 'Koken', quantity: 1 };

for (const type of SHEETS) {
  check(`${type}: admin may change B-12 → C-99`,
    errsFor(type, { ...base, boxNo: 'C-99' }, true).length === 0);
  check(`${type}: admin may set a first box`,
    errsFor(type, { ...base, skuCode: 'SKU2', boxNo: 'A-1' }, true).length === 0);
  check(`${type}: non-admin may leave the cell blank`,
    errsFor(type, { ...base, boxNo: null }, false).length === 0);
  // The round trip that would otherwise break: export → edit quantities →
  // re-upload, with the box column still populated as exported.
  check(`${type}: non-admin may re-upload an unchanged box number`,
    errsFor(type, { ...base, boxNo: 'B-12' }, false).length === 0);
  check(`${type}: non-admin CANNOT change a box number`,
    errsFor(type, { ...base, boxNo: 'C-99' }, false)
      .some((e) => e.category === 'permission'));
  check(`${type}: non-admin CANNOT set a box on an unmapped SKU`,
    errsFor(type, { ...base, skuCode: 'SKU2', boxNo: 'A-1' }, false)
      .some((e) => e.category === 'permission'));
}

check('fresh-inventory keeps its own rule and reports BOTH problems at once',
  (() => {
    const e = errsFor('fresh-inventory', { brand: 'Koken', boxNo: 'C-99' }, false);
    return e.length === 2
      && e.some((x) => x.category === 'required')
      && e.some((x) => x.category === 'permission');
  })());
check('the message names no "undefined" when the row identifies no SKU',
  !errsFor('fresh-inventory', { brand: 'Koken', boxNo: 'C-99' }, false)
    .some((e) => /undefined/.test(e.message)));
check('the rejection message names the current box, so the fix is obvious',
  errsFor('inventory-master', { ...base, boxNo: 'C-99' }, false)[0].message.includes('B-12'));
// A missing context must fail CLOSED, never open.
check('a missing validation context refuses the change rather than allowing it',
  IMPORT_TEMPLATES['inventory-master'].validate({ ...base, boxNo: 'C-99' }, undefined).length === 1);

console.log('\n   headers and coercion');
for (const type of SHEETS) {
  check(`${type}: template header row ends with Box No`,
    headersFor(type).includes('Box No'));
  const m = matchHeaders(type, [...headersFor(type)]);
  check(`${type}: its own generated header row matches cleanly`,
    m.missing.length === 0 && m.unexpected.length === 0 && m.mapping.boxNo !== undefined);
  // Files written before the column existed must keep importing.
  const legacy = matchHeaders(type, headersFor(type).filter((h) => h !== 'Box No'));
  check(`${type}: a file without the column still validates`,
    legacy.missing.length === 0 && legacy.mapping.boxNo === undefined);
  check(`${type}: header matching ignores case and spacing`,
    matchHeaders(type, headersFor(type).map((h) => h.toLowerCase() + ' ')).mapping.boxNo !== undefined);
}

const boxSpec = IMPORT_TEMPLATES['inventory-master'].columns.find((c) => c.field === 'boxNo');
eq('a numeric cell coerces to text', coerce(boxSpec, 12).value, '12');
eq('surrounding whitespace is trimmed', coerce(boxSpec, '  B-12  ').value, 'B-12');
eq('an empty cell is null, not an empty string', coerce(boxSpec, '').value, null);
eq('a blank cell is null', coerce(boxSpec, null).value, null);
eq('an Excel rich-text cell reads its display string',
  coerce(boxSpec, { richText: [{ text: 'B-' }, { text: '12' }] }).value, 'B-12');

// ── Blank means KEEP, never CLEAR ────────────────────────────────────────────
// Box numbers are set once in a while, but these sheets are uploaded constantly
// for their quantities — so the overwhelmingly common row carries no box number
// at all and must leave the mapping exactly as it was.
console.log('\n   a blank or absent Box No leaves the existing mapping alone');

check('a supplied box number counts as supplied', suppliesBoxNo({ boxNo: 'B-12' }));
check('a blank cell supplies nothing', !suppliesBoxNo({ boxNo: null }));
check('an empty string supplies nothing', !suppliesBoxNo({ boxNo: '' }));
check('an absent column supplies nothing', !suppliesBoxNo({ boxNo: undefined }));
check('a row object with no boxNo key at all supplies nothing', !suppliesBoxNo({ skuCode: 'X' }));
check('an undefined row does not throw', !suppliesBoxNo(undefined));
// A box literally named "0" is a real box, not a blank.
check('a box number of "0" IS supplied (not treated as blank)', suppliesBoxNo({ boxNo: '0' }));

// The real header-matching and coercion, run the way validateRow runs them, so
// this covers the actual path a spreadsheet takes rather than a paraphrase.
const cellToData = (type, headerRow, values) => {
  const { mapping } = matchHeaders(type, headerRow);
  const data = {};
  for (const col of IMPORT_TEMPLATES[type].columns) {
    const index = mapping[col.field];
    data[col.field] = coerce(col, index === undefined ? null : values[index]).value;
  }
  return data;
};

for (const type of SHEETS) {
  const full = headersFor(type);
  const noBoxCol = full.filter((h) => h !== 'Box No');
  const boxIdx = full.indexOf('Box No');

  const blank = [...full].fill(null); blank[boxIdx] = '';
  check(`${type}: an EMPTY Box No cell yields no write`,
    !suppliesBoxNo(cellToData(type, full, blank)));

  const spaces = [...full].fill(null); spaces[boxIdx] = '   ';
  check(`${type}: a whitespace-only Box No cell yields no write`,
    !suppliesBoxNo(cellToData(type, full, spaces)));

  check(`${type}: a file with NO Box No column yields no write`,
    !suppliesBoxNo(cellToData(type, noBoxCol, [...noBoxCol].fill('x'))));

  const filled = [...full].fill(null); filled[boxIdx] = 'B-12';
  check(`${type}: a populated Box No cell DOES yield a write`,
    suppliesBoxNo(cellToData(type, full, filled)));
}

// The corollary: a non-admin uploading a sheet with the column left blank is
// never blocked, because the row is asking for nothing.
check('a non-admin is never blocked by a blank Box No column',
  errsFor('inventory-master', { ...base, boxNo: null }, false).length === 0
  && errsFor('inventory-master', { ...base, boxNo: '' }, false).length === 0);

// ── A supplied Box No REPLACES what is on file ───────────────────────────────
console.log('\n   a populated Box No replaces the existing mapping');

const staged = (skuCode, boxNo, brand = 'Koken', rowNumber = 1) =>
  ({ rowNumber, data: { skuCode, brand, boxNo } });
const onFile = new Map([
  [boxRowKey('SKU1', 'Koken'), 'B-12'],
  [boxRowKey('SKU2', 'Koken'), null],   // exists, no box mapped yet
  [boxRowKey('SKU1', 'BIX'), 'X-1'],    // same code, different brand
]);

eq('an existing box number is replaced by the new one',
  boxNumberChanges([staged('SKU1', 'C-99')], onFile),
  [{ skuCode: 'SKU1', brand: 'Koken', from: 'B-12', to: 'C-99' }]);

eq('a SKU with no box yet gets its first mapping',
  boxNumberChanges([staged('SKU2', 'A-1')], onFile),
  [{ skuCode: 'SKU2', brand: 'Koken', from: null, to: 'A-1' }]);

eq('a SKU not on file at all is treated as a first mapping',
  boxNumberChanges([staged('SKU9', 'N-1')], onFile),
  [{ skuCode: 'SKU9', brand: 'Koken', from: null, to: 'N-1' }]);

// Re-uploading an exported sheet must not read as thousands of changes.
eq('re-supplying the SAME box number is not a change',
  boxNumberChanges([staged('SKU1', 'B-12')], onFile), []);

eq('replacement is per brand, not per SKU code',
  boxNumberChanges([staged('SKU1', 'C-99'), staged('SKU1', 'Y-2', 'BIX', 2)], onFile),
  [
    { skuCode: 'SKU1', brand: 'Koken', from: 'B-12', to: 'C-99' },
    { skuCode: 'SKU1', brand: 'BIX', from: 'X-1', to: 'Y-2' },
  ]);

eq('a mixed batch reports only the rows that actually moved',
  boxNumberChanges(
    [staged('SKU1', 'B-12', 'Koken', 1), staged('SKU2', 'A-1', 'Koken', 2)],
    onFile,
  ).map((c) => c.skuCode),
  ['SKU2']);

check('the from/to pair is carried so the change is reversible from the audit trail',
  (() => {
    const [c] = boxNumberChanges([staged('SKU1', 'C-99')], onFile);
    return c.from === 'B-12' && c.to === 'C-99';
  })());

// ── 5. Mail recipients ───────────────────────────────────────────────────────
console.log('\n5. MAIL RECIPIENTS');

const MAIL_KEYS = ['BOOKING_CC_EMAILS', 'ALWAYS_CC_EMAILS', 'SUPPORT_TEAM_EMAILS', 'BLOCKED_EMAILS'];
let cacheBust = 0;
const recipientsWith = async (env) => {
  for (const k of MAIL_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  cacheBust += 1;
  return import(`../utils/mailRecipients.js?probe=${cacheBust}`);
};
const lower = (a) => a.map((s) => s.toLowerCase());
const KINJAL = 'kinjal@shraddhaimpex.net';

let m = await recipientsWith({});
check('default: Kinjal is copied on customer mail', lower(m.COMPANY_CC).includes(KINJAL));
check('default: the company mailbox is still copied',
  lower(m.COMPANY_CC).includes('contact@shraddhaimpex.net'));
check('default: support mail does NOT copy Kinjal', !lower(m.SUPPORT_TEAM).includes(KINJAL));

m = await recipientsWith({ BOOKING_CC_EMAILS: 'ops@shraddhaimpex.net' });
check('BOOKING_CC_EMAILS overridden: Kinjal survives',
  lower(m.COMPANY_CC).includes(KINJAL));
check('BOOKING_CC_EMAILS overridden: the new mailbox is used',
  lower(m.COMPANY_CC).includes('ops@shraddhaimpex.net'));
check('BOOKING_CC_EMAILS overridden: support follows the mailbox, not the Cc list',
  JSON.stringify(m.SUPPORT_TEAM) === JSON.stringify(['ops@shraddhaimpex.net']));

m = await recipientsWith({ SUPPORT_TEAM_EMAILS: 'support@shraddhaimpex.net' });
check('explicit support list is respected and excludes Kinjal',
  JSON.stringify(m.SUPPORT_TEAM) === JSON.stringify(['support@shraddhaimpex.net']));

m = await recipientsWith({ BOOKING_CC_EMAILS: `Contact@shraddhaimpex.net,${KINJAL.toUpperCase()}` });
check('an address listed twice in different cases is copied once',
  lower(m.COMPANY_CC).filter((a) => a === KINJAL).length === 1);

m = await recipientsWith({ ALWAYS_CC_EMAILS: '' });
check('ALWAYS_CC_EMAILS="" disables the always-Cc without breaking the mailbox',
  !lower(m.COMPANY_CC).includes(KINJAL) && m.COMPANY_CC.length === 1);

m = await recipientsWith({ BLOCKED_EMAILS: KINJAL });
check('the blocklist still wins over the always-Cc list',
  !lower(m.COMPANY_CC).includes(KINJAL));

await recipientsWith({}); // leave the env as found

// ── 6. Wiring (paths whose behaviour needs a live DB) ────────────────────────
console.log('\n6. WIRING');

const invCtl = src('backend/modules/inventory/inventory.controller.js');
const salesCtl = src('backend/modules/sales/sales.controller.js');
const impSvc = src('backend/modules/inventory/import.service.js');
const ordCtl = src('backend/modules/orders/order.controller.js');

check('boxNo is out of PLANNING_FIELDS (or the planning permission would carry it)',
  /const PLANNING_FIELDS = \[[^\]]*\]/s.test(invCtl)
  && !/const PLANNING_FIELDS = \[[^\]]*'boxNo'[^\]]*\]/s.test(invCtl));
check('boxNo is out of BULK_FIELDS',
  !/const BULK_FIELDS = \[[^\]]*'boxNo'[^\]]*\]/s.test(invCtl));
check('the single-SKU editor refuses a non-admin with 403',
  /MANAGE_BOX_NUMBER/.test(invCtl) && /status\(403\)/.test(invCtl));
check('a box change is audited separately from the planning edit',
  /'Box Number Updated'/.test(invCtl));

check('raisePo re-stamps box numbers before the PO is committed',
  /currentBoxNumbers\(rows\)/.test(salesCtl) && /\$set: \{ boxNo: current \}/.test(salesCtl));
check('the re-stamp happens BEFORE the poNumber is written',
  salesCtl.indexOf('const reBoxed') < salesCtl.indexOf('poGeneratedAt: now'));
check('re-boxed lines are recorded on the PO audit entry',
  /reBoxed/.test(salesCtl) && /meta: \{ orderId, poNumber, poGeneratedAt: now, reBoxed \}/.test(salesCtl));
check('the customer PO email carries NO box number',
  !/Box No/.test(salesCtl.slice(salesCtl.indexOf('buildPoRaisedEmail'),
    salesCtl.indexOf('export const getBookings'))));

check('processMaster does not $set boxNo itself (applyBoxNumbers owns the write)',
  !/\{ boxNo: d\.boxNo \}/.test(impSvc));
check('applyBoxNumbers reads the previous value before writing',
  /const prior = await Product\.find\(/.test(impSvc)
  && impSvc.indexOf('const prior = await Product.find(') < impSvc.indexOf('bulkWrite(ops'));
check('applyBoxNumbers uses the shared change-detection, not its own copy',
  /boxNumberChanges\(carrying, before\)/.test(impSvc)
  && !/\.filter\(\(c\) => c\.from !== c\.to\)/.test(impSvc));
check('the write replaces the stored value with the sheet\'s',
  /\$set: \{ boxNo: c\.to \}/.test(impSvc));
check('applyBoxNumbers only touches rows that landed',
  /landed\.has\(r\.rowNumber\)/.test(impSvc));
// One definition of "blank means keep", shared by the validator and the writer.
check('the writer uses the shared suppliesBoxNo rule, not its own copy',
  /suppliesBoxNo\(r\.data\)/.test(impSvc)
  && !/r\.data\?\.boxNo !== undefined/.test(impSvc));
check('nothing anywhere clears a box number from an import',
  !/boxNo: null/.test(impSvc));
check('fresh inventory applies box numbers on every exit path (wrapper)',
  /const processFreshInventory = async \(args\) => \{/.test(impSvc)
  && /await restateStock\(args\)/.test(impSvc));
check('both order read endpoints strip boxNo',
  (ordCtl.match(/withBoxNoVisibility\(/g) || []).length >= 2);

// The catalogue endpoints return product documents whole. Any response handing
// back rows without passing them through the filter leaks the box number to a
// customer, whose table simply has no column for it — a hidden column is not a
// control. Checked by name so a NEW endpoint returning raw rows is caught too.
const prodCtl = src('backend/modules/products/product.controller.js');
const rawRowResponses = [...prodCtl.matchAll(/data:\s*([A-Za-z_$][\w$]*)\s*[,}]/g)]
  .map((m) => m[1])
  .filter((name) => ['merged', 'products', 'product', 'rows', 'items'].includes(name));
eq('no product endpoint returns catalogue rows unfiltered', rawRowResponses, []);
check('the catalogue endpoints strip boxNo (list, brand list, single)',
  (prodCtl.match(/withCatalogueBoxNoVisibility\(/g) || []).length >= 3);

// A downloaded file leaves the app and gets forwarded, so an export column that
// is not gated the same way as the on-screen one is a worse leak than the
// column itself. Both drawers build their export columns with a `showBoxNo`
// guard; assert the guard is actually there rather than trusting review.
const orderDrawer = src('frontend/src/components/drawer/OrderDrawer.jsx');
const salesDrawer = src('frontend/src/components/drawer/SalesBookingDrawer.jsx');
for (const [name, code] of [['order drawer', orderDrawer], ['sales desk drawer', salesDrawer]]) {
  check(`${name}: the export gates Box No on showBoxNo`,
    /\.\.\.\(showBoxNo \? \[\{ key: "boxNo", label: "Box No" \}\] : \[\]\)/.test(code));
  check(`${name}: showBoxNo comes from the line-item rule`,
    /canViewLineItemBoxNo\(user\)/.test(code));
}
check('the sales desk items table offers a download',
  /handleDownload/.test(salesDrawer) && /exportToExcel/.test(salesDrawer));
check('the sales desk download is lazy-loaded (keeps xlsx out of the main bundle)',
  /import\("\.\.\/\.\.\/utils\/exportUtils"\)/.test(salesDrawer));

// sales.controller.js cannot be imported here (it pulls in the socket server,
// which boots the app), so the one thing the extraction could break — the named
// imports no longer matching what booking.shape.js exports — is checked against
// the real module object instead of being taken on trust.
const shapeMod = await import('../modules/sales/booking.shape.js');
const imported = (salesCtl.match(/import \{([^}]+)\} from '\.\/booking\.shape\.js'/) || [, ''])[1]
  .split(',').map((s) => s.trim()).filter(Boolean);
check('sales.controller imports at least one symbol from booking.shape',
  imported.length > 0);
for (const name of imported) {
  check(`booking.shape exports ${name}`, typeof shapeMod[name] !== 'undefined');
}
check('the moved helpers are gone from sales.controller (no duplicate definition)',
  !/^const shapeBooking = /m.test(salesCtl) && !/^const currentBoxNumbers = /m.test(salesCtl));

// ── 7. Data fidelity ─────────────────────────────────────────────────────────
// An imported value must survive the round trip unchanged. Inventory codes are
// full of characters that other layers want to reinterpret — regex
// metacharacters in search, markup characters in a printed sheet.
console.log('\n7. DATA FIDELITY (special characters survive unchanged)');

const { prefixMatch } = await import('../utils/searchQuery.js');
const { escapeHtml } = await import(
  pathToFileURL(path.join(REPO, 'frontend', 'src', 'utils', 'escapeHtml.js')).href
);

const SPECIALS = [
  'A&B-1', 'SKU<10>', 'X"Y', "O'Brien", 'A/B\\C', '50%', 'C++', '#12',
  'Ø-12', 'café', '日本語', 'B–12', 'A,B', 'A;B', 'A|B', 'A  B',
  '007', '1/2', '3-4', '+91', '=SUM(A1)', '-5', '@here', '13012M.52-10',
  'M8 x 1.25', '(A)[B]{C}', 'A*B?C', 'A$B^C',
];

console.log('\n   import coercion returns the value verbatim');
const skuSpec = IMPORT_TEMPLATES['inventory-master'].columns.find((c) => c.field === 'skuCode');
const mangled = SPECIALS.filter((v) => coerce(skuSpec, v).value !== v);
eq('no special character is altered by cell coercion', mangled, []);
const boxMangled = SPECIALS.filter((v) => coerce(boxSpec, v).value !== v);
eq('the same holds for the Box No column', boxMangled, []);
// Trimming is the ONE intended change, and only at the edges.
eq('only surrounding whitespace is trimmed', coerce(skuSpec, '  A B  ').value, 'A B');
eq('internal spacing is preserved exactly', coerce(skuSpec, 'A   B').value, 'A   B');
eq('a leading zero is not dropped', coerce(skuSpec, '0012').value, '0012');
eq('a leading = is stored as text, not read as a formula',
  coerce(skuSpec, '=SUM(A1)').value, '=SUM(A1)');

console.log('\n   search matches these codes literally');
for (const v of ['13012M.52-10', 'A*B?C', '(A)[B]{C}', 'A$B^C', 'C++']) {
  const re = prefixMatch(v);
  check(`"${v}" matches itself`, re.test(v));
  // The metacharacter must not match something else: `.` matching any char is
  // how a search for one SKU quietly returns a different one.
  const decoy = v.replace(/[.*+?^${}()[\]|\\]/g, 'Z');
  check(`"${v}" does not match its metacharacter-substituted twin`,
    decoy === v || !re.test(decoy));
}

console.log('\n   a printed sheet shows the stored value');
eq('markup characters are escaped, not dropped',
  escapeHtml('A<B>C'), 'A&amp;lt;B&amp;gt;C'.replace(/&amp;(lt|gt);/g, '&$1;'));
eq('an ampersand is escaped once, not twice', escapeHtml('Nut & Bolt'), 'Nut &amp; Bolt');
eq('ampersand is replaced first (no double-escaping)',
  escapeHtml('<'), '&lt;');
eq('quotes are escaped', escapeHtml('X"Y'), 'X&quot;Y');
eq('null and undefined render as empty, not as the word',
  [escapeHtml(null), escapeHtml(undefined)], ['', '']);
// Round trip: what the browser parses back out must equal what went in.
const unescape = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&');
const lost = SPECIALS.filter((v) => unescape(escapeHtml(v)) !== v);
eq('every special value survives escape → render unchanged', lost, []);

check('printData escapes cells, headers and the title',
  (() => {
    const eu = src('frontend/src/utils/exportUtils.js');
    return /escapeHtml\(cellValue\(item, col\)\)/.test(eu)
      && /escapeHtml\(col\.label\)/.test(eu)
      && /const safeTitle = escapeHtml\(title\)/.test(eu)
      && !/<td>\$\{cellValue/.test(eu);
  })());

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(60));
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailed:');
  for (const f of failures) console.log(`  • ${f}`);
}
console.log(
  '\nNot covered here (needs a live MongoDB — this script never connects):\n'
  + '  • applyBoxNumbers / processMaster / processFreshInventory end to end\n'
  + '  • raisePo actually re-stamping rows and locking the booking\n'
  + '  • currentBoxNumbers resolving products by SKU and brand\n'
  + '  • real SMTP delivery of the Cc header\n'
  + 'Section 6 asserts the wiring for these; it does not execute them.',
);

process.exit(failed ? 1 : 0);
