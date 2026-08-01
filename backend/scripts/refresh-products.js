/**
 * refresh-products.js
 * -----------------------------------------------------------------------------
 * Refreshes Koken / BIX / IMADA product data from the "Pankaj's Copy of IMS By
 * D Table" workbooks, with the July physical count taking priority for Koken.
 *
 * Stock priority (as requested):
 *   1. "Ko-ken stock JULY COUNTING 26.xlsx"  — wins for any Koken SKU it lists
 *   2. Pankaj workbook "Total Available Quantity" — used for everything else
 *
 * Deliberate rules:
 *   • UPSERT, never delete. migrate.js does deleteMany() first, which would drop
 *     the 4 SKUs added from the July sheet (they are absent from the Pankaj file).
 *   • bookedQuantity is forced to 0 and NOT taken from the workbook. The Pankaj
 *     file still carries 391 units of bookings that were erased in the fresh
 *     start; importing them would resurrect holds with no reservation behind them.
 *   • availableForSale is always recomputed as totalAvailableQuantity - bookedQuantity.
 *   • Blank numeric cells coerce to 0, matching migrate.js's toNum().
 *
 * Usage:
 *   node scripts/refresh-products.js                    # dry run, all brands
 *   node scripts/refresh-products.js --apply
 *   node scripts/refresh-products.js --brand=bix --apply
 */

import mongoose from 'mongoose';
import XLSX from 'xlsx';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ProductKoken, ProductBIX, ProductIMADA } from '../models/Product.js';
import { normaliseSeason, describeSeasonIssues } from '../utils/productFields.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const getArg = (n) => {
  const hit = process.argv.find(a => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=').replace(/^["']|["']$/g, '') : null;
};
const APPLY = process.argv.includes('--apply');
const ONLY  = (getArg('brand') || '').toLowerCase();

const ROOT = path.join(__dirname, '..', '..');
const JULY_FILE = path.join(ROOT, 'Ko-ken stock JULY COUNTING 26.xlsx');

const BRANDS = [
  { key: 'koken', Model: ProductKoken, sheet: 'Inventory - Koken', file: path.join(ROOT, "Pankaj's Copy of IMS By D Table (koken).xlsx") },
  { key: 'bix',   Model: ProductBIX,   sheet: 'Inventory - BIX',   file: path.join(ROOT, "Pankaj's Copy of IMS By D Table (Bix).xlsx") },
  { key: 'imada', Model: ProductIMADA, sheet: 'Inventory - IMADA', file: path.join(ROOT, "Pankaj's Copy of IMS By D Table (IMADA).xlsx") },
];

// ─── helpers (mirroring scripts/migrate.js) ──────────────────────────────────
const toStr = (v) => { if (v === null || v === undefined) return null; const s = String(v).trim(); return s === '' ? null : s; };
const toNum = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const toArray = (v) => (!v ? [] : String(v).split(',').map(s => s.trim()).filter(Boolean));
const toDate = (v) => { if (!v) return null; const d = v instanceof Date ? v : new Date(v); return isNaN(d.getTime()) ? null : d; };
const mapStatus = (v) => {
  const s = toStr(v);
  if (!s) return 'Active';
  const l = s.toLowerCase();
  if (l.startsWith('inact')) return 'Inactive';
  if (l.startsWith('discont')) return 'Discontinued';
  return 'Active';
};
const near = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.0001;

// ─── July physical counts (Koken only) ───────────────────────────────────────
const readJuly = () => {
  const wb = XLSX.readFile(JULY_FILE);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
  const map = new Map();
  for (const r of rows) {
    const code = toStr(r['Ko-ken code']);
    const raw = r['STOCK PHYSICALLY'];
    if (!code || raw === null || String(raw).trim() === '') continue;
    const n = Number(String(raw).replace(/,/g, '').trim());
    if (Number.isFinite(n)) map.set(code.toUpperCase(), Math.round(n));
  }
  return map;
};

const run = async () => {
  console.log(`\n⚙️   Mode : ${APPLY ? 'APPLY (writes to DB)' : 'DRY RUN (no writes)'}`);
  const july = readJuly();
  console.log(`📄  July count sheet: ${july.size} Koken SKUs take stock priority\n`);

  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log(`🔌  Connected to MongoDB (${mongoose.connection.name})`);

  for (const b of BRANDS) {
    if (ONLY && ONLY !== b.key) continue;

    // cellDates:true — same as migrate.js, so date cells arrive as Date objects
    // rather than Excel serial numbers (which would parse into 1970).
    const wb = XLSX.readFile(b.file, { cellDates: true });
    const ws = wb.Sheets[b.sheet];
    if (!ws) { console.log(`\n❌  ${b.key}: sheet "${b.sheet}" not found`); continue; }

    const rows = XLSX.utils.sheet_to_json(ws, { range: 1, defval: null })
      .filter(r => toStr(r['SKU Code']));

    // Last occurrence wins, matching migrate.js's dedupe
    const src = new Map();
    for (const r of rows) src.set(toStr(r['SKU Code']).toUpperCase(), r);

    const existing = await b.Model.find({}).lean();
    const dbMap = new Map(existing.map(d => [String(d.skuCode).trim().toUpperCase(), d]));

    const ops = [];
    const seasonIssues = [];
    let julyWins = 0, sheetStock = 0, inserts = 0, fieldChanges = 0;
    const stockChanges = [];

    for (const [key, r] of src) {
      const sku = toStr(r['SKU Code']);
      const d = dbMap.get(key);

      // ── stock priority ──
      let total;
      if (b.key === 'koken' && july.has(key)) { total = july.get(key); julyWins++; }
      else { total = toNum(r['Total Available Quantity']); sheetStock++; }

      const booked = 0;                       // fresh start — nothing is held
      const afs = total - booked;
      const maxLevel = toNum(r['Max Level']);

      const doc = {
        skuCode: sku,
        msilCode: toStr(r['MSIL Code']),
        category: toArray(r['Category']),
        itemParameter: toStr(r['Item Parameter\n(Optional)']) ?? toStr(r['Item Parameter\r\n(Optional)']) ?? toStr(r['Item Parameter (Optional)']),
        dailyAvgConsumption: {
          low: toNum(r['Daily Avg Consumption (Low)']),
          normal: toNum(r['Daily Avg Consumption (Normal)']),
          peak: toNum(r['Daily Avg Consumption (Peak)']),
        },
        currentSeason: (() => {
          // Validated against the schema enum rather than written blind:
          // bulkWrite skips validators, so an unmapped value would otherwise
          // land in the database silently.
          const season = normaliseSeason(r['Current Season']);
          if (!season.ok) seasonIssues.push({ sku, raw: season.raw });
          return season.value;
        })(),
        leadTime: toNum(r['Lead Time']),
        safetyFactor: toNum(r['Safety Factor']),
        maxLevel,
        openingStockQuantity: r['Opening Stock Quantity'] != null ? toNum(r['Opening Stock Quantity']) : null,
        totalAvailableQuantity: total,
        // maxLevel is 0 for most rows; the percentage is undefined without it,
        // so leave the stored value alone rather than flattening 377 rows to 0.
        ...(maxLevel ? { availableInPercent: (total / maxLevel) * 100 } : {}),
        openingStockDate: toDate(r['Opening Stock Date']),
        bookedQuantity: booked,
        availableForSale: afs,
        moq: toNum(r['MOQ']),
        boxNo: toStr(r['Box No']),
        status: mapStatus(r['Status']),
        inTransitQty: toNum(r['In-Transit Qty']),
        vendorName: toStr(r['Vendor Name']),
      };

      if (!d) inserts++;
      else {
        if (d.totalAvailableQuantity !== total || d.availableForSale !== afs || d.bookedQuantity !== booked) {
          stockChanges.push({ sku, from: d.totalAvailableQuantity, to: total });
        }
        const metaChanged =
          (d.msilCode ?? null) !== doc.msilCode ||
          JSON.stringify(d.category || []) !== JSON.stringify(doc.category) ||
          !near(d.leadTime, doc.leadTime) || !near(d.safetyFactor, doc.safetyFactor) ||
          !near(d.maxLevel, doc.maxLevel) || !near(d.moq, doc.moq) ||
          (d.boxNo ?? null) !== doc.boxNo || (d.vendorName ?? null) !== doc.vendorName ||
          d.status !== doc.status;
        if (metaChanged) fieldChanges++;
      }

      ops.push({
        updateOne: { filter: { skuCode: sku }, update: { $set: doc }, upsert: true },
      });
    }

    const orphans = [...dbMap.keys()].filter(k => !src.has(k));

    console.log(`\n=== ${b.key.toUpperCase()} ===`);
    console.log(`   sheet SKUs ${src.size} | db SKUs ${dbMap.size}`);
    console.log(`   stock from July sheet   : ${julyWins}`);
    console.log(`   stock from Pankaj sheet : ${sheetStock}`);
    console.log(`   new SKUs to insert      : ${inserts}`);
    console.log(`   stock values changing   : ${stockChanges.length}`);
    console.log(`   metadata changing       : ${fieldChanges}`);
    console.log(`   in db but not in sheet  : ${orphans.length} (kept, not deleted)${orphans.length && orphans.length <= 6 ? ' → ' + orphans.join(', ') : ''}`);

    const seasonReport = describeSeasonIssues(seasonIssues);
    if (seasonReport) {
      console.log(`
   ❌  ${seasonReport}`);
      seasonIssues.slice(0, 10).forEach(i => console.log(`      ${i.sku}: "${i.raw}"`));
      if (seasonIssues.length > 10) console.log(`      ...and ${seasonIssues.length - 10} more`);
    }
    if (stockChanges.length) {
      console.log('   stock diffs:');
      stockChanges.slice(0, 15).forEach(c => console.log(`      ${c.sku.padEnd(18)} ${c.from} → ${c.to}`));
      if (stockChanges.length > 15) console.log(`      ...and ${stockChanges.length - 15} more`);
    }

    // Refuse to write a brand whose sheet carries values the schema rejects —
    // a partial import is harder to unpick than a refused one.
    if (APPLY && seasonIssues.length) {
      console.log(`
   🚫  Skipping ${b.key.toUpperCase()} — fix the season values above first.
`);
      continue;
    }

    if (APPLY && ops.length) {
      // timestamps:false — otherwise Mongoose stamps a fresh updatedAt into every
      // $set, so modifiedCount reports every document even when no value changed.
      const res = await b.Model.bulkWrite(ops, { ordered: false, timestamps: false });
      console.log(`   ✅  upserted ${res.upsertedCount}, modified ${res.modifiedCount}`);
    }
  }

  if (!APPLY) console.log('\n🚫  Dry run — nothing written. Re-run with --apply to commit.\n');
  else console.log('\n✅  Refresh complete.\n');
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('\n❌  Failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
