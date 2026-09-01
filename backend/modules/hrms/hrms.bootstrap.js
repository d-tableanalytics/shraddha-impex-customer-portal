/**
 * HRMS startup wiring.
 *
 * Registers the handlers and access rules that the generic machinery looks up
 * at runtime. Called once from server.js, alongside the portal's own seeders.
 *
 * Registration is explicit and central rather than a side effect of importing a
 * module, so what is active in a running system is answerable by reading one
 * file - and so importing a service from a script does not silently arm a
 * background behaviour. The portal made the same choice for its alert
 * subscriber, for the same reason.
 */

import { registerRetentionHandler } from './retention/retention.registry.js';
import { auditRetentionHandler } from './retention/auditRetention.handler.js';
import { RETENTION_CATEGORIES } from '../../shared/constants/hrms.js';

/**
 * Wire up the HRMS foundation.
 *
 * Phase 0 registers what Phase 0 owns. Later phases add their own:
 *   attendance  -> the selfie retention handler + its file access rule
 *   employees   -> the employee resolver for the HRMS actor
 *   payroll     -> payslip and bank-file access rules
 */
export function bootstrapHrms() {
  registerRetentionHandler(RETENTION_CATEGORIES.AUDIT_LOG, auditRetentionHandler);

  return {
    retentionHandlers: [RETENTION_CATEGORIES.AUDIT_LOG],
  };
}

export default bootstrapHrms;
