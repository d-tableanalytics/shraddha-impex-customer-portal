/**
 * ADAPTER — this portal's own file, not a copy. See scripts/fms-port.mjs.
 *
 * Where the FMS screens' API lives: the EMPLOYEE Portal's server, not this
 * portal's. FMS has one engine, one set of scheduled jobs and one set of Work
 * Queue mirrors, and they all run there; these screens only draw it.
 *
 * Same exports as the Employee Portal's apiBase.js, so the verbatim files that
 * import it (services/fileUrl.js) resolve their URLs against the right server.
 *
 * VITE_EMPLOYEE_API_URL is the Employee API's ORIGIN, e.g.
 * `https://employee-api.example.com` — no `/api/v1`. Unset in a production
 * build means FMS is simply not offered here: the menu, the bell and the routes
 * stay hidden, and nothing else in this portal notices. In development it
 * falls back to the Employee Portal's dev server.
 */

const DEV_FALLBACK = 'http://localhost:5001';

const raw = import.meta.env.VITE_EMPLOYEE_API_URL;
const configured = raw != null && String(raw).trim() !== ''
  ? String(raw).trim().replace(/\/+$/, '')
  : null;

const origin = configured ?? (import.meta.env.DEV ? DEV_FALLBACK : null);

/** False when this build was given no Employee API to talk to. */
export const FMS_API_CONFIGURED = origin !== null;

export const API_ORIGIN = origin ?? '';

export const API_BASE_URL = `${API_ORIGIN}/api/v1`;

export default API_BASE_URL;
