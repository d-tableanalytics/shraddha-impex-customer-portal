/**
 * The domain boundary, as a route guard.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR, AND WHAT ALREADY COVERS THE REST
 * ---------------------------------------------------------------------------
 *
 * Most of the portal separation needs no middleware at all: the two portals are
 * separate deployments that mount different routers, so an employee-domain URL
 * typed at the customer domain hits the 404 handler because nothing is listening
 * there. That is the strongest possible enforcement — the code is absent.
 *
 * This exists for the narrower case: a router that IS mounted here, serving a
 * module that only one domain should offer. `administration` is the example —
 * both portals maintain accounts, but Roles & Permissions is employee-only and
 * Customer Management is customer-only, and they share one Express router.
 *
 * ---------------------------------------------------------------------------
 * WHY 404 AND NOT 403
 * ---------------------------------------------------------------------------
 *
 * 403 says "this exists and you may not have it", which tells a prober that the
 * endpoint is real and worth attacking from the other domain. 404 says nothing —
 * and it is also the honest answer, because from THIS domain's point of view the
 * route genuinely is not part of the application.
 *
 * It is deliberately NOT a permission failure. A Super Admin holds the wildcard
 * and satisfies every permission check ever written; the domain fence has to sit
 * outside that system or the most privileged accounts would be the ones it fails
 * to contain.
 */

import { currentPortal } from '../config/portal.js';
import { getModule, getSubmodule, servesPortal } from '../config/moduleRegistry.js';

const notFound = (res) =>
  res.status(404).json({ success: false, message: 'API Route Not Found' });

/**
 * Refuse this route unless the current deployment's portal serves the module.
 *
 *   router.use('/', requirePortalModule('administration', 'roles'));
 *
 * Naming the sub-module is what allows a single router to be half-served: the
 * module may be offered here while this particular screen is not.
 *
 * An UNKNOWN module or sub-module throws at mount time rather than at request
 * time. A typo would otherwise resolve to "no portals declared" and — because
 * `portalsOf` treats an untagged entry as belonging to every portal — quietly
 * open the route everywhere, which is the exact opposite of what the caller
 * asked for.
 *
 * @param {string} moduleKey
 * @param {string} [submoduleKey]
 */
export const requirePortalModule = (moduleKey, submoduleKey) => {
  const mod = getModule(moduleKey);
  if (!mod) throw new Error(`requirePortalModule: unknown module "${moduleKey}"`);

  let entry = mod;
  if (submoduleKey) {
    const found = getSubmodule(moduleKey, submoduleKey);
    if (!found) {
      throw new Error(`requirePortalModule: unknown sub-module "${moduleKey}.${submoduleKey}"`);
    }
    // A sub-module inherits its module's portals unless it names its own.
    entry = { portals: found.submodule.portals ?? mod.portals };
  }

  return (req, res, next) => (servesPortal(entry, currentPortal()) ? next() : notFound(res));
};

/** Refuse this route unless the deployment IS the named portal. */
export const requirePortal = (portal) => (req, res, next) =>
  (currentPortal() === portal ? next() : notFound(res));

export default { requirePortalModule, requirePortal };
