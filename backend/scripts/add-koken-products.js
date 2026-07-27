/**
 * add-koken-products.js
 * -----------------------------------------------------------------------------
 * Adds the four Ko-ken codes that appeared in "Ko-ken stock JULY COUNTING 26.xlsx"
 * but had no matching product in `products_koken`.
 *
 * For each new product only what the stock sheet actually tells us is set:
 *   skuCode, msilCode, totalAvailableQuantity, availableForSale,
 *   openingStockQuantity, openingStockDate, status
 *
 * Everything else (category, moq, leadTime, safetyFactor, maxLevel,
 * dailyAvgConsumption, boxNo, vendorName) is left at the schema default —
 * the stock sheet carries no data for those fields, so they are not invented.
 *
 * Two of the codes carry an MSIL code. `reservation.controller.js` rejects a
 * booking when a product has an msilCode that is missing/inactive in the
 * MsilCode collection, so those codes are registered there too (same behaviour
 * as scripts/sync-msil.js).
 *
 * Safe to re-run — existing skuCodes and MSIL codes are skipped, not duplicated.
 *
 * Usage:
 *   node scripts/add-koken-products.js            # dry run (default)
 *   node scripts/add-koken-products.js --apply    # write to the database
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ProductKoken } from '../models/Product.js';
import MsilCode from '../models/MsilCode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const APPLY = process.argv.includes('--apply');

// Straight from the July count sheet (rows 262, 736, 742, 795)
const NEW_PRODUCTS = [
  { skuCode: '165BM.80-10X12', msilCode: 'MA5I6000000', stock: 3 },
  { skuCode: '2725RK-2(3/8)',  msilCode: null,          stock: 0 },
  { skuCode: 'NV13760-150',    msilCode: 'MA0M200K000', stock: 0 },
  { skuCode: '14760-300',      msilCode: null,          stock: 6 },
];

// The date the stock was physically counted, used as the opening-stock date.
const COUNT_DATE = new Date('2026-07-26T00:00:00.000Z');

const run = async () => {
  console.log(`\n⚙️   Mode : ${APPLY ? 'APPLY (writes to DB)' : 'DRY RUN (no writes)'}\n`);

  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log(`🔌  Connected to MongoDB (${mongoose.connection.name})`);
  console.log(`📦  ${await ProductKoken.countDocuments()} Koken products before.\n`);

  const toInsert = [];
  const skipped = [];

  for (const p of NEW_PRODUCTS) {
    const existing = await ProductKoken.findOne({ skuCode: p.skuCode }, 'skuCode').lean();
    if (existing) { skipped.push(p.skuCode); continue; }

    toInsert.push({
      skuCode: p.skuCode,
      msilCode: p.msilCode,
      totalAvailableQuantity: p.stock,
      availableForSale: p.stock,      // nothing booked against a brand-new product
      bookedQuantity: 0,
      openingStockQuantity: p.stock,
      openingStockDate: COUNT_DATE,
      status: 'Active',
    });
  }

  // MSIL codes that need registering so reservations don't get rejected
  const msilNeeded = [];
  for (const p of NEW_PRODUCTS) {
    if (!p.msilCode) continue;
    const exists = await MsilCode.findOne({ code: p.msilCode }).lean();
    if (!exists) msilNeeded.push(p.msilCode);
  }

  console.log('──────────── PLAN ────────────');
  toInsert.forEach(d =>
    console.log(`   + ${d.skuCode.padEnd(16)} msil ${(d.msilCode || '—').padEnd(12)} stock ${d.totalAvailableQuantity}`)
  );
  skipped.forEach(s => console.log(`   = ${s} — already exists, skipped`));
  msilNeeded.forEach(c => console.log(`   + MsilCode ${c} (Active)`));
  console.log('──────────────────────────────\n');

  if (!APPLY) {
    console.log('🚫  Dry run — nothing written. Re-run with --apply to commit.\n');
    await mongoose.disconnect();
    return;
  }

  if (toInsert.length) {
    const res = await ProductKoken.insertMany(toInsert, { ordered: false });
    console.log(`✅  Inserted ${res.length} Koken product(s).`);
  } else {
    console.log('✅  No new products to insert.');
  }

  if (msilNeeded.length) {
    await MsilCode.insertMany(msilNeeded.map(code => ({ code, status: 'Active' })), { ordered: false });
    console.log(`✅  Registered ${msilNeeded.length} MSIL code(s).`);
  }

  console.log(`📦  ${await ProductKoken.countDocuments()} Koken products after.\n`);
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('\n❌  Failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
