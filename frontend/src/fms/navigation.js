import { canUseO2d, hasPermission, PERMISSIONS } from "./utils/permissions";
import { o2dRoute } from "./shared/constants/o2d.js";

/**
 * The FMS group in this portal's sidebar.
 *
 * Built on the client, from the FMS session, because this portal's server menu
 * cannot contain it: the registry tags the o2d module as the Employee Portal's,
 * and changing that tag is a shared-contract change that would alter how every
 * role resolves in both portals. The items, labels and gating are the Employee
 * Portal sidebar's own (its `o2dSections`), in this sidebar's group shape.
 *
 * @param {object|null} fmsUser the user as the Employee API resolves them.
 * @returns {object|null} a sidebar group, or null when FMS is not offered.
 */
export const fmsNavGroup = (fmsUser) => {
  if (!fmsUser || !canUseO2d(fmsUser)) return null;

  const item = (key, label, icon) => ({ id: `o2d.${key}`, key, label, path: o2dRoute(key), icon });

  return {
    key: "o2d",
    label: "FMS",
    icon: "Truck",
    alwaysGrouped: true,
    items: [
      item("tasks", "My Tasks", "ListChecks"),
      item("orders", "Order Tracker", "Truck"),
      item("stages", "Stages", "LayoutGrid"),
      item("history", "Order History", "History"),
      item("exits", "Exit Register", "Ban"),
      ...(hasPermission(fmsUser, PERMISSIONS.VIEW_O2D_ANALYTICS)
        ? [item("analytics", "Analytics", "BarChart3")]
        : []),
    ],
  };
};

/**
 * Place the FMS group where the registry orders it: after the Sales Desk, ahead
 * of Inventory. Groups that are not there are skipped over, and with neither it
 * goes last, ahead of nothing the caller moves afterwards.
 */
export const withFmsGroup = (groups, fmsGroup) => {
  if (!fmsGroup) return groups;
  const after = groups.findIndex((g) => g.key === "sales");
  const before = groups.findIndex((g) => g.key === "inventory");
  const at = after >= 0 ? after + 1 : before >= 0 ? before : groups.length;
  return [...groups.slice(0, at), fmsGroup, ...groups.slice(at)];
};

export default fmsNavGroup;
