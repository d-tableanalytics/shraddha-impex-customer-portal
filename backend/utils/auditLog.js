import AuditLog from '../models/AuditLog.js';

/**
 * Shared audit writer.
 *
 * This existed as six near-identical private copies — one per controller — which
 * drifted: three different signatures, and only some of them recorded the
 * structured `meta` payload. One implementation means an audit field added here
 * is immediately captured by every module.
 *
 * The 5th parameter is an options object rather than a positional session/meta,
 * because that is exactly what the three previous versions disagreed about.
 *
 * Never throws. A failed audit write must not roll back the business operation
 * that triggered it — but it is logged, so a silently broken trail is visible in
 * the server output rather than invisible.
 *
 * @param {object}  user            Actor. Null for system jobs.
 * @param {string}  action          Short stable label, e.g. 'PO Generated'.
 * @param {string}  remarks         Human-readable detail.
 * @param {object} [req]            Express request, for method/endpoint/IP/agent.
 * @param {object} [options]
 * @param {object} [options.meta]   Structured before/after detail.
 * @param {object} [options.session] Mongoose session to enlist in a transaction.
 */
export const recordAudit = async (user, action, remarks, req, { meta = null, session = null } = {}) => {
  try {
    await AuditLog.create(
      [{
        user: user?._id || null,
        action,
        method: req?.method || 'SYSTEM',
        endpoint: req?.originalUrl || 'N/A',
        ipAddress: req?.ip || '127.0.0.1',
        userAgent: req?.headers?.['user-agent'] || 'ERP SYSTEM',
        remarks,
        meta,
      }],
      session ? { session } : {},
    );
  } catch (error) {
    console.error(`[Audit] Failed to record "${action}":`, error.message);
  }
};

/**
 * Audit entry for a background job — no user, no request. Kept separate so a
 * system action is never mistaken for one a person performed.
 */
export const recordSystemAudit = async (action, remarks, meta = null) => {
  try {
    await AuditLog.create({
      action,
      method: 'SYSTEM_JOB',
      endpoint: 'N/A',
      ipAddress: '127.0.0.1',
      userAgent: 'ERP BACKGROUND JOB',
      remarks,
      meta,
    });
  } catch (error) {
    console.error(`[Audit] Failed to record system event "${action}":`, error.message);
  }
};

export default { recordAudit, recordSystemAudit };
