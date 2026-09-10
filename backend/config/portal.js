/**
 * Which portal THIS process is.
 *
 * ---------------------------------------------------------------------------
 * WHY A DEPLOYMENT DECLARES ITSELF
 * ---------------------------------------------------------------------------
 *
 * The Customer Portal and the Employee Portal are separate repositories sharing
 * ONE database — the same `users` and `roles` collections, the same accounts,
 * the same JWT secret. A person can hold a legitimate session in both.
 *
 * That is exactly why the SERVER has to know which domain it is serving. It
 * cannot ask the user: an account with HRMS access presenting a valid token is
 * indistinguishable, request by request, from the same account working a
 * booking. And it must not ask the CLIENT — a header or a query parameter
 * naming the portal would be trivially forged by the URL-typer this whole
 * mechanism exists to stop.
 *
 * So the answer is a property of the deployment, fixed at boot.
 *
 * ---------------------------------------------------------------------------
 * WHY AN ENV VAR WITH A COMPILED-IN DEFAULT
 * ---------------------------------------------------------------------------
 *
 * The default is the honest answer for this repository — it IS the customer
 * portal, and a deployment that forgets to set the variable gets the correct
 * behaviour rather than a crash or, far worse, a silently wider module set.
 *
 * The env var exists on top of it for two reasons: a staging box can be pointed
 * at either domain without a code change, and the tests can exercise both sides
 * of the fence in one process.
 *
 * An UNRECOGNISED value throws at boot rather than falling back. A typo like
 * `PORTAL=customers` must not quietly resolve to "serve everything" — that is
 * the failure this file is here to prevent, and a server that refuses to start
 * is a far cheaper way to find out.
 */

import { PORTALS, isPortal } from './moduleRegistry.js';

/** This repository is the Customer Portal. */
const DEFAULT_PORTAL = PORTALS.CUSTOMER;

/**
 * Read lazily, not as a module-level constant.
 *
 * `server.js` calls `dotenv.config()` AFTER the import graph has evaluated, so
 * a module-level `process.env` read here would see nothing — the same trap that
 * left `JWT_EXPIRES_IN=1d` doing nothing for months (see utils/tokens.js).
 * Reading at call time means the value is correct whoever asks and whenever.
 */
export const currentPortal = () => {
  const configured = process.env.PORTAL;
  if (!configured) return DEFAULT_PORTAL;

  const value = String(configured).trim().toLowerCase();
  if (!isPortal(value)) {
    throw new Error(
      `PORTAL="${configured}" is not a known portal. Expected one of: ${Object.values(PORTALS).join(', ')}. `
        + 'Refusing to start rather than guessing, because guessing would mean serving the wrong module set.',
    );
  }
  return value;
};

/** True when this process serves the given portal. */
export const isCurrentPortal = (portal) => currentPortal() === portal;

/** Human-readable, for the boot log. */
export const describePortal = () => {
  const portal = currentPortal();
  const source = process.env.PORTAL ? 'PORTAL env var' : 'compiled-in default';
  return `[Portal] Serving the ${portal} portal (${source})`;
};

export default { currentPortal, isCurrentPortal, describePortal };
