import { create } from "zustand";
import { usersApi } from "../services/users";
import { refreshSocketAuth } from "../services/socketService";
import { useNotificationStore } from "./notificationStore";
import { resetSessionStores } from "./sessionReset";

export const useUserStore = create((set) => ({
  user: null,
  loading: !!localStorage.getItem('token'),
  error: null,

  login: async (credentials) => {
    set({ loading: true, error: null });
    try {
      const { token } = await usersApi.login(credentials);
      localStorage.setItem('token', token);

      const user = await usersApi.getCurrentUser();
      // A different account may have been signed in on this tab a moment ago,
      // and the stores keep their data on screen across refreshes now.
      resetSessionStores();
      set({ user, loading: false });
      refreshSocketAuth(); // rejoin socket rooms as the logged-in user

      return true;
    } catch (err) {
      set({ error: err.response?.data?.message || "Login failed", loading: false });
      return false;
    }
  },

  fetchUser: async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      set({ user: null, loading: false });
      return;
    }

    set({ loading: true, error: null });
    try {
      const user = await usersApi.getCurrentUser();
      set({ user, loading: false });
    } catch (err) {
      // Only a 401 means the token is actually bad. Discarding it on any error
      // (a 429, or the API being down) logs the user out over a transient blip.
      if (err.response?.status === 401) {
        localStorage.removeItem('token');
        set({ error: "Session expired", user: null, loading: false });
      } else {
        set({ error: "Could not load your session", loading: false });
      }
    }
  },

  /**
   * Re-read the signed-in user WITHOUT the loading state, so the screen stays
   * where it is. Used when something the user object carries changes
   * elsewhere — today, the brand list. Replacing `user` re-renders every
   * screen that reads it, which is what puts a new brand into dropdowns that
   * are already open.
   */
  refreshSession: async () => {
    if (!localStorage.getItem('token')) return;
    try {
      const user = await usersApi.getCurrentUser();
      set({ user });
    } catch {
      // A failed background refresh changes nothing; the next one will retry.
    }
  },

  updateProfile: async (updates) => {
    try {
      const user = await usersApi.updateProfile(updates);
      set({ user });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || 'Failed to update profile' };
    }
  },

  changePassword: async (currentPassword, newPassword) => {
    try {
      await usersApi.changePassword(currentPassword, newPassword);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || 'Failed to change password' };
    }
  },

  logout: async () => {
    // Revoke server-side first so the refresh cookie cannot be exchanged again;
    // usersApi.logout never rejects, so the local clear below always runs.
    await usersApi.logout();
    localStorage.removeItem('token');
    set({ user: null });
    resetSessionStores();
    useNotificationStore.getState().clear();
    refreshSocketAuth(); // drop out of the user/admin rooms
  },
}));

