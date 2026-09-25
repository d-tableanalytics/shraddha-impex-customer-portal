import { create } from 'zustand';

import { api } from '../services/api';
import { FMS_API_CONFIGURED } from '../services/apiBase';

/**
 * ADAPTER — this portal's own file, not a copy. See scripts/fms-port.mjs.
 *
 * The signed-in user AS THE EMPLOYEE API SEES THEM, which is what every FMS
 * screen asks about. Same export and shape as the Employee Portal's
 * `useUserStore` — `{ user, loading }`, `user.permissions` — so the verbatim
 * screens and their tests use it unchanged.
 *
 * NOT this portal's session store (src/store/userStore.js). That one holds the
 * user as THIS server resolves them, and this server's portal fence strips
 * every O2D permission by design (the o2d module serves the Employee Portal).
 * Asking it whether someone may use FMS would always answer no. The server
 * that enforces O2D is the one that should say who may use it, so this store
 * reads that server's `/auth/me`.
 *
 * Loaded by <FmsSession/> (src/fms/FmsSession.jsx) whenever this portal's user
 * changes, and cleared when they sign out. A failure leaves `user` null, which
 * every FMS surface reads as "not offered" — never as a reason to sign out.
 */

/** Accounts FMS is never offered to. Their token would be refused anyway. */
const PORTAL_ONLY_ROLES = new Set(['Customer']);

let requestSeq = 0;

export const useUserStore = create((set, get) => ({
  user: null,
  loading: FMS_API_CONFIGURED && !!localStorage.getItem('token'),
  error: null,
  /** The portal user this FMS session belongs to. */
  forUserId: null,

  /**
   * Resolve FMS access for this portal user.
   *
   * @param {object|null} portalUser this portal's signed-in user, or null.
   */
  load: async (portalUser) => {
    const portalUserId = portalUser?._id ? String(portalUser._id) : null;

    if (!FMS_API_CONFIGURED || !portalUserId || PORTAL_ONLY_ROLES.has(portalUser.role)) {
      get().clear();
      return;
    }
    if (get().forUserId === portalUserId && get().user) return;

    // A different person than the last load: drop the previous answer at once,
    // so their FMS menu cannot linger while this request is in flight.
    const seq = ++requestSeq;
    set({ user: null, loading: true, error: null, forUserId: portalUserId });

    try {
      const res = await api.get('/auth/me');
      if (seq !== requestSeq) return;
      const user = res.data?.data ?? null;
      // The token is shared with the rest of the portal; if it changed hands
      // mid-request, this answer describes somebody else.
      if (!user || String(user._id) !== portalUserId) {
        set({ user: null, loading: false, error: 'mismatch' });
        return;
      }
      set({ user, loading: false });
    } catch (error) {
      if (seq !== requestSeq) return;
      set({
        user: null,
        loading: false,
        error: error?.response ? `refused (${error.response.status})` : 'unreachable',
      });
    }
  },

  clear: () => {
    requestSeq += 1;
    set({ user: null, loading: false, error: null, forUserId: null });
  },
}));

export default useUserStore;
