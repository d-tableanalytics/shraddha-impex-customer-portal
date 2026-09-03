import axios from 'axios';

const rawApiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000';
const cleanApiUrl = rawApiUrl.replace(/\/+$/, '');

export const api = axios.create({
  baseURL: `${cleanApiUrl}/api/v1`,
  headers: {
    'Content-Type': 'application/json',
  },
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
  (error) => {
    if (error.response?.status === 401) {
      // Clear token and force logout if unauthorized
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);
