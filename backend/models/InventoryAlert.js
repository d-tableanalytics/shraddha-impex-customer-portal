import mongoose from 'mongoose';

/**
 * Inventory alert (IMS Module M8).
 *
 * An alert is an EVENT with a lifecycle. Its identity and trigger data are
 * fixed at creation and never change — what the condition was, when it fired,
 * and which projection values justified it. Only lifecycle fields move
 * (status, who acknowledged it, when it resolved) plus the dedup counters.
 *
 * That split is deliberate: "why was this raised" must remain answerable long
 * after the condition cleared, while "what happened to it" has to stay
 * writable. The pre-save guard below enforces exactly that boundary.
 *
 * THE ALERT ENGINE CALCULATES NOTHING. Every value stored here — band,
 * percentage, coverage, quantities — is copied from the health (M4) or balance
 * (M3) projection at trigger time.
 */

/** The closed set from the blueprint. Adding one is a deliberate design act. */
export const ALERT_TYPES = {
  // ── Stock health ────────────────────────────────────────────────────────
  CRITICAL_STOCK: { category: 'Stock Health', severity: 'Critical', label: 'Critical Stock' },
  LOW_STOCK: { category: 'Stock Health', severity: 'Medium', label: 'Low Stock' },
  OUT_OF_STOCK: { category: 'Stock Health', severity: 'Critical', label: 'Out of Stock' },
  OVERSTOCK: { category: 'Stock Health', severity: 'Low', label: 'Overstock' },

  // ── Planning ────────────────────────────────────────────────────────────
  MISSING_PLANNING_DATA: { category: 'Planning', severity: 'Low', label: 'Missing Planning Data' },
  UNKNOWN_HEALTH: { category: 'Planning', severity: 'Low', label: 'No Planning Data' },
  MISSING_LEAD_TIME: { category: 'Planning', severity: 'Low', label: 'Missing Lead Time' },
  MISSING_CONSUMPTION: { category: 'Planning', severity: 'Low', label: 'Missing Consumption' },

  // ── Operations ──────────────────────────────────────────────────────────
  OVERSOLD_EXCEPTION: { category: 'Operations', severity: 'Critical', label: 'Oversold Exception' },
  COUNT_VARIANCE_PENDING: { category: 'Operations', severity: 'Medium', label: 'Count Variance Pending' },
  COUNT_APPROVAL_PENDING: { category: 'Operations', severity: 'Medium', label: 'Count Approval Pending' },
  PROJECTION_FAILURE: { category: 'Operations', severity: 'High', label: 'Projection Failure' },
  SNAPSHOT_FAILURE: { category: 'Operations', severity: 'High', label: 'Snapshot Failure' },

  // ── Configuration ───────────────────────────────────────────────────────
  FORMULA_VERSION_CHANGED: { category: 'Configuration', severity: 'High', label: 'Formula Version Changed' },
  CONFIGURATION_UPDATED: { category: 'Configuration', severity: 'Info', label: 'Configuration Updated' },
  PROJECTION_REBUILD_COMPLETED: { category: 'Configuration', severity: 'Info', label: 'Projection Rebuild Completed' },
};

export const ALERT_TYPE_NAMES = Object.keys(ALERT_TYPES);
export const ALERT_CATEGORIES = [...new Set(Object.values(ALERT_TYPES).map((t) => t.category))];
export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info'];
export const ALERT_STATUSES = ['Open', 'Acknowledged', 'Resolved', 'Closed'];

/**
 * Legal lifecycle moves.
 *
 * A Resolved alert may be closed, but a CLOSED alert is terminal — it cannot be
 * reopened. If the condition returns, the deduplication key is free again and a
 * NEW alert is raised, which keeps each occurrence separately timestamped
 * instead of collapsing a recurring problem into one perpetually-reopened row.
 */
export const ALERT_TRANSITIONS = {
  Open: ['Acknowledged', 'Resolved', 'Closed'],
  Acknowledged: ['Resolved', 'Closed'],
  Resolved: ['Closed'],
  Closed: [],
};

const inventoryAlertSchema = new mongoose.Schema(
  {
    alertId: { type: String, required: true, unique: true },

    // ── What and where (immutable) ──────────────────────────────────────────
    alertType: { type: String, enum: ALERT_TYPE_NAMES, required: true },
    category: { type: String, required: true },
    severity: { type: String, enum: SEVERITIES, required: true },

    // Null for alerts that are not about a specific SKU (config, snapshot).
    skuCode: { type: String, default: null },
    brand: { type: String, default: null },
    location: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    locationCode: { type: String, default: null },

    /**
     * Deduplication key: one ACTIVE alert per condition.
     *
     * Backs the partial unique index below. Built from type + sku + brand +
     * location, so the same condition on the same SKU cannot raise a second
     * alert while the first is still live.
     */
    dedupeKey: { type: String, required: true },
    // Present and true only while Open or Acknowledged. Cleared on resolve or
    // close, freeing the key so a recurrence can raise a fresh alert.
    active: { type: Boolean, default: true },

    // ── Why (immutable) ─────────────────────────────────────────────────────
    title: { type: String, required: true },
    message: { type: String, required: true },
    // Which module announced the condition.
    triggerSource: {
      type: String,
      enum: ['health-projection', 'balance-projection', 'count', 'snapshot', 'config', 'system'],
      required: true,
    },
    // Projection values AS THEY WERE when the alert fired. Copied, never
    // computed, and never refreshed — so the alert still explains itself after
    // the projection has moved on.
    snapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    // Link back to the record that caused it (count id, snapshot run, etc).
    relatedEntityType: { type: String, default: null },
    relatedEntityId: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },

    // ── Lifecycle (mutable) ─────────────────────────────────────────────────
    status: { type: String, enum: ALERT_STATUSES, default: 'Open', required: true },
    // How many times the condition has been re-observed while this alert was
    // live. High occurrences on a long-lived alert means a persistent problem,
    // not a noisy rule.
    occurrences: { type: Number, default: 1 },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    // When a notification was last pushed for this alert. Backs the cooldown.
    lastNotifiedAt: { type: Date, default: null },

    acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    acknowledgedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
    // Set when the engine resolved it because the condition cleared, rather
    // than a person acting on it.
    autoResolved: { type: Boolean, default: false },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    closedAt: { type: Date, default: null },
    resolutionNote: { type: String, default: null },

    // Delivery record per channel. In-app is the only live channel; email and
    // webhook are declared so enabling one later needs no schema change.
    deliveries: {
      type: [{
        channel: { type: String, enum: ['in-app', 'email', 'webhook'] },
        status: { type: String, enum: ['sent', 'failed', 'skipped'] },
        recipients: Number,
        at: Date,
        reason: String,
        _id: false,
      }],
      default: [],
    },
  },
  { timestamps: true, versionKey: false },
);

// ONE active alert per condition. Partial, so resolved and closed alerts drop
// out of the index and a recurrence can raise a new one.
inventoryAlertSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);

// The alert list: brand-scoped, newest first, filterable by status/severity.
inventoryAlertSchema.index({ brand: 1, status: 1, createdAt: -1 });
inventoryAlertSchema.index({ severity: 1, status: 1, createdAt: -1 });
inventoryAlertSchema.index({ alertType: 1, createdAt: -1 });
inventoryAlertSchema.index({ skuCode: 1, createdAt: -1 });
inventoryAlertSchema.index({ relatedEntityType: 1, relatedEntityId: 1 });

/**
 * Trigger data is immutable; lifecycle fields are not.
 *
 * Without this, an alert could be edited after the fact to claim it fired for a
 * different reason — which would make the entire trail worthless.
 */
const IMMUTABLE_FIELDS = [
  'alertId', 'alertType', 'category', 'skuCode', 'brand', 'location',
  'dedupeKey', 'title', 'triggerSource', 'snapshot', 'firstSeenAt',
];

inventoryAlertSchema.pre('save', function guard(next) {
  if (this.isNew) return next();
  const violated = IMMUTABLE_FIELDS.filter((f) => this.isModified(f));
  if (violated.length) {
    return next(new Error(
      `An alert's trigger data is immutable — ${violated.join(', ')} cannot be changed.`,
    ));
  }
  next();
});

for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete']) {
  inventoryAlertSchema.pre(op, function guard(next) {
    next(new Error(`Alerts cannot be deleted — ${op} is not permitted. Close the alert instead.`));
  });
}

export default mongoose.model('InventoryAlert', inventoryAlertSchema);
