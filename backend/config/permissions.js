/**
 * The permission vocabulary, and the BASELINE each built-in role starts from.
 *
 * WHY THIS MOVED OUT OF middlewares/rbac.js
 *
 * It did not change - every key and every role's list is carried over
 * verbatim, and rbac.js re-exports both, so the ~145 call sites and every
 * `import { PERMISSIONS } from '.../rbac.js'` keep working exactly as before.
 * It moved because the resolver now needs to read it and rbac.js needs to read
 * the resolver, and a leaf module both can import is how that stops being a
 * cycle.
 *
 * WHAT "BASELINE" MEANS, AND WHY IT IS A FLOOR RATHER THAN A DEFAULT
 *
 * Requirement 7 is that no existing access is lost. The safe way to honour that
 * is not to copy these lists into the database once and hope the copy was
 * faithful - it is to keep reading them at runtime, and treat the database as
 * something that can only ADD.
 *
 * So a user's effective permissions are:
 *
 *     baseline(user.role)  UNION  whatever their DB role grants
 *
 * A migration bug, a half-finished matrix, an admin who unticks a box they did
 * not understand - none of them can take away what the role could do the day
 * before this system shipped. The Super Admin composes access on top of a floor
 * they cannot fall through.
 *
 * The cost is honest and worth stating: a permission in the baseline cannot be
 * REVOKED through the matrix. That is the deal - it is what "preserve all
 * existing access" asks for. Revoking one means editing this file, which is a
 * code review, which is the right weight for taking away access that the
 * business has been relying on. Roles created AFTER this point carry no
 * baseline at all, so they are fully editable in both directions.
 */

export const PERMISSIONS = {
  CREATE_ORDER: 'create_order',
  MANAGE_ORDERS: 'manage_orders',             // admin booking lifecycle (status changes)
  MANAGE_INVENTORY: 'manage_inventory',       // legacy umbrella; superseded by the granular set below
  MANAGE_USERS: 'manage_users',                // every account, any role
  MANAGE_CUSTOMER_USERS: 'manage_customer_users', // CUSTOMER accounts only
  MANAGE_ROLES: 'manage_roles',
  VIEW_REPORTS: 'view_reports',
  // Sales-desk capabilities
  VIEW_ALL_BOOKINGS: 'view_all_bookings',     // see other customers' bookings
  EDIT_BOOKING_PRE_PO: 'edit_booking_pre_po', // amend lines until the PO is raised
  RAISE_PO: 'raise_po',                       // generate the PO number (locks the booking)
  OVERRIDE_PO_LOCK: 'override_po_lock',       // edit a booking after the PO exists
  /**
   * See the four tier prices, and choose which one a customer is offered.
   *
   * Its own key rather than a corner of RAISE_PO, because "may raise the PO"
   * and "may see what we charge everyone else" are different questions and the
   * requirement asks for the second to be grantable on its own. A holder can
   * read Product.prices and set the price on a booking; nobody else can do
   * either, and the tier figures appear in no other response in the app.
   *
   * A customer never holds it and never needs it: the price they were given is
   * copied onto their own order rows, which they may already read.
   */
  VIEW_PRICING: 'view_pricing',

  // ── Inventory Management System ─────────────────────────────────────────
  // The full set is declared here in one pass rather than being reopened for
  // each module, so the role matrix below is complete and reviewable now. Only
  // the four marked (M1) are enforced by any route today; the rest are carried
  // by the roles that will need them when their module ships.
  VIEW_INVENTORY: 'view_inventory',                     // (M1) list, detail, health, dashboard
  MANAGE_INVENTORY_MASTER: 'manage_inventory_master',   // (M1) edit planning parameters
  MANAGE_BOX_NUMBER: 'manage_box_number',               // (M1) add/change the SKU -> box number mapping
  CONFIGURE_INVENTORY: 'configure_inventory',           // (M1) thresholds, reason codes, locations
  EXPORT_INVENTORY: 'export_inventory',                 // (M1) export lists and reports
  VIEW_STOCK_LEDGER: 'view_stock_ledger',               // (M2) movement history
  POST_STOCK_IN: 'post_stock_in',                       // (M7) receipts and opening stock
  POST_STOCK_OUT: 'post_stock_out',                     // (M7) manual issues
  ADJUST_STOCK: 'adjust_stock',                         // (M7) create adjustments
  APPROVE_ADJUSTMENT: 'approve_adjustment',             // (M7) approve above threshold
  PERFORM_COUNT: 'perform_count',                       // (M7) enter counts
  APPROVE_COUNT: 'approve_count',                       // (M7) approve variances and post
  TRANSFER_STOCK: 'transfer_stock',                     // (M7) inter-location transfers
  /**
   * (M1) Remove a SKU from the catalogue entirely.
   *
   * Its own permission, and Admin-only, for the same reason MANAGE_BOX_NUMBER
   * is: an Inventory Manager maintains what a SKU says, and deleting one is not
   * maintenance - it is the removal of a business key that orders, movements
   * and counts refer to by name. The service refuses outright to delete a SKU
   * anything has ever referenced, so this permission governs only the removal
   * of catalogue entries created in error.
   */
  DELETE_SKU: 'delete_sku',

  // ── Customer Portal ─────────────────────────────────────────────────────
  //
  // NEW KEYS, describing access that until now was simply not permissioned:
  // the dashboard, the catalogue, booking history, the profile screen and help
  // were shown to whoever the sidebar decided to show them to, with no key
  // behind the decision.
  //
  // That was fine while the only question was "customer or staff". It is not
  // fine once a Super Admin is expected to compose a role out of sub-modules:
  // a Customer Portal you cannot grant or withhold section by section is not a
  // module, it is a hardcoded menu.
  //
  // Each key is seeded below to exactly the roles that can reach that screen
  // today, so naming them changes nobody's access on the day they ship.
  VIEW_DASHBOARD: 'view_dashboard',       // the main (booking) dashboard
  VIEW_ORDERS: 'view_orders',             // booking + indent history, read
  VIEW_CATALOGUE: 'view_catalogue',       // the product catalogue at /inventory
  VIEW_PROFILE: 'view_profile',           // own profile and settings
  EDIT_PROFILE: 'edit_profile',           // change own profile and settings
  VIEW_HELP: 'view_help',                 // help and support

  // ── HRMS ────────────────────────────────────────────────────────────────
  //
  // HRMS enforces module x action x scope, not these flat strings, so these
  // keys authorise NOTHING inside HRMS by themselves. Each one is a way for the
  // Super Admin to say "this role holds that HRMS role", and
  // utils/hrmsAccessBridge.js is where the sentence is translated. The HRMS
  // guard, the scopes and the matrix in shared/permissions/ are untouched.
  //
  // WHY A TIER PER HRMS ROLE, RATHER THAN ONE `access_hrms` SWITCH
  //
  // HRMS already models eight roles whose grants were ported wholesale from the
  // reference and reviewed as a set - a payroll admin sees bank details, a
  // recruiter sees candidates, an auditor sees everything and writes nothing.
  // Re-deriving those distinctions as portal cells would be inventing a second,
  // worse copy of a matrix that already exists. So the portal grants ENTRY at
  // the granularity HRMS itself is built on, and HRMS keeps deciding what each
  // tier means.
  //
  // None of these may begin with `hrms_`: that prefix is what isHrmsRoleKey()
  // uses to recognise a role key inside User.roles[], and user.controller.js
  // refuses extra grants that compile to one.
  ACCESS_HRMS: 'access_hrms',                       // employee self-service
  MANAGE_HRMS_TEAM: 'manage_hrms_team',             // reporting manager
  MANAGE_HRMS_PEOPLE: 'manage_hrms_people',         // HR admin
  MANAGE_HRMS_PAYROLL: 'manage_hrms_payroll',       // payroll admin
  MANAGE_HRMS_HIRING: 'manage_hrms_hiring',         // recruiter
  MANAGE_HRMS_ASSETS: 'manage_hrms_assets',         // IT / asset admin
  AUDIT_HRMS: 'audit_hrms',                         // auditor, read-only
  ADMINISTER_HRMS: 'administer_hrms',               // the whole of HRMS
};

/**
 * Every screen in the portal that has always been open to any signed-in
 * account. Named once so the seven baselines below cannot disagree about it.
 *
 * EDIT_PROFILE is in here because it is self-service: it changes the actor's
 * own display name, avatar and notification preferences and nothing else (see
 * updateMe in the auth controller, which refuses email, company, role and
 * category outright). Withholding it would be withholding a user's ability to
 * set their own avatar.
 */
const PORTAL_BASICS = [
  PERMISSIONS.VIEW_DASHBOARD,
  PERMISSIONS.VIEW_CATALOGUE,
  PERMISSIONS.VIEW_PROFILE,
  PERMISSIONS.EDIT_PROFILE,
  PERMISSIONS.VIEW_HELP,
];

/**
 * Role -> permission baseline.
 *
 * Two separation-of-duties rules are enforced structurally here, not by policy:
 *
 *  - Sales holds RAISE_PO but not OVERRIDE_PO_LOCK - raising the PO locks the
 *    booking against the very role that raised it. Only the wildcard clears it.
 *  - Inventory Manager holds ADJUST_STOCK but NOT APPROVE_ADJUSTMENT, and
 *    Management holds the approval without the ability to create. Nobody can
 *    both make and approve their own stock correction.
 *
 * MANAGE_CUSTOMER_USERS is the third structural rule. Sales can create and
 * maintain CUSTOMER accounts and nothing else - not an Admin, not another
 * salesperson, not itself. Privilege escalation through user management is the
 * obvious attack on a role that can create logins, so the restriction is on the
 * TARGET's role and is checked in the controller for every read and write.
 *
 * CONFIGURE_INVENTORY is Admin-only: a threshold change silently reclassifies
 * thousands of SKUs, so it sits with the role that already owns global settings.
 *
 * MANAGE_BOX_NUMBER is Admin-only for the same reason, and is deliberately NOT
 * granted to Inventory Manager despite that role holding
 * MANAGE_INVENTORY_MASTER. The box number is the physical picking location for
 * a SKU: it is quoted on every PO and read off by the warehouse, so it must
 * stay stable and change only when the packing actually changes. Splitting it
 * out of the planning permission is what stops it drifting as an ordinary
 * master-data edit. Sales holds neither permission and so cannot reach it at
 * all.
 */
export const BASELINE_ROLE_PERMISSIONS = {
  /**
   * Super Admin - requirement 2. The wildcard, and the name the client asked
   * for. `Admin` below is the SAME authority under the name this system has
   * used since it was built; both are kept so that renaming nobody's account is
   * a prerequisite for shipping this.
   */
  'Super Admin': ['*'],
  Admin: ['*'],

  /**
   * HR - the whole of HRMS, and the ordinary portal screens.
   *
   * The one new role. It holds ADMINISTER_HRMS, which the bridge reads as
   * `hrms_super_admin`, so "full access to the HRMS module" is a single grant
   * rather than eight that have to be kept in step.
   *
   * It deliberately holds NO sales, inventory or user-administration
   * permission. HR is not a portal administrator: someone who needs both is
   * given both, which is what the matrix is for.
   *
   * Note what this means for Super Admin and Admin, and that it is a DELIBERATE
   * REVERSAL - of the stance in shared/permissions/matrix.js, which held that
   * the portal's `Admin: ['*']` wildcard must not reach HRMS because it would
   * silently hand every portal administrator payroll, PAN and bank-detail
   * access. The requirement now asks for exactly that: "HR, Admin, and Super
   * Admin should be able to access and use the complete HRMS functionality". So
   * the wildcard satisfies ADMINISTER_HRMS like any other key, and all three
   * roles come away with the same HRMS access.
   *
   * It is no longer SILENT, which was the actual objection: HRMS is a visible
   * block of cells in the permission matrix, and an admin who does not want a
   * role to have it can build a role without it.
   *
   * This is not a reversal of AD-3 itself. That decision record specifies
   * effective permissions as the "union of all entries in roles[] PLUS role" -
   * the implementation is what narrowed it to roles[] alone. The bridge
   * restores the union AD-3 described.
   */
  HR: [
    ...PORTAL_BASICS,
    PERMISSIONS.ADMINISTER_HRMS,
  ],

  Sales: [
    ...PORTAL_BASICS,
    PERMISSIONS.VIEW_ORDERS,
    PERMISSIONS.VIEW_ALL_BOOKINGS,
    // Sales onboards its own customers. Deliberately NOT MANAGE_USERS: that
    // would also let a salesperson create an Admin or promote themselves.
    // The narrower permission is enforced on the target account's role in
    // user.controller.js - a permission alone cannot express "only Customers".
    PERMISSIONS.MANAGE_CUSTOMER_USERS,
    PERMISSIONS.EDIT_BOOKING_PRE_PO,
    PERMISSIONS.RAISE_PO,
    // Sales quotes the customer, so Sales sees the price schedule. Admin holds
    // it through the wildcard. No other built-in role does — a warehouse or
    // import user has no reason to know what anyone is charged — and a Super
    // Admin can grant it to a role they invent through the matrix, which is
    // what "other specifically authorized users" means here.
    PERMISSIONS.VIEW_PRICING,
    PERMISSIONS.VIEW_REPORTS,
    // Sales needs to know what can be sold - availability only, never the
    // ledger, costs or adjustments.
    PERMISSIONS.VIEW_INVENTORY,
  ],

  'Inventory Manager': [
    ...PORTAL_BASICS,
    PERMISSIONS.VIEW_INVENTORY,
    PERMISSIONS.VIEW_STOCK_LEDGER,
    PERMISSIONS.MANAGE_INVENTORY_MASTER,
    PERMISSIONS.EXPORT_INVENTORY,
    PERMISSIONS.POST_STOCK_IN,
    PERMISSIONS.POST_STOCK_OUT,
    PERMISSIONS.ADJUST_STOCK,
    PERMISSIONS.PERFORM_COUNT,
    PERMISSIONS.APPROVE_COUNT,
    PERMISSIONS.TRANSFER_STOCK,
    PERMISSIONS.VIEW_REPORTS,
  ],

  'Warehouse User': [
    ...PORTAL_BASICS,
    PERMISSIONS.VIEW_INVENTORY,
    PERMISSIONS.VIEW_STOCK_LEDGER,
    PERMISSIONS.EXPORT_INVENTORY,
    PERMISSIONS.POST_STOCK_IN,
    PERMISSIONS.PERFORM_COUNT,
    PERMISSIONS.TRANSFER_STOCK,
  ],

  // Oversight: read everything, approve, create nothing.
  Management: [
    ...PORTAL_BASICS,
    PERMISSIONS.VIEW_INVENTORY,
    PERMISSIONS.VIEW_STOCK_LEDGER,
    PERMISSIONS.EXPORT_INVENTORY,
    PERMISSIONS.APPROVE_ADJUSTMENT,
    PERMISSIONS.APPROVE_COUNT,
    PERMISSIONS.VIEW_REPORTS,
  ],

  /**
   * Import Team - maintains the catalogue, and touches nothing else.
   *
   * The narrowest of the internal roles by design. It exists for the people who
   * load and correct product data in bulk: the inventory master, the product
   * content, the import wizard behind both, and the reads that make them
   * usable. It holds NO ordering or booking permission at all, which is what
   * makes "hide sales and booking from this user" a fact about the role rather
   * than a decision the UI has to remember to take.
   *
   * What it deliberately does NOT have:
   *
   *  - CREATE_ORDER / VIEW_ORDERS / VIEW_ALL_BOOKINGS / EDIT_BOOKING_PRE_PO /
   *    RAISE_PO - every booking write path is refused, and the sales desk is
   *    invisible.
   *  - MANAGE_BOX_NUMBER - Admin-only for everyone (see the note above); a box
   *    number is a physical picking location quoted on every PO, and the import
   *    is not the way around that. An import that CREATES a SKU may still set
   *    its first box, which is a rule about new SKUs, not about this role.
   *  - ADJUST_STOCK / PERFORM_COUNT / APPROVE_* - correcting a counted balance
   *    is warehouse and management work. This role loads data; it does not
   *    decide that the shelf disagrees with the system.
   *  - CONFIGURE_INVENTORY - thresholds and reason codes reclassify the whole
   *    catalogue, and stay with the role that owns global settings.
   *
   * POST_STOCK_IN is included because the Inventory Master sheet carries a
   * Quantity column: importing one posts a receipt through the ledger, and a
   * role that may run that import must hold the permission the movement needs.
   */
  'Import Team': [
    ...PORTAL_BASICS,
    PERMISSIONS.VIEW_INVENTORY,
    PERMISSIONS.MANAGE_INVENTORY_MASTER,
    PERMISSIONS.EXPORT_INVENTORY,
    PERMISSIONS.VIEW_STOCK_LEDGER,
    PERMISSIONS.POST_STOCK_IN,
  ],

  /**
   * Customer - requirement 1. The Customer Portal, and nothing else.
   *
   * Every key here belongs to the customer_portal module, and the Customer role
   * carries portalOnly, so the resolver refuses to hand it anything outside
   * that module no matter what the matrix says.
   */
  Customer: [
    ...PORTAL_BASICS,
    PERMISSIONS.CREATE_ORDER,
    PERMISSIONS.VIEW_ORDERS,
  ],
};

/**
 * Internal staff roles. They act on the business's own inventory rather than
 * their own orders, so they see every brand - the per-user brandAccess flags
 * exist to scope CUSTOMERS. Sales is deliberately excluded: its brand
 * visibility is already decided separately by the sales-desk rules.
 */
export const INVENTORY_ROLES = ['Inventory Manager', 'Warehouse User', 'Management', 'Import Team'];

/** Roles the code itself references by name, and which therefore cannot be deleted. */
export const SYSTEM_ROLE_NAMES = Object.keys(BASELINE_ROLE_PERMISSIONS);

/** The two names that mean unrestricted access. */
export const SUPER_ADMIN_ROLES = ['Super Admin', 'Admin'];

/**
 * Roles confined to the Customer Portal - requirement 1, as a compiled-in fact.
 *
 * The Role document carries a `portalOnly` flag too, and it is the flag the
 * Super Admin can set on a role they invent. This list is the part that does
 * not depend on the database being readable.
 *
 * That distinction is the whole reason it exists. The fence is a CEILING on
 * what a role can come away holding, and a ceiling that disappears when a
 * query fails is not a ceiling. With this list compiled in, a customer account
 * stays inside the portal on a cold process, an empty roles collection, or a
 * Mongo outage - the same conditions the baseline is designed to survive.
 */
export const PORTAL_ONLY_ROLES = ['Customer'];

export const isPortalOnlyRoleName = (name) => PORTAL_ONLY_ROLES.includes(name);

export const isSuperAdminRoleName = (name) => SUPER_ADMIN_ROLES.includes(name);

export const baselineFor = (roleName) => BASELINE_ROLE_PERMISSIONS[roleName] || [];

export default {
  PERMISSIONS,
  BASELINE_ROLE_PERMISSIONS,
  INVENTORY_ROLES,
  SYSTEM_ROLE_NAMES,
  SUPER_ADMIN_ROLES,
  PORTAL_ONLY_ROLES,
  isSuperAdminRoleName,
  isPortalOnlyRoleName,
  baselineFor,
};
