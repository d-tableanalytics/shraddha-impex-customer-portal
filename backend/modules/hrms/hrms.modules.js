/**
 * Which HRMS modules actually exist right now.
 *
 * The permission matrix declares 31 module keys, because permissions were
 * modelled up front (Phase 0). Very few of them have any screen or endpoint
 * behind them yet.
 *
 * Those are two different questions, and conflating them is how a nav ends up
 * full of links to nothing. `canAccessHrmsModule` answers "is this person
 * ALLOWED here"; this file answers "does this exist yet". The nav needs both,
 * and the dashboard needs the second to show honest empty states rather than
 * invented numbers.
 *
 * Add a key here in the same commit that ships its screens - never before.
 */

import { HRMS_MODULES as M } from '../../shared/permissions/constants.js';

/**
 * Modules with a real, reachable SCREEN.
 *
 * Phase 1 ships the shell, so the dashboard is the only one. The company
 * profile and retention endpoints exist too, but they are foundation
 * infrastructure consumed by the shell rather than a module a user navigates
 * to - listing `settings` here would put a nav link in front of a page nobody
 * has built.
 */
export const IMPLEMENTED_HRMS_MODULES = Object.freeze([M.DASHBOARD]);

/**
 * Modules whose permissions exist but whose implementation does not.
 *
 * Exposed so the UI can distinguish "you may not" from "not built yet" - a
 * distinction a user notices immediately and a 403 cannot express.
 */
export const PLANNED_HRMS_MODULES = Object.freeze(
  Object.values(M).filter((m) => !IMPLEMENTED_HRMS_MODULES.includes(m)),
);

export const isModuleImplemented = (module) => IMPLEMENTED_HRMS_MODULES.includes(module);

export default { IMPLEMENTED_HRMS_MODULES, PLANNED_HRMS_MODULES, isModuleImplemented };
