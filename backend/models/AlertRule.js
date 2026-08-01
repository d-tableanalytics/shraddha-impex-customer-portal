import mongoose from 'mongoose';
import { ALERT_TYPE_NAMES, SEVERITIES } from './InventoryAlert.js';

/**
 * Alert rule (IMS Module M8).
 *
 * Declares WHICH conditions raise an alert and how loudly. It holds no
 * thresholds of its own — a rule matches on the band or flag Module M4 already
 * decided, so the alert engine and the health screen cannot disagree about what
 * "Critical" means.
 *
 * Severity is overridable per rule because urgency is a business judgement (one
 * site treats Overstock as noise, another as tied-up capital) whereas the
 * classification itself is not.
 */
const alertRuleSchema = new mongoose.Schema(
  {
    alertType: { type: String, enum: ALERT_TYPE_NAMES, required: true, unique: true },
    enabled: { type: Boolean, default: true },

    // Overrides the type's default severity when set.
    severity: { type: String, enum: [...SEVERITIES, null], default: null },

    /**
     * How the alert reaches people.
     *
     *   immediate — pushed as it fires. Reserved for conditions that genuinely
     *               warrant interrupting someone.
     *   digest    — recorded and surfaced in the alert list, not pushed. The
     *               DEFAULT, because per-SKU pushing at this catalogue size
     *               produces hundreds of notifications and gets muted within a
     *               week — after which the system is worse than silent, since
     *               everyone believes it is working.
     *   silent    — recorded only.
     */
    delivery: { type: String, enum: ['immediate', 'digest', 'silent'], default: 'digest' },

    /**
     * Minimum gap before the same condition on the same SKU may notify again.
     * Stops a SKU oscillating across a threshold from spamming. The ALERT is
     * still recorded and its occurrence counter still rises; only the push is
     * suppressed.
     */
    cooldownHours: { type: Number, default: 24, min: 1 },

    // Which roles receive a push. Empty means recorded but pushed to nobody —
    // useful for conditions worth tracking but not worth interrupting anyone for.
    notifyRoles: { type: [String], default: ['Admin', 'Inventory Manager'] },

    description: { type: String, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
);

alertRuleSchema.index({ enabled: 1 });

export default mongoose.model('AlertRule', alertRuleSchema);
