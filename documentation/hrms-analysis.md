# DTA HRMS — Complete Architecture Analysis

> Source system: `./DTA_HRMS`
> Status: **analysis only**. Nothing in this repository was modified.
> Every statement below was traced from actual source files, not from folder names or the spec document.

---

## 0. Executive snapshot

| Fact | Value |
|---|---|
| Repo name | `dtable-hrms` (private) |
| Product | D-Table HRMS — role-based, multi-module HR & Payroll platform, functionally modelled on Keka HR |
| Repo layout | **Turborepo + pnpm workspace monorepo** |
| Apps | `apps/api` (NestJS), `apps/web` (React SPA) |
| Shared packages | `packages/rbac`, `packages/shared-types`, `packages/ui-tokens` |
| Language | TypeScript everywhere (strict mode, ES2022 target) |
| Backend | NestJS 10 on **Fastify**, Prisma 5 ORM, **PostgreSQL 16** |
| Frontend | React 18 + Vite 5 + **Ant Design 5** |
| Auth | JWT access + refresh (argon2id hashing), Passport-JWT strategy |
| Authorization | Shared `@dtable/rbac` matrix — `module × action × scope`, enforced by a global Nest guard AND by the React nav/route filter |
| Multi-tenancy | `organization_id` on every business table + **Postgres Row-Level Security (FORCE RLS)** |
| Data model | **93 Prisma models** |
| API surface | **350 HTTP endpoints** across **66 controllers / 85 services** |
| Frontend size | ~38,100 LOC (`apps/web/src`) |
| Backend size | ~31,800 LOC (`apps/api/src`) |
| Shared packages | ~4,100 LOC |
| Total application code | **~74,000 LOC** |

> ⚠️ `DTA_HRMS/CLAUDE.md` is a **build specification**, not a description of what exists. It describes features (multi-country payroll, geofencing, shift rosters, PWA phase 2) at a level of ambition the code does not always reach. Everything in *this* document was verified against source. Where the spec and the code disagree, the code wins and the divergence is called out in §6.

---

## 1. Overall architecture

### 1.1 Monorepo structure

```
DTA_HRMS/
├── package.json            # root scripts: turbo run dev|build|lint|typecheck|test
├── pnpm-workspace.yaml     # packages: apps/*, packages/*
├── turbo.json              # task graph; build dependsOn ^build
├── tsconfig.base.json      # shared strict TS config (ES2022, decorators on)
├── eslint.config.mjs, .prettierrc, .editorconfig, .nvmrc (Node 20)
├── apps/
│   ├── api/                # NestJS + Fastify + Prisma  (264 files)
│   └── web/                # React + Vite + AntD SPA    (187 files)
├── packages/
│   ├── rbac/               # permission matrix + hasPermission() — used by BOTH apps
│   ├── shared-types/       # Zod schemas + inferred TS types — the API contract
│   └── ui-tokens/          # CSS custom properties + AntD theme builder
├── infra/
│   ├── docker-compose.yml  # postgres:16-alpine, redis:7-alpine, mailpit
│   └── postgres/init/01-extensions.sql
└── .github/workflows/      # ci.yml, deploy.yml, prisma-migration-check.yml
```

**Build system:** Turborepo 2 (`turbo run build` with `dependsOn: ["^build"]`). Effective build order: `shared-types → rbac → api → web`.
**Package manager:** pnpm 10.11.0 (pinned via `packageManager`). `pnpm-workspace.yaml` carries an `allowBuilds` allowlist for `@nestjs/core`, `@prisma/client`, `@prisma/engines`, `argon2`, `esbuild`, `msgpackr-extract`, `prisma`.
**Node engine:** `>=20.11.0`.

### 1.2 Entry points

| App | Entry | Notes |
|---|---|---|
| API | `apps/api/src/main.ts` | `NestFactory.create<NestFastifyApplication>` with `rawBody: true` (the biometric webhook needs exact bytes for HMAC). Registers helmet, cookie, multipart (10 MB / 5 files), rate-limit (300/min). Global prefix `api/v1`; `healthz`/`readyz` excluded. Listens on `0.0.0.0:PORT`. |
| API root module | `apps/api/src/app.module.ts` | Imports 27 feature modules; registers `JwtAuthGuard` + `PermissionsGuard` as `APP_GUARD`, `TenancyInterceptor` + `AuditInterceptor` as `APP_INTERCEPTOR` (tenancy must run first so audit writes have context). |
| Web | `apps/web/src/main.tsx` | Loads `@dtable/ui-tokens/tokens.css`, `antd/dist/reset.css`, MD-editor CSS, `styles/global.css`. Registers the `dayjs` relativeTime plugin globally. Registers a **service worker** (`/sw.js`) in prod; actively unregisters it and clears caches in dev. |
| Web root | `apps/web/src/App.tsx` | `ConfigProvider` (AntD theme from `buildAntdTheme(mode)`) → `AntdApp` → `QueryClientProvider` → `TenantBrand` + `InstallPrompt` + `AppRouter`. |

### 1.3 Configuration files

| File | Purpose |
|---|---|
| `apps/api/src/config/config.schema.ts` | **Zod-validated env**. Invalid env → boot fails loudly at process start. |
| `apps/api/nest-cli.json`, `tsconfig.build.json` | Nest build config |
| `apps/api/prisma/schema.prisma` | 2,320 lines, 93 models |
| `apps/api/vitest.config.ts` | Vitest; the statutory engines are the only substantive test suite present |
| `apps/web/vite.config.ts` | Alias `@ → ./src`; dev server on **5173** with `/api` proxied to `VITE_API_PROXY_TARGET` (default `http://localhost:3001`); build target es2022, sourcemaps on |
| `apps/web/public/manifest.json`, `public/sw.js` | PWA manifest + service worker |
| `infra/docker-compose.yml` | Local Postgres / Redis / Mailpit |

### 1.4 Environment variables (from `config.schema.ts` — authoritative)

| Var | Default | Required | Purpose |
|---|---|---|---|
| `NODE_ENV` | `development` | no | dev / test / production |
| `PORT` | `3001` | no | API port |
| `API_PREFIX` | `api/v1` | no | Global route prefix |
| `CORS_ORIGIN` | `http://localhost:5173` | no | Comma-separated allowed origins |
| `DATABASE_URL` | — | **yes** | Postgres connection string |
| `REDIS_ENABLED` | `true` | no | `false` disables BullMQ entirely |
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` | no | BullMQ connection |
| `JWT_ACCESS_SECRET` | — | **yes (min 16 chars)** | Access-token signing |
| `JWT_REFRESH_SECRET` | — | **yes (min 16 chars)** | Refresh-token signing |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | `15m` / `7d` | no | Token lifetimes |
| `MAIL_HOST` / `MAIL_PORT` | `localhost` / `1025` | no | SMTP (Mailpit dev, SES prod) |
| `MAIL_USER` / `MAIL_PASSWORD` / `MAIL_FROM` | `''` / `''` / `D-Table HRMS <…>` | no | SMTP auth + From header |
| `STORAGE_DRIVER` | `local` | no | `local` \| `s3` |
| `STORAGE_LOCAL_PATH` | `./uploads` | no | Root for selfies, receipts, resumes, PDFs, employee docs |
| `AWS_S3_BUCKET` / `AWS_REGION` | `''` / `ap-south-1` | no | S3 target — **declared but not exercised** (see §7) |
| `BIOMETRIC_WEBHOOK_SECRET` | — | **yes (min 16 chars)** | HMAC verification for biometric ingest |
| `ANTHROPIC_API_KEY` | — | no (**undeclared** in schema) | Read via raw `process.env` in `operations-ai-summarizer.service.ts` |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | no (**undeclared**) | Same file |

Frontend env: `VITE_API_PROXY_TARGET` (dev proxy target) plus whatever `apps/web/src/lib/env.ts` resolves for `apiBaseUrl`.

### 1.5 Backend dependencies (`apps/api/package.json`)

`@nestjs/{common,core,config,jwt,passport,platform-fastify,terminus,bullmq}`, `@fastify/{cookie,helmet,multipart,rate-limit,static}`, `@prisma/client` + `prisma`, `argon2`, `bullmq`, `csv-parse`, `date-fns`, `nodemailer`, `passport` + `passport-jwt`, **`pdf-lib`**, `pino`, `reflect-metadata`, `rxjs`, `zod`, plus workspace deps `@dtable/rbac` and `@dtable/shared-types`.

### 1.6 Frontend dependencies (`apps/web/package.json`)

`antd@5` + `@ant-design/icons`, `@tanstack/react-query@5`, `zustand@4`, `react@18` + `react-dom@18`, `react-router-dom@6`, `recharts`, `dayjs`, `zod`, `@dnd-kit/{core,sortable,utilities}` (Operations Kanban), `@uiw/react-md-editor`, plus workspace deps `@dtable/rbac`, `@dtable/shared-types`, `@dtable/ui-tokens`.

### 1.7 Deployment

`.github/workflows/deploy.yml` — SSH to EC2 → `git pull` → wipe `node_modules` → `pnpm install --frozen-lockfile` → `prisma generate` → `pnpm build` → `prisma migrate deploy` → `rsync apps/web/dist → /var/www/html/hrms/dist` → `pm2 restart hrms-api`. Nginx serves the SPA; PM2 runs the API.

---

## 2. Frontend architecture

### 2.1 Folder structure (`apps/web/src`)

```
src/
├── api/            # 20 files — one typed module per domain, thin fetch wrappers
├── components/     # BrandLogo.tsx, InstallPrompt.tsx  ← only TWO global components
├── hooks/          # use-breakpoint, use-is-ea, use-me, use-permissions
├── layouts/        # AppShell.tsx (526 LOC), PublicShell.tsx, nav-items.ts
├── lib/            # api-client.ts, env.ts, query-client.ts, tenant.ts
├── pages/          # 26 page folders — each owns its tabs, tables, drawers, forms
├── routes/         # index.tsx (router), ProtectedRoute.tsx, PageLoader.tsx
├── stores/         # auth-store.ts (zustand + persist), ui-store.ts
├── styles/         # global.css (440 LOC)
├── App.tsx, main.tsx
```

**Structural fact that matters most for replication:** there is **almost no shared component library**. `components/` holds exactly two files. All tables, forms, drawers, modals, filters and pagination are built **inline, per page, from Ant Design primitives** (`<Table>`, `<Form>`, `<Drawer>`, `<Modal>`, `<Select>`, `<DatePicker>`, `<Tabs>`, `<Tag>`, `<Descriptions>`). The "component library" *is* Ant Design.

### 2.2 Routing

`react-router-dom@6` `createBrowserRouter`, defined in `routes/index.tsx`. **Every page is `React.lazy` code-split**, using a named-export → `default` shim.

Two shells:

| Shell | Routes |
|---|---|
| `PublicShell` | `/login`, `/careers`, `/careers/:slug`, `/careers/offer/:id` |
| `ProtectedRoute → AppShell` | everything else |

Verified route table:

```
/                        DashboardPage
/inbox                   InboxPage
/celebrations            CelebrationsPage
/me                      MyProfilePage
/employees               EmployeesPage             (gate: employees)
/employees/analytics     EmployeeAnalyticsPage     (employees)
/employees/:id           EmployeeProfilePage       (employees)
/employees/:id/edit      EmployeeEditPage          (employees)
/attendance              AttendancePage            (attendance)
/leave                   LeavePage                 (leave)
/payroll        → /payroll/overview
/payroll/:tab            PayrollPage               (payroll)
/expenses       → /expenses/claims
/expenses/:tab           ExpensesPage              (expenses)
/onboarding     → /onboarding/portal
/onboarding/:tab         OnboardingPage            (onboarding)
/exits          → /exits/mine
/exits/:tab              ExitsPage                 (exits)
/documents      → /documents/library
/documents/:tab          DocumentsPage             (documents)
/assets         → /assets/mine
/assets/:tab             AssetsPage                (assets)
/hiring         → /hiring/pipeline
/hiring/:tab             HiringPage                (hiring)
/performance    → /performance/goals
/performance/:tab        PerformancePage           (performance)
/engage         → /engage/announcements
/engage/:tab             EngagePage                (engage)
/helpdesk       → /helpdesk/my-tickets
/helpdesk/:tab           HelpdeskPage              (helpdesk)
/projects       → /projects/projects
/projects/:tab           ProjectsPage              (projects)   ← routes live, nav entry removed
/operations              OperationsPage            (operations)
/operations/projects/:id OperationsProjectPage     (operations)
/planning                PlanningPage              (planning)
/org            → /org/departments
/org/:tab                OrgSettingsPage           (org-structure)
/settings       → /settings/company
/settings/:tab           SettingsPage              (settings)
/audit-logs              AuditLogsPage             (audit-logs)
/reports                 ReportsPage               (reports | reports:payroll | reports:hiring | reports:assets | reports:team)
*               → /
```

**Tab-in-URL pattern:** multi-tab modules encode the active tab as a route param (`/payroll/:tab`) with a `<Navigate>` redirect from the bare path to a default tab. Tab *lists* are assembled at render time and filtered by permission — which tabs exist is role-dependent.

### 2.3 Layouts

- **`AppShell.tsx`** (526 LOC) — collapsible left rail driven by `NAV_ITEMS`; top bar with search, inbox badge, theme toggle, avatar menu; responsive behaviour via `use-breakpoint`; light/dark toggle writing `data-theme` on `<html>`.
- **`PublicShell.tsx`** — bare shell for login and the public careers pages.
- **`layouts/nav-items.ts`** — the single declarative nav source. Each `NavItem` is `{key, label, path, icon, group, requires: NavRequirement[]}` where `NavRequirement = {module, action, scope}`. Groups: `core`, `my-work` ("My Work"), `people-org` ("People & Org"), `admin` ("Admin"). An item shows when the actor satisfies **any** entry in `requires`.

### 2.4 State management

Two cleanly separated layers:

| Layer | Tool | Detail |
|---|---|---|
| Server cache | **TanStack Query v5** | `lib/query-client.ts`: `staleTime 30s`, `gcTime 5m`, `refetchOnWindowFocus: false`, no retry on 401/403/404 (max 2 otherwise), mutations never retry |
| Client state | **Zustand** | `stores/auth-store.ts` — persisted to `localStorage` under `dtable-hrms-auth`, **partialized to tokens only**; `stores/ui-store.ts` — theme + sidebar collapse |

The `/auth/me` payload lives in the auth store but is **not persisted** — `use-me` re-fetches it on every load.

### 2.5 API integration layer

- **`lib/api-client.ts`** — hand-rolled `fetch` wrapper. Attaches `Authorization: Bearer`, sets JSON content-type unless the body is `FormData`, sends `credentials: 'include'`. On **401** it runs a **deduped single-flight refresh** (a shared `refreshInFlight` promise) against `/auth/refresh`, retries the request once, and clears the auth store on failure. `apiFetchBlob()` performs the same dance without JSON parsing, for PDFs and CSV exports.
- **`src/api/*.ts`** — 20 domain modules (`payroll.ts` 457 LOC, `operations.ts` 428 LOC, `employees.ts`, `leave.ts`, `attendance.ts`, `hiring.ts`, …). Each exports typed functions returning `@dtable/shared-types` types. Pages consume them through `useQuery` / `useMutation`.

### 2.6 Forms, tables, modals, filters, pagination, validation

All Ant Design, built per page — there are **no wrappers to inherit**:

| Concern | How DTA does it |
|---|---|
| Forms | AntD `<Form>` + `<Form.Item rules={…}>`, plus per-page field components (e.g. `EmployeeFormFields.tsx`, 726 LOC) |
| Tables | AntD `<Table columns dataSource />`; column arrays declared inline in each page |
| Modals | AntD `<Modal>` — `BulkImportModal`, `PayslipPreviewModal` |
| Drawers | AntD `<Drawer>` — `EmployeeFormDrawer`, `ApplyLeaveDrawer` (787 LOC), `CorrectionDrawer`, `TicketDetailDrawer`, `OperationsTaskDrawer`, `ProjectDetailDrawer` |
| Dropdowns | AntD `<Select>`; dependent selects driven by a `useQuery` keyed on the parent value |
| Search | AntD `<Input.Search>` / `<Input allowClear>` bound to a query param |
| Filters | AntD `<Select>` / `<DatePicker.RangePicker>` bound to query params |
| Pagination | **Server-side** — list endpoints accept `page`/`pageSize` and return `{data, total, page, pageSize}`; the AntD `<Table pagination={{current,pageSize,total}} />` is driven from that |
| Sorting | Mostly client-side via AntD column `sorter`; a few endpoints accept `sortBy`/`sortDir` (`paginationQuerySchema`) |
| Validation | **Zod schemas in `@dtable/shared-types`, shared with the backend.** The API validates with `ZodValidationPipe`; the UI mirrors the same rules as AntD `rules` |
| Charts | Recharts (`LoginTrendChart`, payroll and attendance analytics) |
| Kanban | `@dnd-kit` (Operations board, Hiring pipeline) |
| Markdown | `@uiw/react-md-editor` (Operations daily updates, KB articles) |

### 2.7 Design system

`packages/ui-tokens`:
- `tokens.css` — CSS custom properties (`--db-primary: #02408B`, `--db-sidebar-bg: #051D3E`, semantic success/warning/danger/info, neutral ramp), with a `data-theme="dark"` override block.
- `antd-theme.ts` — `buildAntdTheme(mode)` maps the tokens into AntD's `ConfigProvider` theme and swaps in the dark algorithm.
- Per-tenant brand override: `Organization.brand` (JSON) applied at runtime by `lib/tenant.ts` → `applyTenantBrand()`.

---

## 3. Backend architecture

### 3.1 Framework and shape

**NestJS 10 modular monolith on Fastify.** 27 feature modules registered in `app.module.ts`. Each lives under `src/modules/<domain>/` with `<domain>.module.ts` plus one or more `*.controller.ts` / `*.service.ts`. There are **no DTO classes** — request and response shapes come from Zod schemas in `@dtable/shared-types`.

```
apps/api/src/
├── main.ts, app.module.ts
├── common/
│   ├── decorators/    current-user.decorator.ts, permissions.decorator.ts, public.decorator.ts
│   ├── guards/        jwt-auth.guard.ts, permissions.guard.ts
│   ├── interceptors/  tenancy.interceptor.ts, audit.interceptor.ts
│   ├── pipes/         zod-validation.pipe.ts
│   └── tenancy/       tenancy-context.ts   (AsyncLocalStorage)
├── config/            config.schema.ts
├── prisma/            prisma.module.ts, prisma.service.ts
└── modules/           27 domain modules
```

### 3.2 The 27 modules and their endpoint counts

| Module | Endpoints | Controllers |
|---|---:|---|
| payroll | 59 | bank-file, employee-compensation, form16, loan-advance, pay-group, payroll-adjustment, payroll-exports, payroll-run, payslip, salary-component, salary-structure, statutory-config |
| hiring | 36 | ai-jd, application, candidate, hiring-offer, interview, job-posting, job-requisition, public-careers |
| operations | 26 | operations-daily-update, operations-project, operations-report, operations-task |
| expense | 25 | expense-category, expense-claim, expense-policy, reimbursement-batch, travel-request |
| employees | 22 | employees, analytics, csv-import, custom-fields |
| performance | 18 | feedback, goal, one-on-one, review-cycle, review-response |
| engage | 17 | engage |
| onboarding | 16 | offer-letter, onboarding-checklist, onboarding-template |
| organization | 15 | department, location, organization |
| asset | 15 | asset |
| leave | 14 | leave, holiday |
| exit | 14 | exit-request, full-and-final |
| project | 12 | project |
| document | 11 | document, document-folder |
| attendance | 11 | attendance, biometric-ingest |
| helpdesk | 8 | helpdesk |
| rbac, planning, integration, inbox, dashboard, auth | 4 each | — |
| reports | 3 | reports |
| health | 2 | health |
| audit, admin | 1 each | — |
| queues | 0 | BullMQ registration only |

### 3.3 Authentication

Chain: `auth.controller.ts` → `auth.service.ts` → `jwt.strategy.ts` → `actor-loader.ts`.

- **`POST /auth/login`** (`@Public`) — because RLS is FORCE-enabled on `user`, login performs a **two-step lookup**: query `organization` (the one table with no RLS) for candidates, then `prisma.withOrg(orgId, …)` per candidate to find the user. Password verified with **argon2id** (`memoryCost 65536, timeCost 3, parallelism 4`, pinned explicitly). On success it issues tokens, stores an argon2 hash of the refresh token on `User.refreshTokenHash`, updates `lastLoginAt`, and writes an `auth.login` AuditLog row — that row is what feeds the dashboard login-trend chart.
- **`POST /auth/refresh`** (`@Public`) — verifies the refresh JWT, then compares it against the stored hash. **Reuse detection:** a mismatch nulls `refreshTokenHash`, killing every live session for that user. Rotates on every use; `jti: crypto.randomUUID()` guarantees the hash differs each rotation.
- **`POST /auth/logout`** — nulls `refreshTokenHash`.
- **`GET /auth/me`** — returns `{user, employee, organization, roleKeys, permissions}` (the `MeResponse`), which is exactly what the frontend RBAC helper consumes.
- Access token payload `{sub: userId, orgId, employeeId, type: 'access'}`; refresh `{sub, orgId, type: 'refresh', jti}`.
- `JwtStrategy.validate()` returns a fully-hydrated **`Actor`** (`userId, employeeId, organizationId, departmentId, managerChain, roleKeys, permissions`) which becomes `req.user`.

### 3.4 Authorization

Three cooperating layers:

1. **`JwtAuthGuard` (global `APP_GUARD`)** — every route is protected unless it declares `@Public()`. Fails closed.
2. **`PermissionsGuard` (global `APP_GUARD`)** — reads `@Permissions(...)` metadata and evaluates it with the *shared* `hasPermission()` from `@dtable/rbac`.
   - **ANY-OF semantics.** `@Permissions([selfSpec, teamSpec, orgSpec])` passes if the actor satisfies *any* spec. This is how a single `GET /employees/:id` serves employee (self), manager (team) and HR (org).
   - **Resource resolution.** A spec may name a `resourceParam` (`'id'`, `'employeeId'`, `'leaveRequestId'`). The guard loads the owning employee's `userId`, `departmentId` and `managerChain` so `self`/`team`/`department` scopes can be evaluated against a concrete row. It uses `withOrg()` rather than `tx()` because guards run *before* `TenancyInterceptor` populates the ALS.
   - A route with no `@Permissions()` requires authentication only.
3. **Row-level scoping inside services** — e.g. `LeaveService.buildScopeFilter(actor)` narrows the query itself to self / direct reports / org.

**Permission model (`packages/rbac`):**
- `Module` — 33 values, including sub-modules: `employees`, `employees:compensation`, `org-structure`, `onboarding`, `exits`, `attendance`, `leave`, `payroll`, `payroll:structure`, `expenses`, `documents`, `engage`, `performance`, `hiring`, `assets`, `helpdesk`, `helpdesk:hr`, `helpdesk:payroll`, `helpdesk:it`, `reports`, `reports:payroll`, `reports:team`, `reports:hiring`, `reports:assets`, `settings`, `settings:integrations`, `audit-logs`, `dashboard`, `inbox`, `projects`, `operations`, `planning`.
- `Action` — `view | create | edit | delete | approve | run | submit | assign | resolve | export`.
- `Scope` — `self | team | department | org`, ranked `self(0) < team(1) < department(2) < org(3)`. **A wider granted scope satisfies a narrower requirement.**
- `RoleKey` — **9 roles**: `super_admin, hr_admin, payroll_admin, recruiter, manager, project_manager, employee, it_admin, auditor`.
- `PERMISSION_MATRIX` — the canonical role→permission map. A `SELF_BASELINE` array (dashboard, inbox, own attendance/leave/expenses/helpdesk/documents/performance/profile/payroll/onboarding/exits/engage/projects/operations) is spread into nearly every role. **The Prisma seed reads this exact object** to populate `Role`/`Permission`/`RolePermission` — the matrix is not duplicated.
- `hasPermission(actor, module, action, scope, resource?)` — scope-rank check plus `scopeCovers()`; `team` scope tests `resource.ownerManagerChain.includes(actor.employeeId)`.
- Roles are **stored in the DB** (`Role.isSystem`, per-organization), so Settings → Roles can create custom roles. The matrix is the seed, not a hardcoded gate.

### 3.5 Multi-tenancy — the single most important architectural fact

- Every business table carries `organization_id`.
- `migrations/99991231000000_rls_policies/migration.sql` (far-future timestamp so it always runs last) loops over a `scoped_tables` array and for each table: `ENABLE ROW LEVEL SECURITY`, **`FORCE ROW LEVEL SECURITY`** (Prisma connects as the table owner, who would otherwise bypass RLS), then creates a `tenant_isolation` policy with `USING`/`WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)`.
- `TenancyInterceptor` pushes `{organizationId, userId, employeeId}` into **AsyncLocalStorage** for the request, subscribing to the downstream observable *inside* the ALS context so every `await` still sees it.
- `PrismaService` exposes three access modes:
  - **`prisma.tx(fn)`** — reads the ALS, opens a transaction, runs `SET LOCAL app.current_org = '<uuid>'`. The standard path for HTTP handlers. Throws if called outside a request context, deliberately.
  - **`prisma.withOrg(orgId, fn)`** — explicit org, for guards, background jobs and seeds. Validates the UUID shape before interpolating (Postgres `SET` cannot take bind parameters).
  - **`prisma.raw`** — no tenancy set; returns zero rows on any RLS-protected table. Only useful for `Organization` and the global `Permission` catalog.
- Consequence: because the GUC is unset outside `tx()`/`withOrg()`, **a stray query returns nothing rather than leaking**. Fail-closed by construction.

### 3.6 Middleware / interceptors / pipes

| Component | Role |
|---|---|
| `ZodValidationPipe` | Validates `@Body`/`@Query` against a `@dtable/shared-types` Zod schema |
| `TenancyInterceptor` | ALS tenancy — must precede `AuditInterceptor` |
| `AuditInterceptor` + `@Audited({action, entity, resourceParam})` | Writes `AuditLog` rows on decorated mutations |
| `@CurrentUser()` | Injects the resolved `Actor` |
| `@Permissions(...)`, `@Public()` | Guard metadata |
| Fastify plugins | helmet (CSP off, CORP cross-origin), cookie, multipart (10 MB / 5 files), rate-limit (300 req/min global) |

### 3.7 Business logic highlights (traced, not assumed)

**Leave — `leave.service.ts` (728 LOC)**
- Duration units: full day, **half day with AM/PM slots**, **hourly**, and a **mixed-day breakdown** (`dayBreakdown` JSON).
- **Sandwich rule**: a weekend or holiday inside a leave range is deducted only when it sits between two *full* leave days. A half-day or hourly leave on either side breaks the sandwich and the holiday is skipped. Hourly leave never absorbs surrounding non-working days.
- **Approval rule**: only the **direct** reporting manager may approve. Skip-level managers can *view* (team scope) but not approve. HR/org-scope holders keep an override so the org isn't stuck when a manager becomes unreachable.
- The approval chain is a JSON array advanced step by step; a rejection at any level rejects the whole request.
- **Balances are best-effort**: no request is rejected for insufficient balance, and leave types without a seeded balance row still work. Pending/used counters move on submit and settle on decision.
- Team scope *for leave* = own requests + **direct reports only** — deliberately narrower than the generic team scope, to keep the Approvals tab consistent with the approval rule.

**Attendance — `attendance.service.ts` (612 LOC)**
- Clock-in/out with an optional **selfie** (multipart → `STORAGE_LOCAL_PATH/selfies/`, served back through a `@Public()` `GET /attendance/selfie/:filename`).
- **GPS + reverse geocoding** via `https://nominatim.openstreetmap.org/reverse` at punch time; the human-readable label is stored alongside lat/lng.
- Four dedicated columns: `clock_in_selfie`, `clock_in_location`, `clock_out_selfie`, `clock_out_location`.
- Selfie capture degrades gracefully — denying camera access still permits a punch.
- **Biometric ingest**: `POST /attendance/biometric/:orgSlug` is `@Public()` and verifies an **HMAC over the raw body** using `BIOMETRIC_WEBHOOK_SECRET` — this is why `main.ts` sets `rawBody: true`. Device abstraction lives in `biometric-drivers.ts`.
- Correction requests with an approve/reject queue (HR, super admin and recruiter can clear it).

**Payroll — 12 controllers, 59 endpoints**
- `SalaryEngineService.compute()` is **pure given its input**, so employees can be unit-tested without the DB. Documented resolution order: non-statutory structure components (formulas, two settlement passes) → per-employee `compensation.overrides` → preliminary gross → statutory bundle → statutory component lines → `LoanAdvance` auto-deductions → `PayrollAdjustment` rows → totals summed by component type.
- `salary-formula.ts` — small evaluator supporting `fixed | percent_of | formula | statutory` calculation types.
- Statutory engines, each its own file with a **real unit-test suite** (`statutory-engines.test.ts`): `pf.ts`, `esi.ts`, `pt.ts` (state slabs), `lwf.ts` (state rules), `tds.ts` (old/new regime with exemptions).
- LOP: `leave-lop.ts` computes loss-of-pay days; the engine divides by `daysInMonth` for the per-day rate and supports 0.5-day granularity.
- Run lifecycle: `create → compute → lock → disburse → rollback`.
- PDF generation with **pdf-lib**: `payslip-pdf.ts` (604 LOC), Form 16, offer / appointment / relieving / confirmation letters, and three Operations report generators.
- Bank-file export (formats in `bank-file.types.ts`), plus Tally and QuickBooks export endpoints.
- Advance Salary (`LoanAdvance`) has a **conditional-approval** flow: the approver may attach `conditionText`, which the employee must then accept or decline (`conditionAcceptedAt` / `conditionDeclinedAt`).

**Employees — `employees.service.ts` (803 LOC)**
- Creating an employee also creates the `User`, assigns `initialRoleKeys`, returns a `tempPassword`, and optionally sends an invite.
- **`managerChain` is denormalised** (`[directManager, skipLevel, …]`) and recomputed on manager change (`manager-chain.ts`). This array is what makes `team`-scope checks O(1) at the guard.
- Probation: `probationStartDate` defaults to `dateOfJoining`; `probationEndDate = start + probationMonths`; all three then move independently. `POST /employees/:id/confirm` marks probation complete, flips status to `active`, generates a confirmation-letter PDF, and emails it.
- Notice period mirrors probation with bidirectional month ↔ end-date sync in the form.
- CSV import: `GET template.csv` → `POST preview` → `POST commit`.
- Custom fields: admin-defined `CustomFieldDefinition` rows (`text | textarea | number | date | boolean | select | multiselect`) stored per-employee in a `customFieldValues` JSON column.
- Employee uploads: 12 fixed categories — `photo, aadhar, pan, marksheet_10, marksheet_12, marksheet_grad, bank_statement` (personal, one active per slot) and `offer_letter, joining_letter, experience_letter, leaving_certificate, salary_slip` (previous employment, multiple per company, grouped by `label`).
- `emergencyContacts` is capped at **2**; contact phone is validated as **exactly 10 digits** on both sides.

**Inbox / notifications**
- `InboxService` writes actionable `InboxItem` rows (`type, title, body, entity, entityId, href, actionable, readAt`); `MailService` sends templated email (`mail-templates.ts`) **fire-and-forget** — a mail failure never fails an API call.
- **13 of the 27 modules depend on Inbox** — it is by far the most-shared internal dependency.

**Operations — 26 endpoints, 3 PDF generators**
- A Jira-style project/task/Kanban module with daily updates, task comments, an activity log, per-manager and per-employee PDF reports, and an **optional Claude-powered summariser** (`https://api.anthropic.com/v1/messages`), which falls back to a deterministic summary when `ANTHROPIC_API_KEY` is unset.
- Note: `operations` **is not a standard HR module** — it is D-Table's internal project tracker layered into the HRMS, and it duplicates much of the older `projects` module (whose nav entry has been removed but whose routes and tables still exist).

### 3.8 Background jobs

`QueuesModule` registers BullMQ against Redis and degrades to a **no-op module when `REDIS_ENABLED=false`** (the app boots; scheduled jobs simply don't run, and it logs a warning). The only real processor found is `leave/leave-accrual.processor.ts` + `leave-accrual.service.ts`.

### 3.9 External services

| Service | Where used | Required? |
|---|---|---|
| PostgreSQL 16 (`pgcrypto`, `citext`, `pg_trgm`) | everything | **yes** |
| Redis | BullMQ leave accrual | optional (`REDIS_ENABLED=false`) |
| SMTP (Mailpit dev / SES prod) | `MailService` | optional — failures are swallowed |
| **OpenStreetMap Nominatim** | attendance reverse-geocoding | optional, but an unkeyed public API with a strict usage policy |
| **Anthropic API** | Operations AI summariser | optional |
| Google / Microsoft OAuth | `sso.service.ts` — endpoints declared | config-only; **not wired into the login flow** |
| AWS S3 | `STORAGE_DRIVER=s3` declared | **not exercised** — every file path writes to `STORAGE_LOCAL_PATH` |

---

## 4. HRMS navigation hierarchy (verified from `nav-items.ts`)

```
CORE
├── Home            /            (no permission required)
├── Inbox           /inbox       (no permission required)
└── Me              /me          (no permission required)

MY WORK
├── Attendance      /attendance   attendance:view:self
├── Leave           /leave        leave:view:self
├── Payroll         /payroll      payroll:view:self
├── Expenses        /expenses     expenses:view:self
├── Performance     /performance  performance:view:self
├── Documents       /documents    documents:view:self
├── Engage          /engage       engage:view:self
└── Helpdesk        /helpdesk     helpdesk:view:self

PEOPLE & ORG
├── Employees       /employees    employees:view:team
├── Org Structure   /org          org-structure:view:org
├── Onboarding      /onboarding   onboarding:view:team
├── Exits           /exits        exits:view:team | exits:approve:team | exits:edit:org
├── Assets          /assets       assets:view:org
├── Hiring          /hiring       hiring:view:team
├── Operations      /operations   operations:view:self
└── Planning        /planning     planning:view:org
    (Projects — /projects routes live, nav entry commented out in source)

ADMIN
├── Reports         /reports      reports | reports:payroll | reports:hiring | reports:assets | reports:team
├── Audit Logs      /audit-logs   audit-logs:view:org
└── Settings        /settings     settings:view:org

NOT IN NAV (reachable by link / direct route)
├── Celebrations       /celebrations
└── Employee Analytics /employees/analytics

PUBLIC (PublicShell)
└── /login, /careers, /careers/:slug, /careers/offer/:id
```

**22 nav items in 4 groups**, plus 2 non-nav authenticated routes and 4 public routes.

---

## 5. Data model summary

93 Prisma models. Conventions: UUID primary keys (`gen_random_uuid()`), `@map` to snake_case columns, `organizationId` on every business table, `deletedAt` soft-delete on employee-facing tables, `createdById` / `updatedById` on mutable HR data.

| Group | Models |
|---|---|
| Tenant root | `Organization` (**no RLS**) |
| Auth & HR core | `User`, `Employee` |
| RBAC | `Role`, `Permission` (global catalog, no org), `RolePermission`, `UserRole` |
| Org structure | `Department` (self-referencing tree), `Location`, `Designation`, `EmploymentType`, `CustomFieldDefinition` |
| Attendance | `AttendanceRecord`, `AttendanceCorrection` |
| Leave | `LeaveType`, `LeavePolicy`, `LeaveBalance`, `LeaveRequest`, `Holiday` |
| Cross-cutting | `InboxItem`, `AuditLog` |
| Payroll | `PayGroup`, `StatutoryConfig`, `SalaryComponent`, `SalaryStructure`, `SalaryStructureComponent`, `EmployeeCompensation`, `PayrollRun`, `Payslip`, `PayrollAdjustment`, `LoanAdvance`, `Form16`, `BankFile`, `StatutoryReturn` |
| Expenses & Travel | `ExpenseCategory`, `ExpensePolicy`, `ExpenseClaim`, `ExpenseLineItem`, `TravelRequest`, `TravelAdvance`, `ReimbursementBatch` |
| Onboarding | `OnboardingTemplate`, `OnboardingTaskTemplate`, `OnboardingChecklist`, `OnboardingTask`, `OfferLetter`, `AppointmentLetter` |
| Exits | `ExitRequest`, `ExitClearance`, `ExitInterview`, `RelievingLetter`, `FullAndFinal` |
| Documents | `DocumentFolder`, `EmployeeUpload`, `Document`, `PolicyDocument`, `DocumentAcknowledgment` |
| Assets | `AssetCategory`, `AssetItem`, `AssetAssignment`, `AssetRequest` |
| Hiring (ATS) | `JobRequisition`, `JobPosting`, `Candidate`, `Application`, `Interview`, `InterviewFeedback`, `HiringOffer` |
| Performance | `Goal` (self-referencing), `ReviewCycle`, `ReviewResponse`, `Feedback`, `OneOnOne` |
| Engage | `Announcement`, `Poll`, `PollResponse`, `RecognitionBadge`, `Recognition`, `ENpsSurvey`, `ENpsResponse` |
| Helpdesk | `TicketCategory`, `HelpdeskTicket`, `TicketComment`, `KbArticle` |
| Projects / PSA | `Project`, `ProjectMember`, `ProjectTask`, `TimesheetEntry`, `TimesheetPeriod` |
| Planning | `HeadcountPlan`, `HiringPlan` |
| Integrations | `SsoConfig`, `IntegrationConfig` |
| Operations | `OperationsProject`, `OperationsProjectMember`, `OperationsTask`, `OperationsTaskComment`, `OperationsDailyUpdate`, `OperationsTaskActivity` |

**Migration history (16 migrations)** reveals the real build order: initial schema → holidays → advance-salary conditional approval → probation/confirmation → probation start date → employee uploads → Operations module → Operations daily updates → leave half-day & hourly → leave half-day slots → leave mixed-day breakdown → Operations roadmap URL → employee family/addresses → phone2 → notice period → attendance selfie + lookup tables → **RLS policies (always last)**.

---

## 6. What exists vs what the spec claims

| Spec claim (`CLAUDE.md`) | Reality in code |
|---|---|
| Org chart as an SVG bezier tree | ✅ implemented in `OrgSettingsPage.tsx` (Org Chart tab) |
| Shift management, rosters, rotational shifts | ❌ **no `Shift` / `ShiftAssignment` model, no endpoints** |
| Geofencing for field employees | ❌ not implemented (GPS is captured; no fence evaluation) |
| Multi-tenant SaaS as a "stretch goal" | ✅ **actually built** — RLS + `Organization.brand` |
| E-signature workflow | ⚠️ partial — `SignaturePad.tsx` + `signature` JSON on offers, letters and acknowledgments |
| Reports & Analytics | ⚠️ only **3** report definitions exist: `employees_directory`, `attendance_monthly`, `leave_balances` |
| AI-assisted JD drafting | ✅ `POST /hiring/ai/jd` |
| Projects & Timesheets (PSA) | ✅ built, but the nav entry was removed in favour of Operations |
| Native / PWA mobile | ⚠️ partial — manifest, service worker and `InstallPrompt`; responsive web |
| Field-level encryption for PAN/bank | ❌ not implemented |
| S3 file storage | ❌ config declared; every code path writes to local disk |
| Redis-backed dashboard caching | ❌ not implemented |

---

## 7. Risks and sharp edges to carry into any replication

1. **Access and refresh tokens live in `localStorage`.** The store's own comment flags this as acceptable only for an internal tool.
2. **RLS is load-bearing.** Dropping Postgres drops the tenant-isolation guarantee, which would then have to be re-implemented in application code on every single query.
3. **Storage is local disk.** Selfies, receipts, resumes, every generated PDF and every employee document live under `STORAGE_LOCAL_PATH`. No S3 implementation, no visible backup story.
4. **Nominatim is called synchronously at clock-in.** Public instance, strict usage policy, no SLA — a slow response delays a punch.
5. **Test coverage is essentially one suite** (`statutory-engines.test.ts`). Payroll correctness beyond the statutory engines is unverified.
6. **`operations` duplicates `projects`.** Two overlapping project/task subsystems with separate tables. Replicating both without a decision carries the duplication forward.
7. **The Reports module is a stub** relative to the prominence it is given in the nav and the permission matrix.
8. **Heavy use of JSON columns**: `emergencyContacts`, `dependents`, `customFieldValues`, `approvalChain`, `itinerary`, `ratings`, `agenda`, `notes`, `actionItems`, `totals`, `lines`, `breakdown`, `accrual`, `formula`, `template`, `panel`, `options`, `answer`, `brand`, `config`. These are schema-less at the DB level and validated only by Zod at the edge — the validation layer must be replicated exactly or the data becomes unconstrained.
