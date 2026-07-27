/**
 * update-koken-stock.js
 * -----------------------------------------------------------------------------
 * Updates physical stock for Koken products from the monthly stock-count sheet.
 *
 * Excel columns expected (headers on row 1):
 *   Ko-ken code | MSIL code | STOCK PHYSICALLY
 *
 * Matching is done on `skuCode` (Ko-ken code). For every matched product:
 *   totalAvailableQuantity = STOCK PHYSICALLY
 *   availableForSale       = max(0, STOCK PHYSICALLY - bookedQuantity)
 *   availableInPercent     = totalAvailableQuantity / maxLevel * 100  (only when maxLevel > 0)
 *
 * Nothing else is touched — bookedQuantity, openingStockQuantity, msilCode,
 * category and pricing fields are all left as-is.
 *
 * Usage:
 *   node scripts/update-koken-stock.js                 # dry run (default)
 *   node scripts/update-koken-stock.js --apply         # write to the database
 *   node scripts/update-koken-stock.js --apply --file="path/to/sheet.xlsx"
 */

import mongoose from 'mongoose';
import XLSX from 'xlsx';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ProductKoken } from '../models/Product.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// -----------------------------------------------------------------------------
// CLI args
// -----------------------------------------------------------------------------
const getArg = (name) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=').replace(/^["']|["']$/g, '') : null;
};

const APPLY = process.argv.includes('--apply');
const FILE  = getArg('file') ||
  path.join(__dirname, '..', '..', 'Ko-ken stock JULY COUNTING 26.xlsx');

const COL_CODE  = 'Ko-ken code';
const COL_STOCK = 'STOCK PHYSICALLY';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const toStr = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

const toQty = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? Math.round(n) : null;
};

const round = (n, dp = 10) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

// -----------------------------------------------------------------------------
// Read the sheet
// -----------------------------------------------------------------------------
const readStockRows = () => {
  const wb = XLSX.readFile(FILE);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

  const parsed = [];
  const badRows = [];

  rows.forEach((row, i) => {
    const code  = toStr(row[COL_CODE]);
    const stock = toQty(row[COL_STOCK]);

    if (!code) return;                                    // padding row
    if (stock === null) { badRows.push({ code, excelRow: i + 2 }); return; }

    parsed.push({ code, stock, excelRow: i + 2 });
  });

  // Same SKU listed twice (e.g. counted in two boxes) → sum the counts
  const merged = new Map();
  const dupes = [];
  for (const r of parsed) {
    const key = r.code.toUpperCase();
    if (merged.has(key)) {
      const prev = merged.get(key);
      dupes.push({ code: r.code, rows: [prev.excelRow, r.excelRow], stocks: [prev.stock, r.stock] });
      prev.stock += r.stock;
    } else {
      merged.set(key, { ...r });
    }
  }

  return { rows: [...merged.values()], badRows, dupes };
};

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
const run = async () => {
  console.log(`\n📄  Sheet : ${FILE}`);
  console.log(`⚙️   Mode  : ${APPLY ? 'APPLY (writes to DB)' : 'DRY RUN (no writes)'}\n`);

  const { rows, badRows, dupes } = readStockRows();
  console.log(`   Parsed ${rows.length} unique Ko-ken codes from the sheet.`);
  if (dupes.length) {
    console.log(`   ℹ️   ${dupes.length} code(s) appeared more than once — counts summed:`);
    dupes.forEach(d => console.log(`        ${d.code}  rows ${d.rows.join('+')}  ${d.stocks.join(' + ')} = ${d.stocks.reduce((a, b) => a + b, 0)}`));
  }
  if (badRows.length) {
    console.log(`   ⚠️   ${badRows.length} row(s) skipped — blank/non-numeric "${COL_STOCK}":`);
    badRows.slice(0, 20).forEach(r => console.log(`        row ${r.excelRow}: ${r.code}`));
    if (badRows.length > 20) console.log(`        ...and ${badRows.length - 20} more`);
  }

  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log(`\n🔌  Connected to MongoDB (${mongoose.connection.name})`);

  // Index the collection by upper-cased skuCode so matching is case-insensitive
  const products = await ProductKoken.find(
    {},
    'skuCode totalAvailableQuantity availableForSale bookedQuantity availableInPercent maxLevel'
  ).lean();

  const bySku = new Map();
  products.forEach(p => {
    const key = String(p.skuCode).trim().toUpperCase();
    if (!bySku.has(key)) bySku.set(key, p);
  });
  console.log(`📦  ${products.length} Koken products in the database.\n`);

  const ops = [];
  const changed = [];
  const unchanged = [];
  const notFound = [];
  const clamped = [];

  for (const r of rows) {
    const product = bySku.get(r.code.toUpperCase());
    if (!product) { notFound.push(r); continue; }

    const booked = product.bookedQuantity || 0;
    const afs = Math.max(0, r.stock - booked);
    if (r.stock < booked) clamped.push({ ...r, booked });

    // Only the counted quantity decides whether a row is a change;
    // availableInPercent is derived and gets recomputed alongside it.
    const same =
      product.totalAvailableQuantity === r.stock &&
      product.availableForSale === afs;

    if (same) { unchanged.push(r); continue; }

    // maxLevel is 0 for most Koken rows; without it the percentage is undefined,
    // so leave the stored value alone rather than flattening it to 0.
    const pct = product.maxLevel ? round((r.stock / product.maxLevel) * 100) : null;

    changed.push({
      skuCode: product.skuCode,
      from: { total: product.totalAvailableQuantity, afs: product.availableForSale },
      to:   { total: r.stock, afs },
      booked,
    });

    ops.push({
      updateOne: {
        filter: { _id: product._id },
        update: {
          $set: {
            totalAvailableQuantity: r.stock,
            availableForSale: afs,
            ...(pct === null ? {} : { availableInPercent: pct }),
          },
        },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  console.log('──────────── SUMMARY ────────────');
  console.log(`   Codes in sheet        : ${rows.length}`);
  console.log(`   Matched in database   : ${rows.length - notFound.length}`);
  console.log(`   → stock changed       : ${changed.length}`);
  console.log(`   → already correct     : ${unchanged.length}`);
  console.log(`   Not found in database : ${notFound.length}`);
  console.log(`   Untouched DB products : ${products.length - (rows.length - notFound.length)}`);
  console.log('─────────────────────────────────\n');

  if (clamped.length) {
    console.log(`⚠️   ${clamped.length} product(s) counted below their booked quantity — availableForSale floored at 0:`);
    clamped.slice(0, 20).forEach(c => console.log(`     ${c.code}: counted ${c.stock}, booked ${c.booked}`));
    if (clamped.length > 20) console.log(`     ...and ${clamped.length - 20} more`);
    console.log('');
  }

  if (notFound.length) {
    console.log(`⚠️   Codes in the sheet with no matching Koken product (skipped):`);
    notFound.slice(0, 40).forEach(r => console.log(`     row ${r.excelRow}: ${r.code} (stock ${r.stock})`));
    if (notFound.length > 40) console.log(`     ...and ${notFound.length - 40} more`);
    console.log('');
  }

  if (changed.length) {
    console.log(`📝  First ${Math.min(25, changed.length)} changes:`);
    changed.slice(0, 25).forEach(c =>
      console.log(`     ${c.skuCode.padEnd(20)} total ${String(c.from.total).padStart(6)} → ${String(c.to.total).padStart(6)}   afs ${String(c.from.afs).padStart(6)} → ${String(c.to.afs).padStart(6)}${c.booked ? `   (booked ${c.booked})` : ''}`)
    );
    if (changed.length > 25) console.log(`     ...and ${changed.length - 25} more`);
    console.log('');
  }

  if (!APPLY) {
    console.log('🚫  Dry run — nothing written. Re-run with --apply to commit these changes.\n');
    await mongoose.disconnect();
    return;
  }

  if (ops.length === 0) {
    console.log('✅  Nothing to update.\n');
    await mongoose.disconnect();
    return;
  }

  const result = await ProductKoken.bulkWrite(ops, { ordered: false });
  console.log(`✅  Updated ${result.modifiedCount} product(s) (matched ${result.matchedCount}).\n`);

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('\n❌  Failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
