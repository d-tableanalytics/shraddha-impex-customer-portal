/**
 * "About this module" documentation: Customer Portal screens.
 *
 * GENERATED from the module audit; edit the text here directly when a screen
 * changes. The code each statement was verified against is listed in
 * docs/module-documentation-map.md, not here, so no source paths ship to the
 * browser. `verified: false` items show as "Requires verification".
 */
export default [
  {
    "key": "customer_portal.dashboard",
    "portal": "customer",
    "paths": [
      "/"
    ],
    "title": "Dashboard",
    "overview": {
      "what": "The home screen after sign-in. It shows stock tiles for everyone, and booking figures, a demand chart and recent bookings for anyone who places bookings.",
      "why": "Gives each person a one-glance view of the stock and bookings they are allowed to see.",
      "users": [
        "Customer",
        "Sales",
        "Admin / Super Admin",
        "Inventory Manager",
        "Warehouse User",
        "Management",
        "HR",
        "Billing",
        "Accounts"
      ]
    },
    "functions": [
      {
        "title": "Stock tiles",
        "detail": "Total products and out-of-stock count, counted only across the brands you may see."
      },
      {
        "title": "Booking figures",
        "detail": "Conversion summary, demand chart (default 6 months) and recent bookings feed. Shown only to people who place bookings."
      },
      {
        "title": "Quick buttons",
        "detail": "Inventory for everyone; Bulk Upload and New Booking only for people who place bookings."
      },
      {
        "title": "Two audiences",
        "detail": "A customer sees only their own bookings. A Super Admin sees everyone's and the heading reads 'Admin Dashboard'."
      }
    ],
    "connections": [
      {
        "module": "Create Booking / Booking History",
        "key": "customer_portal.create_booking",
        "why": "The booking figures are counted from booking records.",
        "data": "Booking rows (own rows for non-admins), selection-list count",
        "direction": "one-way",
        "trigger": "Page load; refreshed after any booking change",
        "verified": true
      },
      {
        "module": "Product Catalogue",
        "key": "customer_portal.catalogue",
        "why": "Stock tiles read the same brand-scoped product lists.",
        "data": "Product counts, available-for-sale",
        "direction": "one-way",
        "trigger": "Page load",
        "verified": true
      },
      {
        "module": "Inventory Dashboard",
        "key": "inventory.dashboard",
        "why": "Import Team's home is the Inventory Dashboard instead of this page.",
        "data": "Redirect only",
        "direction": "one-way",
        "trigger": "Opening '/'",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Opening the dashboard",
        "effect": "Read-only. Nothing is written.",
        "kind": "historical",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Brand scope",
        "detail": "Counts include only brands ticked on your account. Admin and inventory roles see all brands.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Booking panels hidden for non-ordering roles",
        "detail": "Roles that cannot book see only the stock tiles.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Access",
        "detail": "Needs 'View Dashboard', which every built-in role holds.",
        "kind": "permission",
        "verified": true
      }
    ],
    "steps": [
      "Sign in; you land on the Dashboard.",
      "Read the stock tiles at the top.",
      "If you book, check the conversion summary and demand chart.",
      "Open a recent booking from the feed, or use New Booking / Bulk Upload."
    ],
    "warnings": [],
    "unverified": [
      "Exact list of KPI fields returned by the stats endpoint was not traced line by line.",
      "Sales sees only bookings they own on this page (the stats filter is skipped only for Super Admin), unlike the Sales Desk — confirm this is intended."
    ]
  },
  {
    "key": "customer_portal.create_booking",
    "portal": "customer",
    "paths": [
      "/orders/new"
    ],
    "title": "Create Booking",
    "overview": {
      "what": "Pick products and quantities into a Selection List, then Confirm Booking. Stock is taken at confirmation; anything short becomes an indent.",
      "why": "Lets customers (or Sales on their behalf) secure stock and record demand for items that are out of stock.",
      "users": [
        "Customer",
        "Sales",
        "Admin / Super Admin"
      ]
    },
    "functions": [
      {
        "title": "Select Customer (Sales/Admin only)",
        "detail": "Optional. Choose an active customer and the booking belongs to them, with staff recorded as 'SI Team'; leave it empty and the booking is created on the staff member's own account. '+ Add Customer' opens Customer Management and returns with the new customer selected."
      },
      {
        "title": "Add to List",
        "detail": "Search by SKU (or MSIL Code where shown), see Available, Multiple and Remaining, enter a quantity. Adding a product already in the list tops up that line."
      },
      {
        "title": "Edit / remove lines",
        "detail": "Change quantity or remove one or many lines. No stock is held while items sit in the list."
      },
      {
        "title": "Confirm Booking",
        "detail": "Customers book straight away. Sales/Admin see a review popup first; if the list or stock changed meanwhile, the server refuses and asks to re-check."
      },
      {
        "title": "Outcome",
        "detail": "Booking created (BO- number), indent raised (PI- number, same digits), or both. A toast states which."
      }
    ],
    "connections": [
      {
        "module": "Inventory Master / Stock Ledger",
        "key": "inventory.ledger",
        "why": "Confirming deducts available stock and posts a reserve movement.",
        "data": "Available-for-sale down, booked up; RESERVE ledger movement",
        "direction": "one-way",
        "trigger": "Confirm Booking",
        "verified": true
      },
      {
        "module": "Booking Desk (Sales Desk)",
        "key": "sales.bookings",
        "why": "Each confirmed booking appears on the desk for PO, edits and status.",
        "data": "Booking rows, incl. SI Team (who placed it)",
        "direction": "two-way",
        "trigger": "Confirm Booking",
        "verified": true
      },
      {
        "module": "Indent History / Indent Stock Assignment",
        "key": "inventory.indent_assignment",
        "why": "The unfilled part becomes an open indent waiting for stock.",
        "data": "Indent lines (Pending / Partially Confirmed)",
        "direction": "one-way",
        "trigger": "Confirm Booking with short stock",
        "verified": true
      },
      {
        "module": "Customer Management",
        "key": "administration.customers",
        "why": "Staff pick or add the customer here; customer's brand access, MSIL category and Multiple exemption decide what can be booked.",
        "data": "Customer account",
        "direction": "one-way",
        "trigger": "Select Customer / + Add Customer",
        "verified": true
      },
      {
        "module": "Notifications and email",
        "key": null,
        "why": "Customer, placing staff and admins are told the outcome.",
        "data": "In-app notices; one booking or indent email to the customer, staff placer copied",
        "direction": "one-way",
        "trigger": "Confirm Booking",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Adding to the Selection List",
        "effect": "A reservation line is saved (7-day validity). No stock moves. Admins get a 'New Booking' notice.",
        "kind": "automatic",
        "verified": true
      },
      {
        "action": "Confirm Booking",
        "effect": "Stock is deducted, booking rows are created with status 'Booking Received', short quantity becomes an indent, emails and notices go out, and the Sales Desk, Booking History, Indent History and Dashboard refresh (live events 'order-created' / 'indent-raised').",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Leaving lines unconfirmed",
        "effect": "Daily job sends reminders on day 5 and day 6, then cancels the lines after 7 days (status Expired). Staff-built lists remind the staff member, not the customer.",
        "kind": "automatic",
        "verified": true
      },
      {
        "action": "No PO within 7 days of confirming",
        "effect": "Hourly job auto-cancels the booking, returns stock, emails the customer and may auto-book waiting indents with the freed stock.",
        "kind": "multi",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Multiple (MOQ)",
        "detail": "Non-MSIL customers must book in multiples of the product's Multiple. MSIL customers, company-email staff and accounts marked SKIP are exempt.",
        "kind": "validation",
        "verified": true
      },
      {
        "title": "Brand access",
        "detail": "Only products of brands ticked on the customer's account can be found or booked. MSIL customers never see brands flagged hidden from MSIL.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "MSIL code must be active",
        "detail": "For users MSIL codes apply to, a product with an inactive MSIL code cannot be booked.",
        "kind": "validation",
        "verified": true
      },
      {
        "title": "Over-booking allowed",
        "detail": "Any quantity may be added; the part stock cannot cover becomes an indent at confirmation.",
        "kind": "stock",
        "verified": true
      },
      {
        "title": "7-day validity",
        "detail": "Unconfirmed lines expire after 7 days; topping up a line does not extend it.",
        "kind": "expiry",
        "verified": true
      },
      {
        "title": "Booking for others",
        "detail": "Only holders of 'View All Bookings' (Sales, Admin) may book for a customer, and only for an active Customer account.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Access",
        "detail": "Needs 'Create Order' (Customer, Sales via matrix/Admin) or 'View All Bookings' (Sales, Admin).",
        "kind": "permission",
        "verified": true
      }
    ],
    "steps": [
      "Open Create Booking.",
      "Sales/Admin: optionally choose the customer in Select Customer (empty books on your own account).",
      "Search the SKU and enter a quantity in the right Multiple.",
      "Click ADD TO LIST; repeat for each item.",
      "Check the Selection List and add Remarks if needed.",
      "Click CONFIRM BOOKING (Sales/Admin review the popup and confirm).",
      "Find the result in Booking History, and any shortfall in Indent History."
    ],
    "warnings": [
      {
        "title": "Raise the PO within 7 days",
        "detail": "A confirmed booking without a PO is cancelled automatically after 7 days and the stock is released.",
        "severity": "warning"
      },
      {
        "title": "Confirmation cannot be undone by a customer",
        "detail": "Customers cannot cancel a confirmed booking; only staff with 'Manage Orders' can.",
        "severity": "irreversible"
      }
    ],
    "unverified": []
  },
  {
    "key": "customer_portal.bulk_upload",
    "portal": "customer",
    "paths": [
      "/orders/bulk-upload"
    ],
    "title": "Bulk Booking Upload",
    "overview": {
      "what": "Upload an Excel template of SKUs (or MSIL codes) and quantities, check every row, then book the selected rows in one step.",
      "why": "Saves typing large orders line by line.",
      "users": [
        "Customer",
        "Sales",
        "Admin / Super Admin"
      ]
    },
    "functions": [
      {
        "title": "Download template",
        "detail": "Get the Excel template (with MSIL column where MSIL codes apply)."
      },
      {
        "title": "Validate",
        "detail": "Each row is checked: SKU/MSIL exists in your brands, quantity is whole, Multiple, MSIL code active. Short stock is a warning, not an error."
      },
      {
        "title": "Download Error report",
        "detail": "Export failing rows to fix and re-upload."
      },
      {
        "title": "Continue to Booking",
        "detail": "Books the selected rows directly, without the Selection List, all-or-nothing."
      }
    ],
    "connections": [
      {
        "module": "Create Booking",
        "key": "customer_portal.create_booking",
        "why": "Uses the same confirmation logic, so results are identical.",
        "data": "Booking rows and indent lines",
        "direction": "one-way",
        "trigger": "Continue to Booking",
        "verified": true
      },
      {
        "module": "Inventory Master / Stock Ledger",
        "key": "inventory.ledger",
        "why": "Stock is deducted for booked rows.",
        "data": "Stock movement",
        "direction": "one-way",
        "trigger": "Continue to Booking",
        "verified": true
      },
      {
        "module": "Booking Desk / Booking History / Indent History",
        "key": "sales.bookings",
        "why": "The created booking and any indent appear there.",
        "data": "Booking and indent records",
        "direction": "one-way",
        "trigger": "Continue to Booking",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Continue to Booking",
        "effect": "One transaction: either the whole file becomes a booking (plus an indent for any shortfall) or nothing is saved. Same emails, notices and live events as Create Booking.",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Validate",
        "effect": "Read-only check; nothing is saved.",
        "kind": "historical",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Re-checked at booking",
        "detail": "Multiple, brand and MSIL rules are checked again when booking, not trusted from the preview.",
        "kind": "validation",
        "verified": true
      },
      {
        "title": "Repeated SKUs merged",
        "detail": "The same SKU listed twice in one file becomes one line.",
        "kind": "validation",
        "verified": true
      },
      {
        "title": "Does not touch the Selection List",
        "detail": "Items already in your list are not swept into the upload's booking.",
        "kind": "automation",
        "verified": true
      },
      {
        "title": "Access",
        "detail": "Needs 'Create Order' or 'View All Bookings'.",
        "kind": "permission",
        "verified": true
      }
    ],
    "steps": [
      "Open Bulk Upload and download the template.",
      "Fill SKU (or MSIL Code) and quantity, then upload.",
      "Fix any red rows (download the error report if needed).",
      "Select rows and click Continue to Booking.",
      "Read the summary; the booking shows in Booking History, any shortfall in Indent History."
    ],
    "warnings": [
      {
        "title": "Books immediately",
        "detail": "There is no Selection List step; Continue to Booking confirms the booking at once.",
        "severity": "irreversible"
      }
    ],
    "unverified": [
      "Bulk Upload has no Select Customer picker, so a Sales user's upload is booked to their own account — requires verification that this is intended.",
      "Validation uses the uploader's own rules (brand, Multiple), not a customer's."
    ]
  },
  {
    "key": "customer_portal.booking_history",
    "portal": "customer",
    "paths": [
      "/orders/history"
    ],
    "title": "Booking History",
    "overview": {
      "what": "Lists confirmed bookings with status, PO and quantities. A side drawer shows lines, status timeline and quantity changes.",
      "why": "Lets customers track their orders and staff manage the booking lifecycle.",
      "users": [
        "Customer",
        "Sales",
        "Admin / Super Admin"
      ]
    },
    "functions": [
      {
        "title": "Search and filter",
        "detail": "Find bookings by ID, PO, SKU or status; metric tiles show totals and a cancelled count."
      },
      {
        "title": "Booking drawer",
        "detail": "Lines, PO number, 'Booked by' (SI Team), status timeline (Booking Received → Ready for Dispatch → Dispatched → Delivered)."
      },
      {
        "title": "Staff actions",
        "detail": "With 'Manage Orders': advance status, set PO, schedule dates, resend status email, cancel. With 'Edit Booking Pre-PO': amend quantities."
      }
    ],
    "connections": [
      {
        "module": "Booking Desk (Sales Desk)",
        "key": "sales.bookings",
        "why": "Same booking records and same endpoints.",
        "data": "Booking rows, status, PO",
        "direction": "two-way",
        "trigger": "Status/PO/qty changes",
        "verified": true
      },
      {
        "module": "Inventory Master / Stock Ledger",
        "key": "inventory.ledger",
        "why": "Cancelling returns stock; raising a PO consumes it.",
        "data": "Stock release / consumption",
        "direction": "one-way",
        "trigger": "Cancel booking / PO raised (settled by hourly job)",
        "verified": true
      },
      {
        "module": "Indent Stock Assignment",
        "key": "inventory.indent_assignment",
        "why": "Stock freed by a cancel is offered to waiting indents.",
        "data": "Released SKUs",
        "direction": "one-way",
        "trigger": "Cancel booking",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Status change by staff",
        "effect": "Every line moves, a timeline entry is saved and the customer is emailed.",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Cancel booking (staff)",
        "effect": "Booking marked Cancelled, stock returned, customer and admins notified, live event 'booking-cancelled', waiting indents may auto-book.",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Past bookings",
        "effect": "Customer details are copied onto the booking when created; later profile changes do not rewrite them.",
        "kind": "historical",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Customers cannot cancel",
        "detail": "Since 2026-10-27 the cancel button shows only for 'Manage Orders' holders; customers are told to email support.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Own bookings only",
        "detail": "Without 'View All Bookings' you see only your own bookings.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Quantity edits",
        "detail": "Only 'Edit Booking Pre-PO' holders (Sales, Admin) can change quantities; the customer is emailed.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Access",
        "detail": "Needs 'View Orders' (Customer, Sales, Admin).",
        "kind": "permission",
        "verified": true
      }
    ],
    "steps": [
      "Open Booking History.",
      "Search or filter for the booking.",
      "Click a row to open the drawer.",
      "Check lines, PO and status timeline.",
      "Staff: update status, PO or quantities from the drawer."
    ],
    "warnings": [
      {
        "title": "Cancelling releases stock",
        "detail": "A cancelled booking cannot be reopened from the portal.",
        "severity": "irreversible"
      }
    ],
    "unverified": []
  },
  {
    "key": "customer_portal.indent_history",
    "portal": "customer",
    "paths": [
      "/orders/indent-history"
    ],
    "title": "Indent History",
    "overview": {
      "what": "Lists open indents: quantities booked but not covered by stock, waiting for material.",
      "why": "Shows what is still owed to the customer and when it may arrive.",
      "users": [
        "Customer",
        "Sales",
        "Admin / Super Admin"
      ]
    },
    "functions": [
      {
        "title": "Indent list",
        "detail": "Indent number, linked booking (only when one really exists), PO, SKU, quantity, scheduled date."
      },
      {
        "title": "Schedule availability (Admin)",
        "detail": "Set an expected date per line; the customer gets one delivery-schedule email."
      },
      {
        "title": "Cancel indent (staff)",
        "detail": "Staff with 'Manage Orders' can cancel open lines."
      }
    ],
    "connections": [
      {
        "module": "Inventory stock postings (receipts, adjustments, counts, imports)",
        "key": "inventory.master",
        "why": "Any stock increase runs the indent pass that turns covered indents into bookings.",
        "data": "Indent → booking rows; stock reserved",
        "direction": "one-way",
        "trigger": "Stock movement / job",
        "verified": true
      },
      {
        "module": "Indent Stock Assignment",
        "key": "inventory.indent_assignment",
        "why": "In manual mode, arriving stock waits there to be assigned to an indent.",
        "data": "Indent lines, allocations",
        "direction": "two-way",
        "trigger": "Assign / Auto-assign",
        "verified": true
      },
      {
        "module": "Sales Desk (MSIL Supply Date)",
        "key": "sales.bookings",
        "why": "Late MSIL stock holds the indent for Convert or Cancel on the desk.",
        "data": "Supply check status 'Awaiting decision'",
        "direction": "two-way",
        "trigger": "Stock arrival after Supply Date or 7-day window",
        "verified": true
      },
      {
        "module": "Upcoming Stock",
        "key": "inventory.health",
        "why": "Reads open indents to calculate expected cover; analysis only.",
        "data": "Indent quantities (read)",
        "direction": "one-way",
        "trigger": "Opening Upcoming Stock",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Stock arrives for an indent",
        "effect": "In auto mode the oldest covered indent becomes a booking (or is added to its booking), stock is reserved, customer notified and emailed, support mailbox informed.",
        "kind": "automatic",
        "verified": true
      },
      {
        "action": "Late MSIL arrival",
        "effect": "Indent is held, stock is not used, admins notified once; desk must Convert or Cancel.",
        "kind": "manual",
        "verified": true
      },
      {
        "action": "Scheduling a date",
        "effect": "Customer emailed their full schedule and notified in-app; restore before that date is refused.",
        "kind": "automatic",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Auto-booking conditions",
        "detail": "Indent open, no PO yet, stock covers the whole quantity, not scheduled for later.",
        "kind": "automation",
        "verified": true
      },
      {
        "title": "MSIL supply check",
        "detail": "MSIL customers with a Supply Date: stock must arrive by that date and within 7 days of booking, else held.",
        "kind": "approval",
        "verified": true
      },
      {
        "title": "Customers cannot cancel indents",
        "detail": "Server returns an error asking them to email support.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Scope",
        "detail": "'View All Bookings' holders see every customer's indents; customers see their own, brand-scoped.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Access",
        "detail": "Needs 'View Orders'. Scheduling is Admin-only.",
        "kind": "permission",
        "verified": true
      }
    ],
    "steps": [
      "Open Indent History.",
      "Search for an indent number or SKU.",
      "Open a row to see its lines and dates.",
      "Wait for stock: covered indents become bookings automatically.",
      "Check Booking History for the new booking."
    ],
    "warnings": [
      {
        "title": "Manual assignment mode",
        "detail": "If Indent Stock Assignment is set to manual, indents are not converted until someone assigns stock.",
        "severity": "warning"
      }
    ],
    "unverified": []
  },
  {
    "key": "customer_portal.catalogue",
    "portal": "customer",
    "paths": [
      "/inventory"
    ],
    "title": "Inventory Dashboard",
    "overview": {
      "what": "Read-only product list with stock in hand, search, brand filter, product details, availability check from a file and Excel export.",
      "why": "Lets customers and staff see what is in stock before booking.",
      "users": [
        "Customer",
        "Sales",
        "Admin / Super Admin",
        "Inventory Manager",
        "Warehouse User",
        "Management",
        "Import Team",
        "HR",
        "Billing",
        "Accounts"
      ]
    },
    "functions": [
      {
        "title": "Search and filter",
        "detail": "Server-side search, sort, paging and brand filter."
      },
      {
        "title": "Check availability for a list",
        "detail": "Upload SKU (or MSIL) codes and see stock for each."
      },
      {
        "title": "Product details",
        "detail": "Description, photos and videos maintained in Admin → Product Details."
      },
      {
        "title": "Export",
        "detail": "Download the list as Excel."
      }
    ],
    "connections": [
      {
        "module": "Inventory Master",
        "key": "inventory.master",
        "why": "Shows the stock the master holds.",
        "data": "Product and available stock (read)",
        "direction": "one-way",
        "trigger": "Page load and live 'inventory:stock-updated' event",
        "verified": true
      },
      {
        "module": "Product Details (Admin)",
        "key": "inventory.product_content",
        "why": "Supplies the detail panel content.",
        "data": "Descriptions, media",
        "direction": "one-way",
        "trigger": "Opening a product",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Browsing",
        "effect": "Read-only; nothing is saved.",
        "kind": "historical",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Brand scope",
        "detail": "Only brands on your account are listed.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "MSIL code visibility",
        "detail": "Shown to Admin, Sales, inventory roles, MSIL customers and accounts flagged to see it.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Access",
        "detail": "Needs 'View Catalogue', held by every built-in role.",
        "kind": "permission",
        "verified": true
      }
    ],
    "steps": [
      "Open Inventory from the menu or Dashboard.",
      "Search a SKU or pick a brand.",
      "Click a product to view details.",
      "Use Create Booking to book what you need."
    ],
    "warnings": [],
    "unverified": [
      "Box No column visibility rule not traced.",
      "Screen heading reads 'Inventory Dashboard' while the menu label is 'Product Catalogue'."
    ]
  },
  {
    "key": "customer_portal.profile",
    "portal": "customer",
    "paths": [
      "/settings"
    ],
    "title": "Account Settings",
    "overview": {
      "what": "Your own profile: name and photo; Admins also get a Security tab to change their password.",
      "why": "Self-service upkeep of your own account.",
      "users": [
        "All signed-in users"
      ]
    },
    "functions": [
      {
        "title": "My Profile",
        "detail": "Change display name and upload or remove a photo. Email and company are shown read-only."
      },
      {
        "title": "Security (Admin only)",
        "detail": "Change password with the current password."
      }
    ],
    "connections": [
      {
        "module": "Customer Management",
        "key": "administration.customers",
        "why": "Edits the same user record; email, company, role and category can only be changed there.",
        "data": "Name, photo, notification preferences",
        "direction": "one-way",
        "trigger": "Save",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Changing name",
        "effect": "Existing bookings keep the details copied when they were made.",
        "kind": "historical",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Limited fields",
        "detail": "Only name, photo and notification preferences can be changed here.",
        "kind": "validation",
        "verified": true
      },
      {
        "title": "Password rules",
        "detail": "Current password required; new password must pass the strength check; rate-limited.",
        "kind": "validation",
        "verified": true
      },
      {
        "title": "Access",
        "detail": "Needs 'View Profile' / 'Edit Profile', held by every built-in role.",
        "kind": "permission",
        "verified": true
      }
    ],
    "steps": [
      "Open Settings.",
      "Edit Full Name or upload a photo.",
      "Save; the new name shows in the top bar."
    ],
    "warnings": [],
    "unverified": [
      "The Security tab is hidden for non-admins in the UI, but the password API itself is open to any signed-in user — requires verification of intent."
    ]
  },
  {
    "key": "customer_portal.support",
    "portal": "customer",
    "paths": [
      "/help"
    ],
    "title": "Help & Support",
    "overview": {
      "what": "Support contact (support@shraddhaimpex.net) and answers to common questions about bookings, indents and bulk upload.",
      "why": "Points users to support for actions the portal does not allow, such as cancellations.",
      "users": [
        "All signed-in users"
      ]
    },
    "functions": [
      {
        "title": "Email support",
        "detail": "Opens your mail app or copies the support address."
      },
      {
        "title": "FAQs",
        "detail": "Creating bookings, what an indent is, bulk upload, editing/cancelling, 7-day validity."
      }
    ],
    "connections": [],
    "impacts": [],
    "rules": [
      {
        "title": "Access",
        "detail": "Needs 'View Help', held by every built-in role.",
        "kind": "permission",
        "verified": true
      }
    ],
    "steps": [
      "Open Help & Support.",
      "Read the FAQ that matches your question.",
      "If needed, email support with your Booking or Indent ID."
    ],
    "warnings": [],
    "unverified": [
      "Help content is static text; no ticketing is recorded in the system."
    ]
  }
];
