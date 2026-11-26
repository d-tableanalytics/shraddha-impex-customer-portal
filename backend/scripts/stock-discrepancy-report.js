#!/usr/bin/env node
/**
 * Excel deliverables for the stock reconciliation — REPORT ONLY.
 *
 * Produces two workbooks:
 *
 *   1. stock-ambiguous-skus.xlsx
 *      The SKUs where the recorded physical figure and the ledger disagree and
 *      nothing in the data settles which is right. One row per SKU with a BLANK
 *      "Verified Physical Stock" column for the client to count and fill in.
 *      That count is the only thing that can resolve these; no amount of
 *      further analysis will.
 *
 *   2. stock-proposed-corrections.xlsx
 *      The phantom-stock and negative-field SKUs, with the current figures, the
 *      proposed ones, and why. PROPOSED — nothing is applied.
 *
 * Reads the JSON produced by scripts/reconcile-stock.js so the two deliverables
 * cannot disagree, and enriches it with product names.
 *
 * IT CANNOT WRITE TO THE DATABASE. Same seal as reconcile-stock.js: every
 * mutating method on the driver's Collection prototype throws before a
 * connection is opened.
 *
 * USAGE
 *   node scripts/reconcile-stock.js --json reconcile.json
 *   node scripts/stock-discrepancy-report.js --input reconcile.json --out-dir ./reports
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { MongoClient, Collection } from 'mongodb';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Classifications a correction is never proposed for. */
const CORRECTION_EXCLUDED = new Set(['malformed', 'genuinely-oversold', 'clean', 'ledger-incomplete']);

const WRITE_METHODS = [
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne',
  'deleteOne', 'deleteMany', 'bulkWrite', 'findOneAndUpdate', 'findOneAndDelete',
  'findOneAndReplace', 'drop', 'rename', 'createIndex', 'createIndexes',
  'dropIndex', 'dropIndexes', 'initializeOrderedBulkOp', 'initializeUnorderedBulkOp',
];
for (const m of WRITE_METHODS) {
  Collection.prototype[m] = function sealed() {
    throw new Error(`stock-discrepancy-report.js is read-only: refused Collection.${m}().`);
  };
}

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : null;
};
const INPUT = flag('input');
const OUT_DIR = flag('out-dir') || path.join(HERE, '..', '..', '..', 'reports');
if (!INPUT) throw new Error('--input <reconcile.json> is required (run reconcile-stock.js --json first).');

const uri = fs.readFileSync(path.join(HERE, '..', '.env'), 'utf8').match(/MONGODB_URI\s*=\s*(\S+)/)[1];

/** Header styling applied identically to both sheets. */
const styleHeader = (sheet) => {
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
  row.alignment = { vertical: 'middle', wrapText: true };
  row.height = 32;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
};

/** The one column the client fills in — visually obvious, and unlocked. */
const markInputColumn = (sheet, colLetter, lastRow) => {
  for (let r = 2; r <= lastRow; r += 1) {
    const cell = sheet.getCell(`${colLetter}${r}`);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFBF8F00' } },
      left: { style: 'thin', color: { argb: 'FFBF8F00' } },
      bottom: { style: 'thin', color: { argb: 'FFBF8F00' } },
      right: { style: 'thin', color: { argb: 'FFBF8F00' } },
    };
  }
};

const main = async () => {
  const report = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  const results = report.results;

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();

  const skus = results.map((r) => r.sku).filter(Boolean);
  const names = new Map(
    (await db.collection('products')
      .find({ skuCode: { $in: skus } }, { projection: { skuCode: 1, description: 1, msilCode: 1, boxNo: 1 } })
      .toArray())
      .map((p) => [p.skuCode, { name: p.description || '', msil: p.msilCode || '', box: p.boxNo || '' }]),
  );

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);

  // ── 1. Ambiguous SKUs ─────────────────────────────────────────────────────
  const ambiguous = results
    .filter((r) => r.classification === 'physical-ambiguous')
    .sort((a, b) => Math.abs(b.ledger.onHand - b.before.total) - Math.abs(a.ledger.onHand - a.before.total));

  const wb1 = new ExcelJS.Workbook();
  wb1.creator = 'Shraddha Impex ERP — stock reconciliation';
  wb1.created = new Date();
  const s1 = wb1.addWorksheet('Physical Verification');

  s1.columns = [
    { header: 'SKU Code', key: 'sku', width: 20 },
    { header: 'Brand', key: 'brand', width: 10 },
    { header: 'Product Name', key: 'name', width: 42 },
    { header: 'MSIL Code', key: 'msil', width: 15 },
    { header: 'Box No', key: 'box', width: 10 },
    { header: 'Recorded Physical Stock\n(portal)', key: 'recorded', width: 15 },
    { header: 'Ledger Stock\n(movement history)', key: 'ledger', width: 15 },
    { header: 'Active Reserved Qty\n(live bookings)', key: 'reserved', width: 15 },
    { header: 'Available Stock\n(portal)', key: 'available', width: 13 },
    { header: 'Discrepancy\n(ledger − recorded)', key: 'discrepancy', width: 15 },
    { header: 'VERIFIED PHYSICAL STOCK\n(please count and enter)', key: 'verified', width: 24 },
    { header: 'Counted By', key: 'countedBy', width: 16 },
    { header: 'Date Counted', key: 'countedOn', width: 14 },
    { header: 'Remarks', key: 'remarks', width: 30 },
  ];

  for (const r of ambiguous) {
    const meta = names.get(r.sku) || { name: '', msil: '', box: '' };
    s1.addRow({
      sku: r.sku,
      brand: r.brand,
      name: meta.name,
      msil: meta.msil,
      box: meta.box,
      recorded: r.before.total,
      ledger: r.ledger.onHand,
      reserved: r.register.committed,
      available: r.before.afs,
      discrepancy: r.ledger.onHand - r.before.total,
      verified: null,
      countedBy: null,
      countedOn: null,
      remarks: null,
    });
  }
  styleHeader(s1);
  markInputColumn(s1, 'K', s1.rowCount);
  s1.autoFilter = { from: 'A1', to: { row: 1, column: s1.columns.length } };
  s1.getColumn('discrepancy').numFmt = '+0;-0;0';

  const notes1 = wb1.addWorksheet('How to use');
  notes1.getColumn(1).width = 110;
  [
    'PHYSICAL STOCK VERIFICATION',
    '',
    `Generated ${stamp} from the Shraddha Impex ERP.`,
    '',
    'WHY THESE SKUs ARE LISTED',
    'For each SKU below the portal and the stock-movement ledger report a different physical quantity,',
    'and nothing in the system establishes which is correct. A physical count is the only way to settle it.',
    '',
    'WHAT TO DO',
    '1. Count the physical stock of each SKU on the shelf.',
    '2. Enter the figure in the shaded column "VERIFIED PHYSICAL STOCK".',
    '3. Fill in who counted it and when. Add anything unusual under Remarks.',
    '4. Return the file. Nothing is changed in the system until the counts are reviewed and approved.',
    '',
    'IMPORTANT',
    '"Active Reserved Qty" is stock already promised to customers on live bookings. It is NOT available',
    'to sell. If your verified count is lower than that figure, say so in Remarks — it means stock has',
    'been promised that is not on the shelf, and the sales desk must be told before anything is changed.',
    '',
    'No booking, order, PO or indent has been or will be altered by this exercise.',
  ].forEach((line) => notes1.addRow([line]));
  notes1.getRow(1).font = { bold: true, size: 14 };

  const file1 = path.join(OUT_DIR, `stock-ambiguous-skus-${stamp}.xlsx`);
  await wb1.xlsx.writeFile(file1);

  // ── 2. Proposed corrections ───────────────────────────────────────────────
  // The SAME set the reconciliation would apply, not a separate list scoped to
  // two classifications. Two definitions of "what gets corrected" is how the
  // workbook and the tool come to disagree.
  const corrections = results
    .filter((r) => r.proposed && !CORRECTION_EXCLUDED.has(r.classification)
      && (r.deltas.total !== 0 || r.deltas.booked !== 0 || r.deltas.afs !== 0))
    .sort((a, b) => a.classification.localeCompare(b.classification) || String(a.sku).localeCompare(String(b.sku)));

  const wb2 = new ExcelJS.Workbook();
  wb2.creator = 'Shraddha Impex ERP — stock reconciliation';
  wb2.created = new Date();
  const s2 = wb2.addWorksheet('Proposed Corrections');

  s2.columns = [
    { header: 'SKU Code', key: 'sku', width: 20 },
    { header: 'Brand', key: 'brand', width: 10 },
    { header: 'Product Name', key: 'name', width: 42 },
    { header: 'Issue', key: 'issue', width: 18 },
    { header: 'Current Total', key: 'ct', width: 12 },
    { header: 'Current Booked', key: 'cb', width: 13 },
    { header: 'Current Available', key: 'ca', width: 14 },
    { header: 'Ledger onHand', key: 'lo', width: 13 },
    { header: 'Ledger Reserved', key: 'lr', width: 13 },
    { header: 'Live Commitments\n(orders)', key: 'committed', width: 15 },
    { header: 'Proposed Total', key: 'pt', width: 12 },
    { header: 'Proposed Booked', key: 'pb', width: 13 },
    { header: 'Proposed Available', key: 'pa', width: 14 },
    { header: 'Change to Available', key: 'delta', width: 15 },
    { header: 'Why', key: 'why', width: 58 },
    { header: 'Approved? (Y/N)', key: 'approved', width: 15 },
  ];

  for (const r of corrections) {
    const meta = names.get(r.sku) || { name: '' };
    const why = r.classification === 'phantom-stock'
      ? `availableForSale (${r.before.afs}) exceeds physical stock (${r.before.total}). `
        + `${r.before.afs - r.before.total} unit(s) are offered to customers but do not exist.`
      : `bookedQuantity is ${r.before.booked}. A negative reservation count is read as free stock, `
        + `inflating availability by ${Math.abs(r.before.booked)} unit(s).`;
    s2.addRow({
      sku: r.sku,
      brand: r.brand,
      name: meta.name,
      issue: r.classification === 'phantom-stock' ? 'Phantom stock' : 'Negative booked',
      ct: r.before.total,
      cb: r.before.booked,
      ca: r.before.afs,
      lo: r.ledger.onHand,
      lr: r.ledger.reserved,
      committed: r.register.committed,
      pt: r.proposed ? r.proposed.total : 'needs count',
      pb: r.proposed ? r.proposed.booked : 'needs count',
      pa: r.proposed ? r.proposed.afs : 'needs count',
      delta: r.proposed ? r.proposed.afs - r.before.afs : '',
      why,
      approved: null,
    });
  }
  styleHeader(s2);
  markInputColumn(s2, 'P', s2.rowCount);
  s2.autoFilter = { from: 'A1', to: { row: 1, column: s2.columns.length } };
  s2.getColumn('delta').numFmt = '+0;-0;0';

  const notes2 = wb2.addWorksheet('How to use');
  notes2.getColumn(1).width = 110;
  [
    'PROPOSED STOCK CORRECTIONS — FOR APPROVAL',
    '',
    `Generated ${stamp} from the Shraddha Impex ERP.`,
    '',
    'NOTHING HERE HAS BEEN APPLIED. This is a proposal.',
    '',
    'WHAT THESE ARE',
    'Each SKU below currently offers customers more stock than physically exists, either because',
    '"available" was credited with units nothing was holding, or because the reserved counter went',
    'negative and a negative reservation reads as free stock.',
    '',
    'WHAT APPROVING MEANS',
    'Approving reduces the quantity customers can see and book. That is the point: the extra units are',
    'not there, and leaving them visible means a booking that cannot be dispatched.',
    '',
    'ROWS MARKED "needs count"',
    'The portal and the ledger disagree on the physical figure for these, so no correction can be',
    'proposed until a physical count is done. They also appear in the physical verification workbook.',
    '',
    'NO customer booking, order, PO, indent or audit record is changed by any correction proposed here.',
    'Live commitments are preserved in full. Where commitments exceed stock the SKU is reported as',
    'oversold for the sales desk to resolve — never resolved by reducing a customer booking.',
  ].forEach((line) => notes2.addRow([line]));
  notes2.getRow(1).font = { bold: true, size: 14 };

  const file2 = path.join(OUT_DIR, `stock-proposed-corrections-${stamp}.xlsx`);
  await wb2.xlsx.writeFile(file2);

  console.log('Excel reports written (read-only run, nothing was modified):');
  console.log(`  ${file1}`);
  console.log(`     ${ambiguous.length} SKU(s) needing a physical count`);
  console.log(`  ${file2}`);
  console.log(`     ${corrections.length} SKU(s) with a proposed correction`);

  await client.close();
};

main().catch((e) => { console.error(e); process.exit(1); });
