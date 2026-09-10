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

/**
 * Turn a failed request into something a person can act on.
 *
 * THE TWO FAILURES LOOK IDENTICAL TO A CATCH BLOCK AND ARE NOTHING ALIKE:
 *
 *   • The server answered and said no. It always sends a `message` — the global
 *     error handler guarantees one — so that message is the whole story and is
 *     what should be shown.
 *
 *   • No answer arrived at all: the API was restarting, the network dropped, or
 *     the browser cancelled it. `err.response` is undefined, so reading
 *     `err.response?.data?.message` yields nothing and every caller written as
 *     `?? "Something went wrong"` reports its own generic sentence.
 *
 * That second case is the one worth naming, because the advice differs: the
 * request may well have been PROCESSED before the connection died, so the right
 * move is to reload and check rather than to assume nothing happened. A caller
 * that cannot tell the two apart sends people looking for a bug in the wrong
 * place — which is exactly what a generic "could not be saved" did.
 */
export const describeRequestFailure = (err, fallback = "The request failed") => {
  if (err?.response) {
    return err.response.data?.message
      || `The server refused the request (${err.response.status} ${err.response.statusText || ""}).`.trim();
  }
  if (err?.code === "ECONNABORTED") {
    return "The server took too long to answer. It may still have processed the request — reload and check before trying again.";
  }
  return `${fallback} — the server did not respond. It may be restarting, or the connection dropped. `
    + "The request may still have gone through, so reload and check before trying again.";
};

// Add a response interceptor to handle token expiry
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    const status = error.response?.status;

    const url = String(original?.url ?? '');

    /*
     * Endpoints whose 401 means "you got that wrong", not "your session died".
     *
     * THE BUG THIS FIXES: `PUT /auth/me/password` answers 401 for a WRONG
     * CURRENT PASSWORD. That URL is neither /auth/refresh nor /auth/login, so it
     * used to be treated as an expired token — refreshed, replayed, refused a
     * second time, and then dropped through the blanket handler below, which
     * hard-redirected to /login. Mistyping your own password signed you out, and
     * the error message the Settings page had carefully prepared was never seen.
     * It also burned two of the five attempts on the password limiter, so a
     * couple of typos produced a 429 as well.
     */
    const isCredentialCheck =
      url.includes('/auth/me/password') || url.includes('/auth/login');

    const isRefreshable =
      status === 401 &&
      original &&
      !original._retry &&
      !original._skipAuthRefresh &&
      !isCredentialCheck &&
      // Never try to refresh the refresh call itself.
      !url.includes('/auth/refresh');

    if (isRefreshable) {
      original._retry = true;
      try {
        await refreshAccessToken();
        return api(original);
      } catch (refreshError) {
        /*
         * A THROTTLED refresh is not a dead session.
         *
         * The refresh limiter answers 429, and this catch used to treat every
         * failure alike and sign the user out — obeying the throttle message
         * ("Please sign in again") literally. Behind one office IP that turned a
         * busy afternoon into a mass logout, because the limiter was keyed per
         * address and every tab shared the budget.
         *
         * The limiter is now keyed per account and skips successful refreshes,
         * so this should be rare. When it does happen the session is still
         * perfectly valid: fail THIS request, keep the user signed in, and let
         * the next attempt through once the window rolls over.
         */
        if (refreshError?.response?.status === 429) {
          return Promise.reject(error);
        }
        clearSessionAndRedirect();
        return Promise.reject(error);
      }
    }

    /*
     * A 401 that is NOT a dead session must not sign anybody out.
     *
     * `_retry` is the important half. Axios preserves it across the replay, so a
     * request that already refreshed successfully and STILL got a 401 is telling
     * us the token was fine and the request was refused on its merits. Logging
     * out on that is how a wrong-password dialog became a logout.
     */
    if (status === 401 && !isCredentialCheck && !original?._retry) {
      clearSessionAndRedirect();
    }

    return Promise.reject(error);
  }
);
