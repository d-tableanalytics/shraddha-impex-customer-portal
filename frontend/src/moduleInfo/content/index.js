/**
 * Every screen's "About this module" documentation, as data.
 *
 * One file per area, each exporting an array of entries (shape documented in
 * ../registry.js and checked by ../moduleInfo.test.js). The content was
 * written from an audit of the application code; every connection, impact and
 * rule carries `verified` and, in the source files, the code location it was
 * read from. Anything the audit could not confirm is listed under
 * `unverified` and shown as "Requires verification".
 */
import customerPortal from "./customerPortal";
import salesReports from "./salesReports";
import inventory from "./inventory";
import administration from "./administration";

export const MODULE_INFO = Object.freeze([
  ...customerPortal,
  ...salesReports,
  ...inventory,
  ...administration,
]);

export default MODULE_INFO;
