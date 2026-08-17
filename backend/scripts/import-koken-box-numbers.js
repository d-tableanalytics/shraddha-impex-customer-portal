/**
 * import-koken-box-numbers.js
 * -----------------------------------------------------------------------------
 * One-off import of the SKU → Box Number mapping for KOKEN, from a two-column
 * sheet ("Sku code", "box no").
 *
 * DRY RUN BY DEFAULT. Nothing is written unless --apply is passed, so the
 * report below can be read before the database is touched.
 *
 *   node scripts/import-koken-box-numbers.js            # report only
 *   node scripts/import-koken-box-numbers.js --apply    # write
 *   node scripts/import-koken-box-numbers.js --file "../Some Other.xlsx"
 *
 * Why a script rather than the M9 import pipeline: that pipeline stages an
 * uploaded file against a job owned by a signed-in user, which does not exist
 * on a command line. The rules it enforces are reproduced here deliberately —
 * box numbers are stored as TEXT, a blank cell is skipped rather than treated
 * as a clear, and only rows that actually change are written and audited.
 */

import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import XLSX from 'xlsx';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { Product, ProductKoken } = await import('../models/Product.js');
const { boxNumberChanges, boxRowKey, suppliesBoxNo } =
  await import('../modules/inventory/boxNumber.rules.js');

const APPLY = process.argv.includes('--apply');
const fileArg = process.argv.indexOf('--file');
const FILE = fileArg > -1
  ? process.argv[fileArg + 1]
  : path.join(__dirname, '..', '..', 'docs', 'Model No & Box No.xlsx');

const BRAND = 'Koken';

/**
 * Read the sheet into { skuCode, boxNo } rows.
 *
 * Box numbers arrive as a MIX of numbers and text — "1" is stored by Excel as
 * the number 1 while "1B-1" is a string. Both are stored as text, because the
 * field is an identifier and not a quantity: left as a number, box 1 and box
 * "1" would be two different values on the same shelf, and "01" would already
 * have lost its leading zero.
 */
const readSheet = (file) => {
  const wb = XLSX.readFile(file, { dense: true, cellDates: true, cellFormula: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, blankrows: false, defval: null });

  const header = (raw[0] || []).map((h) => String(h ?? '').trim().toLowerCase());
  const skuIdx = header.findIndex((h) => h.includes('sku') || h.includes('model'));
  const boxIdx = header.findIndex((h) => h.includes('box'));
  if (skuIdx === -1 || boxIdx === -1) {
    throw new Error(`Could not find a SKU and a Box column in: ${JSON.stringify(raw[0])}`);
  }

  const text = (v) => {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return { date: v };
    const s = String(v).trim();
    return s === '' ? null : s;
  };

  /**
   * Recover a box number Excel turned into a date.
   *
   * Box numbers in this sheet are overwhelmingly of the form "<n>-<n>" — 5-1,
   * 30-2, 1B-1. Typed into a General-formatted cell, Excel reads "1-3" as a
   * date and stores 3 January of the then-current year. The text is gone from
   * the file; what survives is the month and day, and Excel's parse puts the
   * FIRST number in the month position and the SECOND in the day position.
   * So "1-3" → Jan 3 → "1-3" reads back unambiguously.
   *
   * "13-1" could never be mangled this way (there is no month 13), which is why
   * only the low-numbered boxes are affected.
   */
  const undate = (d) => `${d.getMonth() + 1}-${d.getDate()}`;

  const rows = [];
  const recovered = [];
  const problems = [];
  raw.slice(1).forEach((r, i) => {
    const line = i + 2; // 1-based, header included, matching the spreadsheet
    const sku = text(r?.[skuIdx]);
    const box = text(r?.[boxIdx]);

    if (sku?.date) { problems.push({ line, reason: 'SKU cell is a date' }); return; }
    if (!sku) { if (box) problems.push({ line, reason: 'box number with no SKU' }); return; }
    if (!box) { problems.push({ line, reason: `no box number for ${sku}` }); return; }

    if (box.date) {
      const value = undate(box.date);
      recovered.push({ line, skuCode: sku, boxNo: value, from: box.date.toISOString().slice(0, 10) });
      return;
    }
    rows.push({ line, skuCode: sku, boxNo: box });
  });

  return { rows, recovered, problems, header: raw[0] };
};

const main = async () => {
  console.log(`\nKOKEN BOX NUMBER IMPORT — ${APPLY ? 'APPLY (will write)' : 'DRY RUN (no writes)'}`);
  console.log('='.repeat(66));
  console.log(`File: ${FILE}`);

  const { rows: cleanRows, recovered, problems, header } = readSheet(FILE);
  // --recover opts the date-mangled cells in; they are held back otherwise,
  // because a recovered value is an inference and a wrong box number on a PO
  // sends the warehouse to the wrong shelf.
  const RECOVER = process.argv.includes('--recover');
  const rows = RECOVER ? [...cleanRows, ...recovered] : cleanRows;

  console.log(`Header: ${JSON.stringify(header)}`);
  console.log(`\nSheet: ${cleanRows.length} clean row(s), ${recovered.length} date-mangled, `
    + `${problems.length} unusable.`);

  if (recovered.length) {
    console.log(`\n${RECOVER ? '✓ INCLUDING' : '⚠ HELD BACK'} — Excel turned these into dates before the file was saved.`);
    console.log('   The original text is gone from the file; month-day reads back the typed value:');
    for (const r of recovered.slice(0, 12)) {
      console.log(`     line ${String(r.line).padEnd(5)} ${r.skuCode.padEnd(18)} ${r.from}  ->  "${r.boxNo}"`);
    }
    if (recovered.length > 12) console.log(`     ... and ${recovered.length - 12} more`);
    if (!RECOVER) console.log('   Pass --recover to include them.');
  }

  // Duplicate SKUs. Two rows naming one SKU with DIFFERENT boxes cannot both be
  // right, and applying them in file order would silently let the last one win.
  const bySku = new Map();
  const conflicts = [];
  for (const r of rows) {
    const seen = bySku.get(r.skuCode);
    if (!seen) { bySku.set(r.skuCode, r); continue; }
    if (seen.boxNo !== r.boxNo) conflicts.push({ skuCode: r.skuCode, a: seen, b: r });
  }
  const dupSame = rows.length - bySku.size - conflicts.length;
  if (dupSame) console.log(`Duplicate rows agreeing on the box: ${dupSame} (harmless).`);
  if (conflicts.length) {
    console.log(`\n⚠  ${conflicts.length} SKU(s) appear twice with DIFFERENT box numbers:`);
    for (const c of conflicts.slice(0, 10)) {
      console.log(`     ${c.skuCode}: line ${c.a.line} = "${c.a.boxNo}"  vs  line ${c.b.line} = "${c.b.boxNo}"`);
    }
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`\nConnected: ${mongoose.connection.host} / ${mongoose.connection.name}`);

  const skus = [...bySku.keys()];
  const products = await ProductKoken.find({ skuCode: { $in: skus } }, 'skuCode brand boxNo').lean();
  const onFile = new Map(products.map((p) => [boxRowKey(p.skuCode, p.brand), p.boxNo || null]));
  const known = new Set(products.map((p) => p.skuCode));

  const matched = [...bySku.values()].filter((r) => known.has(r.skuCode));
  const missing = [...bySku.values()].filter((r) => !known.has(r.skuCode));

  // Reuse the same change-detection the import pipeline uses, so this script
  // and the uploaded-sheet path can never disagree about what counts as a change.
  const staged = matched.map((r) => ({
    rowNumber: r.line,
    data: { skuCode: r.skuCode, brand: BRAND, boxNo: r.boxNo },
  }));
  const changes = boxNumberChanges(staged.filter((s) => suppliesBoxNo(s.data)), onFile);

  const firstMap = changes.filter((c) => c.from === null);
  const reBox = changes.filter((c) => c.from !== null);

  console.log('\n' + '-'.repeat(66));
  console.log(`Unique SKUs in sheet        : ${bySku.size}`);
  console.log(`  matched in Koken catalogue: ${matched.length}`);
  console.log(`  NOT in Koken catalogue    : ${missing.length}`);
  console.log(`\nOf the matched:`);
  console.log(`  already correct (no write): ${matched.length - changes.length}`);
  console.log(`  first box number set      : ${firstMap.length}`);
  console.log(`  CHANGED from an existing  : ${reBox.length}`);

  if (reBox.length) {
    console.log(`\n⚠  These already had a DIFFERENT box number and would be overwritten:`);
    for (const c of reBox.slice(0, 25)) {
      console.log(`     ${c.skuCode.padEnd(20)} "${c.from}"  ->  "${c.to}"`);
    }
    if (reBox.length > 25) console.log(`     ... and ${reBox.length - 25} more`);
  }

  if (missing.length) {
    console.log(`\n   Not found in the Koken catalogue (skipped, nothing written):`);
    for (const m of missing.slice(0, 25)) console.log(`     line ${String(m.line).padEnd(5)} ${m.skuCode}`);
    if (missing.length > 25) console.log(`     ... and ${missing.length - 25} more`);
  }

  if (problems.length) {
    console.log(`\n   Rows skipped in the sheet:`);
    for (const p of problems.slice(0, 15)) console.log(`     line ${String(p.line).padEnd(5)} ${p.reason}`);
    if (problems.length > 15) console.log(`     ... and ${problems.length - 15} more`);
  }

  const distinct = [...new Set(changes.map((c) => c.to))];
  console.log(`\nDistinct box numbers to be written: ${distinct.length}`);
  console.log(`  sample: ${distinct.slice(0, 12).map((b) => `"${b}"`).join(', ')}`);
  console.log(`  all stored as TEXT (so "1" stays "1", never the number 1)`);

  if (!APPLY) {
    console.log('\n' + '='.repeat(66));
    console.log(`DRY RUN — nothing was written. ${changes.length} row(s) would change.`);
    console.log('Re-run with --apply to write.');
    await mongoose.disconnect();
    return;
  }

  if (changes.length === 0) {
    console.log('\nNothing to write — every matched SKU already holds its box number.');
    await mongoose.disconnect();
    return;
  }

  const result = await ProductKoken.bulkWrite(
    changes.map((c) => ({
      updateOne: { filter: { skuCode: c.skuCode }, update: { $set: { boxNo: c.to } } },
    })),
    { ordered: false },
  );
  console.log(`\nWritten. matched=${result.matchedCount} modified=${result.modifiedCount}`);

  // Audited under the same action name the app uses, so this bulk change shows
  // up in the trail beside every other box-number change rather than being
  // invisible because it came from a script.
  const AuditLog = (await import('../models/AuditLog.js')).default;
  await AuditLog.create({
    action: 'Box Number Updated',
    method: 'SCRIPT',
    endpoint: 'scripts/import-koken-box-numbers.js',
    ipAddress: '127.0.0.1',
    userAgent: 'ERP MAINTENANCE SCRIPT',
    remarks: `${changes.length} Koken box number(s) imported from "${path.basename(FILE)}" `
      + `(${firstMap.length} first mapping, ${reBox.length} changed). `
      + 'Subsequent POs will quote the new box numbers.',
    meta: { file: path.basename(FILE), brand: BRAND, changes },
  });
  console.log('Audit entry recorded (action: Box Number Updated).');

  // Read back a sample, so the report ends with what is actually stored rather
  // than what was sent.
  const sample = await ProductKoken.find(
    { skuCode: { $in: changes.slice(0, 5).map((c) => c.skuCode) } },
    'skuCode boxNo',
  ).lean();
  console.log('\nVerified from the database:');
  for (const s of sample) console.log(`   ${s.skuCode.padEnd(20)} boxNo = ${JSON.stringify(s.boxNo)}`);

  await mongoose.disconnect();
};

main().catch(async (e) => {
  console.error('\nFAILED:', e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
