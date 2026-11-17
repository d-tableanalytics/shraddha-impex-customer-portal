# Customer Portal: module documentation map

Generated from the module audit. Every screen with its route, its verified connections and impacts, and the code each statement was read from. Items marked **UNVERIFIED** could not be confirmed from the code.

## Customer Portal

### Dashboard (`customer_portal.dashboard`)

Routes: `/`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Create Booking / Booking History | one-way | Booking rows (own rows for non-admins), selection-list count | Page load; refreshed after any booking change | backend/routes/api.routes.js:235; frontend/src/store/homeDashboardStore.js; frontend/src/store/cartStore.js:9 |
| Product Catalogue | one-way | Product counts, available-for-sale | Page load | backend/routes/api.routes.js:243-257 |
| Inventory Dashboard | one-way | Redirect only | Opening '/' | frontend/src/components/layout/HomeRoute.jsx |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Opening the dashboard | Read-only. Nothing is written. | historical | backend/routes/api.routes.js:235 |

Rules:

- **Brand scope**: Counts include only brands ticked on your account. Admin and inventory roles see all brands. _(backend/utils/brandAccess.js; backend/routes/api.routes.js:240-244)_
- **Booking panels hidden for non-ordering roles**: Roles that cannot book see only the stock tiles. _(frontend/src/pages/Dashboard/Dashboard.jsx:26)_
- **Access**: Needs 'View Dashboard', which every built-in role holds. _(backend/config/permissions.js PORTAL_BASICS)_

Requires verification:

- Exact list of KPI fields returned by the stats endpoint was not traced line by line.
- Sales sees only bookings they own on this page (the stats filter is skipped only for Super Admin), unlike the Sales Desk — confirm this is intended.

### Create Booking (`customer_portal.create_booking`)

Routes: `/orders/new`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Inventory Master / Stock Ledger | one-way | Available-for-sale down, booked up; RESERVE ledger movement | Confirm Booking | backend/modules/reservations/reservation.controller.js:95-135 |
| Booking Desk (Sales Desk) | two-way | Booking rows, incl. SI Team (who placed it) | Confirm Booking | backend/modules/reservations/reservation.controller.js:1091-1150 |
| Indent History / Indent Stock Assignment | one-way | Indent lines (Pending / Partially Confirmed) | Confirm Booking with short stock | backend/modules/reservations/reservation.controller.js:1155-1166 |
| Customer Management | one-way | Customer account | Select Customer / + Add Customer | backend/utils/bookingActor.js; frontend/src/pages/CustomerOrders/CustomerOrders.jsx:95-125 |
| Notifications and email | one-way | In-app notices; one booking or indent email to the customer, staff placer copied | Confirm Booking | backend/modules/reservations/reservation.controller.js:1283-1360; backend/utils/indentMail.js |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Adding to the Selection List | A reservation line is saved (7-day validity). No stock moves. Admins get a 'New Booking' notice. | automatic | backend/modules/reservations/reservation.controller.js:640-705 |
| Confirm Booking | Stock is deducted, booking rows are created with status 'Booking Received', short quantity becomes an indent, emails and notices go out, and the Sales Desk, Booking History, Indent History and Dashboard refresh (live events 'order-created' / 'indent-raised'). | multi | backend/modules/reservations/reservation.controller.js:1240-1400 |
| Leaving lines unconfirmed | Daily job sends reminders on day 5 and day 6, then cancels the lines after 7 days (status Expired). Staff-built lists remind the staff member, not the customer. | automatic | backend/modules/reservations/reservationExpiryJob.js; backend/server.js:168 |
| No PO within 7 days of confirming | Hourly job auto-cancels the booking, returns stock, emails the customer and may auto-book waiting indents with the freed stock. | multi | backend/modules/orders/poExpiryJob.js:199-297; backend/server.js:164 |

Rules:

- **Multiple (MOQ)**: Non-MSIL customers must book in multiples of the product's Multiple. MSIL customers, company-email staff and accounts marked SKIP are exempt. _(backend/utils/moq.js)_
- **Brand access**: Only products of brands ticked on the customer's account can be found or booked. MSIL customers never see brands flagged hidden from MSIL. _(backend/utils/brandAccess.js; reservation.controller.js:612-620)_
- **MSIL code must be active**: For users MSIL codes apply to, a product with an inactive MSIL code cannot be booked. _(backend/modules/reservations/reservation.controller.js:635-641)_
- **Over-booking allowed**: Any quantity may be added; the part stock cannot cover becomes an indent at confirmation. _(backend/modules/reservations/reservation.controller.js:630-633)_
- **7-day validity**: Unconfirmed lines expire after 7 days; topping up a line does not extend it. _(backend/modules/reservations/reservation.controller.js:672-700)_
- **Booking for others**: Only holders of 'View All Bookings' (Sales, Admin) may book for a customer, and only for an active Customer account. _(backend/utils/bookingActor.js:47-75)_
- **Access**: Needs 'Create Order' (Customer, Sales via matrix/Admin) or 'View All Bookings' (Sales, Admin). _(backend/modules/reservations/reservation.routes.js:36; backend/config/moduleRegistry.js:163)_

### Bulk Booking Upload (`customer_portal.bulk_upload`)

Routes: `/orders/bulk-upload`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Create Booking | one-way | Booking rows and indent lines | Continue to Booking | backend/modules/reservations/reservation.controller.js:1418-1421, 843-918 |
| Inventory Master / Stock Ledger | one-way | Stock movement | Continue to Booking | backend/modules/reservations/reservation.controller.js:95-135 |
| Booking Desk / Booking History / Indent History | one-way | Booking and indent records | Continue to Booking | frontend/src/pages/BulkUpload/BulkUpload.jsx:197-210 |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Continue to Booking | One transaction: either the whole file becomes a booking (plus an indent for any shortfall) or nothing is saved. Same emails, notices and live events as Create Booking. | multi | backend/modules/reservations/reservation.controller.js:1240-1400 |
| Validate | Read-only check; nothing is saved. | historical | backend/modules/reservations/reservation.controller.js:1423 |

Rules:

- **Re-checked at booking**: Multiple, brand and MSIL rules are checked again when booking, not trusted from the preview. _(backend/modules/reservations/reservation.controller.js:885-897)_
- **Repeated SKUs merged**: The same SKU listed twice in one file becomes one line. _(backend/modules/reservations/reservation.controller.js:866-874)_
- **Does not touch the Selection List**: Items already in your list are not swept into the upload's booking. _(backend/modules/reservations/reservation.controller.js:843-860)_
- **Access**: Needs 'Create Order' or 'View All Bookings'. _(backend/modules/reservations/reservation.routes.js:60-64)_

Requires verification:

- Bulk Upload has no Select Customer picker, so a Sales user's upload is booked to their own account — requires verification that this is intended.
- Validation uses the uploader's own rules (brand, Multiple), not a customer's.

### Booking History (`customer_portal.booking_history`)

Routes: `/orders/history`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Booking Desk (Sales Desk) | two-way | Booking rows, status, PO | Status/PO/qty changes | frontend/src/services/orders.js:259-380; backend/modules/orders/order.routes.js |
| Inventory Master / Stock Ledger | one-way | Stock release / consumption | Cancel booking / PO raised (settled by hourly job) | backend/modules/orders/order.controller.js:623-780; backend/modules/orders/poExpiryJob.js |
| Indent Stock Assignment | one-way | Released SKUs | Cancel booking | backend/modules/orders/order.controller.js:778 |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Status change by staff | Every line moves, a timeline entry is saved and the customer is emailed. | multi | backend/modules/orders/bookingStatus.service.js:125 |
| Cancel booking (staff) | Booking marked Cancelled, stock returned, customer and admins notified, live event 'booking-cancelled', waiting indents may auto-book. | multi | backend/modules/orders/order.controller.js:721-780 |
| Past bookings | Customer details are copied onto the booking when created; later profile changes do not rewrite them. | historical | backend/modules/reservations/reservation.controller.js:1120-1135 |

Rules:

- **Customers cannot cancel**: Since 2026-10-27 the cancel button shows only for 'Manage Orders' holders; customers are told to email support. _(backend/modules/orders/order.controller.js:636-645; frontend/src/components/drawer/OrderDrawer.jsx:154)_
- **Own bookings only**: Without 'View All Bookings' you see only your own bookings. _(backend/modules/orders/order.controller.js:97)_
- **Quantity edits**: Only 'Edit Booking Pre-PO' holders (Sales, Admin) can change quantities; the customer is emailed. _(backend/modules/orders/order.routes.js:85-90)_
- **Access**: Needs 'View Orders' (Customer, Sales, Admin). _(backend/config/moduleRegistry.js:187)_

### Indent History (`customer_portal.indent_history`)

Routes: `/orders/indent-history`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Inventory stock postings (receipts, adjustments, counts, imports) | one-way | Indent → booking rows; stock reserved | Stock movement / job | backend/modules/inventory/indentAvailability.service.js:968-1100 |
| Indent Stock Assignment | two-way | Indent lines, allocations | Assign / Auto-assign | backend/modules/inventory/indentAvailability.service.js:1015 |
| Sales Desk (MSIL Supply Date) | two-way | Supply check status 'Awaiting decision' | Stock arrival after Supply Date or 7-day window | backend/utils/msilSupply.js; indentAvailability.service.js:905-966 |
| Upcoming Stock | one-way | Indent quantities (read) | Opening Upcoming Stock | backend/modules/inventory/indentAvailability.service.js:976-985 |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Stock arrives for an indent | In auto mode the oldest covered indent becomes a booking (or is added to its booking), stock is reserved, customer notified and emailed, support mailbox informed. | automatic | backend/modules/inventory/indentAvailability.service.js:194, 658-740 |
| Late MSIL arrival | Indent is held, stock is not used, admins notified once; desk must Convert or Cancel. | manual | backend/modules/inventory/indentAvailability.service.js:905-935 |
| Scheduling a date | Customer emailed their full schedule and notified in-app; restore before that date is refused. | automatic | backend/modules/reservations/reservation.controller.js:316-460, 490-505 |

Rules:

- **Auto-booking conditions**: Indent open, no PO yet, stock covers the whole quantity, not scheduled for later. _(backend/modules/inventory/indentAvailability.service.js:1-20)_
- **MSIL supply check**: MSIL customers with a Supply Date: stock must arrive by that date and within 7 days of booking, else held. _(backend/utils/msilSupply.js)_
- **Customers cannot cancel indents**: Server returns an error asking them to email support. _(backend/modules/reservations/reservation.controller.js:776-784)_
- **Scope**: 'View All Bookings' holders see every customer's indents; customers see their own, brand-scoped. _(backend/modules/reservations/reservation.controller.js:163-170)_
- **Access**: Needs 'View Orders'. Scheduling is Admin-only. _(backend/config/moduleRegistry.js:196; reservation.controller.js:336)_

### Inventory Dashboard (`customer_portal.catalogue`)

Routes: `/inventory`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Inventory Master | one-way | Product and available stock (read) | Page load and live 'inventory:stock-updated' event | frontend/src/pages/Inventory/Inventory.jsx:5,69; backend/utils/stockEvents.js:22 |
| Product Details (Admin) | one-way | Descriptions, media | Opening a product | frontend/src/routes/index.jsx (admin/product-details) |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Browsing | Read-only; nothing is saved. | historical | frontend/src/services/products.js |

Rules:

- **Brand scope**: Only brands on your account are listed. _(backend/utils/brandAccess.js)_
- **MSIL code visibility**: Shown to Admin, Sales, inventory roles, MSIL customers and accounts flagged to see it. _(backend/utils/msilVisibility.js:17-25)_
- **Access**: Needs 'View Catalogue', held by every built-in role. _(backend/config/permissions.js PORTAL_BASICS)_

Requires verification:

- Box No column visibility rule not traced.
- Screen heading reads 'Inventory Dashboard' while the menu label is 'Product Catalogue'.

### Account Settings (`customer_portal.profile`)

Routes: `/settings`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Customer Management | one-way | Name, photo, notification preferences | Save | backend/modules/auth/auth.controller.js:504-515 |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Changing name | Existing bookings keep the details copied when they were made. | historical | backend/modules/reservations/reservation.controller.js:1120-1135 |

Rules:

- **Limited fields**: Only name, photo and notification preferences can be changed here. _(backend/modules/auth/auth.controller.js:504-515)_
- **Password rules**: Current password required; new password must pass the strength check; rate-limited. _(backend/modules/auth/auth.controller.js:546-564; backend/modules/auth/auth.routes.js:16)_
- **Access**: Needs 'View Profile' / 'Edit Profile', held by every built-in role. _(backend/config/permissions.js PORTAL_BASICS)_

Requires verification:

- The Security tab is hidden for non-admins in the UI, but the password API itself is open to any signed-in user — requires verification of intent.

### Help & Support (`customer_portal.support`)

Routes: `/help`

Rules:

- **Access**: Needs 'View Help', held by every built-in role. _(backend/config/permissions.js PORTAL_BASICS)_

Requires verification:

- Help content is static text; no ticketing is recorded in the system.

## Sales Desk and Reports

### Sales Desk (`sales.bookings`)

Routes: `/sales`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Inventory Master | one-way | Available and booked quantities per SKU | Line edit, Raise PO, cancel, 7-day auto-cancel | backend/modules/sales/sales.controller.js:560-575 (reserveStock/releaseStock/adjust*), backend/utils/stockLedger.js |
| Stock Ledger | one-way | Stock movement records with the booking ID and the staff member | Any stock move from the desk or the PO job | backend/utils/stockLedger.js:1-31 (recordStockMovement dual-write); ctx.workflow in sales.controller.js:563, :1003; poExpiryJob.js:156,:214 |
| Booking History (customer) | one-way | Booking lines (shared records), status timeline events | Any desk change; status changes add timeline events | backend/modules/orders/bookingStatus.service.js:recordEvent, order.routes.js:53 (timeline) |
| Indent History (customer) | one-way | Indent lines (quantity, status) | Quantity edit beyond stock, cancel, auto-cancel, Select Customer move | backend/modules/sales/sales.controller.js:410 setIndentShortfall; backend/utils/bookingOwner.js |
| Indent Stock Assignment | two-way | Inward allocations on booking lines | Allocation runs; Cancel allocation; Convert/Cancel held indent | frontend/src/store/salesStore.js:210 → POST /inventory/indent-assignment/cancel; backend/modules/sales/sales.routes.js:48-50 |
| Customer Management | one-way | Customer account, brand access, CC emails, notification preference | Edit Details customer change; every booking email | backend/modules/sales/bookingEdit.service.js:362-415; backend/utils/bookingRecipients.js |
| Audit log | one-way | 'PO Generated', 'Booking Edited (Sales)', 'Booking Priced', 'Booking Details Edited', 'Booking Status Updated', 'Booking Auto-Cancelled (No PO)' | Each desk action and the PO job | backend/utils/auditLog.js; sales.controller.js:1065, :1250; poExpiryJob.js:logSystemEvent |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Raising the PO | The booking locks. Reserved stock is permanently taken out of inventory (total and booked both drop). Box numbers are refreshed from the product master. The customer gets an in-app notice and an email with the new PO number, the booking table, the delivery schedule and Excel/PDF attachments. The SI Team creator is copied. | multi | backend/modules/sales/sales.controller.js:870-1150 (settleBooking consume, buildPoRaisedEmail, bookingCc) |
| Changing a quantity before the PO | Stock is reserved or released in the same step. Any shortfall goes to the indent. The customer is emailed 'Quantities updated on your booking' with a Change column, and gets an in-app notice when part of a line moves to indent. | automatic | backend/modules/sales/sales.controller.js:780-850 |
| No PO within 7 days | An hourly job cancels the booking, returns the stock, closes its indent, adds 'Cancelled' to the customer's timeline, notifies the customer and the admins, and emails the customer. The returned stock can then fill other customers' waiting indents automatically. | automatic | backend/server.js:164 (cron '0 * * * *'); backend/modules/orders/poExpiryJob.js |
| Changing booking status | Every line moves together. One timeline event is recorded, the customer gets one email and an in-app notice, and admins are alerted if the email fails. The email can be resent from the timeline. | automatic | backend/modules/orders/bookingStatus.service.js:applyBookingStatus, notifyCustomer, resendStatusMail |
| Select Customer in Edit Details | The booking, its open indent lines and its status timeline move to the new customer's portal. The old customer no longer sees it. | multi | backend/modules/sales/bookingEdit.service.js:265-277; backend/utils/bookingOwner.js:moveOwnedRecords |
| Changing the price after the PO | Only the saved rates change. Stock and lock are untouched. The audit entry records the old and new tier but no amounts. | historical | backend/modules/sales/sales.controller.js:1218-1280 |

Rules:

- **Who reaches the desk**: Needs the 'View All Bookings' permission. Sales holds it, and Admin/Super Admin get it through full access. Customers, Import Team, Warehouse, Inventory Manager and Management do not. _(backend/config/permissions.js:430-462; sales.routes.js:18)_
- **Editing lines**: Needs 'Edit Booking (Pre-PO)'. Held by Sales. A line cannot go below the units already allocated to it, cannot have the same SKU twice, and must keep at least one line. _(backend/modules/sales/sales.controller.js:470-540)_
- **Raising the PO**: Needs 'Raise PO'. Held by Sales. A typed PO number must be unique across bookings. A cancelled booking cannot get a PO. The delivery date cannot be in the past. _(backend/modules/sales/sales.controller.js:870-960)_
- **PO lock**: Once the PO exists, lines are frozen. Only a role with 'Override PO Lock' can change them. Sales deliberately does not have it, so Sales cannot reopen a booking it locked. Only Admin/Super Admin have it. _(backend/utils/bookingLock.js:assertBookingEditable; permissions.js:304)_
- **Edit Details is Admin-only**: Edit Details and Select Customer need 'Override PO Lock'. The new customer must be an active customer account with access to the booking's brand, and MSIL and standard customers cannot be swapped. _(backend/modules/sales/sales.routes.js:84; bookingEdit.service.js:362-400)_
- **7-day PO deadline**: A booking without a PO 7 × 24 hours after its booking date is cancelled automatically. The job checks every hour. _(backend/utils/bookingLock.js:PO_DEADLINE_DAYS; backend/server.js:164)_
- **Status, schedule and cancel**: Need 'Manage Orders'. Held by Sales (since 2026-10-19). To cancel, use 'Cancel booking', because setting the status to Cancelled is refused. _(backend/modules/orders/order.routes.js:32-117; order.controller.js:636; bookingStatus.service.js:applyBookingStatus)_
- **Seeing and choosing prices**: Needs 'View Pricing'. Held by Sales only, plus Admin/Super Admin. Without it, booking data arrives with no money at all. Changing the tier prices needs 'Manage Pricing' (Sales, Inventory Manager, Management, Import Team). _(backend/config/permissions.js:445-565; sales.routes.js:103-105; sales.controller.js:mayPrice)_
- **Held MSIL indent decision**: Convert/Cancel needs both 'View All Bookings' and 'Assign Indent Stock'. _(backend/modules/sales/sales.routes.js:47)_

Requires verification:

- The server sends a 'booking-updated' (and 'po-generated') live signal after edits, but no screen in the Customer Portal listens for it. Other open screens do not refresh until reloaded. Requires verification if the Employee Portal listens.
- No WhatsApp message was found for any Sales Desk action. Only email and in-app notifications were traced.
- Whether raising the PO starts an O2D (FMS) order automatically was not traced. No such call was found in the PO code.

### System Reports (`reports.operational`)

Routes: `/reports`

Rules:

- **Hidden from the sidebar**: The menu entry is hidden on purpose until the page shows real data. It can only be reached by typing /reports. _(backend/config/moduleRegistry.js:484-498 (hidden: true))_
- **Admin only, despite the permission**: The route checks 'View Reports' (held by Sales, Inventory Manager and Management), but the page itself sends anyone who is not Admin or Super Admin back to the home page. _(frontend/src/pages/Reports/Reports.jsx:8-20; backend/config/permissions.js:449,477,516)_

Requires verification:

- The weekly booking & indent history email report (scheduled in server.js) is a separate job and is not shown on this page.

## Inventory Management

### Inventory Dashboard (`inventory.dashboard`)

Routes: `/inventory/dashboard`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Inventory Health | one-way | Band, available %, coverage days per SKU | Page load (the result is cached briefly on the server) | backend/modules/inventory/dashboard.service.js:1-30; frontend/src/pages/Inventory/InventoryDashboard.jsx:62 |
| Stock Ledger (balances) | one-way | On hand, reserved per SKU and location | Page load | backend/modules/inventory/dashboard.service.js:1-4 |
| Brands | one-way | Brand list | Brand saved on the Brands screen | backend/modules/inventory/brand.controller.js:97 (invalidateDashboardCache) |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Any stock movement (booking, adjustment, import, count) | Balances and health are recomputed for the SKUs touched; the dashboard shows the new figures the next time it loads. It does not refresh live. | automatic | backend/utils/dualWrite.js:207-225; InventoryDashboard.jsx has no socket listener |

Rules:

- **Who can open it**: Needs the 'View Inventory' permission, held by Admin, Sales, Inventory Manager, Warehouse User, Management and Import Team. _(backend/config/moduleRegistry.js inventory.dashboard; backend/config/permissions.js:440-565)_
- **No trend, no alerts**: The dashboard shows today's position only. It has no history chart and does not list inventory alerts. _(backend/modules/inventory/dashboard.service.js:25)_

Requires verification:

- Exact cache duration of the dashboard payload was not checked (dashboard.controller.js).

### Inventory Master (`inventory.master`)

Routes: `/inventory/master`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Stock Ledger | one-way | Adjustment movements with reason, before/after quantity | Update stock saved | backend/modules/inventory/adjustment.service.js:214-229 |
| Inventory Health | one-way | Lead time, consumption, safety factor, season, status, balances | Stock adjustment or planning save | backend/modules/inventory/adjustment.service.js:35; health.service.js:334 |
| Catalogue / Create Booking (customer stock) | one-way | Total, booked, available for sale, in transit | Adjustment, import or count posted | backend/modules/inventory/balance.service.js:436 (syncLegacyStock); adjustment.service.js:34 |
| Upcoming Stock | one-way | Positive adjustment / receipt / count movements | Stock increase posted | backend/modules/inventory/upcomingStock.service.js:15-23, 63-64 |
| Sales Desk / Purchase Orders | one-way | Box No | Box No saved by Admin | frontend/src/pages/Inventory/InventoryMaster.jsx:336-343; backend/config/permissions.js:319-330 |
| Customer Pricing | one-way | Product price tiers | Pricing saved | backend/modules/inventory/inventory.routes.js:118-122 |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Saving Update stock | The difference is posted to the ledger, balances and health are recomputed, and the customer-facing available quantity is updated. This screen refreshes its list. | multi | backend/modules/inventory/adjustment.service.js:18-35 |
| Setting a SKU Inactive or Discontinued | Refused while the SKU has any on-hand or reserved stock in any location. Existing bookings and indents are not changed by the status itself. | manual | backend/modules/inventory/inventory.controller.js:620-640 |
| Deleting a SKU | Only possible when nothing has ever referred to it. Otherwise it is refused with a list of what uses it, and you should set it to Discontinued instead. | manual | backend/modules/inventory/sku.service.js:405-425 |
| Changing the box number | Every PO raised after the change quotes the new box. POs already raised keep the old one. | historical **UNVERIFIED** | frontend/src/pages/Inventory/InventoryMaster.jsx:338-340 (on-screen text) |

Rules:

- **Balances are read-only**: On Hand, Reserved and Available change only through stock movements. The server rejects direct edits. _(backend/modules/inventory/inventory.routes.js:96-104)_
- **Adjustment reason must match direction**: A reason code that means a loss (for example damage) cannot be used on a stock increase, and only active reason codes are accepted. _(backend/modules/inventory/adjustment.service.js:190-205)_
- **Make and approve are split**: Inventory Manager can adjust and count but not approve adjustments; Management approves but cannot create. A counter cannot approve their own count. _(backend/config/permissions.js:303-310; inventory.routes.js:224-230)_
- **Permissions**: Open: 'View Inventory'. Add/edit SKU: 'Manage Inventory Master' (Admin, Inventory Manager, Import Team). Delete SKU and Box No: Admin only. Update stock: 'Adjust Stock' (Admin, Inventory Manager). Pricing: 'Manage Pricing'. Export: 'Export Inventory'. _(backend/config/moduleRegistry.js:308-460; backend/config/permissions.js:440-565)_
- **Brand scope**: You only see and edit SKUs of brands your account can access. _(frontend/src/pages/Inventory/InventoryMaster.jsx:494; backend/modules/inventory/sku.service.js:415)_

Requires verification:

- Whether 'Update stock' broadcasts a live refresh to other users: the stock-updated event is sent by imports and counts only; adjustments refresh just the current screen.
- Which roles canUseInventoryMaster() admits on the client was not read (utils/permissions.js).
- Approval threshold for adjustments ('Approve Adjustment') is declared but the Update stock path posts directly; whether any adjustment waits for approval requires verification.

### Inventory Health (`inventory.health`)

Routes: `/inventory/health`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Stock Ledger (balances) | one-way | On hand, reserved | Any posted movement recomputes health for the SKUs it touched | backend/utils/dualWrite.js:218-225; backend/modules/inventory/health.service.js:334 |
| Inventory Master | one-way | Lead time, consumption, safety factor, season, status | Planning saved | frontend/src/pages/Inventory/InventoryMaster.jsx:539-547 |
| Inventory Alerts (in-app notifications) | one-way | SKU, band | Health recomputed event | backend/modules/inventory/alert.subscriber.js:30; alert.service.js:222-236 |
| Weekly inventory health report (email) | one-way | Health per SKU | Weekly cron, if configured | backend/server.js:192-214; backend/modules/inventory/inventoryReport.job.js |
| Inventory Dashboard | one-way | Bands, coverage | Page load | backend/modules/inventory/dashboard.service.js:1-25 |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Changing thresholds or formula in configuration | Can reclassify thousands of SKUs at once; an alert is raised about the change. | multi | backend/config/permissions.js:316-318; alert.subscriber.js:203 |
| Stock moving (booking, adjustment, import, count) | Health for the touched SKUs is recomputed automatically. This screen shows it on next load. | automatic | backend/utils/dualWrite.js:218-225 |

Rules:

- **Inventory Alerts (no screen)**: Alerts are raised only by the system (low stock, count waiting for approval, oversold, snapshot or rebuild failures, configuration changes). They go to the in-app notification bell of users whose role the rule names. Acknowledge/resolve needs 'Manage Inventory Master' or 'Approve Adjustment'; rule changes need 'Configure Inventory'. The alerts page exists in code but is not routed. _(backend/modules/inventory/inventory.routes.js:233-262; alert.subscriber.js; alert.service.js:222-251; frontend/src/routes/index.jsx (no alerts route))_
- **Inventory snapshot**: A snapshot copies balances and health into a dated history record. It is created manually ('Configure Inventory'); the scheduled snapshot is written but not switched on in the server's cron. _(backend/modules/inventory/snapshot.service.js:331-345; backend/server.js (no snapshot cron))_
- **Who can open it**: Needs 'View Inventory'. It is hidden from the sidebar and opened from Inventory Master. _(backend/config/moduleRegistry.js inventory.health (hidden: true))_

Requires verification:

- Whether the frontend shows the 'inventory:alert' live popup: the server emits it, but no frontend listener was found; the alert appears in the notification bell on fetch.

### Upcoming Stock (`inventory.health.upcoming`)

Routes: `/inventory/upcoming`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Stock Ledger | one-way | Positive receipt, opening, adjustment or count movements after the line was loaded | Page load (sync runs on read) | backend/modules/inventory/upcomingStock.service.js:13-23, 191 |
| Inventory Master | one-way | On hand | Stock-updated socket event | frontend/src/pages/Inventory/UpcomingStock.jsx:565 |
| Indent Stock Assignment | one-way | Open indents (Pending, Partially Confirmed) | Page load | backend/modules/inventory/upcomingStock.service.js:25-37, 60 |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Stock arriving through import, Update stock or a count | Reduces the matching shipment lines, earliest ETA first. | automatic | backend/modules/inventory/upcomingStock.service.js:103-165 |
| Stock decreasing | Never puts quantity back onto shipment lines. | historical | backend/modules/inventory/upcomingStock.service.js:15-17 |
| Importing, editing or cancelling shipments | Recorded in the audit log. No email, notification or booking change. | manual | backend/modules/inventory/upcomingStock.service.js:32-35, 734, 866, 919 |

Rules:

- **Internal analysis only**: Since 2026-10-22 nothing here reserves stock, changes an indent or emails a customer. _(backend/modules/inventory/upcomingStock.service.js:25-37)_
- **Permissions**: View needs 'View Inventory'. Import and correct lines need 'Manage Inventory Master' (Admin, Inventory Manager, Import Team). _(backend/modules/inventory/inventory.routes.js:350-357)_
- **Only later arrivals count**: A shipment line only receives stock that arrived after the line was loaded. Returns from bookings and location transfers do not count. _(backend/modules/inventory/upcomingStock.service.js:18-23, 134)_

Requires verification:

- Whether IndentReservationSection on this page still offers any action button; no reserve endpoint exists on the server.

### Stock Ledger (`inventory.ledger`)

Routes: `/inventory/ledger`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Create Booking / Sales Desk | one-way | Reserve, release, consume movements with the booking reference | Booking confirmed, edited, cancelled, PO raised, 7-day PO deadline (hourly job) | backend/utils/stockLedger.js:46-120; backend/utils/stockSettlement.js; backend/server.js:164 |
| Inventory Master | one-way | Adjustment movements | Update stock saved | backend/modules/inventory/adjustment.service.js:214 |
| Inventory Import | one-way | Movements per row | Import confirmed | backend/modules/inventory/import.service.js:1190-1244, 1270-1384 |
| Inventory Health and Dashboard | one-way | Balances | Movement posted | backend/utils/dualWrite.js:207-225 |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Booking confirmation | Stock is first moved on the product (available to booked) inside the booking transaction. The ledger movement is queued and posted only after the booking commits; then balances and health update. If the ledger is slow or down, the booking still succeeds and the gap shows in reconciliation. | multi | backend/utils/transaction.js:20-30, 73; backend/utils/ledgerDeferral.js; backend/utils/dualWrite.js:8-27, 33-75 |
| Import or count posted | A live 'stock updated' signal makes open Inventory Master, Upcoming Stock and the customer Inventory screen re-read. | automatic | backend/utils/stockEvents.js:14-30; import.service.js:1258, 1400; count.service.js:540; frontend InventoryMaster.jsx:473, UpcomingStock.jsx:565, Inventory.jsx:87 |

Rules:

- **Read-only**: No screen or API writes to the ledger directly. Movements cannot be edited or deleted; corrections are new movements or reversals. _(backend/modules/inventory/inventory.routes.js:124-128; sku.service.js:260)_
- **Whole numbers only**: Quantities must be whole, non-zero numbers of a known movement type. _(backend/modules/inventory/ledger.service.js:66-110)_
- **Who can open it**: Needs 'View Stock Ledger': Admin, Inventory Manager, Warehouse User, Management, Import Team. Sales does not have it. _(backend/config/permissions.js:440-565)_
- **Balance rebuild**: Balances can be rebuilt from the ledger and checked by a reconciliation report; both need 'Configure Inventory' (Admin). _(backend/modules/inventory/inventory.routes.js:136-140)_

Requires verification:

- Exact list of movement types shown in the Movement Type filter (from StockMovement model) was not copied here.

### Brands (`inventory.brands`)

Routes: `/inventory/brands`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| User Management (brand access) | two-way | Brand access flags on users | Brand created or deleted (flags cleared) | backend/modules/inventory/brand.controller.js:77-83, 151, 192-194 |
| Inventory Master and product catalogue | one-way | Brand name and key | Brand list reloaded | backend/utils/brandAccess.js:31-37 |
| Employee Portal | two-way | Brand list | Periodic reload | backend/utils/brandRegistry.js:12-24; brand.controller.js:28-31 |
| Inventory Dashboard | one-way | None | Any brand save | backend/modules/inventory/brand.controller.js:96-99 |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Adding a brand | Appears at once in every brand list in this portal; open browsers are told to refresh (brands:updated). An audit entry is written. | multi | backend/modules/inventory/brand.controller.js:160-170 |
| Changing Hidden from MSIL | MSIL customers stop (or start) seeing that brand's products immediately. | automatic | backend/modules/inventory/brand.controller.js:197-220; backend/utils/brandAccess.js:10-12 |
| Deleting a brand | Refused if any product, order, movement, balance, count, alert, snapshot, import or product detail names it. On success the brand flag is removed from every account. | manual | backend/modules/inventory/brand.controller.js:41-75, 233-275 |

Rules:

- **Brands are never renamed**: The name is stored on every product, order and movement. Fix a mistake by deleting (if unused) and creating again. _(backend/models/Brand.js:11-15)_
- **Admin only**: Needs 'Configure Inventory', held only by Admin unless granted. _(backend/config/moduleRegistry.js inventory.brands; backend/config/permissions.js:316-318)_

### Indent Stock Assignment (`inventory.indent_assignment`)

Routes: `/inventory/indent-assignment`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Sales Desk | two-way | New or updated booking lines with allocations, quantities and PO number | Assign, Auto-assign, Move to…, or Cancel allocation in the booking drawer | backend/modules/inventory/indentAvailability.service.js:443 (allocateToBooking); frontend/src/components/drawer/SalesBookingDrawer.jsx:1730 |
| Indent History | two-way | Indent quantity and status (Pending / Partially Confirmed / Confirmed) | Any assignment reduces the indent; reassign and cancel give units back | backend/modules/inventory/indentAssignment.service.js:84, 382-405, 504-524 |
| Stock Ledger | one-way | RESERVE / RELEASE / ISSUE / ADJUSTMENT movements tied to the booking | Assign, reassign, cancel | backend/utils/stockLedger.js:46,84,184; indentAvailability.service.js:452 |
| Inventory Import / stock postings | one-way | SKUs received and quantities | Import confirm, stock adjustment, stock count, booking cancel, PO expiry job, MSIL supply date change | import.service.js:1255; adjustment.service.js:250; count.service.js:539; orders/order.controller.js:778; orders/poExpiryJob.js:297; sales/msilSupply.service.js:117 |
| Upcoming Stock | one-way | Arrived quantities only | Start of every indent pass | indentAvailability.service.js:975-985; upcomingStock.service.js:186 (syncUpcoming, no allocation calls) |
| MSIL Supply Date (Sales Desk) | two-way | Supply check status | Assigning an indent marked Awaiting decision | indentAssignment.service.js:259-268; utils/msilSupply.js |
| Inventory Configuration | one-way | Assignment mode setting | Mode button | frontend/src/services/inventory.js:84; inventory.routes.js:363 (configure_inventory) |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Assigning or Auto-assigning stock | Stock is reserved; the units are added to the customer's booking (a new line is created if the SKU was not on it, at the booking's price tier); the indent's waiting quantity goes down. | multi | indentAvailability.service.js:443-640 |
| Assigning or Auto-assigning stock | The customer gets an in-app notice and an email (copied to their booking CC list, the company copy addresses and the staff member who placed the booking). The Support Team gets its own copy, even if the customer turned email off. | automatic | indentAvailability.service.js:658-745; utils/indentMail.js:488 |
| Move to… (reassign) | Stock is released from the first booking and reserved on the second. The first indent waits for those units again. If the second step fails, the units are put back. | multi | indentAssignment.service.js:302-449 |
| Cancel inward allocation | The allocation is kept but marked Cancelled with who, when and why. Stock returns (released, or returned to stock if a PO had already taken it). The indent waits again unless the desk had cancelled it. The oldest-first pass is NOT re-run. | multi | indentAssignment.service.js:451-559 |
| Switching to held mode | Arriving stock is no longer assigned by itself. Customers are still emailed that material came in against their indent. | automatic | indentAvailability.service.js:1007-1015, 1110-1112 |
| Any action on this screen | Written to the audit log with the user: 'Indent Stock Auto-Assigned', 'Indent Stock Assigned', 'Indent Stock Reassigned', 'Inward Allocation Cancelled'. | historical | indentAssignment.service.js:44-53, 209, 270, 425, 534 |

Rules:

- **Permission**: Needs the 'Assign indent stock' permission, held by Sales and Import Team (and Admin / Super Admin). Changing the mode needs 'Configure inventory', which only Admin holds by default. _(backend/config/permissions.js (Sales, Import Team); inventory.routes.js:341-345, 363)_
- **Default is automatic**: If no mode was ever set, stock goes to the oldest indent by itself. _(inventory/config.service.js:59-61)_
- **No over-allocation**: You cannot assign more than the indent is waiting for or more than is free. The stock write itself is guarded, so two people clicking at once cannot both take the same units. _(indentAssignment.service.js:232-240; stockLedger.js:46)_
- **Reassign only before the PO**: Once any line of the booking has a PO, its stock is committed and cannot be moved. Same SKU only. _(indentAssignment.service.js:316-321)_
- **Cancel only at 'PO Received'**: Allocations already picked or dispatched cannot be cancelled. A second cancel of the same allocation is refused. _(indentAssignment.service.js:470-500)_
- **MSIL late arrivals are held**: For MSIL customers with a Supply Date, stock arriving after that date or more than 7 days after the booking is not converted automatically; the indent shows 'Awaiting decision'. _(utils/msilSupply.js; indentAvailability.service.js:1075-1106)_
- **Scheduled indents wait**: An indent scheduled for a later date is skipped by the automatic pass. _(indentAvailability.service.js (scheduledForLater in processAvailableIndents))_

Requires verification:

- Whether the live Sales and Import Team role records already contain the 'Assign indent stock' permission requires verification (the role baseline must be applied to the database).

### Inventory Import (`inventory.imports`)

Routes: `/inventory/import`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Stock Ledger | one-way | OPENING (new SKU), RECEIPT (positive), ADJUSTMENT with reason MANUAL_ADJUSTMENT (negative), COUNT with COUNT_SURPLUS / COUNT_SHORTAGE (fresh inventory) | Confirming the import | import.service.js:1190-1226, 1343-1364 |
| Indent Stock Assignment | one-way | SKUs and units received | End of a stock import | import.service.js:1255, 1397; indentAvailability.service.js:968 |
| Customer emails (material inward) | one-way | Indent lines, received and available quantity | Positive quantities in a stock import | indentAvailability.service.js:769-866; utils/indentMail.js:419 (sendMaterialInwardMails) |
| Upcoming Stock | one-way | Arrived quantity | Stock import posting | indentAvailability.service.js:975-985 |
| Inventory Master / Product Catalogue | one-way | Product records and available-for-sale figure | Confirming the import | import.service.js:1379-1383 (syncLegacyStock), 859, 1620 |
| Product Details | one-way | Description and video links | Product Details import | import.service.js:1463-1519 |
| MSIL code list | one-way | MSIL codes | Inventory Master import | import.service.js:1057-1065; utils/msilRegistry.js |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Confirming a stock import | Stock moves through the ledger, stock health is recalculated, available-for-sale updates, and open screens get a live 'stock updated' signal. | multi | import.service.js:1376-1400; utils/stockEvents.js (inventory:stock-updated) |
| Confirming a stock import with positive quantities | Waiting indents may be booked automatically and customers emailed (copy to Support Team and the staff member who raised the indent). | multi | indentAvailability.service.js:827-833 |
| Confirming any import | Audit log gets 'Inventory Import Confirmed' and 'Inventory Import Processed' with row counts. | historical | import.service.js:1797, 1937 |
| Fresh Inventory Import | Replaces the stock figure. A row of 155 on a SKU holding 5 ends at 155. | automatic | import.templates.js:283-320 |

Rules:

- **Who can run which sheet**: Inventory Master, Fresh Inventory, Planning and Product Details need 'Manage inventory master'. SKU Pricing needs 'Manage pricing'. Anyone with 'View inventory' can open the page and see history. _(import.templates.js:234,290,347,383,459; inventory.routes.js:278-307)_
- **Price rows are private**: The preview and error report of a SKU Pricing import are visible only to people who may run that import. _(import.templates.js:466; import.controller.js:50-63)_
- **Box numbers**: Changing an existing SKU's box number needs the 'Manage box number' permission (Admin only). A new SKU may get its first box from the sheet. _(import.templates.js:169-201; permissions.js notes)_
- **Rows checked before writing**: Every row is validated first. Nothing is written until you confirm. MSIL Code, if given, must match the SKU. _(import.service.js:1768-1803; import.templates.js (verifyMsil))_
- **Stock floor**: A negative quantity can reduce stock only to zero and never below units already reserved for bookings. _(import.templates.js:250-258 (note))_
- **Brand**: A new SKU in the Inventory Master sheet takes the brand chosen on the upload form. _(import.templates.js:241-245)_

Requires verification:

- Whether the Planning and SKU Pricing processors write any audit row beyond the job-level entries was not traced line by line (SKU pricing records which tiers changed, not amounts, per skuPricing.service.js:101).

### Product Details (`inventory.product_content`)

Routes: `/admin/product-details`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Product Catalogue | one-way | Description, images, videos | Customer or staff opens a product | frontend/src/components/inventory/DetailsDrawer.jsx; pages/Inventory/Inventory.jsx:13; productDetail.routes.js:70 |
| Inventory Import | one-way | Description, video links | Product Details import | import.service.js:1463-1519 |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Saving text or uploading images | Change is live immediately in the Product Catalogue slide-over for every user who can see that brand. | automatic | productDetail.routes.js:52-70 |
| Any change | Audit log gets 'Product Details Updated', 'Product Images Uploaded' or 'Product Images Updated'. | historical | productDetail.service.js:218-391 |

Rules:

- **Permission**: Needs 'Manage inventory master', held by Inventory Manager, Import Team and Admin. Reading the content is open to every signed-in user, limited to brands they can see. _(moduleRegistry.js product_content; productDetail.routes.js:38-90)_
- **Limits**: Images: 12 per SKU, 5 per upload, 5 MB each. Description up to 8,000 characters. Up to 6 YouTube videos. _(productDetail.rules.js:28-34, 157, 180)_

Requires verification:

- Product content is not shown on booking screens (Create Booking, Booking Review): no use of the product-details API was found there.

## Administration

### Admin Control Panel (`administration.overview`)

Routes: `/admin`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Customer Management | one-way | Navigation only | User clicks the tile | CP frontend/src/pages/Admin/Admin.jsx:13-18 |
| Internal User Management | one-way | Navigation only | User clicks the tile | CP frontend/src/pages/Admin/Admin.jsx:19-24 |
| Roles & Permissions | one-way | Navigation only | User clicks the tile | CP frontend/src/pages/Admin/Admin.jsx:30-37 |
| Product Details | one-way | Navigation only | User clicks the tile | CP frontend/src/pages/Admin/Admin.jsx:38-43 |

Rules:

- **Who can open it**: Needs the 'Manage Users' or 'Manage Roles' permission. Super Admin and Admin hold everything. Sales does not see this page; Sales reaches Customer Management directly from the sidebar. _(CP backend/config/moduleRegistry.js:868-890 (administration.overview view: manage_users, manage_roles); CP frontend/src/routes/index.jsx:110-111)_
- **Customer Portal only**: The Employee Portal has no /admin route; its administration screens are opened from the sidebar. _(EP frontend/src/routes/index.jsx:160-178 (only admin/users and admin/permissions mounted))_

Requires verification:

- The tiles for Customer Management, Internal User Management, Product Details and Inventory are shown to everyone who can open the page. Each target screen checks its own permission, so a tile can lead to an access-denied page.

### Customer Management (`administration.customers`)

Routes: `/admin/customers`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Create Booking (booking on behalf) | one-way | Active Customer accounts: name, company, category, brand access, MOQ, MSIL code setting, addresses | Customer picker search on Create Booking | CP backend/modules/users/user.controller.js:164-191 (searchCustomers: role Customer, status Active); CP frontend/src/pages/Admin/Settings/UserManagement.jsx:199-210,492-494 (returnTo + customer id) |
| Bookings on every booking screen | one-way | Customer Name, company, contact, phone, location, shop, vendor, GST, category, addresses are read live from the customer account | Any screen that loads bookings | CP backend/utils/customerContact.js:66-91 (attachCustomerDetails) |
| Booking emails | one-way | Booking CC Emails stored on the customer account | Booking emails sent by the booking modules | CP backend/utils/bookingRecipients.js:42-47; CP backend/models/User.js:174 |
| Login | one-way | Account status | Sign-in or any request with an old token | CP backend/modules/auth/auth.controller.js:173-183; CP backend/middlewares/auth.js:25-26 |
| Audit log | one-way | Actor, action name, target | Saving on this screen | CP backend/modules/users/user.routes.js:43-53 (auditLogger) |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Editing a customer's address or brand access | Applies to new bookings. Existing bookings keep the address they were made with; the picklist already issued is unchanged. | historical | CP backend/modules/users/user.controller.js:52-68 (addresses snapshotted on Order rows) |
| Filling in a missing Customer Master detail | Shows on every past and future booking of that customer, because booking screens read the customer profile live. | automatic | CP backend/utils/customerContact.js:6-15,66-91 |
| Suspending a customer | The account leaves the active users list. The customer cannot sign in and current sessions are refused. Sales can no longer book on their behalf. Their existing bookings and indents are not changed or cancelled; booking screens fall back to the details saved on each booking. | multi | CP backend/modules/users/user.controller.js:393-407 (archive + delete from users); CP backend/middlewares/auth.js:22,25; CP backend/utils/customerContact.js:76-78 |
| Restoring a suspended customer | The account is recreated with its original id, so its bookings link back to it. | automatic | CP backend/modules/users/user.controller.js:410-428 |

Rules:

- **Who can use it**: Needs 'Manage Customer Users' (held by Sales) or 'Manage Users' (Super Admin, Admin). Sales can only see and change Customer accounts. _(CP backend/config/moduleRegistry.js:914-927; CP backend/modules/users/user.controller.js:127-135 (denyIfOutOfScope); EP backend/config/permissions.js BASELINE Sales: MANAGE_CUSTOMER_USERS)_
- **Master details are locked after creation**: Customer Name, Phone, Location, Shop, Vendor and GST numbers cannot be edited on a live account. The save is refused rather than silently ignored. _(CP backend/modules/users/user.controller.js:36-50)_
- **Unique email**: An email already used by a live or suspended account is refused. _(CP backend/modules/users/user.controller.js:266-279,351-357)_
- **Category values**: Only MSIL or Customer are accepted. _(CP backend/modules/users/user.controller.js:288,344-346)_
- **No role changes or extra access for Sales**: Changing an account's role and granting extra per-account access are for full administrators only. _(CP backend/modules/users/user.controller.js:475-490,545-552)_
- **Cannot suspend yourself**: Suspending your own account is refused. _(CP backend/modules/users/user.controller.js:363-367)_

Requires verification:

- MOQ and Booking CC Emails are stored on the customer account but are not in the list of fields this screen can update. Where are they set? (Possibly migration/import scripts only.)
- Nothing on this screen permanently deletes a customer; the 'delete' permission cell gates no action yet.

### Internal User Management (`administration.users`)

Routes: `/admin/users`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Roles & Permissions | one-way | Role name on the account | Saving a role change | CP backend/utils/roleResolver.js:338-344 (permissions resolved from user.role on every request) |
| HRMS employee records | one-way | HRMS roles on the account | Changing an account's role | CP backend/modules/users/user.controller.js:491-498 (denyIfRoleCombinationInvalid) |
| Other portal | two-way | Staff accounts | Any save in either portal | CP and EP backend/models/User.js identical; EP frontend/src/routes/index.jsx:160-172 |
| Audit log | one-way | Create, update, role, password, access actions | Saving | EP backend/modules/users/user.routes.js:49-58 |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Changing a person's role | Their menus and allowed actions change on their next page load in both portals. No re-login is needed because access is worked out on each request. | automatic | CP backend/middlewares/rbac.js:65; CP backend/utils/roleResolver.js:338 |
| Suspending a staff account | They are refused on the next request in both portals. Work assigned to them (Work Queue tasks, O2D stages) is not reassigned automatically. | manual **UNVERIFIED** | CP backend/middlewares/auth.js:22-26 |

Rules:

- **Who can use it**: Opening needs 'Manage Users'. Creating needs 'Create Users', editing needs 'Edit Users'. Super Admin and Admin hold all of these; Sales does not. _(CP backend/config/moduleRegistry.js:929-958; EP backend/modules/users/user.routes.js:45-58)_
- **Customer Portal checks per target**: In the Customer Portal, which accounts you may create or edit is checked against the account type: Customer accounts need the Customer Management permission, staff accounts need the Internal User Management permission. _(CP backend/modules/users/user.controller.js:110-135)_
- **Extra access: admins only**: Only full administrators who can also manage roles see the Access button. _(CP frontend/src/pages/Admin/Settings/UserManagement.jsx:241,760)_
- **Each portal edits only its own extra grants**: In the Customer Portal, extra grants for Employee Portal modules are kept as stored and cannot be changed from there. _(CP backend/modules/users/user.controller.js:556-619 (mergeServedGrants, normaliseExtraGrants))_

Requires verification:

- Permanent erase of an employee is done in HRMS (employee record), not on this screen. Its effect on the login account requires verification. (EP backend/modules/hrms/employees/employee.routes.js:144)
- Whether open Work Queue or O2D work moves when a staff account is suspended was not traced.

### Roles & Permissions (`administration.roles.customer`)

Routes: `/admin/permissions`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Roles & Permissions (Employee Portal) | two-way | Role grants; Employee Portal cells are kept as stored on every save here | Saving a role | CP backend/utils/portalGrants.js:1-60 (mergeServedGrants); CP backend/modules/roles/role.controller.js:240-250 |
| Every Customer Portal screen | one-way | Role grants | Saving; periodic 60-second reload | CP backend/server.js:124-125 |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Saving a role | Only Customer Portal cells change. Employee Portal ticks on the same role are kept exactly as stored. This portal reloads roles before replying; the Employee Portal picks up the change only when its own role list next reloads. | multi | CP backend/utils/portalGrants.js (normaliseRoleSave); CP backend/modules/roles/role.controller.js:252-253 |

Rules:

- **Who can use it**: Only Super Admin and Admin in practice: the role-management permissions belong to an Employee Portal screen, so this portal removes them from everyone else. _(CP backend/modules/roles/role.routes.js:30-50; CP frontend/src/pages/Admin/Settings/RolesPermissions.jsx:142)_
- **Customer Management cell is narrowed**: Ticking Customer Management stores only 'Manage Customer Users', never full user administration. _(CP backend/utils/portalGrants.js NARROWED_CELLS)_
- **Derived cells**: New Booking View, Bulk Upload View and Admin Panel View cannot be changed here; they follow other access. _(CP backend/utils/portalGrants.js DERIVED_CELLS)_
- **Same protections as the Employee matrix**: Full-access flag only by a Super Admin; built-in roles cannot be renamed or deleted; roles in use cannot be deleted; Customer role stays fenced. _(CP backend/modules/roles/role.controller.js:140-330)_

Requires verification:

- The route is not wrapped in the sidebar module guard; the page itself checks role-management access. Confirm non-admins see an access message rather than a blank page.

## FMS: Order to Dispatch

### My Tasks (`o2d.tasks`)

Routes: `/fms/o2d/tasks`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Work Queue: Checklist and Delegation | two-way | One task per open stage: a team Checklist task for the owning role, or a personal task when a person is assigned. Completing it from the Work Queue completes the real stage. | Stage unlocks, is assigned, completed, skipped, held | EP backend/modules/o2d/stage.engine.js:220-224 (ensureStageTask on unlock); EP backend/modules/o2d/stageMirror.service.js:1-30,159; EP backend/modules/checklist/checklist.controller.js:20,43-72 |
| Executive Scoreboard | one-way | Stage task completion times | Completing the stage task | EP backend/modules/scoreboard/scoreboard.controller.js:16-18,272 |
| O2D bell (in-app notifications) | one-way | Unlocked, due soon, overdue, escalated | Stage events and the 5-minute sweep | EP backend/modules/o2d/notification.service.js:1-30; EP frontend/src/pages/O2d/O2dBell.jsx |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Completing a stage | The next stage unlocks with a new deadline, its owner gets a task and a notification, and the Work Queue copy of this stage is marked done. | multi | EP backend/modules/o2d/stage.engine.js:260,461 |
| Leaving a stage past its deadline | The 5-minute sweep sends an overdue alert to the owner, and after a grace period escalates to the stage's escalation role (Management by default). | automatic | EP backend/modules/o2d/escalation.service.js:100-160; EP backend/modules/o2d/notification.service.js:144; EP backend/server.js:255-260 |

Rules:

- **Who sees it**: Needs 'View O2D'. By default held by Sales, Billing, Accounts, Billing Head, Warehouse User, Management and Import Team. The list only shows stages your role owns or may complete. _(EP backend/config/moduleRegistry.js:628-635; EP backend/config/permissions.js BASELINE_ROLE_PERMISSIONS; EP backend/modules/o2d/task.service.js:1-40)_
- **Completing needs 'Work O2D Stage'**: Held by Sales, Billing, Accounts, Billing Head and Warehouse User. Import Team and Management can view but not complete. _(EP backend/modules/o2d/o2d.routes.js:84,194-199)_
- **Working hours**: Deadlines count working time only (default 10:30 to 18:30, Monday to Saturday), except stage 5 which uses calendar days. _(EP backend/shared/constants/o2d.js:247-293; EP backend/config/seedO2dStages.js:102-111)_

Requires verification:

- Background sweeps (reminders, escalations, daily summary, invoice retry) run only when the Employee Portal server has O2D_CRON=enabled. Production setting not checked.
- WhatsApp and email notifications are off unless O2D_WHATSAPP_ENABLED / O2D_EMAIL_ENABLED are set; in-app is on by default. Production settings not checked.

### Order Tracker (`o2d.orders`)

Routes: `/fms/o2d/orders`, `/fms/o2d/orders/new`, `/fms/o2d/history`, `/fms/o2d/exits`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Customer Portal bookings | one-way | Booking lines grouped by booking number are read; nothing is written back to the booking | Picking a booking on New Order | EP backend/modules/o2d/booking.service.js:1-40; EP backend/modules/o2d/o2d.routes.js:122-135 |
| Work Queue (Checklist / Delegation) | two-way | Task per stage, held/released with the order | Unlock, assign, complete, skip, hold, reopen | EP backend/modules/o2d/stageMirror.service.js:1-40; EP backend/modules/o2d/o2dDelegationSync.service.js:1-25; EP backend/modules/o2d/stage.engine.js:224,461,520,703,870 |
| Zoho Books | two-way | Invoice number and status | Raise invoice button; Zoho webhook; hourly retry of failed invoices | EP backend/modules/o2d/invoicing.service.js:58-67,178,224; EP backend/modules/o2d/o2d.routes.js:79,277; EP backend/server.js:281 |
| Notifications (in-app, email, WhatsApp) | one-way | Order created, stage unlocked / due soon / overdue / escalated, held, resumed, closed, cancelled | Stage engine events and the sweep | EP backend/shared/constants/o2d.js:357-374; EP backend/modules/o2d/notification.service.js; EP backend/modules/o2d/channels/* |
| Delay Analytics | one-way | Stage status and timings | Completing stages | EP backend/modules/o2d/analytics.service.js; EP backend/shared/constants/o2d.js:103-106 |

| Action | Effect | Kind | Evidence |
|---|---|---|---|
| Creating an order | Twelve stage rows are created; stage 1 opens and its owner gets a task and notification. | multi | EP backend/modules/o2d/stage.engine.js:123 |
| Putting an order on hold | Deadlines pause and the order's Work Queue tasks are held. Resuming releases them. | multi | EP backend/modules/o2d/stage.engine.js:804,870,902 |
| Cancelling or voiding | The order leaves the tracker and appears in the Exit Register. The record and its stages are kept. | historical | EP backend/config/moduleRegistry.js:646-647; EP backend/modules/o2d/o2d.routes.js:232-237 |
| Creating an O2D order from a booking | The booking itself is not changed; it stops appearing in the booking picker while a live O2D order uses it. | historical | EP backend/modules/o2d/booking.service.js:13-21,42-44 |

Rules:

- **Create an order**: Needs 'Create O2D Order'. By default only Sales (and admins). _(EP backend/modules/o2d/o2d.routes.js:83,140; EP frontend/src/routes/index.jsx:197-202)_
- **Complete, assign, raise invoice**: Needs 'Work O2D Stage' (Sales, Billing, Accounts, Billing Head, Warehouse User). The server also checks your role against the stage owner. _(EP backend/modules/o2d/o2d.routes.js:84,194-220,277)_
- **Hold and resume**: Needs 'Hold O2D' (Billing Head, Management). _(EP backend/modules/o2d/o2d.routes.js:85,221-222)_
- **Cancel, void, revive**: Needs 'Exit O2D' (Billing Head, Management). _(EP backend/modules/o2d/o2d.routes.js:86,235-237)_
- **Reopen and overrides**: Needs 'Override O2D' (Billing Head, Management). _(EP backend/modules/o2d/o2d.routes.js:87,200-205)_
- **One invoice per order**: The Zoho invoice uses a fixed key per order so retries never create a second invoice. _(EP backend/modules/o2d/invoicing.service.js:1-30,58)_

Requires verification:

- Zoho integration is active only when O2D_ZOHO_ENABLED=enabled on the Employee server; production setting not checked.
- In the Customer Portal these screens call the Employee Portal server; they are hidden if that server's address is not configured, and the Customer Portal's web address must be allowed by the Employee server (CORS).

### Stages (`o2d.stages`)

Routes: `/fms/o2d/stages`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Order Tracker | one-way | Live orders and stage status | Opening the screen | EP backend/modules/o2d/o2d.routes.js:108-117; EP frontend/src/pages/O2d/StagesTab.jsx |

Rules:

- **Who sees it**: Needs 'View O2D'. What each person sees is narrowed by role on the server. _(EP backend/config/moduleRegistry.js:652-662)_

### Analytics (`o2d.analytics`)

Routes: `/fms/o2d/analytics`

| Connected to | Direction | Exchanged | Trigger | Evidence |
|---|---|---|---|---|
| Order Tracker / My Tasks | one-way | Stage status and timings | Opening the screen | EP backend/modules/o2d/analytics.service.js:94-475; EP backend/shared/constants/o2d.js:103-106 |
| Daily summary email | one-way | Open, overdue and summary counts | Daily scheduled job | EP backend/modules/o2d/escalation.service.js:259,286; EP backend/modules/o2d/notification.service.js:70,104,116; EP backend/server.js:271-278 |

Rules:

- **Who sees it**: Needs 'View O2D Analytics', held by default by Billing Head and Management. The tab is hidden from others. _(EP backend/modules/o2d/o2d.routes.js:91,250-264; EP frontend/src/pages/O2d/O2dPage.jsx:89-91)_
- **Held time excluded**: Time an order spent on hold is not counted as delay. _(EP backend/shared/constants/o2d.js:73-76)_

Requires verification:

- The registry calls this screen 'Delay Analytics'; the tab in the app is labelled 'Analytics'.
