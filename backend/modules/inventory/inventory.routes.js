import express from 'express';
import {
  listItems, listItemCodes, lookupItems, getItem, updatePlanning, bulkUpdatePlanning,
  listCategories, checkSkuAvailable, createItem, getItemReferences, deleteItem, renameItemCode,
} from './inventory.controller.js';
import { postAdjustment, getAdjustmentPreview, getReasonCodes } from './adjustment.controller.js';
import { recalculate as recalculateConsumption } from './consumption.controller.js';
import { listLocations, createLocation, updateLocation, setDefaultLocation } from './location.controller.js';
import { getConfig, getConfigHistory, updateConfig } from './config.controller.js';
import {
  searchLedger, searchLedgerGrouped, getSkuMovements, getMovement, getBatch, listMovementTypes,
} from './ledger.controller.js';
import {
  listBalances, getBalanceBySku, getAvailabilityBatch, rebuild, getReconciliation,
} from './balance.controller.js';
import {
  listHealth, listHealthCodes, getHealthBySku, getReorderList, getOverstockList,
  getCoverage, rebuild as rebuildHealthProjection, listFormulas,
} from './health.controller.js';
import { getDashboard } from './dashboard.controller.js';
import {
  getInventorySummary, getMovementReport, getHealthReport, getBalanceReport,
  getAgingReport, listSnapshots, getSnapshot, createSnapshot,
  getSnapshotValidation, getSnapshotComparison,
} from './report.controller.js';
import {
  listCounts, getCount, create as createCountSession, start as startCountSession,
  update as updateCountLines, submit as submitCountSession, review as reviewCountSession,
  post as postCountSession, cancel as cancelCountSession, listVariances,
  countHistory, listAdjustments, listOversold, resolveOversoldException,
} from './count.controller.js';
import {
  listAlerts, getAlert, acknowledge as acknowledgeAlert, resolve as resolveAlert,
  close as closeAlert, listRules, updateRule, listNotifications,
  markNotificationsRead, getStatistics as getAlertStatistics, listAlertTypes,
} from './alert.controller.js';
import {
  listImportTypes, downloadTemplate, upload as uploadImport, preview as previewImport,
  errors as importErrors, confirm as confirmImport, status as importStatus,
  resume as resumeImport, cancel as cancelImport, history as importHistory,
  setImportMoqHandler, setNewSkuDetailsHandler,
} from './import.controller.js';
import {
  listExportTypes, listRuns as listExportRuns, download as downloadExport,
  history as exportHistory,
} from './export.controller.js';
import { uploadImportFile, handleUploadErrors } from '../../middlewares/importUpload.js';
import { protect } from '../../middlewares/auth.js';
import { authorize, PERMISSIONS } from '../../middlewares/rbac.js';

/**
 * Inventory Management System — Module M1 routes.
 *
 * Every route is authenticated AND permission-checked. Admin satisfies these via
 * the '*' wildcard; Customers hold none of them and are rejected. The frontend
 * hides controls it cannot use, but that is convenience only — these checks are
 * the control.
 *
 * Grown module by module: M1 master data, M2 ledger, M3 balances, M4 health,
 * M5 dashboard, M6 reports and snapshots, M7 counts, M8 alerts.
 */
const router = express.Router();

router.use(protect);

// ── Inventory master ──────────────────────────────────────────────────────
// Static paths first, or Express matches '/categories' as a :sku.
router.get('/categories', authorize(PERMISSIONS.VIEW_INVENTORY), listCategories);

// Daily average measured from sales. Rewrites a planning input across the
// catalogue, so it is a system operation, not a master edit.
router.post('/consumption/recalculate', authorize(PERMISSIONS.CONFIGURE_INVENTORY), recalculateConsumption);
router.get('/items', authorize(PERMISSIONS.VIEW_INVENTORY), listItems);
// Before '/items/:sku', or 'codes' is read as a SKU. Backs the table's
// select-all, which needs every matching code rather than one page of them.
router.get('/items/codes', authorize(PERMISSIONS.VIEW_INVENTORY), listItemCodes);
// Read-only: check a list of SKU codes against the catalogue. Static path, so
// it sits with the others before '/items/:sku'.
router.post('/items/lookup', authorize(PERMISSIONS.VIEW_INVENTORY), lookupItems);
// ── SKU lifecycle (M1) ────────────────────────────────────────────────────
// Static paths BEFORE '/items/:sku', or 'available' is read as a SKU code.
//
// Creating and editing sit on MANAGE_INVENTORY_MASTER, the permission that has
// always governed the master. DELETING has its own, and it is Admin-only: a SKU
// code is a business key that orders and movements refer to by name, so
// removing one is not master-data maintenance. The service refuses outright to
// delete a SKU anything has ever referenced, so what this permission actually
// governs is undoing a row created by mistake.
router.get('/items/available', authorize(PERMISSIONS.MANAGE_INVENTORY_MASTER), checkSkuAvailable);
router.post('/items', authorize(PERMISSIONS.MANAGE_INVENTORY_MASTER), createItem);

router.get('/items/:sku', authorize(PERMISSIONS.VIEW_INVENTORY), getItem);
// What would break if this SKU went. Read by the confirmation dialog, so the
// cost is stated before the click rather than by the refusal after it.
router.get('/items/:sku/references', authorize(PERMISSIONS.MANAGE_INVENTORY_MASTER), getItemReferences);
router.delete('/items/:sku', authorize(PERMISSIONS.DELETE_SKU), deleteItem);
// Renaming the CODE. On MANAGE_INVENTORY_MASTER rather than DELETE_SKU because
// the service already restricts it to SKUs nothing has transacted against, so
// what it can actually reach is a typo on a row created minutes ago. A SKU with
// history keeps its code and is refused with an explanation.
router.patch('/items/:sku/code', authorize(PERMISSIONS.MANAGE_INVENTORY_MASTER), renameItemCode);

// Planning-parameter maintenance (M1). These are the ONLY write paths into the
// product master outside the M9 import — the portal, not the database, is where
// inventory is maintained.
//
// Nothing computed is writable here. Max Level, Available %, Total Available
// and Available for Sale are derived from these inputs plus the ledger, so
// there is no endpoint that can set them directly and no way for a stored value
// to drift from the formula that produced it.
//
// Both paths are three segments and differ in the LAST one ('bulk' vs the
// literal 'planning'), so neither can shadow the other whatever the order —
// unlike '/items/bulk', which '/items/:sku' would happily swallow as a SKU.
router.patch('/items/planning/bulk', authorize(PERMISSIONS.MANAGE_INVENTORY_MASTER), bulkUpdatePlanning);
router.patch('/items/:sku/planning', authorize(PERMISSIONS.MANAGE_INVENTORY_MASTER), updatePlanning);

// Direct stock adjustment. The only hand-operated write into the ledger, and
// it does NOT set a balance — it posts the DIFFERENCE between the figure the
// operator wants and the figure the ledger currently holds, as an ADJUSTMENT
// movement. ADJUST_STOCK, the same permission that gates posting a counted
// variance, because it is the same act: correcting recorded stock to reality.
//
// The static path sits before the parameterised sibling for the same reason as
// above; 'adjustments' could otherwise be read as a :sku.
router.get('/adjustments/reason-codes', authorize(PERMISSIONS.ADJUST_STOCK), getReasonCodes);
router.get('/items/:sku/adjust', authorize(PERMISSIONS.ADJUST_STOCK), getAdjustmentPreview);
router.post('/items/:sku/adjust', authorize(PERMISSIONS.ADJUST_STOCK), postAdjustment);

// ── Stock ledger (M2) ─────────────────────────────────────────────────────
// Read-only. Movements are posted through LedgerService by workflows in later
// modules — there is deliberately no HTTP route that writes to the ledger,
// because no approved workflow produces movements until M7.
//
// Static paths before parameterised ones, or '/movement-types' matches as a
// :transactionId.
router.get('/ledger/movement-types', authorize(PERMISSIONS.VIEW_STOCK_LEDGER), listMovementTypes);
// Grouped view: one row per posting rather than per movement. Before
// '/ledger/:transactionId', or 'grouped' is read as a transaction id.
router.get('/ledger/grouped', authorize(PERMISSIONS.VIEW_STOCK_LEDGER), searchLedgerGrouped);
router.get('/ledger', authorize(PERMISSIONS.VIEW_STOCK_LEDGER), searchLedger);
router.get('/ledger/:transactionId', authorize(PERMISSIONS.VIEW_STOCK_LEDGER), getMovement);
router.get('/items/:sku/movements', authorize(PERMISSIONS.VIEW_STOCK_LEDGER), getSkuMovements);
router.get('/batches/:identifier', authorize(PERMISSIONS.VIEW_STOCK_LEDGER), getBatch);

// ── Balance engine (M3) ───────────────────────────────────────────────────
// Balances are a projection of the ledger, never a source of truth. Reads are
// open to anyone who may see inventory; rebuilding and reconciling are system
// operations gated behind CONFIGURE_INVENTORY.
//
// Static and more-specific paths first.
router.get('/availability', authorize(PERMISSIONS.VIEW_INVENTORY), getAvailabilityBatch);
router.get('/reconciliation', authorize(PERMISSIONS.CONFIGURE_INVENTORY), getReconciliation);
router.post('/balances/rebuild', authorize(PERMISSIONS.CONFIGURE_INVENTORY), rebuild);
router.get('/balances', authorize(PERMISSIONS.VIEW_INVENTORY), listBalances);
router.get('/balances/:sku', authorize(PERMISSIONS.VIEW_INVENTORY), getBalanceBySku);

// ── Stock health (M4) ─────────────────────────────────────────────────────
// Reads the stockhealth projection — derived entirely from stockbalances,
// planning parameters and InventoryConfig. Never touches legacy inventory
// fields. Rebuilding is a system operation, so it sits behind
// CONFIGURE_INVENTORY alongside the other projection rebuilds.
//
// Static and more-specific paths first, or '/reorder' matches as a :sku.
router.get('/health/meta/formulas', authorize(PERMISSIONS.VIEW_INVENTORY), listFormulas);
router.get('/health/reorder/list', authorize(PERMISSIONS.VIEW_INVENTORY), getReorderList);
router.get('/health/overstock/list', authorize(PERMISSIONS.VIEW_INVENTORY), getOverstockList);
router.get('/health/coverage/lookup', authorize(PERMISSIONS.VIEW_INVENTORY), getCoverage);
// Before '/health/:sku', or 'codes' is read as a SKU.
router.get('/health/codes', authorize(PERMISSIONS.VIEW_INVENTORY), listHealthCodes);
router.post('/health/rebuild', authorize(PERMISSIONS.CONFIGURE_INVENTORY), rebuildHealthProjection);
router.get('/health', authorize(PERMISSIONS.VIEW_INVENTORY), listHealth);
router.get('/health/:sku', authorize(PERMISSIONS.VIEW_INVENTORY), getHealthBySku);

// ── Dashboard (M5) ────────────────────────────────────────────────────────
// A pure read model over the balance and health projections. One composed,
// briefly-cached payload rather than a widget-per-request fan-out. It performs
// no inventory calculation of its own — every figure traces to a projection.
router.get('/dashboard', authorize(PERMISSIONS.VIEW_INVENTORY), getDashboard);

// ── Reports & snapshots (M6) ──────────────────────────────────────────────
// Read-only aggregations over the ledger, balance and health projections.
// Nothing here computes an inventory value.
//
// Generating a snapshot WRITES immutable history, so it sits behind
// CONFIGURE_INVENTORY alongside the projection rebuilds. Reading one does not.
//
// Static and more-specific paths first, or '/snapshot-comparison' would match
// as a :runId.
router.get('/reports/inventory-summary', authorize(PERMISSIONS.VIEW_REPORTS, PERMISSIONS.VIEW_INVENTORY), getInventorySummary);
router.get('/reports/movements', authorize(PERMISSIONS.VIEW_REPORTS, PERMISSIONS.VIEW_STOCK_LEDGER), getMovementReport);
router.get('/reports/health', authorize(PERMISSIONS.VIEW_REPORTS, PERMISSIONS.VIEW_INVENTORY), getHealthReport);
router.get('/reports/balances', authorize(PERMISSIONS.VIEW_REPORTS, PERMISSIONS.VIEW_INVENTORY), getBalanceReport);
router.get('/reports/aging', authorize(PERMISSIONS.VIEW_REPORTS, PERMISSIONS.VIEW_INVENTORY), getAgingReport);
router.get('/reports/snapshot-comparison', authorize(PERMISSIONS.VIEW_REPORTS, PERMISSIONS.VIEW_INVENTORY), getSnapshotComparison);
router.get('/reports/snapshots/:runId/validate', authorize(PERMISSIONS.CONFIGURE_INVENTORY), getSnapshotValidation);
router.get('/reports/snapshots/:runId', authorize(PERMISSIONS.VIEW_INVENTORY), getSnapshot);
router.get('/reports/snapshots', authorize(PERMISSIONS.VIEW_INVENTORY), listSnapshots);
router.post('/reports/snapshots', authorize(PERMISSIONS.CONFIGURE_INVENTORY), createSnapshot);

// ── Stock verification & physical inventory (M7) ──────────────────────────
// Counting and approving are DELIBERATELY separate permissions. Warehouse
// users may count but not approve; Management may approve but not count.
// Inventory Manager holds both, so the service additionally enforces that the
// approver is not the person who counted or submitted — a permission check
// alone would let one person do the whole loop.
//
// Posting writes immutable ledger movements, so it needs ADJUST_STOCK.
//
// Static and more-specific paths first, or '/history' matches as a :countId.
router.get('/counts/history/lines', authorize(PERMISSIONS.VIEW_INVENTORY), countHistory);
router.get('/counts/oversold', authorize(PERMISSIONS.VIEW_INVENTORY), listOversold);
router.post('/counts/oversold/:id/resolve', authorize(PERMISSIONS.APPROVE_ADJUSTMENT), resolveOversoldException);
router.get('/counts/adjustments', authorize(PERMISSIONS.VIEW_INVENTORY), listAdjustments);

router.get('/counts', authorize(PERMISSIONS.VIEW_INVENTORY), listCounts);
router.post('/counts', authorize(PERMISSIONS.PERFORM_COUNT), createCountSession);
router.get('/counts/:countId', authorize(PERMISSIONS.VIEW_INVENTORY), getCount);
router.get('/counts/:countId/variances', authorize(PERMISSIONS.VIEW_INVENTORY), listVariances);
router.post('/counts/:countId/start', authorize(PERMISSIONS.PERFORM_COUNT), startCountSession);
router.put('/counts/:countId/lines', authorize(PERMISSIONS.PERFORM_COUNT), updateCountLines);
router.post('/counts/:countId/submit', authorize(PERMISSIONS.PERFORM_COUNT), submitCountSession);
router.post('/counts/:countId/review', authorize(PERMISSIONS.APPROVE_COUNT), reviewCountSession);
router.post('/counts/:countId/post', authorize(PERMISSIONS.ADJUST_STOCK), postCountSession);
router.post('/counts/:countId/cancel', authorize(PERMISSIONS.APPROVE_COUNT), cancelCountSession);

// ── Alerts & notifications (M8) ───────────────────────────────────────────
// There is NO route that creates an alert. Alerts are raised by the subscriber
// in response to events the projection modules emit — an endpoint that could
// create one would let a caller assert a stock condition no projection ever
// observed.
//
// Acknowledging and resolving are treated as inventory actions rather than
// approvals: they change nothing about stock, only who is on the hook for it.
// Rules ARE configuration — changing a severity or muting a type changes what
// the business is told about its own stock — so they sit behind
// CONFIGURE_INVENTORY alongside thresholds.
//
// Static paths first, or '/types' and '/rules' match as an :alertId.
router.get('/alerts/types', authorize(PERMISSIONS.VIEW_INVENTORY), listAlertTypes);
router.get('/alerts/statistics', authorize(PERMISSIONS.VIEW_INVENTORY), getAlertStatistics);
router.get('/alerts/rules', authorize(PERMISSIONS.VIEW_INVENTORY), listRules);
router.put('/alerts/rules/:alertType', authorize(PERMISSIONS.CONFIGURE_INVENTORY), updateRule);

// The notification feed is the caller's OWN, so it needs no permission beyond
// being signed in with inventory visibility — every query is scoped to req.user.
router.get('/alerts/notifications', authorize(PERMISSIONS.VIEW_INVENTORY), listNotifications);
router.post('/alerts/notifications/read', authorize(PERMISSIONS.VIEW_INVENTORY), markNotificationsRead);

router.get('/alerts', authorize(PERMISSIONS.VIEW_INVENTORY), listAlerts);
router.get('/alerts/:alertId', authorize(PERMISSIONS.VIEW_INVENTORY), getAlert);
router.post('/alerts/:alertId/acknowledge', authorize(PERMISSIONS.MANAGE_INVENTORY_MASTER, PERMISSIONS.APPROVE_ADJUSTMENT), acknowledgeAlert);
router.post('/alerts/:alertId/resolve', authorize(PERMISSIONS.MANAGE_INVENTORY_MASTER, PERMISSIONS.APPROVE_ADJUSTMENT), resolveAlert);
router.post('/alerts/:alertId/close', authorize(PERMISSIONS.MANAGE_INVENTORY_MASTER, PERMISSIONS.APPROVE_ADJUSTMENT), closeAlert);

// ── Import (M9) ───────────────────────────────────────────────────────────
// The route gate is "may import ANYTHING"; the controller then checks the
// permission for the specific type, which only it can see because the type
// arrives in the body. Same split as M7: route checks the permission, the
// layer below checks the record.
//
// Confirm is gated separately from upload. Uploading writes nothing to
// inventory — confirming is the request that posts to the ledger — so the two
// are distinct acts even though the same roles hold both today.
const MAY_IMPORT = [
  PERMISSIONS.MANAGE_INVENTORY_MASTER,
  PERMISSIONS.CONFIGURE_INVENTORY,
  PERMISSIONS.POST_STOCK_IN,
  PERMISSIONS.POST_STOCK_OUT,
  PERMISSIONS.ADJUST_STOCK,
  PERMISSIONS.PERFORM_COUNT,
];

router.get('/imports/types', authorize(...MAY_IMPORT), listImportTypes);
router.get('/imports/templates/:importType', authorize(...MAY_IMPORT), downloadTemplate);
router.get('/imports', authorize(PERMISSIONS.VIEW_INVENTORY), importHistory);
router.post('/imports', authorize(...MAY_IMPORT), uploadImportFile, handleUploadErrors, uploadImport);
router.get('/imports/:jobId', authorize(PERMISSIONS.VIEW_INVENTORY), importStatus);
router.get('/imports/:jobId/preview', authorize(PERMISSIONS.VIEW_INVENTORY), previewImport);
router.get('/imports/:jobId/errors', authorize(PERMISSIONS.VIEW_INVENTORY), importErrors);
// Answer the mandatory details — MOQ, lead time, safety factor, box number —
// for the NEW SKUs a staged import will create. Same permission as the import
// itself: whoever may create a SKU through a sheet is who must describe it, and
// the import cannot be confirmed until they have.
router.post('/imports/:jobId/new-skus', authorize(...MAY_IMPORT), setNewSkuDetailsHandler);
router.post('/imports/:jobId/confirm', authorize(...MAY_IMPORT), confirmImport);
// Answer the MOQ prompt for SKUs this import created. Same permission as the
// import itself — whoever may create a SKU may set the minimum it needs.
router.post('/imports/:jobId/moq', authorize(...MAY_IMPORT), setImportMoqHandler);
router.post('/imports/:jobId/resume', authorize(...MAY_IMPORT), resumeImport);
router.post('/imports/:jobId/cancel', authorize(...MAY_IMPORT), cancelImport);

// ── Export (M9) ───────────────────────────────────────────────────────────
// Read-only, so EXPORT_INVENTORY alone. Brand isolation is applied inside the
// service on top of whatever filter was requested — a brand filter can narrow
// the result but never widen it.
router.get('/exports/types', authorize(PERMISSIONS.EXPORT_INVENTORY), listExportTypes);
router.get('/exports/snapshot-runs', authorize(PERMISSIONS.EXPORT_INVENTORY), listExportRuns);
router.get('/exports/history', authorize(PERMISSIONS.EXPORT_INVENTORY), exportHistory);
router.get('/exports/:exportType', authorize(PERMISSIONS.EXPORT_INVENTORY), downloadExport);

// ── Locations ─────────────────────────────────────────────────────────────
// Readable by anyone who can see inventory (they pick a location on later
// screens); mutable only by whoever configures the system.
router.get('/locations', authorize(PERMISSIONS.VIEW_INVENTORY), listLocations);
router.post('/locations', authorize(PERMISSIONS.CONFIGURE_INVENTORY), createLocation);
router.patch('/locations/:id', authorize(PERMISSIONS.CONFIGURE_INVENTORY), updateLocation);
router.post(
  '/locations/:id/default',
  authorize(PERMISSIONS.CONFIGURE_INVENTORY),
  setDefaultLocation,
);

// ── Configuration ─────────────────────────────────────────────────────────
router.get('/config/history', authorize(PERMISSIONS.CONFIGURE_INVENTORY), getConfigHistory);
router.get('/config', authorize(PERMISSIONS.VIEW_INVENTORY), getConfig);
router.put('/config', authorize(PERMISSIONS.CONFIGURE_INVENTORY), updateConfig);

export default router;
