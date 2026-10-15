/**
 * Per-session data that must not outlive the account that loaded it.
 *
 * Several stores now keep their last response on screen while a refresh runs,
 * instead of blanking to skeletons on every visit. That is only safe if the data
 * belongs to the person looking at it. Before, a fresh `loading: true` on every
 * fetch hid the previous account's rows by accident; with the rows kept, a second
 * person signing in on the same tab would briefly see the first person's
 * bookings. So every store that keeps data registers a reset here, and the user
 * store runs them all whenever the signed-in account changes (login, logout).
 *
 * A hard sign-out (an expired session) reloads the page, which clears memory on
 * its own; this covers the in-page paths.
 */

const resets = new Set();

/** Register a function that clears a store back to its signed-out state. */
export const registerSessionReset = (fn) => {
  resets.add(fn);
  return () => resets.delete(fn);
};

/** Clear every registered store. A failing reset must not block the others. */
export const resetSessionStores = () => {
  for (const fn of resets) {
    try {
      fn();
    } catch (err) {
      console.error("[session] a store failed to reset:", err);
    }
  }
};
