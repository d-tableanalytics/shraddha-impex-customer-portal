/**
 * Retention handler for attendance selfies (AD-16).
 *
 * The only category AD-16 gives a concrete non-audit window to: 90 days, then
 * DELETE. The number is not here — it lives in the HrmsConfig document, and the
 * sweep passes the cutoff it derived. Nothing in this file may branch on a
 * period, and `scripts/hrms/verify-no-hardcoded-retention.js` enforces that.
 *
 * ---------------------------------------------------------------------------
 * Why this is the largest personal-data store in the system
 * ---------------------------------------------------------------------------
 * AD-15 does the arithmetic: at AD-13's headcount, two punches a day over a
 * working year is roughly 100,000 photographs of employees. The S3 cost is
 * negligible; the liability is not. This handler is what stops that pile
 * growing without bound.
 *
 * The attendance RECORD is never deleted — it is a business record and payroll
 * evidence. Only the photograph goes. That is the whole distinction: the punch
 * is why the data exists, the selfie was only ever there to verify it.
 */

import AttendanceRecord from '../../../models/hrms/AttendanceRecord.js';
import { purgeStoredObjects } from '../retention/purgeStoredObjects.js';

/**
 * Rows whose selfies are due for deletion.
 *
 * Filtered on `date` rather than `createdAt`: an approved correction updates a
 * row long after the day it describes, and keying off the update time would
 * keep resetting the clock on a photograph that is already past its window.
 */
const expiredFilter = (cutoff) => ({
  date: { $lt: cutoff },
  $or: [
    { 'clockInCapture.selfieKey': { $ne: null } },
    { 'clockOutCapture.selfieKey': { $ne: null } },
  ],
});

const KEY_FIELDS = ['clockInCapture.selfieKey', 'clockOutCapture.selfieKey'];

export const attendanceSelfieRetentionHandler = {
  description: 'Deletes attendance selfies past the configured window; keeps the punch record.',

  /**
   * The scheduled sweep.
   *
   * `action` is accepted and deliberately ignored beyond a guard: AD-16 allows
   * retain / delete / archive, and there is no archive destination for a
   * photograph — archiving one would mean moving the liability rather than
   * removing it. An `archive` rule on this category is reported as unsupported
   * rather than silently treated as a delete.
   */
  async sweep({ cutoff, action, dryRun = false, batchSize = 500 }) {
    if (action !== 'delete') {
      return {
        scanned: 0,
        affected: 0,
        notes: [
          `attendance selfies support "delete" only; the configured action is "${action}" — nothing was done`,
        ],
      };
    }

    const outcome = await purgeStoredObjects({
      model: AttendanceRecord,
      filter: expiredFilter(cutoff),
      keyFields: KEY_FIELDS,
      dryRun,
      batchSize,
    });

    return {
      scanned: outcome.scanned,
      affected: outcome.cleared,
      failed: outcome.orphaned,
      notes: [
        `${outcome.objectsDeleted} object(s) deleted from storage`,
        ...outcome.notes,
      ],
    };
  },

  /**
   * Immediate purge, outside the schedule.
   *
   * Consent withdrawal needs this (AD-15): withdrawal means erase NOW, not
   * erase eventually. Same routine, different trigger — so the ordering
   * guarantee (null the pointer, then delete the object) is identical and the
   * two paths cannot diverge.
   */
  async purgeNow({ filter, batchSize = 500 }) {
    if (!filter || Object.keys(filter).length === 0) {
      // A purge with no filter would erase every selfie in the company. That
      // is never what an immediate, targeted purge means.
      throw new Error('purgeNow requires a filter — refusing an unbounded selfie purge.');
    }

    const outcome = await purgeStoredObjects({
      model: AttendanceRecord,
      filter,
      keyFields: KEY_FIELDS,
      dryRun: false,
      batchSize,
    });

    return {
      scanned: outcome.scanned,
      affected: outcome.cleared,
      failed: outcome.orphaned,
      notes: outcome.notes,
    };
  },
};

export default attendanceSelfieRetentionHandler;
