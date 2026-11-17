import { recordAudit } from './auditLog.js';

/**
 * Record a refused request in the audit trail ("Access Denied").
 *
 * Called by authorize() / authorizeModule() when they answer 403, so every
 * permission refusal across the API is visible to an administrator: who, which
 * endpoint, and which permission they lacked. Never blocks or fails the
 * response - the 403 has already been decided.
 *
 * Throttled to one entry per user, method and path per minute. A screen that
 * retries, or a script hammering an endpoint, would otherwise write one row
 * per attempt and bury every other entry; one row a minute still shows that it
 * is happening, when, and by whom.
 */
const WINDOW_MS = Number(process.env.DENIED_AUDIT_WINDOW_MS) || 60_000;
const MAX_TRACKED = 5_000;
const lastLogged = new Map();

export const recordDenied = (req, required) => {
  try {
    if (process.env.NODE_ENV === 'test' && !process.env.AUDIT_DENIED_IN_TESTS) return;
    const path = (req.baseUrl || '') + (req.route?.path || req.path || '');
    const key = `${req.user?._id || 'anon'}|${req.method}|${path}`;
    const now = Date.now();
    if (now - (lastLogged.get(key) || 0) < WINDOW_MS) return;
    if (lastLogged.size >= MAX_TRACKED) lastLogged.clear();
    lastLogged.set(key, now);
    recordAudit(
      req.user || null,
      'Access Denied',
      `${req.method} ${req.originalUrl || path}: missing ${[].concat(required).join(' or ')}`,
      req,
      { meta: { required: [].concat(required), role: req.user?.role || null } },
    ).catch(() => {});
  } catch {
    // An audit failure must never change the answer.
  }
};

export default { recordDenied };
