import ExcelJS from 'exceljs';

import { Product } from '../../models/Product.js';
import StockBalance, { deriveBalance } from '../../models/StockBalance.js';
import StockHealth from '../../models/StockHealth.js';
import StockMovement from '../../models/StockMovement.js';
import InventorySnapshot from '../../models/InventorySnapshot.js';
import SnapshotRun from '../../models/SnapshotRun.js';
import StockCount from '../../models/StockCount.js';
import InventoryAlert, { ALERT_TYPES } from '../../models/InventoryAlert.js';
import ExportJob from '../../models/ExportJob.js';
import { nextSequence } from '../../models/Counter.js';
import { recordAudit } from '../../utils/auditLog.js';

/**
 * Export service (IMS Module M9).
 *
 * READ-ONLY, AND IT CALCULATES NOTHING. Every column below is a field that
 * already exists on a projection: the band was decided by M4, the balance by
 * M3, the movement by M2. If a figure is not already stored, it is not
 * exported — deriving it here would create a second implementation of the rule
 * and guarantee that one day a spreadsheet and the screen disagree.
 *
 * Rows are streamed from a Mongo cursor straight into the response. Nothing
 * accumulates an array of results, so a 50,000-row export uses the same memory
 * as a 50-row one.
 */

/**
 * Column definitions per export.
 *
 * `get` reads a stored value. It may format — a date as a date, a null as an
 * em-dash — but it must never compute a business figure from other fields.
 */
const nul = (v) => (v === null || v === undefined ? '' : v);
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const stamp = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '');

export const EXPORTS = {
  'inventory-master': {
    label: 'Inventory Master',
    model: () => Product,
    sort: { brand: 1, skuCode: 1 },
    columns: [
      { header: 'SKU Code', get: (r) => r.skuCode },
      { header: 'Brand', get: (r) => r.brand },
      { header: 'MSIL Code', get: (r) => nul(r.msilCode) },
      { header: 'Description', get: (r) => nul(r.description) },
      { header: 'Category', get: (r) => (r.category || []).join(', ') },
      { header: 'UOM', get: (r) => nul(r.uom) },
      { header: 'Status', get: (r) => nul(r.status) },
      { header: 'Current Season', get: (r) => nul(r.currentSeason) },
      { header: 'Daily Avg Consumption', get: (r) => nul(r.dailyAvgConsumption) },
      { header: 'Lead Time', get: (r) => nul(r.leadTime) },
      { header: 'Safety Factor', get: (r) => nul(r.safetyFactor) },
      { header: 'Updated At', get: (r) => stamp(r.updatedAt) },
    ],
    filter: ({ brand, category, status, search }) => ({
      ...(brand ? { brand } : {}),
      ...(category ? { category } : {}),
      ...(status ? { status } : {}),
      ...(search ? { skuCode: new RegExp(`^${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') } : {}),
    }),
  },

  'stock-balance': {
    label: 'Stock Balance',
    model: () => StockBalance,
    sort: { skuCode: 1 },
    columns: [
      { header: 'SKU Code', get: (r) => r.skuCode },
      { header: 'Brand', get: (r) => r.brand },
      { header: 'Location', get: (r) => nul(r.locationCode) },
      { header: 'On Hand', get: (r) => r.onHand },
      { header: 'Reserved', get: (r) => r.reserved },
      { header: 'Incoming', get: (r) => deriveBalance(r).incoming },
      { header: 'Outgoing', get: (r) => deriveBalance(r).outgoing },
      // M3 deliberately does NOT store `available` — it is derived, so that a
      // stale stored copy can never contradict the two numbers it comes from.
      // The export therefore calls M3's own `deriveBalance` rather than
      // subtracting here, which would be a second implementation of the rule
      // and the exact duplication this module is forbidden.
      { header: 'Available', get: (r) => deriveBalance(r).available },
      { header: 'Projected', get: (r) => deriveBalance(r).projected },
      { header: 'Last Movement', get: (r) => stamp(r.lastMovementAt) },
      { header: 'Last Physical Movement', get: (r) => stamp(r.lastPhysicalMovementAt) },
    ],
    filter: ({ brand, locationCode, skuCode }) => ({
      ...(brand ? { brand } : {}),
      ...(locationCode ? { locationCode } : {}),
      ...(skuCode ? { skuCode } : {}),
    }),
  },

  'stock-health': {
    label: 'Stock Health',
    model: () => StockHealth,
    sort: { skuCode: 1 },
    columns: [
      { header: 'SKU Code', get: (r) => r.skuCode },
      { header: 'Brand', get: (r) => r.brand },
      { header: 'Band', get: (r) => r.band },
      { header: 'Plannable', get: (r) => (r.plannable ? 'Yes' : 'No') },
      { header: 'On Hand', get: (r) => r.onHand },
      { header: 'Available', get: (r) => r.available },
      { header: 'Max Level', get: (r) => nul(r.maxLevel) },
      { header: 'Reorder Level', get: (r) => nul(r.reorderLevel) },
      { header: '% Of Target', get: (r) => nul(r.replenishmentPercent) },
      { header: 'Coverage Days', get: (r) => nul(r.coverageDays) },
      { header: 'Not Plannable Because', get: (r) => (r.notPlannableReasons || []).join(', ') },
      { header: 'Computed At', get: (r) => stamp(r.computedAt) },
    ],
    filter: ({ brand, band, plannable }) => ({
      ...(brand ? { brand } : {}),
      ...(band ? { band } : {}),
      ...(plannable === 'true' ? { plannable: true } : plannable === 'false' ? { plannable: false } : {}),
    }),
  },

  'stock-movements': {
    label: 'Stock Movements',
    model: () => StockMovement,
    sort: { effectiveDate: -1, _id: -1 },
    columns: [
      { header: 'Transaction ID', get: (r) => r.transactionId },
      { header: 'Batch ID', get: (r) => r.batchId },
      { header: 'Effective Date', get: (r) => stamp(r.effectiveDate) },
      { header: 'SKU Code', get: (r) => r.skuCode },
      { header: 'Brand', get: (r) => r.brand },
      { header: 'Location', get: (r) => nul(r.locationCode) },
      { header: 'Movement Type', get: (r) => r.movementType },
      { header: 'Class', get: (r) => nul(r.movementClass) },
      { header: 'Quantity', get: (r) => r.quantity },
      { header: 'Before', get: (r) => nul(r.beforeQuantity) },
      { header: 'After', get: (r) => nul(r.afterQuantity) },
      { header: 'Reason Code', get: (r) => nul(r.reasonCode) },
      { header: 'Reference', get: (r) => nul(r.referenceId) },
      { header: 'Note', get: (r) => nul(r.note) },
    ],
    filter: ({ brand, skuCode, locationCode, movementType, dateFrom, dateTo }) => ({
      ...(brand ? { brand } : {}),
      ...(skuCode ? { skuCode } : {}),
      ...(locationCode ? { locationCode } : {}),
      ...(movementType ? { movementType } : {}),
      ...(dateFrom || dateTo ? {
        effectiveDate: {
          ...(dateFrom ? { $gte: new Date(dateFrom) } : {}),
          ...(dateTo ? { $lte: new Date(`${dateTo}T23:59:59.999Z`) } : {}),
        },
      } : {}),
    }),
  },

  snapshot: {
    label: 'Inventory Snapshot',
    model: () => InventorySnapshot,
    sort: { skuCode: 1 },
    columns: [
      { header: 'Run ID', get: (r) => r.runId },
      { header: 'Snapshot Date', get: (r) => day(r.snapshotDate) },
      { header: 'SKU Code', get: (r) => r.skuCode },
      { header: 'Brand', get: (r) => r.brand },
      { header: 'Location', get: (r) => nul(r.locationCode) },
      { header: 'On Hand', get: (r) => r.onHand },
      { header: 'Reserved', get: (r) => nul(r.reserved) },
      { header: 'Available', get: (r) => nul(r.available) },
      { header: 'Band', get: (r) => nul(r.band) },
      { header: 'Max Level', get: (r) => nul(r.maxLevel) },
    ],
    // A snapshot export is always for ONE run. Exporting across runs would mix
    // two versions of history in one file with nothing to tell them apart.
    filter: ({ runId }) => ({ runId }),
    requires: ['runId'],
  },

  'stock-counts': {
    label: 'Count Sessions',
    model: () => StockCount,
    sort: { createdAt: -1 },
    columns: [
      { header: 'Count ID', get: (r) => r.countId },
      { header: 'Status', get: (r) => r.status },
      { header: 'Scope', get: (r) => nul(r.scope) },
      { header: 'Brand', get: (r) => nul(r.brand) },
      { header: 'Location', get: (r) => r.locationCode },
      { header: 'Lines', get: (r) => nul(r.lineCount) },
      { header: 'Adjustment ID', get: (r) => nul(r.adjustmentId) },
      { header: 'Ledger Batch', get: (r) => nul(r.ledgerBatchId) },
      { header: 'Created', get: (r) => stamp(r.createdAt) },
      { header: 'Posted', get: (r) => stamp(r.postedAt) },
    ],
    filter: ({ brand, status, locationCode, dateFrom, dateTo }) => ({
      ...(brand ? { brand } : {}),
      ...(status ? { status } : {}),
      ...(locationCode ? { locationCode } : {}),
      ...(dateFrom || dateTo ? {
        createdAt: {
          ...(dateFrom ? { $gte: new Date(dateFrom) } : {}),
          ...(dateTo ? { $lte: new Date(`${dateTo}T23:59:59.999Z`) } : {}),
        },
      } : {}),
    }),
  },

  alerts: {
    label: 'Inventory Alerts',
    model: () => InventoryAlert,
    sort: { createdAt: -1 },
    columns: [
      { header: 'Alert ID', get: (r) => r.alertId },
      { header: 'Type', get: (r) => ALERT_TYPES[r.alertType]?.label ?? r.alertType },
      { header: 'Category', get: (r) => r.category },
      { header: 'Severity', get: (r) => r.severity },
      { header: 'Status', get: (r) => r.status },
      { header: 'SKU Code', get: (r) => nul(r.skuCode) },
      { header: 'Brand', get: (r) => nul(r.brand) },
      { header: 'Title', get: (r) => r.title },
      { header: 'Occurrences', get: (r) => r.occurrences },
      { header: 'First Seen', get: (r) => stamp(r.firstSeenAt) },
      { header: 'Last Seen', get: (r) => stamp(r.lastSeenAt) },
      { header: 'Resolved At', get: (r) => stamp(r.resolvedAt) },
      { header: 'Auto Resolved', get: (r) => (r.autoResolved ? 'Yes' : 'No') },
      { header: 'Resolution Note', get: (r) => nul(r.resolutionNote) },
    ],
    filter: ({ brand, severity, status, category, alertType, dateFrom, dateTo }) => ({
      ...(brand ? { brand } : {}),
      ...(severity ? { severity } : {}),
      ...(status ? { status } : {}),
      ...(category ? { category } : {}),
      ...(alertType ? { alertType } : {}),
      ...(dateFrom || dateTo ? {
        createdAt: {
          ...(dateFrom ? { $gte: new Date(dateFrom) } : {}),
          ...(dateTo ? { $lte: new Date(`${dateTo}T23:59:59.999Z`) } : {}),
        },
      } : {}),
    }),
  },
};

export const EXPORT_NAMES = Object.keys(EXPORTS);

/**
 * Brand isolation, applied on top of whatever the caller asked for.
 *
 * A brand filter in the query narrows; it can never widen. The `$and` keeps the
 * two conditions independent, so a caller who asks for a brand they cannot see
 * gets an empty file rather than someone else's data.
 */
const applyBrandScope = (filter, brands, hasBrandField = true) => {
  if (!hasBrandField) return filter;
  return { $and: [filter, { $or: [{ brand: null }, { brand: { $in: brands } }] }] };
};

// ─── File writers ────────────────────────────────────────────────────────────

const csvCell = (value) => {
  const s = value === null || value === undefined ? '' : String(value);
  // Quote when the value could otherwise break the row. The doubled quote is
  // the CSV escape, not a typo.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Stream a CSV straight to the response.
 *
 * Written row by row as the cursor yields, with backpressure respected — if the
 * client is slow, the cursor waits rather than the process buffering the whole
 * export in memory.
 */
const writeCsv = async (res, columns, cursor) => {
  let rowCount = 0;
  let byteCount = 0;

  const push = (line) => {
    byteCount += Buffer.byteLength(line);
    if (!res.write(line)) {
      return new Promise((resolve) => res.once('drain', resolve));
    }
    return null;
  };

  // BOM, so Excel opens a UTF-8 CSV with the accents intact instead of mojibake.
  await push('﻿');
  await push(`${columns.map((c) => csvCell(c.header)).join(',')}\r\n`);

  for await (const doc of cursor) {
    const wait = push(`${columns.map((c) => csvCell(c.get(doc))).join(',')}\r\n`);
    if (wait) await wait;
    rowCount += 1;
  }

  return { rowCount, byteCount };
};

/**
 * Stream an .xlsx straight to the response.
 *
 * `WorkbookWriter` commits each row to the output as it is added rather than
 * building a workbook in memory — the streaming counterpart of the reader used
 * on the import side.
 */
const writeXlsx = async (res, columns, cursor, sheetName) => {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: res,
    // Needed for the bold header row. Without it exceljs silently drops every
    // style, so the setting below would look applied and do nothing.
    useStyles: true,
    // A shared-string table must be held in memory for the whole workbook and
    // written at the end, which is the opposite of streaming. Inline strings
    // cost a little file size and keep memory flat.
    useSharedStrings: false,
  });

  // `views` is CONSTRUCTOR-ONLY on the streaming writer — `sheet.views = [...]`
  // has a getter and no setter, and assigning to it throws. The error surfaces
  // mid-stream, after the response headers have gone out, so the browser saves
  // a truncated file that looks like a real download and opens as "corrupted
  // zip". Passing it here is the only way that works.
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31), {
    // The header stays visible when someone scrolls a 9,000-row export.
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = columns.map((c) => ({
    header: c.header,
    key: c.header,
    width: Math.min(Math.max(c.header.length + 4, 12), 40),
  }));
  sheet.getRow(1).font = { bold: true };

  let rowCount = 0;
  for await (const doc of cursor) {
    sheet.addRow(columns.map((c) => c.get(doc))).commit();
    rowCount += 1;
  }

  sheet.commit();
  await workbook.commit();
  return { rowCount, byteCount: 0 };
};

// ─── Entry point ─────────────────────────────────────────────────────────────

const fail = (message, status = 400, code = 'EXPORT_ERROR') => {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
};

/**
 * Run an export, streaming it to the response and logging it.
 *
 * The log is written AFTER the stream finishes, with the real row count — a
 * record claiming 9,000 rows for a download that broke at 400 would be worse
 * than no record.
 */
export const runExport = async ({ exportType, format = 'xlsx', filters = {}, brands, actor, req, res }) => {
  const spec = EXPORTS[exportType];
  if (!spec) fail(`Unknown export "${exportType}".`, 400, 'UNKNOWN_EXPORT');
  if (!['xlsx', 'csv'].includes(format)) fail('Format must be xlsx or csv.');

  for (const required of (spec.requires || [])) {
    if (!filters[required]) fail(`This export needs a ${required}.`);
  }
  if (!brands || brands.length === 0) fail('Your account has access to no brands.', 403, 'NO_BRAND_ACCESS');

  const started = Date.now();
  const year = new Date().getFullYear();
  const seq = await nextSequence(`exportjob-${year}`);
  const exportId = `EXP-${year}-${String(seq).padStart(6, '0')}`;
  const fileName = `${exportType}-${new Date().toISOString().slice(0, 10)}-${exportId}.${format}`;

  const Model = spec.model();
  const baseFilter = spec.filter(filters) || {};

  // "Export the rows I selected" — applied on top of whatever the type's own
  // filter produced, so a selection can never widen the scope, only narrow it.
  // Every export here is keyed on skuCode, so one clause covers them all.
  if (Array.isArray(filters.skuCodes) && filters.skuCodes.length > 0) {
    baseFilter.skuCode = { $in: filters.skuCodes };
  }
  if (Array.isArray(filters.transactionIds) && filters.transactionIds.length > 0) {
    baseFilter.transactionId = { $in: filters.transactionIds };
  }
  const scoped = applyBrandScope(baseFilter, brands);

  // `lean()` because these documents are read once and written to a file —
  // hydrating them into Mongoose objects would allocate for nothing. Batched so
  // the driver holds a bounded window rather than a whole result set.
  const cursor = Model.find(scoped).sort(spec.sort).lean().batchSize(500).cursor();

  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', format === 'csv'
    ? 'text/csv; charset=utf-8'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  // No length is known in advance — that is the price of streaming, and it is
  // the right trade against buffering the file to measure it.
  res.setHeader('Cache-Control', 'no-store');

  let outcome = { rowCount: 0, byteCount: 0 };
  let failureReason = null;

  try {
    outcome = format === 'csv'
      ? await writeCsv(res, spec.columns, cursor)
      : await writeXlsx(res, spec.columns, cursor, spec.label);
    if (format === 'csv') res.end();
  } catch (error) {
    failureReason = error.message;
    // Headers are already sent, so the response cannot become a JSON error.
    // Destroying it is what tells the client the file is incomplete — ending it
    // cleanly would hand over a truncated file that looks whole.
    res.destroy();
  } finally {
    await cursor.close().catch(() => {});
  }

  await ExportJob.create({
    exportId, exportType, format, fileName,
    filters, brandScope: brands,
    rowCount: outcome.rowCount,
    byteCount: outcome.byteCount,
    durationMs: Date.now() - started,
    status: failureReason ? 'Failed' : 'Completed',
    failureReason,
    requestedBy: actor._id,
  }).catch((e) => console.error('[Export] Failed to log export:', e.message));

  await recordAudit(actor, 'Inventory Exported',
    `${spec.label} exported as ${format.toUpperCase()} (${exportId}): ` +
    `${outcome.rowCount} row(s)${failureReason ? ` — FAILED: ${failureReason}` : ''}.`,
    req, { meta: { exportId, exportType, format, filters, brandScope: brands, rowCount: outcome.rowCount, failureReason } });

  return { exportId, rowCount: outcome.rowCount, failureReason };
};

/** Snapshot runs available to export, so the UI can offer a real list. */
export const listSnapshotRuns = async (brands) => {
  const runs = await SnapshotRun.find(
    { status: 'complete', $or: [{ scopeBrand: null }, { scopeBrand: { $in: brands } }] },
    'runId snapshotDate scopeBrand rowCount skuCount completedAt',
  ).sort({ snapshotDate: -1 }).limit(100).lean();
  return runs;
};

export default { EXPORTS, EXPORT_NAMES, runExport, listSnapshotRuns };
