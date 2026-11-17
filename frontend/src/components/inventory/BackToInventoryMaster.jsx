import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import { useUserStore } from "../../store/userStore";
import { canAction, canOpenInventoryMaster } from "../../utils/permissions";

/**
 * "← Back to Inventory Master", for the pages Inventory Master's action
 * buttons open: Inventory Health (Inventory Health Check) and Brands (Add
 * Brands). Neither is in the sidebar any more, so this is their way back.
 *
 * It navigates to the Inventory Master ROUTE rather than stepping back through
 * browser history, so it works the same when the page was opened from a
 * bookmark. Nothing is lost by that: Inventory Master keeps its search, brand,
 * status, sort and page in the inventory store, which outlives the page, and
 * picks them up again when it remounts.
 *
 * Offered only to a user who may open Inventory Master — the route's cell
 * (inventory.master.view) AND the page's own check — so it never leads to an
 * access-denied screen.
 */

export const INVENTORY_MASTER_PATH = "/inventory/master";

export const canReturnToInventoryMaster = (user) =>
  (!Array.isArray(user?.grants) || canAction(user, "inventory", "master", "view"))
  && canOpenInventoryMaster(user);

export const BackToInventoryMaster = () => {
  const navigate = useNavigate();
  const user = useUserStore((s) => s.user);
  if (!canReturnToInventoryMaster(user)) return null;

  return (
    <button
      type="button"
      onClick={() => navigate(INVENTORY_MASTER_PATH)}
      className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 -ml-1.5 text-xs font-bold text-slate-500 transition-colors hover:bg-slate-100 hover:text-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
    >
      <ArrowLeft size={14} aria-hidden="true" />
      Back to Inventory Master
    </button>
  );
};

export default BackToInventoryMaster;
