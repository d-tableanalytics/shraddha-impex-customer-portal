import { create } from "zustand";
import { api } from "../services/api";

/**
 * The signed-in user's HRMS actor.
 *
 * Separate from userStore on purpose: the portal session and HRMS
 * authorization are two different things (AD-3), and a Customer has the first
 * without the second. Keeping them apart means the portal never waits on an
 * HRMS request, and an HRMS failure cannot break the customer portal.
 *
 * `/hrms/me` returns 403 for anyone with no HRMS role, which is the expected
 * answer for most accounts - not an error to report.
 */
export const useHrmsStore = create((set, get) => ({
  actor: null,
  loading: false,
  loaded: false,

  /**
   * Fetch the actor. Safe to call repeatedly; only the first call hits the API
   * unless `force` is passed.
   */
  fetchActor: async ({ force = false } = {}) => {
    if (get().loaded && !force) return get().actor;
    if (!localStorage.getItem("token")) {
      set({ actor: null, loaded: true, loading: false });
      return null;
    }

    set({ loading: true });
    try {
      const res = await api.get("/hrms/me");
      const actor = res.data.data;
      set({ actor, loading: false, loaded: true });
      return actor;
    } catch (err) {
      // 403 means "no HRMS access", which is a normal state for a Customer or
      // a portal-only account — not a failure worth surfacing.
      if (err.response?.status === 403) {
        set({ actor: null, loading: false, loaded: true });
        return null;
      }
      set({ loading: false, loaded: true });
      return null;
    }
  },

  clear: () => set({ actor: null, loaded: false, loading: false }),
}));
