import { create } from "zustand";
import { hrmsMeApi, hrmsStatusApi, HrmsApiError } from "../services/hrms";

/**
 * The signed-in user's HRMS actor, plus what the HRMS foundation has built.
 *
 * Separate from userStore on purpose: the portal session and HRMS authorization
 * are two different things (AD-3), and a Customer has the first without the
 * second. Keeping them apart means the portal never waits on an HRMS request,
 * and an HRMS failure cannot break the customer portal.
 *
 * `/hrms/me` returns 403 for anyone with no HRMS role. That is the EXPECTED
 * answer for most accounts, not an error to surface.
 */
export const useHrmsStore = create((set, get) => ({
  actor: null,
  /** Module keys with a real screen behind them, from /hrms/status. */
  implementedModules: [],
  loading: false,
  loaded: false,
  error: null,

  /**
   * Load the actor and the foundation status together.
   *
   * Safe to call repeatedly; only the first call hits the API unless `force`.
   */
  load: async ({ force = false } = {}) => {
    if (get().loaded && !force) return get().actor;

    if (!localStorage.getItem("token")) {
      set({ actor: null, implementedModules: [], loaded: true, loading: false, error: null });
      return null;
    }

    set({ loading: true, error: null });

    try {
      const actor = await hrmsMeApi.get();
      // Only ask for status once we know the account has HRMS access - a
      // Customer would just get a second 403.
      const status = await hrmsStatusApi.get().catch(() => null);

      set({
        actor,
        implementedModules: status?.implementedModules ?? [],
        loading: false,
        loaded: true,
        error: null,
      });
      return actor;
    } catch (err) {
      // 403 means "no HRMS access" - a normal state for a Customer or a
      // portal-only account, and not something to report as a failure.
      const forbidden = err instanceof HrmsApiError && err.isForbidden;
      set({
        actor: null,
        implementedModules: [],
        loading: false,
        loaded: true,
        error: forbidden ? null : err?.message ?? "Could not load HRMS access.",
      });
      return null;
    }
  },

  clear: () =>
    set({ actor: null, implementedModules: [], loaded: false, loading: false, error: null }),
}));
