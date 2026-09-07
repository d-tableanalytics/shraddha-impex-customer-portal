# DTA HRMS — Complete Module & Submodule Inventory

> Traced from `nav-items.ts`, `routes/index.tsx`, every `*.controller.ts`, every page's tab list, the Prisma schema and the RBAC matrix.
> "Submodule" = a tab, a distinct sub-route, or a separately-controlled sub-resource with its own controller.
>
> ⚠️ **SCOPE NOTE.** This is a complete inventory of the **source system as built**. Per **AD-5** ([`architecture-decisions.md`](architecture-decisions.md)), modules **#18 Operations** and **#19 Projects & Timesheets** are **OUT OF SCOPE** for the Shraddha replication — along with the `project_manager` role and the `operations` / `projects` RBAC module keys. They are documented below for completeness and traceability only.
>
> **In-scope totals: 22 modules · 81 submodules · 312 endpoints · 82 models · 8 roles · 31 module keys.**

---

## Summary counts

| Metric | Count |
|---|---:|
| Top-level nav modules | **22** |
| Non-nav authenticated routes | 2 (`/celebrations`, `/employees/analytics`) |
| Public routes | 4 (`/login`, `/careers`, `/careers/:slug`, `/careers/offer/:id`) |
| Hidden-but-live module | 1 (`Projects` — routes exist, nav entry commented out) |
| **Total functional modules** (nav + hidden + public careers) | **24** |
| **Total submodules** (tabs + sub-routes + sub-resource controllers) | **89** |
| Backend feature modules (NestJS) | 27 |
| Controllers | 66 |
| Services | 85 |
| HTTP endpoints | 350 |
| Prisma models | 93 |
| RBAC roles | 9 |
| RBAC module keys | 33 |

---

## Module map (one row per module)

| # | Module | Route | RBAC module key | Submodules | Endpoints | Primary models |
|---:|---|---|---|---:|---:|---|
| 1 | Dashboard / Home | `/` | `dashboard` | 4 role variants + 7 widgets | 4 | (aggregate) |
| 2 | Inbox | `/inbox` | `inbox` | 1 | 4 | `InboxItem` |
| 3 | Me (My Profile) | `/me` | `employees:*:self` | 1 | reuses employees | `Employee`, `User` |
| 4 | Employees | `/employees` | `employees`, `employees:compensation` | 6 | 22 | `Employee`, `CustomFieldDefinition`, `EmployeeUpload` |
| 5 | Attendance | `/attendance` | `attendance` | 3 | 11 | `AttendanceRecord`, `AttendanceCorrection` |
| 6 | Leave | `/leave` | `leave` | 4 | 14 | `LeaveType/Policy/Balance/Request`, `Holiday` |
| 7 | Payroll | `/payroll/:tab` | `payroll`, `payroll:structure` | 7 | 59 | 13 payroll models |
| 8 | Expenses & Travel | `/expenses/:tab` | `expenses` | 4 | 25 | 7 expense models |
| 9 | Onboarding | `/onboarding/:tab` | `onboarding` | 4 | 16 | 6 onboarding models |
| 10 | Exits | `/exits/:tab` | `exits` | 3 | 14 | 5 exit models |
| 11 | Documents | `/documents/:tab` | `documents` | 4 | 11 | `DocumentFolder`, `Document`, `PolicyDocument`, `DocumentAcknowledgment` |
| 12 | Assets | `/assets/:tab` | `assets` | 4 | 15 | `AssetCategory/Item/Assignment/Request` |
| 13 | Hiring (ATS) | `/hiring/:tab` | `hiring` | 6 | 36 | 7 hiring models |
| 14 | Performance | `/performance/:tab` | `performance` | 5 | 18 | `Goal`, `ReviewCycle`, `ReviewResponse`, `Feedback`, `OneOnOne` |
| 15 | Engage | `/engage/:tab` | `engage` | 4 | 17 | `Announcement`, `Poll`, `Recognition`, `ENps*` |
| 16 | Helpdesk | `/helpdesk/:tab` | `helpdesk`, `helpdesk:{hr,payroll,it}` | 3 | 8 | `TicketCategory`, `HelpdeskTicket`, `TicketComment`, `KbArticle` |
| 17 | Org Structure | `/org/:tab` | `org-structure` | 4 | 15 | `Department`, `Location`, `Designation`, `EmploymentType`, `CustomFieldDefinition` |
| 18 | Operations | `/operations` | `operations` | 4 + project detail | 26 | 6 Operations models |
| 19 | Projects & Timesheets | `/projects/:tab` **(nav removed)** | `projects` | 3 | 12 | `Project`, `ProjectMember`, `ProjectTask`, `TimesheetEntry`, `TimesheetPeriod` |
| 20 | Planning | `/planning` | `planning` | 2 | 4 | `HeadcountPlan`, `HiringPlan` |
| 21 | Reports | `/reports` | `reports`, `reports:{payroll,team,hiring,assets}` | 3 report defs | 3 | (aggregate) |
| 22 | Audit Logs | `/audit-logs` | `audit-logs` | 1 | 1 | `AuditLog` |
| 23 | Settings | `/settings/:tab` | `settings`, `settings:integrations` | 4 | 8 (rbac+integration) | `Role`, `Organization`, `SsoConfig`, `IntegrationConfig` |
| 24 | Careers (public) | `/careers*` | `@Public()` | 3 | 7 | `JobPosting`, `Candidate`, `Application`, `HiringOffer` |
| — | Celebrations | `/celebrations` | `dashboard` | 1 | (dashboard endpoint) | `Employee` |
| — | Auth | `/login` | `@Public()` | 1 | 4 | `User` |

---

# Module detail

---

## 1. Dashboard / Home — `/`

**Landing page for every role.** Two layers.

### Layer 1 — universal widgets (`HomeWidgets.tsx`, 506 LOC)
`GET /dashboard/widgets` returns all seven at once:
1. **Quick Access** — contextual shortcut tiles filtered by the actor's permissions
2. **Upcoming Holidays** — next holidays with days-until countdown and type tag
3. **Announcements** — most recent published announcements
4. **Active Polls** — with "Voted" / "Vote now" state
5. **On Leave Today** — avatar list, scope-aware (HR org-wide, manager team-only, employee hidden)
6. **Working Remotely** — employees who clocked in via mobile today, same scoping
7. **Celebrations** — upcoming birthdays and work anniversaries (deep-links to `/celebrations`)

### Layer 2 — role-specific KPIs (`DashboardPage.tsx`, 589 LOC)
`GET /dashboard/summary` returns a **discriminated union keyed by `role`**:
- `hr_admin` — headcount KPI tiles, Pending Actions widget, login-activity area chart, New Hires / Exits mini-feeds
- `manager` — team pulse (direct reports, present today, on leave, pending approvals) plus employee widgets
- `employee` — present days this month, today's status, leave balances
- `payroll_admin` — payroll run status, pending expense approvals

Supporting endpoints: `GET /dashboard/login-trend` (7/14/30-day selector, feeds `LoginTrendChart` — Recharts area chart), `GET /dashboard/celebrations`.

| Aspect | Present |
|---|---|
| Landing / Add / Edit / View / Delete | Landing only (read-only aggregate) |
| Search / Filters / Sorting / Pagination | Range selector on the login trend chart only |
| Permissions | `dashboard:view:self` — in `SELF_BASELINE`, so everyone |
| Business rules | Widget content is scope-filtered server-side; role determines the KPI union branch |

---

## 2. Inbox — `/inbox`

Unified actionable feed. Every module writes here via `InboxService`.

- `GET /inbox` — list
- `GET /inbox/unread-count` — drives the top-bar badge
- `POST /inbox/:id/read`
- `POST /inbox/read-all`

`InboxItem` fields: `type, title, body, entity, entityId, href, actionable, readAt`. `href` is a deep link into the originating module.
Permissions: `inbox:view:self` (baseline — everyone).
**13 modules depend on Inbox** — see the dependency map.

---

## 3. Me — `/me`

`MyProfilePage.tsx`. Self-service view of the actor's own `Employee` + `User` record. Backed by the employees endpoints under `self` scope (`employees:view:self`, `employees:edit:self` — both in `SELF_BASELINE`).

---

## 4. Employees (Core HR) — `/employees`

### Submodules
| Submodule | Route / file | Purpose |
|---|---|---|
| Directory (landing) | `/employees` — `EmployeesPage.tsx` (625 LOC) | Paginated, searchable, filterable table |
| Profile (view) | `/employees/:id` — `EmployeeProfilePage.tsx` (**1,303 LOC — the largest file in the repo**) | Full read view |
| Edit | `/employees/:id/edit` — `EmployeeEditPage.tsx` | Full edit form |
| Analytics | `/employees/analytics` — `EmployeeAnalyticsPage.tsx` | Headcount snapshot |
| Bulk import | `BulkImportModal.tsx` | CSV template → preview → commit |
| Custom fields | `/org/custom-fields` tab + `custom-fields.controller.ts` | Admin field builder |

### Landing page — capabilities
| Capability | Implementation |
|---|---|
| **Search** | `<Input allowClear placeholder="Search name / code / email">` → `?search=` |
| **Filters** | Department `<Select allowClear>`, Location `<Select allowClear>`, Status `<Select allowClear>` — also supports `?managerId=` and `?roleKey=` server-side |
| **Sorting** | AntD column sorters (client-side) |
| **Pagination** | **Server-side** — `?page=&pageSize=` (default 25, max 200), response `{data, total, page, pageSize}` |
| **Bulk selection** | AntD `rowSelection` with `preserveSelectedRowKeys`, selection toolbar appears when rows are selected. Row-click navigation is suppressed for clicks inside inline editors / popovers / select portals / modals |
| **Columns** | Employee (avatar + name + code), Email, Phone, Designation, Department, Location, Reporting Manager, Status badge, actions |
| **Add** | `EmployeeFormDrawer` |
| **Delete** | `DELETE /employees/:id` — `employees:delete:org`, super-admin only in practice |

### Employee form — fields (`EmployeeFormFields.tsx`, 726 LOC; schema in `shared-types/employee.ts`)

**Identity:** `employeeCode` (1–30), `firstName` (1–80), `lastName` (1–80), `displayName` (derived)
**Contact:** `email` (login, unique per org, citext), `personalEmail` (optional), `phone` ("Phone 1 (Personal)"), `phone2` (optional secondary)
**Dates:** `dateOfBirth` (optional, `YYYY-MM-DD`), `dateOfJoining` (**required**)
**Job:** `employmentType` (`full_time | part_time | contract | intern | consultant`), `designation`, `departmentId`, `locationId`, `reportingManagerId`
**Status:** `invited | active | probation | notice | exited | suspended | inactive`
**Family:** `fatherName`, `motherName`
**Address:** `permanentAddress`, `temporaryAddress` (multiline, max 1000; UI offers a copy action between them)
**Emergency contacts:** array **capped at 2** — `{name, relationship, phone (exactly 10 digits), email?}`
**Dependents:** array — `{name, relationship, dateOfBirth?, isNominee}`
**Custom fields:** `customFieldValues` JSON, driven by `CustomFieldDefinition` rows
**Create-only:** `sendInvite` (default true), `initialRoleKeys` (default `['employee']`), `probationMonths` (default 3)

### Conditional fields & dependencies (business rules — verified)
1. **Probation block reveals when relevant.** `probationStartDate` defaults to `dateOfJoining`; `probationEndDate = probationStartDate + probationMonths`. Editing months recomputes the end date; editing the end date recomputes months. All three then move independently.
2. **Notice block reveals only when `status = 'notice'`.** Same bidirectional `noticeMonths ↔ noticeEndDate` sync anchored on `noticeStartDate`.
3. **Department → Reporting Manager**: the manager `<Select>` is populated from the employee list; setting a manager recomputes the denormalised `managerChain`.
4. **Compensation section is permission-gated** — visible only with `employees:compensation:view:org`.
5. **Confirmation letter download** appears only after `confirmedAt` is set.
6. **Custom fields render by `type`** — `text | textarea | number | date | boolean | select | multiselect`; `options[]` drives select/multiselect; `required` enforced.

### Endpoints (22)
```
GET    /employees                          employees:view org|team|self
GET    /employees/:id                      + resourceParam 'id' for team/self
POST   /employees                          employees:create:org      @Audited
PATCH  /employees/:id                      employees:edit org|self
GET    /employees/:id/roles                employees:edit:org
PATCH  /employees/:id/roles                employees:edit:org
POST   /employees/:id/confirm              employees:edit:org
GET    /employees/:id/confirmation-letter  (PDF)
GET    /employees/:id/uploads
POST   /employees/:id/uploads              (multipart)
GET    /employees/:id/uploads/:uploadId    (download)
DELETE /employees/:id/uploads/:uploadId
POST   /employees/:id/reset-password       employees:edit:org
DELETE /employees/:id                      employees:delete:org
GET    /employees/analytics/snapshot       employees:view:org
GET    /employees/import/template.csv      employees:create:org
POST   /employees/import/preview           employees:create:org
POST   /employees/import/commit            employees:create:org
GET    /employees/custom-fields
POST   /employees/custom-fields            employees:edit:org
PATCH  /employees/custom-fields/:id        employees:edit:org
DELETE /employees/custom-fields/:id        employees:edit:org
```

### Business rules
- Creating an employee also creates the `User`, assigns roles, returns a `tempPassword`, optionally emails an invite.
- `POST /:id/confirm` → probation complete → `status = 'active'` → generate confirmation-letter PDF → email it.
- `status = 'inactive'` cascades to `User.status = 'suspended'` (account can no longer log in).
- 12 fixed upload categories, split into *personal* (one active per slot) and *previous employment* (multiple per company, grouped by `label`).

---

## 5. Attendance — `/attendance`

### Submodules (tabs, permission-filtered)
| Tab | Visible to | Content |
|---|---|---|
| My Attendance | everyone | `ClockInCard` (845 LOC) + own history table |
| Team | `attendance:view:team`+ | Team grid |
| Corrections | everyone (own) / approvers (queue) | Request + decide |

### Endpoints (11)
```
POST /attendance/clock-in            attendance:submit:self
POST /attendance/clock-out           attendance:submit:self
GET  /attendance/today               attendance:view:self
GET  /attendance                     attendance:view org|team|self
GET  /attendance/team-grid           attendance:view org|team
POST /attendance/upload-selfie       attendance:submit:self   (multipart)
GET  /attendance/selfie/:filename    @Public()
POST /attendance/corrections         attendance:submit:self
GET  /attendance/corrections         attendance:view org|team|self
POST /attendance/corrections/:id/decide  attendance:approve org|team
POST /attendance/biometric/:orgSlug  @Public() + HMAC
```

### Business rules
- Selfie + GPS captured on **both** clock-in and clock-out; selfie is skippable (camera denial still permits a punch).
- GPS is **reverse-geocoded via Nominatim** at punch time; the readable label is persisted.
- Biometric webhook verifies an **HMAC over the raw request body** with `BIOMETRIC_WEBHOOK_SECRET`.
- Correction queue is clearable by HR admin, super admin **and recruiter** (recruiter holds `attendance:approve:org` in the matrix).
- Fields: `date, clockIn, clockOut, source (web|mobile|biometric), status, geoLat, geoLng, notes`, plus the four selfie/location columns.

> ❌ **Not present**: shift management, shift rosters, rotational shifts, geofencing. The spec describes them; no model or endpoint exists.

---

## 6. Leave — `/leave`

### Submodules
| Tab | Visible to | Content |
|---|---|---|
| My Leave | everyone | Own requests + balances + `ApplyLeaveDrawer` (787 LOC) |
| Approvals | `leave:approve` holders | Decision queue |
| Team Calendar | team-scope holders | Calendar view |
| Holidays | everyone (read) / HR (write) | `HolidaysTab` + MP-defaults importer (`mp-holidays.ts`) |

### Endpoints (14)
```
GET  /leave/types                    leave:view:self
GET  /leave/balances/me              leave:view:self
GET  /leave/balances/:employeeId     leave:view org|team|self
POST /leave/requests                 leave:submit:self
GET  /leave/requests                 leave:view org|team|self
POST /leave/requests/:id/decide      leave:approve org|team
POST /leave/requests/:id/cancel      leave:submit:self
GET  /leave/calendar                 leave:view org|team
GET  /holidays                       leave:view:self
GET  /holidays/years                 leave:view:self
POST /holidays                       leave:edit:org
PATCH /holidays/:id                  leave:edit:org
DELETE /holidays/:id                 leave:edit:org
POST /holidays/bulk-import           leave:edit:org
```

### Apply-leave form — fields & conditional logic
`leaveTypeId`, `startDate`, `endDate`, `durationUnit` (`full_day | half_day | hourly | mixed`), `durationValue`, `halfDayPeriod` (AM/PM), `halfDaySlots` (JSON), `dayBreakdown` (JSON), `hourFrom`/`hourTo`, `reason`.

- Selecting `half_day` reveals the AM/PM period selector; `hourly` reveals the from/to time inputs; `mixed` reveals the per-day breakdown grid.
- `LeaveType.allowsHalfDay` gates the half-day option per type.
- `LeaveType.requiresProof` drives an attachment requirement.
- Holidays in the range are greyed out in the picker.

### Business rules (the most intricate in the system)
1. **Sandwich rule** — a weekend/holiday inside the range is deducted only when it sits between two **full** leave days. A half-day or hourly leave on either side breaks the sandwich. Hourly leave never absorbs surrounding non-working days.
2. **Only the direct reporting manager may approve.** Skip-level managers can view (team scope) but not approve. Org-scope holders (HR/super admin) keep an override so the org never deadlocks on an unreachable manager.
3. **Team scope for leave = own + direct reports only** — narrower than the generic team scope, to keep Approvals consistent with rule 2.
4. **Balances are advisory** — a request is never rejected for insufficient balance, and types with no seeded balance row still work. Pending/used counters move on submit and settle on decision.
5. Approval chain is a JSON array advanced step by step; a rejection at any level rejects the whole request. Self-approve when the requester has no manager.
6. Cancel is requester-only and only while pending.
7. Holiday fields: `name, date, year, type (national|state|festival|optional|restricted), region (ISO-3166-2), description, isOptional`.

---

## 7. Payroll — `/payroll/:tab` (largest module: 59 endpoints, 12 controllers)

### Submodules (tabs, permission-filtered)
| Tab | Gate | Content |
|---|---|---|
| Overview | all | `PayrollOverviewTab` |
| Payslips | all | Own payslips; org-wide with `payroll:view:org` |
| Advance Salary | all | `LoansTab` (790 LOC) |
| Pay Groups | `payroll:structure:edit` | `PayGroupsTab` |
| Structures | `payroll:structure:edit` | `StructuresTab` (628 LOC) |
| Runs | `payroll:run` | `RunsTab` (416 LOC) |
| Statutory | `payroll:structure:edit` | `StatutoryTab` |

### Endpoint groups
```
Pay groups        GET/POST/PATCH/DELETE  /pay-groups[/:id]
Salary components GET/POST/PATCH/DELETE  /salary-components[/:id]
Salary structures GET/POST/PATCH/DELETE  /salary-structures[/:id]
                  POST /salary-structures/:id/preview
Statutory config  GET/POST/PATCH/DELETE  /statutory-configs[/:id], GET /statutory-configs/current
Compensation      GET  /compensations/employee/:employeeId
                  GET  /compensations/employee/:employeeId/current
                  POST /compensations                     employees:compensation:edit:org
                  DELETE /compensations/:id
Runs              GET  /payroll/runs, GET /payroll/runs/:id
                  POST /payroll/runs                       payroll:run:org
                  POST /payroll/runs/:id/compute
                  POST /payroll/runs/:id/lock
                  POST /payroll/runs/:id/disburse
                  POST /payroll/runs/:id/rollback
Adjustments       GET/POST/DELETE /payroll/runs/:runId/adjustments[/:adjustmentId]
Bank files        POST/GET /payroll/runs/:runId/bank-files
                  GET  /payroll/runs/:runId/bank-files/files/:fileId/download
Exports           GET  /payroll/runs/:runId/exports/tally
                  GET  /payroll/runs/:runId/exports/quickbooks
Payslips          GET  /payslips/mine
                  GET  /payslips/employee/:employeeId       payroll:view:org
                  GET  /payslips/run/:runId
                  POST /payslips/adhoc
                  GET  /payslips/:id, GET /payslips/:id/pdf
Form 16           POST /form16/generate                     payroll:run:org
                  GET  /form16/employee/:employeeId
                  GET  /form16/:id/pdf
Advance salary    GET  /loans/mine, GET /loans, GET /loans/:id
                  POST /loans                               payroll:view:self
                  POST /loans/:id/approve                   payroll:approve:org
                  POST /loans/:id/reject
                  POST /loans/:id/accept-condition          (employee)
                  POST /loans/:id/decline-condition         (employee)
                  DELETE /loans/:id
```

### Business rules
- **Run lifecycle**: `draft → compute → lock → disburse`, with `rollback`.
- **Salary engine resolution order** (from `salary-engine.service.ts`): non-statutory formula components (two settlement passes) → per-employee `overrides` → preliminary gross → statutory bundle → statutory lines → loan auto-deductions → adjustments → totals by component type.
- **Statutory engines**, each unit-tested: **PF, ESI, PT (state slabs), LWF (state rules), TDS (old/new regime + exemptions)**.
- **LOP** from `leave-lop.ts`; per-day rate = monthly ÷ `daysInMonth`; 0.5-day granularity.
- **Advance Salary conditional approval**: the approver may attach `conditionText`; the employee must then accept (`conditionAcceptedAt`) or decline (`conditionDeclinedAt`). Approvers are HR admin **and recruiter** (both hold `payroll:approve:org`) plus super admin.
- HR admin can **view** payroll but **cannot run** it — only `payroll_admin` and `super_admin` hold `payroll:run:org`.
- `EmployeeCompensation` is effective-dated (`effectiveFrom`/`effectiveTo`) with a `revisionReason`.
- Reimbursement batches from Expenses link into a `PayrollRun`.
- Full & Final from Exits links into a `PayrollRun`.

---

## 8. Expenses & Travel — `/expenses/:tab`

### Submodules
| Tab | Gate | Content |
|---|---|---|
| Claims | all | `ClaimsTab` (415 LOC) — own claims + approval queue |
| Travel | all | `TravelTab` — travel requests + advances |
| Categories | `expenses:approve:org` | `CategoriesTab` |
| Reimbursement batches | `expenses:approve:org` | `BatchesTab` |

### Endpoints (25)
```
Categories  GET/POST/PATCH/DELETE  /expenses/categories[/:id]
Policies    GET  /expenses/policies, GET /expenses/policies/category/:categoryId
            POST/DELETE /expenses/policies[/:id]
Claims      GET  /expenses/claims, GET /expenses/claims/:id
            POST /expenses/claims                      expenses:submit:self
            POST /expenses/claims/:id/submit
            POST /expenses/claims/:id/decide           expenses:approve org|team
            POST /expenses/claims/:id/line-items/:lineId/receipt   (multipart)
            GET  /expenses/claims/line-items/:lineId/receipt
Travel      GET  /expenses/travel, GET /expenses/travel/:id
            POST /expenses/travel                      expenses:submit:self
            POST /expenses/travel/:id/decide
            POST /expenses/travel/:id/disburse         expenses:approve:org
Batches     GET/POST /expenses/reimbursement-batches
            POST /expenses/reimbursement-batches/:id/collect
            POST /expenses/reimbursement-batches/:id/link
```

### Business rules
- **Multi-level approval** via the `approvalChain` JSON (Manager → Finance).
- `ExpensePolicy` per category: `dailyLimit`, `monthlyLimit`, `requiresReceipt`, `requiresApproval`, **`autoApproveBelow`** (a claim under this amount skips approval).
- `ExpenseClaim` → many `ExpenseLineItem` (each with category, date, amount, description, optional receipt).
- Travel: `estimatedBudget`, `advanceRequested`, `itinerary` JSON, optional `TravelAdvance` with `disbursedAt`/`settledAt`.
- A claim may be linked to a `TravelRequest`, and collected into a `ReimbursementBatch`, which links to a `PayrollRun`.
- Categories carry `glCode` and `tallyLedger` for accounting export.

---

## 9. Onboarding — `/onboarding/:tab`

### Submodules
| Tab | Gate | Content |
|---|---|---|
| My onboarding | all | `NewHirePortal` — self-service |
| Checklists | `onboarding:view:team`+ | `ChecklistsTab` |
| Templates | `onboarding:edit:org` | `TemplatesTab` |
| Offer letters | `onboarding:edit:org` | `OffersTab` |

### Endpoints (16)
```
Templates   GET/POST/PATCH/DELETE /onboarding/templates[/:id]
Checklists  GET  /onboarding/checklists, GET /onboarding/checklists/:id
            POST /onboarding/checklists            onboarding:edit:org
            PATCH /onboarding/checklists/:id/tasks/:taskId
Offers      GET  /onboarding/offers
            GET  /onboarding/offers/employee/:employeeId
            POST /onboarding/offers                onboarding:edit:org
            POST /onboarding/offers/:id/send
            POST /onboarding/offers/:id/sign       onboarding:view:self  ← new hire e-signs
            POST /onboarding/offers/:id/reject     onboarding:view:self
            GET  /onboarding/offers/:id/pdf
```

### Business rules
- `OnboardingTemplate` scoped by `appliesToRoleKey` / `appliesToDepartmentId`; contains `OnboardingTaskTemplate[]` with `dueDays` and `assignTo` (HR / Buddy / Manager / New Hire).
- Instantiating a template creates an `OnboardingChecklist` + `OnboardingTask[]` with computed `dueDate`s.
- Offer letter → PDF (pdf-lib) → send → new hire signs (`SignaturePad.tsx`, `signature` JSON) or rejects.
- `AppointmentLetter` mirrors the offer flow.
- Open join-task counts surface on the HR dashboard.

---

## 10. Exits (Offboarding) — `/exits/:tab`

### Submodules
| Tab | Gate | Content |
|---|---|---|
| My exit | all | `MyExitTab` — initiate resignation |
| Clearance queue | clearance assignees | `ClearanceQueueTab` |
| Exit requests | `exits:view:team`+ | `ExitRequestsTab` (393 LOC) |

### Endpoints (14)
```
GET   /exits, GET /exits/:id
POST  /exits                          exits:submit:self       ← employee initiates
POST  /exits/:id/manager-approve      exits:approve:team
POST  /exits/:id/hr-approve           exits:edit:org
POST  /exits/:id/open-clearances      exits:edit:org
PATCH /exits/:id/clearances/:clearanceId
PATCH /exits/:id                      exits:edit:org
POST  /exits/:id/cancel
GET   /exits/:id/fnf/preview          exits:edit:org
POST  /exits/:id/fnf                  exits:edit:org
POST  /exits/:id/fnf/disburse         exits:edit:org
POST  /exits/:id/relieving-letter     exits:edit:org
GET   /exits/:id/relieving-letter/pdf
```

### Business rules
- **Two-stage approval**: manager (`managerApprovedAt`) → HR (`hrApprovedAt`), then clearances open.
- `ExitClearance` rows per `area` (IT / Finance / Admin / Asset) with an `assigneeUserId`. **IT Admin holds `exits:view:org`** specifically for the asset-clearance step.
- `ExitInterview` with `feedback` JSON and a `satisfactionScore`.
- `FullAndFinal`: `gross`, `deductions`, `netPayable`, `breakdown` JSON, links to a `PayrollRun` on disburse. Preview before commit.
- `RelievingLetter` PDF generated on completion.
- Exit reads `LoanAdvance` (outstanding recovery) and `ProjectMember` (handover) — cross-module data dependencies.
- `replacementEmployeeId` + `transferNotes` capture knowledge transfer.

---

## 11. Documents — `/documents/:tab`

### Submodules
| Tab | Gate | Content |
|---|---|---|
| Company library | all | `LibraryTab` |
| Policies | all | `PoliciesTab` — acknowledgment tracking |
| My documents | all | `MyDocumentsTab` |
| Folders | `documents:view:org` | `FoldersTab` — folder tree admin |

### Endpoints (11)
```
Folders  GET/POST/PATCH/DELETE /documents/folders[/:id]
Docs     GET    /documents
         POST   /documents/upload                 (multipart)
         GET    /documents/:id/download
         DELETE /documents/:id                    documents:view:org
         POST   /documents/policies               documents:view:org
         POST   /documents/acknowledgments
         GET    /documents/:id/acknowledgment-status  documents:view:org
```

### Business rules
- `DocumentFolder` is a **tree** (`parentId`) with `visibility`, `roleKeys[]` and `departmentIds[]` — access control is data-driven, not code-driven.
- `PolicyDocument` wraps a `Document` with `requiresAcknowledgment`, `requiresSignature`, `effectiveFrom`, `expiresAt`, `targetRoleKeys[]`.
- `DocumentAcknowledgment` records `userId`, `acknowledgedAt` and an optional `signature` JSON.
- A `Document` may be folder-scoped **or** employee-scoped (`employeeId`).

---

## 12. Assets — `/assets/:tab`

### Submodules
| Tab | Gate | Content |
|---|---|---|
| My assets | all | `MyAssetsTab` |
| Requests | all | `RequestsTab` |
| Inventory | `assets:assign:org` | `InventoryTab` |
| Categories | `assets:assign:org` | `CategoriesTab` |

### Endpoints (15)
```
GET    /assets/categories
POST   /assets/categories                assets:assign:org
DELETE /assets/categories/:id
GET    /assets/items                     assets:view:org
POST   /assets/items                     assets:assign:org
POST   /assets/items/assign
POST   /assets/assignments/:id/return
POST   /assets/items/:id/status
GET    /assets/assignments/mine          assets:view:self
GET    /assets/assignments/employee/:employeeId
GET    /assets/requests
POST   /assets/requests                  assets:view:self   ← employee requests
POST   /assets/requests/:id/decide       assets:assign:org
POST   /assets/requests/:id/fulfill      assets:assign:org
POST   /assets/requests/:id/cancel
```

### Business rules
- `AssetCategory.requiresSerialNumber` conditionally makes `serialNumber` mandatory on `AssetItem`.
- `AssetItem` tracks `purchaseDate`, `warrantyEnd`, `amcEnd`, `purchasePrice`, `status`, and a denormalised `currentAssignmentId`.
- Assign → `AssetAssignment` (with `conditionOnAssign`) → return (`returnedAt`, `conditionOnReturn`).
- `AssetRequest` flow: request → decide → fulfil (links `fulfilledAssetItemId`) or reject with a reason; requester can cancel.
- Assets tie into the exit clearance flow.

---

## 13. Hiring / ATS — `/hiring/:tab` (36 endpoints, 8 controllers)

### Submodules
| Tab | Gate | Content |
|---|---|---|
| Requisitions | `hiring:edit:org` | `RequisitionsTab` |
| Candidates | `hiring:edit:org` | `CandidatesTab` |
| Pipeline | `hiring:view:org` | `PipelineTab` — Kanban |
| My interviews | all with hiring access | `InterviewsTab` (522 LOC) |
| Postings | `hiring:edit:org` | `PostingsTab` |
| Offers | `hiring:edit:org` | `OffersTab` |

### Endpoints
```
Requisitions GET /hiring/requisitions, GET /hiring/requisitions/:id
             POST /hiring/requisitions                   hiring:edit:org
             POST /hiring/requisitions/:id/approve
             POST /hiring/requisitions/:id/status
Postings     GET  /hiring/postings
             POST /hiring/postings                       hiring:edit:org
             POST /hiring/postings/:id/publish
             POST /hiring/postings/:id/close
Candidates   GET  /hiring/candidates, GET /hiring/candidates/:id
             POST /hiring/candidates                     hiring:edit:org
             POST /hiring/candidates/:id/resume          (multipart)
             GET  /hiring/candidates/:id/resume
Applications GET  /hiring/applications, GET /hiring/applications/:id
             POST /hiring/applications
             POST /hiring/applications/:id/move          ← pipeline stage move
Interviews   GET  /hiring/interviews, GET /hiring/interviews/mine
             POST /hiring/interviews                     hiring:edit:org
             POST /hiring/interviews/:id/status
             GET  /hiring/interviews/:id/feedback
             POST /hiring/interviews/feedback
Offers       GET  /hiring/offers
             POST /hiring/offers                         hiring:edit:org
             POST /hiring/offers/:id/send
             GET  /hiring/offers/:id/pdf
AI           POST /hiring/ai/jd                          hiring:edit:org
PUBLIC       GET  /careers/postings                      @Public()
             GET  /careers/postings/:slug                @Public()
             POST /careers/postings/:slug/apply          @Public()
             GET  /careers/offer/:id                     @Public()
             GET  /careers/offer/:id/pdf                 @Public()
             POST /careers/offer/:id/accept              @Public()
             POST /careers/offer/:id/reject              @Public()
```

### Business rules
- Requisition → approval → `JobPosting` with a unique `publicSlug` → publish → public careers page.
- `Application.stage` drives the Kanban; `currentStageAt` timestamps each move.
- `Interview` has a `panel` JSON and `round` number; each panellist submits `InterviewFeedback` with `ratings` JSON and a `decision`.
- `HiringOffer` → PDF → send → the candidate accepts/rejects **on a public route** (no login), capturing a `signature`.
- Managers get an **interviewer-only view** (`hiring:view:team`).
- **7 public endpoints** with no authentication — the largest unauthenticated surface in the system.

---

## 14. Performance — `/performance/:tab`

### Submodules
| Tab | Gate | Content |
|---|---|---|
| My goals | all | `GoalsTab` |
| Reviews | all | `ReviewsTab` |
| Feedback | all | `FeedbackTab` |
| 1:1s | all | `OneOnOnesTab` |
| Cycles & calibration | `performance:approve:org` | `CyclesTab` |

### Endpoints (18)
```
Goals    GET /performance/goals
         POST /performance/goals               performance:submit:self
         PATCH /performance/goals/:id
         DELETE /performance/goals/:id
Cycles   GET  /performance/cycles
         POST /performance/cycles              performance:approve:org
         POST /performance/cycles/:id/phase
         GET  /performance/cycles/:id/calibration
Reviews  GET  /performance/reviews/mine
         GET  /performance/reviews             performance:view:org
         POST /performance/reviews
         POST /performance/reviews/:id/submit  performance:submit:self
Feedback GET  /performance/feedback/received
         GET  /performance/feedback/given
         POST /performance/feedback            performance:submit:self
1:1s     GET  /performance/one-on-ones
         POST /performance/one-on-ones         performance:approve:team  ← manager schedules
         PATCH /performance/one-on-ones/:id
```

### Business rules
- `Goal` is **self-referencing** (`parentGoalId`) for cascading/company-aligned OKRs; carries `targetValue`, `currentValue`, `unit`, `weight`, `status`, `dueDate`, optional `cycleId`.
- `ReviewCycle.phase` drives the workflow; `template` JSON defines the question set.
- `ReviewResponse.kind` distinguishes self / manager / peer (360°).
- `Feedback.visibility` controls who can see continuous feedback; `kind` classifies it.
- `OneOnOne` carries `agenda`, `notes` and `actionItems` JSON; only managers can schedule.
- Calibration view is HR/admin-only.

---

## 15. Engage — `/engage/:tab`

### Submodules
| Tab | Content |
|---|---|
| Announcements | `AnnouncementsTab` |
| Polls & Surveys | `PollsTab` |
| Recognition | `RecognitionTab` |
| eNPS | `ENpsTab` (rendered inside the polls/surveys area) |

### Endpoints (17)
```
GET  /engage/announcements
POST /engage/announcements                engage:edit:org
POST /engage/announcements/:id/publish
DELETE /engage/announcements/:id
GET  /engage/polls
POST /engage/polls                        engage:edit:org
POST /engage/polls/:id/respond            engage:view:self
GET  /engage/polls/:id/results            engage:edit:org
GET  /engage/recognitions/wall
GET  /engage/recognitions/received
POST /engage/recognitions                 engage:view:self   ← peer-to-peer
GET  /engage/badges
POST /engage/badges                       engage:edit:org
GET  /engage/enps
POST /engage/enps                         engage:edit:org
POST /engage/enps/:id/respond             engage:view:self
GET  /engage/enps/:id/results             engage:edit:org
```

### Business rules
- `Announcement` targeting by `targetRoleKeys[]` and `targetDepartmentIds[]`; draft until `publishedAt`; `expiresAt`; `mediaKeys[]`.
- `Poll.anonymous` → `PollResponse.respondentUserId` is nullable. `kind` distinguishes poll vs pulse survey.
- `Recognition` peer-to-peer with an optional `RecognitionBadge`, `teamVisible` and `anonymous` flags.
- `ENpsSurvey` → `ENpsResponse.score` (0–10) → NPS calculation in `enps.service.ts`.

---

## 16. Helpdesk — `/helpdesk/:tab`

### Submodules
| Tab | Gate | Content |
|---|---|---|
| My Tickets | all | `MyTicketsTab` + `TicketDetailDrawer` |
| Resolver Queue | resolvers | `QueueTab` (inserted at index 1) |
| Knowledge Base | all | `KbTab` |

### Endpoints (8)
```
GET   /helpdesk/tickets                helpdesk:view:self
GET   /helpdesk/tickets/:id
POST  /helpdesk/tickets                helpdesk:submit:self
PATCH /helpdesk/tickets/:id            helpdesk:resolve:org
GET   /helpdesk/tickets/:id/comments
POST  /helpdesk/tickets/:id/comments
GET   /helpdesk/kb
POST  /helpdesk/kb/search
```

### Business rules
- **Category-scoped resolution** is the distinctive rule: `helpdesk:hr:resolve:org` (HR admin), `helpdesk:payroll:resolve:org` (payroll admin), `helpdesk:it:resolve:org` (IT admin). Super admin holds the unscoped `helpdesk:resolve:org`.
- `TicketCategory.slaHours` + `defaultAssigneeRoleKey` drive routing and SLA timers.
- `TicketComment.internal` hides resolver-only notes from the requester.
- `HelpdeskTicket` supports soft delete (`deletedAt`).

---

## 17. Org Structure — `/org/:tab`

### Submodules
| Tab | Gate | Content |
|---|---|---|
| Departments | `org-structure:edit:org` | `DepartmentsTab` |
| Locations | `org-structure:edit:org` | `LocationsTab` |
| Custom Fields | `org-structure:edit:org` | `CustomFieldsTab` |
| Org Chart | all with org-structure view | Inline in `OrgSettingsPage.tsx` |

### Endpoints (15)
```
GET/POST/PATCH/DELETE /departments[/:id]     view: org-structure:view:self  write: edit:org
GET/POST/PATCH/DELETE /locations[/:id]       same
GET   /organization/current                  settings:view:org
GET   /organization/tree                     org-structure view
GET   /organization/logo                     @Public()
POST  /organization/logo                     settings:edit:org  (multipart)
PATCH /organization/current                  settings:edit:org
```

### Business rules
- **Org chart is hand-rolled**, no charting library: an absolutely-positioned canvas with SVG S-curve bezier connectors. `calcLayout` + `nudgeX` recursively compute subtree widths and centre each node over its children. Constants: `CW=172, CH=96, HG=36, VG=64, PAD=28`. Multiple roots are laid out side by side.
- `Department` is a **self-referencing tree** (`parentId`) with an optional `headEmployeeId`.
- **Every authenticated user holds `org-structure:view:self`** in `SELF_BASELINE` — department and location names appear on every profile, so any user must be able to resolve those UUIDs to labels.
- `Designation` and `EmploymentType` are ordered, activatable lookup tables (seeded by dedicated scripts) — **easy to miss as "master data" modules**.

---

## 18. Operations — `/operations` (26 endpoints)

> Not a standard HR module. D-Table's internal Jira-style project tracker, layered into the HRMS. It **overlaps the `projects` module**.

### Submodules
| Tab / route | Gate | Content |
|---|---|---|
| Projects | all | `ProjectsTab` + `OperationsProjectCard` |
| My Tasks | all | `MyOperationsTasksList` |
| My Updates | all | `DailyUpdatesTab` (406 LOC) |
| Reports | managers/HR/recruiter | `ReportsTab` (**1,209 LOC — second largest file**) |
| Project detail | `/operations/projects/:id` | `OperationsProjectPage` + `OperationsBoard` (Kanban) |

### Endpoints
```
Projects GET  /operations/projects, GET /operations/projects/:id
         POST /operations/projects                 operations:edit:org
         PATCH /operations/projects/:id
         DELETE /operations/projects/:id
         GET/POST /operations/projects/:id/members
         DELETE /operations/projects/:id/members/:memberId
Tasks    GET  /operations/projects/:projectId/board
         GET  /operations/tasks/mine
         GET  /operations/projects/:projectId/tasks/:taskId
         POST /operations/projects/:projectId/tasks
         PATCH /operations/projects/:projectId/tasks/:taskId
         DELETE /operations/projects/:projectId/tasks/:taskId
         POST /operations/projects/:projectId/tasks/:taskId/comments
Updates  GET  /operations/updates/mine
         POST /operations/updates                  operations:submit:self
         DELETE /operations/updates/:id
         GET  /operations/updates/project/:projectId
Reports  GET  /operations/reports/project
         GET  /operations/reports/project.pdf
         GET  /operations/reports/by-manager, .pdf
         GET  /operations/reports/by-employee, .pdf
         POST /operations/reports/summarize        ← optional Claude call
```

### Business rules
- **`project_manager` deliberately lacks `operations:view:org`** — a PM sees only their own projects (list/view falls back to owner/member scope). Cross-PM awareness for shared employees is exposed through each update's `otherProjects` field instead.
- `manager` holds `operations:view:org` + `edit:org` because Operations membership crosses reporting lines.
- Everyone holds `operations:edit:self` — an employee moves their own card across columns and comments.
- `OperationsProject.taskCounter` generates per-project sequential `taskNumber`s.
- `OperationsTaskActivity` records before/after JSON on every change.
- Daily updates carry `hoursSpent` and `blockers`; markdown-edited.
- `ea-elevation.ts` implements an "Executive Assistant" privilege elevation (frontend `use-is-ea.ts`) — an undocumented, easily-missed rule.
- PDF reports: `operations-report-pdf.ts` (880 LOC), `operations-manager-report-pdf.ts`, `operations-employee-report-pdf.ts`.

---

## 19. Projects & Timesheets (PSA) — `/projects/:tab` — **nav entry removed, routes live**

### Submodules
| Tab | Gate |
|---|---|
| Projects | all |
| My Timesheet | all |
| Utilization | `projects:view:org` |

### Endpoints (12)
```
GET  /projects, GET /projects/:id
POST /projects                              projects:edit:org
GET/POST /projects/:id/members
GET/POST /projects/:id/tasks
GET  /projects/timesheets/mine
POST /projects/timesheets                   projects:submit:self
POST /projects/timesheets/submit
POST /projects/timesheets/periods/:id/approve   projects:approve:team
GET  /projects/utilization/report            projects:view:org
```

### Business rules
- `TimesheetPeriod` is weekly (`weekStartDate`), with `submittedAt` / `approvedByUserId` / `approvedAt`.
- `Project.billability` drives the utilization report.
- `ProjectMember.allocationPercent` feeds resource planning.
- **Decision needed**: this module and Operations duplicate each other. See the replication plan.

---

## 20. Planning — `/planning`

### Submodules
| Tab | Content |
|---|---|
| Headcount | `HeadcountPlan` — planned vs actual, budget per head, total budget, utilization % |
| Hiring Plan | `HiringPlan` — role, planned-by date, actual-by date, status |

### Endpoints (4)
```
GET  /planning/headcount     planning:view:org
POST /planning/headcount     planning:edit:org
GET  /planning/hiring        planning:view:org
POST /planning/hiring        planning:edit:org
```

Optionally links a `HiringPlan` to a `JobRequisition`; both plans are department-scoped and financial-year-keyed.

---

## 21. Reports — `/reports`

### Endpoints (3)
```
GET /reports/catalog            any of the reports:* permissions
GET /reports/:key/run           any of the reports:* permissions
GET /reports/:key/export.csv    reports:*:export
```

**Only three report definitions exist** in `reports.service.ts`:
| Key | Label | Columns |
|---|---|---|
| `employees_directory` | Employee Directory | Code, Name, Email, Department, Designation, Join Date |
| `attendance_monthly` | Monthly Attendance Summary | Code, Name, Present Days |
| `leave_balances` | Leave Balances (current year) | Code, Name, Leave Type, Balance |

The route gate accepts **any** of `reports`, `reports:payroll`, `reports:hiring`, `reports:assets`, `reports:team` — deliberately, so a recruiter who *sees* the nav item isn't bounced when they click it. Filtering of which catalog entries each role sees happens inside the service.

---

## 22. Audit Logs — `/audit-logs`

`GET /audit-logs` — `audit-logs:view:org`. Read-only viewer over `AuditLog` (`actorUserId, action, entity, entityId, method, path, payload, createdAt`). Rows are written by the `AuditInterceptor` on `@Audited()` handlers plus explicit writes (notably `auth.login`).

---

## 23. Settings — `/settings/:tab`

### Submodules
| Tab | Gate | Content |
|---|---|---|
| Company Profile | `settings:edit:org` | `CompanyProfileTab` — name, logo upload, brand JSON |
| Roles & Permissions | `settings:edit:org` | `RolesTab` (456 LOC) — custom role builder |
| Single Sign-On | `settings:integrations:edit:org` | `SsoTab` |
| Integrations | `settings:integrations:edit:org` | `IntegrationsTab` |

### Endpoints
```
GET/POST/PATCH/DELETE /roles[/:id]     settings:view|edit :org
GET/POST  /integrations/sso            settings:integrations:edit:org
GET/POST  /integrations                settings:integrations:edit:org
GET/PATCH /organization/current        settings:view|edit :org
POST      /organization/logo           settings:edit:org
POST      /admin/reset-dtable-seed     settings:edit:org
```

### Business rules
- **Custom roles are real.** `Role.isSystem` protects the 9 seeded roles; org admins can create additional roles and attach arbitrary `module × action × scope` permissions.
- `Organization.brand` JSON is applied to CSS variables at runtime — per-tenant theming.
- `SsoConfig` stores Google/Microsoft OAuth client credentials. `sso.service.ts` declares the endpoint URLs but **is not wired into the login flow** — configuration only.
- `IntegrationConfig` is a generic `{kind, config JSON, active}` store.

---

## 24. Careers (public) — `/careers*`

`PublicShell`, no authentication:
| Page | Route |
|---|---|
| `CareersHome` | `/careers` |
| `CareersPostingPage` | `/careers/:slug` |
| `OfferAcceptPage` | `/careers/offer/:id` |

Backed by the 7 `@Public()` endpoints under `/careers` in `public-careers.controller.ts`.

---

## 25. Celebrations — `/celebrations`

Not in the nav; deep-linked from the dashboard Celebrations widget. Lists upcoming birthdays and work anniversaries, scope-aware. Backed by `GET /dashboard/celebrations`.

---

## Master / lookup modules that are easy to overlook

| Lookup | Where managed | Why it matters |
|---|---|---|
| `Designation` | seeded by `seed-designations.ts`; ordered + `active` flag | The employee form's designation dropdown |
| `EmploymentType` | seeded by `seed-employment-types.ts` | Employment-type dropdown |
| `LeaveType` / `LeavePolicy` | seeded; no admin CRUD UI found | Leave module cannot function without these rows |
| `Holiday` | full CRUD + bulk import (`/holidays`) | Drives the leave sandwich rule |
| `ExpenseCategory` / `ExpensePolicy` | Expenses → Categories tab | Gates claim submission and auto-approval |
| `AssetCategory` | Assets → Categories tab | Gates serial-number requirement |
| `TicketCategory` | seeded; no admin CRUD UI found | Drives helpdesk routing and SLA |
| `SalaryComponent` / `SalaryStructure` / `PayGroup` / `StatutoryConfig` | Payroll tabs | Payroll cannot run without all four |
| `RecognitionBadge` | `POST /engage/badges` | Recognition wall |
| `CustomFieldDefinition` | Org Structure → Custom Fields | Dynamic employee fields |
| `Permission` (global catalog) | seeded from `PERMISSION_MATRIX` | **The whole authorization system** |

---

## Submodule tally (89)

Employees 6 · Attendance 3 · Leave 4 · Payroll 7 · Expenses 4 · Onboarding 4 · Exits 3 · Documents 4 · Assets 4 · Hiring 6 · Performance 5 · Engage 4 · Helpdesk 3 · Org Structure 4 · Operations 5 · Projects 3 · Planning 2 · Settings 4 · Reports 3 · Careers 3 · Dashboard 4 role variants + 7 widgets = 11 · Inbox 1 · Me 1 · Audit Logs 1 · Celebrations 1 · Auth (login) 1
