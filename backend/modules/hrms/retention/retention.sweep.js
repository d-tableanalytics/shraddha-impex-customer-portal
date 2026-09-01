/**
 * The scheduled retention sweep (AD-16).
 *
 * Reads the configured policy, runs the registered handler for each category
 * with an active window, and records ONE summary audit entry for the run.
 *
 * The APPLICATION is authoritative. The S3 lifecycle rule sits behind this at a
 * deliberately longer window, so it never pre-empts a policy change made in
 * Settings - it exists to guarantee an upper bound on orphans, nothing more.
 *
 * Runs on the daily cron already in server.js, beside runReservationExpiryChecks
 * and sweepUploads. No new infrastructure: Redis and BullMQ were dropped in
 * favour of node-cron for exactly this kind of work.
 */

import HrmsConfig from '../../../models/hrms/HrmsConfig.js';
import { getRetentionHandler, registeredRetentionCategories } from './retention.registry.js';
import { recordSystemAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS } from '../../../shared/constants/hrms.js';

/** Batch size. Configurable per AD-13; never a headcount-derived constant. */
const BATCH_SIZE = Number(process.env.HRMS_RETENTION_BATCH_SIZE ?? 500);

export const cutoffFor = (days, now = new Date()) =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

/**
 * Run the sweep.
 *
 * @param {object}  [options]
 * @param {boolean} [options.dryRun=false]  report what would happen, change nothing
 * @param {Date}    [options.now]           injectable for tests
 * @returns {Promise<{ ranAt, dryRun, results, skipped, totals }>}
 */
export async function runHrmsRetentionSweep({ dryRun = false, now = new Date() } = {}) {
  const config = await HrmsConfig.load();
  const active = config.activeRetentionRules();

  const results = [];
  const skipped = [];

  for (const { category, days, action } of active) {
    const handler = getRetentionHandler(category);

    if (!handler) {
      // Configured but not implemented. Reported rather than passed over in
      // silence - otherwise a category could look retained while nothing runs.
      skipped.push({
        category,
        days,
        action,
        reason: 'no retention handler is registered for this category',
      });
      continue;
    }

    const cutoff = cutoffFor(days, now);
    try {
      const outcome = await handler.sweep({ cutoff, action, dryRun, batchSize: BATCH_SIZE });
      results.push({ category, days, action, cutoff: cutoff.toISOString(), ...outcome });
    } catch (err) {
      // One category failing must not abort the rest of the run.
      results.push({
        category,
        days,
        action,
        cutoff: cutoff.toISOString(),
        error: err.message,
        scanned: 0,
        affected: 0,
      });
      console.error(`[HRMS retention] "${category}" failed:`, err.message);
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      scanned: acc.scanned + (r.scanned ?? 0),
      affected: acc.affected + (r.affected ?? 0),
      errors: acc.errors + (r.error ? 1 : 0),
    }),
    { scanned: 0, affected: 0, errors: 0 },
  );

  const summary = {
    ranAt: now.toISOString(),
    dryRun,
    results,
    skipped,
    totals,
    registeredCategories: registeredRetentionCategories(),
  };

  // ONE summary row per run, and it is exempt from its own window - see
  // RETENTION_EXEMPT_AUDIT_ACTIONS. Without that, the record of deletion would
  // itself be deleted three years later.
  if (!dryRun && (totals.affected > 0 || totals.errors > 0 || skipped.length > 0)) {
    await recordSystemAudit(
      AUDIT_ACTIONS.RETENTION_SWEEP,
      `Retention sweep: ${totals.affected} record(s) actioned across ${results.length} category(ies)` +
        (skipped.length ? `, ${skipped.length} skipped` : '') +
        (totals.errors ? `, ${totals.errors} error(s)` : ''),
      summary,
    );
  }

  return summary;
}

/**
 * Immediate purge for a single category, outside the schedule.
 *
 * Consent withdrawal (AD-15) needs this: withdrawal means erase NOW, not erase
 * eventually. Same deletion routine, different trigger - so the two can never
 * diverge in behaviour.
 */
export async function purgeCategoryNow(category, { filter, reason } = {}) {
  const handler = getRetentionHandler(category);
  if (!handler) {
    throw new Error(`purgeCategoryNow: no handler registered for "${category}"`);
  }
  if (typeof handler.purgeNow !== 'function') {
    throw new Error(`purgeCategoryNow: "${category}" does not support immediate purge`);
  }

  const outcome = await handler.purgeNow({ filter, batchSize: BATCH_SIZE });

  await recordSystemAudit(
    AUDIT_ACTIONS.RETENTION_SWEEP,
    `Immediate purge of ${category}: ${outcome.affected ?? 0} record(s). ${reason ?? ''}`.trim(),
    { category, reason: reason ?? null, immediate: true, ...outcome },
  );

  return outcome;
}

export default { runHrmsRetentionSweep, purgeCategoryNow, cutoffFor };
