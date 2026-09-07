/**
 * Retention handler for employee documents (AD-16).
 *
 * `RETENTION_CATEGORIES.EMPLOYEE_DOCUMENTS` already existed before this module,
 * with the default policy `{ days: null, action: 'retain' }` — keep forever.
 * That default is correct and is not changed here: a signed contract, a PAN
 * copy or an educational certificate is the evidence behind an employment
 * relationship, and deleting it on a timer is how an organisation loses a
 * tribunal.
 *
 * What this adds is the HANDLER. Without one the sweep reports the category as
 * unimplemented, so an administrator who later sets a window would see a rule
 * that looks enforced and deletes nothing. Registering it makes the configured
 * policy real — including the default, which does nothing and says so.
 *
 * Only the OBJECT is purged, never the record. A document row carries who
 * uploaded what and when, and the acknowledgment register points at it; the
 * bytes are the liability, the row is the history. This is the same
 * distinction the attendance selfie handler draws between a punch and a photo.
 *
 * Company library documents are deliberately out of scope: a policy everyone
 * acknowledged is a compliance record, not personal data, and nothing in the
 * reference or in AD-16 puts a clock on it.
 */

import { HrmsDocument } from '../../../models/hrms/DocumentModels.js';
import { purgeStoredObjects } from '../retention/purgeStoredObjects.js';

/**
 * Personal documents whose objects are past the window.
 *
 * Filtered on `uploadedAt` — the moment the file entered the system, which is
 * what the window is measured from. Already-purged rows are excluded so a
 * second sweep does not rescan them.
 */
const expiredFilter = (cutoff) => ({
  scope: 'employee',
  uploadedAt: { $lt: cutoff },
  storageKey: { $ne: null },
});

const KEY_FIELDS = ['storageKey'];

export const documentRetentionHandler = {
  description:
    'Deletes the stored file behind an employee document past the configured window; keeps the record.',

  async sweep({ cutoff, action, dryRun = false, batchSize = 500 }) {
    // `retain` is the default for this category and means exactly that.
    if (action === 'retain') {
      return {
        scanned: 0,
        affected: 0,
        notes: ['employee documents are set to retain; nothing was deleted'],
      };
    }
    if (action !== 'delete') {
      // Archiving a contract would move the liability rather than remove it,
      // and there is no archive destination for one. Reported, not guessed.
      return {
        scanned: 0,
        affected: 0,
        notes: [
          `employee documents support "retain" and "delete"; the configured action is "${action}" — nothing was done`,
        ],
      };
    }

    const outcome = await purgeStoredObjects({
      model: HrmsDocument,
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
        `${outcome.objectsDeleted} document object(s) deleted from storage`,
        ...outcome.notes,
      ],
    };
  },
};

export default documentRetentionHandler;
