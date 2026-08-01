/**
 * seed-opening-stock.js
 * -----------------------------------------------------------------------------
 * One-off go-live step: carry today's legacy stock figures into the ledger as
 * OPENING movements, so Module M3's balance projection has a starting position.
 *
 * WHY totalAvailableQuantity AND NOT openingStockQuantity
 * The ledger starts empty today, so the opening position must equal stock as it
 * stands NOW. `openingStockQuantity` is the figure from the original spreadsheet
 * opening date; using it would silently discard every receipt and issue since.
 * `totalAvailableQuantity` is the legacy live balance — the number the old
 * system would show if you asked it right now — which is exactly what the
 * ledger's opening position has to reproduce.
 *
 * GOES THROUGH MODULE M9, NOT STRAIGHT AT THE LEDGER. The rows are written to a
 * real workbook and pushed through the ordinary import pipeline: template
 * validation, row validation, preview, confirm, chunked posting via
 * LedgerService, health re-projection. That yields an ImportJob record, a full
 * audit trail and per-chunk idempotency — and it exercises the same path a user
 * would take, rather than a private back door that nothing else uses.
 *
 * IRREVERSIBLE. Ledger movements are immutable by design; a mistake here is
 * corrected with counter-movements, never with a delete.
 *
 * Usage:
 *   node scripts/seed-opening-stock.js            # validate only, writes nothing
 *   node scripts/seed-opening-stock.js --apply    # validate, then post
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import fs from 'fs';
import ExcelJS from 'exceljs';
import { fileURLToPath } from 'url';

import { Product } from '../models/Product.js';
import Location from '../models/Location.js';
import User from '../models/User.js';
import ImportJob from '../models/ImportJob.js';
import StockBalance from '../models/StockBalance.js';
import { createImportJob, confirmJob, errorReport } from '../modules/inventory/import.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const APPLY = process.argv.includes('--apply');

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`🔌  Connected to MongoDB (${mongoose.connection.name})`);
  console.log(`⚙️   Mode : ${APPLY ? 'APPLY — posts to the ledger' : 'VALIDATE ONLY — writes nothing'}\n`);

  const actor = await User.findOne({ role: 'Admin', status: 'Active' }).lean();
  if (!actor) throw new Error('No active Admin user to attribute the import to.');

  const location = await Location.findOne({ isDefault: true }).lean()
    ?? await Location.findOne({ active: true }).lean();
  if (!location) throw new Error('No location to post against.');

  // ── Collect the rows ──────────────────────────────────────────────────────
  // Positive only. OPENING carries a 'positive' sign by definition; a negative
  // opening position is a different statement about the world and is reported
  // below for separate handling rather than being quietly coerced or dropped.
  const rows = await Product.find(
    { totalAvailableQuantity: { $gt: 0 } },
    'skuCode brand totalAvailableQuantity openingStockDate',
  ).sort({ brand: 1, skuCode: 1 }).lean();

  const negatives = await Product.find(
    { totalAvailableQuantity: { $lt: 0 } },
    'skuCode brand totalAvailableQuantity',
  ).lean();

  const units = rows.reduce((sum, r) => sum + r.totalAvailableQuantity, 0);
  const byBrand = rows.reduce((acc, r) => {
    acc[r.brand] = (acc[r.brand] || 0) + 1;
    return acc;
  }, {});

  console.log('📋  Opening position to be established');
  console.log(`      location        : ${location.code}`);
  console.log(`      SKUs            : ${rows.length.toLocaleString()}  (${Object.entries(byBrand).map(([b, n]) => `${b} ${n}`).join(', ')})`);
  console.log(`      total units     : ${units.toLocaleString()}`);
  console.log(`      negative rows   : ${negatives.length}  (excluded — see below)`);
  if (negatives.length) {
    for (const n of negatives.slice(0, 10)) {
      console.log(`         ${n.brand} ${n.skuCode}: ${n.totalAvailableQuantity}`);
    }
  }

  if (rows.length === 0) {
    console.log('\n   Nothing to post.\n');
    await mongoose.disconnect();
    return;
  }

  // ── Build the workbook the importer will read ─────────────────────────────
  const dir = path.join(os.tmpdir(), 'ims-opening-stock');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'opening-stock.xlsx');

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Opening Stock');
  ws.addRow(['SKU Code', 'Brand', 'Location Code', 'Quantity', 'Unit Cost', 'Note']);
  for (const r of rows) {
    ws.addRow([
      r.skuCode, r.brand, location.code, r.totalAvailableQuantity, null,
      'Go-live opening position carried from the legacy stock figure.',
    ]);
  }
  await wb.xlsx.writeFile(file);
  console.log(`\n📄  Workbook written: ${rows.length.toLocaleString()} data rows`);

  // ── Stage and validate (no inventory is written by this step) ─────────────
  const job = await createImportJob({
    filePath: file,
    fileName: 'opening-stock.xlsx',
    fileType: 'xlsx',
    fileSize: fs.statSync(file).size,
    importType: 'opening-stock',
    actor,
    req: null,
    force: true,
  });

  console.log('\n🔍  Validation');
  console.log(`      job             : ${job.jobId}`);
  console.log(`      status          : ${job.status}`);
  console.log(`      rows read       : ${job.totalRows.toLocaleString()}`);
  console.log(`      valid           : ${job.validRows.toLocaleString()}`);
  console.log(`      rejected        : ${job.invalidRows.toLocaleString()}`);
  if (job.fileErrors?.length) console.log(`      file errors     : ${job.fileErrors.join(' ')}`);

  if (job.invalidRows > 0) {
    const report = await errorReport(job.jobId, { limit: 10 });
    console.log('\n      first rejections:');
    for (const e of report.errors) console.log(`         row ${e.rowNumber} [${e.category}] ${e.message}`);
  }

  if (!APPLY) {
    console.log('\n🚫  Validate-only — nothing posted. Re-run with --apply to commit.');
    console.log(`    The staged job ${job.jobId} is left in ${job.status} and can be confirmed or cancelled.\n`);
    await mongoose.disconnect();
    return;
  }

  if (job.status !== 'Validated' || job.validRows === 0) {
    console.log('\n❌  Not in a postable state — nothing was written.\n');
    await mongoose.disconnect();
    return;
  }

  // ── Post ──────────────────────────────────────────────────────────────────
  console.log('\n⏳  Posting through LedgerService...');
  const started = Date.now();

  // `confirmJob` starts the processor DETACHED and returns immediately, because
  // a large import runs for minutes and an HTTP request cannot be held open for
  // it. So this waits for the job to leave Processing rather than calling
  // `runJob` itself: a second call is refused by the job lock — correctly, that
  // lock is what stops two processors posting the same chunk — and returns
  // instantly, after which the script would disconnect Mongo out from under the
  // run that is actually doing the work.
  await confirmJob({ jobId: job.jobId, actor, req: null });

  for (;;) {
    const cur = await ImportJob.findOne({ jobId: job.jobId }, 'status processedRows validRows').lean();
    if (!cur || cur.status !== 'Processing') break;
    process.stdout.write(`\r      progress        : ${cur.processedRows.toLocaleString()} / ${cur.validRows.toLocaleString()}   `);
    await new Promise((r) => { setTimeout(r, 500); });
  }
  process.stdout.write('\r');

  const done = await ImportJob.findOne({ jobId: job.jobId }).lean();
  console.log(`      status          : ${done.status}`);
  console.log(`      posted          : ${done.successfulRows.toLocaleString()}`);
  console.log(`      failed          : ${done.failedRows.toLocaleString()}`);
  console.log(`      took            : ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const [bal] = await StockBalance.aggregate([
    { $group: { _id: null, rows: { $sum: 1 }, onHand: { $sum: '$onHand' } } },
  ]);
  console.log('\n📊  Balance projection now holds');
  console.log(`      balance rows    : ${(bal?.rows ?? 0).toLocaleString()}`);
  console.log(`      total on hand   : ${(bal?.onHand ?? 0).toLocaleString()}  (expected ${units.toLocaleString()})`);
  console.log(bal?.onHand === units ? '      ✅ matches the source figure' : '      ⚠️  DOES NOT match — investigate before rebuilding health');

  fs.rmSync(dir, { recursive: true, force: true });
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('\n❌  Failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
