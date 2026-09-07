/**
 * HRMS entity references.
 *
 * The Employee Master, Department and Location collections arrive in later
 * phases, but the foundation already depends on them:
 *
 *   - RBAC needs an employee's departmentId and managerChain to evaluate
 *     `self`, `team` and `department` scopes
 *   - the import pipeline resolves department and location CODES
 *   - the file-access rules resolve an object's owning employee
 *   - every future list screen renders "Reporting manager: <name>"
 *
 * So the ABSTRACTION exists now and its providers are registered later. That is
 * the alternative to building half an Employee CRUD to satisfy a dependency.
 *
 * ---------------------------------------------------------------------------
 * An unregistered reference FAILS, it does not return empty
 * ---------------------------------------------------------------------------
 * `resolveEmployee()` with no provider REJECTS with HrmsNotImplementedError
 * (503), never resolves to `null`. Returning null would be indistinguishable from "that employee
 * does not exist", so a screen would render "no manager" when the truth is "the
 * Employee Master is not built yet" - and a permission check would silently
 * evaluate against an actor with no team.
 *
 * The one exception is `describe()`, which reports what is wired up precisely so
 * a caller can ask before committing to a path that will reject.
 */

import { HrmsNotImplementedError } from '../hrms.errors.js';

/**
 * @typedef {object} EmployeeRef
 * @property {string}   id
 * @property {string}   employeeCode
 * @property {string}   displayName
 * @property {string|null} departmentId
 * @property {string|null} locationId
 * @property {string|null} reportingManagerId
 * @property {string[]} managerChain   ancestor employee ids, nearest first
 * @property {string|null} userId
 * @property {string}   status
 */

/**
 * @typedef {object} LookupRef
 * @property {string} id
 * @property {string} code
 * @property {string} name
 */

/** @type {{ employee: object|null, department: object|null, location: object|null }} */
const providers = {
  employee: null,
  department: null,
  location: null,
};

const PROVIDER_CONTRACTS = {
  employee: ['byId', 'byUserId', 'byCodes', 'byIds'],
  department: ['byId', 'byCodes', 'list'],
  location: ['byId', 'byCodes', 'list'],
};

const PHASE_HINT = {
  employee: 'The Employee Master lands in a later phase.',
  department: 'Org Structure lands in a later phase.',
  location: 'Org Structure lands in a later phase.',
};

/**
 * Register the provider for a reference kind.
 *
 * The full contract is required. A partially-implemented provider fails here,
 * at startup, rather than at the first call that happens to need the missing
 * method - which could be months into a phase.
 */
export function registerReferenceProvider(kind, provider) {
  const contract = PROVIDER_CONTRACTS[kind];
  if (!contract) {
    throw new Error(`registerReferenceProvider: unknown reference kind "${kind}"`);
  }
  const missing = contract.filter((m) => typeof provider?.[m] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(
      `registerReferenceProvider("${kind}"): provider is missing ${missing.join(', ')}`,
    );
  }
  providers[kind] = provider;
}

/** Test seam. */
export function __resetReferenceProviders() {
  providers.employee = null;
  providers.department = null;
  providers.location = null;
}

/** What is wired up. Safe to call at any time; never throws. */
export function describe() {
  return {
    employee: Boolean(providers.employee),
    department: Boolean(providers.department),
    location: Boolean(providers.location),
  };
}

/** True when every reference kind has a provider. */
export const referencesReady = () => Object.values(describe()).every(Boolean);

/**
 * The provider for a kind, or a rejected promise.
 *
 * ASYNC on purpose. Every function below returns a promise and every caller
 * awaits it, so a synchronous throw here would escape a `.catch()` and land in
 * a different place from every other failure this module can produce. An
 * async-looking API that sometimes throws synchronously is a trap.
 */
async function require_(kind) {
  const provider = providers[kind];
  if (!provider) {
    throw new HrmsNotImplementedError(
      `The ${kind} reference provider`,
      PHASE_HINT[kind],
    );
  }
  return provider;
}

// ---------------------------------------------------------------------------
// Employee references
// ---------------------------------------------------------------------------

/** @returns {Promise<EmployeeRef|null>} null only when the id genuinely has no employee. */
export const resolveEmployee = async (employeeId) =>
  (await require_('employee')).byId(String(employeeId));

/**
 * The employee behind a user account.
 *
 * This is what the HRMS actor is built from. Note the AD-4 consequence: a
 * Customer never reaches here at all, because `attachHrmsActor` skips the
 * lookup entirely for an account with no HRMS role.
 */
export const resolveEmployeeByUser = async (userId) =>
  (await require_('employee')).byUserId(String(userId));

/** @returns {Promise<Map<string, EmployeeRef>>} keyed by employeeCode. */
export const resolveEmployeesByCodes = async (codes = []) =>
  codes.length === 0 ? new Map() : (await require_('employee')).byCodes(codes.map(String));

/** @returns {Promise<Map<string, EmployeeRef>>} keyed by id. Batch, to avoid N+1. */
export const resolveEmployeesByIds = async (ids = []) =>
  ids.length === 0 ? new Map() : (await require_('employee')).byIds(ids.map(String));

/**
 * The manager chain for an employee.
 *
 * DERIVED, never stored by a caller. Every `team`-scope permission check reads
 * it, so it has exactly one source (AD-11).
 */
export async function resolveManagerChain(employeeId) {
  const employee = await resolveEmployee(employeeId);
  return employee?.managerChain ?? [];
}

// ---------------------------------------------------------------------------
// Org-structure references
// ---------------------------------------------------------------------------

export const resolveDepartment = async (id) => (await require_('department')).byId(String(id));
export const resolveDepartmentsByCodes = async (codes = []) =>
  codes.length === 0 ? new Map() : (await require_('department')).byCodes(codes.map(String));
export const listDepartments = async () => (await require_('department')).list();

export const resolveLocation = async (id) => (await require_('location')).byId(String(id));
export const resolveLocationsByCodes = async (codes = []) =>
  codes.length === 0 ? new Map() : (await require_('location')).byCodes(codes.map(String));
export const listLocations = async () => (await require_('location')).list();

/**
 * Build the ResourceContext the permission evaluator needs for a scoped check.
 *
 * Centralised so `self`, `team` and `department` are always derived the same
 * way. A handler assembling this by hand is how a scope check quietly starts
 * passing for the wrong person.
 */
export async function resourceContextForEmployee(employeeId) {
  const employee = await resolveEmployee(employeeId);
  if (!employee) return undefined;
  return {
    ownerUserId: employee.userId ?? undefined,
    ownerEmployeeId: employee.id,
    ownerDepartmentId: employee.departmentId ?? undefined,
    ownerManagerChain: employee.managerChain ?? [],
  };
}

export default {
  registerReferenceProvider,
  describe,
  referencesReady,
  resolveEmployee,
  resolveEmployeeByUser,
  resolveEmployeesByCodes,
  resolveEmployeesByIds,
  resolveManagerChain,
  resolveDepartment,
  resolveDepartmentsByCodes,
  listDepartments,
  resolveLocation,
  resolveLocationsByCodes,
  listLocations,
  resourceContextForEmployee,
};
