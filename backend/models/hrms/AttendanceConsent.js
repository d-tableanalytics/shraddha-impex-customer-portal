/**
 * AttendanceConsent — the DPDP consent ledger for selfie and location capture.
 *
 * NET-NEW. The reference has no consent model of any kind: its ClockInCard
 * gates the punch behind a hard camera-and-location permission check with an
 * explicit "no bypass" comment, which makes the capture a CONDITION of being
 * able to clock in. AD-15 rejects that — under India's DPDP Act 2023 consent
 * must be free, so a refusal has to leave the punch possible.
 *
 * ---------------------------------------------------------------------------
 * An append-only ledger, not a flag
 * ---------------------------------------------------------------------------
 * AD-15 asks for the HISTORY: when consent was given, under which wording, and
 * when it was withdrawn. A boolean on Employee answers none of those, and the
 * one question that actually matters in a dispute — "what had they agreed to on
 * the day this photograph was taken" — is unanswerable without the trail.
 *
 * So every grant and every withdrawal INSERTS a row. The current state for a
 * purpose is the newest row; nothing is ever updated in place.
 *
 * ---------------------------------------------------------------------------
 * Versioned wording
 * ---------------------------------------------------------------------------
 * `consentTextVersion` records which notice the employee actually read.
 * Bumping CURRENT_CONSENT_VERSION invalidates prior consent, because consent to
 * one purpose is not consent to a broader one written later.
 */

import mongoose from 'mongoose';

import {
  CONSENT_PURPOSE_LIST,
  CURRENT_CONSENT_VERSION,
} from '../../shared/constants/hrms.js';

const { Schema } = mongoose;

const attendanceConsentSchema = new Schema(
  {
    employeeId: {
      type: Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
      index: true,
    },

    /** `attendance_selfie` or `attendance_location`. Separate, so one may be granted without the other. */
    purpose: { type: String, enum: CONSENT_PURPOSE_LIST, required: true },

    /** True for a grant, false for a withdrawal. Both are recorded events. */
    granted: { type: Boolean, required: true },

    /**
     * The wording in force when this decision was made.
     *
     * Stamped from CURRENT_CONSENT_VERSION at write time, never sent by the
     * client — a client that chose its own version could claim agreement to a
     * notice it never displayed.
     */
    consentTextVersion: { type: Number, required: true, default: CURRENT_CONSENT_VERSION },

    grantedAt: { type: Date, default: null },
    withdrawnAt: { type: Date, default: null },

    /**
     * Where the decision came from.
     *
     * Evidence of a specific act by a specific person, which is what makes an
     * "unambiguous, affirmative action" demonstrable later.
     */
    ipAddress: { type: String, default: null, maxlength: 64 },
    userAgent: { type: String, default: null, maxlength: 300 },

    /** The login that performed the act; normally the employee's own. */
    actedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

/** "The newest decision for this employee and purpose" — the only read there is. */
attendanceConsentSchema.index({ employeeId: 1, purpose: 1, createdAt: -1 });

/**
 * The current state of one purpose, or null if never decided.
 *
 * Deliberately a static rather than something each caller assembles: reading
 * the ledger wrong — taking the first row instead of the newest — would report
 * a withdrawn consent as still granted.
 */
attendanceConsentSchema.statics.currentFor = async function currentFor(employeeId, purpose) {
  return this.findOne({ employeeId, purpose }).sort({ createdAt: -1 }).lean();
};

export default mongoose.models.AttendanceConsent ||
  mongoose.model('AttendanceConsent', attendanceConsentSchema);
