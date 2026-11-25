/**
 * "About this module" documentation: Sales Desk and Reports.
 *
 * GENERATED from the module audit; edit the text here directly when a screen
 * changes. The code each statement was verified against is listed in
 * docs/module-documentation-map.md, not here, so no source paths ship to the
 * browser. `verified: false` items show as "Requires verification".
 */
export default [
  {
    "key": "sales.bookings",
    "portal": "customer",
    "paths": [
      "/sales"
    ],
    "title": "Sales Desk",
    "overview": {
      "what": "The internal desk where staff review every customer booking, correct it, price it, raise the Purchase Order (PO) that locks it, and move it through dispatch and delivery.",
      "why": "A booking holds stock for the customer. The desk turns that hold into a committed order within 7 days, or the system cancels it and returns the stock.",
      "users": [
        "Sales",
        "Admin",
        "Super Admin"
      ]
    },
    "functions": [
      {
        "title": "Pending PO / PO Generated tabs",
        "detail": "Lists all bookings from all customers and all brands. 'Pending PO' shows bookings still waiting for a PO; 'PO Generated' shows locked ones. The counts stay the same whichever tab is open."
      },
      {
        "title": "Search bookings",
        "detail": "Finds bookings by booking ID, SKU, PO number, company, customer name, or the SI Team member who placed it."
      },
      {
        "title": "SI Team column",
        "detail": "Shows the staff member who placed the booking on the customer's behalf. If it is empty, the customer booked it themselves."
      },
      {
        "title": "Download Excel / PDF",
        "detail": "Exports the bookings on screen, or the lines of one booking, as Excel or PDF."
      },
      {
        "title": "Edit lines (before PO)",
        "detail": "Change quantities, swap a SKU, add or remove lines. The quantity you type is the line total. Any part that stock cannot cover moves to the booking's indent."
      },
      {
        "title": "Rearrange lines",
        "detail": "Drag lines into the same order as the customer's own PO. Only the order changes, not the quantities."
      },
      {
        "title": "Raise PO (Confirm & Lock PO)",
        "detail": "Opens a form with customer name, phone, location, addresses, shop number, GST, vendor code, PO date, payment term, promise date, delivery schedule date and price type. Leave the PO number blank and the system creates one (PO-YEAR-number). Confirming locks the booking."
      },
      {
        "title": "Customer Pricing (capability: Customer Pricing)",
        "detail": "Staff with the 'View Pricing' permission see four price tiers (Venus Automation, Trader, End User, MSIL) and the total for each. They can pick a tier, clear it, or type rates by hand ('No pricing' + manual rates). The server looks up the rate, so the browser cannot set a price. The price can still be changed after the PO is raised."
      },
      {
        "title": "Changing the price schedule (capability: Customer Pricing, edit)",
        "detail": "The tier prices themselves are not changed here. They are changed in Inventory Master → Update Stock → Pricing, or with the SKU Pricing import. That needs the 'Manage Pricing' permission."
      },
      {
        "title": "Edit Details (Admin)",
        "detail": "Corrects customer and order details after submission (name, phone, email, location, shop number, GST, PO number, PO date, vendor code, addresses, payment term, remarks, promise date). Only changed fields are sent."
      },
      {
        "title": "Select Customer (inside Edit Details)",
        "detail": "Moves the booking to a different customer account. Its open indent lines and status timeline move with it, and the new customer's details are copied onto the booking."
      },
      {
        "title": "Booking status",
        "detail": "Moves the whole booking through Booking Received → Ready for Dispatch → Dispatched → Delivered. The customer gets one email per real change."
      },
      {
        "title": "Delivery schedule",
        "detail": "Sets the expected date per SKU line and emails the customer the schedule."
      },
      {
        "title": "Cancel booking",
        "detail": "Cancels the booking for the customer, returns its stock and cancels its open indent. Customers cannot do this themselves."
      },
      {
        "title": "Cancel an inward allocation",
        "detail": "Cancels stock that arrived against this booking's indent. The record is kept as Cancelled, and the stock and the indent are restored."
      },
      {
        "title": "Indent section (standalone and partial)",
        "detail": "Under Booking Items, every line the customer is still waiting for on this booking, with SKU, MSIL code, product name, quantity and status. Standalone lines come first: stock covered none of that SKU, so it has no row in Booking Items at all and appears nowhere else on the screen. Partial lines are the shortfall on a line that is already in the table above. These are live reservations, not the quantity frozen on the booking at confirmation."
      },
      {
        "title": "MSIL Supply Date and held indents",
        "detail": "Sets the date an MSIL customer needs the goods by. Indent stock that arrives too late is held, and the desk chooses Convert (add it to the booking) or Cancel."
      },
      {
        "title": "Picklist",
        "detail": "Opens a picklist preview for the warehouse and downloads it as a PDF. It uses the box numbers and saved prices."
      },
      {
        "title": "Action → Booking History",
        "detail": "A read-only timeline of the booking: created, indent raised, stock allocated, PO raised, status changes and later edits, with who did each one and where. Filters: All, Booking & PO, Indents, Allocations, Status, Updates."
      }
    ],
    "connections": [
      {
        "module": "Inventory Master",
        "key": "inventory.master",
        "why": "Every desk edit, PO and cancellation moves stock between 'available for sale' and 'booked'.",
        "data": "Available and booked quantities per SKU",
        "direction": "one-way",
        "trigger": "Line edit, Raise PO, cancel, 7-day auto-cancel",
        "verified": true
      },
      {
        "module": "Stock Ledger",
        "key": "inventory.ledger",
        "why": "Each stock movement from the desk is also written as a ledger entry, tagged with where it came from (sales-desk-edit, po-raise, booking-cancel, po-settlement).",
        "data": "Stock movement records with the booking ID and the staff member",
        "direction": "one-way",
        "trigger": "Any stock move from the desk or the PO job",
        "verified": true
      },
      {
        "module": "Booking History (customer)",
        "key": "customer_portal.booking_history",
        "why": "The customer sees the same booking: its quantities, PO number, status and status timeline.",
        "data": "Booking lines (shared records), status timeline events",
        "direction": "one-way",
        "trigger": "Any desk change; status changes add timeline events",
        "verified": true
      },
      {
        "module": "Indent History (customer)",
        "key": "customer_portal.indent_history",
        "why": "If a desk edit asks for more than stock covers, the extra goes on the booking's indent (PI-number). Cancelling or auto-cancelling closes the indent.",
        "data": "Indent lines (quantity, status)",
        "direction": "one-way",
        "trigger": "Quantity edit beyond stock, cancel, auto-cancel, Select Customer move",
        "verified": true
      },
      {
        "module": "Indent Stock Assignment",
        "key": "inventory.indent_assignment",
        "why": "Stock that arrives against an indent is allocated to bookings there. The desk shows and can cancel those allocations, and decides on held MSIL indents.",
        "data": "Inward allocations on booking lines",
        "direction": "two-way",
        "trigger": "Allocation runs; Cancel allocation; Convert/Cancel held indent",
        "verified": true
      },
      {
        "module": "Customer Management",
        "key": "administration.customers",
        "why": "Select Customer only accepts active customer accounts that have access to the booking's brand. The customer's CC list and email settings decide who gets booking emails.",
        "data": "Customer account, brand access, CC emails, notification preference",
        "direction": "one-way",
        "trigger": "Edit Details customer change; every booking email",
        "verified": true
      },
      {
        "module": "Audit log",
        "key": null,
        "why": "Every desk action is written to the shared audit log that the Employee Portal also reads.",
        "data": "'PO Generated', 'Booking Edited (Sales)', 'Booking Priced', 'Booking Details Edited', 'Booking Status Updated', 'Booking Auto-Cancelled (No PO)'",
        "direction": "one-way",
        "trigger": "Each desk action and the PO job",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Raising the PO",
        "effect": "The booking locks. Reserved stock is permanently taken out of inventory (total and booked both drop). Box numbers are refreshed from the product master. The customer gets an in-app notice and an email with the new PO number, the booking table, the delivery schedule and Excel/PDF attachments. The SI Team creator is copied.",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Changing a quantity before the PO",
        "effect": "Stock is reserved or released in the same step. Any shortfall goes to the indent. The customer is emailed 'Quantities updated on your booking' with a Change column, and gets an in-app notice when part of a line moves to indent.",
        "kind": "automatic",
        "verified": true
      },
      {
        "action": "No PO within 7 days",
        "effect": "An hourly job cancels the booking, returns the stock, closes its indent, adds 'Cancelled' to the customer's timeline, notifies the customer and the admins, and emails the customer. The returned stock can then fill other customers' waiting indents automatically.",
        "kind": "automatic",
        "verified": true
      },
      {
        "action": "Changing booking status",
        "effect": "Every line moves together. One timeline event is recorded, the customer gets one email and an in-app notice, and admins are alerted if the email fails. The email can be resent from the timeline.",
        "kind": "automatic",
        "verified": true
      },
      {
        "action": "Select Customer in Edit Details",
        "effect": "The booking, its open indent lines and its status timeline move to the new customer's portal. The old customer no longer sees it.",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Changing the price after the PO",
        "effect": "Only the saved rates change. Stock and lock are untouched. The audit entry records the old and new tier but no amounts.",
        "kind": "historical",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Who reaches the desk",
        "detail": "Needs the 'View All Bookings' permission. Sales holds it, and Admin/Super Admin get it through full access. Customers, Import Team, Warehouse, Inventory Manager and Management do not.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Editing lines",
        "detail": "Needs 'Edit Booking (Pre-PO)'. Held by Sales. A line cannot go below the units already allocated to it, cannot have the same SKU twice, and must keep at least one line.",
        "kind": "validation",
        "verified": true
      },
      {
        "title": "Raising the PO",
        "detail": "Needs 'Raise PO'. Held by Sales. A typed PO number must be unique across bookings. A cancelled booking cannot get a PO. The delivery date cannot be in the past.",
        "kind": "validation",
        "verified": true
      },
      {
        "title": "PO lock",
        "detail": "Once the PO exists, lines are frozen. Only a role with 'Override PO Lock' can change them. Sales deliberately does not have it, so Sales cannot reopen a booking it locked. Only Admin/Super Admin have it.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Edit Details is Admin-only",
        "detail": "Edit Details and Select Customer need 'Override PO Lock'. The new customer must be an active customer account with access to the booking's brand, and MSIL and standard customers cannot be swapped.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "7-day PO deadline",
        "detail": "A booking without a PO 7 × 24 hours after its booking date is cancelled automatically. The job checks every hour.",
        "kind": "expiry",
        "verified": true
      },
      {
        "title": "Status, schedule and cancel",
        "detail": "Need 'Manage Orders'. Held by Sales (since 2026-10-19). To cancel, use 'Cancel booking', because setting the status to Cancelled is refused.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Seeing and choosing prices",
        "detail": "Needs 'View Pricing'. Held by Sales only, plus Admin/Super Admin. Without it, booking data arrives with no money at all. Changing the tier prices needs 'Manage Pricing' (Sales, Inventory Manager, Management, Import Team).",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Held MSIL indent decision",
        "detail": "Convert/Cancel needs both 'View All Bookings' and 'Assign Indent Stock'.",
        "kind": "permission",
        "verified": true
      }
    ],
    "steps": [
      "Open Sales Desk from the sidebar.",
      "Stay on 'Pending PO' and search for the booking.",
      "Open it and check or correct the lines against the customer's PO.",
      "Rearrange the lines to match the PO if needed, then save.",
      "Click Raise PO, fill in the details, delivery date and price type, then press Confirm & Lock PO.",
      "Move the status forward (Ready for Dispatch, Dispatched, Delivered) as the goods move.",
      "The customer sees the result in Booking History, and the booking moves to the 'PO Generated' tab."
    ],
    "warnings": [
      {
        "title": "Raising the PO cannot be undone by Sales",
        "detail": "It locks the booking and takes the stock out of inventory. Only Admin can change it afterwards.",
        "severity": "irreversible"
      },
      {
        "title": "Bookings expire after 7 days",
        "detail": "Without a PO, the booking is cancelled and its stock is released automatically. Cancelling does not reopen its indent.",
        "severity": "irreversible"
      },
      {
        "title": "Every edit emails the customer",
        "detail": "Quantity edits, the PO, status changes and schedules all send customer email. Check before saving.",
        "severity": "warning"
      },
      {
        "title": "Select Customer moves the booking",
        "detail": "The previous customer immediately loses sight of the booking and its open indent.",
        "severity": "warning"
      }
    ],
    "unverified": [
      "The server sends a 'booking-updated' (and 'po-generated') live signal after edits, but no screen in the Customer Portal listens for it. Other open screens do not refresh until reloaded. Requires verification if the Employee Portal listens.",
      "No WhatsApp message was found for any Sales Desk action. Only email and in-app notifications were traced.",
      "Whether raising the PO starts an O2D (FMS) order automatically was not traced. No such call was found in the PO code."
    ]
  },
  {
    "key": "reports.operational",
    "portal": "customer",
    "paths": [
      "/reports"
    ],
    "title": "System Reports",
    "overview": {
      "what": "A placeholder page titled 'System Reports'. It shows a 'Bookings Processed' card and a 'Top Selling Products' list.",
      "why": "Intended for operational reporting. All figures on it are currently fixed sample numbers, not live data.",
      "users": [
        "Admin",
        "Super Admin"
      ]
    },
    "functions": [
      {
        "title": "Bookings Processed card",
        "detail": "Shows a fixed sample figure (1,284, +8.2%). It is not read from any booking."
      },
      {
        "title": "Top Selling Products",
        "detail": "Shows four fixed sample products with unit bars. It is not read from inventory or orders."
      }
    ],
    "connections": [],
    "impacts": [],
    "rules": [
      {
        "title": "Hidden from the sidebar",
        "detail": "The menu entry is hidden on purpose until the page shows real data. It can only be reached by typing /reports.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Admin only, despite the permission",
        "detail": "The route checks 'View Reports' (held by Sales, Inventory Manager and Management), but the page itself sends anyone who is not Admin or Super Admin back to the home page.",
        "kind": "permission",
        "verified": true
      }
    ],
    "steps": [
      "Sign in as Admin or Super Admin.",
      "Type /reports in the address bar. There is no menu link.",
      "Read the page as a preview only. The numbers are samples.",
      "For real figures, use the Inventory Dashboard, Inventory Health or the Sales Desk exports."
    ],
    "warnings": [
      {
        "title": "Numbers are not real",
        "detail": "Every figure on this page is sample data written into the screen. Do not use it for decisions.",
        "severity": "warning"
      }
    ],
    "unverified": [
      "The weekly booking & indent history email report is a separate job and is not shown on this page."
    ]
  }
];
