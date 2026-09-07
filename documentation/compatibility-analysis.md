# Compatibility Analysis — DTA HRMS vs Shraddha Impex

> Every row was verified against source in both repositories. Where two things share a name but differ in behaviour, that is called out explicitly (Critical Rule 9).

---

## 1. Master comparison table

| Area | DTA HRMS | Shraddha Impex | Recommended action |
|---|---|---|---|
| **Frontend** | React 18.3 + Vite 5 + **Ant Design 5** + TypeScript (strict) | React 19.2 + Vite 8 + **Tailwind CSS 4** + JavaScript (`.jsx`) | **REBUILD UI in Shraddha's stack.** Keep Tailwind. Port logic, not components |
| **Backend** | NestJS 10 on **Fastify** + Prisma 5, TypeScript, decorator-driven DI | **Express 4** + Mongoose 8, JavaScript ESM, `routes → controller → service` | **REBUILD in Express.** Follow the inventory module's layering exactly |
| **Routing (FE)** | react-router-dom **6**, `createBrowserRouter`, lazy pages, tab-in-URL (`/payroll/:tab`), `ProtectedRoute requiresModules[]` | react-router-dom **7**, `createBrowserRouter`, lazy pages, flat paths, `ProtectedRoute` auth-only | **EXTEND.** Add nested `/hrms/*` routes + a `requiresModules` gate. v6→v7 idioms are compatible for what is used here |
| **Routing (BE)** | `@Controller('x')` + `@Get()/@Post()` decorators, global `api/v1` prefix | `express.Router()` + `router.get(path, protect, authorize(...), handler)`, mounted in `app.js` | **REBUILD** as Express routers under `/api/v1/hrms/*` |
| **Authentication** | JWT access (15m) + refresh (7d), **argon2id**, refresh-hash stored + **rotation + reuse detection**, org-scoped login, `/auth/me` returns full permission list | JWT single token (1d), **bcryptjs OR plaintext**, no refresh, no rotation, no server-side logout, `/auth/me` returns the raw `User` doc | **ADAPT + HARDEN.** Keep Shraddha's endpoints; add refresh+rotation, remove plaintext, extend `/me` with `permissions[]`/`roleKeys[]`. **This is a blocker for payroll data** |
| **Authorization** | `module × action × scope` (33 × 10 × 4), shared `@dtable/rbac` package used by guard *and* UI, `managerChain[]` for team scope, DB-backed custom roles | Flat permission strings (24), `Admin:['*']`, **hand-mirrored** in `middlewares/rbac.js` and `utils/permissions.js`, no scope, no hierarchy | **REBUILD the model.** Port DTA's `hasPermission()` + matrix into a **single shared module** both halves import. Preserve Shraddha's 6 roles alongside the 9 HRMS roles |
| **Database** | **PostgreSQL 16** + Prisma, UUID PKs, relational FKs, **FORCE RLS** tenant isolation, `$transaction` everywhere | **MongoDB** + Mongoose, ObjectId PKs, manual refs, single-tenant, transactions used in orders/reservations | **REBUILD schema for MongoDB.** This is the largest single conversion. RLS has no MongoDB equivalent — see §2.4 |
| **Models** | 93 Prisma models, deep FK graph, `Employee` as a 30-relation hub | 31 Mongoose models, no HR entities at all | **BUILD ~90 new Mongoose schemas.** Only `User`, `Role`, `AuditLog`, `Notification` have any overlap — and only partially |
| **APIs** | 350 endpoints, bare JSON responses, Zod-validated via a pipe | ~128 endpoints, `{success, data, message}` envelope, `express-validator` installed (lightly used) | **BUILD ~330 new endpoints.** Adopt Shraddha's `{success,data}` envelope for consistency |
| **Components** | 2 shared components; everything else is inline AntD | 23-file Tailwind UI kit + 8 layout + 10 domain folders | **BUILD ~22 new primitives** (Select, ServerDataTable, Tabs, FilterBar, form fields…). Reuse Modal, Drawer, Pagination, DateField, Card, Badge, EmptyState, skeletons |
| **Forms** | AntD `<Form>` + `rules`, Zod schemas shared with the backend | `react-hook-form` + `zod@4` — **installed but used on only 2 pages** | **ADOPT RHF+zod and scale it.** Port DTA's Zod schemas (v3→v4 pass required) |
| **Tables** | AntD `<Table>` with **server-side** pagination | `DataTable` — **client-side sort + page only**; `Pagination` is server-capable | **BUILD `ServerDataTable`** wrapping the existing `Pagination`. Blocks ~20 list pages |
| **State management** | TanStack Query v5 (server) + Zustand v4 (client), clean split | Zustand v5 (18 stores) **+** TanStack Query v5 — two paradigms coexisting | **STANDARDISE for HRMS**: Query for server state, Zustand for UI state. Leave existing stores untouched |
| **Styling** | `--db-*` CSS variables + `buildAntdTheme()`, navy `#02408B`, light/dark via `data-theme` | Tailwind theme (`primary` blue `#2563eb`, `enterprise.*` neutrals), `clsx` + `tailwind-merge`, `themeStore` | **KEEP SHRADDHA'S PALETTE.** Requirement 19 — HRMS must look native. Both already use Inter |
| **Dependencies** | pnpm workspace, `@dtable/{rbac,shared-types,ui-tokens}` | Two independent npm projects, **no root `package.json`**, no shared package | **ADD a shared module.** Either a third folder both import, or duplicate-with-a-test. **New deps needed: `pdf-lib` (server PDFs), `argon2` or proper `bcrypt` usage, optionally `date-fns`** |
| **Real-time** | none | **Socket.IO 4** — JWT handshake, `user:<id>` + `admins` rooms, event-bus bridge | **REUSE.** HRMS inbox gets live push, which DTA never had |
| **Background jobs** | BullMQ + Redis (`REDIS_ENABLED=false` degrades to no-op) | `node-cron` daily at 00:00, in-process | **REUSE node-cron.** Leave accrual is a daily job; Redis is not worth adding |
| **File storage** | `@fastify/multipart` → `STORAGE_LOCAL_PATH` (selfies, receipts, resumes, PDFs, employee docs). S3 declared, never used | `multer` disk storage for Excel imports + `sweepUploads()` | **EXTEND multer** into a general upload service. Add `STORAGE_LOCAL_PATH` env |
| **PDF generation** | `pdf-lib` **server-side** — payslips, Form 16, 5 letter types, 3 Operations reports | `jspdf` + `jspdf-autotable` **client-side** only | **ADD `pdf-lib` server-side.** Payslips and statutory letters are records; they cannot be client-rendered |
| **Excel / CSV** | `csv-parse` in, CSV out | `exceljs` + `xlsx`, full `ImportJob/ImportRow/ImportError` pipeline with preview → confirm → resume → cancel | **REUSE Shraddha's** — it is materially better than DTA's |
| **Email** | nodemailer + `mail-templates.ts`, fire-and-forget | nodemailer + `utils/mailer.js` + recipient blocklist + HTML shell | **REUSE Shraddha's**, add HRMS templates |
| **Audit logging** | `AuditInterceptor` + `@Audited({action,entity,resourceParam})`, structured payload, `GET /audit-logs` | `auditLogger('Action')` middleware on ~8 routes, `meta` Mixed field, **no read API** | **EXTEND.** Add before/after capture + a read endpoint |
| **Notifications / Inbox** | `InboxItem` (`entity`,`entityId`,`href`,`actionable`) + 4 endpoints | `Notification` (`type: order\|inventory\|reservation`) + 3 endpoints + sockets | **ADAPT.** Extend the schema and the enum; reuse the socket delivery |
| **Validation** | Zod schemas in a shared package, validated by `ZodValidationPipe`, mirrored in AntD `rules` | `express-validator` (installed, sparsely used); `zod@4` on one frontend page | **ADOPT ZOD both sides.** Port DTA's `shared-types` into a shared module |
| **Multi-tenancy** | `organization_id` + Postgres FORCE RLS + AsyncLocalStorage tenancy context | **None** — single tenant | **DECISION REQUIRED.** See §2.4 — recommend single-tenant |
| **Error handling** | Nest exception filters, `{statusCode,message,error}` | `errorHandler.js` mapping Mongoose/JWT errors → `{success,message,stack}` | **REUSE Shraddha's** |
| **Rate limiting** | `@fastify/rate-limit` 300/min global | `express-rate-limit` installed, **deliberately not applied** | **RECONSIDER** for HRMS auth + payroll endpoints |
| **Health checks** | `/healthz`, `/readyz` (terminus) | `/health` | **REUSE** |
| **Testing** | Vitest; one real suite (statutory engines) | none; 10 manual `verify-*.js` scripts | **BUILD.** Port the statutory tests; they are the highest-value tests in either repo |
| **Deployment** | EC2 + nginx (`/var/www/html/hrms/dist`) + PM2 `hrms-api` | EC2 + nginx (`/var/www/shraddha-impex/frontend/dist`) + PM2 `shraddha-backend` :4000, **build-on-runner**, 3.7 GB / no swap / ~15 co-tenants / 400 MB cap | **REUSE Shraddha's pipeline.** Watch the memory ceiling — payroll + PDFs are heavy |
| **CI** | `ci.yml`, `deploy.yml`, `prisma-migration-check.yml` | `ci.yml`, `deploy.yml` | **EXTEND** |

---

## 2. Per-difference verdicts

For each material difference: *Can it be reused? Adapted? Must it be rewritten? Is there a conflict? Is new infrastructure required?*

### 2.1 Language — TypeScript vs JavaScript

- **Reuse:** ❌ No. Shraddha has no TS toolchain, no `tsconfig`, and lints with `oxlint` on `.jsx`.
- **Adapt:** ⚠️ Possible — Vite compiles `.ts` out of the box, and `jsconfig.json` could become `tsconfig.json`. But the backend has no build step at all (`node server.js`), so backend TS would require adding one.
- **Rewrite:** ✅ Yes — all ~74,000 LOC must be expressed in JavaScript, **or** Shraddha must adopt TypeScript wholesale.
- **Conflict:** Yes, and it is a strategic one. DTA's `strict` + `noUncheckedIndexedAccess` typing is load-bearing for payroll correctness; JavaScript loses that safety net.
- **New infrastructure:** Optional — a TS build step for the backend, plus type-checking in CI.
- **Recommendation:** **Stay in JavaScript**, and replace the lost type safety with **Zod schemas validated at every boundary** (which DTA already provides and which Shraddha already has as a dependency). Revisit TS as a separate initiative.

### 2.2 Ant Design vs Tailwind

- **Reuse:** ❌ Zero. Every DTA page imports `antd`.
- **Adapt:** ❌ Installing AntD alongside Tailwind would give the portal two visual languages, ~1.2 MB of extra bundle, and a token system that fights Tailwind's. It also violates requirement 19 (HRMS must be *native*).
- **Rewrite:** ✅ All ~150 `.tsx` page files.
- **Conflict:** Yes — this is the single largest source of effort.
- **New infrastructure:** ~22 UI primitives (see `hrms-component-map.md` §5).
- **Recommendation:** **Rebuild in Tailwind.** Build the Tier-1 primitives first.

### 2.3 PostgreSQL/Prisma vs MongoDB/Mongoose

- **Reuse:** ❌ `schema.prisma` cannot be used by Mongoose.
- **Adapt:** ⚠️ The *shape* adapts — 93 models become ~90 Mongoose schemas. What does **not** adapt:
  | Postgres/Prisma feature | MongoDB reality |
  |---|---|
  | FK constraints + `onDelete: Restrict/Cascade` | Application-enforced only |
  | **Row-Level Security** | **No equivalent** |
  | `@@unique([organizationId, email])` | Compound unique index (works) |
  | `Decimal` (payroll money) | ⚠️ `Decimal128` required — **never `Number`** for currency |
  | `String[]` array columns | Native (works) |
  | JSON columns | Native `Mixed` (works — arguably better) |
  | Self-referencing trees | Manual `$graphLookup` or app-side recursion |
  | Multi-table transactions | Requires a replica set — **already assumed** by existing Shraddha code |
  | `citext` case-insensitive email | Lowercase-on-write (Shraddha's `User` already does this) |
  | `pg_trgm` fuzzy search | Text index or regex |
- **Rewrite:** ✅ All schemas, all queries.
- **Conflict:** **Yes — two.** (a) Losing FK integrity on payroll/compliance data. (b) Losing RLS.
- **New infrastructure:** MongoDB replica set (likely already in place — Atlas), plus disciplined use of `Decimal128`.
- **Recommendation:** **Use MongoDB.** Introducing a second database into a 3.7 GB box with ~15 co-tenant apps is worse than the trade-offs above. Compensate with: `Decimal128` for all money, explicit referential-integrity checks in services, and integration tests on the payroll engine.

### 2.4 Multi-tenancy — RLS vs single-tenant

- **Reuse:** ❌ RLS is Postgres-only.
- **Adapt:** ⚠️ Two options:
  1. **Drop tenancy.** Shraddha Impex is one company. Remove `organizationId` everywhere. Simplest, fastest, matches the target's reality.
  2. **Keep `organizationId` in app code.** Every query gets `{organizationId: req.orgId}`. No database enforcement — one forgotten filter is a cross-tenant leak, which is exactly what RLS was there to prevent.
- **Rewrite:** ✅ Either way.
- **Conflict:** Yes — DTA's fail-closed guarantee cannot be reproduced.
- **New infrastructure:** Only if option 2 is chosen (a tenancy middleware + a Mongoose plugin that injects the filter, plus a lint rule or test that catches raw queries).
- **Recommendation:** **Option 1 — single-tenant.** Shraddha Impex is a single organisation with a single portal. Carrying an unenforced tenant column adds a false sense of isolation. `Organization` becomes a single **`CompanyProfile`** document holding name, logo, brand and address. If SaaS is ever wanted, that is a separate project.
- ⚠️ **This is a blocking business decision** — it changes ~every schema and ~every query.

### 2.5 RBAC — scoped vs flat

- **Reuse:** ✅ **The logic ports almost verbatim.** `packages/rbac/src/has-permission.ts` (~90 LOC) is pure functions over plain objects with zero dependencies; `matrix.ts` (268 LOC) is a literal data structure.
- **Adapt:** ⚠️ Shraddha's `authorize(...perms)` middleware becomes `requirePermission(...specs)` where a spec is `{module, action, scope, resourceParam?}`.
- **Rewrite:** The `Role` model — `permissions: [String]` must become `permissions: [{module, action, scope}]`, plus a `Permission` catalog collection and `isSystem` protection.
- **Conflict:** ⚠️ **Yes, and it needs a decision.** Shraddha's 6 roles (Admin, Sales, Inventory Manager, Warehouse User, Management, Customer) and DTA's 9 (super_admin, hr_admin, payroll_admin, recruiter, manager, project_manager, employee, it_admin, auditor) are different axes. `Customer` must **never** receive HRMS permissions. Options:
  - **(a) Merge into one role set** — 15 roles, one `role` field. Simple, but a Sales user who is also an employee needs both.
  - **(b) Multi-role** — `User.roles: [String]`, matching DTA's `UserRole` join. More faithful; requires touching the existing `authorize` path.
  - **(c) Two axes** — keep `role` for the portal, add `hrmsRoles: [String]`. Least disruption to existing behaviour, but two systems to reason about.
- **New infrastructure:** A shared permissions module both halves import (ending the hand-mirroring), plus a `managerChain` field on the employee record.
- **Recommendation:** **(b) multi-role**, with Shraddha's existing 6 roles mapped into the new tuple format so nothing existing breaks. Every existing route keeps working because `Admin:['*']` maps to a wildcard grant.

### 2.6 Authentication hardening

- **Reuse:** ✅ Shraddha's endpoints, `protect` middleware, `ArchivedUser` handling and status checks are all sound.
- **Adapt:** ⚠️ Add refresh tokens (`refreshTokenHash` on `User`), rotation with `jti`, reuse detection, and a real server-side logout. Port DTA's `api-client.ts` single-flight refresh into `services/api.js`.
- **Rewrite:** ✅ **Password storage.** The plaintext path must go. This requires a migration: hash every existing password on next login (accept plaintext once, re-store hashed, then remove the fallback).
- **Conflict:** ⚠️ **Yes — and it is the single most important one.** `backend/models/User.js` and `auth.controller.js` both store plaintext today, and `routes/api.routes.js` has a second login endpoint doing a raw plaintext comparison with no rate limit. HRMS will hold salary, PAN, bank details, statutory IDs and performance reviews.
- **New infrastructure:** A password-migration script; optionally `argon2` (DTA's choice) — though `bcryptjs` is already installed and adequate.
- **Recommendation:** **Fix this before any HRMS module ships.** Treat it as Phase 0, not as a payroll-phase task.

### 2.7 Server-side PDF generation

- **Reuse:** ❌ `jspdf` runs in the browser.
- **Adapt:** ❌ A payslip is a **record**, not a view. It must be generated, stored (`pdfKey`) and re-servable identically months later.
- **Rewrite:** ✅ Port DTA's `pdf-lib` generators: `payslip-pdf.ts` (604 LOC), Form 16, offer / appointment / relieving / confirmation letters, and (if in scope) the 3 Operations report generators.
- **Conflict:** No, just missing.
- **New infrastructure:** `pdf-lib` dependency; a storage path; **memory headroom** — PDF generation inside a 400 MB PM2 cap needs streaming or batching.
- **Recommendation:** Add `pdf-lib`. Generate payroll PDFs in batches, not one pass over all employees.

### 2.8 Server-side pagination

- **Reuse:** ✅ `Pagination.jsx` is excellent and already takes `totalItems` from anywhere.
- **Adapt:** ⚠️ `DataTable.jsx` sorts and slices in memory — it cannot back a 500-employee directory.
- **Rewrite:** Build `ServerDataTable` = existing `Pagination` + server-driven rows + `sortBy`/`sortDir`.
- **Conflict:** No.
- **New infrastructure:** A `paginate(query)` helper on the backend returning `{data, total, page, pageSize}`.

### 2.9 Navigation model

- **Reuse:** ✅ `MainLayout`, `Navbar` and the sidebar's active-match logic are all reusable.
- **Adapt:** ⚠️ `Sidebar.jsx` builds `menuItems` as an inline array with conditional spreads. Adding ~22 HRMS items in 4 groups is unmanageable that way.
- **Rewrite:** Extract `constants/navItems.js` in DTA's declarative shape (`{key,label,path,icon,group,requires:[{module,action,scope}]}`), then have `Sidebar.jsx` render from it. Existing items migrate into the same table.
- **Conflict:** No — a mechanical refactor.
- **New infrastructure:** Nav groups (DTA has 4: core / My Work / People & Org / Admin; Shraddha has none today).

### 2.10 Frontend route guarding

- **Reuse:** ✅ `ProtectedRoute` as an auth gate.
- **Adapt:** ⚠️ Add `requiresModules[]`. Today Shraddha guards per-page inside each component; with ~40 new HRMS routes that becomes 40 hand-written checks.
- **Rewrite:** No.
- **Conflict:** No.

### 2.11 Response envelope

- **Conflict:** ⚠️ Shraddha returns `{success, data, message}`; DTA returns bare objects. Mixing both inside one portal creates two client-side handling paths.
- **Recommendation:** **Adopt Shraddha's `{success, data}` envelope** for all HRMS endpoints. Consistency inside the target beats fidelity to the source, and requirement 19 asks for nativeness.

### 2.12 Data fetching

- **Conflict:** ⚠️ Shraddha runs 18 Zustand stores **and** TanStack Query. Both work; the mixture is the problem.
- **Recommendation:** For HRMS, use **TanStack Query for all server state** (as DTA does) and **Zustand only for UI state**. Leave the existing 18 stores alone — do not refactor working code as part of this project.

### 2.13 Real-time — a Shraddha advantage

- Socket.IO with JWT handshake and per-user rooms already exists. DTA has nothing equivalent.
- **Recommendation:** Wire the HRMS inbox into `EVENTS.NOTIFICATION_CREATED`. Leave approvals, payroll completion and helpdesk replies push live for free.

### 2.14 Event bus — a Shraddha advantage

- `utils/eventBus.js` is a dependency-free leaf with fire-and-forget delivery that never throws.
- **Recommendation:** Add HRMS events (`leave.approved`, `payroll.locked`, `exit.initiated`, `asset.assigned`, `ticket.resolved`) and subscribe the inbox/mail/socket bridges. This is exactly the decoupling DTA achieves by injecting `InboxService` into 13 modules — but cleaner.

### 2.15 Operations & Projects modules

- **Conflict:** ⚠️ Two overlapping project/task subsystems exist in DTA (11 models, 38 endpoints, ~4,000 LOC combined). The `projects` nav entry is already removed in DTA itself. Neither is an HR function.
- **Recommendation:** **Exclude both from Phase 1** and raise as a blocking question. If project tracking is wanted, build **one** module, not two.

### 2.16 External services

| Service | DTA | Shraddha | Action |
|---|---|---|---|
| Redis / BullMQ | leave accrual | ❌ | **Drop.** Use `node-cron` |
| Nominatim | attendance reverse-geocoding | ❌ | **DECISION** — keep (free, no key, strict policy), swap for a keyed provider, or store raw coordinates |
| Anthropic API | Operations summariser | ❌ | **DECISION** — scope-dependent |
| Google/MS OAuth | declared, unwired | ❌ | **Omit** — it does not work in DTA either |
| AWS S3 | declared, unused | ❌ | **Omit** for Phase 1; local disk matches both systems today |
| SMTP | Mailpit/SES | ✅ live | **Reuse Shraddha's** |
| MongoDB Atlas | ❌ | ✅ live | **Reuse** |
| Socket.IO | ❌ | ✅ live | **Reuse** |

---

## 3. Architectural conflicts — ranked

| # | Conflict | Severity | Resolution |
|---|---|---|---|
| 1 | **Plaintext passwords + no refresh/rotation/logout**, and a second unauthenticated-by-design login route | 🔴 **Critical** | Phase 0. Hash-on-login migration, remove the plaintext path, retire the duplicate `/api/auth/login`, add refresh + rotation |
| 2 | **No scope dimension in RBAC** | 🔴 **Critical** | Port DTA's rbac into a shared module. Nothing in HRMS works without `self/team/department/org` |
| 3 | **No reporting hierarchy** | 🔴 **Critical** | Add `reportingManagerId` + denormalised `managerChain[]` to the employee schema |
| 4 | **Relational → document DB** | 🟠 High | Rewrite schemas; `Decimal128` for money; app-level integrity checks; integration tests |
| 5 | **RLS has no MongoDB equivalent** | 🟠 High | Go single-tenant (recommended) — the guarantee is then unnecessary |
| 6 | **AntD → Tailwind** | 🟠 High | Rebuild UI; ~22 primitives first |
| 7 | **TypeScript → JavaScript** | 🟠 High | Zod at every boundary as the replacement safety net |
| 8 | **No server-side PDF** | 🟡 Medium | Add `pdf-lib`; batch generation for memory |
| 9 | **Client-only DataTable** | 🟡 Medium | Build `ServerDataTable` |
| 10 | **No `Select` component** | 🟡 Medium | Build it first — it blocks every form |
| 11 | **Inline nav array** | 🟡 Medium | Extract a declarative nav table |
| 12 | **Hand-mirrored permissions in two files** | 🟡 Medium | Single shared module |
| 13 | **Response envelope mismatch** | 🟡 Medium | Standardise on `{success,data}` |
| 14 | **Two data-fetching paradigms** | 🟡 Medium | Query for server state in HRMS code |
| 15 | **No rate limiting on auth** | 🟡 Medium | Reconsider once payroll is behind the same login |
| 16 | **3.7 GB RAM, 400 MB cap, ~15 co-tenants** | 🟡 Medium | Batch payroll; stream PDFs; monitor. May need a bigger instance |
| 17 | **`User` is a customer account, not an employee** | 🟡 Medium | Separate `Employee` collection with `userId`, as DTA does |
| 18 | **`Location` name collision** | 🟢 Low | Shraddha's `Location` = stock location. HRMS needs `OfficeLocation` — **do not reuse the collection** |
| 19 | **`AuditLog` shape differs** | 🟢 Low | Extend with `entity`/`entityId`/before-after |
| 20 | **`Notification.type` enum too narrow** | 🟢 Low | Add HRMS values + `entity`/`entityId`/`href`/`actionable` |
| 21 | **No test suite either side** | 🟢 Low (but compounding) | Port the statutory-engine tests at minimum |
| 22 | **Stray root artifacts** (`index.js`/`script.js`, 554 KB each, identical; 4 preview HTML files) | 🟢 Low | Tidy-up decision before adding top-level folders |

---

## 4. Name collisions — verified NOT equivalent

Per Critical Rule 9, these share a name and differ in substance:

| Name | DTA meaning | Shraddha meaning | Verdict |
|---|---|---|---|
| `Location` | Office/branch (name, code, address, city, country, timezone) — employees are assigned to one | **Stock location** for inventory (IMS M1) | ❌ **Not equivalent.** Use a distinct HRMS collection |
| `Role` | `{organizationId, key, label, isSystem}` + `RolePermission` join to `{module,action,scope}` | `{name, description, permissions: [String]}` | ❌ Must be restructured |
| `AuditLog` | `{actorUserId, action, entity, entityId, method, path, payload}` | `{user, action, method, endpoint, ipAddress, userAgent, remarks, meta}` | ⚠️ Adaptable — Shraddha's has IP/UA (better), DTA's has entity targeting (needed) |
| `Notification` / `InboxItem` | `{type,title,body,entity,entityId,href,actionable,readAt}` | `{user,title,message,type:enum,read}` | ⚠️ Adaptable — needs `entity`, `entityId`, `href`, `actionable` |
| `User` | Auth identity, 1:1 with `Employee` | Customer/staff account with GST, shop number, brand access, MOQ | ⚠️ Keep as the auth identity; add a separate `Employee` |
| `Modal` | AntD `<Modal>` | Tailwind + framer-motion portal | ✅ Functionally equivalent — Shraddha's is usable |
| `Drawer` | AntD `<Drawer>` | Tailwind slide-over | ✅ Functionally equivalent |
| `Pagination` | AntD `<Table pagination>` — server-driven | Standalone bar, takes `totalItems` | ✅ Shraddha's works for server paging |
| `DataTable` / `Table` | AntD `<Table>` — server paged | `DataTable` — **client paged only** | ❌ Not equivalent for HRMS list sizes |
| `ProtectedRoute` | Auth + `requiresModules[]` | Auth only | ⚠️ Must be extended |
| `Dashboard` | Role-branched HR KPIs | Booking/inventory KPIs | ❌ Different pages; HRMS needs its own |
| `Reports` | 3 HR report definitions | Inventory reports (6 endpoints) | ❌ Different domains |
| `Settings` | Company profile, roles, SSO, integrations | User profile + preferences | ❌ Different scope |
| `Admin` | (no such page) | Admin landing + user management + permission matrix | ⚠️ HRMS settings should extend this area, not duplicate it |
| `hasPermission` | `(actor, module, action, scope, resource?)` | `(user, permissionString)` | ❌ Different signature and semantics |
| `authorize` / `@Permissions` | Scoped, resource-aware, ANY-OF | Flat strings, ANY-OF | ⚠️ Same ANY-OF semantics; different granularity |
| `AuthLayout` / `PublicShell` | Login + careers | Login only | ✅ Equivalent; extend for careers if in scope |

---

## 5. What genuinely transfers

| Category | Items | Est. LOC |
|---|---|---|
| **Direct logic port** (pure, no framework) | RBAC matrix + `hasPermission`; PF/ESI/PT/LWF/TDS engines + tests; salary formula evaluator; salary engine `compute()`; LOP calculation; leave duration + **sandwich rule**; manager-chain recomputation; org-chart layout maths (`calcLayout`/`nudgeX`) | ~1,400 |
| **Schema port** (Zod v3 → v4) | `packages/shared-types` — all field definitions, enums, regex rules, min/max, defaults | ~3,500 |
| **Pattern port** (rewrite, same design) | api-client single-flight refresh; `usePermissions` hook; declarative nav table; `requiresModules` gate; audit before/after; mail templates; tab-in-URL routing | ~800 |
| **Data-model port** (Prisma → Mongoose) | 93 model definitions — field names, types, enums, indexes, relations | ~2,300 |
| **Business-rule port** (documented behaviour) | Approval chains; probation/notice bidirectional date sync; expense `autoApproveBelow`; asset assign/return; exit two-stage approval; helpdesk category-scoped resolution; payroll run lifecycle; advance-salary conditional approval | — |
| **Reuse as-is from Shraddha** | Socket.IO, event bus, `Counter`, mailer, errorHandler, multer, exceljs/xlsx import pipeline, `Modal`, `Drawer`, `Pagination`, `DateField`, `Input`, `Card`, `Badge`, `EmptyState`, skeletons, `ConfirmationDialog`, `MetricsCard`, `ActivityFeed`, `MainLayout`, `Navbar`, `CommandPalette`, nginx + PM2 + CI | — |

**Everything else — roughly 60,000 LOC of UI and framework-bound code — is a rewrite.**
