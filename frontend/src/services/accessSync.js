import { api } from "./api";
import { refreshSocketAuth } from "./socketService";
import { useUserStore } from "../store/userStore";

/**
 * Keep the screen in step with the user's CURRENT access.
 *
 * The full access (permissions, grants, menu) is read once, from /auth/me. An
 * Admin can change it at any moment - the role's matrix, the account's role,
 * its extra access - and the server enforces the change on the very next
 * request. Without this the browser kept showing the old sidebar and buttons
 * until a reload, so a revoked screen stayed one click away from a 403 and a
 * granted one stayed invisible.
 *
 * So the browser asks the server for a short fingerprint of the access
 * (GET /auth/access-version, a few bytes) and re-reads /auth/me only when it
 * moved:
 *   - every POLL_MS while the tab is visible,
 *   - when the tab becomes visible again,
 *   - shortly after any 403 (the clearest sign the screen is out of date).
 */

const POLL_MS = Number(import.meta.env?.VITE_ACCESS_POLL_MS) || 30_000;
const AFTER_403_MS = 300;

let timer = null;
let pending = null;
let checking = false;
let started = false;

/** Ask once; refresh the session when the fingerprint differs. */
export const checkAccess = async () => {
  if (checking) return false;
  const current = useUserStore.getState().user;
  if (!current || !localStorage.getItem("token")) return false;
  checking = true;
  try {
    const res = await api.get("/auth/access-version");
    const latest = res.data?.data?.accessVersion;
    if (!latest || latest === current.accessVersion) return false;
    await useUserStore.getState().refreshSession();
    // Live-update rooms are decided at connection, by access; reconnect.
    refreshSocketAuth();
    return true;
  } catch {
    // A failed check changes nothing; a 401 is handled by the api client.
    return false;
  } finally {
    checking = false;
  }
};

const soon = (ms) => {
  clearTimeout(pending);
  pending = setTimeout(checkAccess, ms);
};

/** Start the checks. Idempotent; returns a stop function. */
export const startAccessSync = () => {
  if (started) return stopAccessSync;
  started = true;

  timer = setInterval(() => {
    if (typeof document === "undefined" || document.visibilityState === "visible") checkAccess();
  }, POLL_MS);

  const onVisible = () => { if (document.visibilityState === "visible") soon(0); };
  document.addEventListener("visibilitychange", onVisible);

  const interceptor = api.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error?.response?.status === 403) soon(AFTER_403_MS);
      return Promise.reject(error);
    },
  );

  stopAccessSync = () => {
    clearInterval(timer);
    clearTimeout(pending);
    document.removeEventListener("visibilitychange", onVisible);
    api.interceptors.response.eject(interceptor);
    started = false;
  };
  return stopAccessSync;
};

export let stopAccessSync = () => {};

export default { startAccessSync, checkAccess };
