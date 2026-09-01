/**
 * Employee Master HTTP layer.
 *
 * Thin: validation happens in the `validate` middleware, authorization in
 * `requirePermission` plus a second check inside the service, and business
 * rules in the service. What remains here is shaping the response and writing
 * the audit entry.
 */

import * as service from './employee.service.js';
import { recordAudit } from '../../../utils/auditLog.js';
import { AUDIT_ACTIONS } from '../../../shared/constants/hrms.js';

/** GET /api/v1/hrms/employees */
export const listEmployees = async (req, res, next) => {
  try {
    const result = await service.listEmployees(req.hrmsActor, req.query);
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/employees/:id */
export const getEmployee = async (req, res, next) => {
  try {
    const employee = await service.getEmployee(req.params.id, req.hrmsActor);
    res.status(200).json({ success: true, data: employee });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/hrms/employees
 *
 * Returns the record AND a one-time temporary password, matching the
 * reference: the administrator hands it over, and it cannot be retrieved again.
 * It is never stored in plaintext, and the audit entry below does not contain
 * it.
 */
export const createEmployee = async (req, res, next) => {
  try {
    const { employee, tempPassword } = await service.createEmployee(req.body, req.hrmsActor);

    await recordAudit(
      req.user,
      'hrms.employee.created',
      `Created employee ${employee.employeeCode} (${employee.displayName})`,
      req,
      {
        meta: {
          employeeId: employee.id,
          employeeCode: employee.employeeCode,
          status: employee.status,
          // Which sensitive fields were supplied, never their values.
          sensitiveFieldsSet: sensitiveKeysPresent(employee),
        },
      },
    );

    res.status(201).json({ success: true, data: { employee, tempPassword } });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/v1/hrms/employees/:id */
export const updateEmployee = async (req, res, next) => {
  try {
    const employee = await service.updateEmployee(req.params.id, req.body, req.hrmsActor);

    await recordAudit(
      req.user,
      'hrms.employee.updated',
      `Updated employee ${employee.employeeCode}`,
      req,
      {
        meta: {
          employeeId: employee.id,
          employeeCode: employee.employeeCode,
          // FIELD NAMES ONLY. Logging the values would put a PAN or a bank
          // account number into the audit collection in plaintext, which is
          // precisely what AD-10 removed from the employee record.
          fields: Object.keys(req.body),
        },
      },
    );

    res.status(200).json({ success: true, data: employee });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/v1/hrms/employees/:id — soft delete, as the reference does. */
export const deactivateEmployee = async (req, res, next) => {
  try {
    const result = await service.deactivateEmployee(req.params.id, req.hrmsActor);

    await recordAudit(
      req.user,
      'hrms.employee.deactivated',
      `Deactivated employee ${result.employeeCode}; login suspended and sessions revoked`,
      req,
      { meta: result },
    );

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/hrms/employees/:id/reveal
 *
 * One sensitive field, in full. Separate from the read and audited every time,
 * because seeing a full PAN or bank account is the act worth recording — not
 * opening the profile.
 */
export const revealSensitiveField = async (req, res, next) => {
  try {
    const { field, reason } = req.body;
    const result = await service.revealSensitiveField(req.params.id, field, req.hrmsActor);

    await recordAudit(
      req.user,
      AUDIT_ACTIONS.SENSITIVE_FIELD_VIEWED,
      `Revealed ${field} for employee ${req.params.id}`,
      req,
      // The reason and the field name, never the value.
      { meta: { employeeId: req.params.id, field, reason: reason ?? null } },
    );

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/hrms/employees/:id/roles */
export const getEmployeeRoles = async (req, res, next) => {
  try {
    const data = await service.getEmployeeRoles(req.params.id, req.hrmsActor);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/v1/hrms/employees/:id/roles */
export const assignEmployeeRoles = async (req, res, next) => {
  try {
    const data = await service.assignEmployeeRoles(
      req.params.id,
      req.body.roleKeys,
      req.hrmsActor,
    );

    await recordAudit(
      req.user,
      'hrms.employee.roles_changed',
      `Set HRMS roles for employee ${req.params.id}: ${data.roleKeys.join(', ')}`,
      req,
      { meta: { employeeId: req.params.id, roleKeys: data.roleKeys } },
    );

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/v1/hrms/employees/:id/reset-password — super admin only. */
export const resetEmployeePassword = async (req, res, next) => {
  try {
    const data = await service.resetEmployeePassword(req.params.id, req.hrmsActor);

    await recordAudit(
      req.user,
      'hrms.employee.password_reset',
      `Reset the password for employee ${req.params.id}; sessions revoked`,
      req,
      // The temporary password is deliberately absent from the audit entry.
      { meta: { employeeId: req.params.id } },
    );

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Custom field definitions
// ---------------------------------------------------------------------------

export const listCustomFields = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await service.listCustomFields() });
  } catch (error) {
    next(error);
  }
};

export const createCustomField = async (req, res, next) => {
  try {
    const data = await service.createCustomField(req.body);
    await recordAudit(req.user, 'hrms.custom_field.created', `Created custom field "${data.name}"`, req, {
      meta: data,
    });
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const updateCustomField = async (req, res, next) => {
  try {
    const data = await service.updateCustomField(req.params.id, req.body);
    await recordAudit(req.user, 'hrms.custom_field.updated', `Updated custom field "${data.name}"`, req, {
      meta: data,
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const deleteCustomField = async (req, res, next) => {
  try {
    await service.deleteCustomField(req.params.id);
    await recordAudit(
      req.user,
      'hrms.custom_field.deleted',
      `Retired custom field ${req.params.id}; existing values are kept`,
      req,
      { meta: { id: req.params.id } },
    );
    res.status(200).json({ success: true, message: 'Custom field retired.' });
  } catch (error) {
    next(error);
  }
};

/** Which sensitive fields are on file. Presence only — never the value. */
function sensitiveKeysPresent(dto) {
  return Object.entries(dto)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
}

export default {
  listEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  deactivateEmployee,
  revealSensitiveField,
  getEmployeeRoles,
  assignEmployeeRoles,
  resetEmployeePassword,
  listCustomFields,
  createCustomField,
  updateCustomField,
  deleteCustomField,
};
