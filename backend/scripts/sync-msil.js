/**
 * sync-msil.js
 * -----------------------------------------------------------------------------
 * Register every MSIL code the product master uses into the `msilcodes`
 * allowlist.
 *
 *   node scripts/sync-msil.js            # DRY RUN — reports the gap, writes nothing
 *   node scripts/sync-msil.js --apply    # register the missing codes
 *   npm run msil:check / npm run msil:sync
 *
 * WHY THIS IS NEEDED AT ALL
 *
 * An MSIL code lives in two places: on the product, and as a row in `msilcodes`
 * saying the code is one we accept orders against. Booking checks the SECOND.
 * A SKU whose code was never registered fails with
 *
 *     MSIL Code MA0M200L000 for product NV13760-250 is inactive or does not exist.
 *
 * even though the SKU is perfectly fine. The three write paths that set an MSIL
 * code now register it as they go (utils/msilRegistry.js), so this script is the
 * REPAIR TOOL rather than the mechanism: it closes a gap left by rows written
 * before that, or by a registration that failed at the time.
 *
 * IT ONLY ADDS. A code deliberately set to Inactive stays Inactive — withdrawing
 * a code is a decision, and a sync must not quietly reverse it.
 *
 * THIS FILE WAS BROKEN. It imported ../models/ProductKoken.js, ProductBIX.js and
 * ProductIMADA.js, which stopped existing when the three product collections
 * were unified behind one discriminated `Product` model. It threw on startup, so
 * nobody could have run it — which is a fair part of why the allowlist had drifted
 * 24 codes behind by September 2026.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { connectDatabase } = await import('../config/database.js');
const { Product } = await import('../models/Product.js');
const MsilCode = (await import('../models/MsilCode.js')).default;
const { registerMsilCodes } = await import('../utils/msilRegistry.js');
const { ALL_BRANDS } = await import('../utils/brandAccess.js');

const APPLY = process.argv.includes('--apply');
const INCLUDE_UNKNOWN_BRANDS = process.argv.includes('--all-brands');

const main = async () => {
  await connectDatabase();

  const products = await Product.find(
    { msilCode: { $nin: [null, ''] } },
    'skuCode brand msilCode status',
  ).lean();

  const rows = await MsilCode.find({}, 'code status').lean();
  const known = new Map(rows.map((r) => [r.code, r.status]));

  /**
   * Only the REAL catalogue, unless --all-brands says otherwise.
   *
   * The products collection still holds demo rows written before the three
   * brand collections were unified: no SKU code, and a `brand` like
   * "ABC Cables" that is not one of the three the portal sells. They carry
   * invented MSIL codes, and registering those would put codes in the allowlist
   * for products nobody can order — noise in the one place that has to be a
   * clean answer to "may we take an order against this code".
   */
  const missing = new Map();   // code -> the products using it
  const skipped = [];
  let active = 0;
  let inactive = 0;
  for (const p of products) {
    const status = known.get(p.msilCode);
    if (status === 'Active') { active += 1; continue; }
    if (status === 'Inactive') { inactive += 1; continue; }
    if (!ALL_BRANDS.includes(p.brand) && !INCLUDE_UNKNOWN_BRANDS) { skipped.push(p); continue; }
    if (!missing.has(p.msilCode)) missing.set(p.msilCode, []);
    missing.get(p.msilCode).push(p);
  }

  console.log('\nMSIL allowlist vs the product master\n');
  console.log(`  Products carrying an MSIL code   ${products.length}`);
  console.log(`  Rows in the msilcodes allowlist  ${rows.length}`);
  console.log(`  Registered and Active            ${active}`);
  console.log(`  Registered but INACTIVE          ${inactive}   (left alone — withdrawing a code is deliberate)`);
  console.log(`  NOT REGISTERED AT ALL            ${missing.size} code(s) across ${[...missing.values()].flat().length} product(s)`);
  if (skipped.length) {
    console.log(`  Skipped, brand not one of ${ALL_BRANDS.join('/')}   ${skipped.length}   (--all-brands to include them)`);
  }

  if (inactive) {
    console.log('\n  Inactive codes still in use by a product:');
    for (const p of products) {
      if (known.get(p.msilCode) === 'Inactive') {
        console.log(`    ${String(p.skuCode ?? '(no sku)').padEnd(18)} ${p.msilCode}  (${p.brand})`);
      }
    }
  }

  if (!missing.size) {
    console.log('\n  Nothing to do — every MSIL code in use is registered.\n');
    await mongoose.disconnect();
    return;
  }

  console.log('\n  Unregistered:');
  for (const [code, users] of missing) {
    const who = users
      .map((u) => `${u.skuCode ?? '(no sku)'} [${u.brand}]`)
      .join(', ');
    console.log(`    ${code.padEnd(16)} ${who}`);
  }

  if (!APPLY) {
    console.log('\n  DRY RUN — re-run with --apply to register them.\n');
    await mongoose.disconnect();
    return;
  }

  const result = await registerMsilCodes([...missing.keys()]);
  console.log(`\n  Registered ${result.added.length} code(s) as Active.\n`);

  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error('\nsync-msil failed:', error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
