/**
 * Retention policy configuration (AD-16).
 *
 * Settings-editable, versioned, and audited. The sweep reads this; no retention
 * period is written into any service.
 */

import HrmsConfig from '../../../models/hrms/HrmsConfig.js';
import { runHrmsRetentionSweep } from './retention.sweep.js';
import { registeredRetentionCategories } from './retention.registry.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { formatZodIssues, z } from '../../../shared/validation/common.js';
import { retentionRule } from '../../../shared/validation/common.js';
import {
  RETENTION_CATEGORY_LIST,
  RETENTION_CATEGORIES,
  AUDIT_ACTIONS,
} from '../../../shared/constants/hrms.js';

const updateSchema = z.object({
  retention: z.record(z.enum(RETENTION_CATEGORY_LIST), retentionRule),
  reason: z.string().trim().max(500).optional(),
});

const serialise = (config) => ({
  retention: Object.fromEntries(
    RETENTION_CATEGORY_LIST.map((c) => [c, config.ruleFor(c)]),
  ),
  // Which categories actually have a sweep implemented. A configured window
  // with no handler does nothing, and the UI should be able to say so.
  implemented: registeredRetentionCategories(),
  updatedAt: config.updatedAt,
});

/** GET /api/v1/hrms/config/retention */
export const getRetentionConfig = async (req, res, next) => {
  try {
    const config = await HrmsConfig.load();
    res.status(200).json({ success: true, data: serialise(config) });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/config/retention/history */
export const getRetentionHistory = async (req, res, next) => {
  try {
    const config = await HrmsConfig.load();
    res.status(200).json({
      success: true,
      data: [...config.history].sort((a, b) => b.changedAt - a.changedAt).slice(0, 200),
    });
  } catch (error) {
    next(error);
  }
};

/** PUT /api/v1/hrms/config/retention */
export const updateRetentionConfig = async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: 'Invalid retention policy.',
        errors: formatZodIssues(parsed.error),
      });
    }

    const config = await HrmsConfig.load();
    const changed = [];

    for (const [category, rule] of Object.entries(parsed.data.retention)) {
      const before = config.ruleFor(category);
      if (before.days === rule.days && before.action === rule.action) continue;

      config.retention.set(category, rule);
      config.history.push({
        changedBy: req.user?._id ?? null,
        changedAt: new Date(),
        category,
        before,
        after: rule,
        reason: parsed.data.reason ?? null,
      });
      changed.push({ category, before, after: rule });
    }

    if (changed.length === 0) {
      return res.status(200).json({ success: true, data: serialise(config), message: 'No change.' });
    }

    await config.save();

    // Exempt from its own retention window: the record of a policy change must
    // outlive the policy it changed.
    await recordAudit(
      req.user,
      AUDIT_ACTIONS.RETENTION_CONFIG_CHANGED,
      `Retention policy updated for: ${changed.map((c) => c.category).join(', ')}`,
      req,
      { meta: { changed, reason: parsed.data.reason ?? null } },
    );

    res.status(200).json({ success: true, data: serialise(config) });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/hrms/config/retention/sweep
 *
 * Runs the sweep on demand. Defaults to a DRY RUN: an operator checking what a
 * policy change would remove must not have to delete anything to find out.
 * Passing `{ dryRun: false }` performs it.
 */
export const runSweepNow = async (req, res, next) => {
  try {
    const dryRun = req.body?.dryRun !== false;
    const summary = await runHrmsRetentionSweep({ dryRun });
    res.status(200).json({ success: true, data: summary });
  } catch (error) {
    next(error);
  }
};

export default {
  getRetentionConfig,
  getRetentionHistory,
  updateRetentionConfig,
  runSweepNow,
  RETENTION_CATEGORIES,
};
