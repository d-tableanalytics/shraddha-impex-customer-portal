# Shraddha Impex Customer Portal — Complete Architecture Analysis

> Target system: `./shraddha-impex-customer-portal`
> Status: **analysis only**. Nothing in this repository was modified.
> Traced from source: `app.js`, `server.js`, every route file, every model, both `rbac` implementations, the frontend router, stores, services and component tree.

---

## 0. Executive snapshot

| Fact | Value |
|---|---|
| Product | Shraddha Impex ERP — customer booking portal + Inventory Management System (IMS) |
| Repo layout | **Two sibling folders, no monorepo tooling** — `backend/` and `frontend/` each have their own `package.json`; **no root `package.json`** |
| Language | **JavaScript (ESM)** throughout — `.js` backend, `.jsx` frontend. No TypeScript |
| Backend | **Node.js + Express 4**, Mongoose 8, **MongoDB** |
| Frontend | **React 19 + Vite 8 + Tailwind CSS 4** |
| Auth | JWT (single token, `1d` default), bcryptjs — **with a plaintext-password fallback still live** |
| Authorization | Flat string permissions, `role → permission[]`, `Admin: ['*']` |
| Real-time | **Socket.IO 4** with JWT handshake + per-user rooms |
| Tenancy | **Single tenant.** No `organization` concept anywhere |
| Data model | **31 Mongoose models** (29 files; `Product.js` exports 3) |
| API surface | **~128 Express routes** |
| Backend size | ~31,300 LOC (`backend/**/*.js`, excl. node_modules) |
| Frontend size | ~23,600 LOC (`frontend/src`) |
| Deployment | EC2 + nginx (static SPA from `frontend/dist`) + **PM2** (`shraddha-backend` on :4000) |
| Domain | Bookings/indents, product catalogue (3 brands), reservations, sales desk, inventory (10 IMS modules) |
| **HR functionality** | **None. Zero.** |

---

## 1. Repository structure

```
shraddha-impex-customer-portal/
├── (no root package.json — two independent npm projects)
├── ecosystem.config.cjs        # PM2: one app, backend only, 400M cap
├── index.html, index.js, script.js, *-preview.html   # stray root artifacts (see §7)
├── deploy/
│   ├── nginx/shraddha-impex-app.conf     # SPA + /api proxy + /socket.io proxy
│   ├── nginx/shraddha-impex.conf         # server block (certbot-managed)
│   └── README.md
├── docs/                       # 8 .xlsx/.docx business documents (no dev docs)
├── test-sheets/
├── .github/workflows/          # ci.yml, deploy.yml
├── backend/
│   ├── .env                    # 11 keys, committed
│   ├── server.js               # HTTP + Socket.IO + seeds + cron + boot
│   ├── app.js                  # Express app, middleware, route mounting
│   ├── config/                 # database.js + 3 seeders
│   ├── middlewares/            # auth, rbac, auditLogger, errorHandler, importUpload
│   ├── models/                 # 29 Mongoose schema files
│   ├── modules/                # 9 feature folders
│   ├── routes/api.routes.js    # legacy catch-all router
│   ├── scripts/                # 18 migration/verification scripts (~5,700 LOC)
│   └── utils/                  # 24 helpers (~2,900 LOC)
└── frontend/
    ├── vite.config.js          # plugins:[react()] only — NO dev proxy, NO alias
    ├── tailwind.config.js      # primary/success/error/warning/enterprise palettes
    ├── jsconfig.json, .oxlintrc.json, vercel.json, postcss.config.js
    └── src/
        ├── App.jsx, main.jsx, index.css
        ├── routes/index.jsx    # createBrowserRouter, all pages lazy
        ├── components/         # ui/ (23), layout/ (8), + 10 domain folders
        ├── pages/              # 20 page files in 13 folders
        ├── services/           # 10 API modules + socketService
        ├── store/              # 18 Zustand stores
        ├── hooks/, utils/, constants/, types/
```

**No shared package between backend and frontend.** `backend/middlewares/rbac.js` and `frontend/src/utils/permissions.js` are **hand-maintained mirrors**, and the frontend file says so in its own header comment.

---

## 2. Backend architecture

### 2.1 Bootstrap — `server.js`

```
connectDatabase()                 → mongoose.connect(MONGODB_URI)
seedDefaultRoles()                → seeds Role collection when empty
seedInventoryDefaults()           → default stock Location + InventoryConfig
seedAlertRules()                  → one rule per alert type (idempotent per type)
subscribeAlerts()                 → binds the alert engine to the event bus
sweepUploads()                    → clears orphaned import files
runReservationExpiryChecks()      → initial pass
runPoSettlement()                 → consume/release stock behind confirmed bookings
cron.schedule('0 0 * * *', …)     → the three jobs above, daily at midnight
server.listen(PORT)
```

Also in `server.js`: the **Socket.IO server**. The handshake verifies the same JWT as the REST API; a valid user joins `user:<id>` and, if `role === 'Admin'`, also `admins`. An invalid token still connects but joins no rooms, so it silently receives nothing. An event-bus bridge (`NOTIFICATION_CREATED`) is the **only** place sockets and the alert engine meet — deliberately, so no module has to import `io`.

Process handlers: `uncaughtException` → `process.exit(1)`; `unhandledRejection` → graceful close. PM2 restarts with a 4s backoff, max 10.

### 2.2 Express app — `app.js`

```
app.set('trust proxy', 1)      // real client IP behind nginx
helmet()
cors({ origin: FRONTEND_URL || http://localhost:5173, credentials: true })
compression()
express.json({ limit: '10mb' })
express.urlencoded({ extended: true, limit: '10mb' })
cookieParser()
morgan('dev')                  // non-production only
```

Route mounting:
```
/api/v1/auth           → modules/auth/auth.routes.js
/api/v1/users          → modules/users/user.routes.js
/api/v1/products       → modules/products (inventoryRouter)
/api/v1/products/:brand→ modules/products/product.routes.js
/api/v1/orders         → modules/orders/order.routes.js
/api/v1/reservations   → modules/reservations/reservation.routes.js
/api/v1/notifications  → modules/notifications/notification.routes.js
/api/v1/roles          → modules/roles/role.routes.js
/api/v1/sales          → modules/sales/sales.routes.js
/api/v1/inventory      → modules/inventory/inventory.routes.js
/api                   → routes/api.routes.js       (legacy)
/api/v1                → routes/api.routes.js       (same router, mounted twice)
/health                → inline
404 handler → errorHandler
```

> **Rate limiting is deliberately absent.** `app.js` carries an explicit comment: a single page load costs several requests, and any per-IP ceiling tight enough to matter locked real users out mid-task. **Nothing throttles `/api`, including login.** `express-rate-limit` is installed but unused.

### 2.3 Module inventory (9 modules, ~18,400 LOC)

| Module | LOC | Routes | Contents |
|---|---:|---:|---|
| **inventory** | **13,283** | 88 | 30 files: master, categories, locations, config, balance, ledger, health, dashboard, adjustments, counts, alerts (+subscriber), import (parser/templates/service), export, reports, snapshots, reconciliation, consumption, indentAvailability, boxNumber rules |
| reservations | 1,535 | 9 | Cart reservations, backorders, indent scheduling, expiry job |
| orders | 1,472 | 10 | Booking lifecycle, status events, PO expiry job |
| sales | 961 | 4 | Sales desk — view all bookings, edit pre-PO, raise PO |
| products | 521 | 2 | 3-brand catalogue |
| users | 372 | 5 | Account CRUD, role assignment, password reset |
| auth | 145 | 4 | login, me, update me, change password |
| notifications | 52 | 3 | list, mark-all-read, mark-one-read |
| roles | 42 | 2 | list roles, update role permissions |

**The Inventory module is 72% of the backend's module code.** It is the mature, heavily-engineered part of this system and the strongest evidence of the team's conventions.

### 2.4 Layering convention

`*.routes.js` (mount + guards) → `*.controller.js` (HTTP shape) → `*.service.js` (business logic) → Mongoose models.

The inventory module follows this strictly (`balance.controller.js` + `balance.service.js`, `count.controller.js` + `count.service.js`, …). The older modules (`orders`, `reservations`, `products`) are thinner — controller-only, with logic in `utils/`. **The inventory pattern is the one to follow for HRMS.**

Cross-cutting helpers in `utils/` (~2,900 LOC, 24 files): `eventBus`, `mongoSession`, `mailer`, `mailRecipients`, `notify`, `auditLog`, `stockLedger`, `stockEvents`, `bookingLifecycle`, `bookingJourney`, `bookingLock`, `bookingStatusMail`, `brandAccess`, `boxNoVisibility`, `msilVisibility`, `customerContact`, `dualWrite`, `indentMail`, `moq`, `productFields`, `searchQuery`, `transactionTerms`.

**`utils/eventBus.js` is the architectural centrepiece.** An in-process `EventEmitter` that is a **leaf** — it imports nothing but Node's `events`, so anything may depend on it and it depends on nothing. Delivery is fire-and-forget and never throws: "an alert is a side-effect of business activity, never a precondition for it." It exists to break the M4↔M8 cycle and to keep `io` out of every module. **This is directly reusable for HRMS domain events** (leave approved, payroll locked, exit initiated).

### 2.5 Authentication — `middlewares/auth.js` + `modules/auth/auth.controller.js`

```js
protect: reads `Authorization: Bearer` OR `req.cookies.accessToken`
      → jwt.verify(token, JWT_SECRET)
      → User.findById(decoded.id)
      → reject if !user or user.status !== 'Active'
      → req.user = user (the full Mongoose document)
```

`generateToken(id)` → `jwt.sign({id}, JWT_SECRET, {expiresIn: JWT_EXPIRES_IN || '1d'})`.

**Login flow (`auth.controller.js`):**
1. `User.findOne({email}).select('+password')`
2. If not found, check `ArchivedUser` → a suspended account gets an explicit "account has been suspended" 403 rather than a misleading "not registered"
3. **Password check:** `(user.password === password) || await bcrypt.compare(password, user.password)` — **plaintext comparison first**, bcrypt as fallback
4. Reject non-`Active` status with 403 before issuing a token
5. Issue token, set `lastLogin`, return `{_id, name, email, role, token}`

**Security findings (stated plainly, not editorialised):**
- `models/User.js` documents the password field as *"Plaintext password used to match the auth sheet requirements. TODO: replace with bcrypt.hash / bcrypt.compare once ready."*
- `changePassword` stores the new password **as plaintext**: *"Stored plaintext to remain consistent with the current auth scheme."*
- `routes/api.routes.js` contains a **second, older login endpoint** (`POST /api/auth/login`) that does a pure plaintext match, has **no rate limiting**, and returns the full user document.
- There is **no refresh token, no rotation, no reuse detection, and no server-side logout**. Logout is `localStorage.removeItem('token')` on the client.
- The JWT carries only `{id}` — no role, no permissions. Every request re-reads the `User` document.

### 2.6 Authorization — `middlewares/rbac.js`

A flat, well-documented capability model:

```js
PERMISSIONS = { CREATE_ORDER, MANAGE_ORDERS, MANAGE_INVENTORY, MANAGE_USERS,
  MANAGE_CUSTOMER_USERS, MANAGE_ROLES, VIEW_REPORTS, VIEW_ALL_BOOKINGS,
  EDIT_BOOKING_PRE_PO, RAISE_PO, OVERRIDE_PO_LOCK,
  VIEW_INVENTORY, MANAGE_INVENTORY_MASTER, MANAGE_BOX_NUMBER, CONFIGURE_INVENTORY,
  EXPORT_INVENTORY, VIEW_STOCK_LEDGER, POST_STOCK_IN, POST_STOCK_OUT, ADJUST_STOCK,
  APPROVE_ADJUSTMENT, PERFORM_COUNT, APPROVE_COUNT, TRANSFER_STOCK }   // 24 total
```

**6 roles:**

| Role | Permissions |
|---|---|
| `Admin` | `['*']` wildcard |
| `Sales` | VIEW_ALL_BOOKINGS, MANAGE_CUSTOMER_USERS, EDIT_BOOKING_PRE_PO, RAISE_PO, VIEW_REPORTS, VIEW_INVENTORY |
| `Inventory Manager` | VIEW_INVENTORY, VIEW_STOCK_LEDGER, MANAGE_INVENTORY_MASTER, EXPORT_INVENTORY, POST_STOCK_IN/OUT, ADJUST_STOCK, PERFORM_COUNT, APPROVE_COUNT, TRANSFER_STOCK, VIEW_REPORTS |
| `Warehouse User` | VIEW_INVENTORY, VIEW_STOCK_LEDGER, EXPORT_INVENTORY, POST_STOCK_IN, PERFORM_COUNT, TRANSFER_STOCK |
| `Management` | VIEW_INVENTORY, VIEW_STOCK_LEDGER, EXPORT_INVENTORY, APPROVE_ADJUSTMENT, APPROVE_COUNT, VIEW_REPORTS |
| `Customer` | CREATE_ORDER |

**Three separation-of-duties rules are enforced structurally, not by policy** — worth preserving, because HRMS has the same shape of problem (approve-your-own-leave, run-your-own-payroll):
1. Sales holds `RAISE_PO` but **not** `OVERRIDE_PO_LOCK` — raising the PO locks the booking against the very role that raised it.
2. `Inventory Manager` holds `ADJUST_STOCK` but **not** `APPROVE_ADJUSTMENT`; `Management` holds the approval without the ability to create. Nobody can both make and approve their own stock correction.
3. `Sales` holds `MANAGE_CUSTOMER_USERS`, never `MANAGE_USERS` — a salesperson cannot create an Admin or promote themselves. The restriction is on the **target account's role** and is re-checked in the controller for every read and write, because a permission alone cannot express "only Customers".

**Guard:** `authorize(...perms)` — passes when the user holds **ANY** listed permission (same ANY-OF semantics as DTA).

**What is structurally absent vs DTA:**
- ❌ No **scope** dimension (`self` / `team` / `department` / `org`)
- ❌ No **module × action** decomposition — permissions are opaque strings
- ❌ No reporting hierarchy, no `managerChain`, no team-based visibility
- ❌ Roles are **hardcoded** in `rbac.js`; the `Role` collection exists and is seeded, but `ROLE_PERMISSIONS` is the actual authority. The PermissionMatrix UI edits `Role.permissions`, which the middleware does not read
- ❌ No `organization` / tenant dimension

### 2.7 Other middleware

| File | Role |
|---|---|
| `errorHandler.js` | Maps Mongoose 11000 → 400, `ValidationError` → 400, `JsonWebTokenError`/`TokenExpiredError` → 401. Returns `{success:false, message, stack}` (stack suppressed in production) |
| `auditLogger.js` | `auditLogger('Action name')` — logs on `res.on('finish')` for 2xx only. Captures `user, action, method, endpoint, ipAddress, userAgent`. Applied to ~8 routes |
| `importUpload.js` | multer disk storage for Excel imports + `handleUploadErrors` + `sweepUploads()` |

### 2.8 Response conventions

Every endpoint returns `{ success: boolean, data?: any, message?: string }`. **This differs from DTA**, which returns bare objects/arrays and uses HTTP status alone. The HRMS frontend layer will need one convention or the other, consistently.

### 2.9 Database

- **MongoDB** via Mongoose 8, `connectDatabase()` in `config/database.js`; hard-exits on connection failure.
- `MONGODB_URI` in `.env` (an Atlas URI, with a local alternative commented out).
- **Transactions are used** — `mongoose.startSession()` + `withTransaction` in orders and reservations, with `utils/mongoSession.js` as a helper. `api.routes.js` documents the trade-off explicitly (transactions need a replica set; atomic `findOneAndUpdate` is the standalone fallback).
- `Counter` model + `nextSequence(name)` / `nextSequenceBlock(name, count)` give **atomic, collision-free human-readable IDs** — introduced to replace a `Math.random()` scheme that collided on a unique index. Directly useful for HRMS employee codes.
- Indexes are declared per schema (`auditLogSchema.index({user:1, createdAt:-1})` etc.).

### 2.10 Models (31)

| Cluster | Models |
|---|---|
| Identity | `User`, `ArchivedUser`, `Role` |
| Catalogue | `ProductKoken`, `ProductBIX`, `ProductIMADA` (from `Product.js`), `MsilCode` |
| Sales | `Order`, `BookingStatusEvent`, `Reservation` |
| Inventory | `StockBalance`, `StockMovement`, `StockBatch`, `StockAdjustment`, `StockCount`, `StockCountLine`, `StockHealth`, `InventorySnapshot`, `SnapshotRun`, `InventoryConfig`, `InventoryAlert`, `AlertRule`, `OversoldException`, `Location` |
| Import/Export | `ImportJob`, `ImportRow`, `ImportError`, `ExportJob` |
| Cross-cutting | `AuditLog`, `Notification`, `Counter` |

**`User` schema** — the model HRMS must extend or sit beside:
```
email (unique, lowercase), password (plaintext), company, user (display name),
avatar (data URL), preferences{emailNotifications, pushNotifications},
role (enum: Admin|Sales|Inventory Manager|Warehouse User|Management|Customer),
customerCategory (enum: MSIL|Customer|Regular Customer|Non-MSIL),
customerName, phone, location, shopNumber, vendorNumber, gstNumber,   ← immutable master fields
brandAccess{koken, bix, imada}, moq, showMsilCode, bookingCcEmails[],
status (Active|Inactive|Suspended), lastLogin, timestamps
```
Note: **customer master fields are immutable after creation**, enforced by `CUSTOMER_MASTER_FIELDS` in the user controller, which *refuses* an update rather than silently dropping it. This is a customer-account model, **not** an employee record — it has no joining date, no department, no manager, no employment type.

**`Role` schema** — `{name (unique), description, permissions: [String]}`. A flat string list. It cannot express `module × action × scope`.

**`AuditLog` schema** — `{user, action, method, endpoint, ipAddress, userAgent, remarks, meta (Mixed)}`. The `meta` field carries structured before/after detail for booking edits.

**`Notification` schema** — `{user, title, message, type: enum['order','inventory','reservation'], read}`. **The enum would need `hr` values added** for an HRMS inbox.

### 2.11 Scripts (`backend/scripts/`, ~5,700 LOC)

18 files: 6 migration scripts (`migrate.js`, `migrate-to-atlas.js`, `migrate-unify-products.js`, …), 10 `verify-*.js` scripts (alerts, balance, box-numbers, count, feature-pack, health, import, ledger, reports), plus data loaders. There is a clear convention of **shipping a verification script alongside each module** — worth carrying into HRMS.

---

## 3. Frontend architecture

### 3.1 Bootstrap

`main.jsx` → `<StrictMode><App/></StrictMode>`
`App.jsx` → `QueryClientProvider` (`refetchOnWindowFocus:false`, `retry:1`) → `<RouterProvider router={router}/>` + `<Toaster/>`; on mount runs `initTheme()`, `initSocket()`, `fetchUser()`.

### 3.2 Routing — `routes/index.jsx`

`createBrowserRouter`, **all pages `React.lazy`** with a named-export → default shim (same idiom as DTA).

```
<AuthLayout>
  /login                     Login

<ProtectedRoute>             ← auth only, NO permission gate
  <MainLayout>               ← Sidebar + Navbar + Suspense(Outlet) + CommandPalette
    /                        Dashboard
    /orders/new              CustomerOrders
    /orders/history          OrderHistory
    /orders/bulk-upload      BulkUpload
    /orders/indent-history   IndentHistory
    /sales                   SalesDesk           ← page re-checks its own permission
    /admin                   Admin
    /admin/users             UserManagement
    /admin/permissions       PermissionMatrix
    /inventory               Inventory
    /inventory/master        InventoryMaster     ← page re-checks
    /inventory/ledger        StockLedger
    /inventory/health        InventoryHealth
    /inventory/dashboard     InventoryDashboard
    /inventory/import        InventoryImport
    /reports                 Reports
    /settings                Settings
    /help                    Help
```

**19 routes. Authorization is per-page, not per-route** — `ProtectedRoute` only checks that a user exists. Each sensitive page re-checks its own permission internally, and every underlying API is guarded server-side. There is **no `requiresModules[]` equivalent** and **no catch-all `*` route**.

Pages not in `routes/index.jsx`: `Backorders.jsx`, `Admin/Settings/InventoryConfig.jsx`, `Inventory/InventoryAlerts.jsx`, `Inventory/InventoryExport.jsx`, `Inventory/InventoryReports.jsx` — rendered inside other pages or currently unrouted.

### 3.3 Navigation — `components/layout/Sidebar.jsx`

The `menuItems` array is **built inline** with conditional spreads:
```
Dashboard                                          (always)
Create Booking / Bulk Upload / Booking History /
  Indent History / Inventory                       (worksOrders — not an INVENTORY_ROLE)
Inventory Dashboard / Inventory Master             (canUseInventoryMaster)
Inventory Health                                   (VIEW_INVENTORY && canUseInventoryMaster)
Stock Ledger                                       (VIEW_STOCK_LEDGER)
Inventory Import                                   (canUseInventoryMaster)
Sales Desk                                         (canUseSalesDesk)
User Management                                    (canOpenUserManagement)
Settings / Help                                    (always)
```
Reports is present but **commented out** of the menu.

Active-item logic is careful: exactly one item highlights, chosen by **longest matching path** on a segment boundary, so `/inventory` claims `/inventory/master` but never `/inventory-config`.

**This is the single biggest structural difference from DTA's `nav-items.ts`** — Shraddha's nav is imperative code, DTA's is a declarative table with `requires: [{module,action,scope}]`. Adding ~22 HRMS nav items to this inline array without refactoring would be unmanageable.

### 3.4 State management — 18 Zustand stores

`adminStore, alertStore, bulkImportStore, cartStore, countStore, dashboardStore, healthStore, importStore, indentHistoryStore, inventoryStore, ledgerStore, notificationStore, orderHistoryStore, orderStore, productStore, reportStore, salesStore, themeStore, uiStore, userStore`

**One store per domain** — the convention HRMS should follow. Note there is **no `persist` middleware** anywhere; the JWT lives in raw `localStorage` and everything else is refetched.

`userStore` holds `{user, loading, error}` + `login/fetchUser/updateProfile/changePassword/logout`. Notably, `fetchUser` only discards the token on a **401** — a 429 or a downed API does not log the user out.

TanStack Query is installed and wired at the root, but the stores do most of the fetching. **Two data-fetching paradigms coexist.**

### 3.5 API layer

- `services/api.js` — the live axios instance. `baseURL = (VITE_API_URL || 'http://localhost:5000') + '/api/v1'`. Request interceptor injects `localStorage.token` and **deletes `Content-Type` when the body is `FormData`** (with a good comment explaining why). Response interceptor: **401 → clear token → `window.location.href = '/login'`**.
- `services/axios.js` — a second instance with `baseURL: '/api'`. **Dead code**: zero importers.
- `services/socketService.js` — Socket.IO client + `refreshSocketAuth()` on login/logout.
- Domain modules: `admin.js, inventory.js, orders.js, products.js, reservations.js, sales.js, users.js`.

> ⚠️ `frontend/vite.config.js` has **no dev proxy**. The frontend talks to the backend cross-origin in development, relying on the backend's CORS allowlist. DTA proxies `/api` in dev. There is also **no `frontend/.env`** — `VITE_API_URL` is supplied by the deploy workflow.

### 3.6 Styling / design system

**Tailwind CSS 4** via `@tailwindcss/postcss`. `tailwind.config.js` defines:
- `primary` 50→950 (blue, `600 = #2563eb`)
- `success` / `error` / `warning` (50, 100, 500, 600)
- `enterprise` — `bg #f8fafc`, `card #ffffff`, `border #e2e8f0`, `text #0f172a`, `muted #64748b`
- `fontFamily.sans: ['Inter', 'sans-serif']`
- Custom `shadow-enterprise{,-md,-lg}`

Composition helpers: `clsx` + `tailwind-merge` (used in `Input`, `Button`, `DateField`). Animation: `framer-motion` (Modal, Drawer). Icons: `lucide-react`. Toasts: `react-hot-toast`.

### 3.7 Forms and validation

`react-hook-form` + `@hookform/resolvers` + `zod@4` are installed, but used on **only two pages**: `pages/Auth/Login.jsx` (the only file importing `zod`) and `pages/CustomerOrders/CustomerOrders.jsx`. Everything else uses `useState` and manual validation.

**Implication:** the RHF+zod foundation is present and correct, but has no established pattern at scale. HRMS forms — which are the most field-dense part of the system — will define that pattern.

### 3.8 Permissions on the frontend — `utils/permissions.js`

A hand-written mirror of `backend/middlewares/rbac.js` (same `PERMISSIONS`, same `ROLE_PERMISSIONS`), plus ~15 semantic predicates: `isAdmin, isSales, canUseSalesDesk, canEditBooking, canEditBookingQuantity, canRaisePo, canUseInventoryMaster, canOpenUserManagement, canManageAllUsers, canManageAccount, assignableRolesFor, canEditPlanning, canEditBoxNo, canViewBoxNo, canViewLineItemBoxNo, canConfigureInventory, canAdjustStock`.

The header states the contract plainly: *"This governs what the UI offers. It is never the enforcement point."* The predicates are well-reasoned — `canViewBoxNo` vs `canViewLineItemBoxNo` are deliberately different rules with a documented justification.

**Risk for HRMS:** this file must be kept in sync by hand. DTA solved the same problem with a shared workspace package consumed by both sides. Adding 33 HRMS modules × 10 actions × 4 scopes to a hand-mirrored file is a drift hazard.

---

## 4. Environment variables

`backend/.env` (11 keys, committed to the repo):

| Var | Purpose |
|---|---|
| `PORT` | API port (4000 in production via PM2) |
| `FRONTEND_URL` | CORS + Socket.IO origin allowlist |
| `MONGODB_URI` | MongoDB Atlas connection |
| `JWT_SECRET` | Single signing secret |
| `JWT_EXPIRES_IN` | Token TTL (default `1d`) |
| `NODE_ENV` | environment |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Mail transport |
| `EMAIL_FROM` | From header |

Documented in `backend/README.md` but **not present in `.env`**: `BOOKING_CC_EMAILS`, `SUPPORT_TEAM_EMAILS`.

The README carries an important operational warning: **`SMTP_HOST` is not optional** — unset, the mailer logs to console and *reports success*, so an app started without its `.env` reports every notification as delivered while sending none.

Frontend: `VITE_API_URL` only, injected at build time by the deploy workflow (`https://erp.shraddhaimpex.net`). There is no `frontend/.env` file.

---

## 5. Deployment

**`.github/workflows/deploy.yml`** — on push to `main`:
- `EC2_SSH_KEY` is the only secret; host (`32.236.114.49`), user (`ubuntu`), `APP_DIR` (`/var/www/shraddha-impex`), `SITE_URL` and `VITE_API_URL` are literals, with a comment explaining why (secrets that were "quietly missing or mistyped" surfaced as unrelated SSH errors).
- The **frontend is built on the runner, not the server** — the EC2 box runs ~15 other production apps on 3.7 GB with no swap, so a Vite build there risks the OOM killer taking down a neighbour.
- Concurrency group `deploy-production`, `cancel-in-progress: false`.

**`ecosystem.config.cjs`** — one PM2 app, `shraddha-backend`, fork mode, 1 instance, `max_memory_restart: 400M`, `--max-old-space-size=384`, `restart_delay: 4000`, `max_restarts: 10`. The frontend is static — nginx serves `frontend/dist` directly.

**`deploy/nginx/shraddha-impex-app.conf`** (a snippet, kept apart from the certbot-managed server block):
```
root /var/www/shraddha-impex/frontend/dist
client_max_body_size 20m         # Excel imports
/assets/     → 1y immutable cache
/index.html  → no-store
/api/        → proxy 127.0.0.1:4000, read/send timeout 300s
/socket.io/  → proxy 127.0.0.1:4000, Upgrade/Connection, 86400s
/health      → proxy, access_log off
/            → try_files $uri $uri/ /index.html
```

**Operational constraint to carry into planning: 3.7 GB RAM, no swap, ~15 co-tenant apps, 400 MB PM2 cap.** Adding an HRMS to this process is not free — payroll runs and PDF generation are memory-hungry.

---

## 6. Existing domain modules (for context — none overlap HR)

| Module | What it does |
|---|---|
| **Bookings/Orders** | Customer places a booking → `Reservation` holds stock → confirm → `Order` → PO raised (locks the booking) → Dispatched → Delivered. `BookingStatusEvent` records the journey; `poExpiryJob` settles or releases stock after a 7-day PO deadline |
| **Reservations/Indents** | Cart-style selection list, backorders for unavailable stock, indent scheduling, automatic expiry |
| **Sales Desk** | Sales views all bookings, amends lines pre-PO, raises the PO (which locks it against Sales itself) |
| **Products** | 3 separate brand collections (Koken, BIX, IMADA) + MSIL code validation + per-user `brandAccess` visibility |
| **IMS (M1–M9)** | Stock master, ledger (movements), balances, health classification, dashboard, snapshots, counts/adjustments with maker-checker, alert engine over an event bus, Excel import/export |
| **Users/Roles** | Account CRUD with role-scoped management; a PermissionMatrix UI over `Role.permissions` |
| **Notifications** | In-app notifications + real-time Socket.IO delivery |

---

## 7. Findings relevant to hosting an HRMS

### Strengths to build on
1. **The inventory module is a proven blueprint** — routes → controller → service → model, with permission guards declared at the route and business rules in the service. 13,283 LOC of consistent, well-commented precedent.
2. **The event bus** is exactly the decoupling primitive an HRMS needs (leave approved → notify + inbox; payroll locked → notify; exit initiated → open clearances).
3. **Socket.IO with per-user rooms** already exists — an HRMS inbox gets real-time push for free, which DTA does not have.
4. **`Counter` sequences** solve employee-code generation atomically.
5. **`exceljs` + `xlsx` + the import pipeline** (`ImportJob`/`ImportRow`/`ImportError`, preview → confirm → resume → cancel) maps directly onto HRMS bulk employee import.
6. **Separation-of-duties reasoning is already a habit** in this codebase — the same discipline HRMS approval flows need.
7. **Verification scripts per module** — a convention worth continuing.
8. **Deployment is solid**: build-on-runner, concurrency guard, certbot-safe nginx split, PM2 memory caps.

### Gaps that must be closed before HRMS can land
| # | Gap | Impact |
|---|---|---|
| 1 | **No scope dimension in RBAC** (`self`/`team`/`department`/`org`) | HRMS is unbuildable without it — every leave, expense, attendance and review endpoint depends on it |
| 2 | **No reporting hierarchy** | No manager → report relationship exists anywhere. All approval routing depends on it |
| 3 | **No `Employee` entity** | `User` is a customer account: no joining date, department, designation, employment type, manager |
| 4 | **Plaintext passwords + no refresh tokens + no server-side logout** | HRMS holds salary, PAN, bank and statutory data. This must be fixed *before*, not after |
| 5 | **No rate limiting on login** | Deliberate for the current product; reconsider when payroll data is behind the same door |
| 6 | **No route-level permission gate on the frontend** | `ProtectedRoute` is auth-only |
| 7 | **Nav is an inline array** | ~22 HRMS items cannot be added to it as-is |
| 8 | **Permission list is hand-mirrored** in two files | 33 modules × 10 actions × 4 scopes will drift |
| 9 | **No server-side PDF generation** | `jspdf` is client-side; payslips and statutory letters are records, not views |
| 10 | **No server-side paginated table component** | `DataTable` sorts and pages client-side only |
| 11 | **No `Select` component** | Blocks essentially every HRMS form |
| 12 | **Two data-fetching paradigms** (Zustand stores + TanStack Query) | HRMS should pick one; the DTA pattern (Query for server state, Zustand for UI state) is the cleaner fit |
| 13 | **Response envelope differs** (`{success,data}` vs bare) | Pick one for HRMS endpoints and hold to it |
| 14 | **Stray root artifacts** — `index.js` and `script.js` are two identical 554 KB files at the repo root, plus 4 `*-preview.html` mockups | Not blocking, but the root is not a clean place to add `documentation/` or new top-level folders without a tidy-up decision |
| 15 | **No automated test suite** in either half | The 10 `verify-*.js` scripts are manual. Payroll correctness needs real tests |
| 16 | **Memory ceiling** — 3.7 GB shared, 400 MB PM2 cap | Payroll runs and PDF generation need a plan |

---

## 8. Size comparison

| | DTA HRMS | Shraddha Impex |
|---|---:|---:|
| Backend LOC | 31,838 | 31,268 |
| Frontend LOC | 38,144 | 23,578 |
| Shared packages LOC | 4,099 | 0 |
| **Total** | **~74,000** | **~54,800** |
| Models/entities | 93 | 31 |
| API endpoints | 350 | ~128 |
| Roles | 9 | 6 |
| Permission tuples | 33 modules × 10 actions × 4 scopes | 24 flat strings |
| Frontend routes | 40 | 19 |
| Shared UI components | 2 | 23 |

**Replicating DTA HRMS into Shraddha adds roughly 135% to the codebase and triples the data model.**
