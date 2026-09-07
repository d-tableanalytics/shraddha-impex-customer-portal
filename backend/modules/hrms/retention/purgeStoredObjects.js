/**
 * The null-the-pointer-then-delete-the-object routine (AD-16).
 *
 * Shared by every retention handler that expires a stored file, and by consent
 * withdrawal (AD-15), which needs the same deletion with a different trigger.
 *
 * ---------------------------------------------------------------------------
 * The ORDER is the whole point
 * ---------------------------------------------------------------------------
 * A file lives in S3; its key lives in MongoDB. Deleting one without the other
 * leaves either a broken image or an orphaned object.
 *
 *   1. Null the database pointer FIRST.
 *   2. Then delete the S3 object.
 *   3. Tolerate an S3 failure: the row is already clean, so what remains is an
 *      orphan, which the bucket's lifecycle rule reaps. The lifecycle window is
 *      deliberately LONGER than the application policy so it never pre-empts
 *      it - it exists to guarantee an upper bound, not to enforce the decision.
 *
 * The reverse order risks a live pointer to a missing object: a presigned URL
 * that 404s, in the UI, on an employee's own record. A broken image is a bug
 * the user sees; an orphan is a cost nobody sees.
 */

import { deleteObjects as deleteObjectsFromStorage } from '../../../utils/hrms/storage/index.js';

/**
 * @param {object} params
 * @param {import('mongoose').Model} params.model
 * @param {object}   params.filter        which documents to purge
 * @param {string[]} params.keyFields     document paths holding object keys
 * @param {boolean} [params.dryRun=false]
 * @param {number}  [params.batchSize=500]
 * @param {Function} [params.deleteObjects]  injectable for tests; defaults to
 *   the real storage deleter. ESM namespace objects are frozen, so a seam here
 *   is the only way to assert the ordering below without a live bucket - and
 *   the ordering is the entire reason this function exists.
 * @returns {Promise<{ scanned: number, cleared: number, objectsDeleted: number,
 *                     orphaned: number, notes: string[] }>}
 */
export async function purgeStoredObjects({
  model,
  filter,
  keyFields,
  dryRun = false,
  batchSize = 500,
  deleteObjects = deleteObjectsFromStorage,
}) {
  const notes = [];
  let scanned = 0;
  let cleared = 0;
  let objectsDeleted = 0;
  let orphaned = 0;

  // Batched (AD-13): the first run over a long backlog must not load everything
  // into a process capped at 400 MB, and batch boundaries also yield the event
  // loop so a sweep cannot stall customer-facing requests.
  for (;;) {
    const projection = keyFields.reduce((acc, f) => ({ ...acc, [f]: 1 }), { _id: 1 });
    const batch = await model.find(filter).select(projection).limit(batchSize).lean();
    if (batch.length === 0) break;

    scanned += batch.length;

    const keys = [];
    const ids = [];
    for (const doc of batch) {
      ids.push(doc._id);
      for (const field of keyFields) {
        const value = field.split('.').reduce((o, part) => o?.[part], doc);
        if (value) keys.push(value);
      }
    }

    if (dryRun) {
      notes.push(`[dry run] would clear ${ids.length} pointer(s) and delete ${keys.length} object(s)`);
      // Without a write the filter would keep matching the same rows forever.
      break;
    }

    // 1. Pointer first.
    const unset = keyFields.reduce((acc, f) => ({ ...acc, [f]: null }), {});
    const res = await model.updateMany({ _id: { $in: ids } }, { $set: unset });
    cleared += res.modifiedCount ?? ids.length;

    // 2. Then the objects. 3. Failures become orphans, not a stalled sweep.
    if (keys.length > 0) {
      const outcome = await deleteObjects(keys);
      objectsDeleted += outcome.deleted.length;
      orphaned += outcome.failed.length;
      for (const f of outcome.failed) {
        notes.push(`orphaned ${f.key}: ${f.error} (the S3 lifecycle rule will reap it)`);
      }
    }

    if (batch.length < batchSize) break;
  }

  return { scanned, cleared, objectsDeleted, orphaned, notes };
}

export default purgeStoredObjects;
