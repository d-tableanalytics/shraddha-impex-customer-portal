/**
 * The source-adapter boundary (AD-11).
 *
 *   [ unknown source ] -> adapter -> CanonicalEmployeeRecord[] -> pipeline
 *        (deferred)     (deferred)        (defined)               (built)
 *
 * Everything to the right of the adapter exists. When the migration source is
 * finally chosen, only a function that produces canonical records has to be
 * written - validation, sanitisation, dependency checking, preview, commit,
 * linking and verification are already in place and already tested.
 *
 * NO ADAPTER IS SHIPPED. Registering one is a deliberate act, and the pipeline
 * refuses to run without one rather than inventing a default. AD-11 says the
 * source is not decided; a default would be an assumption about it.
 *
 * The persistence port is separate for the same reason: the Employee collection
 * arrives in Phase 1, so the pipeline is written against an interface rather
 * than against a model that does not exist yet.
 */

/** @type {Map<string, { load: Function, description?: string }>} */
const adapters = new Map();

/**
 * Register a source adapter.
 *
 * @param {string} name
 * @param {object} adapter
 * @param {Function} adapter.load  `(input) => Promise<object[]>` - raw rows in
 *   canonical SHAPE. It does not have to validate; the pipeline does that, so
 *   an adapter stays a pure mapping and its failures surface as row errors.
 */
export function registerImportAdapter(name, adapter) {
  if (typeof adapter?.load !== 'function') {
    throw new TypeError('registerImportAdapter: adapter.load must be a function');
  }
  adapters.set(name, adapter);
}

export const getImportAdapter = (name) => adapters.get(name) ?? null;
export const registeredImportAdapters = () => [...adapters.keys()];

/**
 * The persistence port the pipeline writes through.
 *
 * Implemented by the employees module in Phase 1. Every method is required, and
 * the pipeline refuses to commit without it - so a half-wired port fails at the
 * boundary rather than half-way through a migration.
 *
 * @typedef {object} EmployeePersistencePort
 * @property {(codes: string[]) => Promise<Map<string, object>>} findByEmployeeCodes
 * @property {(codes: string[]) => Promise<Map<string, string>>} resolveDepartmentCodes
 * @property {(codes: string[]) => Promise<Map<string, string>>} resolveLocationCodes
 * @property {(records: object[]) => Promise<{ created: number, updated: number, byCode: Map<string,string> }>} upsertEmployees
 * @property {(links: Array<{ employeeCode: string, managerEmployeeCode: string }>) => Promise<number>} linkReportingManagers
 * @property {() => Promise<number>} rebuildManagerChains
 * @property {(employeeCodes: string[]) => Promise<number>} seedLeaveBalances
 */

/** @type {EmployeePersistencePort|null} */
let persistence = null;

const REQUIRED_PORT_METHODS = [
  'findByEmployeeCodes',
  'resolveDepartmentCodes',
  'resolveLocationCodes',
  'upsertEmployees',
  'linkReportingManagers',
  'rebuildManagerChains',
  'seedLeaveBalances',
];

export function registerEmployeePersistence(port) {
  const missing = REQUIRED_PORT_METHODS.filter((m) => typeof port?.[m] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(
      `registerEmployeePersistence: the port is missing ${missing.join(', ')}`,
    );
  }
  persistence = port;
}

export const getEmployeePersistence = () => persistence;

/** Test seam. */
export function __resetImportRegistry() {
  adapters.clear();
  persistence = null;
}

export { REQUIRED_PORT_METHODS };
