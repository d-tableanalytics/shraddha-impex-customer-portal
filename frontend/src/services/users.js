import { api } from './api';

export const usersApi = {
  login: async (credentials) => {
    const response = await api.post('/auth/login', credentials);
    return response.data.data;
  },
  
  getCurrentUser: async () => {
    const response = await api.get('/auth/me');
    return response.data.data;
  },

  updateProfile: async (updates) => {
    const response = await api.patch('/auth/me', updates);
    return response.data.data;
  },

  changePassword: async (currentPassword, newPassword) => {
    const response = await api.put('/auth/me/password', { currentPassword, newPassword });
    return response.data;
  },

  /**
   * Sign out on the SERVER as well as the client.
   *
   * Logging out used to be `localStorage.removeItem('token')` alone, which left
   * the session valid until the token expired. This clears the stored refresh
   * hash and the httpOnly cookie, so the session genuinely ends.
   *
   * Never rejects: a user pressing sign-out must always end up signed out
   * locally, even if the request fails.
   */
  logout: async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Ignored on purpose — the local clear below is what the user sees.
    }
  },
};
