import { api } from './api';
import { setBrandRegistry } from '../utils/brandAccess';

/**
 * The customer picker on Create Booking (Sales / Admin booking on a
 * customer's behalf). Reads the accounts Customer Management manages — the
 * server returns live Customer accounts only, with the fields the booking
 * form needs to apply that customer's rules (category, brand access, MOQ).
 */
export const customersApi = {
  /** Customers whose name, contact, company or email contains `search`. */
  search: async (search = '', { signal } = {}) => {
    const response = await api.get('/users/customers', { params: { search, limit: 20 }, signal });
    return response.data.data || [];
  },

  /** One customer by id, or null. Used to re-select a just-created customer. */
  getById: async (id) => {
    if (!id) return null;
    const response = await api.get('/users/customers', { params: { id } });
    return (response.data.data || [])[0] || null;
  },
};

export const usersApi = {
  login: async (credentials) => {
    const response = await api.post('/auth/login', credentials);
    return response.data.data;
  },
  
  getCurrentUser: async () => {
    const response = await api.get('/auth/me');
    const user = response.data.data;
    // The brand list rides with the user, so it is installed before any
    // screen that reads allowedBrands(user) renders with the new user.
    setBrandRegistry(user?.brands);
    return user;
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
