import { hasPermission, PERMISSIONS } from '../middlewares/rbac.js';

/**
 * Who the box number is shown to ON A BOOKING'S LINE ITEMS.
 *
 * Sales and Admin only. The box number is the physical picking location for a
 * SKU: the desk quotes it and the warehouse reads it off, but the customer who
 * placed the booking has no use for it and should not be told where in the
 * building their goods sit.
 *
 * Derived from VIEW_ALL_BOOKINGS rather than listing roles, because that is
 * already the permission separating "works the sales queue" from "owns this one
 * booking", and it is the same predicate getOrders() uses to decide whether a
 * caller sees every customer's orders or only their own. Tying the two together
 * means a new desk role cannot end up able to see the bookings but not the
 * boxes it has to pick from.
 *
 * MUST MATCH canViewLineItemBoxNo() in frontend/src/utils/permissions.js.
 *
 * Note this is NARROWER than who sees a box number on the INVENTORY screens,
 * where the inventory roles need it too — that rule is canViewBoxNo() on the
 * frontend and is enforced by the inventory routes' own permissions.
 */
export const boxNoAppliesTo = (user) => hasPermission(user, PERMISSIONS.VIEW_ALL_BOOKINGS);

/**
 * Who the box number is shown to ON THE INVENTORY AND CATALOGUE SCREENS.
 *
 * Wider than boxNoAppliesTo: the inventory roles pick and count against the box
 * and need it on the master list, even though they never work a booking's line
 * items. Derived from VIEW_INVENTORY, which resolves to exactly Admin, Sales,
 * Inventory Manager, Warehouse User and Management — a Customer holds only
 * CREATE_ORDER and so is excluded.
 *
 * MUST MATCH canViewBoxNo() in frontend/src/utils/permissions.js.
 */
export const catalogueBoxNoAppliesTo = (user) =>
  hasPermission(user, PERMISSIONS.VIEW_INVENTORY);

/**
 * Strip `boxNo` from an order row, or an array of them, for a caller who may
 * not see it.
 *
 * Hiding the column in the UI is not enough on its own: the orders endpoint
 * serves the customer their own bookings, so without this the value still
 * arrives in the JSON and is one devtools panel away. Returns plain objects,
 * since a Mongoose document cannot have a path deleted from it.
 */
// COPY, then delete. Returning `d` itself for a plain object and deleting the
// key off it mutates the caller's data — invisible for a hydrated Mongoose
// document, where toObject() already hands back a copy, but a `.lean()` query
// returns plain objects and those would be edited in place.
const strip = (docs, allowed) => {
  if (allowed) return docs;
  const hide = (d) => {
    if (!d || typeof d !== 'object') return d;
    const o = typeof d.toObject === 'function' ? d.toObject() : { ...d };
    delete o.boxNo;
    return o;
  };
  return Array.isArray(docs) ? docs.map(hide) : hide(docs);
};

export const withBoxNoVisibility = (docs, user) => strip(docs, boxNoAppliesTo(user));

/** As above, for product/catalogue rows rather than booking line items. */
export const withCatalogueBoxNoVisibility = (docs, user) =>
  strip(docs, catalogueBoxNoAppliesTo(user));

export default {
  boxNoAppliesTo,
  catalogueBoxNoAppliesTo,
  withBoxNoVisibility,
  withCatalogueBoxNoVisibility,
};
