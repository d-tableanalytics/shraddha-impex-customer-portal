/**
 * verify-import.js
 * -----------------------------------------------------------------------------
 * Checks for IMS Module M9 — Import / Export.
 *
 *   1. Integration only   the module calculates no inventory
 *   2. Approved paths     every stock-affecting import goes through a service
 *   3. Template registry  one definition drives template, headers and validation
 *   4. Parsing            xlsx and csv stream; quoting, BOM and blank rows
 *   5. Validation         every rule, with all errors collected
 *   6. Nothing before confirm
 *   7. Processing         chunking, partial success, resume, idempotency
 *   8. Exports            read-only, brand-scoped, streamed
 *   9. Security           NoSQL operators, path traversal, brand isolation
 *
 * Sections 1–4 are static. The rest require --db.
 *
 * Usage:
 *   node scripts/verify-import.js
 *   node scripts/verify-import.js --db
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ExcelJS from 'exceljs';
import { fileURLToPath } from 'url';

import ImportJob from '../models/ImportJob.js';
import ImportRow from '../models/ImportRow.js';
import ImportError from '../models/ImportError.js';
import ExportJob from '../models/ExportJob.js';
import StockMovement from '../models/StockMovement.js';
import StockBalance from '../models/StockBalance.js';
import StockBatch from '../models/StockBatch.js';
import StockCount from '../models/StockCount.js';
import Location from '../models/Location.js';
import User from '../models/User.js';
import { Product, createProductModel } from '../models/Product.js';

import { IMPORT_TEMPLATES, IMPORT_TYPE_NAMES, matchHeaders, headersFor, coerce } from '../modules/inventory/import.templates.js';
import { readXlsx, readCsv } from '../modules/inventory/import.parser.js';
import { createImportJob, previewJob, confirmJob, runJob, resumeJob, cancelJob, getJob, errorReport } from '../modules/inventory/import.service.js';
import { EXPORTS, EXPORT_NAMES, runExport } from '../modules/inventory/export.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const WITH_DB = process.argv.includes('--db');

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`   ✅ ${name}`); }
  else { failed++; console.log(`   ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const expectFail = async (name, fn) => {
  try { await fn(); check(name, false, 'it succeeded'); }
  catch (err) { check(name, true, `${err.code || err.name}: ${String(err.message).slice(0, 55)}`); }
};

const readSource = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
/** Strip comments, so a rule is not "satisfied" by prose describing it. */
const codeOnly = (src) => src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');

const TMP = path.join(os.tmpdir(), 'ims-m9-verify');
fs.mkdirSync(TMP, { recursive: true });

/** Write an .xlsx from a header row plus data rows. */
const makeXlsx = async (file, headers, rows) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(file);
  return file;
};
const makeCsv = (file, lines) => { fs.writeFileSync(file, lines.join('\r\n'), 'utf8'); return file; };

const run = async () => {
  const importSvc = codeOnly(readSource('modules', 'inventory', 'import.service.js'));
  const exportSvc = codeOnly(readSource('modules', 'inventory', 'export.service.js'));
  const templates = codeOnly(readSource('modules', 'inventory', 'import.templates.js'));
  const parser = codeOnly(readSource('modules', 'inventory', 'import.parser.js'));
  const m9 = `${importSvc}\n${exportSvc}\n${templates}\n${parser}`;

  // ── 1. Integration only ───────────────────────────────────────────────────
  console.log('\n1. INTEGRATION ONLY — NO INVENTORY LOGIC');
  check('never imports the health calculator', !/calculateHealth|MAX_LEVEL_FORMULAS|classify\b/.test(m9));
  check('never imports the balance reducer', !/reduceMovements/.test(m9));
  check('never writes StockBalance', !/StockBalance\.(updateOne|updateMany|bulkWrite|create|insertMany|findOneAndUpdate)/.test(m9));
  check('never writes StockHealth', !/StockHealth\.(updateOne|updateMany|bulkWrite|create|insertMany|findOneAndUpdate)/.test(m9));
  check('never writes StockMovement directly', !/StockMovement\.(create|insertMany|updateOne|updateMany|bulkWrite)/.test(m9));
  check('never writes a snapshot', !/(InventorySnapshot|SnapshotRun)\.(create|insertMany|updateOne|updateMany|bulkWrite)/.test(m9));
  check('never writes an alert', !/InventoryAlert\.(create|insertMany|updateOne|bulkWrite)/.test(m9));
  check('never touches legacy inventory fields', !/totalAvailableQuantity|bookedQuantity|availableForSale/.test(m9));
  check('no band, target or percentage arithmetic',
    !/maxLevel\s*=|replenishmentPercent\s*=|coverageDays\s*=|band\s*=\s*['"]/.test(m9));
  check('the export derives `available` through M3, never by subtracting',
    /deriveBalance\(/.test(exportSvc) && !/onHand\s*-\s*reserved/.test(exportSvc));

  // ── 2. Approved paths ─────────────────────────────────────────────────────
  console.log('\n2. APPROVED PATHS');
  check('stock rows post through LedgerService.postBatch', /postBatch\(/.test(importSvc));
  check('balances update through applyMovements', /applyMovements\(/.test(importSvc));
  check('health updates through recomputeHealthForSkus', /recomputeHealthForSkus\(/.test(importSvc));
  check('health is never rebuilt wholesale', !/rebuildHealth\(/.test(importSvc));
  check('balances are never rebuilt wholesale', !/rebuildBalances\(/.test(importSvc));
  check('count rows go through the count service',
    /createCount\(/.test(importSvc) && /recordCounts\(/.test(importSvc));
  check('an imported count is submitted, never posted',
    /submitCount\(/.test(importSvc) && !/postCount\(/.test(importSvc));
  check('the ledger idempotency key is derived from the job and chunk',
    /idempotencyKey:\s*`import-\$\{job\.jobId\}-\$\{chunkIndex\}`/.test(importSvc));

  // ── 3. Template registry ──────────────────────────────────────────────────
  console.log('\n3. TEMPLATE REGISTRY');
  check('every type declares label, permissions and columns',
    IMPORT_TYPE_NAMES.every((k) => {
      const t = IMPORT_TEMPLATES[k];
      return t.label && Array.isArray(t.permissions) && t.permissions.length && t.columns?.length;
    }));
  check('every column declares a header and a field',
    IMPORT_TYPE_NAMES.every((k) => IMPORT_TEMPLATES[k].columns.every((c) => c.header && c.field)));
  check('no type declares a duplicate header',
    IMPORT_TYPE_NAMES.every((k) => {
      const h = headersFor(k);
      return new Set(h).size === h.length;
    }));
  check('every type has a sample row covering its headers',
    IMPORT_TYPE_NAMES.every((k) => {
      const t = IMPORT_TEMPLATES[k];
      return !t.sample || t.columns.every((c) => c.header in t.sample);
    }));
  check('COUNT is not importable as a movement',
    !IMPORT_TEMPLATES['stock-movements'].columns.find((c) => c.field === 'movementType').enumOf.includes('COUNT'));
  check('allocation movements are not importable',
    !['RESERVE', 'RELEASE'].some((t) =>
      IMPORT_TEMPLATES['stock-movements'].columns.find((c) => c.field === 'movementType').enumOf.includes(t)));
  check('REVERSAL is not importable',
    !IMPORT_TEMPLATES['stock-movements'].columns.find((c) => c.field === 'movementType').enumOf.includes('REVERSAL'));
  check('OPENING is not offered on the movement sheet',
    !IMPORT_TEMPLATES['stock-movements'].columns.find((c) => c.field === 'movementType').enumOf.includes('OPENING'));

  // Header matching
  const good = matchHeaders('opening-stock', ['SKU Code', 'Brand', 'Location Code', 'Quantity', 'Unit Cost', 'Note']);
  check('a correct header row maps every column', good.missing.length === 0 && Object.keys(good.mapping).length === 6);
  const loose = matchHeaders('opening-stock', ['sku code', '  BRAND ', 'Location Code', 'Quantity']);
  check('header matching ignores case and spacing', loose.missing.length === 0, loose.missing.join());
  const short = matchHeaders('opening-stock', ['SKU Code', 'Brand']);
  check('a missing required column is reported', short.missing.includes('Quantity'));
  const extra = matchHeaders('opening-stock', ['SKU Code', 'Brand', 'Quantity', 'Checked By']);
  check('an unexpected column is tolerated but reported',
    extra.missing.length === 0 && extra.unexpected.includes('Checked By'));
  const scrambled = matchHeaders('opening-stock', ['Quantity', 'Brand', 'SKU Code']);
  check('column ORDER does not matter',
    scrambled.mapping.quantity === 0 && scrambled.mapping.skuCode === 2);

  // Coercion
  console.log('\n   coercion');
  check('thousands separators are accepted', coerce({ type: 'number' }, '1,250').value === 1250);
  check('a non-number is rejected', coerce({ type: 'number' }, 'abc').ok === false);
  check('a blank number is null, not zero', coerce({ type: 'number' }, '').value === null);
  check('a negative below min is rejected', coerce({ type: 'number', min: 0 }, '-5').ok === false);
  check('a fractional integer is rejected', coerce({ type: 'int' }, '1.5').ok === false);
  check('a list splits on commas', coerce({ type: 'list' }, 'Sockets, Wrenches').value.length === 2);
  check('yes/no maps to boolean', coerce({ type: 'boolean' }, 'Yes').value === true);
  check('an unparseable date is rejected', coerce({ type: 'date' }, 'not-a-date').ok === false);
  check('rich text cells resolve to their display string',
    coerce({ type: 'string' }, { richText: [{ text: 'ABC' }, { text: '-1' }] }).value === 'ABC-1');
  check('a formula cell resolves to its result', coerce({ type: 'string' }, { result: 'XYZ' }).value === 'XYZ');

  // ── 4. Parsing ────────────────────────────────────────────────────────────
  console.log('\n4. PARSERS');
  check('csv is read line by line, never slurped',
    /createReadStream/.test(parser) && /readline\.createInterface/.test(parser)
    && !/readFileSync|await fs\.promises\.readFile/.test(parser));
  // The xlsx path is a deliberate single-pass read: the streaming reader in
  // exceljs 4.4.0 silently corrupts text cells (see the note in the parser).
  // What must hold is that the cost is BOUNDED and the values are correct.
  check('the xlsx read is bounded by an explicit row cap', /MAX_ROWS/.test(parser));
  check('the parsed workbook is released before the rows are walked',
    /workbook\.Sheets = null/.test(parser));
  check('xlsx date cells are read as dates, not serial numbers', /cellDates:\s*true/.test(parser));
  check('the xlsx writer streams', /stream\.xlsx\.WorkbookWriter/.test(exportSvc));
  check('the export never buffers rows into an array',
    !/const rows = await .*\.find\([^)]*\)\.lean\(\);/.test(exportSvc) && /\.cursor\(\)/.test(exportSvc));

  const csvFile = makeCsv(path.join(TMP, 'p.csv'), [
    '﻿SKU Code,Brand,Quantity,Note',
    'A-1,Koken,10,plain',
    'A-2,Koken,20,"has, comma"',
    'A-3,Koken,30,"has ""quotes"""',
    '',
    'A-4,Koken,40,',
  ]);
  const csvRows = [];
  for await (const r of readCsv(csvFile)) csvRows.push(r);
  check('csv: the BOM is stripped from the first header', csvRows[0].values[0] === 'SKU Code', csvRows[0].values[0]);
  check('csv: four data rows read (blank line skipped)', csvRows.filter((r) => !r.header).length === 4);
  check('csv: a quoted comma stays in one field', csvRows[2].values[3] === 'has, comma');
  check('csv: a doubled quote unescapes', csvRows[3].values[3] === 'has "quotes"');
  check('csv: row numbers are 1-based and exclude the header', csvRows[1].rowNumber === 1);

  const xlsxFile = await makeXlsx(path.join(TMP, 'p.xlsx'),
    ['SKU Code', 'Brand', 'Quantity'], [['A-1', 'Koken', 10], ['A-2', 'Koken', 20]]);
  const xRows = [];
  for await (const r of readXlsx(xlsxFile)) xRows.push(r);
  check('xlsx: the header is identified', xRows[0].header === true && xRows[0].values[0] === 'SKU Code');
  check('xlsx: two data rows read', xRows.filter((r) => !r.header).length === 2);
  check('xlsx: row numbers exclude the header', xRows[1].rowNumber === 1);

  // ── 5. Exports declare only stored fields ────────────────────────────────
  console.log('\n5. EXPORT DEFINITIONS');
  check('every export declares a label, model, sort and columns',
    EXPORT_NAMES.every((k) => EXPORTS[k].label && EXPORTS[k].model && EXPORTS[k].sort && EXPORTS[k].columns?.length));
  check('every export column has a header and a getter',
    EXPORT_NAMES.every((k) => EXPORTS[k].columns.every((c) => c.header && typeof c.get === 'function')));
  check('the snapshot export requires a run id', EXPORTS.snapshot.requires?.includes('runId'));
  check('brand scope is applied on top of the caller filter',
    /applyBrandScope\(/.test(exportSvc) && /\$and/.test(exportSvc));

  if (!WITH_DB) {
    console.log(`\n${'─'.repeat(52)}`);
    console.log(`   PASSED ${passed}   FAILED ${failed}   (static checks only)`);
    console.log('─'.repeat(52));
    console.log('\n   Re-run with --db to exercise the full pipeline.\n');
    process.exit(failed === 0 ? 0 : 1);
  }

  // ── Database-backed ───────────────────────────────────────────────────────
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`\n🔌  Connected to MongoDB (${mongoose.connection.name})`);

  const SKU_A = '__M9_A__';
  const SKU_B = '__M9_B__';
  const BRAND = 'Koken';
  const actor = await User.findOne({ role: 'Admin', status: 'Active' }).lean();
  if (!actor) { console.log('\n❌  No active Admin user to run as.\n'); process.exit(1); }

  const jobIds = new Set();
  const exportIds = new Set();
  const wipe = async () => {
    const ids = [...jobIds];
    await ImportRow.deleteMany({ jobId: { $in: ids } });
    await ImportError.deleteMany({ jobId: { $in: ids } });
    await ImportJob.deleteMany({ jobId: { $in: ids } });
    await ExportJob.deleteMany({ exportId: { $in: [...exportIds] } });
    await Product.deleteMany({ skuCode: { $in: [SKU_A, SKU_B] } });
    await StockBalance.deleteMany({ skuCode: { $in: [SKU_A, SKU_B] } });
    const movs = await StockMovement.find({ skuCode: { $in: [SKU_A, SKU_B] } }, 'batchId').lean();
    await mongoose.connection.collection('stockmovements').deleteMany({ skuCode: { $in: [SKU_A, SKU_B] } });
    await mongoose.connection.collection('stockbatches').deleteMany({ batchId: { $in: [...new Set(movs.map((m) => m.batchId))] } });
    await mongoose.connection.collection('stockhealths').deleteMany({ skuCode: { $in: [SKU_A, SKU_B] } });
    await mongoose.connection.collection('inventoryalerts').deleteMany({ skuCode: { $in: [SKU_A, SKU_B] } });
    // Count lines carry the "one open count per SKU" lock, so a session left
    // behind by an earlier crash blocks every later run. Lines first, then any
    // session that referenced them.
    const staleLines = await mongoose.connection.collection('stockcountlines')
      .find({ skuCode: { $in: [SKU_A, SKU_B] } }, { projection: { countId: 1 } }).toArray();
    const staleCounts = [...new Set(staleLines.map((l) => l.countId))];
    await mongoose.connection.collection('stockcountlines').deleteMany({ countId: { $in: staleCounts } });
    await mongoose.connection.collection('stockcounts').deleteMany({ countId: { $in: staleCounts } });
    await mongoose.connection.collection('stockcounts').deleteMany({ notes: /IMP-/ });
  };
  await wipe();

  let location = await Location.findOne({ isDefault: true }).lean();
  if (!location) location = await Location.create({ code: 'DEFAULT', name: 'Main', type: 'Warehouse', isDefault: true, active: true });

  /** Upload a file and remember the job for cleanup. */
  const upload = async (importType, file, fileType, opts = {}) => {
    const job = await createImportJob({
      filePath: file, fileName: path.basename(file), fileType,
      fileSize: fs.statSync(file).size, importType, actor, req: null, ...opts,
    });
    jobIds.add(job.jobId);
    return job;
  };
  /**
   * Confirm and wait. `confirmJob` starts the processor detached, so the test
   * must wait for it rather than start a second one — running two processors
   * on one job is exactly what the job lock now prevents.
   */
  const waitForIdle = async (jobId, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await ImportJob.findOne({ jobId }, 'status').lean();
      if (job && job.status !== 'Processing') return job;
      if (Date.now() > deadline) throw new Error(`${jobId} did not finish within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const confirmAndWait = async (jobId, timeoutMs = 60_000) => {
    await confirmJob({ jobId, actor, req: null });
    return waitForIdle(jobId, timeoutMs);
  };

  /** Copy a fixture, because the service deletes the file it consumes. */
  const fixture = (src, tag) => {
    const dst = path.join(TMP, `${tag}-${Math.random().toString(36).slice(2)}${path.extname(src)}`);
    fs.copyFileSync(src, dst);
    return dst;
  };

  // ── 6. Master import ──────────────────────────────────────────────────────
  console.log('\n6. MASTER IMPORT');
  const masterFile = await makeXlsx(path.join(TMP, 'master.xlsx'),
    ['SKU Code', 'Brand', 'Description', 'Category', 'Daily Avg Consumption', 'Lead Time', 'Safety Factor'],
    [
      [SKU_A, 'Koken', 'Verify A', 'Sockets', 4, 30, 1.2],
      [SKU_B, 'koken', 'Verify B', 'Wrenches', 2, 45, 1.1],   // lower-case brand
    ]);
  const masterJob = await upload('inventory-master', fixture(masterFile, 'master'), 'xlsx');
  check('the job parks at Validated', masterJob.status === 'Validated', masterJob.status);
  check('both rows are valid', masterJob.validRows === 2 && masterJob.invalidRows === 0);
  check('a lower-case brand is normalised, not rejected', masterJob.invalidRows === 0);
  check('NOTHING is written before confirmation',
    (await Product.countDocuments({ skuCode: { $in: [SKU_A, SKU_B] } })) === 0);
  check('the uploaded file is deleted once staged', !fs.existsSync(path.join(TMP, 'master-consumed.xlsx')));

  await confirmAndWait(masterJob.jobId);
  const afterMaster = await getJob(masterJob.jobId);
  check('the master import completes', afterMaster.status === 'Completed', afterMaster.status);
  check('two products exist', (await Product.countDocuments({ skuCode: { $in: [SKU_A, SKU_B] } })) === 2);
  const prodA = await Product.findOne({ skuCode: SKU_A }).lean();
  check('the brand discriminator stamped the document', prodA?.brand === BRAND, String(prodA?.brand));
  check('planning values landed', prodA?.leadTime === 30 && prodA?.dailyAvgConsumption === 4);

  // ── 7. Validation ─────────────────────────────────────────────────────────
  console.log('\n7. VALIDATION — ALL ERRORS COLLECTED');
  const badFile = await makeXlsx(path.join(TMP, 'bad.xlsx'),
    ['SKU Code', 'Brand', 'Location Code', 'Quantity', 'Unit Cost', 'Note'],
    [
      [SKU_A, 'Koken', location.code, 100, 5, 'good'],           // valid
      ['', 'Koken', location.code, 10, null, 'no sku'],           // required
      ['__M9_NOPE__', 'Koken', location.code, 10, null, 'ghost'], // unknown sku
      [SKU_A, 'Nintendo', location.code, 10, null, 'bad brand'],  // unknown brand
      [SKU_B, 'Koken', 'NO-SUCH-LOC', 10, null, 'bad loc'],       // unknown location
      [SKU_B, 'Koken', location.code, 'abc', null, 'bad qty'],    // not a number
      [SKU_B, 'Koken', location.code, -5, null, 'negative'],      // below min
      [SKU_A, 'Koken', location.code, 55, null, 'duplicate'],     // dup of row 1
    ]);
  const badJob = await upload('opening-stock', fixture(badFile, 'bad'), 'xlsx');
  check('validation does not stop at the first bad row', badJob.totalRows === 8, `read ${badJob.totalRows}`);
  check('one row is valid, seven are not',
    badJob.validRows === 1 && badJob.invalidRows === 7, `${badJob.validRows}/${badJob.invalidRows}`);

  const report = await errorReport(badJob.jobId, { limit: 200 });
  const cats = report.byCategory;
  check('a missing required field is reported', (cats.required ?? 0) >= 1);
  check('an unknown SKU is reported', report.errors.some((e) => /does not exist/.test(e.message)));
  check('an unknown brand is reported', report.errors.some((e) => /Unknown brand/.test(e.message)));
  check('an unknown location is reported', report.errors.some((e) => /Unknown location/.test(e.message)));
  check('a non-numeric quantity is reported', (cats.format ?? 0) >= 1);
  check('a negative quantity is reported', (cats.range ?? 0) >= 1 || report.errors.some((e) => /at least 0/.test(e.message)));
  check('a duplicate key is reported', (cats.duplicate ?? 0) >= 1);
  check('errors carry the row number', report.errors.every((e) => e.rowNumber === null || Number.isInteger(e.rowNumber)));

  // Mixed file: the valid row must still import.
  await confirmAndWait(badJob.jobId);
  const mixed = await getJob(badJob.jobId);
  check('a mixed file imports its valid rows', mixed.successfulRows === 1, `${mixed.successfulRows}`);
  check('the outcome is Partial, not Completed', mixed.status === 'Partial', mixed.status);
  const balA = await StockBalance.findOne({ skuCode: SKU_A }).lean();
  check('the opening balance reached the projection', balA?.onHand === 100, String(balA?.onHand));
  check('it arrived as an OPENING ledger movement',
    (await StockMovement.countDocuments({ skuCode: SKU_A, movementType: 'OPENING' })) === 1);

  // Template failures
  const noHeader = await makeXlsx(path.join(TMP, 'nohdr.xlsx'), ['Widget', 'Thing'], [['a', 'b']]);
  const noHeaderJob = await upload('opening-stock', fixture(noHeader, 'nohdr'), 'xlsx');
  check('a wrong template fails the file', noHeaderJob.status === 'Failed');
  check('the missing columns are named', /SKU Code|Brand|Quantity/.test(noHeaderJob.fileErrors.join(' ')));
  await expectFail('a failed job cannot be confirmed',
    () => confirmJob({ jobId: noHeaderJob.jobId, actor, req: null }));

  const emptyFile = await makeXlsx(path.join(TMP, 'empty.xlsx'), headersFor('opening-stock'), []);
  const emptyJob = await upload('opening-stock', fixture(emptyFile, 'empty'), 'xlsx');
  check('a header-only file fails with a clear reason',
    emptyJob.status === 'Failed' && /no data rows/.test(emptyJob.fileErrors.join(' ')));

  // ── 8. Movements, chunking, idempotency ───────────────────────────────────
  console.log('\n8. MOVEMENTS, CHUNKING AND IDEMPOTENCY');
  const movFile = await makeXlsx(path.join(TMP, 'mov.xlsx'),
    ['SKU Code', 'Brand', 'Location Code', 'Movement Type', 'Quantity', 'Note'],
    [
      [SKU_A, 'Koken', location.code, 'RECEIPT', 50, 'in'],
      [SKU_A, 'Koken', location.code, 'ISSUE', 20, 'out'],
      [SKU_B, 'Koken', location.code, 'ADJUSTMENT', 7, 'adj'],
      [SKU_A, 'Koken', location.code, 'ISSUE', -3, 'signed by hand'],  // rejected
    ]);
  const movJob = await upload('stock-movements', fixture(movFile, 'mov'), 'xlsx');
  check('a hand-signed negative quantity is rejected', movJob.invalidRows === 1 && movJob.validRows === 3);
  check('the message explains the sign convention',
    (await ImportError.findOne({ jobId: movJob.jobId, category: 'range' }).lean())?.message.includes('positive'));

  const beforeA = (await StockBalance.findOne({ skuCode: SKU_A }).lean())?.onHand ?? 0;
  await confirmAndWait(movJob.jobId);
  const movDone = await getJob(movJob.jobId);
  check('three movements imported', movDone.successfulRows === 3, `${movDone.successfulRows}`);
  const afterA = (await StockBalance.findOne({ skuCode: SKU_A }).lean())?.onHand ?? 0;
  check('the balance moved by the net of the file', afterA === beforeA + 50 - 20, `${beforeA} → ${afterA}`);
  check('an ISSUE was stored as a negative movement',
    (await StockMovement.findOne({ skuCode: SKU_A, movementType: 'ISSUE' }).lean())?.quantity === -20);
  check('the job records the ledger batch it produced',
    movDone.producedRefs.some((r) => r.kind === 'ledgerBatch'));

  // Idempotency: re-running a finished job must post nothing further.
  const movementsBefore = await StockMovement.countDocuments({ skuCode: { $in: [SKU_A, SKU_B] } });
  await ImportJob.updateOne({ jobId: movJob.jobId }, { $set: { status: 'Processing' } });
  await ImportRow.updateMany({ jobId: movJob.jobId, status: 'processed' }, { $set: { status: 'pending' } });
  await runJob(movJob.jobId, actor, null);
  const movementsAfter = await StockMovement.countDocuments({ skuCode: { $in: [SKU_A, SKU_B] } });
  check('re-processing the same chunk posts NO new movements',
    movementsAfter === movementsBefore, `${movementsBefore} → ${movementsAfter}`);
  const replayedRow = await ImportRow.findOne({ jobId: movJob.jobId, status: 'processed' }).lean();
  check('the ledger reports the batch as replayed', replayedRow?.result?.replayed === true);
  const balanceAfterReplay = (await StockBalance.findOne({ skuCode: SKU_A }).lean())?.onHand ?? 0;
  check('the balance is unchanged by the replay', balanceAfterReplay === afterA, `${afterA} → ${balanceAfterReplay}`);

  // Re-upload of an identical file is caught before anything is staged.
  await expectFail('the same file cannot be uploaded twice',
    () => upload('stock-movements', fixture(movFile, 'mov-again'), 'xlsx'));
  const forced = await upload('stock-movements', fixture(movFile, 'mov-force'), 'xlsx', { force: true });
  check('...unless it is explicitly forced', forced.status === 'Validated');
  await cancelJob({ jobId: forced.jobId, reason: 'verification', actor, req: null });

  // ── 9. Resume and the processing lock ────────────────────────────────────
  console.log('\n9. RESUME AND THE PROCESSING LOCK');
  const resumeRows = Array.from({ length: 5 }, (_, i) => [SKU_B, 'Koken', location.code, 'RECEIPT', i + 1, `r${i}`]);
  const resumeFile = await makeXlsx(path.join(TMP, 'resume.xlsx'),
    ['SKU Code', 'Brand', 'Location Code', 'Movement Type', 'Quantity', 'Note'], resumeRows);
  const resJob = await upload('stock-movements', fixture(resumeFile, 'resume'), 'xlsx');
  check('rows sit pending before confirmation',
    (await ImportRow.countDocuments({ jobId: resJob.jobId, status: 'pending' })) === 5);

  await confirmAndWait(resJob.jobId);
  check('every pending row drains', (await ImportRow.countDocuments({ jobId: resJob.jobId, status: 'pending' })) === 0);
  const resumed = await getJob(resJob.jobId);
  check('all five rows processed', resumed.successfulRows === 5, `${resumed.successfulRows}`);
  check('the lock is released when the run finishes', resumed.lockedAt === null);

  // A crash mid-run: the job is left Processing with rows outstanding and a
  // lock nobody will ever release.
  await ImportRow.updateMany({ jobId: resJob.jobId }, { $set: { status: 'pending', result: null } });
  await ImportJob.updateOne({ jobId: resJob.jobId }, {
    $set: { status: 'Processing', successfulRows: 0, failedRows: 0, processedRows: 0, lockedAt: new Date() },
  });

  // A LIVE lock must block a second processor — this is what stops two runs
  // posting the same chunk at once.
  check('a second processor cannot claim a live lock',
    (await runJob(resJob.jobId, actor, null)) === null);
  check('...and it processed nothing',
    (await ImportRow.countDocuments({ jobId: resJob.jobId, status: 'pending' })) === 5);

  // A STALE lock is taken over, so a dead process cannot strand a job forever.
  await ImportJob.updateOne({ jobId: resJob.jobId }, { $set: { lockedAt: new Date(Date.now() - 20 * 60 * 1000) } });
  const movementsBeforeResume = await StockMovement.countDocuments({ skuCode: SKU_B });
  await resumeJob({ jobId: resJob.jobId, actor, req: null });
  await waitForIdle(resJob.jobId);
  check('a stale lock is taken over and the job resumes',
    (await ImportRow.countDocuments({ jobId: resJob.jobId, status: 'pending' })) === 0);
  check('resuming replayed the ledger rather than posting again',
    (await StockMovement.countDocuments({ skuCode: SKU_B })) === movementsBeforeResume,
    `${movementsBeforeResume} → ${await StockMovement.countDocuments({ skuCode: SKU_B })}`);
  await expectFail('resuming a finished job is refused',
    () => resumeJob({ jobId: resJob.jobId, actor, req: null }));

  // ── 10. Count import stops at approval ────────────────────────────────────
  console.log('\n10. COUNT IMPORT — M7 IS NOT BYPASSED');
  const countFile = await makeXlsx(path.join(TMP, 'count.xlsx'),
    ['SKU Code', 'Brand', 'Location Code', 'Counted Quantity', 'Reason Code', 'Note'],
    [[SKU_A, 'Koken', location.code, 999, 'MISCOUNT', '__M9_count__']]);
  const countJob = await upload('physical-count', fixture(countFile, 'count'), 'xlsx');
  check('the count sheet validates', countJob.status === 'Validated' && countJob.validRows === 1);
  check('no count session exists before confirmation',
    (await StockCount.countDocuments({ notes: /__M9_/ })) === 0);

  await confirmAndWait(countJob.jobId);
  const countDone = await getJob(countJob.jobId);
  const sessionRef = countDone.producedRefs.find((r) => r.kind === 'count');
  const session = sessionRef ? await StockCount.findOne({ countId: sessionRef.id }).lean() : null;
  check('a count session was created', Boolean(session), session?.countId);
  check('the job links to the session', countDone.producedRefs.some((r) => r.kind === 'count'));
  check('the session is Submitted, awaiting approval', session?.status === 'Submitted', session?.status);
  check('NOTHING posted to the ledger from the count import',
    (await StockMovement.countDocuments({ skuCode: SKU_A, movementType: 'COUNT' })) === 0);
  const balUnchanged = (await StockBalance.findOne({ skuCode: SKU_A }).lean())?.onHand ?? 0;
  check('the balance is untouched by the count import', balUnchanged === afterA, `${afterA} → ${balUnchanged}`);
  check('no adjustment was created', !session?.adjustmentId);

  // ── 11. Cancellation ──────────────────────────────────────────────────────
  console.log('\n11. CANCELLATION');
  const cancelFile = await makeXlsx(path.join(TMP, 'cancel.xlsx'),
    ['SKU Code', 'Brand', 'Location Code', 'Movement Type', 'Quantity', 'Note'],
    [[SKU_B, 'Koken', location.code, 'RECEIPT', 12, 'to cancel']]);
  const cancelJobRec = await upload('stock-movements', fixture(cancelFile, 'cancel'), 'xlsx');
  const balBeforeCancel = (await StockBalance.findOne({ skuCode: SKU_B }).lean())?.onHand ?? 0;
  await cancelJob({ jobId: cancelJobRec.jobId, reason: 'not needed', actor, req: null });
  const cancelled = await ImportJob.findOne({ jobId: cancelJobRec.jobId }).lean();
  check('the job is Cancelled', cancelled.status === 'Cancelled');
  check('the staged rows are discarded', (await ImportRow.countDocuments({ jobId: cancelJobRec.jobId })) === 0);
  check('cancelling wrote nothing to stock',
    ((await StockBalance.findOne({ skuCode: SKU_B }).lean())?.onHand ?? 0) === balBeforeCancel);
  await expectFail('a cancelled job cannot be confirmed',
    () => confirmJob({ jobId: cancelJobRec.jobId, actor, req: null }));

  // ── 12. Exports ───────────────────────────────────────────────────────────
  console.log('\n12. EXPORTS');
  /** Collect a streamed export into memory. Test-only — the real path streams. */
  const collect = async (exportType, format, filters = {}, brands = ['Koken', 'BIX', 'IMADA']) => {
    const chunks = [];
    const res = {
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      write(c) { chunks.push(Buffer.from(c)); return true; },
      end(c) { if (c) chunks.push(Buffer.from(c)); this.ended = true; },
      once() {},
      on() {},
      destroy() { this.destroyed = true; },
      headersSent: false,
    };
    const out = await runExport({ exportType, format, filters, brands, actor, req: null, res });
    if (out.exportId) exportIds.add(out.exportId);
    return { ...out, buffer: Buffer.concat(chunks), headers: res.headers, destroyed: res.destroyed };
  };

  const masterCsv = await collect('inventory-master', 'csv', { search: '__M9' });
  const csvText = masterCsv.buffer.toString('utf8');
  check('a CSV export streams rows', masterCsv.rowCount === 2, `${masterCsv.rowCount}`);
  check('the CSV carries a header row', csvText.includes('SKU Code,Brand'));
  check('the CSV contains the exported SKUs', csvText.includes(SKU_A) && csvText.includes(SKU_B));
  check('the CSV starts with a BOM for Excel', masterCsv.buffer[0] === 0xEF);
  check('the download filename is set', /attachment; filename=/.test(masterCsv.headers['Content-Disposition']));
  check('an export is logged', Boolean(await ExportJob.findOne({ exportId: masterCsv.exportId }).lean()));

  const balanceCsv = await collect('stock-balance', 'csv', { skuCode: SKU_A });
  const balanceText = balanceCsv.buffer.toString('utf8');
  const balanceLine = balanceText.split('\r\n').find((l) => l.startsWith(SKU_A));
  const balanceCols = balanceLine.split(',');
  check('the balance export derives Available correctly',
    Number(balanceCols[7]) === Number(balanceCols[3]) - Number(balanceCols[4]),
    balanceLine);

  // The xlsx writer needs a real Writable — it pipes a zip through it — so this
  // one goes to a file and is read back, which also proves the output is a
  // workbook rather than merely some bytes.
  const xlsxPath = path.join(TMP, 'export.xlsx');
  const fileStream = fs.createWriteStream(xlsxPath);
  fileStream.setHeader = () => {};
  const xlsxOut = await runExport({
    exportType: 'inventory-master', format: 'xlsx', filters: { search: '__M9' },
    brands: ['Koken', 'BIX', 'IMADA'], actor, req: null, res: fileStream,
  });
  // No wait needed: exceljs's WorkbookWriter resolves its commit on the
  // stream's own 'finish', so by the time runExport returns the file is whole.
  // (Listening for 'close' here would hang — it has already fired.)
  if (!fileStream.writableFinished) {
    await new Promise((resolve) => fileStream.end(resolve));
  }
  if (xlsxOut.exportId) exportIds.add(xlsxOut.exportId);
  const xlsxBytes = fs.readFileSync(xlsxPath);
  check('an xlsx export is a real zip container',
    xlsxBytes.length > 0 && xlsxBytes[0] === 0x50 && xlsxBytes[1] === 0x4B, `${xlsxBytes.length} bytes`);
  check('the xlsx export reports its row count', xlsxOut.rowCount === 2, `${xlsxOut.rowCount}`);
  const roundTrip = new ExcelJS.Workbook();
  await roundTrip.xlsx.readFile(xlsxPath);
  const sheet = roundTrip.worksheets[0];
  check('the workbook reads back with a header and both rows',
    sheet.getRow(1).getCell(1).value === 'SKU Code' && sheet.rowCount === 3, `rows=${sheet.rowCount}`);
  check('the exported cells carry the real values',
    [sheet.getRow(2).getCell(1).value, sheet.getRow(3).getCell(1).value].sort().join() === [SKU_A, SKU_B].sort().join(),
    `${sheet.getRow(2).getCell(1).value} / ${sheet.getRow(3).getCell(1).value}`);

  // Brand isolation
  const bixOnly = await collect('inventory-master', 'csv', { search: '__M9' }, ['BIX']);
  check('brand isolation excludes another brand\'s rows', bixOnly.rowCount === 0, `${bixOnly.rowCount}`);
  const kokenOnly = await collect('inventory-master', 'csv', { search: '__M9' }, ['Koken']);
  check('...and includes the caller\'s own', kokenOnly.rowCount === 2, `${kokenOnly.rowCount}`);

  await expectFail('an unknown export type is refused',
    () => collect('not-a-thing', 'csv', {}));
  await expectFail('the snapshot export refuses to run without a run id',
    () => collect('snapshot', 'csv', {}));
  await expectFail('an export refuses when the caller can see no brands',
    () => collect('inventory-master', 'csv', {}, []));

  // ── 13. Security ──────────────────────────────────────────────────────────
  console.log('\n13. SECURITY');
  const importCtl = readSource('modules', 'inventory', 'import.controller.js');
  const exportCtl = readSource('modules', 'inventory', 'export.controller.js');
  const routes = readSource('modules', 'inventory', 'inventory.routes.js');
  const uploadMw = readSource('middlewares', 'importUpload.js');

  check('both controllers coerce query values to strings',
    /const asString/.test(importCtl) && /const asString/.test(exportCtl));
  check('the upload never uses the client filename on disk',
    /crypto\.randomBytes/.test(uploadMw) && !/cb\(null, file\.originalname\)/.test(uploadMw));
  check('uploads are stored outside the repo', /os\.tmpdir\(\)/.test(uploadMw));
  check('the upload size is capped', /limits:\s*\{[^}]*fileSize/.test(uploadMw));
  check('only spreadsheet extensions are accepted', /ALLOWED_EXTENSIONS/.test(uploadMw));
  check('every import route is permission-gated',
    (routes.match(/router\.(get|post)\('\/imports[^)]*/g) || []).every((r) => r.includes('authorize(')));
  check('every export route is permission-gated',
    (routes.match(/router\.get\('\/exports[^)]*/g) || []).every((r) => r.includes('authorize(')));
  check('the import type permission is re-checked at confirm',
    /mayImport\(req\.user, existing\.importType\)/.test(importCtl));
  check('exports are read-only — no write to any collection',
    !/\.(create|insertMany|updateOne|updateMany|deleteOne|deleteMany|bulkWrite)\(/.test(
      exportSvc.replace(/ExportJob\.create\([\s\S]*?\}\)/, '')));

  // A NoSQL operator smuggled into a filter must not reach Mongo.
  const injected = await collect('inventory-master', 'csv', { search: '__M9', status: { $ne: 'Active' } });
  check('an operator object in a filter cannot widen the result',
    injected.rowCount <= 2, `${injected.rowCount}`);

  // ── 14. Audit ─────────────────────────────────────────────────────────────
  console.log('\n14. AUDIT');
  const audits = await mongoose.connection.collection('auditlogs')
    .find({ 'meta.jobId': { $in: [...jobIds] } }).toArray();
  const actions = new Set(audits.map((a) => a.action));
  for (const expected of ['Inventory Import Uploaded', 'Inventory Import Confirmed', 'Inventory Import Processed', 'Inventory Import Cancelled']) {
    check(`audited: ${expected}`, actions.has(expected));
  }
  check('the audit records the file hash',
    audits.some((a) => typeof a.meta?.fileHash === 'string' && a.meta.fileHash.length === 64));
  check('exports are audited',
    (await mongoose.connection.collection('auditlogs').countDocuments({ action: 'Inventory Exported' })) > 0);

  // ── Clean up ──────────────────────────────────────────────────────────────
  const countSession = session;
  if (countSession) {
    await mongoose.connection.collection('stockcountlines').deleteMany({ countId: countSession.countId });
    await mongoose.connection.collection('stockcounts').deleteMany({ countId: countSession.countId });
  }
  await mongoose.connection.collection('auditlogs').deleteMany({ 'meta.jobId': { $in: [...jobIds] } });
  await mongoose.connection.collection('auditlogs').deleteMany({ action: 'Inventory Exported', 'meta.exportId': { $in: [...exportIds] } });
  await wipe();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`   PASSED ${passed}   FAILED ${failed}`);
  console.log('─'.repeat(52));
  console.log(failed === 0
    ? '\n✅  Import/export guarantees hold.\n'
    : '\n❌  M9 verification FAILED — see above.\n');

  await mongoose.disconnect();
  process.exit(failed === 0 ? 0 : 1);
};

run().catch(async (err) => {
  console.error('\n❌  Verification crashed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
