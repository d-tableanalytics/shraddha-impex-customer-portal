/**
 * HRMS configuration, versioned with history (AD-16).
 *
 * Follows the shape the portal already uses for `InventoryConfig`: a single
 * live document plus an append-only history of what changed, who changed it and
 * when. Using the established pattern rather than inventing a second one means
 * the Settings screen, the audit trail and the operational habits all carry
 * over.
 *
 * ---------------------------------------------------------------------------
 * Retention periods are DATA, never constants
 * ---------------------------------------------------------------------------
 * AD-16 requires that no retention period is hardcoded into business logic.
 * The sweep reads this document; there is no `90` or `1095` anywhere in a
 * service. scripts/hrms/verify-no-hardcoded-retention.js enforces that.
 *
 * `days: null` means RETAIN INDEFINITELY - never "delete immediately". An
 * unconfigured category must fail toward keeping data, the same way an
 * unconfigured statutory state blocks payroll rather than silently deducting
 * zero (AD-12).
 */

import mongoose from 'mongoose';

import {
  RETENTION_CATEGORY_LIST,
  RETENTION_ACTION_LIST,
  RETENTION_ACTIONS,
  DEFAULT_RETENTION_POLICY,
} from '../../shared/constants/hrms.js';

const retentionRuleSchema = new mongoose.Schema(
  {
    /** Null = retain indefinitely. Never treat null as zero. */
    days: { type: Number, default: null, min: 1, max: 36500 },
    action: { type: String, enum: RETENTION_ACTION_LIST, default: RETENTION_ACTIONS.RETAIN },
  },
  { _id: false },
);

const historyEntrySchema = new mongoose.Schema(
  {
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    changedAt: { type: Date, default: Date.now },
    category: { type: String, required: true },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    reason: { type: String, default: null },
  },
  { _id: false },
);

const hrmsConfigSchema = new mongoose.Schema(
  {
    /**
     * Discriminator for the single live document. A fixed key rather than a
     * "find the newest" query, so there can only ever be one.
     */
    key: { type: String, default: 'hrms-config', unique: true, immutable: true },

    retention: {
      type: Map,
      of: retentionRuleSchema,
      default: () => new Map(Object.entries(DEFAULT_RETENTION_POLICY)),
    },

    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true },
);

/**
 * Read the live config, creating it from the seed defaults on first use.
 *
 * Idempotent, so it is safe to call on every boot and from every request.
 */
hrmsConfigSchema.statics.load = async function load() {
  const existing = await this.findOne({ key: 'hrms-config' });
  if (existing) return existing;
  return this.create({ key: 'hrms-config' });
};

/**
 * The rule for a category, falling back to the seed default and then to
 * "retain" - so a category that is added in code but not yet present in a live
 * document is never swept.
 */
hrmsConfigSchema.methods.ruleFor = function ruleFor(category) {
  const stored = this.retention?.get?.(category);
  if (stored) return { days: stored.days ?? null, action: stored.action };
  const seed = DEFAULT_RETENTION_POLICY[category];
  return seed ? { ...seed } : { days: null, action: RETENTION_ACTIONS.RETAIN };
};

/** Every category with an active (non-null) retention window. */
hrmsConfigSchema.methods.activeRetentionRules = function activeRetentionRules() {
  const out = [];
  for (const category of RETENTION_CATEGORY_LIST) {
    const rule = this.ruleFor(category);
    if (rule.days !== null && rule.action !== RETENTION_ACTIONS.RETAIN) {
      out.push({ category, ...rule });
    }
  }
  return out;
};

export default mongoose.models.HrmsConfig || mongoose.model('HrmsConfig', hrmsConfigSchema);
