/**
 * "About this module" documentation: Administration.
 *
 * GENERATED from the module audit; edit the text here directly when a screen
 * changes. The code each statement was verified against is listed in
 * docs/module-documentation-map.md, not here, so no source paths ship to the
 * browser. `verified: false` items show as "Requires verification".
 */
export default [
  {
    "key": "administration.overview",
    "portal": "customer",
    "paths": [
      "/admin"
    ],
    "title": "Admin Control Panel",
    "overview": {
      "what": "A tile page that links to the Customer Portal's administration screens: customers, staff accounts, roles, product details and inventory.",
      "why": "Gives administrators one starting point for system setup instead of hunting through the sidebar.",
      "users": [
        "Super Admin",
        "Admin"
      ]
    },
    "functions": [
      {
        "title": "User Management tile",
        "detail": "Opens Customer Management, where customer accounts are added and their category (MSIL / Customer) is set."
      },
      {
        "title": "Internal User Management tile",
        "detail": "Opens the staff accounts screen. Staff created there work in both portals."
      },
      {
        "title": "Roles & Permissions tile",
        "detail": "Shown only to people who may manage roles. Opens the Customer Portal's permission matrix."
      },
      {
        "title": "Product Details tile",
        "detail": "Opens descriptions, images and videos per SKU."
      },
      {
        "title": "Inventory tile",
        "detail": "Opens live stock across all brands."
      }
    ],
    "connections": [
      {
        "module": "Customer Management",
        "key": "administration.customers",
        "why": "Tile link",
        "data": "Navigation only",
        "direction": "one-way",
        "trigger": "User clicks the tile",
        "verified": true
      },
      {
        "module": "Internal User Management",
        "key": "administration.users",
        "why": "Tile link",
        "data": "Navigation only",
        "direction": "one-way",
        "trigger": "User clicks the tile",
        "verified": true
      },
      {
        "module": "Roles & Permissions",
        "key": "administration.roles",
        "why": "Tile link, shown only with role-management access",
        "data": "Navigation only",
        "direction": "one-way",
        "trigger": "User clicks the tile",
        "verified": true
      },
      {
        "module": "Product Details",
        "key": "inventory.product_content",
        "why": "Tile link",
        "data": "Navigation only",
        "direction": "one-way",
        "trigger": "User clicks the tile",
        "verified": true
      }
    ],
    "impacts": [],
    "rules": [
      {
        "title": "Who can open it",
        "detail": "Needs the 'Manage Users' or 'Manage Roles' permission. Super Admin and Admin hold everything. Sales does not see this page; Sales reaches Customer Management directly from the sidebar.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Customer Portal only",
        "detail": "The Employee Portal has no /admin route; its administration screens are opened from the sidebar.",
        "kind": "permission",
        "verified": true
      }
    ],
    "steps": [
      "Open Admin from the sidebar.",
      "Pick the tile for the task: customers, staff, roles, product content or inventory.",
      "Do the work on that screen.",
      "Use the browser back button or the sidebar to return here."
    ],
    "warnings": [],
    "unverified": [
      "The tiles for Customer Management, Internal User Management, Product Details and Inventory are shown to everyone who can open the page. Each target screen checks its own permission, so a tile can lead to an access-denied page."
    ]
  },
  {
    "key": "administration.customers",
    "portal": "customer",
    "paths": [
      "/admin/customers"
    ],
    "title": "Customer Management",
    "overview": {
      "what": "The list of customer accounts: the businesses that log in to book stock. You add customers here, set their category and brand access, and suspend or restore them.",
      "why": "Every booking belongs to a customer account. The category and brand access set here decide what the customer can see and book.",
      "users": [
        "Sales",
        "Super Admin",
        "Admin"
      ]
    },
    "functions": [
      {
        "title": "Add a customer",
        "detail": "Enter email, password, contact name, company and the Customer Master details: Customer Name, Phone, Location, Shop, Vendor and GST numbers. Shipping and billing addresses are optional."
      },
      {
        "title": "Set category",
        "detail": "MSIL or Customer. Category changes MOQ and MSIL rules on that customer's bookings."
      },
      {
        "title": "Brand access",
        "detail": "Tick which brands the customer may see and book. New customers start with all brands ticked."
      },
      {
        "title": "Show MSIL code",
        "detail": "An on/off setting saved on the customer account."
      },
      {
        "title": "Search",
        "detail": "Matches customer name, contact name, company or email."
      },
      {
        "title": "Suspend / restore",
        "detail": "Setting status to Suspended moves the account out of the active list into an archive. Setting it back to Active recreates it with the same id."
      },
      {
        "title": "Reset password",
        "detail": "Sets a new password (at least 5 characters). For a suspended account it takes effect once the account is restored."
      },
      {
        "title": "Return to Create Booking",
        "detail": "When opened from '+ Add Customer' on Create Booking, the Add form opens by itself. After saving, you are sent back to the booking with the new customer selected."
      }
    ],
    "connections": [
      {
        "module": "Create Booking (booking on behalf)",
        "key": "customer_portal.create_booking",
        "why": "Sales and Admin pick the customer from the same accounts list",
        "data": "Active Customer accounts: name, company, category, brand access, MOQ, MSIL code setting, addresses",
        "direction": "one-way",
        "trigger": "Customer picker search on Create Booking",
        "verified": true
      },
      {
        "module": "Bookings on every booking screen",
        "key": null,
        "why": "Bookings show the customer's current details",
        "data": "Customer Name, company, contact, phone, location, shop, vendor, GST, category, addresses are read live from the customer account",
        "direction": "one-way",
        "trigger": "Any screen that loads bookings",
        "verified": true
      },
      {
        "module": "Booking emails",
        "key": null,
        "why": "Booking mail is copied to the customer's Booking CC addresses",
        "data": "Booking CC Emails stored on the customer account",
        "direction": "one-way",
        "trigger": "Booking emails sent by the booking modules",
        "verified": true
      },
      {
        "module": "Login",
        "key": null,
        "why": "Suspension blocks sign-in",
        "data": "Account status",
        "direction": "one-way",
        "trigger": "Sign-in or any request with an old token",
        "verified": true
      },
      {
        "module": "Audit log",
        "key": null,
        "why": "Every create, update, password reset and role change is logged",
        "data": "Actor, action name, target",
        "direction": "one-way",
        "trigger": "Saving on this screen",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Editing a customer's address or brand access",
        "effect": "Applies to new bookings. Existing bookings keep the address they were made with; the picklist already issued is unchanged.",
        "kind": "historical",
        "verified": true
      },
      {
        "action": "Filling in a missing Customer Master detail",
        "effect": "Shows on every past and future booking of that customer, because booking screens read the customer profile live.",
        "kind": "automatic",
        "verified": true
      },
      {
        "action": "Suspending a customer",
        "effect": "The account leaves the active users list. The customer cannot sign in and current sessions are refused. Sales can no longer book on their behalf. Their existing bookings and indents are not changed or cancelled; booking screens fall back to the details saved on each booking.",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Restoring a suspended customer",
        "effect": "The account is recreated with its original id, so its bookings link back to it.",
        "kind": "automatic",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Who can use it",
        "detail": "Needs 'Manage Customer Users' (held by Sales) or 'Manage Users' (Super Admin, Admin). Sales can only see and change Customer accounts.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Master details are locked after creation",
        "detail": "Customer Name, Phone, Location, Shop, Vendor and GST numbers cannot be edited on a live account. The save is refused rather than silently ignored.",
        "kind": "validation",
        "verified": true
      },
      {
        "title": "Unique email",
        "detail": "An email already used by a live or suspended account is refused.",
        "kind": "validation",
        "verified": true
      },
      {
        "title": "Category values",
        "detail": "Only MSIL or Customer are accepted.",
        "kind": "validation",
        "verified": true
      },
      {
        "title": "No role changes or extra access for Sales",
        "detail": "Changing an account's role and granting extra per-account access are for full administrators only.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Cannot suspend yourself",
        "detail": "Suspending your own account is refused.",
        "kind": "validation",
        "verified": true
      }
    ],
    "steps": [
      "Open Customer Management from the sidebar (or the Admin panel).",
      "Search for the customer, or click Add User.",
      "Fill in the contact, company and Customer Master details, category and brand access.",
      "Save. The customer can now sign in.",
      "To change category, brand access or status later, click the edit (pencil) icon.",
      "The customer now appears in the Create Booking customer picker and on their bookings."
    ],
    "warnings": [
      {
        "title": "Master details cannot be corrected later",
        "detail": "Check Customer Name, phone, location, shop, vendor and GST numbers before saving. They are locked on a live account.",
        "severity": "irreversible"
      },
      {
        "title": "Suspending removes the account from the active list",
        "detail": "A confirmation is shown first. The customer is logged out and cannot book until restored.",
        "severity": "warning"
      }
    ],
    "unverified": [
      "MOQ and Booking CC Emails are stored on the customer account but are not in the list of fields this screen can update. Where are they set? (Possibly migration/import scripts only.)",
      "Nothing on this screen permanently deletes a customer; the 'delete' permission cell gates no action yet."
    ]
  },
  {
    "key": "administration.users",
    "portal": "both",
    "paths": [
      "/admin/users"
    ],
    "title": "Internal User Management",
    "overview": {
      "what": "The list of staff accounts (Sales, Billing, Warehouse, HR, Admin and other internal roles). The same screen exists in both portals and edits the same accounts.",
      "why": "Staff need one account that works in both portals, with the right role.",
      "users": [
        "Super Admin",
        "Admin"
      ]
    },
    "functions": [
      {
        "title": "Add a staff account",
        "detail": "Email, password, name, company and role."
      },
      {
        "title": "Change role",
        "detail": "Moves the person to another role. Their access changes on their next request."
      },
      {
        "title": "Suspend / restore",
        "detail": "Suspended accounts move to an archive and cannot sign in; restoring recreates them."
      },
      {
        "title": "Reset password",
        "detail": "Sets a new password. Rate-limited."
      },
      {
        "title": "Access (extra grants)",
        "detail": "Gives one account a few permissions beyond its role. Only adds, never removes."
      }
    ],
    "connections": [
      {
        "module": "Roles & Permissions",
        "key": "administration.roles",
        "why": "The role chosen here decides what the person can do",
        "data": "Role name on the account",
        "direction": "one-way",
        "trigger": "Saving a role change",
        "verified": true
      },
      {
        "module": "HRMS employee records",
        "key": null,
        "why": "HRMS roles held by the account limit which portal role it may take",
        "data": "HRMS roles on the account",
        "direction": "one-way",
        "trigger": "Changing an account's role",
        "verified": true
      },
      {
        "module": "Other portal",
        "key": null,
        "why": "Both portals read and write the same users collection",
        "data": "Staff accounts",
        "direction": "two-way",
        "trigger": "Any save in either portal",
        "verified": true
      },
      {
        "module": "Audit log",
        "key": null,
        "why": "Changes are logged",
        "data": "Create, update, role, password, access actions",
        "direction": "one-way",
        "trigger": "Saving",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Changing a person's role",
        "effect": "Their menus and allowed actions change on their next page load in both portals. No re-login is needed because access is worked out on each request.",
        "kind": "automatic",
        "verified": true
      },
      {
        "action": "Suspending a staff account",
        "effect": "They are refused on the next request in both portals. Work assigned to them (Work Queue tasks, O2D stages) is not reassigned automatically.",
        "kind": "manual",
        "verified": false
      }
    ],
    "rules": [
      {
        "title": "Who can use it",
        "detail": "Opening needs 'Manage Users'. Creating needs 'Create Users', editing needs 'Edit Users'. Super Admin and Admin hold all of these; Sales does not.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Customer Portal checks per target",
        "detail": "In the Customer Portal, which accounts you may create or edit is checked against the account type: Customer accounts need the Customer Management permission, staff accounts need the Internal User Management permission.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Extra access: admins only",
        "detail": "Only full administrators who can also manage roles see the Access button.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Each portal edits only its own extra grants",
        "detail": "In the Customer Portal, extra grants for Employee Portal modules are kept as stored and cannot be changed from there.",
        "kind": "permission",
        "verified": true
      }
    ],
    "steps": [
      "Open Internal User Management from the sidebar (Administration).",
      "Search for the person, or click Add User.",
      "Enter email, password, name and role, then save.",
      "Use the pencil icon to change role or status, the key icon to reset a password.",
      "The person signs in to either portal and sees the screens their role allows."
    ],
    "warnings": [
      {
        "title": "Role changes take effect immediately",
        "detail": "Giving someone an admin role gives them full access to both portals on their next click.",
        "severity": "warning"
      }
    ],
    "unverified": [
      "Permanent erase of an employee is done in HRMS (employee record), not on this screen. Its effect on the login account requires verification.",
      "Whether open Work Queue or O2D work moves when a staff account is suspended was not traced."
    ]
  },
  {
    "key": "administration.roles.customer",
    "portal": "customer",
    "paths": [
      "/admin/permissions"
    ],
    "title": "Roles & Permissions",
    "overview": {
      "what": "The Customer Portal's own permission matrix: the same roles, but only the Customer Portal's screens (bookings, sales desk, inventory, customers).",
      "why": "Lets an administrator adjust Customer Portal access without touching Employee Portal permissions.",
      "users": [
        "Super Admin",
        "Admin"
      ]
    },
    "functions": [
      {
        "title": "Edit a role's matrix",
        "detail": "Tick or untick actions on Customer Portal screens and save."
      },
      {
        "title": "Create / delete roles",
        "detail": "Same rules as the Employee Portal matrix."
      },
      {
        "title": "Locked cells",
        "detail": "Some cells are stored narrowly or cannot be changed here (see rules). The screen shows them as they are saved."
      }
    ],
    "connections": [
      {
        "module": "Roles & Permissions (Employee Portal)",
        "key": "administration.roles",
        "why": "Same roles collection",
        "data": "Role grants; Employee Portal cells are kept as stored on every save here",
        "direction": "two-way",
        "trigger": "Saving a role",
        "verified": true
      },
      {
        "module": "Every Customer Portal screen",
        "key": null,
        "why": "Ticks decide access and sidebar",
        "data": "Role grants",
        "direction": "one-way",
        "trigger": "Saving; periodic 60-second reload",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Saving a role",
        "effect": "Only Customer Portal cells change. Employee Portal ticks on the same role are kept exactly as stored. This portal reloads roles before replying; the Employee Portal picks up the change only when its own role list next reloads.",
        "kind": "multi",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Who can use it",
        "detail": "Only Super Admin and Admin in practice: the role-management permissions belong to an Employee Portal screen, so this portal removes them from everyone else.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Customer Management cell is narrowed",
        "detail": "Ticking Customer Management stores only 'Manage Customer Users', never full user administration.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Derived cells",
        "detail": "New Booking View, Bulk Upload View and Admin Panel View cannot be changed here; they follow other access.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Same protections as the Employee matrix",
        "detail": "Full-access flag only by a Super Admin; built-in roles cannot be renamed or deleted; roles in use cannot be deleted; Customer role stays fenced.",
        "kind": "validation",
        "verified": true
      }
    ],
    "steps": [
      "Open Admin, then the Roles & Permissions tile.",
      "Select a role.",
      "Tick or untick Customer Portal actions.",
      "Click Save. The role's holders see the change on their next request in this portal."
    ],
    "warnings": [
      {
        "title": "Two editors, one role list",
        "detail": "Changes here are not shown in the Employee Portal matrix until its server reloads roles.",
        "severity": "warning"
      }
    ],
    "unverified": [
      "The route is not wrapped in the sidebar module guard; the page itself checks role-management access. Confirm non-admins see an access message rather than a blank page."
    ]
  }
];
