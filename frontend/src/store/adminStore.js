import { create } from "zustand";
import { adminApi } from "../services/admin";

export const useAdminStore = create((set, get) => ({
  users: [],
  roles: [],
  /** { actions: [...], modules: [...] } - the catalogue the matrix renders. */
  registry: null,
  // True by default: the admin screens fetch on mount, so their tables show
  // skeleton rows from first paint instead of a brief "no records" flash.
  loading: true,
  error: null,

  fetchUsers: async () => {
    set({ loading: true, error: null });
    try {
      const users = await adminApi.getUsers();
      set({ users, loading: false });
    } catch (err) {
      set({ error: err.response?.data?.message || "Failed to fetch users", loading: false });
    }
  },

  fetchRoles: async () => {
    set({ loading: true, error: null });
    try {
      const roles = await adminApi.getRoles();
      set({ roles, loading: false });
    } catch (err) {
      set({ error: err.response?.data?.message || "Failed to fetch roles", loading: false });
    }
  },

  createUser: async (payload) => {
    try {
      const newUser = await adminApi.createUser(payload);
      set((state) => ({ users: [newUser, ...state.users] }));
      return { success: true };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || "Failed to create user" };
    }
  },

  updateUser: async (userId, updates) => {
    try {
      const updatedUser = await adminApi.updateUser(userId, updates);
      set((state) => ({
        users: state.users.map((u) => (u._id === userId ? updatedUser : u)),
      }));
      return { success: true };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || "Failed to update user" };
    }
  },

  resetUserPassword: async (userId, newPassword) => {
    try {
      await adminApi.resetUserPassword(userId, newPassword);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || "Failed to reset password" };
    }
  },

  updateUserRole: async (userId, roleId) => {
    try {
      const updatedUser = await adminApi.updateUserRole(userId, roleId);
      set((state) => ({
        users: state.users.map((u) => (u._id === userId ? updatedUser : u))
      }));
      return true;
    } catch (err) {
      set({ error: err.response?.data?.message || "Failed to update user role" });
      return false;
    }
  },

  updateRolePermissions: async (roleId, permissions) => {
    try {
      const updatedRole = await adminApi.updateRolePermissions(roleId, permissions);
      set((state) => ({
        roles: state.roles.map((r) => (r._id === roleId ? updatedRole : r))
      }));
      return true;
    } catch (err) {
      set({ error: err.response?.data?.message || "Failed to update role permissions" });
      return false;
    }
  },

  /**
   * Roles and the module catalogue together.
   *
   * One action rather than two, because the matrix cannot render either without
   * the other: roles alone have no columns, the catalogue alone has no ticks.
   * Fetching them separately means two loading states for one screen and a
   * window where the table is half-drawn.
   */
  /**
   * Role names for the user-management dropdown.
   *
   * Deliberately does NOT set `loading`. That flag is shared with fetchUsers,
   * and the users table renders its skeleton from it - flipping it here would
   * blank a table that has already loaded, just to fetch a list used to fill a
   * <select>.
   *
   * A failure is swallowed for the same reason: the built-in roles are known to
   * the bundle, so the dropdown still works. Only the custom roles are missing,
   * and an error toast about a background fetch the user did not ask for is
   * noise on a screen whose real job succeeded.
   */
  fetchAssignableRoles: async () => {
    try {
      const roles = await adminApi.getRoles();
      set({ roles });
    } catch {
      // Built-in roles remain assignable; custom ones simply are not offered.
    }
  },

  /**
   * The module catalogue on its own.
   *
   * For screens that need the registry but not the whole role matrix - the
   * per-user access modal, which is opened from a row and should not make the
   * users table flicker. Skips the fetch if the registry is already in hand,
   * because it changes only when the code does.
   */
  fetchRegistry: async () => {
    if (get().registry) return true;
    try {
      set({ registry: await adminApi.getModuleRegistry() });
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Save one account's extra access.
   *
   * The server returns the account with its RESOLVED permissions, so the local
   * copy is replaced wholesale rather than patched with what was sent - the two
   * differ wherever the role already granted something the modal also ticked.
   */
  updateUserAccess: async (userId, extraGrants) => {
    try {
      const updated = await adminApi.updateUserAccess(userId, extraGrants);
      set((state) => ({
        users: state.users.map((u) => (u._id === userId ? { ...u, ...updated } : u)),
      }));
      return { success: true, user: updated };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || "Failed to update access" };
    }
  },

  fetchRoleMatrix: async () => {
    set({ loading: true, error: null });
    try {
      const [roles, registry] = await Promise.all([
        adminApi.getRoles(),
        adminApi.getModuleRegistry(),
      ]);
      set({ roles, registry, loading: false });
      return true;
    } catch (err) {
      set({
        error: err.response?.data?.message || "Failed to load roles and permissions",
        loading: false,
      });
      return false;
    }
  },

  createRole: async (payload) => {
    try {
      const role = await adminApi.createRole(payload);
      set((state) => ({ roles: [...state.roles, role] }));
      return { success: true, role };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || "Failed to create role" };
    }
  },

  /**
   * Save one role's matrix.
   *
   * The server returns the role as it now RESOLVES - baseline included - so the
   * response replaces the local copy rather than the optimistic edit being kept.
   * A role can end up holding more than was ticked (its compiled-in floor), and
   * showing the ticks instead of the truth is how a screen starts lying about
   * access.
   */
  updateRole: async (roleId, updates) => {
    try {
      const role = await adminApi.updateRole(roleId, updates);
      set((state) => ({ roles: state.roles.map((r) => (r._id === roleId ? role : r)) }));
      return { success: true, role };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || "Failed to update role" };
    }
  },

  deleteRole: async (roleId) => {
    try {
      await adminApi.deleteRole(roleId);
      set((state) => ({ roles: state.roles.filter((r) => r._id !== roleId) }));
      return { success: true };
    } catch (err) {
      return { success: false, error: err.response?.data?.message || "Failed to delete role" };
    }
  },
}));
