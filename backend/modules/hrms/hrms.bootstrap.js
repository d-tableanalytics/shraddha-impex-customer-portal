/**
 * HRMS startup wiring.
 *
 * Registers the handlers, access rules and providers that the generic
 * machinery looks up at runtime. Called once from server.js, alongside the
 * portal's own seeders.
 *
 * Registration is explicit and central rather than a side effect of importing a
 * module, so what is active in a running system is answerable by reading one
 * file - and so importing a service from a script does not silently arm a
 * background behaviour. The portal made the same choice for its alert
 * subscriber, for the same reason.
 */

import { registerRetentionHandler } from './retention/retention.registry.js';
import { auditRetentionHandler } from './retention/auditRetention.handler.js';
import { setEmployeeResolver } from '../../middlewares/hrmsAuth.js';
import {
  resolveEmployeeByUser,
  describe as describeReferences,
} from './references/reference.service.js';
import { RETENTION_CATEGORIES } from '../../shared/constants/hrms.js';

/**
 * Wire up the HRMS foundation.
 *
 * Phase 1 registers what Phase 1 owns. Later phases add their own:
 *   employees   -> the employee reference PROVIDER (see below)
 *   org         -> the department and location providers
 *   attendance  -> the selfie retention handler + its file access rule
 *   payroll     -> payslip and bank-file access rules
 */
export function bootstrapHrms() {
  registerRetentionHandler(RETENTION_CATEGORIES.AUDIT_LOG, auditRetentionHandler);

  /**
   * Bridge the actor's employee lookup onto the reference service.
   *
   * Phase 0 left `setEmployeeResolver` as a hook; this connects it to the one
   * abstraction that resolves employees, so there is a single implementation
   * rather than the guard growing its own.
   *
   * Until the Employee Master registers a provider, `resolveEmployeeByUser`
   * throws HrmsNotImplementedError. Returning null instead would be wrong in a
   * way that is hard to see: the actor would silently carry no departmentId and
   * an empty managerChain, and every `team` and `department` scope check would
   * quietly evaluate against nothing. Failing is the safe direction.
   *
   * The one case that must NOT fail is an actor with no employee record at all
   * - an HR admin who is not themselves an employee is legitimate - so a
   * genuine null from a registered provider passes through untouched.
   */
  setEmployeeResolver(async (userId) => {
    if (!describeReferences().employee) {
      // No provider yet. The guard treats this as "no employee context", which
      // is correct for Phase 1: no module needs team scope until one exists.
      return null;
    }
    return resolveEmployeeByUser(userId);
  });

  return {
    retentionHandlers: [RETENTION_CATEGORIES.AUDIT_LOG],
    references: describeReferences(),
  };
}

export default bootstrapHrms;
