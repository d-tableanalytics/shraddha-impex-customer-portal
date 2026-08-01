import { onEvent, EVENTS, listenerCounts } from '../../utils/eventBus.js';
import { ALERT_TYPES } from '../../models/InventoryAlert.js';
import { raiseAlert, clearAlert, evaluateSkus, loadRules } from './alert.service.js';

/**
 * Alert subscriptions (IMS Module M8).
 *
 * The ONLY place events are bound to alerts. Modules M1/M4/M6/M7 announce what
 * happened; nothing in them knows this file exists. That direction matters — the
 * alert engine reads the health projection Module M4 owns, so if M4 called the
 * alert engine directly the two would import each other.
 *
 * Every handler is best-effort. `onEvent` already catches and logs, so a failure
 * to raise an alert cannot fail the count, snapshot or booking that emitted the
 * event (BR-57).
 */

/** Guard against double subscription if this module is imported twice. */
let subscribed = false;

const ruleFor = async (alertType) => (await loadRules())(alertType);

export const subscribeAlerts = () => {
  if (subscribed) return listenerCounts();
  subscribed = true;

  // ── Stock health and planning ─────────────────────────────────────────────
  // Module M4 recomputed health for a set of SKUs. Scoped to exactly those
  // SKUs — the catalogue is never re-evaluated because one booking moved.
  onEvent(EVENTS.HEALTH_PROJECTED, ({ skuCodes, brand }) =>
    evaluateSkus(skuCodes, { brand }));

  // ── Operations ────────────────────────────────────────────────────────────
  onEvent(EVENTS.COUNT_SUBMITTED, async ({ countId, brand, locationCode, varianceLines, netVariance }) => {
    // Always raised: a submitted count is blocking until someone approves it,
    // and a count that sits unreviewed is the most common way physical stock
    // and system stock drift apart.
    await raiseAlert({
      alertType: 'COUNT_APPROVAL_PENDING',
      brand, locationCode,
      title: `Count ${countId} awaiting approval`,
      message:
        `Count ${countId} at ${locationCode} was submitted with ${varianceLines} variance line(s), ` +
        `net ${netVariance}. It cannot post until an approver reviews it.`,
      triggerSource: 'count',
      relatedEntityType: 'count',
      relatedEntityId: countId,
      metadata: { varianceLines, netVariance },
      rule: await ruleFor('COUNT_APPROVAL_PENDING'),
    });

    if (varianceLines > 0) {
      await raiseAlert({
        alertType: 'COUNT_VARIANCE_PENDING',
        brand, locationCode,
        title: `Count ${countId} has ${varianceLines} variance(s)`,
        message:
          `Physical stock did not match system stock on ${varianceLines} line(s) at ${locationCode} ` +
          `(net ${netVariance}). Nothing has been corrected — approving the count posts the ` +
          `adjustment to the ledger.`,
        triggerSource: 'count',
        relatedEntityType: 'count',
        relatedEntityId: countId,
        metadata: { varianceLines, netVariance },
        rule: await ruleFor('COUNT_VARIANCE_PENDING'),
      });
    }
  });

  // Approval, rejection and posting all end the "waiting on a human" condition,
  // so both count alerts clear. Resolving on rejection matters as much as on
  // approval — otherwise a rejected count leaves a permanent alert for a
  // decision that has already been taken.
  const clearCountAlerts = async ({ countId, brand, locationCode }, note) => {
    for (const alertType of ['COUNT_APPROVAL_PENDING', 'COUNT_VARIANCE_PENDING']) {
      await clearAlert({ alertType, brand, locationCode, relatedEntityId: countId, note });
    }
  };

  onEvent(EVENTS.COUNT_APPROVED, (p) => clearCountAlerts(p, `Count ${p.countId} was approved.`));
  onEvent(EVENTS.COUNT_REJECTED, (p) =>
    clearCountAlerts(p, `Count ${p.countId} was rejected: ${p.reason || 'no reason given'}.`));
  onEvent(EVENTS.COUNT_POSTED, async (p) => {
    await clearCountAlerts(p, `Count ${p.countId} posted as ${p.adjustmentId}.`);
    // Posting changed balances, so health moved for the counted SKUs. M4's own
    // recompute emits HEALTH_PROJECTED, so stock-health alerts are re-evaluated
    // through the normal path — nothing extra is needed here.
  });

  onEvent(EVENTS.OVERSOLD_RAISED, async ({ countId, skuCode, brand, onHand, reserved, shortfall, exceptionId, affectedBookings }) => {
    // Critical and immediate by default: stock has been promised to customers
    // that physically is not there. Every hour this goes unseen is another hour
    // of orders being taken against it.
    await raiseAlert({
      alertType: 'OVERSOLD_EXCEPTION',
      skuCode, brand,
      title: `Oversold: ${skuCode}`,
      message:
        `${skuCode} has ${reserved} unit(s) reserved against ${onHand} on hand — a shortfall of ` +
        `${Math.abs(shortfall)}. ${affectedBookings} booking(s) are affected. Raised by count ${countId}.`,
      triggerSource: 'count',
      relatedEntityType: 'oversold',
      relatedEntityId: exceptionId,
      metadata: { countId, onHand, reserved, shortfall, affectedBookings },
      rule: await ruleFor('OVERSOLD_EXCEPTION'),
    });
  });

  // ── Snapshots ─────────────────────────────────────────────────────────────
  onEvent(EVENTS.SNAPSHOT_FAILED, async ({ runId, snapshotDate, scopeBrand, error }) => {
    await raiseAlert({
      alertType: 'SNAPSHOT_FAILURE',
      brand: scopeBrand || null,
      title: `Snapshot ${runId} failed`,
      message:
        `The inventory snapshot for ${new Date(snapshotDate).toISOString().slice(0, 10)}` +
        `${scopeBrand ? ` (${scopeBrand})` : ''} did not complete: ${error}. ` +
        `History for that date is missing until the run is repeated.`,
      triggerSource: 'snapshot',
      relatedEntityType: 'snapshotRun',
      relatedEntityId: runId,
      metadata: { snapshotDate, error },
      rule: await ruleFor('SNAPSHOT_FAILURE'),
    });
  });

  onEvent(EVENTS.SNAPSHOT_COMPLETED, async ({ runId, snapshotDate, scopeBrand, rowCount, skuCount, missingHealthCount }) => {
    // A successful run resolves any failure alert for the same scope. The
    // dedupe key is per run id, so this clears the run that actually failed
    // rather than every snapshot alert.
    await clearAlert({
      alertType: 'SNAPSHOT_FAILURE',
      brand: scopeBrand || null,
      relatedEntityId: runId,
      note: `Snapshot ${runId} completed with ${rowCount} row(s).`,
    });

    // Not a failure, but worth recording: rows were written from health data
    // that could not be found, so those SKUs are in the snapshot with no band.
    if (missingHealthCount > 0) {
      await raiseAlert({
        alertType: 'PROJECTION_FAILURE',
        brand: scopeBrand || null,
        title: `Snapshot ${runId}: ${missingHealthCount} SKU(s) without health`,
        message:
          `Snapshot ${runId} for ${new Date(snapshotDate).toISOString().slice(0, 10)} captured ` +
          `${skuCount} SKU(s), of which ${missingHealthCount} had no health projection and were ` +
          `stored without a band. Rebuilding health and re-running the snapshot will fill them in.`,
        triggerSource: 'snapshot',
        relatedEntityType: 'snapshotRun',
        relatedEntityId: runId,
        metadata: { rowCount, skuCount, missingHealthCount },
        rule: await ruleFor('PROJECTION_FAILURE'),
      });
    }
  });

  // ── Projections ───────────────────────────────────────────────────────────
  onEvent(EVENTS.PROJECTION_FAILED, async ({ projection, scope, error }) => {
    await raiseAlert({
      alertType: 'PROJECTION_FAILURE',
      brand: scope?.brand || null,
      title: `${projection} projection failed`,
      message:
        `The ${projection} projection could not be updated: ${error}. Figures on the dashboard and ` +
        `health screen may be stale until it is rebuilt.`,
      triggerSource: 'system',
      relatedEntityType: 'projection',
      relatedEntityId: projection,
      metadata: { scope, error },
      rule: await ruleFor('PROJECTION_FAILURE'),
    });
  });

  onEvent(EVENTS.PROJECTION_REBUILT, async ({ projection, scope, processed, changed, bandCounts }) => {
    // Informational, and deliberately not silent: a rebuild reclassifies SKUs
    // in bulk, so someone looking at a band count that moved overnight needs a
    // record of why.
    await raiseAlert({
      alertType: 'PROJECTION_REBUILD_COMPLETED',
      brand: scope?.brand || null,
      title: `${projection} projection rebuilt`,
      message:
        `Rebuilt ${projection} for ${processed} SKU(s)` +
        `${scope?.brand ? ` in ${scope.brand}` : ''}. ${changed} band(s) changed.`,
      triggerSource: 'system',
      relatedEntityType: 'projection',
      relatedEntityId: `${projection}-rebuild`,
      metadata: { scope, processed, changed, bandCounts },
      rule: await ruleFor('PROJECTION_REBUILD_COMPLETED'),
    });

    // A successful rebuild clears the failure alert for the same projection.
    await clearAlert({
      alertType: 'PROJECTION_FAILURE',
      brand: scope?.brand || null,
      relatedEntityId: projection,
      note: `${projection} rebuilt successfully for ${processed} SKU(s).`,
    });
  });

  // ── Configuration ─────────────────────────────────────────────────────────
  onEvent(EVENTS.CONFIG_UPDATED, async ({ scope, scopeValue, configId, formulaVersion, formulaChanged, previousFormulaVersion, changeNote, updatedBy }) => {
    const scopeLabel = scopeValue ? `${scope} "${scopeValue}"` : 'global';

    if (formulaChanged) {
      // Higher severity than an ordinary config edit, because it changes how
      // every SKU's target is calculated — the same stock reclassifies without
      // a single unit moving. Anyone comparing to last week's figures needs to
      // know the definition changed under them.
      await raiseAlert({
        alertType: 'FORMULA_VERSION_CHANGED',
        title: `Max Level formula changed to ${formulaVersion}`,
        message:
          `The stock target formula for ${scopeLabel} moved from ${previousFormulaVersion} to ` +
          `${formulaVersion} (by ${updatedBy}). Every SKU in scope has been reclassified. ` +
          `${changeNote ? `Note: ${changeNote}` : ''}`.trim(),
        triggerSource: 'config',
        relatedEntityType: 'config',
        relatedEntityId: configId,
        metadata: { scope, scopeValue, formulaVersion, previousFormulaVersion },
        rule: await ruleFor('FORMULA_VERSION_CHANGED'),
      });
    } else {
      await raiseAlert({
        alertType: 'CONFIGURATION_UPDATED',
        title: `Inventory configuration updated (${scopeLabel})`,
        message:
          `Inventory configuration for ${scopeLabel} was updated by ${updatedBy}. ` +
          `Health is being recalculated for the affected scope. ` +
          `${changeNote ? `Note: ${changeNote}` : ''}`.trim(),
        triggerSource: 'config',
        relatedEntityType: 'config',
        relatedEntityId: configId,
        metadata: { scope, scopeValue },
        rule: await ruleFor('CONFIGURATION_UPDATED'),
      });
    }
  });

  const counts = listenerCounts();
  console.log(
    `[AlertEngine] Subscribed to ${Object.values(counts).filter(Boolean).length} event(s); ` +
    `${Object.keys(ALERT_TYPES).length} alert type(s) registered.`,
  );
  return counts;
};

export default { subscribeAlerts };
