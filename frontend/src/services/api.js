import axios from 'axios';

const rawApiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000';
const cleanApiUrl = rawApiUrl.replace(/\/+$/, '');

export const api = axios.create({
  baseURL: `${cleanApiUrl}/api/v1`,
  headers: {
    'Content-Type': 'application/json',
  },
  // The refresh token lives in an httpOnly cookie, so it can only be sent if
  // the browser is told to include credentials. Access tokens still travel as a
  // Bearer header, exactly as before.
  withCredentials: true,
});

// Add a request interceptor to attach the JWT token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    // A file upload must NOT go out as application/json.
    //
    // Axios sets multipart/form-data with a generated boundary when it sees a
    // FormData body — but only if no Content-Type is already set, and the
    // instance default above always is. The request then arrives claiming to be
    // JSON with no boundary, multer parses nothing, and the server correctly
    // reports "No file was uploaded" for a request that did contain one.
    //
    // Deleting the header here lets axios put back the right one, with the
    // boundary the browser generates.
    if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
      delete config.headers['Content-Type'];
    }

    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

/**
 * Access tokens are now short-lived (15 minutes), so a 401 is the normal end of
 * a token's life rather than evidence of a problem. Before, a 401 logged the
 * user out; now it triggers one refresh against the httpOnly cookie and the
 * original request is retried.
 *
 * Single-flight: a page load can fire a dozen requests at once, and all of them
 * can 401 together. Without a shared promise that becomes a dozen concurrent
 * refresh calls, of which all but one would be rejected as token reuse — which
 * would revoke every session for the account.
 */
let refreshPromise = null;

const clearSessionAndRedirect = () => {
  localStorage.removeItem('token');
  if (!window.location.pathname.startsWith('/login')) {
    window.location.href = '/login';
  }
};

async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = api
      .post('/auth/refresh', {}, { _skipAuthRefresh: true })
      .then((res) => {
        const token = res?.data?.data?.token;
        if (!token) throw new Error('No token in refresh response');
        localStorage.setItem('token', token);
        return token;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    const status = error.response?.status;

    const isRefreshable =
      status === 401 &&
      original &&
      !original._retry &&
      !original._skipAuthRefresh &&
      // Never try to refresh the refresh call, or a failed sign-in.
      !String(original.url ?? '').includes('/auth/refresh') &&
      !String(original.url ?? '').includes('/auth/login');

    if (isRefreshable) {
      original._retry = true;
      try {
        await refreshAccessToken();
        return api(original);
      } catch {
        clearSessionAndRedirect();
        return Promise.reject(error);
      }
    }

    if (status === 401) {
      clearSessionAndRedirect();
    }

    return Promise.reject(error);
  }
);
