import axios from 'axios';

import { API_BASE_URL } from './apiBase';
import { refreshAccessToken } from '../../services/api';

/**
 * ADAPTER — this portal's own file, not a copy. See scripts/fms-port.mjs.
 *
 * The transport the FMS screens use: an axios instance aimed at the Employee
 * API, carrying THIS portal's session. Same export (`api`) as the Employee
 * Portal's api.js, so the verbatim services and the ported tests' mocks
 * resolve to it unchanged.
 *
 * WHY THIS PORTAL'S TOKEN WORKS THERE
 *
 * Both portals sign access tokens with the same JWT_SECRET for the same `users`
 * collection (Employee portal module/SHARED-CONTRACT.md §1), and the Employee
 * API's `protect` accepts any valid access token. So there is no second login:
 * the token already in localStorage is presented as a Bearer header.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *   • Refresh on its own. The refresh cookie belongs to THIS portal's API, and
 *     rotation is single-flight there: two independent refreshers would race,
 *     and a refresh token presented twice revokes every session on the
 *     account. A 401 from the Employee API goes through this portal's own
 *     `refreshAccessToken()`, then the request is retried once.
 *
 *   • Sign anybody out. A refusal from the Employee API — its CORS not admitting
 *     this origin, a mismatched secret, the server being down — says FMS is
 *     unavailable, not that this portal's session died. The FMS screens report
 *     it; the rest of the portal carries on.
 *
 *   • Send cookies. Nothing here needs one, and a cross-site request that
 *     carries none cannot be used against this portal's cookie.
 */
export const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: false,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  // Let axios set multipart/form-data with the browser's boundary; the default
  // JSON header above would otherwise stop multer finding the file.
  if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
    delete config.headers['Content-Type'];
  }

  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && original && !original._fmsRetry) {
      original._fmsRetry = true;
      try {
        await refreshAccessToken();
      } catch {
        return Promise.reject(error);
      }
      return api(original);
    }
    return Promise.reject(error);
  },
);

export default api;
