import InventoryAlert, {
  ALERT_TYPES, ALERT_TYPE_NAMES, ALERT_TRANSITIONS,
} from '../../models/InventoryAlert.js';
import AlertRule from '../../models/AlertRule.js';
import StockHealth from '../../models/StockHealth.js';
import Notification from '../../models/Notification.js';
import User from '../../models/User.js';
import { nextSequence, nextSequenceBlock } from '../../models/Counter.js';
import { recordAudit } from '../../utils/auditLog.js';
import { isDuplicateKeyError } from '../../utils/mongoSession.js';
import { emitEvent, EVENTS } from '../../utils/eventBus.js';

/**
 * Alert Engine (IMS Module M8).
 *
 * A CONSUMER, not a calculator. It reads the band, the plannable flag and the
 * percentages that Module M4 already computed, and decides only whether anyone
 * should be told. It never derives a Max Level, a percentage, a coverage figure
 * or a balance — if a value is not already in a projection, no alert can be
 * raised on it.
 *
 * DEDUPLICATION AND TRANSITION-FIRING ARE THE SAME MECHANISM
 * ----------------------------------------------------------
 * One ACTIVE alert per (type, sku, brand, location), enforced by a partial
 * unique index. Evaluation then reduces to three cases:
 *
 *   condition true,  no active alert  →  CREATE   (this IS the transition)
 *   condition true,  active alert     →  TOUCH    (occurrence++, no new alert)
 *   condition false, active alert     →  RESOLVE  (auto)
 *
 * Firing on transition rather than state falls out of this for free. Without
 * it, every SKU sitting in the Critical band would alert on every evaluation —
 * 97 notifications an hour, muted within a week, after which the system is
 * worse than silent because everyone believes it is working.
 */

// ─── Rules ───────────────────────────────────────────────────────────────────

/** Rules cached per evaluation run — one query, not one per SKU. */
export const loadRules = async () => {
  const rows = await AlertRule.find({}).lean();
  const byType = new Map(rows.map((r) => [r.alertType, r]));
  // A type with no stored rule falls back to its declared default, so a newly
  // added alert type works before anyone configures it.
  return (alertType) => {
    const stored = byType.get(alertType);
    const spec = ALERT_TYPES[alertType];
    return {
      alertType,
      enabled: stored?.enabled ?? true,
      severity: stored?.severity || spec.severity,
      delivery: stored?.delivery || 'digest',
      cooldownHours: stored?.cooldownHours ?? 24,
      notifyRoles: stored?.notifyRoles?.length ? stored.notifyRoles : ['Admin', 'Inventory Manager'],
    };
  };
};

const dedupeKeyFor = ({ alertType, skuCode, brand, locationCode, relatedEntityId }) =>
  [alertType, skuCode ?? '', brand ?? '', locationCode ?? '', relatedEntityId ?? ''].join('::');

// ─── Raising and clearing ────────────────────────────────────────────────────

/**
 * Raise an alert, or touch the existing one.
 *
 * Never throws. An alert is a side-effect of business activity, never a
 * precondition for it — a failure here must not fail the stock operation that
 * triggered it (BR-57).
 */
export const raiseAlert = async ({
  alertType, skuCode = null, brand = null, location = null, locationCode = null,
  title, message, triggerSource, snapshot = null,
  relatedEntityType = null, relatedEntityId = null, metadata = null,
  rule = null, actor = null,
}) => {
  try {
    const spec = ALERT_TYPES[alertType];
    if (!spec) return { ok: false, error: `Unknown alert type ${alertType}` };

    const resolved = rule || {
      enabled: true, severity: spec.severity, delivery: 'digest',
      cooldownHours: 24, notifyRoles: ['Admin', 'Inventory Manager'],
    };
    if (!resolved.enabled) return { ok: true, skipped: 'rule-disabled' };

    const dedupeKey = dedupeKeyFor({ alertType, skuCode, brand, locationCode, relatedEntityId });
    const now = new Date();

    // Touch first: the common case is a condition that is still true.
    //
    // This path always increments, because it is reached from a DISCRETE event
    // — a count submitted, an oversold exception raised. Each call really is a
    // fresh occurrence. The projection sweep in evaluateSkus increments more
    // conservatively, because there every pass would otherwise count as one.
    const touched = await InventoryAlert.findOneAndUpdate(
      { dedupeKey, active: true },
      { $inc: { occurrences: 1 }, $set: { lastSeenAt: now, message } },
      { new: true },
    );
    if (touched) {
      return { ok: true, alertId: touched.alertId, action: 'touched', occurrences: touched.occurrences };
    }

    const year = now.getFullYear();
    const seq = await nextSequence(`alert-${year}`);
    const alertId = `ALT-${year}-${String(seq).padStart(6, '0')}`;

    let alert;
    try {
      alert = await InventoryAlert.create({
        alertId,
        alertType,
        category: spec.category,
        severity: resolved.severity,
        skuCode, brand, location, locationCode,
        dedupeKey,
        active: true,
        title, message, triggerSource, snapshot,
        relatedEntityType, relatedEntityId, metadata,
        status: 'Open',
        firstSeenAt: now,
        lastSeenAt: now,
      });
    } catch (error) {
      // Lost a race against a concurrent evaluation — the winner's alert is
      // authoritative, so treat it as a touch.
      if (isDuplicateKeyError(error)) {
        const winner = await InventoryAlert.findOneAndUpdate(
          { dedupeKey, active: true },
          { $inc: { occurrences: 1 }, $set: { lastSeenAt: now } },
          { new: true },
        );
        if (winner) return { ok: true, alertId: winner.alertId, action: 'touched' };
      }
      throw error;
    }

    await deliver(alert, resolved);

    await recordAudit(actor, 'Inventory Alert Raised',
      `${spec.label} raised${skuCode ? ` for ${skuCode}` : ''}: ${title}`,
      null, { meta: { alertId, alertType, skuCode, brand, severity: resolved.severity, relatedEntityId } });

    return { ok: true, alertId, action: 'created' };
  } catch (error) {
    console.error(`[AlertEngine] Failed to raise ${alertType}:`, error.message);
    return { ok: false, error: error.message };
  }
};

/**
 * Auto-resolve an active alert because its condition cleared.
 *
 * `active` is unset rather than set false, which releases the partial unique
 * index so a recurrence can raise a genuinely new alert with its own timestamps
 * — rather than reopening the old one and losing the distinction between "still
 * broken" and "broke again".
 */
export const clearAlert = async ({ alertType, skuCode = null, brand = null, locationCode = null, relatedEntityId = null, note = null }) => {
  try {
    const dedupeKey = dedupeKeyFor({ alertType, skuCode, brand, locationCode, relatedEntityId });
    const cleared = await InventoryAlert.findOneAndUpdate(
      { dedupeKey, active: true },
      {
        $set: {
          status: 'Resolved',
          resolvedAt: new Date(),
          autoResolved: true,
          resolutionNote: note || 'Condition no longer met.',
        },
        $unset: { active: '' },
      },
      { new: true },
    );
    return cleared ? { ok: true, alertId: cleared.alertId, action: 'resolved' } : { ok: true, action: 'none' };
  } catch (error) {
    console.error(`[AlertEngine] Failed to clear ${alertType}:`, error.message);
    return { ok: false, error: error.message };
  }
};

// ─── Delivery ────────────────────────────────────────────────────────────────

/**
 * Push an alert to the people who should see it.
 *
 * In-app is the ONLY live channel. Email and webhook are declared in the schema
 * and recorded as `skipped` so enabling one later is a delivery change, not a
 * data-model change — and so an operator can see that a channel exists but is
 * not switched on, rather than wondering why nothing arrived.
 *
 * Notifications are written to the EXISTING `notifications` collection rather
 * than a parallel store, so alerts appear in the same bell as everything else.
 * A second feed would mean users seeing half their notifications in each.
 */
const deliver = async (alert, rule) => {
  const deliveries = [];
  const now = new Date();

  try {
    if (rule.delivery === 'silent') {
      deliveries.push({ channel: 'in-app', status: 'skipped', at: now, reason: 'rule is silent' });
    } else if (rule.delivery === 'digest') {
      // Recorded and visible in the alert list, but not pushed. This is the
      // default for stock-health alerts precisely because they are numerous.
      deliveries.push({ channel: 'in-app', status: 'skipped', at: now, reason: 'digest delivery' });
    } else {
      // BR-56 — cooldown. The alert exists regardless; only the push is gated.
      const cutoff = new Date(now.getTime() - rule.cooldownHours * 3_600_000);
      const recent = await InventoryAlert.findOne({
        alertType: alert.alertType,
        skuCode: alert.skuCode,
        brand: alert.brand,
        lastNotifiedAt: { $gte: cutoff },
        _id: { $ne: alert._id },
      }).lean();

      if (recent) {
        deliveries.push({ channel: 'in-app', status: 'skipped', at: now, reason: 'within cooldown' });
      } else {
        const recipients = await User.find(
          { role: { $in: rule.notifyRoles }, status: 'Active' },
          '_id',
        ).lean();

        if (recipients.length) {
          const docs = recipients.map((u) => ({
            user: u._id,
            title: alert.title,
            message: alert.message,
            // The 'inventory' type has existed on the Notification schema since
            // the beginning and had never been emitted by anything. This is it.
            type: 'inventory',
          }));
          const created = await Notification.insertMany(docs);

          // Announced on the bus rather than pushed to a socket here. The
          // socket bridge lives in server.js, so this module never imports the
          // HTTP layer — the inverted dependency the audit found in
          // utils/notify.js is not repeated.
          emitEvent(EVENTS.NOTIFICATION_CREATED, {
            alertId: alert.alertId,
            severity: alert.severity,
            notifications: created.map((n) => ({ id: String(n._id), user: String(n.user) })),
            title: alert.title,
            message: alert.message,
          });
        }

        deliveries.push({ channel: 'in-app', status: 'sent', recipients: recipients.length, at: now });
        await InventoryAlert.updateOne({ _id: alert._id }, { $set: { lastNotifiedAt: now } });
      }
    }

    // Declared but not enabled — visible in the delivery record so nobody has
    // to guess whether an email was attempted.
    deliveries.push({ channel: 'email', status: 'skipped', at: now, reason: 'channel not enabled' });
    deliveries.push({ channel: 'webhook', status: 'skipped', at: now, reason: 'channel not enabled' });
  } catch (error) {
    deliveries.push({ channel: 'in-app', status: 'failed', at: now, reason: error.message });
    console.error(`[AlertEngine] Delivery failed for ${alert.alertId}:`, error.message);
  }

  await InventoryAlert.updateOne({ _id: alert._id }, { $set: { deliveries } }).catch(() => {});
};

// ─── Health rule evaluation ──────────────────────────────────────────────────

/**
 * Which alert a health band implies. Pure lookup — the band was decided by M4.
 *
 * BR-54: a SKU in the Unknown band raises a PLANNING alert, never a stock-health
 * one. Alerting "critically low" on a SKU whose target cannot even be computed
 * would be false, and at ~90% of the catalogue it would drown everything real.
 */
const BAND_ALERTS = {
  'Out of Stock': 'OUT_OF_STOCK',
  Critical: 'CRITICAL_STOCK',
  Low: 'LOW_STOCK',
  Overstock: 'OVERSTOCK',
  Healthy: null,
  Unknown: null,
};

/** Which planning alert a not-plannable reason implies. */
const REASON_ALERTS = {
  NO_LEAD_TIME: 'MISSING_LEAD_TIME',
  NO_CONSUMPTION: 'MISSING_CONSUMPTION',
  NO_SAFETY_FACTOR: 'MISSING_PLANNING_DATA',
  NOT_ACTIVE: null,
  NO_BALANCE: null,
};

const STOCK_HEALTH_TYPES = ['OUT_OF_STOCK', 'CRITICAL_STOCK', 'LOW_STOCK', 'OVERSTOCK'];
const PLANNING_TYPES = ['UNKNOWN_HEALTH', 'MISSING_LEAD_TIME', 'MISSING_CONSUMPTION', 'MISSING_PLANNING_DATA'];

const HEALTH_TYPES = [...STOCK_HEALTH_TYPES, ...PLANNING_TYPES];

/**
 * How long a live alert may go without a `lastSeenAt` refresh.
 *
 * Long enough that a rebuild does not rewrite the whole alert set, short enough
 * that "last seen 3 days ago" on an Open alert means the condition really has
 * not been re-observed rather than that nobody bothered to stamp it.
 */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** Which alerts a health row implies. Pure — no I/O, no arithmetic on stock. */
const wantedFor = (h) => {
  const wanted = new Set();

  if (h.plannable) {
    // BR-54 — a SKU whose target cannot be computed gets a planning alert, not
    // a stock-health one. "Critically low" against an unknown target is a
    // statement nobody can act on.
    const band = BAND_ALERTS[h.band];
    if (band) wanted.add(band);
  } else {
    // A specific reason alert names the missing input — "no daily consumption"
    // — and is strictly more useful than UNKNOWN_HEALTH, which only repeats
    // that the SKU cannot be planned. Raising both put the SAME 7,924 SKUs into
    // two alerts apiece: 15,848 rows carrying one fact, which buried the 621
    // real stock-health alerts underneath them.
    //
    // UNKNOWN_HEALTH is now the FALLBACK, for a reason with no specific alert
    // type mapped, so nothing unplannable goes unreported.
    let specific = 0;
    for (const reason of h.notPlannableReasons || []) {
      const type = REASON_ALERTS[reason];
      if (type) { wanted.add(type); specific += 1; }
    }
    if (specific === 0) wanted.add('UNKNOWN_HEALTH');
  }
  return wanted;
};

/** The message an alert carries. Every figure is copied from the projection. */
const describe = (type, h) => {
  if (PLANNING_TYPES.includes(type)) {
    const reasons = (h.notPlannableReasons || []).join(', ') || 'planning inputs';
    return `${h.skuCode} (${h.brand}) cannot be planned — no stock target can be calculated. Missing: ${reasons}.`;
  }
  return (
    `${h.skuCode} (${h.brand}) is ${h.band}` +
    (h.replenishmentPercent !== null && h.replenishmentPercent !== undefined
      ? ` at ${Math.round(h.replenishmentPercent * 10) / 10}% of target` : '') +
    `. On hand ${h.onHand}` +
    (h.coverageDays !== null && h.coverageDays !== undefined
      ? `, ${Math.round(h.coverageDays)} days of cover` : '') + '.'
  );
};

/** The full alert payload for a health condition. Shared by both create paths. */
const healthAlertPayload = (alertType, h) => ({
  alertType,
  skuCode: h.skuCode,
  brand: h.brand,
  title: `${ALERT_TYPES[alertType].label}: ${h.skuCode}`,
  message: describe(alertType, h),
  triggerSource: 'health-projection',
  // Projection values AS THEY WERE. Copied, never computed, never refreshed —
  // so the alert still explains itself after the stock has moved on.
  snapshot: {
    band: h.band,
    onHand: h.onHand,
    available: h.available,
    maxLevel: h.maxLevel,
    reorderLevel: h.reorderLevel,
    replenishmentPercent: h.replenishmentPercent,
    coverageDays: h.coverageDays,
    plannable: h.plannable,
    computedAt: h.computedAt,
  },
  relatedEntityType: 'sku',
});

/**
 * Write a batch of non-immediate alerts in one insert.
 *
 * Ids come from a single contiguous sequence block rather than one $inc per
 * alert, and the whole batch produces ONE audit entry rather than thousands —
 * an eight-thousand-row audit burst is itself noise, and it would bury the
 * human actions the trail exists to record.
 *
 * Duplicate keys are expected, not exceptional: a concurrent evaluation may
 * have raised the same condition first. Those rows are dropped and the winner
 * stands.
 */
const createInBulk = async (items, now, actor) => {
  try {
    const seqs = await nextSequenceBlock(`alert-${now.getFullYear()}`, items.length);
    const year = now.getFullYear();

    const docs = items.map((item, i) => {
      const payload = healthAlertPayload(item.alertType, item.health);
      const spec = ALERT_TYPES[item.alertType];
      return {
        ...payload,
        alertId: `ALT-${year}-${String(seqs[i]).padStart(6, '0')}`,
        category: spec.category,
        severity: item.rule.severity,
        location: null,
        locationCode: null,
        relatedEntityId: null,
        metadata: null,
        dedupeKey: dedupeKeyFor({ alertType: item.alertType, skuCode: item.health.skuCode, brand: item.health.brand }),
        active: true,
        status: 'Open',
        occurrences: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        lastNotifiedAt: null,
        deliveries: [
          {
            channel: 'in-app',
            status: 'skipped',
            at: now,
            reason: item.rule.delivery === 'silent' ? 'rule is silent' : 'digest delivery',
          },
          { channel: 'email', status: 'skipped', at: now, reason: 'channel not enabled' },
          { channel: 'webhook', status: 'skipped', at: now, reason: 'channel not enabled' },
        ],
        createdAt: now,
        updatedAt: now,
      };
    });

    let inserted = 0;
    try {
      const result = await InventoryAlert.collection.insertMany(docs, { ordered: false });
      inserted = result.insertedCount;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      inserted = error.result?.insertedCount ?? error.insertedCount ?? 0;
    }

    if (inserted > 0) {
      const byType = {};
      for (const item of items) byType[item.alertType] = (byType[item.alertType] || 0) + 1;
      await recordAudit(actor, 'Inventory Alerts Raised',
        `${inserted} alert(s) raised from the health projection: ` +
        Object.entries(byType).map(([t, n]) => `${ALERT_TYPES[t].label} ×${n}`).join(', ') + '.',
        null, { meta: { count: inserted, byType, sample: docs.slice(0, 20).map((d) => d.alertId) } });
    }

    return inserted;
  } catch (error) {
    console.error('[AlertEngine] Bulk raise failed:', error.message);
    return 0;
  }
};

/**
 * Evaluate alert rules for specific SKUs. THE INCREMENTAL PATH.
 *
 * Called when Module M4 announces that health was recomputed. Scoped to the
 * SKUs that actually changed — the catalogue is never scanned after a stock
 * movement.
 *
 * WORKS AS A DIFF, NOT AS A LOOP OF WRITES.
 *
 * The obvious shape — for each SKU, for each of the eight health alert types,
 * ask the database what to do — costs eight round trips per SKU. A catalogue
 * rebuild touches ~8,600 SKUs, so that is roughly 69,000 sequential writes for
 * a pass whose usual answer is "nothing changed".
 *
 * Instead: read every active alert for the SKU set once, compare it against
 * what the projection now implies, and issue writes only where the two differ.
 * In the steady state that is two reads and nothing else. Only genuinely NEW
 * alerts go through raiseAlert one at a time, because each needs an id, a rule
 * lookup and a delivery decision.
 */
export const evaluateSkus = async (skuCodes, { brand = null, actor = null } = {}) => {
  try {
    const skus = [...new Set((skuCodes || []).filter(Boolean))];
    if (skus.length === 0) return { evaluated: 0, created: 0, touched: 0, resolved: 0 };

    const ruleFor = await loadRules();

    const rows = await StockHealth.find({
      skuCode: { $in: skus },
      ...(brand ? { brand } : {}),
    }).lean();
    if (rows.length === 0) return { evaluated: 0, created: 0, touched: 0, resolved: 0 };

    // Every live health alert for these SKUs, in one query. `message` comes
    // along so an unchanged alert can be recognised without a write.
    const live = await InventoryAlert.find(
      { skuCode: { $in: rows.map((r) => r.skuCode) }, alertType: { $in: HEALTH_TYPES }, active: true },
      'alertId alertType skuCode brand dedupeKey message lastSeenAt',
    ).lean();
    const liveByKey = new Map(live.map((a) => [a.dedupeKey, a]));

    const now = new Date();
    const toTouch = [];
    const toResolve = [];
    const toCreate = [];

    for (const h of rows) {
      const wanted = wantedFor(h);

      for (const alertType of HEALTH_TYPES) {
        const dedupeKey = dedupeKeyFor({ alertType, skuCode: h.skuCode, brand: h.brand });
        const existing = liveByKey.get(dedupeKey);

        if (wanted.has(alertType)) {
          if (!existing) {
            toCreate.push({ alertType, health: h });
          } else {
            // An unchanged alert is left alone. Writing to every live alert on
            // every pass would mean 8,000 writes each time a threshold is
            // edited, and it would inflate `occurrences` with re-evaluations
            // rather than re-observations — turning the one number that
            // distinguishes a persistent problem from a noisy rule into a count
            // of how often the job ran.
            const message = describe(alertType, h);
            if (message !== existing.message) {
              toTouch.push({ dedupeKey, message, changed: true });
            } else if (!existing.lastSeenAt || now - new Date(existing.lastSeenAt) > STALE_AFTER_MS) {
              // Still true and still worded the same, but it has been a while.
              // A heartbeat, so "last seen" does not go stale on a condition
              // that is very much still live.
              toTouch.push({ dedupeKey, message, changed: false });
            }
          }
        } else if (existing) {
          toResolve.push({
            dedupeKey,
            note: h.plannable ? `Band is now ${h.band}.` : 'Planning inputs are now present.',
          });
        }
        // Not wanted, not live — the overwhelmingly common case, and it costs
        // nothing.
      }
    }

    // ── Still true: bump the counter, refresh the wording ──────────────────
    // `occurrences` rises only where the observed values actually moved, so it
    // stays a measure of the condition rather than of the scheduler.
    if (toTouch.length) {
      await InventoryAlert.bulkWrite(
        toTouch.map((t) => ({
          updateOne: {
            filter: { dedupeKey: t.dedupeKey, active: true },
            update: {
              ...(t.changed ? { $inc: { occurrences: 1 } } : {}),
              $set: { lastSeenAt: now, message: t.message },
            },
          },
        })),
        { ordered: false },
      );
    }

    // ── No longer true: auto-resolve ───────────────────────────────────────
    // `active` is unset rather than set false, releasing the partial unique
    // index so a recurrence raises a genuinely new alert.
    if (toResolve.length) {
      await InventoryAlert.bulkWrite(
        toResolve.map((r) => ({
          updateOne: {
            filter: { dedupeKey: r.dedupeKey, active: true },
            update: {
              $set: { status: 'Resolved', resolvedAt: now, autoResolved: true, resolutionNote: r.note },
              $unset: { active: '' },
            },
          },
        })),
        { ordered: false },
      );
    }

    // ── Newly true: raise ──────────────────────────────────────────────────
    // Split by delivery. Only `immediate` alerts need the full single-alert
    // path — a cooldown lookup, recipient resolution and a notification write.
    // Everything else is recorded and read on the alert screen, so it can be
    // written in bulk.
    //
    // This split is what makes a first-ever rebuild survivable. Most of the
    // catalogue has no planning data yet, so the opening pass raises thousands
    // of Planning alerts at once; at five round trips each that pass does not
    // finish. In bulk it is three operations regardless of volume.
    const bulk = [];
    const individually = [];
    for (const item of toCreate) {
      const rule = ruleFor(item.alertType);
      if (!rule.enabled) continue;
      (rule.delivery === 'immediate' ? individually : bulk).push({ ...item, rule });
    }

    let created = 0;
    for (const { alertType, health, rule } of individually) {
      const r = await raiseAlert({ ...healthAlertPayload(alertType, health), rule, actor });
      if (r.action === 'created') created++;
    }

    if (bulk.length) {
      created += await createInBulk(bulk, now, actor);
    }

    return { evaluated: rows.length, created, touched: toTouch.length, resolved: toResolve.length };
  } catch (error) {
    console.error('[AlertEngine] Evaluation failed:', error.message);
    return { evaluated: 0, error: error.message };
  }
};

// ─── Lifecycle actions ───────────────────────────────────────────────────────

const assertTransition = (from, to) => {
  const allowed = ALERT_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    const err = new Error(
      `An alert in "${from}" cannot move to "${to}".` +
      (allowed.length ? ` Allowed: ${allowed.join(', ')}.` : ' It is closed and cannot be reopened.'),
    );
    err.status = 409;
    err.code = 'INVALID_TRANSITION';
    throw err;
  }
};

export const transitionAlert = async ({ alertId, to, note = null, actor, req }) => {
  const alert = await InventoryAlert.findOne({ alertId });
  if (!alert) {
    const err = new Error(`Alert ${alertId} not found.`);
    err.status = 404;
    throw err;
  }
  const from = alert.status;
  assertTransition(from, to);

  const now = new Date();
  alert.status = to;
  if (to === 'Acknowledged') {
    alert.acknowledgedBy = actor._id;
    alert.acknowledgedAt = now;
  } else if (to === 'Resolved') {
    alert.resolvedBy = actor._id;
    alert.resolvedAt = now;
    alert.autoResolved = false;
    alert.resolutionNote = note;
    // Releases the dedup key — a recurrence raises a NEW alert.
    alert.active = undefined;
  } else if (to === 'Closed') {
    alert.closedBy = actor._id;
    alert.closedAt = now;
    alert.resolutionNote = note ?? alert.resolutionNote;
    alert.active = undefined;
  }
  await alert.save();

  await recordAudit(actor, `Inventory Alert ${to}`,
    `Alert ${alertId} (${alert.alertType}) marked ${to}${note ? `: ${note}` : ''}.`,
    req, { meta: { alertId, alertType: alert.alertType, from, to, note } });

  return alert.toObject();
};

export { ALERT_TYPE_NAMES };
export default { raiseAlert, clearAlert, evaluateSkus, transitionAlert, loadRules };
