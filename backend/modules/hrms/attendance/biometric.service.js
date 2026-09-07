/**
 * Biometric punch ingestion.
 *
 * Ported from the reference's `BiometricIngestService`, which IS a real,
 * wired workflow: an HMAC-signed webhook carrying a canonical punch payload,
 * upserting attendance rows by employee code.
 *
 * ---------------------------------------------------------------------------
 * What is NOT ported, and why
 * ---------------------------------------------------------------------------
 * The reference also ships `biometric-drivers.ts` — ZKTeco, eSSL and Realtime
 * payload parsers behind a `DRIVER_REGISTRY`. Nothing imports them. There is no
 * controller, no service call and no test that reaches `normalizeVendorPayload`,
 * and the `ingestVendor()` its own comment names does not exist. It is
 * unreached code describing an intention, not a workflow, so there is nothing
 * there to reproduce. Vendor normalisation happens on the device side of this
 * webhook, exactly as the canonical payload assumes.
 *
 * No hardware integration is built. AD-15 fences that off explicitly.
 *
 * ---------------------------------------------------------------------------
 * Corrections to the source
 * ---------------------------------------------------------------------------
 * 1. FAILS CLOSED WITHOUT A SECRET. The reference reads
 *    `BIOMETRIC_WEBHOOK_SECRET` from a config schema; if that were ever absent
 *    or empty, `createHmac('sha256', '')` still produces a valid digest and the
 *    endpoint would accept anything signed with the empty key. Here an
 *    unconfigured secret DISABLES the endpoint.
 *
 * 2. TIMESTAMPS ARE BOUNDED. The reference accepts any timestamp a device
 *    sends, so a replayed or malformed payload can rewrite a closed month or
 *    file a punch in 2099.
 *
 * 3. REJECTIONS ARE AUDITED. An unauthenticated endpoint that writes attendance
 *    leaves no trace when someone probes it. A run of failed signatures is the
 *    only signal that anyone is trying.
 *
 * 4. SOFT-DELETED EMPLOYEES ARE SKIPPED, as in the reference, and REPORTED
 *    rather than silently counted as applied.
 */

import crypto from 'node:crypto';

import AttendanceRecord from '../../../models/hrms/AttendanceRecord.js';
import Employee from '../../../models/hrms/Employee.js';
import { recordSystemAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS } from '../../../shared/constants/hrms.js';
import {
  BIOMETRIC_MAX_BACKDATE_DAYS,
  BIOMETRIC_MAX_FUTURE_SKEW_MS,
} from '../../../shared/constants/attendance.js';
import { todayDate, attendanceDayString, dayToDate } from '../../../shared/attendance/status.js';
import { PUNCHABLE_STATUSES } from './attendance.service.js';

const idStr = (v) => (v === null || v === undefined ? null : String(v));

export class BiometricAuthError extends Error {
  constructor(message, statusCode = 401) {
    super(message);
    this.name = 'BiometricAuthError';
    this.statusCode = statusCode;
  }
}

/** The configured secret, or null when ingestion is switched off. */
export function webhookSecret() {
  const secret = process.env.HRMS_BIOMETRIC_WEBHOOK_SECRET;
  return typeof secret === 'string' && secret.length >= 16 ? secret : null;
}

export const isBiometricIngestEnabled = () => webhookSecret() !== null;

/**
 * Verify the HMAC-SHA256 signature over the RAW body.
 *
 * Over the raw bytes, not over a re-serialised object: two JSON encodings of
 * the same object differ in key order and whitespace, so signing the parsed
 * form would fail for honest senders and would let a crafted body that parses
 * identically pass.
 *
 * `timingSafeEqual` on equal-length buffers, so response timing does not leak
 * how many leading bytes of a guess were right.
 */
export function verifySignature(rawBody, signatureHeader) {
  const secret = webhookSecret();
  if (!secret) {
    throw new BiometricAuthError(
      'Biometric ingestion is not configured on this server.',
      503,
    );
  }
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw new BiometricAuthError('The request body could not be verified.', 400);
  }
  if (!signatureHeader) {
    throw new BiometricAuthError('Missing X-Signature header.', 401);
  }

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = String(signatureHeader).trim().replace(/^sha256=/i, '').toLowerCase();

  // Length and alphabet are checked first: timingSafeEqual THROWS on a length
  // mismatch, and Buffer.from(x,'hex') silently truncates on a non-hex char,
  // which would compare a shortened buffer against the full digest.
  if (provided.length !== expected.length || !/^[0-9a-f]+$/.test(provided)) {
    throw new BiometricAuthError('Invalid signature.', 401);
  }
  if (!crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new BiometricAuthError('Invalid signature.', 401);
  }
  return true;
}

/** Record a refused call. Never throws — auditing a rejection must not fail it. */
export async function auditRejection(reason, meta = {}) {
  await recordSystemAudit(
    AUDIT_ACTIONS.ATTENDANCE_BIOMETRIC_REJECTED,
    `Biometric ingestion refused: ${reason}`,
    meta,
  );
}

/**
 * Is this punch timestamp plausible?
 *
 * A device that has been offline replays its buffer, so backdating must be
 * allowed — but not without limit, or a replayed payload rewrites a closed
 * month. A small forward tolerance covers device clock skew.
 */
function timestampProblem(ts, now) {
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return 'unparseable timestamp';
  if (at.getTime() > now.getTime() + BIOMETRIC_MAX_FUTURE_SKEW_MS) {
    return 'timestamp is in the future';
  }
  const earliest = now.getTime() - BIOMETRIC_MAX_BACKDATE_DAYS * 24 * 60 * 60 * 1000;
  if (at.getTime() < earliest) {
    return `timestamp is more than ${BIOMETRIC_MAX_BACKDATE_DAYS} days old`;
  }
  return null;
}

/**
 * Apply a batch of canonical punches.
 *
 * Per-punch outcomes are REPORTED rather than aborting the batch: a device
 * sending fifty punches, one of which names an employee code that no longer
 * exists, should have the other forty-nine recorded. The reference behaves the
 * same way and returns `{ received, applied, skipped }`.
 *
 * @param {{punches: Array}} dto  validated by biometricIngestSchema
 * @returns {Promise<{received:number, applied:number, skipped:Array}>}
 */
export async function ingest(dto, { now = new Date() } = {}) {
  const punches = dto.punches ?? [];

  const codes = [...new Set(punches.map((p) => p.employeeCode))];
  const employees = await Employee.find({
    employeeCode: { $in: codes },
    deletedAt: null,
  })
    .select('_id employeeCode status')
    .lean();

  const byCode = new Map(employees.map((e) => [e.employeeCode, e]));

  const skipped = [];
  let applied = 0;

  for (let i = 0; i < punches.length; i += 1) {
    const punch = punches[i];
    const line = i + 1;

    const employee = byCode.get(punch.employeeCode);
    if (!employee) {
      skipped.push({ line, reason: `unknown or deleted employeeCode ${punch.employeeCode}` });
      continue;
    }
    if (!PUNCHABLE_STATUSES.includes(employee.status)) {
      skipped.push({
        line,
        reason: `employee ${punch.employeeCode} is "${employee.status}" and cannot record attendance`,
      });
      continue;
    }

    const problem = timestampProblem(punch.timestamp, now);
    if (problem) {
      skipped.push({ line, reason: `${problem} (${punch.timestamp})` });
      continue;
    }

    const at = new Date(punch.timestamp);
    // The calendar day is computed in the business time zone, like every other
    // punch — a device reporting 06:00 IST must file against that morning, not
    // against the previous UTC day.
    const date = dayToDate(attendanceDayString(at));

    const existing = await AttendanceRecord.findOne({ employeeId: employee._id, date }).lean();

    if (punch.punchType === 'in') {
      // EARLIEST in-punch wins, as in the reference: a later swipe must not
      // push someone's arrival time forwards.
      const keepExisting = existing?.clockIn && new Date(existing.clockIn) <= at;
      if (existing && keepExisting) {
        await AttendanceRecord.updateOne(
          { _id: existing._id },
          { $set: { source: 'biometric', deviceId: punch.deviceId } },
        );
      } else {
        await upsertPunch({
          employeeId: employee._id,
          date,
          set: {
            clockIn: at,
            'clockInCapture.at': at,
            source: 'biometric',
            status: existing?.status === 'absent' || !existing ? 'present' : existing.status,
            deviceId: punch.deviceId,
          },
        });
      }
    } else {
      // LATEST out-punch wins, as in the reference: a shift that swipes out
      // more than once ends at the last one.
      const keepExisting = existing?.clockOut && new Date(existing.clockOut) >= at;
      if (existing && keepExisting) {
        await AttendanceRecord.updateOne(
          { _id: existing._id },
          { $set: { source: 'biometric', deviceId: punch.deviceId } },
        );
      } else {
        await upsertPunch({
          employeeId: employee._id,
          date,
          set: {
            clockOut: at,
            'clockOutCapture.at': at,
            source: 'biometric',
            status: existing?.status ?? 'present',
            deviceId: punch.deviceId,
          },
        });
      }
    }

    applied += 1;
  }

  const summary = { received: punches.length, applied, skipped };

  await recordSystemAudit(
    AUDIT_ACTIONS.ATTENDANCE_BIOMETRIC_INGESTED,
    `Biometric ingestion: ${applied} of ${punches.length} punch(es) applied` +
      (skipped.length ? `, ${skipped.length} skipped` : ''),
    {
      ...summary,
      deviceIds: [...new Set(punches.map((p) => p.deviceId))],
      employeeCodes: [...new Set(punches.map((p) => p.employeeCode))],
    },
  );

  return summary;
}

/**
 * Create or amend the day's row.
 *
 * Upsert rather than find-then-create, so two devices reporting the same
 * employee at once cannot both create a row — the unique (employeeId, date)
 * index makes the second an update.
 */
async function upsertPunch({ employeeId, date, set }) {
  return AttendanceRecord.updateOne(
    { employeeId, date },
    { $set: set, $setOnInsert: { employeeId, date } },
    { upsert: true, setDefaultsOnInsert: true },
  );
}

export { todayDate, idStr };

export default {
  verifySignature,
  ingest,
  isBiometricIngestEnabled,
  webhookSecret,
  auditRejection,
  BiometricAuthError,
};
