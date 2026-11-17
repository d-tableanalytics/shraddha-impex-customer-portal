import { canAction, hasPermission } from "./permissions";

/**
 * The flat permission keys behind each Customer Portal matrix cell.
 *
 * A COPY of the `actions` of every sub-module in backend/config/moduleRegistry.js
 * that serves the customer portal. cellKeys.test.js compares the two, so a
 * registry change fails the build until it is copied here.
 *
 * Used only when the server sent no `grants` (an older backend, or a login
 * response without them): the route guards then answer from the permission
 * list instead of letting everyone through. A cell admits a user holding ANY of
 * its keys, as on the server (backend utils/roleResolver.js satisfiesCell).
 */
export const CELL_KEYS = {
  "customer_portal.dashboard": { view: ["view_dashboard"] },
  "customer_portal.create_booking": { view: ["create_order", "view_all_bookings"], create: ["create_order"] },
  "customer_portal.bulk_upload": { view: ["create_order", "view_all_bookings"], create: ["create_order"] },
  "customer_portal.booking_history": { view: ["view_orders"], edit: ["edit_booking_pre_po"], delete: ["manage_orders"], approve: ["manage_orders"] },
  "customer_portal.indent_history": { view: ["view_orders"], edit: ["manage_orders"] },
  "customer_portal.catalogue": { view: ["view_catalogue"] },
  "customer_portal.profile": { view: ["view_profile"], edit: ["edit_profile"] },
  "customer_portal.support": { view: ["view_help"] },
  "sales.bookings": { view: ["view_all_bookings"], create: ["create_order"], edit: ["edit_booking_pre_po"], delete: ["override_po_lock"], approve: ["raise_po"] },
  "sales.pricing": { view: ["view_pricing"], edit: ["manage_pricing"] },
  "inventory.dashboard": { view: ["view_inventory"] },
  "inventory.master": { view: ["view_inventory"], create: ["manage_inventory_master"], edit: ["manage_inventory_master"], delete: ["delete_sku"] },
  "inventory.health": { view: ["view_inventory"] },
  "inventory.ledger": { view: ["view_stock_ledger"] },
  "inventory.indent_assignment": { view: ["assign_indent_stock"], create: ["assign_indent_stock"], edit: ["assign_indent_stock"] },
  "inventory.imports": { view: ["view_inventory"], create: ["manage_inventory_master", "post_stock_in"] },
  "inventory.product_content": { view: ["manage_inventory_master"], create: ["manage_inventory_master"], edit: ["manage_inventory_master"], delete: ["manage_inventory_master"] },
  "inventory.brands": { view: ["configure_inventory"], create: ["configure_inventory"], edit: ["configure_inventory"], delete: ["configure_inventory"] },
  "inventory.adjustments": { view: ["view_inventory"], create: ["adjust_stock"], edit: ["adjust_stock"], approve: ["approve_adjustment"] },
  "inventory.counts": { view: ["view_inventory"], create: ["perform_count"], edit: ["perform_count"], approve: ["approve_count"] },
  "inventory.receipts": { create: ["post_stock_in"] },
  "inventory.issues": { create: ["post_stock_out"] },
  "inventory.transfers": { create: ["transfer_stock"] },
  "inventory.alerts": { view: ["view_inventory"], edit: ["manage_inventory_master"], approve: ["approve_adjustment"] },
  "inventory.exports": { view: ["export_inventory"] },
  "inventory.box_numbers": { edit: ["manage_box_number"] },
  "inventory.configuration": { view: ["view_inventory"], edit: ["configure_inventory"] },
  "reports.operational": { view: ["view_reports"] },
  "administration.overview": { view: ["manage_users", "manage_roles"] },
  "administration.customers": { view: ["manage_customer_users", "manage_users"], create: ["manage_customer_users", "manage_users"], edit: ["manage_customer_users", "manage_users"], delete: ["manage_users"] },
  "administration.users": { view: ["manage_users"], create: ["create_users"], edit: ["edit_users"], delete: ["delete_users"] },
};

/** The keys behind one cell's action, or null when this bundle does not know the cell. */
export const cellKeysFor = (moduleKey, submoduleKey, action) =>
  CELL_KEYS[`${moduleKey}.${submoduleKey}`]?.[action] ?? null;

/**
 * May this user take `action` on this cell?
 *
 * With grants from the server, the grants decide (canAction). Without them, the
 * cell's keys are asked of the permission list. Returns null only when there are
 * no grants AND the cell is unknown here, so the caller decides what that means.
 */
export const canCell = (user, moduleKey, submoduleKey, action = "view") => {
  if (Array.isArray(user?.grants) || hasPermission(user, "*")) {
    return canAction(user, moduleKey, submoduleKey, action);
  }
  const keys = cellKeysFor(moduleKey, submoduleKey, action);
  if (!keys) return null;
  return keys.some((key) => hasPermission(user, key));
};
