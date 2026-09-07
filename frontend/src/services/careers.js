import axios from "axios";

/**
 * The public careers API.
 *
 * ---------------------------------------------------------------------------
 * Its own axios instance, on purpose
 * ---------------------------------------------------------------------------
 * Everywhere else in this app, `services/api.js` is the one client and adding a
 * second is a mistake — it would need the Bearer header, the credentialed
 * refresh cookie and the single-flight 401 retry reimplemented, and the two
 * would drift.
 *
 * These endpoints are the exception because they are used by people who have no
 * session at all. Routing them through the portal's instance would mean:
 *
 *   - sending whatever access token happens to be in storage to an
 *     unauthenticated endpoint, and
 *   - handing a 401 to `clearSessionAndRedirect`, which would throw a job
 *     applicant — who was never signed in — onto the login page.
 *
 * So this instance carries no credentials, no interceptors, and no session
 * behaviour. That absence IS the feature.
 */

const rawApiUrl = import.meta.env.VITE_API_URL || "http://localhost:5000";
const cleanApiUrl = rawApiUrl.replace(/\/+$/, "");

const client = axios.create({
  baseURL: `${cleanApiUrl}/api/v1/hrms/careers`,
  headers: { "Content-Type": "application/json" },
  // No cookies. An anonymous visitor has no session and must not be given one.
  withCredentials: false,
});

/** A failed public request, normalised the way `HrmsApiError` normalises HRMS ones. */
export class CareersApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "CareersApiError";
    this.status = status ?? 0;
    this.code = code ?? null;
  }

  /** The server answers 404 for an unknown, malformed, expired or spent link alike. */
  get isNotFound() {
    return this.status === 404;
  }

  /** Rate limited — the write endpoints are deliberately tight. */
  get isThrottled() {
    return this.status === 429;
  }
}

async function request(method, path, data) {
  try {
    const res = await client.request({ method, url: path, ...(data ? { data } : {}) });
    return res.data?.data ?? res.data;
  } catch (error) {
    const body = error?.response?.data ?? {};
    throw new CareersApiError(
      body.message ?? error?.message ?? "Something went wrong. Please try again.",
      { status: error?.response?.status, code: body.code },
    );
  }
}

export const careersApi = {
  /** Live adverts only. Nothing here is filtered client-side. */
  listRoles: () => request("get", "/postings"),
  getRole: (slug) => request("get", `/postings/${encodeURIComponent(slug)}`),
  apply: (slug, dto) => request("post", `/postings/${encodeURIComponent(slug)}/apply`, dto),

  /**
   * The offer, addressed by its access token.
   *
   * The token is the ONLY credential. It is never put in a query string — a URL
   * path is already more exposed than one would like (browser history, the
   * referrer header), and a query string is worse for logging.
   */
  getOffer: (token) => request("get", `/offer/${encodeURIComponent(token)}`),
  acceptOffer: (token, dto) => request("post", `/offer/${encodeURIComponent(token)}/accept`, dto),
  rejectOffer: (token, dto) => request("post", `/offer/${encodeURIComponent(token)}/reject`, dto),
};

export default careersApi;
