/**
 * HRMS foundation endpoints.
 */

import { modulesForHrmsRoles } from '../../shared/permissions/matrix.js';
import { HRMS_ROLE_LABELS } from '../../shared/permissions/constants.js';

/**
 * GET /api/v1/hrms/me
 *
 * The payload the entire frontend HRMS authorization layer is built on: role
 * keys, the flattened grant list, and the modules those grants reach.
 *
 * The permission list is sent in full so the client can evaluate the SAME
 * `hasHrmsPermission` the server uses, rather than reimplementing the rules.
 * It describes what this account may do; it is not a credential, and the server
 * re-checks every request regardless.
 */
export const getHrmsMe = async (req, res, next) => {
  try {
    const actor = req.hrmsActor;

    res.status(200).json({
      success: true,
      data: {
        userId: actor.userId,
        employeeId: actor.employeeId,
        departmentId: actor.departmentId,
        managerChain: actor.managerChain,
        roleKeys: actor.roleKeys,
        roleLabels: actor.roleKeys.map((k) => HRMS_ROLE_LABELS[k] ?? k),
        permissions: actor.permissions,
        modules: modulesForHrmsRoles(actor.roleKeys),
      },
    });
  } catch (error) {
    next(error);
  }
};

export default { getHrmsMe };
