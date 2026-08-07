import { useUserStore } from "../store/userStore";
import { INVENTORY_ROLES } from "../utils/permissions";

/**
 * Who MSIL Codes are shown to.
 *
 * MSIL Codes are only meaningful to Admins, to Sales (who work the desk for
 * both kinds of customer), to MSIL customers themselves, to anyone explicitly
 * flagged, and to internal inventory staff. A Non-MSIL customer never sees or
 * enters one, so it stays hidden from their tables, forms, templates and
 * exports.
 *
 * MUST MATCH msilAppliesTo() in backend/utils/msilVisibility.js. The two had
 * already drifted: the server granted visibility to the inventory roles and
 * this copy did not, so an Inventory Manager was served MSIL data by the API
 * and then had the column hidden from them in the UI.
 */
export const useShowMsilCode = () => {
  const user = useUserStore((s) => s.user);
  return (
    user?.role === "Admin" ||
    user?.role === "Sales" ||
    user?.customerCategory === "MSIL" ||
    user?.showMsilCode === true ||
    INVENTORY_ROLES.includes(user?.role)
  );
};

export default useShowMsilCode;
