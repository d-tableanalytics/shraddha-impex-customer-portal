/**
 * Retention handler for the audit log (AD-16).
 *
 * A scheduled job, deliberately NOT a MongoDB TTL index:
 *   - a TTL index can only delete, never archive, and AD-16 allows either
 *   - its window lives in the index definition, which is the opposite of the
 *     "configurable, never hardcoded" requirement
 *
 * ---------------------------------------------------------------------------
 * The sweep's own trail must outlive its own window
 * ---------------------------------------------------------------------------
 * Deleting audit rows without recording that they were deleted destroys the
 * very trail the log exists to provide. The sweep writes a summary - and that
 * summary is itself an audit row, so it would eventually be deleted by a later
 * sweep. RETENTION_EXEMPT_AUDIT_ACTIONS is excluded from the filter, which is
 * what stops the record of deletion being deleted.
 *
 * Archiving writes compressed JSONL to S3 under SSE-KMS before removal, because
 * Indian payroll retention commonly runs 7-8 years and a blanket 3-year delete
 * could conflict with it. `archive` is therefore the configured default.
 */

import zlib from 'node:zlib';
import { promisify } from 'node:util';

import AuditLog from '../../../models/AuditLog.js';
import { putObject } from '../../../utils/hrms/storage/index.js';
import {
  RETENTION_ACTIONS,
  RETENTION_EXEMPT_AUDIT_ACTIONS,
  STORAGE_CATEGORIES,
} from '../../../shared/constants/hrms.js';

const gzip = promisify(zlib.gzip);

export const auditRetentionHandler = {
  description: 'Archives or deletes audit rows older than the configured window.',

  async sweep({ cutoff, action, dryRun = false, batchSize = 500 }) {
    const filter = {
      createdAt: { $lt: cutoff },
      // Never expire the record that data was expired.
      action: { $nin: RETENTION_EXEMPT_AUDIT_ACTIONS },
    };

    const scanned = await AuditLog.countDocuments(filter);
    if (scanned === 0) {
      return { scanned: 0, affected: 0, notes: ['nothing older than the cutoff'] };
    }

    if (dryRun) {
      return {
        scanned,
        affected: 0,
        notes: [`[dry run] would ${action} ${scanned} audit row(s) older than ${cutoff.toISOString()}`],
      };
    }

    const notes = [];
    let affected = 0;

    for (;;) {
      const batch = await AuditLog.find(filter).sort({ createdAt: 1 }).limit(batchSize).lean();
      if (batch.length === 0) break;

      if (action === RETENTION_ACTIONS.ARCHIVE) {
        const jsonl = batch.map((row) => JSON.stringify(row)).join('\n');
        const { key } = await putObject({
          category: STORAGE_CATEGORIES.AUDIT_ARCHIVE,
          body: await gzip(Buffer.from(jsonl, 'utf8')),
          contentType: 'application/gzip',
          scope: String(cutoff.getUTCFullYear()),
          filename: 'audit.jsonl.gz',
        });
        notes.push(`archived ${batch.length} row(s) to ${key}`);
      }

      const ids = batch.map((r) => r._id);
      const res = await AuditLog.deleteMany({ _id: { $in: ids } });
      affected += res.deletedCount ?? ids.length;

      if (batch.length < batchSize) break;
    }

    return { scanned, affected, notes };
  },
};

export default auditRetentionHandler;
