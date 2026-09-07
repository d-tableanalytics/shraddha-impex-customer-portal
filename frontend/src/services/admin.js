import { api } from './api';

export const adminApi = {
  getUsers: async () => {
    const response = await api.get('/users');
    return response.data.data;
  },

  updateUserRole: async (userId, roleId) => {
    const response = await api.put(`/users/${userId}/roles`, { roleIds: [roleId] });
    return response.data.data;
  },

  createUser: async (payload) => {
    const response = await api.post('/users', payload);
    return response.data.data;
  },

  updateUser: async (userId, updates) => {
    const response = await api.patch(`/users/${userId}`, updates);
    return response.data.data;
  },

  resetUserPassword: async (userId, newPassword) => {
    const response = await api.put(`/users/${userId}/password`, { newPassword });
    return response.data;
  },

  getRoles: async () => {
    const response = await api.get('/roles');
    return response.data.data;
  },

  /**
   * The module catalogue the permission matrix is drawn from.
   *
   * Fetched rather than bundled: the screen must offer exactly the cells the
   * server will honour, and a copy compiled into the frontend is a copy that
   * can be out of date. It also means a module added to the backend registry
   * shows up on this screen with no frontend release.
   */
  getModuleRegistry: async () => {
    const response = await api.get('/roles/registry');
    return response.data.data;
  },

  createRole: async (payload) => {
    const response = await api.post('/roles', payload);
    return response.data.data;
  },

  updateRole: async (roleId, updates) => {
    const response = await api.patch(`/roles/${roleId}`, updates);
    return response.data.data;
  },

  deleteRole: async (roleId) => {
    const response = await api.delete(`/roles/${roleId}`);
    return response.data;
  },

  /**
   * Extra access for one account, on top of its role. Admin-only server-side.
   * Returns the account WITH its resolved permissions, so the caller can show
   * the result rather than only the delta it sent.
   */
  updateUserAccess: async (userId, extraGrants) => {
    const response = await api.put(`/users/${userId}/access`, { extraGrants });
    return response.data.data;
  },

  /** The signed-in user's own access, for refreshing it after a change. */
  getMyAccess: async () => {
    const response = await api.get('/roles/my-access');
    return response.data.data;
  },

  // Legacy flat-permission save. Still served by the API - see the note on the
  // handler - and kept here for anything that has not moved to grants.
  updateRolePermissions: async (roleId, permissions) => {
    const response = await api.put(`/roles/${roleId}/permissions`, { permissions });
    return response.data.data;
  }
};
