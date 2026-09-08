/**
 * verify-msil.js
 * -----------------------------------------------------------------------------
 * The MSIL allowlist: that it stays in step with the product master, and that
 * registering a code can only ever OPEN a gate that was never opened, not
 * reopen one somebody closed.
 *
 *   node scripts/verify-msil.js
 *
 * The behavioural checks write and then delete two throwaway codes under a
 * ZZ-VERIFY- prefix, and the last check proves they are gone. Nothing else in
 * the database is touched.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { connectDatabase } = await import('../config/database.js');
const { Product } = await import('../models/Product.js');
const MsilCode = (await import('../models/MsilCode.js')).default;
const { registerMsilCode, registerMsilCodes } = await import('../utils/msilRegistry.js');
const { ALL_BRANDS } = await import('../utils/brandAccess.js');
const { createSku } = await import('../modules/inventory/sku.service.js');
const { msilAppliesTo } = await import('../utils/msilVisibility.js');
const { moqError } = await import('../utils/moq.js');

let passed = 0;
let failed = 0;
const check = (label, ok) => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}`); }
};
const section = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);
const src = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* ── 1. Every path that sets an MSIL code registers it ────────────────────── */
section('1. THE THREE WRITE PATHS');

const skuSvc = src('modules/inventory/sku.service.js');
const invCtl = src('modules/inventory/inventory.controller.js');
const impSvc = src('modules/inventory/import.service.js');

check('Add SKU registers the code it was given',
  skuSvc.includes("from '../../utils/msilRegistry.js'")
  && /registerMsilCode\(created\.msilCode\)/.test(skuSvc));
check('...AFTER the product is created, so a rejected SKU registers nothing',
  skuSvc.indexOf('await Model.create(doc)') < skuSvc.indexOf('registerMsilCode(created.msilCode)'));
check('the planning edit registers a code moved onto a SKU',
  invCtl.includes("from '../../utils/msilRegistry.js'")
  && /if \(updates\.msilCode\) await registerMsilCode\(updated\.msilCode\)/.test(invCtl));
check('the Inventory Master import registers the codes its sheet introduced',
  impSvc.includes("from '../../utils/msilRegistry.js'")
  && /registerMsilCodes\(importedMsilCodes\)/.test(impSvc));
check('the import only registers codes on rows that actually landed',
  /landedRows\.has\(r\.rowNumber\) && r\.data\?\.msilCode/.test(impSvc));

/* ── 2. The gate booking checks ───────────────────────────────────────────── */
section('2. THE GATE ITSELF IS UNCHANGED');

const resCtl = src('modules/reservations/reservation.controller.js');
check('booking still requires an ACTIVE row, not merely a row',
  (resCtl.match(/msilDoc\.status !== 'Active'/g) || []).length >= 2);
check('the check is still confined to users MSIL applies to',
  /msilAppliesTo\(req\.user\) && product\.msilCode/.test(resCtl));

/* ── 3. Registration behaviour ────────────────────────────────────────────── */
await connectDatabase();
section('3. REGISTERING A CODE');

const NEW = 'ZZ-VERIFY-NEW';
const CLOSED = 'ZZ-VERIFY-CLOSED';
await MsilCode.deleteMany({ code: { $in: [NEW, CLOSED] } });

const first = await registerMsilCode(NEW);
check('a code nobody has seen is added, and reported as added', first.added === true);
check('...and it is Active, which is what makes the SKU bookable',
  (await MsilCode.findOne({ code: NEW }).lean())?.status === 'Active');

const again = await registerMsilCode(NEW);
check('registering it a second time adds nothing', again.added === false);

// The gate somebody deliberately closed.
await MsilCode.create({ code: CLOSED, status: 'Inactive' });
await registerMsilCode(CLOSED);
check('a code set to INACTIVE is never quietly reopened',
  (await MsilCode.findOne({ code: CLOSED }).lean())?.status === 'Inactive');

check('a blank or absent code is a no-op, not a blank row',
  (await registerMsilCode('')).added === false
  && (await registerMsilCode(null)).added === false
  && (await registerMsilCode('   ')).added === false
  && (await MsilCode.countDocuments({ code: { $in: ['', '   '] } })) === 0);

const bulk = await registerMsilCodes([NEW, CLOSED, '  ', null]);
check('the bulk path skips what is already known and what is blank',
  bulk.added.length === 0);

await MsilCode.deleteMany({ code: { $in: [NEW, CLOSED] } });
check('the throwaway codes are gone again',
  (await MsilCode.countDocuments({ code: /^ZZ-VERIFY-/ })) === 0);

/* ── 4. The live allowlist ────────────────────────────────────────────────── */
section('4. THE LIVE ALLOWLIST');

const products = await Product.find(
  { msilCode: { $nin: [null, ''] }, brand: { $in: ALL_BRANDS } },
  'skuCode brand msilCode',
).lean();
const known = new Map((await MsilCode.find({}, 'code status').lean()).map((r) => [r.code, r.status]));
const unregistered = products.filter((p) => !known.has(p.msilCode));
const inactive = products.filter((p) => known.get(p.msilCode) === 'Inactive');

check(`every MSIL code in the real catalogue is registered (${products.length} products)`,
  unregistered.length === 0);
for (const p of unregistered.slice(0, 10)) console.log(`        ${p.skuCode} -> ${p.msilCode}`);

check('the four SKUs added on 2026-09-07 are bookable',
  ['MA0M200L000', 'MA0M200J000', 'MA0M200N000', 'MA0M200O000']
    .every((c) => known.get(c) === 'Active'));

// Not a failure — a withdrawn code is a decision. Reported so it is never a
// surprise when a booking is refused.
if (inactive.length) {
  console.log(`\n  NOTE  ${inactive.length} product(s) carry a code that is registered INACTIVE.`);
  console.log('        Bookings for these are refused on purpose:');
  for (const p of inactive.slice(0, 10)) console.log(`        ${p.skuCode} -> ${p.msilCode}`);
}

/* ── 5. A SKU created right now ───────────────────────────────────────────── */
section('5. A SKU CREATED RIGHT NOW IS IMMEDIATELY BOOKABLE');

/**
 * The headline claim, RUN rather than asserted.
 *
 * It calls the SERVICE, not the controller: createSku() writes the product and
 * registers the code and nothing else, so the round trip leaves no health row
 * and no alert behind. Then it applies the gates the booking path applies,
 * verbatim, and deletes what it made.
 */
const TEST_SKU = 'ZZ-VERIFY-SKU-001';
const TEST_MSIL = 'ZZ-VERIFY-MA0001';

await Product.deleteMany({ skuCode: TEST_SKU });
await MsilCode.deleteMany({ code: TEST_MSIL });

try {
  const { product } = await createSku({
    payload: {
      skuCode: TEST_SKU, brand: 'Koken', msilCode: TEST_MSIL,
      description: 'verify-msil throwaway',
    },
    actor: { _id: 'verify', role: 'Admin' },
    allowedBrandList: ALL_BRANDS,
  });

  const msilCustomer = { _id: 'c1', role: 'Customer', customerCategory: 'MSIL', email: 'buyer@example.com' };

  check('the MSIL gate applies to an MSIL customer, so this is the real path',
    msilAppliesTo(msilCustomer) === true);

  // The exact lookup reservation.controller.js performs.
  const gate = await MsilCode.findOne({ code: product.msilCode }).lean();
  check('its code is on the allowlist the instant the SKU exists',
    Boolean(gate) && gate.status === 'Active');
  check('so the booking gate does NOT refuse it',
    !(!gate || gate.status !== 'Active'));

  check('the SKU is Active in the catalogue without anyone setting it',
    product.status === 'Active');
  check('no MOQ blocks a quantity of 1 on a fresh SKU',
    moqError(msilCustomer, product, 1) === null
    && moqError({ _id: 'c2', role: 'Customer', email: 'other@example.com' }, product, 1) === null);
} finally {
  await Product.deleteMany({ skuCode: TEST_SKU });
  await MsilCode.deleteMany({ code: TEST_MSIL });
}

check('the throwaway SKU and its code are gone again',
  (await Product.countDocuments({ skuCode: TEST_SKU })) === 0
  && (await MsilCode.countDocuments({ code: TEST_MSIL })) === 0);

console.log(`\n${passed} passed, ${failed} failed\n`);
await mongoose.disconnect();
process.exit(failed ? 1 : 0);

