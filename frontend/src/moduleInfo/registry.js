import { matchPath } from "react-router-dom";
import ROUTES from "./content/routes";

/**
 * Contextual module information (the ⓘ beside every page heading).
 *
 * ---------------------------------------------------------------------------
 * ONE SOURCE, LOOKED UP BY ROUTE
 * ---------------------------------------------------------------------------
 * Every screen's documentation lives in `./content/*` as plain data, one
 * entry per screen, keyed by the module registry's `module.submodule` key and
 * carrying the route patterns the screen is served at. The icon finds the
 * entry for the CURRENT URL, so a page gets the right panel by being at its
 * own route: no page names its own documentation, and a screen that gains a
 * second route only needs the pattern added to its entry.
 *
 * A page can still name an entry explicitly (`infoKey`) when the URL is not
 * enough: Create Booking and Selection List share one route, and only the
 * page heading carries the icon.
 *
 * ---------------------------------------------------------------------------
 * THE TEXT IS LOADED ON DEMAND
 * ---------------------------------------------------------------------------
 * Every page header asks "is this screen documented?", so that answer comes
 * from `./content/routes.js`: keys, titles and route patterns only, a few KB.
 * The documentation itself (well over 100 KB) is a separate chunk fetched the
 * first time someone opens a panel, so the feature costs a page nothing until
 * it is used.
 *
 * ---------------------------------------------------------------------------
 * MOST SPECIFIC PATTERN WINS
 * ---------------------------------------------------------------------------
 * `/hrms/academy/:tab` and `/hrms/academy/paths/:pathId` both match
 * `/hrms/academy/paths/42`. The pattern with more literal (non-parameter)
 * segments is the screen the user is actually on, so it is preferred; among
 * equals, the one declared first.
 */

const literalSegments = (pattern) =>
  pattern.split("/").filter((seg) => seg && !seg.startsWith(":") && seg !== "*").length;

/** The route-index row for `key` ({ key, title, paths }), or null. */
export const moduleInfoByKey = (key) =>
  (key && ROUTES.find((row) => row.key === key)) || null;

/** The route-index row for the screen served at `pathname`, or null when none is documented. */
export const moduleInfoForPath = (pathname) => {
  if (!pathname) return null;
  let best = null;
  let bestScore = -1;
  for (const row of ROUTES) {
    for (const pattern of row.paths || []) {
      if (!matchPath({ path: pattern, end: true }, pathname)) continue;
      const score = literalSegments(pattern);
      if (score > bestScore) {
        best = row;
        bestScore = score;
      }
    }
  }
  return best;
};

/** `infoKey` when given, else the current route's row. */
export const resolveModuleInfo = ({ infoKey, pathname }) =>
  (infoKey ? moduleInfoByKey(infoKey) : null) || moduleInfoForPath(pathname);

/** The full documentation entry for `key`, fetched on first use. */
export const loadModuleInfo = async (key) => {
  const { MODULE_INFO } = await import("./content");
  return MODULE_INFO.find((entry) => entry.key === key) || null;
};

export default { moduleInfoByKey, moduleInfoForPath, resolveModuleInfo, loadModuleInfo };
