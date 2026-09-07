# Component Map — Reusable Component Analysis

> What exists on each side, what can carry over, and what has to be built.
> **Critical Rule 9 applies throughout**: a shared name (`Modal`, `Drawer`, `Location`, `Pagination`) does not make two things equivalent. Every row below was checked against the implementation.

---

## 0. The headline finding

The two systems sit on **completely different UI foundations**:

| | DTA HRMS | Shraddha Impex |
|---|---|---|
| Component source | **Ant Design 5** (a full enterprise component library) | **Hand-built Tailwind components** (23 files in `components/ui/`) |
| React | 18.3 | **19.2** |
| Router | react-router-dom **6** | react-router-dom **7** |
| Styling | AntD + CSS custom properties (`--db-*` tokens) + `global.css` | **Tailwind CSS 4** + `clsx` + `tailwind-merge` |
| Icons | `@ant-design/icons` | `lucide-react` |
| Language | **TypeScript** (strict) | **JavaScript** (`.jsx`, no types; `jsconfig.json`) |
| Forms | AntD `<Form>` + `rules` | `react-hook-form` + `zod` (used on **only 2 pages**) |
| Animation | none | `framer-motion` |
| Toasts | AntD `App.useApp().message` | `react-hot-toast` |
| Charts | Recharts 2 | Recharts 3 |
| Build | Vite 5 | Vite 8 |

**Consequence: not a single DTA `.tsx` page file can be dropped into Shraddha and render.** Every page imports from `antd`, which Shraddha does not have and whose visual language is incompatible with the Tailwind design system already shipped to Shraddha's users.

---

## 1. DTA HRMS — what components actually exist

### 1.1 Genuinely shared components: **2**

| File | LOC | Purpose |
|---|---|---|
| `components/BrandLogo.tsx` | small | Logo mark, sidebar + login |
| `components/InstallPrompt.tsx` | small | PWA install banner |

That is the entire `components/` directory. **There is no shared table, form, modal, drawer, filter or pagination wrapper to inherit.**

### 1.2 Shared infrastructure that *is* reusable (non-visual)

| File | LOC | What it gives you |
|---|---|---|
| `layouts/AppShell.tsx` | 526 | Sidebar + topbar + responsive shell |
| `layouts/PublicShell.tsx` | small | Login/careers shell |
| `layouts/nav-items.ts` | ~240 | **Declarative nav model** — `{key,label,path,icon,group,requires[]}` |
| `routes/ProtectedRoute.tsx` | ~55 | Auth gate + `requiresModules[]` module gate |
| `routes/PageLoader.tsx` | tiny | Suspense fallback |
| `lib/api-client.ts` | ~130 | fetch wrapper + **single-flight 401→refresh** + `apiFetchBlob` |
| `lib/query-client.ts` | ~25 | TanStack Query defaults |
| `lib/tenant.ts` | small | Applies `Organization.brand` JSON to CSS variables |
| `lib/env.ts` | tiny | `apiBaseUrl` resolution |
| `stores/auth-store.ts` | ~55 | Zustand + persist, partialized to tokens |
| `stores/ui-store.ts` | 37 | theme + sidebar collapse |
| `hooks/use-me.ts` | small | `/auth/me` query |
| `hooks/use-permissions.ts` | ~40 | **`can(module,action,scope)` / `seesModule(module)`** |
| `hooks/use-breakpoint.ts` | small | Responsive helper |
| `hooks/use-is-ea.ts` | small | Executive-assistant elevation check |
| `packages/rbac` | ~450 | **The permission matrix + `hasPermission()` — shared with the backend** |
| `packages/shared-types` | ~3,500 | **Zod schemas = the API contract, shared with the backend** |
| `packages/ui-tokens` | ~130 | CSS variables + `buildAntdTheme()` |

### 1.3 Page-local components (the bulk of the frontend)

26 page folders, ~150 `.tsx` files. Everything is built inline per page. The largest:

| File | LOC | What it contains |
|---|---|---|
| `pages/employees/EmployeeProfilePage.tsx` | **1,303** | The whole employee profile: sections, Descriptions blocks, compensation card, probation card, notice card, documents section |
| `pages/operations/ReportsTab.tsx` | **1,209** | Operations reporting UI, filters, tables, PDF triggers |
| `pages/attendance/ClockInCard.tsx` | **845** | Camera capture, GPS, reverse-geocode display, selfie thumbnails |
| `pages/payroll/LoansTab.tsx` | 790 | Advance-salary table + conditional-approval flow |
| `pages/leave/ApplyLeaveDrawer.tsx` | **787** | Leave form with half-day/hourly/mixed conditional fields |
| `pages/employees/EmployeeFormFields.tsx` | 726 | The full employee form field set |
| `pages/payroll/StructuresTab.tsx` | 628 | Salary-structure builder |
| `pages/employees/EmployeesPage.tsx` | 625 | Directory: search, 3 filters, bulk selection, server pagination |
| `pages/dashboard/DashboardPage.tsx` | 589 | Role-branched KPI dashboard |
| `pages/employees/EmployeeDocumentsSection.tsx` | 572 | 12-category upload UI |
| `pages/hiring/InterviewsTab.tsx` | 522 | Interview scheduling + feedback |
| `pages/operations/OperationsTaskDrawer.tsx` | 513 | Task detail drawer |
| `pages/dashboard/HomeWidgets.tsx` | 506 | The 7 universal widgets |
| `pages/settings/RolesTab.tsx` | 456 | Custom role builder |

**Recurring patterns worth naming** (they appear 15–25 times each and are candidates for extraction during replication):

| Pattern | Occurrences | Current shape |
|---|---|---|
| Tabbed module page | 13 modules | `<Tabs items={permissionFilteredArray} activeKey={params.tab} onChange={navigate}>` |
| Server-paginated list | ~10 | `useQuery` + `<Table pagination={{current,pageSize,total,onChange}}>` |
| Filter bar | ~10 | `<Input.Search>` + 2–4 `<Select allowClear>` bound to query params |
| Create/edit drawer | ~12 | `<Drawer>` + `<Form>` + `useMutation` + `queryClient.invalidateQueries` |
| Confirm-destructive | ~15 | AntD `Modal.confirm` / `<Popconfirm>` |
| Status pill | ~12 | `<Tag color={mapStatusToColor(status)}>` — each module has its own `format.ts` |
| Approve/reject action pair | 7 (leave, expenses, travel, exits, assets, loans, corrections) | Two buttons + a comment field |
| PDF download | ~10 | `apiFetchBlob()` → `URL.createObjectURL` → anchor click |
| Money formatter | 3 copies | `payroll/format-money.ts`, plus per-module `format.ts` |
| Avatar + name cell | ~8 | `<Avatar>` + two-line text |

Note the **9 separate `format.ts` files** (assets, documents, exits, expenses, hiring, operations, performance, payroll, leave) — formatting logic is duplicated per module rather than shared.

---

## 2. Shraddha Impex — what components actually exist

### 2.1 UI kit — `components/ui/` (23 files, 1,694 LOC)

| Component | LOC | API | HRMS fitness |
|---|---:|---|---|
| `DataTable` | 146 | `{columns:[{header,accessorKey,sortable,cell}], data, loading, pageSize}` | ⚠️ **Client-side only** — sorts and paginates the array it is given. HRMS needs server-side paging |
| `Pagination` | 190 | `{page, pageSize, totalItems, onPageChange}` | ✅ **Excellent** — first/prev/numbered/next/last + "go to page", ellipsis windowing. Works with server totals |
| `Modal` | 63 | `{isOpen, onClose, title, children, size: sm\|md\|lg\|xl}` | ✅ Portal + framer-motion + body scroll lock |
| `Drawer` | 56 | `{isOpen, onClose, title, children, maxWidth}` | ✅ Right-side slide-over |
| `Input` | 46 | `forwardRef`, `{label, error, helperText, disabled, ...props}` | ✅ RHF-compatible |
| `DateField` | 254 | `{value:"YYYY-MM-DD", onChange(str)}` | ✅ **Strong** — `react-day-picker` in a portal, replaces `<input type=date>`, local-time safe |
| `Autocomplete` | 141 | `{label, placeholder, value, onChange, error}` | ⚠️ **Hardwired to `useProductStore`** — the search logic is not generic |
| `ProductSearchDropdown` | 208 | product-specific | ❌ Domain-specific |
| `Button` | 78 | `forwardRef`, variants | ✅ |
| `ERPButton` | 55 | alternate button style | ✅ |
| `Card` + `CardHeader/Title/Content/Footer` | 59 | compound | ✅ |
| `Badge` | 29 | `{variant, children}` | ✅ |
| `StatusBadge` | 41 | `{status}` → colour map | ⚠️ Booking statuses hardcoded |
| `StageBadge` / `PoStatusBadge` / `IndentStatusBadge` / `PriorityBadge` | 23–50 | domain badges | ❌ `PriorityBadge` reusable; rest are domain-specific |
| `EmptyState` | 27 | `{icon,title,description}` | ✅ |
| `LoadingSpinner` | 13 | — | ✅ |
| `SkeletonLoader` | 21 | `{variant, className}` | ✅ |
| `TableSkeleton` | 46 | `{rows, columns, cellClass}` | ✅ |
| `ConfirmationDialog` | 33 | `{isOpen,onClose,onConfirm,title,message,loading}` | ✅ |
| `PoCountdown` | 52 | PO deadline timer | ❌ Domain-specific |

### 2.2 Layout — `components/layout/`

| Component | Role | HRMS fitness |
|---|---|---|
| `MainLayout.jsx` | `Sidebar` + `Navbar` + `<Suspense><Outlet/></Suspense>` + `CommandPalette` | ✅ Shell is reusable as-is |
| `Sidebar.jsx` | Collapsible rail; **`menuItems` array built inline with permission spreads**; longest-path active matching; user card + sign-out | ⚠️ **Must be refactored** — the nav model is an inline array, not a declarative table like DTA's `nav-items.ts` |
| `Navbar.jsx` | Top bar | ✅ |
| `ProtectedRoute.jsx` | `user`/`loading` gate → `<Outlet/>` | ⚠️ **Auth-only. No module/permission gate** — DTA's `requiresModules[]` has no equivalent |
| `CommandPalette.jsx` | ⌘K palette | ✅ Bonus DTA lacks |
| `IndentToolbar` / `OrderToolbar` | domain toolbars | ❌ |

### 2.3 Domain component folders (not reusable, listed for completeness)

`admin/AuditLogTable`, `backorders/BackordersTable`, `booking/ReviewIndentModal`, `cards/{ErrorPanel, ImportSummaryCard, IndentMetricsCard, MetricsCard, OrderTimeline, StockCard}`, `dashboard/{ActivityFeed, ConversionSummary, KPIStats, RevenueChart}`, `drawer/{IndentDrawer, IndentScheduleSection, OrderDrawer, SalesBookingDrawer}`, `inventory/{BulkPlanningEditor, DetailsDrawer, ExportButton, NewSkuMoqModal, SkuLookupModal, UpdateStockModal}`, `modal/PoConfirmModal`, `tables/{ExcelPreviewTable, IndentHistoryTable, OrderHistoryTable, OrderTable}`, `upload/BulkUploadCard`.

**Reusable *patterns* worth borrowing from these:** `cards/MetricsCard` (KPI tile — directly usable for HRMS dashboards), `dashboard/KPIStats`, `dashboard/ActivityFeed` (matches DTA's New Hires/Exits feed), `cards/OrderTimeline` (timeline pattern → onboarding/exit checklists), `admin/AuditLogTable` (→ HRMS audit viewer), `tables/ExcelPreviewTable` (→ employee CSV import preview), `upload/BulkUploadCard` (→ bulk employee import).

### 2.4 Frontend infrastructure

| File | Role | HRMS fitness |
|---|---|---|
| `services/api.js` | axios instance, `VITE_API_URL + /api/v1`, request interceptor injects `localStorage.token`, **deletes Content-Type for FormData**, response interceptor 401 → clear token → `window.location = '/login'` | ⚠️ **No refresh-token flow.** Needs the single-flight refresh from DTA's `api-client.ts` |
| `services/axios.js` | second axios instance, `baseURL:'/api'` | ❌ **Dead code** — zero importers found |
| `services/socketService.js` | Socket.IO client + `refreshSocketAuth()` | ✅ Bonus |
| `services/{admin,inventory,orders,products,reservations,sales,users}.js` | domain API modules | ✅ Pattern to follow for HRMS modules |
| `store/*.js` (18 Zustand stores) | one per domain | ✅ Pattern to follow |
| `store/userStore.js` | `user, loading, login, fetchUser, updateProfile, changePassword, logout` | ⚠️ Holds the raw `User` doc; **no `permissions[]`** |
| `store/themeStore.js` | `initTheme()` | ✅ |
| `store/uiStore.js` | sidebar state | ✅ |
| `utils/permissions.js` | **Frontend mirror of `backend/middlewares/rbac.js`** — `PERMISSIONS` map, `ROLE_PERMISSIONS`, `hasPermission`, plus ~15 named predicates (`canEditBooking`, `canRaisePo`, `canViewBoxNo`, …) | ⚠️ **Duplicated by hand, explicitly documented as needing manual sync.** DTA solves this with a shared workspace package |
| `hooks/usePagination.js` | client-side paging helper | ⚠️ Client-side only |
| `hooks/useShowMsilCode.js` | domain | ❌ |
| `utils/{exportUtils, excelParser, skuFile, bookingPdf, escapeHtml, dateValue}` | helpers | ✅ `dateValue`, `escapeHtml`, `exportUtils`, `excelParser` reusable |

---

## 3. Side-by-side component gap table

| Capability | DTA HRMS | Shraddha | Verdict for HRMS-in-Shraddha |
|---|---|---|---|
| **Data table (server paged)** | AntD `<Table>` + server `{data,total,page,pageSize}` | `DataTable` client-only + `Pagination` (server-capable) | **BUILD** — a `ServerDataTable` combining Shraddha's `Pagination` with a server-driven table. ~1 day, unblocks ~20 HRMS list pages |
| **Column sorting (server)** | AntD `sorter` (mostly client) | `DataTable` client sort | **BUILD** — add `sortBy`/`sortDir` to the new table |
| **Filter bar** | Ad-hoc per page | none | **BUILD** — a `FilterBar` primitive (search + N selects + date range) |
| **Select / dropdown** | AntD `<Select showSearch allowClear>` | ❌ **none** (`Autocomplete` is product-bound) | **BUILD — highest priority.** Nearly every HRMS form needs a searchable select; dependent selects (department→manager, category→policy) need it too |
| **Multi-select** | AntD `<Select mode="multiple">` | ❌ none | **BUILD** |
| **Date picker** | AntD `<DatePicker>` | ✅ `DateField` (better cross-browser story) | **REUSE** |
| **Date range picker** | AntD `<RangePicker>` | ❌ none | **BUILD** — extend `DateField` |
| **Time picker** | AntD `<TimePicker>` | ❌ none | **BUILD** — needed for hourly leave |
| **Modal** | AntD `<Modal>` | ✅ `Modal` | **REUSE** |
| **Drawer** | AntD `<Drawer>` | ✅ `Drawer` | **REUSE** |
| **Confirm dialog** | `Modal.confirm` / `<Popconfirm>` | ✅ `ConfirmationDialog` | **REUSE** |
| **Form + validation** | AntD `<Form rules>` + shared Zod | `react-hook-form` + `zod` (2 pages only) | **ADOPT + SCALE** — RHF+zod is the better foundation; it just isn't used broadly yet |
| **Field components** | AntD Form.Item variants | `Input` only | **BUILD** — Textarea, Select, Checkbox, Radio, NumberInput, FileInput, FieldArray |
| **Tabs** | AntD `<Tabs>` | ❌ none | **BUILD** — 13 HRMS modules are tab-based |
| **Descriptions / detail grid** | AntD `<Descriptions>` | ❌ none | **BUILD** — heavily used on the employee profile |
| **Upload / dropzone** | AntD `<Upload>` | `react-dropzone` (in `BulkUploadCard`) | **ADAPT** — generalise into a `FileUpload` |
| **Avatar** | AntD `<Avatar>` | inline divs (Sidebar) | **BUILD** — small |
| **Tag / status pill** | AntD `<Tag color>` | ✅ `Badge` + `StatusBadge` | **ADAPT** — generalise the status→colour map |
| **Tree view** | AntD `<Tree>` | ❌ none | **BUILD** — department tree, document folder tree |
| **Org chart** | Hand-rolled SVG bezier canvas | ❌ none | **PORT** — the layout algorithm (`calcLayout`/`nudgeX`, `CW/CH/HG/VG/PAD`) is framework-agnostic and can be re-expressed in Tailwind |
| **Kanban board** | `@dnd-kit` | ❌ none | **BUILD** (if Operations/Hiring pipeline is in scope) |
| **Charts** | Recharts 2 | ✅ Recharts 3 (`RevenueChart`) | **REUSE** — minor v2→v3 API differences |
| **KPI stat tile** | `StatTile` in `DashboardPage` | ✅ `MetricsCard`, `KPIStats` | **REUSE** |
| **Activity feed** | `MiniFeed` in `DashboardPage` | ✅ `ActivityFeed` | **REUSE** |
| **Timeline** | inline | ✅ `OrderTimeline` | **ADAPT** |
| **Markdown editor** | `@uiw/react-md-editor` | ❌ none | **BUILD/ADD DEP** (only if Operations is in scope) |
| **Signature pad** | `SignaturePad.tsx` | ❌ none | **PORT** — canvas-based, framework-agnostic |
| **Camera / selfie capture** | inside `ClockInCard` (`getUserMedia`) | ❌ none | **PORT** — browser API, no library |
| **Toast** | AntD message | ✅ `react-hot-toast` | **REUSE** |
| **Skeleton loading** | AntD `<Skeleton>` | ✅ `SkeletonLoader`, `TableSkeleton` | **REUSE** |
| **Empty state** | AntD `<Empty>` | ✅ `EmptyState` | **REUSE** |
| **Command palette** | ❌ none | ✅ `CommandPalette` | **BONUS** — HRMS global search could hang off it |
| **Theme toggle (light/dark)** | ✅ `ui-store` + `data-theme` + AntD dark algorithm | ✅ `themeStore.initTheme()` | **VERIFY** — confirm Shraddha's dark mode covers new HRMS surfaces |
| **PWA / service worker** | ✅ manifest + `sw.js` + `InstallPrompt` | ❌ none | **OPTIONAL** |

---

## 4. Non-visual code: what genuinely ports

This is where real reuse lives — logic with **no UI and no framework dependency**.

### 4.1 High-value, high-portability (port the algorithm, retype in JS)

| Source | LOC | Why it ports cleanly |
|---|---:|---|
| `packages/rbac/src/has-permission.ts` | ~90 | Pure functions over plain objects. `SCOPE_RANK`, `scopeCovers`, `isSelf`, `isInTeamOf`, `canAccessModule`. **Zero dependencies.** |
| `packages/rbac/src/matrix.ts` | 268 | A literal data structure. Becomes a `.js` object unchanged |
| `payroll/statutory-engines/{pf,esi,pt,lwf,tds}.ts` | ~600 | Pure calculators with a **unit-test suite**. India statutory rules — expensive to re-derive, cheap to port |
| `payroll/salary-formula.ts` | small | Pure formula evaluator |
| `payroll/salary-engine.service.ts` | ~300 | `compute()` is documented as pure given its input |
| `payroll/leave-lop.ts` | small | Pure LOP calculation |
| `leave.service.ts` → `computeDuration` + sandwich rule | ~90 | The single most intricate business rule in the system. Pure date logic |
| `employees/manager-chain.ts` | small | Chain recomputation |
| `settings/OrgSettingsPage.tsx` → `calcLayout` + `nudgeX` | ~80 | Org-chart layout maths, framework-agnostic |
| `packages/shared-types/src/*.ts` | ~3,500 | Zod schemas. **Zod 3 → Zod 4** (Shraddha has v4) needs a compatibility pass, but the shapes and rules transfer directly |

### 4.2 Portable with rewriting

| Source | Target in Shraddha |
|---|---|
| `lib/api-client.ts` single-flight refresh | Add to `services/api.js` axios interceptors |
| `hooks/use-permissions.ts` | New `hooks/usePermissions.js` over the ported rbac module |
| `routes/ProtectedRoute.tsx` `requiresModules` | Extend `components/layout/ProtectedRoute.jsx` |
| `layouts/nav-items.ts` | New `constants/navItems.js`; refactor `Sidebar.jsx` to consume it |
| `common/guards/permissions.guard.ts` | Express middleware `requirePermission(...specs)` |
| `common/interceptors/audit.interceptor.ts` | Extend `middlewares/auditLogger.js` with before/after capture |
| `inbox/mail-templates.ts` | Merge into `utils/mailer.js` template set |
| PDF generators (`payslip-pdf.ts`, letters, Operations reports) | Server-side `pdf-lib` (new dep) — **cannot** reuse Shraddha's client-side `jspdf` |

### 4.3 Not portable

| Source | Why |
|---|---|
| Every `.tsx` page/tab/drawer | AntD-bound, TypeScript, React 18 idioms |
| `packages/ui-tokens/antd-theme.ts` | AntD-specific |
| `prisma/schema.prisma` | Prisma/Postgres-specific; must be re-expressed as Mongoose schemas (or Postgres adopted) |
| RLS migration SQL | Postgres-only |
| `PrismaService` (`tx`/`withOrg`/`raw`) | Prisma-specific |
| NestJS decorators, guards, interceptors, DI | Framework-specific |
| Fastify plugin registrations | Express uses different middleware |

---

## 5. Component build backlog for Shraddha

Ordered by how many HRMS screens each unblocks.

### Tier 1 — blocking (build before any HRMS page)
| # | Component | Unblocks | Est. |
|---|---|---|---|
| 1 | `Select` / `SearchableSelect` | ~all forms + all filter bars | 1–2 d |
| 2 | `ServerDataTable` (wraps existing `Pagination`) | ~20 list pages | 1–2 d |
| 3 | `Tabs` | 13 tabbed modules | 0.5 d |
| 4 | `FilterBar` | ~10 list pages | 0.5 d |
| 5 | Form field set — `Textarea`, `SelectField`, `Checkbox`, `Radio`, `NumberInput`, `FieldArray` (RHF-wired) | every form | 2 d |
| 6 | `FormDrawer` (Drawer + RHF + submit/cancel) | ~12 create/edit flows | 0.5 d |
| 7 | `usePermissions` hook + `PermissionGate` component | every gated button | 0.5 d |

### Tier 2 — module-specific
| # | Component | Needed by |
|---|---|---|
| 8 | `DateRangePicker` | attendance, leave, payroll, reports |
| 9 | `TimePicker` | hourly leave |
| 10 | `FileUpload` (generalised dropzone) | documents, employee uploads, receipts, resumes |
| 11 | `DetailGrid` (Descriptions equivalent) | employee profile, all detail views |
| 12 | `Avatar` + `AvatarList` | dashboard widgets, directory, org chart |
| 13 | `TreeView` | departments, document folders |
| 14 | `ApprovalActions` (approve/reject + comment) | 7 approval flows |
| 15 | `StatusPill` (generalised `StatusBadge`) | 12 modules |
| 16 | `MoneyDisplay` / currency formatter | payroll, expenses, planning |

### Tier 3 — specialised
| # | Component | Needed by |
|---|---|---|
| 17 | `SignaturePad` (port) | offer letters, policy acknowledgment |
| 18 | `CameraCapture` (port) | attendance selfie |
| 19 | `OrgChart` (port the layout algorithm) | org structure |
| 20 | `KanbanBoard` | hiring pipeline, Operations *(scope-dependent)* |
| 21 | `MarkdownEditor` | Operations daily updates, KB *(scope-dependent)* |
| 22 | `Timeline` (adapt `OrderTimeline`) | onboarding/exit checklists |

**Rough total: 22 components, ~3 developer-weeks**, before HRMS feature work starts. This is the hidden cost that any "just copy the HRMS across" estimate misses.

---

## 6. Design-system reconciliation

DTA's tokens vs Shraddha's Tailwind theme:

| Token | DTA (`--db-*`) | Shraddha (Tailwind) |
|---|---|---|
| Primary | `#02408B` (D-Table navy) | `primary-600 #2563eb` (blue) |
| Primary dark | `#012C61` | `primary-900 #1e3a8a` |
| Sidebar | `#051D3E` | gradient `slate-800 → primary-900 → slate-900` |
| Background | `#F5F7FA` | `enterprise.bg #f8fafc` |
| Surface | `#FFFFFF` | `enterprise.card #ffffff` |
| Border | `#E2E6ED` | `enterprise.border #e2e8f0` |
| Text | `#1A2332` | `enterprise.text #0f172a` |
| Success | `#1E8E5A` | `success-500 #22c55e` |
| Warning | `#C77A1B` | `warning-500 #f97316` |
| Danger | `#C0342C` | `error-500 #ef4444` |
| Font | Inter / IBM Plex Sans | Inter |
| Shadows | AntD defaults | custom `shadow-enterprise{,-md,-lg}` |

**Recommendation: keep Shraddha's palette.** Requirement 19 says HRMS must become a *native* part of the portal. Two palettes in one sidebar reads as two products. Both systems already use Inter, so typography carries over unchanged. Shraddha's semantic ramp is a superset of what HRMS needs.

---

## 7. Summary

| Question | Answer |
|---|---|
| Can DTA's UI components be reused? | **No.** AntD vs Tailwind, TS vs JS, React 18 vs 19. Zero `.tsx` files render in Shraddha |
| Can DTA's shared *logic* be reused? | **Yes** — RBAC (~350 LOC), statutory engines (~600 LOC), salary engine, leave duration/sandwich rule, manager chain, org-chart layout, Zod schemas (~3,500 LOC, needs Zod 3→4 pass) |
| Can Shraddha's components carry HRMS? | **Partly.** `Modal`, `Drawer`, `Pagination`, `DateField`, `Input`, `Card`, `Badge`, `EmptyState`, skeletons, `ConfirmationDialog`, `MetricsCard`, `ActivityFeed` are directly usable. **`Select` is the critical missing primitive.** |
| What must be built first? | 7 Tier-1 components (~1 week), then 9 Tier-2 (~1 week), then 6 Tier-3 (~1 week) |
| Biggest hidden cost | The component backlog + the RBAC scope model (`self/team/department/org`), neither of which exists in Shraddha today |
| Biggest free win | Shraddha's Socket.IO layer, `Counter` sequences, `exceljs`/`xlsx`, `CommandPalette`, `DateField` — all things DTA lacks |
