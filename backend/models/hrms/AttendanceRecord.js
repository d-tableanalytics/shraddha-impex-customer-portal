/**
 * AttendanceRecord — one row per employee per calendar day.
 *
 * Ported from the reference's Prisma `AttendanceRecord`, adapted to Mongoose
 * and to the accepted decisions:
 *
 *   AD-1   single tenant, so no organizationId
 *   AD-2   ObjectId keys, no foreign keys — the service checks references
 *   AD-7   a selfie is a storage KEY, never a URL
 *   AD-13  every list is server-paginated, so the indexes below matter
 *   AD-15  selfie and GPS at punch time, under consent
 *
 * ---------------------------------------------------------------------------
 * Coordinates are PER PUNCH (AD-15, defect 2)
 * ---------------------------------------------------------------------------
 * The reference carries one `geoLat`/`geoLng` pair but TWO location labels
 * (`clockInLocation`, `clockOutLocation`). Its clock-out then writes
 * `geoLat: dto.geoLat ?? existing.geoLat`, so a clock-out from a different
 * place overwrites where the clock-in happened while the clock-in LABEL stays
 * — leaving a record whose label and coordinates describe different places.
 * Two blocks, one per punch, so the pair always agrees.
 *
 * ---------------------------------------------------------------------------
 * `date` is a label, not an instant
 * ---------------------------------------------------------------------------
 * Midnight UTC of the attendance day, which is computed in the configured
 * business time zone (shared/attendance/status.js). Storing a local midnight
 * would make an equality lookup depend on knowing which zone was configured
 * when the row was written.
 */

import mongoose from 'mongoose';

import { ATTENDANCE_SOURCES, ATTENDANCE_STATUSES } from '../../shared/constants/attendance.js';

const { Schema } = mongoose;

/**
 * A punch-time position.
 *
 * `accuracy` is the 95%-confidence radius in metres, as the browser's
 * `GeolocationCoordinates.accuracy` defines it. The reference discards it, so
 * its UI shows a cell-tower guess and a rooftop fix with identical confidence.
 */
const geoPointSchema = new Schema(
  {
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    accuracy: { type: Number, default: null, min: 0 },
  },
  { _id: false },
);

/**
 * Everything captured at one punch.
 *
 * Grouped rather than flattened into eight sibling fields so consent
 * withdrawal can erase a punch's capture data with one `$set` on a subtree,
 * and so a future third punch type is an added block rather than a schema
 * rewrite.
 */
const punchCaptureSchema = new Schema(
  {
    at: { type: Date, default: null },
    geo: { type: geoPointSchema, default: null },
    /**
     * The human-readable label for `geo`, resolved by reverse geocoding.
     *
     * Filled in AFTER the record is written (AD-15, defect 3) — the reference
     * blocks its punch on a Nominatim call, so a slow third party delays an
     * employee clocking in. Null here means "not resolved", never "no
     * location": the coordinates are the record, the label is a convenience.
     */
    locationLabel: { type: String, default: null, maxlength: 300 },
    /**
     * S3 object key. NOT a URL (AD-15, defect 1).
     *
     * The reference stores `/api/v1/attendance/selfie/<filename>` and serves
     * that path from an `@Public()` route — an unauthenticated, guessable
     * endpoint returning employee photographs. Storing a key instead means
     * there is no address to leak: every read goes through the permission
     * check in the storage service and gets a 60-second presigned URL.
     */
    selfieKey: { type: String, default: null, maxlength: 300 },
  },
  { _id: false },
);

const attendanceRecordSchema = new Schema(
  {
    employeeId: {
      type: Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
      index: true,
    },

    /** Midnight UTC of the attendance day. See the header note. */
    date: { type: Date, required: true },

    clockIn: { type: Date, default: null },
    clockOut: { type: Date, default: null },

    clockInCapture: { type: punchCaptureSchema, default: () => ({}) },
    clockOutCapture: { type: punchCaptureSchema, default: () => ({}) },

    source: {
      type: String,
      enum: ATTENDANCE_SOURCES,
      required: true,
      default: 'web',
    },

    /**
     * The STORED status.
     *
     * A punch writes `present`. The full-day / half-day / partial distinction
     * is derived from hours worked at read time (shared/attendance/status.js)
     * and deliberately not stored — it changes the moment the thresholds do,
     * and a stored copy would then disagree with every recomputation.
     */
    status: {
      type: String,
      enum: ATTENDANCE_STATUSES,
      required: true,
      default: 'present',
      index: true,
    },

    notes: { type: String, default: null, maxlength: 500 },

    /**
     * The device that reported this, for a biometric punch.
     *
     * Null for a web or mobile punch, where the actor is the authenticated
     * user and is already on the audit entry.
     */
    deviceId: { type: String, default: null, maxlength: 80 },

    /**
     * Set when an approved correction rewrote the times.
     *
     * The reference flips `source` to `manual` and keeps nothing else, so a
     * corrected day is indistinguishable from one HR typed in by hand. This
     * points at the correction that did it.
     */
    correctedById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    correctedAt: { type: Date, default: null },
    correctionId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true },
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/**
 * One row per employee per day.
 *
 * This is what makes the clock-in conflict check correct under a race: two
 * simultaneous clock-in requests both read "no record", both try to create one,
 * and the index refuses the second. Without it, a double-tap would produce two
 * rows for the same day and every hours calculation downstream would be wrong.
 */
attendanceRecordSchema.index({ employeeId: 1, date: 1 }, { unique: true });

/** The history list: one employee, a date range, newest first. */
attendanceRecordSchema.index({ employeeId: 1, date: -1 });

/** The team grid and any company-wide day view. */
attendanceRecordSchema.index({ date: -1 });

/**
 * The retention sweep: rows older than the cutoff that still hold a selfie.
 *
 * Sparse, because the overwhelming majority of rows carry no key once the
 * sweep has run and there is no reason to index the nulls.
 */
attendanceRecordSchema.index(
  { date: 1, 'clockInCapture.selfieKey': 1 },
  { sparse: true, name: 'attendance_selfie_retention' },
);

attendanceRecordSchema.set('toJSON', { virtuals: true });

export default mongoose.models.AttendanceRecord ||
  mongoose.model('AttendanceRecord', attendanceRecordSchema);
