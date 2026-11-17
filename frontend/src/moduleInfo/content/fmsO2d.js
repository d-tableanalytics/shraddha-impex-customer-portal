/**
 * "About this module" documentation: FMS: Order to Dispatch.
 *
 * GENERATED from the module audit; edit the text here directly when a screen
 * changes. The code each statement was verified against is listed in
 * docs/module-documentation-map.md, not here, so no source paths ship to the
 * browser. `verified: false` items show as "Requires verification".
 */
export default [
  {
    "key": "o2d.tasks",
    "portal": "both",
    "paths": [
      "/fms/o2d/tasks"
    ],
    "title": "My Tasks",
    "overview": {
      "what": "Your queue of Order-to-Dispatch stages: the stages of open customer orders that your role must complete now, with deadlines.",
      "why": "Each of the 12 stages from customer PO to AWB has an owner and a deadline. This list tells you what is yours and what is late.",
      "users": [
        "Sales",
        "Billing",
        "Accounts",
        "Billing Head",
        "Warehouse User",
        "Management",
        "Import Team",
        "Super Admin",
        "Admin"
      ]
    },
    "functions": [
      {
        "title": "Filter by urgency",
        "detail": "All, Overdue, Due soon, On track; include completed stages or show only to-do."
      },
      {
        "title": "Actionable vs watching",
        "detail": "Stages you may complete are actionable. Stages you own but another team records (for example stage 2 for Sales, closed by Billing) show as watching."
      },
      {
        "title": "Complete a stage",
        "detail": "Opens the completion form; some stages ask for evidence such as invoice number, AWB, amount or UTR."
      },
      {
        "title": "Open the order",
        "detail": "Opens the full order view with all 12 stages."
      }
    ],
    "connections": [
      {
        "module": "Work Queue: Checklist and Delegation",
        "key": "work_queue.tasks",
        "why": "Each open stage also exists as a Work Queue task, so it appears in My Day too",
        "data": "One task per open stage: a team Checklist task for the owning role, or a personal task when a person is assigned. Completing it from the Work Queue completes the real stage.",
        "direction": "two-way",
        "trigger": "Stage unlocks, is assigned, completed, skipped, held",
        "verified": true
      },
      {
        "module": "Executive Scoreboard",
        "key": null,
        "why": "Completed O2D stage tasks count in people's on-time scores, judged against the exact stage deadline",
        "data": "Stage task completion times",
        "direction": "one-way",
        "trigger": "Completing the stage task",
        "verified": true
      },
      {
        "module": "O2D bell (in-app notifications)",
        "key": null,
        "why": "Alerts about stages reach the owning role",
        "data": "Unlocked, due soon, overdue, escalated",
        "direction": "one-way",
        "trigger": "Stage events and the 5-minute sweep",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Completing a stage",
        "effect": "The next stage unlocks with a new deadline, its owner gets a task and a notification, and the Work Queue copy of this stage is marked done.",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Leaving a stage past its deadline",
        "effect": "The 5-minute sweep sends an overdue alert to the owner, and after a grace period escalates to the stage's escalation role (Management by default).",
        "kind": "automatic",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Who sees it",
        "detail": "Needs 'View O2D'. By default held by Sales, Billing, Accounts, Billing Head, Warehouse User, Management and Import Team. The list only shows stages your role owns or may complete.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Completing needs 'Work O2D Stage'",
        "detail": "Held by Sales, Billing, Accounts, Billing Head and Warehouse User. Import Team and Management can view but not complete.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Working hours",
        "detail": "Deadlines count working time only (default 10:30 to 18:30, Monday to Saturday), except stage 5 which uses calendar days.",
        "kind": "automation",
        "verified": true
      }
    ],
    "steps": [
      "Open FMS, then My Tasks.",
      "Start with the Overdue filter.",
      "Click a task to open the order.",
      "Complete the stage, filling in any evidence it asks for.",
      "The next stage's owner is notified and the order moves on in the Order Tracker."
    ],
    "warnings": [
      {
        "title": "Escalations are automatic",
        "detail": "Late stages are reported to the escalation role without anyone pressing a button.",
        "severity": "warning"
      }
    ],
    "unverified": [
      "Background sweeps (reminders, escalations, daily summary, invoice retry) run only when the Employee Portal server has O2D_CRON=enabled. Production setting not checked.",
      "WhatsApp and email notifications are off unless O2D_WHATSAPP_ENABLED / O2D_EMAIL_ENABLED are set; in-app is on by default. Production settings not checked."
    ]
  },
  {
    "key": "o2d.orders",
    "portal": "both",
    "paths": [
      "/fms/o2d/orders",
      "/fms/o2d/orders/new",
      "/fms/o2d/history",
      "/fms/o2d/exits"
    ],
    "title": "Order Tracker",
    "overview": {
      "what": "All live O2D orders (open and on hold) with their current stage, plus the New Order form, Order History and Exit Register. Opening an order shows its 12 stages, documents, history and actions.",
      "why": "Follows every customer PO from receipt to dispatch so nothing stalls between Sales, Billing, Accounts and the warehouse.",
      "users": [
        "Sales",
        "Billing",
        "Accounts",
        "Billing Head",
        "Warehouse User",
        "Management",
        "Import Team",
        "Super Admin",
        "Admin"
      ]
    },
    "functions": [
      {
        "title": "New Order",
        "detail": "Enter the PO number, customer and items. You can pick a Customer Portal booking to build the order from, or enter a PO that came by email. A duplicate warning appears as you type."
      },
      {
        "title": "The 12 stages",
        "detail": "1 Receive Order (Sales), 2 Submit PO to Billing (Sales), 3 Send SOR + PI (Billing), 4 Advance Order Decision (Billing), 5 Receive Advance Payment (Accounts), 6 Create Order List, 7 Warehouse Picking Request, 8 Scan Material + Create Invoice, 9 Pack & Dispatch (Warehouse User), 10 Mark Sent in Zoho, 11 Send Dispatch Details, 12 Upload AWB/LR + Close Order (Billing)."
      },
      {
        "title": "Advance decision (stage 4)",
        "detail": "If no advance is needed, stage 5 is skipped automatically."
      },
      {
        "title": "Assign a stage to a person",
        "detail": "Hands the stage to one named person; it appears in their Work Queue."
      },
      {
        "title": "Hold & Resume",
        "detail": "Puts the whole order on hold with a reason (customer request, stock unavailable, payment pending, documentation, other). Deadlines pause while on hold."
      },
      {
        "title": "Cancel, Void, Revive",
        "detail": "Takes an order out of the workflow (Void is for entry errors) or brings it back. The record is kept and listed in the Exit Register."
      },
      {
        "title": "Reopen a stage",
        "detail": "Sends a completed stage back for rework."
      },
      {
        "title": "Raise invoice",
        "detail": "Creates the invoice in Zoho Books for the order."
      },
      {
        "title": "Documents",
        "detail": "Upload and view files on the order (10 MB limit)."
      },
      {
        "title": "Order History / Exit Register",
        "detail": "Order History lists every order whatever its status; Exit Register lists held, cancelled and voided orders."
      }
    ],
    "connections": [
      {
        "module": "Customer Portal bookings",
        "key": "customer_portal.create_booking",
        "why": "Sales can create an O2D order from a customer's booking",
        "data": "Booking lines grouped by booking number are read; nothing is written back to the booking",
        "direction": "one-way",
        "trigger": "Picking a booking on New Order",
        "verified": true
      },
      {
        "module": "Work Queue (Checklist / Delegation)",
        "key": "work_queue.tasks",
        "why": "Each open stage has one Work Queue task. Stages that need recorded details go to Checklist; stages that are a confirmation or decision (such as 1 and 4) go to Delegation when assigned to a person.",
        "data": "Task per stage, held/released with the order",
        "direction": "two-way",
        "trigger": "Unlock, assign, complete, skip, hold, reopen",
        "verified": true
      },
      {
        "module": "Zoho Books",
        "key": null,
        "why": "Invoices are created in Zoho and their status comes back by webhook",
        "data": "Invoice number and status",
        "direction": "two-way",
        "trigger": "Raise invoice button; Zoho webhook; hourly retry of failed invoices",
        "verified": true
      },
      {
        "module": "Notifications (in-app, email, WhatsApp)",
        "key": null,
        "why": "Owners and oversight roles are told about stage events",
        "data": "Order created, stage unlocked / due soon / overdue / escalated, held, resumed, closed, cancelled",
        "direction": "one-way",
        "trigger": "Stage engine events and the sweep",
        "verified": true
      },
      {
        "module": "Delay Analytics",
        "key": "o2d.analytics",
        "why": "Stage completion times feed the on-time figures",
        "data": "Stage status and timings",
        "direction": "one-way",
        "trigger": "Completing stages",
        "verified": true
      }
    ],
    "impacts": [
      {
        "action": "Creating an order",
        "effect": "Twelve stage rows are created; stage 1 opens and its owner gets a task and notification.",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Putting an order on hold",
        "effect": "Deadlines pause and the order's Work Queue tasks are held. Resuming releases them.",
        "kind": "multi",
        "verified": true
      },
      {
        "action": "Cancelling or voiding",
        "effect": "The order leaves the tracker and appears in the Exit Register. The record and its stages are kept.",
        "kind": "historical",
        "verified": true
      },
      {
        "action": "Creating an O2D order from a booking",
        "effect": "The booking itself is not changed; it stops appearing in the booking picker while a live O2D order uses it.",
        "kind": "historical",
        "verified": true
      }
    ],
    "rules": [
      {
        "title": "Create an order",
        "detail": "Needs 'Create O2D Order'. By default only Sales (and admins).",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Complete, assign, raise invoice",
        "detail": "Needs 'Work O2D Stage' (Sales, Billing, Accounts, Billing Head, Warehouse User). The server also checks your role against the stage owner.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Hold and resume",
        "detail": "Needs 'Hold O2D' (Billing Head, Management).",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Cancel, void, revive",
        "detail": "Needs 'Exit O2D' (Billing Head, Management).",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Reopen and overrides",
        "detail": "Needs 'Override O2D' (Billing Head, Management).",
        "kind": "approval",
        "verified": true
      },
      {
        "title": "One invoice per order",
        "detail": "The Zoho invoice uses a fixed key per order so retries never create a second invoice.",
        "kind": "validation",
        "verified": true
      }
    ],
    "steps": [
      "Open FMS, then Order Tracker.",
      "Click New Order, pick the customer's booking (or type the PO), check items and save.",
      "Each stage owner completes their stage from My Tasks or the order view.",
      "At stage 4, record whether an advance is needed.",
      "Use Hold, Cancel or Void only with a reason; held orders pause their deadlines.",
      "At stage 12, upload the AWB/LR to close the order. It then moves to Order History."
    ],
    "warnings": [
      {
        "title": "Void is for entry errors",
        "detail": "Use Cancel for a real cancelled order. Both remove the order from live work.",
        "severity": "warning"
      },
      {
        "title": "Invoices are real",
        "detail": "Raise invoice creates a real Zoho Books invoice for the customer.",
        "severity": "irreversible"
      }
    ],
    "unverified": [
      "Zoho integration is active only when O2D_ZOHO_ENABLED=enabled on the Employee server; production setting not checked.",
      "In the Customer Portal these screens call the Employee Portal server; they are hidden if that server's address is not configured, and the Customer Portal's web address must be allowed by the Employee server (CORS)."
    ]
  },
  {
    "key": "o2d.stages",
    "portal": "both",
    "paths": [
      "/fms/o2d/stages"
    ],
    "title": "Stages",
    "overview": {
      "what": "A board of the 12 O2D stages: each stage as its own tab, listing the live orders sitting in it and how many are late.",
      "why": "Shows where orders are piling up, stage by stage.",
      "users": [
        "Sales",
        "Billing",
        "Accounts",
        "Billing Head",
        "Warehouse User",
        "Management",
        "Import Team",
        "Super Admin",
        "Admin"
      ]
    },
    "functions": [
      {
        "title": "Stage tabs",
        "detail": "One tab per stage, showing its name and owning role."
      },
      {
        "title": "Here now / Passed through",
        "detail": "Switch between orders currently in the stage and orders that already passed it."
      },
      {
        "title": "Late count",
        "detail": "Each stage shows how many of its orders are late."
      }
    ],
    "connections": [
      {
        "module": "Order Tracker",
        "key": "o2d.orders",
        "why": "Same orders, grouped by stage",
        "data": "Live orders and stage status",
        "direction": "one-way",
        "trigger": "Opening the screen",
        "verified": true
      }
    ],
    "impacts": [],
    "rules": [
      {
        "title": "Who sees it",
        "detail": "Needs 'View O2D'. What each person sees is narrowed by role on the server.",
        "kind": "permission",
        "verified": true
      }
    ],
    "steps": [
      "Open FMS, then Stages.",
      "Pick a stage tab.",
      "Check Here now and the late count.",
      "Click an order to open it and act."
    ],
    "warnings": [],
    "unverified": []
  },
  {
    "key": "o2d.analytics",
    "portal": "both",
    "paths": [
      "/fms/o2d/analytics"
    ],
    "title": "Analytics",
    "overview": {
      "what": "Delay analytics for O2D: open, on-hold and overdue counts, on-time percentage, cycle time from PO to dispatch, worst delays, performance by team and slowest customers.",
      "why": "Shows whether orders are slow because of our teams or because of customers, and which stages lose the most time.",
      "users": [
        "Billing Head",
        "Management",
        "Super Admin",
        "Admin"
      ]
    },
    "functions": [
      {
        "title": "Date range",
        "detail": "From and to dates limit every figure."
      },
      {
        "title": "Headline numbers",
        "detail": "Open orders, On hold, Overdue stages, Dispatched."
      },
      {
        "title": "On-time performance",
        "detail": "Stages completed, stages late and on-time percentage. Skipped stages are not counted."
      },
      {
        "title": "Cycle time (PO to dispatch)",
        "detail": "Median and average hours, and how many orders were measured."
      },
      {
        "title": "Worst delays, By team, Slowest customers",
        "detail": "Ranked lists of where time is lost."
      },
      {
        "title": "Export",
        "detail": "Download a dataset as a file."
      }
    ],
    "connections": [
      {
        "module": "Order Tracker / My Tasks",
        "key": "o2d.orders",
        "why": "Figures are calculated from stage completions",
        "data": "Stage status and timings",
        "direction": "one-way",
        "trigger": "Opening the screen",
        "verified": true
      },
      {
        "module": "Daily summary email",
        "key": null,
        "why": "A 09:00 IST digest goes to Management and Billing Head",
        "data": "Open, overdue and summary counts",
        "direction": "one-way",
        "trigger": "Daily scheduled job",
        "verified": true
      }
    ],
    "impacts": [],
    "rules": [
      {
        "title": "Who sees it",
        "detail": "Needs 'View O2D Analytics', held by default by Billing Head and Management. The tab is hidden from others.",
        "kind": "permission",
        "verified": true
      },
      {
        "title": "Held time excluded",
        "detail": "Time an order spent on hold is not counted as delay.",
        "kind": "automation",
        "verified": true
      }
    ],
    "steps": [
      "Open FMS, then the Analytics tab.",
      "Set the date range.",
      "Read the headline numbers and on-time percentage.",
      "Check Worst delays and By team to find the slow stage.",
      "Export the data if you need it in a spreadsheet."
    ],
    "warnings": [],
    "unverified": [
      "The registry calls this screen 'Delay Analytics'; the tab in the app is labelled 'Analytics'."
    ]
  }
];
