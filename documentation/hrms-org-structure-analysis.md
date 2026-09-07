# HRMS Org Structure — Analysis

**Status:** analysis only. No code, models, routes or migrations were created.
**Reference:** `DTA_HRMS` (read-only, untouched).
**Target:** `shraddha-impex-customer-portal`.
**Date:** 2026-09-02

Everything below was read out of the DTA source, not inferred from its
documentation. File and line references are given so each claim can be checked.

---

## A. DTA Org Structure inventory

Org Structure in DTA is **one nav item, one route, one page component, four
tabs**. It is much smaller than the name suggests.

| # | Tab | Key | Component | Backing entity |
|---|-----|-----|-----------|----------------|
| 1 | Departments | `departments` | `DepartmentsTab.tsx` (216 lines) | `Department` |
| 2 | Locations | `locations` | `LocationsTab.tsx` (216 lines) | `Location` |
| 3 | Custom Fields | `custom-fields` | `CustomFieldsTab.tsx` | `CustomFieldDefinition` |
| 4 | Org Chart | `org-chart` | `OrgChartTab` (inline in `OrgSettingsPage.tsx`) | derived from `Employee` |

Host page: `apps/web/src/pages/settings/OrgSettingsPage.tsx` (297 lines), title
"Org Structure", subtitle "Reporting hierarchy and organizational
configuration".

Tab visibility is permission-driven (`OrgSettingsPage.tsx:18-29`):

```tsx
const canEdit = can('org-structure', 'edit', 'org');
const activeTab = tab ?? (canEdit ? 'departments' : 'org-chart');
const items = [
  ...(canEdit ? [departments, locations, customFields] : []),
  { key: 'org-chart', ... },   // always present
];
```

So a viewer without `edit:org` sees **only** the Org Chart, and it becomes their
default tab.

### Things that are NOT part of Org Structure in DTA

- **Company Profile / logo / SSO / integrations** — these live under
  `/settings`, module `settings`, not `org-structure`
  (`SettingsPage.tsx:20-23`). Already covered by Shraddha's Phase-1
  `CompanyProfile`.
- **Designations** — see D below. A table exists; nothing reads or writes it.
- **Employment types** — same.
- **Teams, grades, bands, cost centres, business units, divisions** — no such
  models exist. Grep over `schema.prisma` returns only `Organization`,
  `Department`, `Location`, `Designation`, `EmploymentType`.

---

## B. DTA routes

`apps/web/src/routes/index.tsx:326-333`

```tsx
{ path: '/org', element: <Navigate to="/org/departments" replace /> },
{
  path: '/org/:tab',
  element: (
    <ProtectedRoute requiresModules={['org-structure']}>
      {suspended(<OrgSettingsPage />)}
    </ProtectedRoute>
  ),
},
```

| Path | Behaviour |
|------|-----------|
| `/org` | redirect → `/org/departments` |
| `/org/departments` | Departments tab |
| `/org/locations` | Locations tab |
| `/org/custom-fields` | Custom Fields tab |
| `/org/org-chart` | Org Chart tab |

There is **one** route with a `:tab` parameter, not four sibling routes. Tab
changes call `navigate('/org/' + key)`, so each tab is linkable and
back-button-able.

Nav entry (`layouts/nav-items.ts:155-161`): key `org`, label **"Org Structure"**,
path `/org`, icon `ApartmentOutlined`, group `people-org`, requires
`org-structure:view:org`.

Note the mismatch, which is real in DTA: the **nav** requires `view:org` while
the **route** requires only module access, which the `self` baseline grants. An
employee cannot see the link but can reach the page by typing the URL, landing
on the Org Chart tab — where the API then refuses them (see N-6).

---

## C. DTA APIs

### Org Structure proper — 11 endpoints

| Method | Path | Permission | Audited | Returns |
|--------|------|-----------|---------|---------|
| GET | `/departments` | `org-structure:view:self` | — | `DepartmentListItem[]` |
| GET | `/departments/:id` | `org-structure:view:self` | — | `Department` |
| POST | `/departments` | `org-structure:edit:org` | `department.create` | `Department` |
| PATCH | `/departments/:id` | `org-structure:edit:org` | `department.update` | `Department` |
| DELETE | `/departments/:id` | `org-structure:edit:org` | `department.delete` | 204 |
| GET | `/locations` | `org-structure:view:self` | — | `LocationListItem[]` |
| GET | `/locations/:id` | `org-structure:view:self` | — | `Location` |
| POST | `/locations` | `org-structure:edit:org` | `location.create` | `Location` |
| PATCH | `/locations/:id` | `org-structure:edit:org` | `location.update` | `Location` |
| DELETE | `/locations/:id` | `org-structure:edit:org` | `location.delete` | 204 |
| GET | `/organization/tree` | **ANY-OF** `org-structure:view:org` OR `employees:view:team` | — | `OrgTreeNode[]` |

Sources: `department.controller.ts`, `location.controller.ts`,
`organization.controller.ts:33-39`.

**Neither list endpoint paginates, filters, sorts by request, or searches.**
`list()` is `findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { employees: true } } } })`
and returns the whole table.

### Adjacent, not Org Structure

| Method | Path | Module | Shraddha status |
|--------|------|--------|-----------------|
| GET/POST/PATCH/DELETE | `/employees/custom-fields[/:id]` | `employees` | **Already built** (Employee Master) |
| GET/PATCH | `/organization/current` | `settings` | Already built (`CompanyProfile`) |
| GET/POST | `/organization/logo` | `settings` (GET is `@Public()`) | Not built; out of scope |

---

## D. DTA models

### `Department` — `schema.prisma:249-268`

```prisma
model Department {
  id             String   @id @default(dbgenerated("gen_random_uuid()"))
  organizationId String
  name           String
  code           String
  parentId       String?                          // self-relation "DeptTree"
  headEmployeeId String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  parent       Department?      @relation("DeptTree", fields: [parentId], references: [id])
  children     Department[]     @relation("DeptTree")
  employees    Employee[]
  requisitions JobRequisition[]

  @@unique([organizationId, code])
  @@index([organizationId])
}
```

### `Location` — `schema.prisma:270-289`

```prisma
model Location {
  id             String   @id
  organizationId String
  name           String
  code           String
  address        String?
  city           String?
  country        String?
  timezone       String   @default("Asia/Kolkata")
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  employees    Employee[]
  requisitions JobRequisition[]

  @@unique([organizationId, code])
  @@index([organizationId])
}
```

### `Designation` — `schema.prisma:298-313` — **ORPHANED**

Documented in the schema as "the picklist of job titles HR can assign to
employees… an authoritative list, avoid typos". In reality:

- `Employee.designation` is `String?` (`schema.prisma:93`), **not** a foreign key.
- `grep -rn "tx.designation|prisma.designation"` over `apps/api/src` → **no matches**.
- No controller, no service, no route, no UI.

Every consumer treats designation as free text, including
`operations/ea-elevation.ts:59`, which does
`(emp?.designation ?? '').trim().toLowerCase()` and compares against string
literals. Shraddha's existing free-text `designation` field is therefore
correct parity, and building a designation catalogue would be **inventing a
feature DTA does not have**.

### `EmploymentType` — `schema.prisma:318+` — **ORPHANED**

Same story. `Employee.employmentType` is a plain code string; the table is never
queried. Shraddha's enum is correct parity.

### `CustomFieldDefinition` — `schema.prisma:341-359`

```prisma
entity String   // 'employee'  — always, in practice
name   String   // snake_case jsonb key
label  String
type   String   // text|textarea|number|date|boolean|select|multiselect
options String[] @default([])
required Boolean @default(false)
order    Int     @default(0)
@@unique([organizationId, entity, name])
```

Shraddha's `EmployeeCustomField` already matches this **field for field**, minus
`entity` (Shraddha's is employee-scoped by name) and `organizationId` (AD-1).

---

## E. DTA fields and validations

### Department

| Field | Type | Required | Server rule (`packages/shared-types/src/org.ts`) | Form rule (`DepartmentsTab.tsx:181-198`) |
|-------|------|----------|--------------------------------------------------|------------------------------------------|
| `code` | string | **yes** | `min(1).max(30)` | required, `max 30`, `/^[A-Z0-9_-]+$/` |
| `name` | string | **yes** | `min(1).max(100)` | required, `max 100` |
| `parentId` | uuid | no | `uuid.optional().nullable()` | **no form field** |
| `headEmployeeId` | uuid | no | `uuid.optional().nullable()` | **no form field** |

### Location

| Field | Type | Required | Server rule | Form rule (`LocationsTab.tsx:182-211`) |
|-------|------|----------|-------------|-----------------------------------------|
| `code` | string | **yes** | `min(1).max(30)` | required, `max 30`, `/^[A-Z0-9_-]+$/` |
| `name` | string | **yes** | `min(1).max(100)` | required, `max 100` |
| `address` | string | **key required, value nullable** | `max(500).nullable()` | optional |
| `city` | string | **key required, value nullable** | `max(100).nullable()` | optional |
| `country` | string | **key required, value nullable** | `max(100).nullable()` | optional |
| `timezone` | string | yes | `max(60).default('Asia/Kolkata')` | required, `Select` from 7 hardcoded values |

Timezone picklist (`LocationsTab.tsx:25-33`) — seven entries, hardcoded:
`Asia/Kolkata`, `Asia/Dubai`, `Asia/Singapore`, `Europe/London`,
`America/New_York`, `America/Los_Angeles`, `UTC`. Form default `Asia/Kolkata`.

### Two validation defects, both real

1. **The uppercase code pattern exists only in the browser.** The server schema
   is `z.string().min(1).max(30)` with no pattern. `POST /departments` with
   `{"code":"eng dept!","name":"X"}` is accepted. Any non-browser client, the
   CSV import, or a curl call bypasses the rule the UI implies is enforced.

2. **`createLocationSchema` makes `address`/`city`/`country` required keys.**
   `locationSchema.omit({ id: true })` leaves them `.nullable()` but **not**
   `.optional()`, so `undefined` fails validation. The Ant form omits untouched
   optional inputs entirely. The department schema explicitly `.extend()`s its
   two optional fields to `.optional().nullable()`; the location schema does
   not. Creating a location without filling City should therefore 400.

---

## F. DTA permissions

Module key: **`org-structure`**. Actions used: `view`, `edit`. Scopes used:
`self`, `org`.

| Role | Grants |
|------|--------|
| `super_admin` | `view:self` (baseline) + `view:org` + `edit:org` |
| `hr_admin` | `view:self` (baseline) + `view:org` + `edit:org` |
| `manager` | `view:self` (baseline) + `view:org` — commented "team hierarchy / org chart visibility" |
| `project_manager` | `view:self` + `view:org` — **excluded by AD-5** |
| `employee` | `view:self` only (baseline) |
| `payroll_admin`, `recruiter`, `it_admin` | `view:self` only (baseline) |
| `auditor` | **none** — auditor does not spread `SELF_BASELINE`; its list is explicit and omits `org-structure` |

Source: `packages/rbac/src/matrix.ts:22,42,68-69,115-116,166,203,240-253`.

**The `department` scope is defined in `SCOPE_RANK` but no DTA grant uses it.**
Same in Shraddha. Org Structure does not change this.

---

## G. DTA business rules

1. **Code is unique per organization.** `@@unique([organizationId, code])` on
   both tables. Violation → Prisma `P2002` → `ConflictException`
   "Department code already in use" / "Location code already in use".
2. **Name is not unique.** Two departments may share a name.
3. **Delete is a hard delete**, guarded only by the database. `Employee.departmentId`
   has no `onDelete` override, so Prisma's default `Restrict` applies; `P2003`/`P2014`
   → `ConflictException` "Department has employees assigned. Reassign them before
   deleting." Identical for locations.
4. **The UI pre-empts that guard**: the confirm dialog disables the OK button
   when `employeeCount > 0` (`DepartmentsTab.tsx:79-80`).
5. **`employeeCount` is a live aggregate** — `_count: { select: { employees: true } }`
   on every list call. It counts *all* employees on the FK, including
   soft-deleted ones, because the `_count` carries no `where`.
6. **Org chart scoping** (`organization.service.ts:77-93`): org-wide when the
   actor has `employees:view:org` **or** `org-structure:edit:org`; otherwise
   restricted to `{ id: actor.employeeId }` OR `{ managerChain: { has: actor.employeeId } }` —
   the actor plus everyone beneath them.
7. **Org chart tree assembly is client-side** (`OrgSettingsPage.tsx:66-78`):
   the API returns a flat list, the browser builds the tree from
   `reportingManagerId`, and a node whose manager is not in the returned set
   becomes a root.
8. **No cycle protection anywhere in Org Structure** — see N-1.
9. **Departments are not actually required on employees**, despite the tab's own
   caption claiming "Departments are used as required foreign keys on Employee
   records" (`DepartmentsTab.tsx:141`). `Employee.departmentId` is `String?`.

---

## H. DTA UI/UX behaviour

### Departments tab

- **List:** Ant `Table`, `pagination={false}`, `size="middle"`, no search box, no
  filters, no column sorters. Columns: **Code** (as a `Tag`, width 120),
  **Name**, **Employees** (right-aligned, width 140), and an actions column
  (width 100) only when `canEdit`.
- **Employee count is a link.** When the viewer can read employees and the count
  is > 0, the number renders as a `Button type="link"` with a team icon that
  navigates to `/employees?departmentId=<id>`. The whole row is clickable for
  the same destination, with `cursor: pointer`.
- **Create/Edit:** a 420px right-hand `Drawer`, `destroyOnClose`, Cancel + Save
  in the header `extra`. Same drawer for both modes; title switches between
  "New Department" and "Edit Department". Two visible fields only.
- **Delete:** `modal.confirm`, red OK labelled "Delete", **disabled** when the
  department has employees; the body text changes to name the count.
- **Empty:** Ant `Table`'s default empty rendering. No custom empty state.

### Locations tab

Structurally identical. Columns: **Code** (Tag, width 100), **Name**, **City**,
**Timezone** (width 160), **Employees**, actions. Form has six fields; `address`
is a `TextArea`; `timezone` is a searchable `Select`.

### Custom Fields tab

Columns: Order, Label, Name (key, rendered as `<Typography.Text code>`), Type
(Tag), Required, actions. Form: hidden `entity` (`initialValue="employee"`),
Label, Name (key), Type, Options (only when type is select/multiselect),
Required switch.

### Org Chart tab

A hand-written layout engine, not a library (`OrgSettingsPage.tsx:50-296`):

- Constants: card 172×96, horizontal gap 36, vertical gap 64, padding 28.
- `buildTree` → `calcLayout` (recursive, centres a parent over its children) →
  `nudgeX` → `flatten` / `collectEdges`.
- Renders absolutely-positioned cards over an SVG layer of cubic Bézier
  connectors.
- Card contents: initials `Avatar`, display name, designation, department name
  as a blue `Tag`, and a status `Tag` **only when status ≠ active**.
- States: `Spin` while pending; `<Empty description="No employees found" />`
  when the list is empty. **No error state.**
- Multiple roots are laid out side by side.

---

## I. Shraddha compatibility analysis

| Seam | Current state | Fit |
|------|---------------|-----|
| **Permission matrix** | `org-structure` already present with `view:self` baseline, `view:org`+`edit:org` for super_admin & hr_admin, `view:org` for manager, none for auditor | **Exact match to DTA.** No change needed. Verified by running the real matrix. |
| **Nav item** | Already declared: `/hrms/org`, `module: ORG_STRUCTURE`, `requires: [org-structure:view:org]` (`navItems.js:197-203`) | Matches DTA. Becomes visible the moment `org-structure` enters `IMPLEMENTED_HRMS_MODULES`. |
| **Reference registry** | `PROVIDER_CONTRACTS.department = ['byId','byCodes','list']`, `.location = ['byId','byCodes','list']`; both `null`, both rejecting with `HrmsNotImplementedError` "Org Structure lands in a later phase." | **The interface is already specified.** Org Structure fills it. |
| **Employee model** | `departmentId` / `locationId` are optional `ObjectId`, indexed as `{deletedAt, departmentId}` and `{deletedAt, locationId}` | Ready. No Employee model change required. |
| **Employee service** | `assertReferencesResolve()` returns 503 when the provider is unregistered and 400 when the id does not resolve (`employee.service.js:238-263`) | Flips to working validation automatically once providers register. |
| **Import pipeline** | `canonical.js:89-90` accepts `departmentCode`/`locationCode`; `pipeline.js:198-220` resolves them via `persistence.resolveDepartmentCodes` / `resolveLocationCodes` and rejects unknown codes per row | Port methods already required by `REQUIRED_PORT_METHODS`. Org Structure supplies the lookups. |
| **Custom fields** | Model + full CRUD API **already built** in Employee Master; **no management UI** — only `.list()` is consumed | The tab is a UI-only addition over an existing API. |
| **Company profile** | `CompanyProfile` built in Phase 1 | DTA's equivalent is under `settings`, not org-structure. Out of scope. |
| **UI primitives** | `HrmsPageLayout`, `TabNav`, `HrmsDataTable`, `FilterBar`, `SearchableSelect`, `PermissionGate`, `ErrorState`, `EmptyState`, `Drawer`, `Modal`, `ConfirmationDialog` | Everything the four tabs need already exists. `TabNav` was built in Phase 1 and has had no consumer until now. |
| **Validation** | Zod 4 in `backend/shared/schemas/`, `validate` middleware, `.strict()` convention | Direct fit. |
| **Audit** | `recordAudit(user, action, message, req, { meta })`, `AUDIT_ACTIONS` frozen map | Needs 6 new action constants. |
| **Errors** | `HrmsNotFoundError`, `HrmsConflictError`, `HrmsValidationError`, `HrmsNotImplementedError` | Covers every case DTA raises. |

### Structural differences that matter

1. **No foreign keys (AD-2).** DTA leans on Postgres `Restrict` to block
   deleting a department in use. MongoDB will not do this. The count-and-refuse
   check must be **explicit and server-side**.
2. **Single tenant (AD-1).** `organizationId` disappears; `@@unique([organizationId, code])`
   becomes a plain unique index on `code`.
3. **UUID → ObjectId.** `ParseUUIDPipe` becomes the existing `objectId` Zod helper.
4. **No `_count` aggregate.** `employeeCount` needs an explicit aggregation —
   one `$group` over `Employee`, not one query per row.
5. **Ant Design → Tailwind.** The org chart's layout engine is pure arithmetic
   and ports directly; only the rendering changes.

---

## J. Required MongoDB/Mongoose design

Two new models. No change to `Employee`.

### `backend/models/hrms/Department.js`

| Field | Type | Rules |
|-------|------|-------|
| `code` | String | required, **unique**, uppercase, trim, maxlength 30, `/^[A-Z0-9_-]+$/` |
| `name` | String | required, trim, maxlength 100 |
| `parentId` | ObjectId | default `null`, indexed — *pending decision O-1* |
| `headEmployeeId` | ObjectId | default `null` — *pending decision O-2* |
| `deletedAt` | Date | default `null`, indexed — *pending decision O-3* |
| timestamps | | `createdAt`, `updatedAt` |

Indexes: `{ code: 1 }` unique; `{ deletedAt: 1, name: 1 }` for the ordered list.

### `backend/models/hrms/Location.js`

| Field | Type | Rules |
|-------|------|-------|
| `code` | String | required, **unique**, uppercase, trim, maxlength 30, same pattern |
| `name` | String | required, trim, maxlength 100 |
| `address` | String | optional, maxlength 500 |
| `city` | String | optional, maxlength 100 |
| `country` | String | optional, maxlength 100 |
| `timezone` | String | required, default `'Asia/Kolkata'`, maxlength 60, validated against a real IANA list |
| `deletedAt` | Date | default `null` |
| timestamps | | |

Indexes: `{ code: 1 }` unique; `{ deletedAt: 1, name: 1 }`.

### Schemas — `backend/shared/schemas/org.js`

`createDepartmentSchema`, `updateDepartmentSchema` (`.partial().strict()`),
`createLocationSchema`, `updateLocationSchema`. The uppercase-code pattern goes
**in the Zod schema**, so it binds every client, not only the browser (fixes
N-2). Optional location fields get `.optional().nullable()`, not bare
`.nullable()` (fixes N-3).

### Provider modules

`department.provider.js` and `location.provider.js`, each exporting
`{ byId, byCodes, list }` to satisfy `PROVIDER_CONTRACTS`, registered in
`hrms.bootstrap.js` exactly as the employee provider is. The import persistence
port's `resolveDepartmentCodes` / `resolveLocationCodes` bind to `byCodes`.

---

## K. Required APIs in Shraddha

Eleven endpoints under `/api/v1/hrms`, mirroring DTA one-for-one.

| Method | Path | Guard |
|--------|------|-------|
| GET | `/org/departments` | `org-structure:view:self` |
| GET | `/org/departments/:id` | `org-structure:view:self` |
| POST | `/org/departments` | `org-structure:edit:org` |
| PATCH | `/org/departments/:id` | `org-structure:edit:org` |
| DELETE | `/org/departments/:id` | `org-structure:edit:org` |
| GET | `/org/locations` | `org-structure:view:self` |
| GET | `/org/locations/:id` | `org-structure:view:self` |
| POST | `/org/locations` | `org-structure:edit:org` |
| PATCH | `/org/locations/:id` | `org-structure:edit:org` |
| DELETE | `/org/locations/:id` | `org-structure:edit:org` |
| GET | `/org/tree` | ANY-OF `org-structure:view:org`, `employees:view:team` |

Every response must nest its payload under `data` — the envelope invariant added
after the employee-list defect, and now covered by a test that scans every HRMS
controller.

New audit actions to add to `AUDIT_ACTIONS`:

```
DEPARTMENT_CREATED  'hrms.department.created'
DEPARTMENT_UPDATED  'hrms.department.updated'
DEPARTMENT_DELETED  'hrms.department.deleted'
LOCATION_CREATED    'hrms.location.created'
LOCATION_UPDATED    'hrms.location.updated'
LOCATION_DELETED    'hrms.location.deleted'
```

---

## L. Required frontend screens

One page, four tabs, at `/hrms/org` → redirect to `/hrms/org/departments`, plus
`/hrms/org/:tab`. Uses the existing `TabNav` primitive (built in Phase 1,
currently unused) inside `HrmsPageLayout`.

| Tab | Build | Reuses |
|-----|-------|--------|
| Departments | `DepartmentsTab.jsx` + drawer | `HrmsDataTable`, `Drawer`, `ConfirmationDialog`, `PermissionGate` |
| Locations | `LocationsTab.jsx` + drawer | same, plus `SearchableSelect` for timezone |
| Custom Fields | `CustomFieldsTab.jsx` | **existing** `employeeCustomFieldsApi` — no new API |
| Org Chart | `OrgChartTab.jsx` | new; layout maths ports from DTA, rendered with Tailwind + SVG |

`HrmsDataTable` is server-paginated, but these lists are unpaginated in DTA and
will hold tens of rows. Passing `total` equal to the row count keeps its
pagination bar hidden while reusing its loading, empty and error states — no new
table component, no contract change.

Deep link `/hrms/employees?departmentId=<id>` must be honoured by
`EmployeesPage`, which currently seeds its filters from local state only.

---

## M. Employee Master integration points

Exactly what Org Structure unlocks, all of it already stubbed and waiting:

| Point | Today | After Org Structure |
|-------|-------|---------------------|
| `assertReferencesResolve` | 503 `HrmsNotImplementedError` on any `departmentId`/`locationId` | validates the id, 400 if unknown |
| Employee form — Department | `SearchableSelect` disabled, placeholder "Available once Org Structure is built" | populated from `/org/departments`, label `CODE · Name` (DTA format) |
| Employee form — Location | same | populated from `/org/locations` |
| Directory filters | Department & Location rendered **disabled** with empty options | populated and active |
| Directory query | `departmentId`/`locationId` already accepted by `employeeListQuerySchema` and applied in `listEmployees` | no change — already wired |
| Employee profile | department/location not displayed | display resolved names |
| Import pipeline | `resolveDepartmentCodes`/`resolveLocationCodes` present on the port but unimplemented | real code→id lookups; unknown codes already rejected per row |
| Reference registry | `describe()` → `{employee: true, department: false, location: false}` | all three true; `referencesReady()` becomes true |
| RBAC `department` scope | actor carries `departmentId`, no grant uses it | unchanged — DTA does not use it either |

**No Employee Master business logic changes.** The seams were built for this.

---

## N. Security / correctness improvements

Nine DTA behaviours that should **not** be copied.

1. **No cycle detection on `Department.parentId`.** `create`/`update` write
   `parentId` straight through. `A → B → A`, or a department as its own parent,
   is accepted. Identical in kind to the `managerChain` defect already corrected
   in Employee Master, and the fix is the same `assertNoCycle` shape. *(Only
   applies if O-1 is answered "hierarchical".)*

2. **The uppercase code rule is browser-only.** Put the pattern in the Zod
   schema so every client is bound by it. Directly contradicts the standing rule
   "do not rely only on frontend validation".

3. **`createLocationSchema` rejects an omitted `city`/`country`/`address`.**
   Use `.optional().nullable()`, as the department schema already does for its
   two optional fields.

4. **`headEmployeeId` is never validated.** DTA accepts any UUID and leans on the
   FK. With no FKs (AD-2), an unchecked id would dangle silently — the same
   trap `assertReferencesResolve` already closes for employees.

5. **`employeeCount` counts soft-deleted employees.** `_count` carries no
   `where`, so a department whose only employees have been deactivated still
   reports them and stays undeletable. The count must filter `deletedAt: null`.

6. **Org chart access is inconsistent.** The route admits anyone with the
   `self` baseline and defaults them to the Org Chart tab, but
   `GET /organization/tree` requires `org-structure:view:org` OR
   `employees:view:team` — which an employee has neither of. The result is a tab
   that always 403s. Either admit the employee to their own subtree or gate the
   tab; do not ship the dead end.

7. **Hard delete with no recovery.** Employee Master soft-deletes. A department
   deleted by mistake takes its audit context with it. Soft-delete for
   consistency, and refuse while employees reference it — *see O-3*.

8. **The public logo endpoint.** `@Public()` on `GET /organization/logo`. Out of
   scope here, but noted so it is not copied if the logo is built later.

9. **The Departments caption is false.** "Departments are used as required
   foreign keys on Employee records" — `Employee.departmentId` is nullable.
   Shraddha's caption should say what is true.

---

## O. Open decisions

Five, of which **three genuinely need your input**.

### O-1. Department hierarchy — *needs input*

DTA has `parentId`, a self-relation, and DTO support — but **no form field, no
tree rendering, and no cycle check**. The data model is hierarchical; the product
is flat.

- **(a) Flat** — omit `parentId` entirely. Matches what DTA users can actually
  do. Least code, no cycle risk.
- **(b) Hierarchical** — expose a parent picker and add `assertNoCycle`. Matches
  DTA's schema and is closer to a real org, but is a feature DTA does not ship,
  so it is an addition rather than parity.

*Recommendation: (a) flat*, keeping the field out of the model until it has a
purpose. Adding it later is a small additive change; shipping an unreachable
half-feature is the thing that is hard to undo.

### O-2. `headEmployeeId` — *needs input*

Same situation: in the model and DTO, absent from the UI. Include it with a
validated employee picker, or omit it?

*Recommendation: omit*, for the same reason as O-1.

### O-3. Delete semantics — *needs input*

DTA hard-deletes and lets the FK refuse. We have no FKs.

- **(a) Soft delete** + explicit in-use check. Consistent with Employee Master,
  recoverable, keeps historical rows resolvable.
- **(b) Hard delete** + explicit in-use check. Closer to DTA's observable
  behaviour.

*Recommendation: (a)*, because an employee record that references a purged
department id would otherwise render a blank field with no way to find out what
it used to say.

### O-4. Timezone list — recommendation only

DTA hardcodes seven. `Intl.supportedValuesOf('timeZone')` gives the real IANA
list from the Node/browser runtime with no dependency, and lets the server
validate what the client sent. Proposed: full list, `Asia/Kolkata` default. This
does not touch AD-12, which is about statutory PT/LWF slabs.

### O-5. Custom Fields tab placement — recommendation only

The API lives under `/employees/custom-fields` in both systems, but DTA's screen
sits in Org Structure. Proposed: follow DTA — the tab renders under `/hrms/org`
and calls the existing Employee Master API. No API move.

---

## P. Recommended implementation order

Each step leaves the build green and the app usable.

1. **Models + schemas** — `Department`, `Location`, `shared/schemas/org.js`,
   audit action constants. Unit tests for uniqueness, the code pattern and the
   optional-field fix.
2. **Services + providers** — CRUD, `employeeCount` aggregation filtered to live
   employees, the in-use delete guard, and the two reference providers.
   Register in `hrms.bootstrap.js`; `referencesReady()` turns true.
3. **Routes + controllers** — the 11 endpoints, guards, audit calls, `data`
   envelope. Backend tests including the envelope scan.
4. **Employee Master unlock** — enable the department/location selects and
   directory filters, honour `?departmentId=`, show names on the profile. No
   business-logic change; the 503 path stops being reachable.
5. **Org page shell** — `/hrms/org` + `/hrms/org/:tab` with `TabNav`, and add
   `org-structure` to `IMPLEMENTED_HRMS_MODULES` so the nav item appears.
6. **Departments and Locations tabs** — tables, drawers, delete confirmations.
7. **Custom Fields tab** — UI only, over the existing API.
8. **Org Chart tab** — port the layout maths, render with Tailwind + SVG, and
   resolve the access inconsistency from N-6.
9. **Import wiring** — bind `resolveDepartmentCodes`/`resolveLocationCodes`;
   the pipeline's unknown-code rejection already exists.

Steps 1–4 are backend-complete and independently shippable; 5–8 are the UI;
9 closes the AD-11 seam.
