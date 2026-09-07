/**
 * Turning submitted sensitive values into their stored form (AD-10).
 *
 * Its own module because BOTH write paths need it and there must be exactly one
 * implementation: the employee service, and the import persistence port. The
 * port previously computed these values and then dropped them on the floor, so
 * an imported PAN, bank account, IFSC or Aadhaar was silently never stored -
 * which looks identical to a successful import until someone opens the record.
 *
 * It lives here rather than in the service because the port is the lower layer:
 * a port importing a service would invert the dependency.
 */

import Employee from '../../../models/hrms/Employee.js';
import { encryptField, blindIndex } from '../../../utils/hrms/crypto/index.js';
import { encPath, idxPath } from '../../../models/hrms/plugins/sensitiveFields.js';
import {
  SENSITIVE_EMPLOYEE_FIELD_LIST,
  BLIND_INDEXED_FIELDS,
} from '../../../shared/security/sensitive-fields.js';
import { HrmsConflictError } from '../hrms.errors.js';

/**
 * Turn submitted sensitive values into their stored form.
 *
 * Runs BEFORE any write. Returns the `$set` fragment — ciphertext envelope plus
 * blind index — so the caller never handles a plaintext value again.
 *
 * A blind index is required for uniqueness: the ciphertext differs on every
 * write (random IV), so an equality query could never find a duplicate PAN.
 */
export async function buildSensitiveUpdate(dto, { employeeId = null } = {}) {
  const $set = {};

  for (const field of SENSITIVE_EMPLOYEE_FIELD_LIST) {
    if (!(field in dto)) continue;
    const value = dto[field];

    if (value === null || value === '') {
      $set[encPath(field)] = null;
      if (BLIND_INDEXED_FIELDS.includes(field)) $set[idxPath(field)] = null;
      continue;
    }

    $set[encPath(field)] = await encryptField(value);

    if (BLIND_INDEXED_FIELDS.includes(field)) {
      const index = blindIndex(value);
      const clash = await Employee.findOne({
        [idxPath(field)]: index,
        deletedAt: null,
        ...(employeeId ? { _id: { $ne: employeeId } } : {}),
      })
        .select('employeeCode')
        .lean();
      if (clash) {
        // Names the field, never the value — the whole point of the index is
        // that the value is not readable from it.
        throw new HrmsConflictError(
          `Another employee (${clash.employeeCode}) already has this ${field}.`,
          { code: 'SENSITIVE_VALUE_DUPLICATE' },
        );
      }
      $set[idxPath(field)] = index;
    }
  }

  return $set;
}
