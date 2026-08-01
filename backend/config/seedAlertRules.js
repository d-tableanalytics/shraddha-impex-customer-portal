import AlertRule from '../models/AlertRule.js';
import { ALERT_TYPES, ALERT_TYPE_NAMES } from '../models/InventoryAlert.js';

/**
 * Seeds default alert rules (Module M8).
 *
 * Idempotent per type: an existing rule is never touched, so a restart cannot
 * undo a threshold someone has tuned. A newly declared alert type is seeded on
 * the next boot without disturbing the rest.
 *
 * DELIVERY DEFAULTS ARE THE IMPORTANT DECISION HERE.
 *
 * Almost everything defaults to `digest` — recorded, visible in the alert list,
 * not pushed. Only conditions that genuinely warrant interrupting someone are
 * `immediate`: stock promised but absent, a projection that has stopped
 * updating, a snapshot that did not run, a formula change that reclassified the
 * catalogue.
 *
 * The alternative — pushing every Critical-band SKU — produces hundreds of
 * notifications on this catalogue. They get muted within a week, and a muted
 * alert system is worse than none, because everyone believes it is working.
 */
const DEFAULTS = {
  // ── Stock health — recorded, reviewed on the alert screen ────────────────
  // Out of Stock is immediate: a SKU at zero is already costing orders, and
  // there are few enough of them at any moment for the push to stay meaningful.
  OUT_OF_STOCK: { delivery: 'immediate', cooldownHours: 12, notifyRoles: ['Admin', 'Inventory Manager', 'Sales'] },
  CRITICAL_STOCK: { delivery: 'digest', cooldownHours: 24, notifyRoles: ['Admin', 'Inventory Manager'] },
  LOW_STOCK: { delivery: 'digest', cooldownHours: 48, notifyRoles: ['Admin', 'Inventory Manager'] },
  // Overstock is capital sitting still, not an emergency. Weekly is enough.
  OVERSTOCK: { delivery: 'digest', cooldownHours: 168, notifyRoles: ['Admin', 'Inventory Manager'] },

  // ── Planning — a backlog, not an incident ───────────────────────────────
  // These will fire in bulk on day one, because most of the catalogue has no
  // consumption or lead-time data yet. Digest at a week keeps them as a work
  // list to grind down rather than a wall of notifications.
  UNKNOWN_HEALTH: { delivery: 'digest', cooldownHours: 168, notifyRoles: ['Admin', 'Inventory Manager'] },
  MISSING_LEAD_TIME: { delivery: 'digest', cooldownHours: 168, notifyRoles: ['Admin', 'Inventory Manager'] },
  MISSING_CONSUMPTION: { delivery: 'digest', cooldownHours: 168, notifyRoles: ['Admin', 'Inventory Manager'] },
  MISSING_PLANNING_DATA: { delivery: 'digest', cooldownHours: 168, notifyRoles: ['Admin', 'Inventory Manager'] },

  // ── Operations ──────────────────────────────────────────────────────────
  // Stock has been promised to customers that physically is not there. Every
  // hour unseen is another hour of orders taken against it.
  OVERSOLD_EXCEPTION: { delivery: 'immediate', cooldownHours: 1, notifyRoles: ['Admin', 'Inventory Manager', 'Management', 'Sales'] },
  // A count waiting on a human is the most common way physical and system
  // stock drift apart, so the approver hears about it once a day.
  COUNT_APPROVAL_PENDING: { delivery: 'immediate', cooldownHours: 24, notifyRoles: ['Admin', 'Inventory Manager', 'Management'] },
  COUNT_VARIANCE_PENDING: { delivery: 'digest', cooldownHours: 24, notifyRoles: ['Admin', 'Inventory Manager'] },
  // A stalled projection means every figure on every inventory screen is
  // quietly stale — the worst failure mode, because nothing looks broken.
  PROJECTION_FAILURE: { delivery: 'immediate', cooldownHours: 2, notifyRoles: ['Admin', 'Inventory Manager'] },
  // Nobody watches a scheduled job. Without this, a missing day of history is
  // discovered when someone runs a report against it months later.
  SNAPSHOT_FAILURE: { delivery: 'immediate', cooldownHours: 6, notifyRoles: ['Admin', 'Inventory Manager'] },

  // ── Configuration ───────────────────────────────────────────────────────
  // A formula change moves every SKU's target without a unit moving. Anyone
  // comparing to last week needs to know the definition changed under them.
  FORMULA_VERSION_CHANGED: { delivery: 'immediate', cooldownHours: 1, notifyRoles: ['Admin', 'Inventory Manager', 'Management'] },
  CONFIGURATION_UPDATED: { delivery: 'digest', cooldownHours: 24, notifyRoles: ['Admin', 'Inventory Manager'] },
  PROJECTION_REBUILD_COMPLETED: { delivery: 'digest', cooldownHours: 24, notifyRoles: ['Admin'] },
};

export const seedAlertRules = async () => {
  try {
    const existing = await AlertRule.find({}, 'alertType').lean();
    const have = new Set(existing.map((r) => r.alertType));
    const missing = ALERT_TYPE_NAMES.filter((t) => !have.has(t));
    if (missing.length === 0) return;

    await AlertRule.insertMany(
      missing.map((alertType) => {
        const spec = ALERT_TYPES[alertType];
        const defaults = DEFAULTS[alertType] || {};
        return {
          alertType,
          enabled: true,
          // Null means "use the type's declared severity". Storing a copy here
          // would let the rule and the type disagree after a code change.
          severity: null,
          delivery: defaults.delivery || 'digest',
          cooldownHours: defaults.cooldownHours ?? 24,
          notifyRoles: defaults.notifyRoles || ['Admin', 'Inventory Manager'],
          description: `${spec.label} — ${spec.category}. Seeded default.`,
        };
      }),
      { ordered: false },
    );

    console.log(`[Seed] ${missing.length} alert rule(s) created.`);
  } catch (error) {
    console.error(`[Seed Error] Failed to seed alert rules: ${error.message}`);
  }
};

export default seedAlertRules;
