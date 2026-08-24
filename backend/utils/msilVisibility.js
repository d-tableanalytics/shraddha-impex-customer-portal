import { INVENTORY_ROLES } from '../middlewares/rbac.js';

/**
 * Who MSIL Codes are shown to.
 *
 * MSIL Codes are only meaningful to Admins, to MSIL customers (who order by
 * them), to anyone explicitly flagged, and to internal inventory staff. For
 * everyone else the code is ignored entirely: a non-MSIL customer is never
 * failed on an MSIL Code being missing, unknown, mismatched or inactive,
 * because it does not apply to them.
 *
 * This rule was previously reimplemented in three places, and the copies had
 * already diverged — one gated search, another gated single-product lookup, and
 * neither knew about the inventory roles. Deriving the whole rule here means a
 * new role is covered everywhere at once.
 */
export const msilAppliesTo = (user) =>
  user?.role === 'Admin' ||
  // Sales work the desk for MSIL and non-MSIL customers alike, so they must be
  // able to see and quote an MSIL Code — a category is a property of the
  // customer they are serving, not of the salesperson.
  user?.role === 'Sales' ||
  user?.customerCategory === 'MSIL' ||
  user?.showMsilCode === true ||
  INVENTORY_ROLES.includes(user?.role);

export default { msilAppliesTo };
