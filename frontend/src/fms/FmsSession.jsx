import { useEffect } from "react";

import { useUserStore as usePortalUserStore } from "../store/userStore";
import { useUserStore as useFmsUserStore } from "./store/userStore";

/**
 * Keeps the FMS session (src/fms/store/userStore.js) following this portal's.
 *
 * Mounted once, in MainLayout, so it lives exactly as long as a signed-in
 * shell: loads FMS access when the portal user arrives or changes, and clears
 * it when the shell unmounts — which is what signing out does.
 */
export const FmsSession = () => {
  const portalUser = usePortalUserStore((s) => s.user);
  const portalUserId = portalUser?._id ?? null;
  const portalRole = portalUser?.role ?? null;

  useEffect(() => {
    useFmsUserStore.getState().load(portalUserId ? { _id: portalUserId, role: portalRole } : null);
  }, [portalUserId, portalRole]);

  useEffect(() => () => useFmsUserStore.getState().clear(), []);

  return null;
};

export default FmsSession;
