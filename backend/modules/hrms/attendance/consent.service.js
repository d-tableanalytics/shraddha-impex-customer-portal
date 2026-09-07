/**
 * Attendance capture consent (AD-15).
 *
 * NET-NEW. The reference has no consent of any kind — its clock-in runs a hard
 * permission gate over camera and geolocation with an explicit "there's no
 * bypass" comment, so an employee who declines either cannot clock in at all.
 * That makes the capture a condition of being paid, which is precisely what
 * India's DPDP Act 2023 means when it requires consent to be FREE.
 *
 * The rule this module exists to enforce:
 *
 *   🔴 A REFUSAL MUST STILL ALLOW THE PUNCH.
 *
 * Attendance is then recorded with no selfie and no coordinates. Everything
 * else here — the ledger, the versioning, the erasure on withdrawal — follows
 * from taking that seriously.
 */

import AttendanceConsent from '../../../models/hrms/AttendanceConsent.js';
import AttendanceRecord from '../../../models/hrms/AttendanceRecord.js';
import { recordAudit } from '../../../utils/auditLog.js';
import {
  CONSENT_PURPOSES,
  CONSENT_PURPOSE_LIST,
  CURRENT_CONSENT_VERSION,
  AUDIT_ACTIONS,
  RETENTION_CATEGORIES,
} from '../../../shared/constants/hrms.js';
import { HrmsForbiddenError } from '../hrms.errors.js';
import { purgeCategoryNow } from '../retention/retention.sweep.js';

/**
 * The consent notice, versioned.
 *
 * The text lives beside the version it belongs to so the two cannot drift: a
 * reworded notice that kept the old number would mean the ledger records
 * agreement to wording nobody saw. AD-15 requires the employee be told WHAT is
 * captured, WHY, WHERE it is stored and FOR HOW LONG, at the point of capture.
 *
 * The retention period is described in words rather than a number, because the
 * number is configuration (AD-16) and quoting it here would hardcode a value
 * the Settings screen can change.
 */
export const CONSENT_NOTICES = Object.freeze({
  [CONSENT_PURPOSES.ATTENDANCE_SELFIE]: Object.freeze({
    version: CURRENT_CONSENT_VERSION,
    title: 'Photograph at clock-in and clock-out',
    body:
      'A photograph is taken from your device camera each time you clock in or out, ' +
      'to confirm that the punch was made by you. It is uploaded over an encrypted ' +
      'connection and stored encrypted; it is never public. Only you, your reporting ' +
      'manager and HR can view it, and every view is recorded. Photographs are deleted ' +
      'automatically once the retention period set by HR has passed. No face matching ' +
      'or facial recognition is performed at any point.',
    optional:
      'You may decline, and you may withdraw at any time. Clocking in and out works ' +
      'either way — your attendance and your pay are not affected.',
  }),
  [CONSENT_PURPOSES.ATTENDANCE_LOCATION]: Object.freeze({
    version: CURRENT_CONSENT_VERSION,
    title: 'Location at clock-in and clock-out',
    body:
      'Your device location is read at the moment you clock in or out, and stored with ' +
      'that punch together with a street-level address looked up from it. It is read ' +
      'ONLY at those two moments — you are not tracked at any other time, and no ' +
      'geofence or boundary is applied. Only you, your reporting manager and HR can ' +
      'see it.',
    optional:
      'You may decline, and you may withdraw at any time. Clocking in and out works ' +
      'either way — your attendance and your pay are not affected.',
  }),
});

/**
 * The current decision for every purpose.
 *
 * A purpose that has never been decided reports `granted: false` with
 * `decided: false`. The distinction matters to the UI: "not yet asked" gets a
 * prompt, "declined" does not get asked again on every punch.
 *
 * Consent is also invalidated by a NEWER notice version — agreeing to one
 * wording is not agreeing to a broader one written afterwards.
 */
export async function consentStateFor(employeeId) {
  const state = {};

  for (const purpose of CONSENT_PURPOSE_LIST) {
    const notice = CONSENT_NOTICES[purpose];
    const latest = employeeId
      ? await AttendanceConsent.currentFor(employeeId, purpose)
      : null;

    const stale = Boolean(latest) && latest.consentTextVersion < notice.version;

    state[purpose] = {
      purpose,
      granted: Boolean(latest?.granted) && !stale,
      decided: Boolean(latest) && !stale,
      decidedAt: latest?.createdAt ?? null,
      consentTextVersion: latest?.consentTextVersion ?? null,
      /** True when a previous decision was superseded by reworded terms. */
      supersededByNewVersion: stale,
      notice,
    };
  }

  return state;
}

/** Is one purpose currently consented to? The check every punch makes. */
export async function hasConsent(employeeId, purpose) {
  if (!employeeId) return false;
  const latest = await AttendanceConsent.currentFor(employeeId, purpose);
  if (!latest?.granted) return false;
  return latest.consentTextVersion >= CONSENT_NOTICES[purpose].version;
}

/**
 * Record a grant or a withdrawal.
 *
 * INSERTS — never updates. The ledger is the point (see the model): the
 * question that matters in a dispute is what the employee had agreed to on the
 * day a particular photograph was taken, and an in-place flag cannot answer it.
 *
 * @param {object} params
 * @param {string} params.employeeId  the AUTHENTICATED actor's own employee id
 * @param {string} params.purpose
 * @param {boolean} params.granted
 * @param {object} [params.req]  for the IP, user agent and audit entry
 * @param {object} [params.user]
 */
export async function setConsent({ employeeId, purpose, granted, req, user }) {
  if (!employeeId) {
    throw new HrmsForbiddenError('Only an employee may record attendance consent.');
  }

  const now = new Date();

  await AttendanceConsent.create({
    employeeId,
    purpose,
    granted,
    consentTextVersion: CONSENT_NOTICES[purpose].version,
    grantedAt: granted ? now : null,
    withdrawnAt: granted ? null : now,
    // Truncated to the column widths rather than rejected: a browser sending a
    // 4 KB user agent is odd, not an attack, and losing the whole consent
    // record over it would be the worse outcome.
    ipAddress: req?.ip ? String(req.ip).slice(0, 64) : null,
    userAgent: req?.headers?.['user-agent']
      ? String(req.headers['user-agent']).slice(0, 300)
      : null,
    actedByUserId: user?._id ?? null,
  });

  await recordAudit(
    user ?? { _id: null },
    granted ? AUDIT_ACTIONS.CONSENT_GRANTED : AUDIT_ACTIONS.CONSENT_WITHDRAWN,
    `${granted ? 'Granted' : 'Withdrew'} consent for ${purpose} (notice v${CONSENT_NOTICES[purpose].version})`,
    req,
    { meta: { employeeId: String(employeeId), purpose, version: CONSENT_NOTICES[purpose].version } },
  );

  /**
   * Withdrawal ERASES what was already captured.
   *
   * AD-15 leaves this open and RECOMMENDS erasure; that recommendation is
   * followed. The reasoning: the attendance record is a business record and
   * must persist, but the selfie and the coordinates were collected only to
   * verify a punch, and continuing to hold them after consent is withdrawn is
   * holding personal data for a purpose that no longer has a basis.
   *
   * Withdrawal means erase NOW, not at the next nightly sweep — which is why
   * `purgeCategoryNow` exists. It runs the same deletion routine as the sweep,
   * so the two can never diverge in behaviour.
   */
  if (!granted) {
    const erased = await erasePriorCaptures(employeeId, purpose);
    return { purpose, granted, erased };
  }

  return { purpose, granted, erased: null };
}

/**
 * Remove already-captured data for a purpose the employee has just declined.
 *
 * Selfies go through the retention machinery — pointer nulled first, then the
 * S3 object, tolerating a storage failure as an orphan (see
 * retention/purgeStoredObjects.js). Coordinates are a plain document update:
 * there is no object to delete, only fields to clear.
 */
async function erasePriorCaptures(employeeId, purpose) {
  if (purpose === CONSENT_PURPOSES.ATTENDANCE_SELFIE) {
    return purgeCategoryNow(RETENTION_CATEGORIES.ATTENDANCE_SELFIES, {
      filter: {
        employeeId,
        $or: [
          { 'clockInCapture.selfieKey': { $ne: null } },
          { 'clockOutCapture.selfieKey': { $ne: null } },
        ],
      },
      reason: 'Employee withdrew consent for attendance selfie capture.',
    });
  }

  const result = await AttendanceRecord.updateMany(
    {
      employeeId,
      $or: [{ 'clockInCapture.geo': { $ne: null } }, { 'clockOutCapture.geo': { $ne: null } }],
    },
    {
      $set: {
        'clockInCapture.geo': null,
        'clockInCapture.locationLabel': null,
        'clockOutCapture.geo': null,
        'clockOutCapture.locationLabel': null,
      },
    },
  );

  return { affected: result.modifiedCount ?? 0, scanned: result.matchedCount ?? 0 };
}

export default { consentStateFor, hasConsent, setConsent, CONSENT_NOTICES };
