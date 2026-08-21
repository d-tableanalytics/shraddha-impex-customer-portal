/**
 * verify-feature-pack.js
 * -----------------------------------------------------------------------------
 * Checks for the four-part feature pack:
 *
 *   1. MOQ prompt for SKUs an Inventory Master import creates
 *   2. Salesperson may manage CUSTOMER users only
 *   3. Six customer master fields, immutable after creation
 *   4. Sales Desk Excel + PDF export
 *
 * Static — no database, no mail. Where behaviour only runs against a live
 * MongoDB (the import writing a product, the API returning a 403) the wiring is
 * asserted at source level and said so, rather than being claimed as executed.
 *
 * Usage:  node scripts/verify-feature-pack.js   (or npm run verify:features)
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');
dotenv.config({ path: path.join(__dirname, '..', '.env') });

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`   PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`   FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (name, actual, expected) => check(
  name,
  JSON.stringify(actual) === JSON.stringify(expected),
  `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
);
const src = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const { PERMISSIONS, hasPermission } = await import('../middlewares/rbac.js');
const { CUSTOMER_MASTER_FIELDS } = await import('../modules/users/user.controller.js');
const { IMPORT_TEMPLATES } = await import('../modules/inventory/import.templates.js');
const fe = await import(
  pathToFileURL(path.join(REPO, 'frontend', 'src', 'utils', 'permissions.js')).href
);

const ROLES = ['Admin', 'Sales', 'Inventory Manager', 'Warehouse User', 'Management', 'Customer'];
const asUser = (role) => ({ role, _id: `id-${role}` });

// Mirrors denyIfOutOfScope() in the user controller.
const canManageAll = (a) => hasPermission(a, PERMISSIONS.MANAGE_USERS);
const inScope = (actor, targetRole) => canManageAll(actor) || (targetRole || 'Customer') === 'Customer';

console.log('\nFEATURE PACK — VERIFICATION\n' + '='.repeat(62));

// ── 1. Salesperson -> customer users ────────────────────────────────────────
console.log('\n1. SALESPERSON MANAGES CUSTOMER USERS');

check('Sales holds MANAGE_CUSTOMER_USERS',
  hasPermission(asUser('Sales'), PERMISSIONS.MANAGE_CUSTOMER_USERS));
check('Sales does NOT hold MANAGE_USERS (no staff accounts)',
  !hasPermission(asUser('Sales'), PERMISSIONS.MANAGE_USERS));
check('Admin still manages everything', canManageAll(asUser('Admin')));
for (const role of ['Inventory Manager', 'Warehouse User', 'Management', 'Customer']) {
  check(`${role} cannot reach user management`,
    !hasPermission(asUser(role), PERMISSIONS.MANAGE_USERS)
    && !hasPermission(asUser(role), PERMISSIONS.MANAGE_CUSTOMER_USERS));
}
eq('Sales may act on Customer accounts only',
  ROLES.filter((t) => inScope(asUser('Sales'), t)), ['Customer']);
eq('Admin may act on every role',
  ROLES.filter((t) => inScope(asUser('Admin'), t)), ROLES);

console.log('\n   frontend mirrors the server');
check('canOpenUserManagement agrees with the two permissions',
  ROLES.every((r) => fe.canOpenUserManagement(asUser(r))
    === (hasPermission(asUser(r), PERMISSIONS.MANAGE_USERS)
      || hasPermission(asUser(r), PERMISSIONS.MANAGE_CUSTOMER_USERS))));
check('canManageAccount agrees with the server scope',
  ROLES.every((t) => fe.canManageAccount(asUser('Sales'), { role: t }) === inScope(asUser('Sales'), t)));
eq('a salesperson may assign only the Customer role',
  fe.assignableRolesFor(asUser('Sales')), ['Customer']);
check('an admin may assign every role',
  fe.assignableRolesFor(asUser('Admin')).length === ROLES.length);

console.log('\n   enforced server-side, not only in the UI');
const userCtl = src('backend/modules/users/user.controller.js');
const userRoutes = src('backend/modules/users/user.routes.js');
check('createUser checks the REQUESTED role before writing',
  userCtl.includes("denyIfOutOfScope(req, res, { role: requestedRole }, 'create')"));
check('updateUser checks the TARGET account',
  userCtl.includes("denyIfOutOfScope(req, res, target, 'edit')"));
check('updateUser blocks a non-admin moving an account off Customer',
  userCtl.includes('this account must stay a Customer'));
check('the role endpoint is admin-only',
  userCtl.includes('Only an administrator can change an account role'));
check('a password reset is scoped like an edit',
  userCtl.includes("denyIfOutOfScope(req, res, target, 'reset the password for')"));
check('the list is scoped in the QUERY, not filtered after the fact',
  userCtl.includes("canManageAllUsers(req.user) ? {} : { role: 'Customer' }"));
check('the route admits both permissions',
  userRoutes.includes('authorize(PERMISSIONS.MANAGE_USERS, PERMISSIONS.MANAGE_CUSTOMER_USERS)'));

// ── 2. Customer master fields ───────────────────────────────────────────────
console.log('\n2. CUSTOMER MASTER FIELDS (fixed after creation)');

eq('all six are declared', CUSTOMER_MASTER_FIELDS,
  ['customerName', 'phone', 'location', 'shopNumber', 'vendorNumber', 'gstNumber']);

const userModel = src('backend/models/User.js');
for (const f of CUSTOMER_MASTER_FIELDS) {
  check(`${f} is on the User schema, optional (old accounts keep working)`,
    userModel.includes(`${f}: { type: String, default: null }`));
}
check('none of them is in ALLOWED_UPDATES', (() => {
  const m = /const ALLOWED_UPDATES = \[([^\]]*)\]/.exec(userCtl);
  return Boolean(m) && CUSTOMER_MASTER_FIELDS.every((f) => !m[1].includes(`'${f}'`));
})());
check('updateUser REFUSES them rather than silently dropping them',
  userCtl.includes('These customer details are fixed once the account exists'));
check('they are required when creating a Customer',
  userCtl.includes('These customer details are required and cannot be added later'));
check('they are demanded only for Customer accounts',
  userCtl.includes("if (requestedRole === 'Customer') {"));
const userMgmt = src('frontend/src/pages/Admin/Settings/UserManagement.jsx');
check('the create form collects all six',
  CUSTOMER_MASTER_FIELDS.every((f) => userMgmt.includes(`key: '${f}'`)));
check('the edit modal shows them read-only, labelled fixed',
  userMgmt.includes('Customer master details — fixed'));
check('the create form warns they cannot be changed later',
  userMgmt.includes('fixed once the account is created'));

// ── 3. MOQ prompt for newly imported SKUs ───────────────────────────────────
console.log('\n3. MOQ PROMPT FOR NEWLY IMPORTED SKUs');

const impSvc = src('backend/modules/inventory/import.service.js');
const jobModel = src('backend/models/ImportJob.js');
const invRoutes = src('backend/modules/inventory/inventory.routes.js');

check('the job records the SKUs the import created', jobModel.includes('pendingMoqSkus'));
check('only rows that actually LANDED are queued',
  impSvc.includes('r.data?.isNewSku && landedRows.has(r.rowNumber)'));
check('a re-run chunk cannot queue the same SKU twice',
  impSvc.includes('$addToSet: { pendingMoqSkus'));
check('the endpoint refuses SKUs this import did not create',
  impSvc.includes('was not created by this import'));
check('MOQ must be a whole number of 1 or more',
  impSvc.includes('MOQ must be a whole number of 1 or more'));
check('answered SKUs leave the pending list',
  impSvc.includes('$pull: { pendingMoqSkus'));
check('health is recomputed (MOQ drives the low-stock threshold)',
  impSvc.includes('recomputeHealthForSkus(applied.map'));
check('the endpoint is behind the import permission',
  invRoutes.includes("router.post('/imports/:jobId/moq', authorize(...MAY_IMPORT)"));

// The sheet has no MOQ column, so an import cannot touch an existing SKU's MOQ.
check('the import sheet carries no MOQ column, so existing MOQs are untouched',
  !IMPORT_TEMPLATES['inventory-master'].columns.some((c) => c.field === 'moq'));
check('nor does the fresh-inventory sheet',
  !IMPORT_TEMPLATES['fresh-inventory'].columns.some((c) => c.field === 'moq'));

const moqModal = src('frontend/src/components/inventory/NewSkuMoqModal.jsx');
check('the modal shows SKU details so the admin knows what they are configuring',
  moqModal.includes('s.description || `MSIL ${s.msilCode}`') && moqModal.includes('Imported Qty'));
check('it validates a positive whole number client-side too',
  moqModal.includes("'Must be 1 or more'") && moqModal.includes("'Whole numbers only'"));
check('it handles many new SKUs, and partial answers',
  moqModal.includes('ready.map') && moqModal.includes('pendingMoqSkus'));
check('closing warns and loses nothing (the queue is server-side)',
  moqModal.includes('Close without saving?'));
const importPage = src('frontend/src/pages/Inventory/InventoryImport.jsx');
check('the summary card keeps the prompt reachable after it is closed',
  importPage.includes('still have no minimum order quantity'));

// ── 4. Sales Desk exports ───────────────────────────────────────────────────
console.log('\n4. SALES DESK EXPORT (Excel + PDF)');

const deskSrc = src('frontend/src/pages/SalesDesk/SalesDesk.jsx');
const drawerSrc = src('frontend/src/components/drawer/SalesBookingDrawer.jsx');

check('the Sales Desk table offers Excel', deskSrc.includes('exportToExcel'));
check('the Sales Desk table offers PDF', deskSrc.includes('exportToPDF'));
check('both formats share ONE row/column definition',
  (deskSrc.match(/const buildExport = /g) || []).length === 1);
check('the export follows the active scope tab and search box',
  deskSrc.includes('SCOPES.find((x) => x.key === scope)') && deskSrc.includes('search.trim()'));
check('the booking-items table keeps Excel and gains PDF',
  drawerSrc.includes('exportToExcel') && drawerSrc.includes('exportToPDF'));
check('its two formats also share one builder',
  (drawerSrc.match(/const buildExport = /g) || []).length === 1);
check('exports stay lazy-loaded (xlsx/jspdf out of the main bundle)',
  (deskSrc.match(/import\("\.\.\/\.\.\/utils\/exportUtils"\)/g) || []).length >= 2);
check('PDF pagination is jspdf-autotable, which repeats headers per page',
  src('frontend/src/utils/exportUtils.js').includes('autoTable(doc, {'));

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(62));
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailed:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(
  '\nNot executed here (needs a live MongoDB / browser):'
  + '\n  - an import actually creating a SKU and queueing it for MOQ'
  + '\n  - the API returning 403 to a salesperson targeting an Admin'
  + '\n  - a generated .xlsx / .pdf opening correctly'
  + '\nThose are asserted at wiring level above, not run.',
);

process.exit(failed ? 1 : 0);
