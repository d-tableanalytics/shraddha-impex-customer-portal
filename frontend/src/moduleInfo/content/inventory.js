/**
 * "About this module" documentation: Inventory Management.
 *
 * GENERATED from the module audit; edit the text here directly when a screen
 * changes. The code each statement was verified against is listed in
 * docs/module-documentation-map.md, not here, so no source paths ship to the
 * browser. `verified: false` items show as "Requires verification".
 */
export default [
  {
    "key": "inventory.dashboard",
    "portal": "customer",
    "paths": [
      "/inventory/dashboard"
    ],
    "title": "Inventory Dashboard",
    "overview": {
      "what": "A one-page summary of stock: SKU counts per health band, stock totals, days of cover and filters by brand, category and date.",
      "why": "Lets staff see at a glance how much of the catalogue is out of stock, critical, low, healthy or overstocked without opening each SKU.",
      "users": [
        "Admin",
        "Sales",
        "Inventory Manager",
        "Warehouse User",
        "Management",
        "Import Team"
      ]
    },
    "functions": [
      {
        "title": "Band summary",
        "detail": "Counts SKUs in each band (Out of Stock, Critical, Low, Healthy, Overstock, No Planning Data). Every figure is read from the stored health and balance records; the screen calculates nothing itself."
      },
      {
        "title": "Drill into Inventory Health",
        "detail": "Clicking a summary tile opens Inventory Health already filtered to that band."
      },
      {
        "title": "Filters",
        "detail": "Brand, category and date filters. You only see brands your account allows."
      },
      {
        "title": "Unplannable reasons",
        "detail": "Shows why SKUs have no target: no stock movement yet, no daily consumption, no lead time, no safety factor, or not active."
      }
    ],
    "connections": [
      {
        "module": "Inventory Health",
        "key": "inventory.health",
        "why": "The bands shown here are the health records that screen lists.",
        "data": "Band, available %, coverage days per SKU",
        "direction": "one-way",
        "trigger": "Page load (the result is cached briefly on the server)",
        "verified": true
      },
      {
        "module": "Stock Ledger (balances)",
        "key": "inventory.ledger",
        "why": "On-hand totals come from the balances the ledger builds.",
        "data": "On hand, reserved per SKU and location",
        "direction": "one-way",
        "trigger": "Page load",
        "verified": true
      },
      {
        "module": "Brands",
        "key": "inventory.brands",
        "why": "Adding, changing or deleting a brand clears the dashboard's cached figures.",
        "data": "Brand list",
        "direction": "one-way",
        "trigger": "Brand saved on the Brands screen",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Any stock movement (booking, adjustment, import, count)",
        "effect": "Balances and health are recomputed for the SKUs touched; the dashboard shows the new figures the next time it loads. It does not refresh live.",
        "kind": "automatic",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Who can open it",
        "detail": "Needs the 'View Inventory' permission, held by Admin, Sales, Inventory Manager, Warehouse User, Management and Import Team.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "No trend, no alerts",
        "detail": "The dashboard shows today's position only. It has no history chart and does not list inventory alerts.",
        "kind": "validation",
        "verified": true
      }
    ],
    "steps": [
      "Open Inventory Management > Inventory Dashboard.",
      "Pick a brand or category if you need a narrower view.",
      "Read the band tiles to see how many SKUs need attention.",
      "Click a tile, such as Critical, to open Inventory Health filtered to those SKUs."
    ],
    "warnings": [
      {
        "title": "Figures can lag",
        "detail": "The page does not update by itself. Reload it after a large import or adjustment.",
        "severity": "warning"
      }
    ],
    "unverified": [
      "Exact cache duration of the dashboard payload was not checked."
    ]
  },
  {
    "key": "inventory.master",
    "portal": "customer",
    "paths": [
      "/inventory/master"
    ],
    "title": "Inventory Master",
    "overview": {
      "what": "The internal list of every SKU with its codes, box number, brand, stock balances (On Hand, Reserved, Available), planning inputs and status.",
      "why": "It is where staff add and maintain SKUs, correct stock, set prices and reach the health and brand screens.",
      "users": [
        "Admin",
        "Inventory Manager",
        "Import Team",
        "Warehouse User",
        "Management",
        "Sales (pricing only)"
      ]
    },
    "functions": [
      {
        "title": "SKU list and filters",
        "detail": "Search by SKU or MSIL code; filter by brand, status (Active, Inactive, Discontinued) and sort. Columns: SKU, MSIL, Box No, Brand / Category, On Hand, Reserved, Available, Planning (Ready / Incomplete), Status."
      },
      {
        "title": "SKU detail panel",
        "detail": "Click a row to see balances (read-only) and edit planning inputs: lead time, safety factor, season, multiple (MOQ), daily average for Low/Normal/Peak, unit, description, vendor and status."
      },
      {
        "title": "Add SKU",
        "detail": "Creates a new SKU under a brand you can access. Needs 'Manage Inventory Master'."
      },
      {
        "title": "Change SKU code",
        "detail": "The pencil next to the code renames it, but only for a SKU nothing has ever used."
      },
      {
        "title": "Delete SKU",
        "detail": "Admin only ('Delete SKU' permission). The dialog first lists what uses the SKU; deletion is refused if any order, reservation, movement, count or adjustment refers to it."
      },
      {
        "title": "Edit selected (bulk)",
        "detail": "Tick SKUs (or every SKU matching the filter, up to 10,000) and change planning inputs in one go."
      },
      {
        "title": "Update stock (Stock Adjustments)",
        "detail": "Row button 'Update stock'. You type the figure the shelf should hold; the system posts only the difference to the ledger as an adjustment with a reason code (default 'Manual adjustment'). Needs 'Adjust Stock' (Admin, Inventory Manager)."
      },
      {
        "title": "Update Stock Pricing tab",
        "detail": "Second tab in the same dialog. Changes the SKU's price tiers only; stock is untouched. Needs 'Manage Pricing' (Admin, Sales, Inventory Manager, Management, Import Team). Sales sees the row button as 'Update pricing'."
      },
      {
        "title": "Import button",
        "detail": "Opens a read-only SKU lookup: upload a file of SKU codes to see On Hand, Reserved and Available for each. It changes nothing. Creating SKUs or adding stock is done on the separate Inventory Import screen."
      },
      {
        "title": "Export",
        "detail": "Downloads the master list for the current filter or the ticked SKUs (Inventory Export capability, 'Export Inventory' permission)."
      },
      {
        "title": "Box No",
        "detail": "The physical picking box, quoted on every PO and on the Sales Desk. Only an Admin ('Manage Box Number') can change it; an import that creates a new SKU may set its first box."
      },
      {
        "title": "Inventory Health Check and Add Brands buttons",
        "detail": "Shortcuts to Inventory Health and Brands, which are no longer in the sidebar."
      },
      {
        "title": "Stock Counts (no screen)",
        "detail": "Count sessions (create, enter counts, submit, review, post) exist on the server and need 'Perform Count' / 'Approve Count'. The person who counted cannot approve. No page in the menu opens them today."
      },
      {
        "title": "Stock Receipts / Stock In (no screen)",
        "detail": "'Post Stock In' has no action of its own. It is required to run an Inventory Import, because the master sheet's Quantity column posts a receipt."
      },
      {
        "title": "Stock Issues / Stock Out and Stock Transfers (no screen)",
        "detail": "'Post Stock Out' and 'Transfer Stock' are permissions only. Post Stock Out merely lets a role open the import wizard; no issue or transfer action is implemented."
      },
      {
        "title": "Inventory Configuration (no screen)",
        "detail": "Thresholds, formula version, reason codes, stock locations, indent assignment mode, balance and health rebuilds and snapshots. Needs 'Configure Inventory', Admin only. Brands is its only screen."
      }
    ],
    "connections": [
      {
        "module": "Stock Ledger",
        "key": "inventory.ledger",
        "why": "Every stock change made here is posted as a movement.",
        "data": "Adjustment movements with reason, before/after quantity",
        "direction": "one-way",
        "trigger": "Update stock saved",
        "verified": true
      },
      {
        "module": "Inventory Health",
        "key": "inventory.health",
        "why": "Planning inputs and balances decide each SKU's band.",
        "data": "Lead time, consumption, safety factor, season, status, balances",
        "direction": "one-way",
        "trigger": "Stock adjustment or planning save",
        "verified": true
      },
      {
        "module": "Catalogue / Create Booking (customer stock)",
        "key": "customer_portal.catalogue",
        "why": "Stock posted here is mirrored onto the product's sellable figures so customers can book it.",
        "data": "Total, booked, available for sale, in transit",
        "direction": "one-way",
        "trigger": "Adjustment, import or count posted",
        "verified": true
      },
      {
        "module": "Upcoming Stock",
        "key": "inventory.health.upcoming",
        "why": "A stock increase is counted as arrival against open shipment lines.",
        "data": "Positive adjustment / receipt / count movements",
        "direction": "one-way",
        "trigger": "Stock increase posted",
        "verified": true
      },
      {
        "module": "Sales Desk / Purchase Orders",
        "key": null,
        "why": "Box number is printed on POs and shown on the Sales Desk.",
        "data": "Box No",
        "direction": "one-way",
        "trigger": "Box No saved by Admin",
        "verified": true
      },
      {
        "module": "Customer Pricing",
        "key": null,
        "why": "Pricing tab writes the price tiers customers and Sales are quoted.",
        "data": "Product price tiers",
        "direction": "one-way",
        "trigger": "Pricing saved",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Saving Update stock",
        "effect": "The difference is posted to the ledger, balances and health are recomputed, and the customer-facing available quantity is updated. This screen refreshes its list.",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Setting a SKU Inactive or Discontinued",
        "effect": "Refused while the SKU has any on-hand or reserved stock in any location. Existing bookings and indents are not changed by the status itself.",
        "kind": "manual",
        "verified": true
      },
      {
        "action": "Deleting a SKU",
        "effect": "Only possible when nothing has ever referred to it. Otherwise it is refused with a list of what uses it, and you should set it to Discontinued instead.",
        "kind": "manual",
        "verified": true
      },
      {
        "action": "Changing the box number",
        "effect": "Every PO raised after the change quotes the new box. POs already raised keep the old one.",
        "kind": "historical",
        "verified": false
      }
    ],
    "rules": [
      {
        "title": "Who can open this screen",
        "detail": "Anyone holding View Inventory: Admin, the inventory roles and Sales. Customers cannot. Sales sees the list read-only unless their role also grants editing, stock updates, pricing or export; each button appears only for the permission it needs.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Balances are read-only",
        "detail": "On Hand, Reserved and Available change only through stock movements. The server rejects direct edits.",
        "kind": "stock",
        "verified": true
      },
      {
        "title": "Adjustment reason must match direction",
        "detail": "A reason code that means a loss (for example damage) cannot be used on a stock increase, and only active reason codes are accepted.",
        "kind": "validation",
        "verified": true
      },
      {
        "title": "Make and approve are split",
        "detail": "Inventory Manager can adjust and count but not approve adjustments; Management approves but cannot create. A counter cannot approve their own count.",
        "kind": "approval",
        "verified": true
      },
      {
        "title": "Permissions",
        "detail": "Open: 'View Inventory'. Add/edit SKU: 'Manage Inventory Master' (Admin, Inventory Manager, Import Team). Delete SKU and Box No: Admin only. Update stock: 'Adjust Stock' (Admin, Inventory Manager). Pricing: 'Manage Pricing'. Export: 'Export Inventory'.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Brand scope",
        "detail": "You only see and edit SKUs of brands your account can access.",
        "kind": "permission",
        "verified": true
      }
    ],
    "steps": [
      "Open Inventory Management > Inventory Master.",
      "Search for the SKU or filter by brand and status.",
      "Click the row to check balances and edit planning inputs, then Save Changes.",
      "To correct stock, click Update stock, enter the real quantity and save.",
      "To change prices, open the Pricing tab in the same dialog.",
      "Check the result in the list, in Stock Ledger and in Inventory Health."
    ],
    "warnings": [
      {
        "title": "Stock adjustments are permanent",
        "detail": "Each adjustment is a ledger movement that cannot be edited or deleted; a mistake is fixed with another adjustment.",
        "severity": "irreversible"
      },
      {
        "title": "The Import button only looks up",
        "detail": "It does not add stock. Use Inventory Import to load quantities.",
        "severity": "warning"
      },
      {
        "title": "Delete is for mistakes only",
        "detail": "Use Discontinued to retire a SKU that has history.",
        "severity": "irreversible"
      }
    ],
    "unverified": [
      "Whether 'Update stock' broadcasts a live refresh to other users: the stock-updated event is sent by imports and counts only; adjustments refresh just the current screen.",
      "Approval threshold for adjustments ('Approve Adjustment') is declared but the Update stock path posts directly; whether any adjustment waits for approval requires verification."
    ]
  },
  {
    "key": "inventory.health",
    "portal": "customer",
    "paths": [
      "/inventory/health"
    ],
    "title": "Inventory Health",
    "overview": {
      "what": "Lists each SKU's health band, target stock (Max Level), available % and days of cover, with the arithmetic behind each figure.",
      "why": "Shows which SKUs need reordering and which are overstocked, based on consumption and lead time.",
      "users": [
        "Admin",
        "Sales",
        "Inventory Manager",
        "Warehouse User",
        "Management",
        "Import Team"
      ]
    },
    "functions": [
      {
        "title": "Health bands",
        "detail": "Out of Stock (zero on hand), Critical, Low, Healthy, Overstock, or No Planning Data when inputs are missing. Thresholds come from Inventory Configuration."
      },
      {
        "title": "Target formula",
        "detail": "Max Level = daily consumption x lead time x safety factor (formula v1, the default). A v2 formula exists and is chosen in configuration."
      },
      {
        "title": "Detail panel",
        "detail": "Click a SKU to see the inputs, the calculation and why a SKU cannot be planned."
      },
      {
        "title": "Filters and export",
        "detail": "Filter by band, brand and SKU; sort by cover; export the list."
      },
      {
        "title": "Recompute (rebuild)",
        "detail": "A full rebuild of health records exists on the server and needs 'Configure Inventory' (Admin only)."
      }
    ],
    "connections": [
      {
        "module": "Stock Ledger (balances)",
        "key": "inventory.ledger",
        "why": "Health is calculated from the balances.",
        "data": "On hand, reserved",
        "direction": "one-way",
        "trigger": "Any posted movement recomputes health for the SKUs it touched",
        "verified": true
      },
      {
        "module": "Inventory Master",
        "key": "inventory.master",
        "why": "Planning inputs drive the target; the page is reached from its Inventory Health Check button.",
        "data": "Lead time, consumption, safety factor, season, status",
        "direction": "one-way",
        "trigger": "Planning saved",
        "verified": true
      },
      {
        "module": "Inventory Alerts (in-app notifications)",
        "key": "inventory.alerts",
        "why": "After each recompute, the alert engine checks the SKUs and raises stock alerts.",
        "data": "SKU, band",
        "direction": "one-way",
        "trigger": "Health recomputed event",
        "verified": true
      },
      {
        "module": "Weekly inventory health report (email)",
        "key": null,
        "why": "A scheduled job emails a health report as Excel and PDF.",
        "data": "Health per SKU",
        "direction": "one-way",
        "trigger": "Weekly cron, if configured",
        "verified": true
      },
      {
        "module": "Inventory Dashboard",
        "key": "inventory.dashboard",
        "why": "The dashboard summarises these same records.",
        "data": "Bands, coverage",
        "direction": "one-way",
        "trigger": "Page load",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Changing thresholds or formula in configuration",
        "effect": "Can reclassify thousands of SKUs at once; an alert is raised about the change.",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Stock moving (booking, adjustment, import, count)",
        "effect": "Health for the touched SKUs is recomputed automatically. This screen shows it on next load.",
        "kind": "automatic",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Inventory Alerts (no screen)",
        "detail": "Alerts are raised only by the system (low stock, count waiting for approval, oversold, snapshot or rebuild failures, configuration changes). They go to the in-app notification bell of users whose role the rule names. Acknowledge/resolve needs 'Manage Inventory Master' or 'Approve Adjustment'; rule changes need 'Configure Inventory'. The alerts page exists in code but is not routed.",
        "kind": "automation",
        "verified": true
      },
      {
        "title": "Inventory snapshot",
        "detail": "A snapshot copies balances and health into a dated history record. It is created manually ('Configure Inventory'); the scheduled snapshot is written but not switched on in the server's cron.",
        "kind": "automation",
        "verified": true
      },
      {
        "title": "Who can open it",
        "detail": "Needs 'View Inventory'. It is hidden from the sidebar and opened from Inventory Master.",
        "kind": "permission",
        "verified": true
      }
    ],
    "steps": [
      "Open Inventory Master and click Inventory Health Check.",
      "Filter by band, for example Critical, or by brand.",
      "Click a SKU to see how its target and available % were worked out.",
      "Fix missing planning inputs on Inventory Master if a SKU shows No Planning Data.",
      "Export the list if you need to share a reorder list."
    ],
    "warnings": [
      {
        "title": "No Planning Data is not a shortage",
        "detail": "It means lead time, consumption or safety factor is missing, not that stock is low.",
        "severity": "warning"
      }
    ],
    "unverified": [
      "Whether the frontend shows the 'inventory:alert' live popup: the server emits it, but no frontend listener was found; the alert appears in the notification bell on fetch."
    ]
  },
  {
    "key": "inventory.health.upcoming",
    "portal": "customer",
    "paths": [
      "/inventory/upcoming"
    ],
    "title": "Upcoming Stock",
    "overview": {
      "what": "Stock ordered but not yet received, per SKU: Actual stock, Upcoming, how much open indents would take (Reserved) and what is left (Remaining).",
      "why": "Helps plan whether incoming shipments will cover customers' open indents.",
      "users": [
        "Admin",
        "Sales",
        "Inventory Manager",
        "Warehouse User",
        "Management",
        "Import Team"
      ]
    },
    "functions": [
      {
        "title": "Import upcoming shipments",
        "detail": "Upload a file of shipment lines (SKU, quantity, ETA, reference). Preview first, then save. Can create a missing SKU. Needs 'Manage Inventory Master'."
      },
      {
        "title": "Edit, cancel or delete a shipment line",
        "detail": "Correct a line, cancel the part not yet arrived, or delete a SKU's upcoming entries. Actual stock is not changed."
      },
      {
        "title": "Reserved is a calculation",
        "detail": "Each time the page loads, upcoming quantity is shared over the SKU's open indents, oldest indent first, earliest arrival first. Nothing is stored or reserved."
      },
      {
        "title": "Filters, sort and export",
        "detail": "Filter by arrival window (overdue, next 7 or 30 days, later), sort by ETA or remaining, export to Excel."
      }
    ],
    "connections": [
      {
        "module": "Stock Ledger",
        "key": "inventory.ledger",
        "why": "Arrivals are read from the ledger, not typed in here.",
        "data": "Positive receipt, opening, adjustment or count movements after the line was loaded",
        "direction": "one-way",
        "trigger": "Page load (sync runs on read)",
        "verified": true
      },
      {
        "module": "Inventory Master",
        "key": "inventory.master",
        "why": "Actual stock is the same on-hand figure; this page refreshes when stock changes.",
        "data": "On hand",
        "direction": "one-way",
        "trigger": "Stock-updated socket event",
        "verified": true
      },
      {
        "module": "Indent Stock Assignment",
        "key": "inventory.indent_assignment",
        "why": "Open indents are what the calculation shares upcoming stock over; real allocation is done there.",
        "data": "Open indents (Pending, Partially Confirmed)",
        "direction": "one-way",
        "trigger": "Page load",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Stock arriving through import, Update stock or a count",
        "effect": "Reduces the matching shipment lines, earliest ETA first.",
        "kind": "automatic",
        "verified": true
      },
      {
        "action": "Stock decreasing",
        "effect": "Never puts quantity back onto shipment lines.",
        "kind": "historical",
        "verified": true
      },
      {
        "action": "Importing, editing or cancelling shipments",
        "effect": "Recorded in the audit log. No email, notification or booking change.",
        "kind": "manual",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Internal analysis only",
        "detail": "Since 2026-10-22 nothing here reserves stock, changes an indent or emails a customer.",
        "kind": "automation",
        "verified": true
      },
      {
        "title": "Permissions",
        "detail": "View needs 'View Inventory'. Import and correct lines need 'Manage Inventory Master' (Admin, Inventory Manager, Import Team).",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Only later arrivals count",
        "detail": "A shipment line only receives stock that arrived after the line was loaded. Returns from bookings and location transfers do not count.",
        "kind": "stock",
        "verified": true
      }
    ],
    "steps": [
      "Open Inventory Management > Upcoming Stock.",
      "Click Import to load a shipment file, check the preview and save.",
      "Filter by arrival window to see what lands soon.",
      "Open a SKU to see which indents its upcoming stock would cover.",
      "When goods arrive, post them via Inventory Import or Update stock; the line reduces by itself."
    ],
    "warnings": [
      {
        "title": "Subtitle says 'Reserve'",
        "detail": "The page subtitle still says you can reserve upcoming stock, but the server only calculates. Use Indent Stock Assignment to actually allocate.",
        "severity": "warning"
      }
    ],
    "unverified": [
      "Whether IndentReservationSection on this page still offers any action button; no reserve endpoint exists on the server."
    ]
  },
  {
    "key": "inventory.ledger",
    "portal": "customer",
    "paths": [
      "/inventory/ledger"
    ],
    "title": "Stock Ledger",
    "overview": {
      "what": "The permanent history of every stock movement: receipts, opening stock, adjustments, counts, reservations, releases and issues, each with before and after quantities.",
      "why": "Answers 'why is this number what it is?'. All balances are totals of these movements.",
      "users": [
        "Admin",
        "Inventory Manager",
        "Warehouse User",
        "Management",
        "Import Team"
      ]
    },
    "functions": [
      {
        "title": "Grouped or All movements",
        "detail": "Grouped shows one row per posting; All movements shows every line."
      },
      {
        "title": "Search",
        "detail": "Filter by SKU, date range (required), movement type, brand, reference and batch."
      },
      {
        "title": "Posting batch",
        "detail": "Open a batch to see every movement written by one action."
      },
      {
        "title": "Export",
        "detail": "Download the filtered movements."
      }
    ],
    "connections": [
      {
        "module": "Create Booking / Sales Desk",
        "key": null,
        "why": "Confirming a booking reserves stock; cancel, PO expiry and PO raising release or consume it. Each is recorded here.",
        "data": "Reserve, release, consume movements with the booking reference",
        "direction": "one-way",
        "trigger": "Booking confirmed, edited, cancelled, PO raised, 7-day PO deadline (hourly job)",
        "verified": true
      },
      {
        "module": "Inventory Master",
        "key": "inventory.master",
        "why": "Update stock posts adjustments here.",
        "data": "Adjustment movements",
        "direction": "one-way",
        "trigger": "Update stock saved",
        "verified": true
      },
      {
        "module": "Inventory Import",
        "key": "inventory.imports",
        "why": "Imports post opening, receipt or adjustment movements; a Fresh Inventory Import posts the difference as a count.",
        "data": "Movements per row",
        "direction": "one-way",
        "trigger": "Import confirmed",
        "verified": true
      },
      {
        "module": "Inventory Health and Dashboard",
        "key": "inventory.health",
        "why": "After each posting, balances update and health is recomputed.",
        "data": "Balances",
        "direction": "one-way",
        "trigger": "Movement posted",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Booking confirmation",
        "effect": "Stock is first moved on the product (available to booked) inside the booking transaction. The ledger movement is queued and posted only after the booking commits; then balances and health update. If the ledger is slow or down, the booking still succeeds and the gap shows in reconciliation.",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Import or count posted",
        "effect": "A live 'stock updated' signal makes open Inventory Master, Upcoming Stock and the customer Inventory screen re-read.",
        "kind": "automatic",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Read-only",
        "detail": "No screen or API writes to the ledger directly. Movements cannot be edited or deleted; corrections are new movements or reversals.",
        "kind": "stock",
        "verified": true
      },
      {
        "title": "Whole numbers only",
        "detail": "Quantities must be whole, non-zero numbers of a known movement type.",
        "kind": "validation",
        "verified": true
      },
      {
        "title": "Who can open it",
        "detail": "Needs 'View Stock Ledger': Admin, Inventory Manager, Warehouse User, Management, Import Team. Sales does not have it.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Balance rebuild",
        "detail": "Balances can be rebuilt from the ledger and checked by a reconciliation report; both need 'Configure Inventory' (Admin).",
        "kind": "permission",
        "verified": true
      }
    ],
    "steps": [
      "Open Inventory Management > Stock Ledger.",
      "Enter a date range and, if needed, a SKU or movement type.",
      "Choose Grouped to see one row per action, or All movements for every line.",
      "Click a batch to see everything one posting changed.",
      "Compare the after quantity with Inventory Master's On Hand."
    ],
    "warnings": [
      {
        "title": "Bookings do not send a live refresh",
        "detail": "Booking reservations update the ledger but do not trigger the 'stock updated' signal; other screens show them on next load.",
        "severity": "warning"
      }
    ],
    "unverified": [
      "Exact list of movement types shown in the Movement Type filter (from StockMovement model) was not copied here."
    ]
  },
  {
    "key": "inventory.brands",
    "portal": "both",
    "paths": [
      "/inventory/brands"
    ],
    "title": "Brands",
    "overview": {
      "what": "The master list of brands the business sells, with how many products and users each has, and whether it is hidden from MSIL customers.",
      "why": "Every brand list, filter and brand-access rule in both portals is built from this list, so adding a brand here is the only step.",
      "users": [
        "Admin"
      ]
    },
    "functions": [
      {
        "title": "Add brand",
        "detail": "Enter a name (2-30 characters, letters, digits, spaces and &. -). A name too close to an existing one is refused."
      },
      {
        "title": "Hidden from MSIL",
        "detail": "Tick to stop MSIL customers ever seeing the brand. IMADA ships with this on. It is the only setting that can change on an existing brand."
      },
      {
        "title": "Delete brand",
        "detail": "Only for a brand created by mistake that nothing uses. Koken, BIX and IMADA cannot be deleted."
      }
    ],
    "connections": [
      {
        "module": "User Management (brand access)",
        "key": null,
        "why": "A new brand starts with no account ticked; customers and Sales see it only once ticked on their account.",
        "data": "Brand access flags on users",
        "direction": "two-way",
        "trigger": "Brand created or deleted (flags cleared)",
        "verified": true
      },
      {
        "module": "Inventory Master and product catalogue",
        "key": "inventory.master",
        "why": "Each brand gets its own product collection type, so SKUs can be filed under it.",
        "data": "Brand name and key",
        "direction": "one-way",
        "trigger": "Brand list reloaded",
        "verified": true
      },
      {
        "module": "Employee Portal",
        "key": null,
        "why": "Both portals share the brands collection; the other portal picks up changes within a minute.",
        "data": "Brand list",
        "direction": "two-way",
        "trigger": "Periodic reload",
        "verified": true
      },
      {
        "module": "Inventory Dashboard",
        "key": "inventory.dashboard",
        "why": "Its cached figures are cleared.",
        "data": "None",
        "direction": "one-way",
        "trigger": "Any brand save",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Adding a brand",
        "effect": "Appears at once in every brand list in this portal; open browsers are told to refresh (brands:updated). An audit entry is written.",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Changing Hidden from MSIL",
        "effect": "MSIL customers stop (or start) seeing that brand's products immediately.",
        "kind": "automatic",
        "verified": true
      },
      {
        "action": "Deleting a brand",
        "effect": "Refused if any product, order, movement, balance, count, alert, snapshot, import or product detail names it. On success the brand flag is removed from every account.",
        "kind": "manual",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Brands are never renamed",
        "detail": "The name is stored on every product, order and movement. Fix a mistake by deleting (if unused) and creating again.",
        "kind": "validation",
        "verified": true
      },
      {
        "title": "Admin only",
        "detail": "Needs 'Configure Inventory', held only by Admin unless granted.",
        "kind": "permission",
        "verified": true
      }
    ],
    "steps": [
      "Open Inventory Master and click Add Brands.",
      "Type the brand name and tick Hidden from MSIL if needed.",
      "Save; the brand now appears in every brand list.",
      "Open User Management and tick the brand on each customer or Sales account that should see it.",
      "Add SKUs under the new brand on Inventory Master or by import."
    ],
    "warnings": [
      {
        "title": "Choose the name carefully",
        "detail": "A brand cannot be renamed once anything uses it.",
        "severity": "irreversible"
      }
    ],
    "unverified": []
  },
  {
    "key": "inventory.indent_assignment",
    "portal": "customer",
    "paths": [
      "/inventory/indent-assignment"
    ],
    "title": "Indent Stock Assignment",
    "overview": {
      "what": "Shows every SKU that has customer indents waiting for stock, how much stock is free, and lets you decide which indent gets it. You can also move or undo stock already given to an indent.",
      "why": "When stock arrives, more than one customer may be waiting for it. This screen makes that choice visible and lets staff override the automatic oldest-first rule.",
      "users": [
        "Admin",
        "Super Admin",
        "Sales",
        "Import Team"
      ]
    },
    "functions": [
      {
        "title": "Two tabs over one queue",
        "detail": "Individual (the default) works SKU by SKU and indent by indent, exactly as before. PO-wise groups the very same waiting indents under the PO they go by, for settling a whole PO at once. Both read the same queue, so the figures always agree."
      },
      {
        "title": "See the waiting queue",
        "detail": "One card per SKU with free stock and its open indents, oldest first. Columns include Customer Name, Company Name, PO Number (a dash until a PO is raised), requested and pending quantity, and the MSIL supply status."
      },
      {
        "title": "Auto-assign (FIFO)",
        "detail": "Gives the SKU's free stock to the oldest waiting indents first. Works in both automatic and held mode."
      },
      {
        "title": "Assign to one indent",
        "detail": "Puts a chosen number of units on a specific indent. Part quantities are allowed, unless the indent's booking was cancelled; then it can only be booked whole as a new booking."
      },
      {
        "title": "Assign all on a PO (PO-wise tab)",
        "detail": "Click a PO number to see every waiting indent under it, with what each would get. 'Assign all' assigns them one after another, oldest first — each one exactly as the Individual tab would assign it. The free stock of a SKU is counted down as it goes, so two indents on one PO never get the same units. What could not be assigned is listed with the reason."
      },
      {
        "title": "Move to… (reassign)",
        "detail": "Moves stock already allocated to one customer's indent onto another indent of the same SKU. Only while that booking has no PO and the stock is still only reserved."
      },
      {
        "title": "Switch automatic / held mode",
        "detail": "'Hold arriving stock for assignment' makes new stock wait here; 'Switch to automatic (FIFO)' sends it to the oldest indent by itself. Only users who can change inventory settings see this button."
      },
      {
        "title": "Search and filter",
        "detail": "Search by SKU, customer, indent, reservation, booking or PO number. 'Only SKUs with stock to assign or move' hides cards with nothing to do. The PO-wise tab has the same box over POs, with 'Only POs with stock to assign'."
      },
      {
        "title": "Cancel an inward allocation (from the Sales Desk)",
        "detail": "Hosted in the Sales Desk booking drawer, not on this screen, but uses the same permission and service. The units go back to stock and back to the indent; the allocation stays on record as Cancelled."
      }
    ],
    "connections": [
      {
        "module": "Sales Desk",
        "key": "sales.bookings",
        "why": "Assigned stock lands on the customer's booking as an inward allocation.",
        "data": "New or updated booking lines with allocations, quantities and PO number",
        "direction": "two-way",
        "trigger": "Assign, Auto-assign, Move to…, or Cancel allocation in the booking drawer",
        "verified": true
      },
      {
        "module": "Indent History",
        "key": "customer_portal.indent_history",
        "why": "The indents shown here are the customer's open indents.",
        "data": "Indent quantity and status (Pending / Partially Confirmed / Confirmed)",
        "direction": "two-way",
        "trigger": "Any assignment reduces the indent; reassign and cancel give units back",
        "verified": true
      },
      {
        "module": "Stock Ledger",
        "key": "inventory.ledger",
        "why": "Every allocation reserves stock through the ledger.",
        "data": "RESERVE / RELEASE / ISSUE / ADJUSTMENT movements tied to the booking",
        "direction": "one-way",
        "trigger": "Assign, reassign, cancel",
        "verified": true
      },
      {
        "module": "Inventory Import / stock postings",
        "key": "inventory.imports",
        "why": "Stock coming in runs the indent pass that either assigns automatically or holds stock here.",
        "data": "SKUs received and quantities",
        "direction": "one-way",
        "trigger": "Import confirm, stock adjustment, stock count, booking cancel, PO expiry job, MSIL supply date change",
        "verified": true
      },
      {
        "module": "Upcoming Stock",
        "key": "inventory.health",
        "why": "Arrivals are first counted against upcoming shipments. Upcoming Stock never assigns stock to an indent and sends nothing.",
        "data": "Arrived quantities only",
        "direction": "one-way",
        "trigger": "Start of every indent pass",
        "verified": true
      },
      {
        "module": "MSIL Supply Date (Sales Desk)",
        "key": "sales.bookings",
        "why": "Late MSIL indents are held for a decision; assigning one here counts as the desk's Convert.",
        "data": "Supply check status",
        "direction": "two-way",
        "trigger": "Assigning an indent marked Awaiting decision",
        "verified": true
      },
      {
        "module": "Inventory Configuration",
        "key": "inventory.configuration",
        "why": "Holds the automatic / held mode.",
        "data": "Assignment mode setting",
        "direction": "one-way",
        "trigger": "Mode button",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Assigning or Auto-assigning stock",
        "effect": "Stock is reserved; the units are added to the customer's booking (a new line is created if the SKU was not on it, at the booking's price tier); the indent's waiting quantity goes down.",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Assigning or Auto-assigning stock",
        "effect": "The customer gets an in-app notice and an email (copied to their booking CC list, the company copy addresses and the staff member who placed the booking). The Support Team gets its own copy, even if the customer turned email off.",
        "kind": "automatic",
        "verified": true
      },
      {
        "action": "Move to… (reassign)",
        "effect": "Stock is released from the first booking and reserved on the second. The first indent waits for those units again. If the second step fails, the units are put back.",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Cancel inward allocation",
        "effect": "The allocation is kept but marked Cancelled with who, when and why. Stock returns (released, or returned to stock if a PO had already taken it). The indent waits again unless the desk had cancelled it. The oldest-first pass is NOT re-run.",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Switching to held mode",
        "effect": "Arriving stock is no longer assigned by itself. Customers are still emailed that material came in against their indent.",
        "kind": "automatic",
        "verified": true
      },
      {
        "action": "Assign all on a PO",
        "effect": "The same as assigning each of that PO's indents by hand: stock reserved, booking lines updated, indents reduced, and one email per allocation to the customer and Support. A PO with more owed than is free is served as far as the stock goes and the rest is reported as still waiting.",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Any action on this screen",
        "effect": "Written to the audit log with the user: 'Indent Stock Auto-Assigned', 'Indent Stock Assigned', 'Indent Stock Reassigned', 'Inward Allocation Cancelled'. A PO-wise run writes one 'Indent Stock Assigned' per indent plus one 'Indent Stock Assigned (PO-wise)' for the run.",
        "kind": "historical",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Permission",
        "detail": "Needs the 'Assign indent stock' permission, held by Sales and Import Team (and Admin / Super Admin). Changing the mode needs 'Configure inventory', which only Admin holds by default.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Default is automatic",
        "detail": "If no mode was ever set, stock goes to the oldest indent by itself.",
        "kind": "automation",
        "verified": true
      },
      {
        "title": "No over-allocation",
        "detail": "You cannot assign more than the indent is waiting for or more than is free. The stock write itself is guarded, so two people clicking at once cannot both take the same units.",
        "kind": "stock",
        "verified": true
      },
      {
        "title": "PO-wise assigns nothing the Individual tab would not",
        "detail": "Every indent on a PO is put through the same assign, with the same checks, one after another. An indent that is refused does not stop the others; it is reported with its reason. An indent whose booking was cancelled can only be taken whole, so it is skipped unless all of it is free.",
        "kind": "stock",
        "verified": true
      },
      {
        "title": "Only indents that already go by a PO",
        "detail": "An indent is listed under a PO once its booking has one (or the PO was stamped on the indent itself). Indents with no PO yet appear only on the Individual tab, and the PO-wise tab says how many there are.",
        "kind": "validation",
        "verified": true
      },
      {
        "title": "Reassign only before the PO",
        "detail": "Once any line of the booking has a PO, its stock is committed and cannot be moved. Same SKU only.",
        "kind": "validation",
        "verified": true
      },
      {
        "title": "Cancel only at 'PO Received'",
        "detail": "Allocations already picked or dispatched cannot be cancelled. A second cancel of the same allocation is refused.",
        "kind": "validation",
        "verified": true
      },
      {
        "title": "MSIL late arrivals are held",
        "detail": "For MSIL customers with a Supply Date, stock arriving after that date or more than 7 days after the booking is not converted automatically; the indent shows 'Awaiting decision'.",
        "kind": "approval",
        "verified": true
      },
      {
        "title": "Scheduled indents wait",
        "detail": "An indent scheduled for a later date is skipped by the automatic pass.",
        "kind": "automation",
        "verified": true
      }
    ],
    "steps": [
      "Open Inventory Management → Indent Stock Assignment.",
      "Check the banner: automatic or held.",
      "Find the SKU with the search box, or tick 'Only SKUs with stock to assign or move'.",
      "Click 'Auto-assign (FIFO)', or type a quantity on one indent and click Assign.",
      "To move stock already given, use 'Move to…' on the allocation.",
      "To settle a whole PO instead, open the PO-wise tab, click the PO number to check its indents, then click 'Assign all'.",
      "Confirm. The booking updates on the Sales Desk and the customer is emailed."
    ],
    "warnings": [
      {
        "title": "Assigning sends emails",
        "detail": "The customer and Support Team are emailed straight away. There is no draft step. 'Assign all' on a PO sends one email per indent it assigns, exactly as assigning them one by one would.",
        "severity": "warning"
      },
      {
        "title": "Cancel does not re-pick",
        "detail": "After cancelling an allocation, in automatic mode the next arrival may give the same units to the same indent again. Use 'Move to…' to pick a different customer.",
        "severity": "warning"
      },
      {
        "title": "No live refresh",
        "detail": "Assignments do not broadcast a live update. Other open screens show the change on their next reload.",
        "severity": "warning"
      }
    ],
    "unverified": [
      "Whether the live Sales and Import Team role records already contain the 'Assign indent stock' permission requires verification (the role baseline must be applied to the database)."
    ]
  },
  {
    "key": "inventory.imports",
    "portal": "customer",
    "paths": [
      "/inventory/import"
    ],
    "title": "Inventory Import",
    "overview": {
      "what": "Upload an Excel or CSV sheet to change many SKUs at once: add stock, restate stock, planning figures, product descriptions or selling prices.",
      "why": "Updating hundreds of SKUs by hand is slow and error-prone. The import checks every row first and shows the errors before anything is written.",
      "users": [
        "Admin",
        "Super Admin",
        "Inventory Manager",
        "Import Team",
        "Warehouse User",
        "Sales",
        "Management"
      ]
    },
    "functions": [
      {
        "title": "Inventory Master sheet",
        "detail": "SKU, optional MSIL Code, Quantity, Box No. Quantity is ADDED to stock (negative deducts). A SKU not in the catalogue is created, and its quantity becomes opening stock; you must give its MOQ, lead time, safety factor and box number before confirming."
      },
      {
        "title": "Fresh Inventory Import",
        "detail": "SKU or MSIL Code and a Quantity that REPLACES the current stock figure (a stock restatement after a count). Never creates SKUs."
      },
      {
        "title": "Planning Parameters",
        "detail": "Daily average consumption (low/normal/peak), lead time and safety factor for existing SKUs."
      },
      {
        "title": "Product Details",
        "detail": "Descriptions and YouTube video links by SKU. Text only; a blank cell leaves existing content alone."
      },
      {
        "title": "SKU Pricing",
        "detail": "Selling price per price type for existing SKUs. Only prices change. A blank cell leaves that price alone; 0 is refused; no SKU is created."
      },
      {
        "title": "Four-step wizard",
        "detail": "Upload → Check rows → Review → Import. Download the template, pick brand and location, fix errors, then confirm."
      },
      {
        "title": "History",
        "detail": "Past imports with type and status filters, error reports, resume and cancel."
      }
    ],
    "connections": [
      {
        "module": "Stock Ledger",
        "key": "inventory.ledger",
        "why": "Stock sheets post real stock movements.",
        "data": "OPENING (new SKU), RECEIPT (positive), ADJUSTMENT with reason MANUAL_ADJUSTMENT (negative), COUNT with COUNT_SURPLUS / COUNT_SHORTAGE (fresh inventory)",
        "direction": "one-way",
        "trigger": "Confirming the import",
        "verified": true
      },
      {
        "module": "Indent Stock Assignment",
        "key": "inventory.indent_assignment",
        "why": "Stock added by import is offered to waiting indents (automatically, or held in held mode).",
        "data": "SKUs and units received",
        "direction": "one-way",
        "trigger": "End of a stock import",
        "verified": true
      },
      {
        "module": "Customer emails (material inward)",
        "key": null,
        "why": "Customers with open indents are told material arrived.",
        "data": "Indent lines, received and available quantity",
        "direction": "one-way",
        "trigger": "Positive quantities in a stock import",
        "verified": true
      },
      {
        "module": "Upcoming Stock",
        "key": "inventory.health",
        "why": "Received units are counted off upcoming shipments, earliest ETA first. Analysis only.",
        "data": "Arrived quantity",
        "direction": "one-way",
        "trigger": "Stock import posting",
        "verified": true
      },
      {
        "module": "Inventory Master / Product Catalogue",
        "key": "inventory.master",
        "why": "Quantities, new SKUs, box numbers, planning values and prices change the catalogue.",
        "data": "Product records and available-for-sale figure",
        "direction": "one-way",
        "trigger": "Confirming the import",
        "verified": true
      },
      {
        "module": "Product Details",
        "key": "inventory.product_content",
        "why": "The Product Details sheet writes the same descriptions and videos that screen edits.",
        "data": "Description and video links",
        "direction": "one-way",
        "trigger": "Product Details import",
        "verified": true
      },
      {
        "module": "MSIL code list",
        "key": null,
        "why": "New MSIL codes in an Inventory Master sheet are registered as Active so the SKU can be booked.",
        "data": "MSIL codes",
        "direction": "one-way",
        "trigger": "Inventory Master import",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Confirming a stock import",
        "effect": "Stock moves through the ledger, stock health is recalculated, available-for-sale updates, and open screens get a live 'stock updated' signal.",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Confirming a stock import with positive quantities",
        "effect": "Waiting indents may be booked automatically and customers emailed (copy to Support Team and the staff member who raised the indent).",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Confirming any import",
        "effect": "Audit log gets 'Inventory Import Confirmed' and 'Inventory Import Processed' with row counts.",
        "kind": "historical",
        "verified": true
      },
      {
        "action": "Fresh Inventory Import",
        "effect": "Replaces the stock figure. A row of 155 on a SKU holding 5 ends at 155.",
        "kind": "automatic",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Who can run which sheet",
        "detail": "Inventory Master, Fresh Inventory, Planning and Product Details need 'Manage inventory master'. SKU Pricing needs 'Manage pricing'. Anyone with 'View inventory' can open the page and see history.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Price rows are private",
        "detail": "The preview and error report of a SKU Pricing import are visible only to people who may run that import.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Box numbers",
        "detail": "Changing an existing SKU's box number needs the 'Manage box number' permission (Admin only). A new SKU may get its first box from the sheet.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Rows checked before writing",
        "detail": "Every row is validated first. Nothing is written until you confirm. MSIL Code, if given, must match the SKU.",
        "kind": "validation",
        "verified": true
      },
      {
        "title": "Stock floor",
        "detail": "A negative quantity can reduce stock only to zero and never below units already reserved for bookings.",
        "kind": "stock",
        "verified": true
      },
      {
        "title": "Brand",
        "detail": "A new SKU in the Inventory Master sheet takes the brand chosen on the upload form.",
        "kind": "validation",
        "verified": true
      }
    ],
    "steps": [
      "Open Inventory Management → Inventory Import.",
      "Choose the import type and download its template.",
      "Fill the sheet, choose brand and location, and upload.",
      "Check rows: fix or accept rejected rows, and fill details for any new SKUs.",
      "Review and click Confirm.",
      "Track progress in History; results show in Inventory Master and the Stock Ledger."
    ],
    "warnings": [
      {
        "title": "Stock changes are real",
        "detail": "A confirmed stock import posts ledger movements and may book customer indents and send emails.",
        "severity": "irreversible"
      },
      {
        "title": "Fresh Inventory replaces stock",
        "detail": "Use Inventory Master to add stock. Fresh Inventory overwrites the figure.",
        "severity": "warning"
      }
    ],
    "unverified": [
      "Whether the Planning and SKU Pricing processors write any audit row beyond the job-level entries was not traced line by line."
    ]
  },
  {
    "key": "inventory.product_content",
    "portal": "customer",
    "paths": [
      "/admin/product-details"
    ],
    "title": "Product Details",
    "overview": {
      "what": "Lists every catalogue SKU with its description, photos and videos, and lets you add or change them.",
      "why": "Customers need to see what a part looks like and what it does before ordering it.",
      "users": [
        "Admin",
        "Super Admin",
        "Inventory Manager",
        "Import Team"
      ]
    },
    "functions": [
      {
        "title": "Edit description and videos",
        "detail": "Write the product description and add YouTube video links, then Save."
      },
      {
        "title": "Add, replace and remove images",
        "detail": "Up to 12 images per SKU, 5 per upload, 5 MB each. The first image is the one customers see first. Each upload is saved at once."
      },
      {
        "title": "Bulk images",
        "detail": "Upload many images; each file name must name the SKU it belongs to."
      },
      {
        "title": "Bulk text by spreadsheet",
        "detail": "Opens the Inventory Import wizard with the Product Details sheet."
      }
    ],
    "connections": [
      {
        "module": "Product Catalogue",
        "key": "customer_portal.catalogue",
        "why": "The product slide-over in the catalogue shows this content.",
        "data": "Description, images, videos",
        "direction": "one-way",
        "trigger": "Customer or staff opens a product",
        "verified": true
      },
      {
        "module": "Inventory Import",
        "key": "inventory.imports",
        "why": "Descriptions and videos can also be loaded by sheet.",
        "data": "Description, video links",
        "direction": "one-way",
        "trigger": "Product Details import",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Saving text or uploading images",
        "effect": "Change is live immediately in the Product Catalogue slide-over for every user who can see that brand.",
        "kind": "automatic",
        "verified": true
      },
      {
        "action": "Any change",
        "effect": "Audit log gets 'Product Details Updated', 'Product Images Uploaded' or 'Product Images Updated'.",
        "kind": "historical",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Permission",
        "detail": "Needs 'Manage inventory master', held by Inventory Manager, Import Team and Admin. Reading the content is open to every signed-in user, limited to brands they can see.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Limits",
        "detail": "Images: 12 per SKU, 5 per upload, 5 MB each. Description up to 8,000 characters. Up to 6 YouTube videos.",
        "kind": "validation",
        "verified": true
      }
    ],
    "steps": [
      "Open Product Details.",
      "Find the SKU in the list.",
      "Edit the description or video links and click Save.",
      "Use Add images, or Bulk images for many SKUs.",
      "Open the product in the Product Catalogue to check it."
    ],
    "warnings": [
      {
        "title": "Removing an image is permanent",
        "detail": "A removed image cannot be restored.",
        "severity": "irreversible"
      }
    ],
    "unverified": [
      "Product content is not shown on booking screens (Create Booking, Booking Review): no use of the product-details API was found there."
    ]
  }
];
