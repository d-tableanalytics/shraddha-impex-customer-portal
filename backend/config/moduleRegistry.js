/**
 * The ERP module registry - the single source of truth for "what can be
 * permissioned".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY IT IS A MAPPING RATHER THAN A REPLACEMENT
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Enforcement in this codebase is spread across ~145 call sites that ask a flat
 * question: authorize('view_inventory'), hasPermission(user, RAISE_PO). Those
 * keys are load-bearing. They encode judgements that took real thought - that
 * Sales may raise a PO but not unlock the booking it locks, that an Inventory
 * Manager may create an adjustment but never approve their own - and they are
 * quoted in comments, verification scripts and route files throughout.
 *
 * The requirement is a Super-Admin-configurable matrix of
 * module x sub-module x {view, create, edit, delete, approve}. The naive way to
 * get one is to invent a new permission vocabulary and rewrite all 145 sites.
 * That trades a working authorisation system for a migration, and every site
 * missed is a hole.
 *
 * So this registry is a TRANSLATION LAYER instead. A grant of
 * `inventory.master:delete` is not a new kind of permission - it is a way of
 * SAYING `delete_sku`, which is the key the route already enforces. The matrix
 * is the vocabulary the Super Admin speaks; the flat keys stay the vocabulary
 * the code speaks; this file is the dictionary.
 *
 * Three properties fall out of that, and they are the reason for the design:
 *
 *   1. Nothing existing breaks. Every authorize() and hasPermission() call is
 *      untouched, because the answer they get is still a flat key.
 *   2. The matrix cannot grant something the code does not enforce. An action
 *      with no keys behind it grants nothing - it cannot silently become a
 *      permission that only the UI respects.
 *   3. A new module is added by appending an entry here. No resolver change, no
 *      migration, no new middleware. That is requirement 8.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW TO READ AN ENTRY
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   actions: { view: ['view_inventory'], delete: ['delete_sku'] }
 *
 * means: ticking "View" on this sub-module grants `view_inventory`; ticking
 * "Delete" grants `delete_sku`. An action absent from the map is not offered in
 * the matrix at all - "Approve" on a screen with nothing to approve is a
 * checkbox that lies, so those cells are rendered as unavailable rather than as
 * unchecked.
 *
 * Where an action lists SEVERAL keys, ticking it grants all of them. That is
 * the case for sub-modules whose screen needs more than one capability to be
 * usable - the inventory import needs both the master-data permission and the
 * receipt permission, because the sheet it loads carries a quantity column.
 *
 * `path: null` means the sub-module is a CAPABILITY, not a screen. Stock
 * receipts, transfers and box numbers are actions taken inside other screens;
 * they are permissioned separately because the business separates them, but
 * they contribute no sidebar entry. The nav builder skips them.
 *
 * `hidden: true` means the screen EXISTS but is not offered in the sidebar yet.
 * Different from `path: null`, and worth its own flag: the route is real and
 * can be reached deliberately, it is simply not finished enough to advertise.
 * The nav builder skips it; the permission matrix still lists it, so access can
 * be configured before the screen ships rather than after.
 */

/** The five actions the Super Admin can grant, in display order. */
/**
 * ── THE PORTALS ──────────────────────────────────────────────────────────
 *
 * One database, one `users` collection, one `roles` collection — and two
 * DOMAINS that must show different things to the same account.
 *
 *   customer   Customer Management, Inventory, Sales Desk
 *   employee   HRMS and the company's internal modules
 *
 * A user may legitimately exist in both: a salesperson works bookings in the
 * customer domain and their own leave in the employee one. What must NOT leak
 * is the MODULE SET — signing into the customer domain must not surface HRMS,
 * and typing an employee-domain URL there must not reach it.
 *
 * Every module below declares which portals may serve it, and that single tag
 * is what the menu, the permission ceiling, the route guard and the frontend
 * nav all read. Adding a third portal is a new string here plus a tag on each
 * module it owns — no new plumbing.
 *
 * A module tagged with BOTH is served by both, deliberately: `administration`
 * is where accounts and roles are maintained, and both domains need part of it.
 * Sub-modules narrow further — "manage customers" and "manage internal users"
 * are the same shape of screen pointed at different populations, and they do
 * not belong in the same domain.
 */
export const PORTALS = Object.freeze({
  CUSTOMER: 'customer',
  EMPLOYEE: 'employee',
});

export const PORTAL_LIST = Object.freeze(Object.values(PORTALS));

export const isPortal = (value) => PORTAL_LIST.includes(value);

/**
 * Which portals serve this module or sub-module.
 *
 * An UNTAGGED entry belongs to every portal. That default is deliberate: adding
 * a module without thinking about domains cannot accidentally hide it, and the
 * tag is only needed where a real boundary exists. The opposite default —
 * untagged means nowhere — would make a forgotten tag look like a broken
 * deployment rather than an unfinished thought.
 */
export const portalsOf = (entry) =>
  Array.isArray(entry?.portals) && entry.portals.length ? entry.portals : PORTAL_LIST;

export const servesPortal = (entry, portal) => portalsOf(entry).includes(portal);

export const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve'];

export const ACTION_LABELS = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  approve: 'Approve',
};

/**
 * MODULES - every module and sub-module in the ERP.
 *
 * `order` drives both the sidebar and the permission matrix, so the two always
 * present the system in the same shape. Icons are lucide-react names, resolved
 * on the frontend; the backend never renders them and does not care.
 */
export const MODULES = [
  /**
   * CUSTOMER PORTAL - requirement 6.
   *
   * Everything a customer-facing session touches, grouped under ONE module.
   * These screens were previously seven unrelated top-level sidebar entries
   * with no shared identity; naming the group is what makes "customers get the
   * Customer Portal and nothing else" a sentence the system can actually
   * enforce, rather than a list somebody has to maintain by hand.
   *
   * Staff roles hold some of these too - Sales works the same booking screens
   * on a customer's behalf - so this is a MODULE, not a synonym for the
   * Customer role. What makes a customer a customer is holding nothing else.
   */
  {
    key: 'customer_portal',
    portals: [PORTALS.CUSTOMER],
    label: 'Customer Portal',
    description: 'Everything the customer-facing portal offers.',
    icon: 'Store',
    order: 10,
    submodules: [
      {
        key: 'dashboard',
        label: 'Dashboard',
        path: '/',
        icon: 'LayoutDashboard',
        actions: { view: ['view_dashboard'] },
      },
      {
        key: 'create_booking',
        label: 'Create Booking',
        path: '/orders/new',
        icon: 'PlusCircle',
        // Two keys because two audiences reach the same screen: a customer
        // booking for themselves, and the desk booking on their behalf.
        actions: {
          view: ['create_order', 'view_all_bookings'],
          create: ['create_order'],
        },
      },
      {
        key: 'bulk_upload',
        label: 'Bulk Upload',
        path: '/orders/bulk-upload',
        icon: 'UploadCloud',
        actions: {
          view: ['create_order', 'view_all_bookings'],
          create: ['create_order'],
        },
      },
      {
        key: 'booking_history',
        label: 'Booking History',
        path: '/orders/history',
        icon: 'History',
        actions: {
          view: ['view_orders'],
          edit: ['edit_booking_pre_po'],
          delete: ['manage_orders'],
          approve: ['manage_orders'],
        },
      },
      {
        key: 'indent_history',
        label: 'Indent History',
        path: '/orders/indent-history',
        icon: 'PackageX',
        actions: {
          view: ['view_orders'],
          edit: ['manage_orders'],
        },
      },
      {
        key: 'catalogue',
        label: 'Product Catalogue',
        path: '/inventory',
        icon: 'Boxes',
        actions: { view: ['view_catalogue'] },
      },
      {
        key: 'profile',
        label: 'Profile & Settings',
        path: '/settings',
        icon: 'Settings',
        actions: { view: ['view_profile'], edit: ['edit_profile'] },
      },
      {
        key: 'support',
        label: 'Help & Support',
        path: '/help',
        icon: 'HelpCircle',
        actions: { view: ['view_help'] },
      },
    ],
  },

  /**
   * SALES DESK.
   *
   * `approve` is RAISE_PO and `delete` is OVERRIDE_PO_LOCK, which preserves the
   * separation of duties the flat keys already encode: a role can be given the
   * power to raise the PO without being given the power to reopen the booking
   * that raising it locked. Granting both to one role is possible - it is the
   * Super Admin's call - but it now has to be a deliberate tick rather than an
   * accident of sharing one permission.
   */
  {
    key: 'sales',
    portals: [PORTALS.CUSTOMER],
    label: 'Sales Desk',
    description: 'Reviewing, amending and releasing customer bookings.',
    icon: 'FileCheck2',
    order: 20,
    submodules: [
      {
        key: 'bookings',
        label: 'Booking Desk',
        path: '/sales',
        icon: 'FileCheck2',
        actions: {
          view: ['view_all_bookings'],
          create: ['create_order'],
          edit: ['edit_booking_pre_po'],
          delete: ['override_po_lock'],
          approve: ['raise_po'],
        },
      },
      {
        /**
         * Its own sub-module, with ONE cell, because the thing being granted is
         * "may see what we charge" - a commercial fact, not a screen. It has no
         * path: the price selector lives inside the PO dialog on the booking
         * desk above, and the four tier prices appear nowhere else in the app.
         *
         * `view` covers both halves of the requirement deliberately. Seeing the
         * tiers and choosing between them are the same act at the desk - a
         * salesperson who can read the schedule to quote it can quote it - and
         * splitting them would produce a role that can look at every price and
         * do nothing with it.
         */
        key: 'pricing',
        label: 'Customer Pricing',
        path: null,
        actions: { view: ['view_pricing'] },
      },
    ],
  },

  /**
   * INVENTORY MANAGEMENT (the IMS).
   *
   * The adjustments and counts entries are where the make/approve split lives:
   * `create` is ADJUST_STOCK / PERFORM_COUNT and `approve` is
   * APPROVE_ADJUSTMENT / APPROVE_COUNT. They are separate cells, so the rule
   * "nobody both makes and approves their own stock correction" survives as
   * something a reviewer can SEE in the matrix.
   */
  {
    key: 'inventory',
    portals: [PORTALS.CUSTOMER],
    label: 'Inventory Management',
    description: 'Stock master data, movements, counts and health.',
    icon: 'Warehouse',
    order: 30,
    submodules: [
      {
        key: 'dashboard',
        label: 'Inventory Dashboard',
        path: '/inventory/dashboard',
        icon: 'GaugeCircle',
        actions: { view: ['view_inventory'] },
      },
      {
        key: 'master',
        label: 'Inventory Master',
        path: '/inventory/master',
        icon: 'Warehouse',
        actions: {
          view: ['view_inventory'],
          create: ['manage_inventory_master'],
          edit: ['manage_inventory_master'],
          delete: ['delete_sku'],
        },
      },
      {
        key: 'health',
        label: 'Inventory Health',
        path: '/inventory/health',
        icon: 'Activity',
        actions: { view: ['view_inventory'] },
      },
      {
        key: 'ledger',
        label: 'Stock Ledger',
        path: '/inventory/ledger',
        icon: 'ScrollText',
        actions: { view: ['view_stock_ledger'] },
      },
      {
        key: 'imports',
        label: 'Inventory Import',
        path: '/inventory/import',
        icon: 'Upload',
        // The Inventory Master sheet carries a Quantity column, so running the
        // import posts a receipt through the ledger. A role that may run it
        // must hold the permission that movement needs.
        actions: {
          view: ['view_inventory'],
          create: ['manage_inventory_master', 'post_stock_in'],
        },
      },
      {
        key: 'product_content',
        label: 'Product Details',
        path: '/admin/product-details',
        icon: 'Images',
        actions: {
          view: ['manage_inventory_master'],
          create: ['manage_inventory_master'],
          edit: ['manage_inventory_master'],
          delete: ['manage_inventory_master'],
        },
      },
      {
        key: 'adjustments',
        label: 'Stock Adjustments',
        path: null,
        actions: {
          view: ['view_inventory'],
          create: ['adjust_stock'],
          edit: ['adjust_stock'],
          approve: ['approve_adjustment'],
        },
      },
      {
        key: 'counts',
        label: 'Stock Counts',
        path: null,
        actions: {
          view: ['view_inventory'],
          create: ['perform_count'],
          edit: ['perform_count'],
          approve: ['approve_count'],
        },
      },
      {
        key: 'receipts',
        label: 'Stock Receipts (Stock In)',
        path: null,
        actions: { create: ['post_stock_in'] },
      },
      {
        key: 'issues',
        label: 'Stock Issues (Stock Out)',
        path: null,
        actions: { create: ['post_stock_out'] },
      },
      {
        key: 'transfers',
        label: 'Stock Transfers',
        path: null,
        actions: { create: ['transfer_stock'] },
      },
      {
        key: 'alerts',
        label: 'Inventory Alerts',
        path: null,
        actions: {
          view: ['view_inventory'],
          edit: ['manage_inventory_master'],
          approve: ['approve_adjustment'],
        },
      },
      {
        key: 'exports',
        label: 'Inventory Export',
        path: null,
        actions: { view: ['export_inventory'] },
      },
      {
        // Its own sub-module because a box number is a physical picking
        // location quoted on every PO, not ordinary master data - see the note
        // in middlewares/rbac.js. Splitting it out is what stops it drifting.
        key: 'box_numbers',
        label: 'Box Numbers',
        path: null,
        actions: { edit: ['manage_box_number'] },
      },
      {
        key: 'configuration',
        label: 'Inventory Configuration',
        path: null,
        actions: {
          view: ['view_inventory'],
          edit: ['configure_inventory'],
        },
      },
    ],
  },

  {
    key: 'reports',
    portals: [PORTALS.CUSTOMER],
    label: 'Reports',
    description: 'Operational and inventory reporting.',
    icon: 'BarChart3',
    order: 40,
    submodules: [
      {
        // HIDDEN FROM THE SIDEBAR, deliberately and as before.
        //
        // /reports is still a stub rendering placeholder figures, and the old
        // sidebar had its menu entry commented out for exactly that reason. It
        // is registered here so the access can be configured, and hidden so
        // that registering it does not put invented numbers in front of the
        // four roles that hold view_reports. Drop `hidden` when the screen is
        // real.
        key: 'operational',
        label: 'Reports',
        path: '/reports',
        hidden: true,
        icon: 'BarChart3',
        actions: { view: ['view_reports'] },
      },
    ],
  },

  /**
   * ADMINISTRATION.
   *
   * `users` carries both MANAGE_USERS and MANAGE_CUSTOMER_USERS because the
   * screen is the same one; WHICH accounts an actor may touch is decided per
   * account by denyIfOutOfScope() in the user controller, which a route-level
   * permission cannot express. Granting the module here is granting entry to
   * the screen, not blanket authority over every account in it.
   */
  /**
   * HRMS.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * EVERY SUB-MODULE HERE IS `path: null`, AND THAT IS THE WHOLE DESIGN
   * ─────────────────────────────────────────────────────────────────────────
   *
   * HRMS has its own navigation, driven by its own evaluator against the actor
   * the server resolves - twenty-odd screens whose visibility depends on
   * module x action x scope, which a portal `view` cell cannot express. Giving
   * these cells a path would put a SECOND set of HRMS links in the sidebar,
   * computed a different way, free to disagree with the first.
   *
   * So they are capabilities, exactly as stock receipts and box numbers are:
   * the matrix grants ENTRY, and the HRMS nav decides what entry shows you.
   *
   * `view` is the only action offered. Ticking a tier means "this role holds
   * that HRMS role"; what the tier may then create, edit, delete or approve is
   * already written down in shared/permissions/matrix.js and is not the
   * portal's to re-decide. Offering the other four here would be four checkboxes
   * that change nothing - the lie the header of this file warns about.
   *
   * Sub-modules are ordered by breadth: self-service, then the four functional
   * administrations, then read-only oversight, then everything.
   */
  {
    key: 'hrms',
    portals: [PORTALS.EMPLOYEE],
    label: 'HRMS',
    description: 'Human resources: self-service, people operations, payroll, hiring and HR administration.',
    icon: 'Users',
    order: 45,
    submodules: [
      {
        key: 'access',
        label: 'HRMS Access (Employee Self-Service)',
        path: null,
        actions: { view: ['access_hrms'] },
      },
      {
        key: 'team',
        label: 'Team Management (Reporting Manager)',
        path: null,
        actions: { view: ['manage_hrms_team'] },
      },
      {
        key: 'people',
        label: 'People Operations (HR Admin)',
        path: null,
        actions: { view: ['manage_hrms_people'] },
      },
      {
        key: 'payroll',
        label: 'Payroll Administration',
        path: null,
        actions: { view: ['manage_hrms_payroll'] },
      },
      {
        key: 'hiring',
        label: 'Recruitment',
        path: null,
        actions: { view: ['manage_hrms_hiring'] },
      },
      {
        key: 'assets',
        label: 'IT & Asset Administration',
        path: null,
        actions: { view: ['manage_hrms_assets'] },
      },
      {
        key: 'audit',
        label: 'HR Audit (read-only)',
        path: null,
        actions: { view: ['audit_hrms'] },
      },
      {
        key: 'administration',
        label: 'Full HRMS Administration',
        path: null,
        actions: { view: ['administer_hrms'] },
      },
    ],
  },

  /**
   * FMS — Fulfilment Management System. O2D is its first workflow.
   *
   * ⚠ THE KEY IS STILL `o2d`, AND DELIBERATELY SO.
   *
   * §1 renames the section to FMS, and what a rename may safely move is the
   * LABEL and the PATH. The key must not move: it is the identity that
   * `requirePortalModule('o2d')` fences on, that `view_o2d` and its siblings are
   * named after, and — the part that cannot be fixed by a find-and-replace —
   * that is already written into the `roles` rows of a live shared database.
   * Renaming it would silently revoke FMS from every role that holds it, which
   * presents as "the menu is empty" rather than as an error.
   *
   * So: FMS is what people read, `o2d` is what the system checks. The one place
   * that must not drift is this file, which is why both appear here together.
   *
   * Unlike the `hrms` block above, these cells DO carry paths: FMS has no
   * navigation of its own, so the registry is what puts it in the sidebar. The
   * HRMS cells are grant-only precisely because HRMS draws its own menu.
   *
   * Employee-domain only. The module's actors are internal staff and its data is
   * its own; nothing about it belongs in a customer-facing session.
   */
  {
    key: 'o2d',
    portals: [PORTALS.EMPLOYEE],
    label: 'FMS',
    description: 'Fulfilment Management System — the twelve-stage O2D workflow, its tasks and its analytics.',
    icon: 'Truck',
    order: 25,
    submodules: [
      {
        key: 'tasks',
        label: 'My Tasks',
        path: '/fms/o2d/tasks',
        icon: 'ListChecks',
        // Everyone who can see O2D has a task inbox; it shows only what their
        // own role owns, which the query enforces rather than the permission.
        actions: { view: ['view_o2d'] },
      },
      {
        key: 'orders',
        label: 'Order Tracker',
        path: '/fms/o2d/orders',
        icon: 'LayoutGrid',
        actions: {
          view: ['view_o2d'],
          create: ['create_o2d_order'],
          // "Edit" here is completing a stage — the only way an order moves.
          edit: ['work_o2d_stage'],
          // Cancel / void. Not a database delete: §29 keeps the record.
          delete: ['exit_o2d'],
          // Hold, resume, proceed-anyway, out-of-order completion.
          approve: ['override_o2d'],
        },
      },
      {
        key: 'stages',
        label: 'Stages',
        path: '/fms/o2d/stages',
        icon: 'LayoutGrid',
        // §27's stage-wise view: one tab per stage, and the live orders sitting
        // in each. VIEW_O2D only — it is the same population the Order Tracker
        // already shows, sliced by position rather than filtered by hand. What a
        // viewer may SEE is narrowed by role scope in the service, not here.
        actions: { view: ['view_o2d'] },
      },
      {
        key: 'hold',
        label: 'Hold & Resume',
        path: null,
        hidden: true,
        // A capability rather than a screen: holding happens from Order 360.
        actions: { edit: ['hold_o2d'] },
      },
      {
        key: 'analytics',
        label: 'Delay Analytics',
        path: '/fms/o2d/analytics',
        icon: 'BarChart3',
        actions: { view: ['view_o2d_analytics'] },
      },
      {
        key: 'masters',
        label: 'FMS Masters',
        path: '/fms/o2d/masters',
        icon: 'Settings',
        // §37: SLA, calendar and escalation configuration, editable without a
        // deploy. Its own cell so it can be granted apart from working orders.
        actions: {
          view: ['manage_o2d_masters'],
          edit: ['manage_o2d_masters'],
        },
      },
    ],
  },

  {
    key: 'administration',
    portals: [PORTALS.CUSTOMER, PORTALS.EMPLOYEE],
    label: 'Administration',
    description: 'Users, roles and system-wide access control.',
    icon: 'ShieldCheck',
    order: 50,
    submodules: [
      {
        key: 'overview',
        label: 'Admin Panel',
        path: '/admin',
        icon: 'LayoutGrid',
        /*
         * `manage_customer_users` is DELIBERATELY not here any more.
         *
         * It used to be, which made Sales an administrator as far as this tile
         * page was concerned — and once the domains were split that leaked:
         * Sales held the key through this sub-module, `overview` is served by
         * both domains, so a salesperson signing into the EMPLOYEE portal saw an
         * "Admin Panel" entry pointing at a route that portal does not even
         * mount. Caught by resolving real accounts against both domains.
         *
         * Nothing is lost. Customer Management is its own sidebar entry now, and
         * it still admits `manage_customer_users` — so Sales reaches the screen
         * they actually use in one click rather than via a tile grid. This page
         * is for administering the SYSTEM, which is what the two keys left here
         * mean.
         */
        actions: { view: ['manage_users', 'manage_roles'] },
      },
      /*
       * ── TWO USER-MANAGEMENT SCREENS, NOT ONE ────────────────────────────
       *
       * `users` used to be a single screen doing both jobs, gated on
       * `manage_users` OR `manage_customer_users`. That conflated two workflows
       * that only look alike:
       *
       *   Customer Management     onboard the businesses we sell to. Sales owns
       *                           it, holds MANAGE_CUSTOMER_USERS, and the
       *                           controller already refuses them any account
       *                           whose role is not Customer.
       *   Internal User Management  create staff — Sales, Inventory Manager,
       *                           Admin. Needs MANAGE_USERS, which is the
       *                           permission that can grant privilege, and is
       *                           therefore the one worth keeping separate.
       *
       * Splitting them is what stops "add a user" meaning two different things
       * depending on who clicks it, and it makes the domain split expressible:
       * customers are a customer-domain concern, staff are an internal one.
       *
       * The BACKEND distinction already existed — two permissions and
       * `denyIfOutOfScope` in user.controller.js. Only the UI was fused.
       */
      {
        key: 'customers',
        label: 'Customer Management',
        path: '/admin/customers',
        icon: 'Store',
        // Customer accounts are a customer-domain concern; the Employee Portal
        // has no reason to onboard the businesses we sell to.
        portals: [PORTALS.CUSTOMER],
        actions: {
          view: ['manage_customer_users', 'manage_users'],
          create: ['manage_customer_users', 'manage_users'],
          edit: ['manage_customer_users', 'manage_users'],
          delete: ['manage_users'],
        },
      },
      {
        key: 'users',
        label: 'Internal User Management',
        path: '/admin/users',
        icon: 'Users',
        /*
         * BOTH portals, and that is a deliberate choice rather than an
         * oversight. The staff created here work in BOTH domains — a
         * salesperson lives in the customer portal, an HR admin in the employee
         * one — so an administrator in either domain may need to create one.
         * `manage_users` gates it, and no customer-facing role holds that.
         */
        portals: [PORTALS.CUSTOMER, PORTALS.EMPLOYEE],
        actions: {
          view: ['manage_users'],
          create: ['manage_users'],
          edit: ['manage_users'],
          delete: ['manage_users'],
        },
      },
      {
        key: 'roles',
        label: 'Roles & Permissions',
        path: '/admin/permissions',
        icon: 'Key',
        /*
         * EMPLOYEE PORTAL ONLY.
         *
         * This matrix grants access across BOTH domains' modules, and both
         * repositories write the same `roles` collection. Two screens
         * recompiling the same `Role.grants` is the hazard SHARED-CONTRACT.md
         * documents — a save from one domain can strip cells the other wrote.
         * Keeping the single editor in the internal domain removes the race
         * rather than trying to merge around it.
         */
        portals: [PORTALS.EMPLOYEE],
        actions: {
          view: ['manage_roles'],
          create: ['manage_roles'],
          edit: ['manage_roles'],
          delete: ['manage_roles'],
        },
      },
    ],
  },
];

// ── Lookups ────────────────────────────────────────────────────────────────
// Built once at import. The resolver runs on every permission check, so it must
// not be walking arrays to find a sub-module.

/** 'module.submodule' -> { module, submodule } */
const SUBMODULE_INDEX = new Map();
/** 'module' -> module */
const MODULE_INDEX = new Map();

for (const mod of MODULES) {
  MODULE_INDEX.set(mod.key, mod);
  for (const sub of mod.submodules) {
    SUBMODULE_INDEX.set(`${mod.key}.${sub.key}`, { module: mod, submodule: sub });
  }
}

export const getModule = (moduleKey) => MODULE_INDEX.get(moduleKey) || null;

export const getSubmodule = (moduleKey, submoduleKey) =>
  SUBMODULE_INDEX.get(`${moduleKey}.${submoduleKey}`) || null;

/** Actions this sub-module actually offers, in ACTIONS order. */
export const availableActions = (submodule) =>
  ACTIONS.filter((action) => Array.isArray(submodule?.actions?.[action]));

/**
 * The flat permission keys a single (module, sub-module, action) grant means.
 * An unknown module, sub-module or action grants NOTHING rather than throwing -
 * a role document naming a module that was later renamed must not take the
 * server down, and must not accidentally grant access either.
 */
export const keysForGrant = (moduleKey, submoduleKey, action) => {
  const found = SUBMODULE_INDEX.get(`${moduleKey}.${submoduleKey}`);
  if (!found) return [];
  const keys = found.submodule.actions?.[action];
  return Array.isArray(keys) ? keys : [];
};

/**
 * Compile a role's grant list into the flat permission set the code enforces.
 *
 * This is the whole translation, and it is deliberately the only place it
 * happens: everything else - middleware, controllers, the sidebar - asks about
 * flat keys, exactly as it did before this system existed.
 */
export const compileGrants = (grants = []) => {
  const permissions = new Set();
  for (const grant of grants) {
    if (!grant?.module || !grant?.submodule) continue;
    for (const action of grant.actions || []) {
      for (const key of keysForGrant(grant.module, grant.submodule, action)) {
        permissions.add(key);
      }
    }
  }
  return permissions;
};

/**
 * The reverse translation: which matrix cells does this flat permission set
 * light up?
 *
 * Used to MIGRATE the roles that already exist. Each of the seven built-in
 * roles is defined today by a list of flat keys; running it through here
 * produces the grant matrix that means exactly the same thing, which is what
 * requirement 7 asks for - existing access mapped into the new structure rather
 * than re-decided by hand.
 *
 * A cell is granted only when EVERY key behind it is held. That direction
 * matters: the inventory import needs two keys, and a role holding one of them
 * has not earned the tick - showing it as granted would tell the Super Admin
 * this role can run imports when it cannot.
 */
export const grantsFromPermissions = (permissionKeys = []) => {
  const held = new Set(permissionKeys);
  const wildcard = held.has('*');
  const grants = [];

  for (const mod of MODULES) {
    for (const sub of mod.submodules) {
      const actions = availableActions(sub).filter((action) => {
        const keys = sub.actions[action];
        return wildcard || keys.every((key) => held.has(key));
      });
      if (actions.length) {
        grants.push({ module: mod.key, submodule: sub.key, actions });
      }
    }
  }

  return grants;
};

/**
 * Check an incoming grant list against the registry.
 *
 * Returns `{ grants }` on success or `{ error }` on the first problem found.
 *
 * REJECTS RATHER THAN SILENTLY DROPPING. A matrix that quietly discards a cell
 * it does not recognise tells the caller the save succeeded while giving them
 * something other than what they ticked, and the difference only surfaces later
 * as somebody who cannot do their job.
 *
 * Lives here rather than in a controller because grants arrive on two paths -
 * a role's matrix and a single user's extra access - and two copies of this
 * would eventually disagree about what a valid grant is. The registry is the
 * thing being validated against, so it is the thing that knows.
 */
export const validateGrants = (grants) => {
  if (!Array.isArray(grants)) return { error: 'grants must be an array.' };

  const clean = [];
  const seen = new Set();

  for (const grant of grants) {
    const { module: moduleKey, submodule, actions } = grant || {};

    const found = getSubmodule(moduleKey, submodule);
    if (!found) {
      return { error: `Unknown module or sub-module: ${moduleKey}.${submodule}` };
    }

    const id = `${moduleKey}.${submodule}`;
    if (seen.has(id)) {
      return { error: `${id} is listed twice. Send one entry per sub-module.` };
    }
    seen.add(id);

    if (!Array.isArray(actions)) {
      return { error: `actions must be an array for ${id}` };
    }

    const offered = availableActions(found.submodule);
    for (const action of actions) {
      if (!ACTIONS.includes(action)) {
        return { error: `Unknown action "${action}" on ${id}` };
      }
      if (!offered.includes(action)) {
        return {
          error: `"${action}" is not available on ${id}. Available: ${offered.join(', ') || 'none'}`,
        };
      }
    }

    // Deduplicated and ordered so two matrices that mean the same thing compare
    // equal, which is what makes an audit diff readable.
    const unique = ACTIONS.filter((a) => actions.includes(a));
    if (unique.length) clean.push({ module: moduleKey, submodule, actions: unique });
  }

  return { grants: clean };
};

/** Every flat key any cell in the registry can grant. */
export const allRegistryKeys = () => {
  const keys = new Set();
  for (const mod of MODULES) {
    for (const sub of mod.submodules) {
      for (const action of availableActions(sub)) {
        for (const key of sub.actions[action]) keys.add(key);
      }
    }
  }
  return [...keys];
};

/**
 * The registry as the admin UI needs it - modules ordered, sub-modules carrying
 * only the actions they really offer. Sent over the wire so the matrix screen
 * never has to keep its own copy of the catalogue.
 */
/**
 * The registry as the permission-matrix screen sees it.
 *
 * ---------------------------------------------------------------------------
 * SCOPED TO ONE DOMAIN, AND WHY THAT IS SAFE
 * ---------------------------------------------------------------------------
 *
 * `portal` narrows the matrix to the modules THAT domain serves, so the
 * Employee Portal's Roles & Permissions screen shows HRMS and Administration
 * and not the Customer Portal, Sales Desk or Inventory.
 *
 * The obvious worry is data loss: if the screen cannot see a customer-domain
 * cell, does saving a role wipe it? No, and the reason is worth writing down
 * because it is not obvious from this file.
 *
 * `PermissionMatrix.jsx` seeds its draft with `grantsToMap(role.grants)` — the
 * role's STORED grants, keyed `module.submodule`, built without consulting the
 * registry at all. Cells it does not render are simply never touched, and
 * `mapToGrants(draft)` serialises the whole map back. So a hidden cell makes the
 * round trip unchanged.
 *
 * Server-side, `validateGrants` still checks against the FULL `MODULES` list —
 * deliberately not filtered — so those returning cells are recognised rather
 * than rejected as "Unknown module or sub-module". Filtering the validator too
 * would turn every save of a role holding another domain's grants into a 400.
 *
 * A `portal` of null/undefined returns everything, which is what a caller that
 * genuinely wants the whole vocabulary should ask for.
 */
export const registryForClient = (portal = null) =>
  [...MODULES]
    .filter((mod) => !portal || servesPortal(mod, portal))
    .sort((a, b) => a.order - b.order)
    .map((mod) => ({
      key: mod.key,
      label: mod.label,
      description: mod.description,
      icon: mod.icon,
      order: mod.order,
      submodules: mod.submodules
        // Sub-modules narrow independently: Roles & Permissions is
        // employee-only inside an Administration module both domains serve.
        .filter((sub) => !portal || servesPortal({ portals: sub.portals ?? mod.portals }, portal))
        .map((sub) => ({
          key: sub.key,
          label: sub.label,
          path: sub.path ?? null,
          hidden: !!sub.hidden,
          icon: sub.icon ?? null,
          actions: availableActions(sub),
        })),
    }));

export default {
  ACTIONS,
  ACTION_LABELS,
  MODULES,
  getModule,
  getSubmodule,
  availableActions,
  keysForGrant,
  compileGrants,
  grantsFromPermissions,
  validateGrants,
  allRegistryKeys,
  registryForClient,
};
