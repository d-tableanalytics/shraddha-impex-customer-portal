# HRMS Dependency Map & Implementation Order

> Derived from **actual code**, not assumed. Three evidence sources:
> 1. **Cross-module service imports** — `grep "from '../<module>/"` across all `*.service.ts` / `*.controller.ts` / `*.module.ts`
> 2. **Prisma model usage per module** — every `tx.<model>.` call, grouped by owning module
> 3. **The RBAC matrix** — which module keys each role needs before a screen can render

---

## 1. Evidence — cross-module service imports

Only **one** service crosses module boundaries in DTA HRMS:

```
onboarding  ──┐
hiring      ──┤
expense     ──┤
operations  ──┤
leave       ──┤
exit        ──┤
engage      ──┤──→  inbox  (InboxService + MailService)
attendance  ──┤
asset       ──┤
performance ──┤
helpdesk    ──┤
employees   ──┤
document    ──┘
```

**13 of 27 modules depend on Inbox.** Nothing else is injected across module lines — every other coupling is via **shared data**, not shared code.

---

## 2. Evidence — cross-domain model access

Each module and the models it touches that it does **not** own:

| Module | Foreign models it reads/writes |
|---|---|
| `auth` | `user`, `employee`, `auditLog` |
| `rbac` | `permission`, `role`, `rolePermission` |
| `organization` | `department`, `location`, **`employee`** |
| `employees` | `user`, `userRole`, `role`, `department`, `location`, `customFieldDefinition`, `employeeUpload`, **`leaveType`**, **`leaveBalance`** |
| `attendance` | `employee`, `user` |
| `leave` | `employee`, `user`, **`holiday`** |
| `payroll` | `employee`, `userRole`, **`holiday`**, **`leaveRequest`**, **`expenseClaim`**, **`reimbursementBatch`**, `loanAdvance` |
| `expense` | `employee`, `user`, **`payrollRun`** |
| `onboarding` | `employee`, `user`, `userRole` |
| `exit` | `employee`, `user`, `userRole`, **`loanAdvance`**, **`projectMember`** |
| `document` | `user`, `userRole` |
| `asset` | `employee`, `user`, `userRole` |
| `hiring` | `user` (→ converts hired candidates into onboarding records) |
| `performance` | `employee`, `user` |
| `engage` | `employee`, `user`, `userRole` |
| `helpdesk` | *(none — self-contained)* |
| `project` | `employee` |
| `operations` | `employee`, `user` |
| `planning` | **`department`**, **`employee`** |
| `reports` | **`employee`**, **`attendanceRecord`**, **`leaveBalance`** |
| `dashboard` | **`employee`**, `user`, **`holiday`**, **`leaveRequest`**, **`leaveBalance`**, **`attendanceRecord`**, **`attendanceCorrection`**, **`announcement`**, **`poll`**, **`pollResponse`** |
| `audit` | `auditLog`, `user` |
| `admin` | ~65 models (destructive reseed helper — depends on everything) |
| `inbox` | `inboxItem` *(leaf — depends on nothing)* |
| `integration` | `ssoConfig`, `integrationConfig` *(leaf)* |
| `health`, `queues` | *(none)* |

**Bold** entries are the couplings that actually constrain build order.

---

## 3. The dependency graph

### Layer 0 — Foundation (nothing depends on anything above it)

```
┌───────────────────────────────────────────────────────────┐
│  Organization / CompanyProfile                            │
│      ↓                                                    │
│  User  ──1:1──  Employee                                  │
│      ↓                                                    │
│  Role ──n:m── Permission   (module × action × scope)      │
│      ↓                                                    │
│  Auth (login, refresh, logout, /me)                       │
└───────────────────────────────────────────────────────────┘
                          ↓
        ┌─────────────────┴─────────────────┐
        ↓                                   ↓
   Department (tree)                   OfficeLocation
   Designation                         EmploymentType
        └─────────────────┬─────────────────┘
                          ↓
                   CustomFieldDefinition
                          ↓
                  ┌───────────────┐
                  │  Inbox + Mail │  ← LEAF. 13 modules depend on it.
                  │  AuditLog     │     Depends on nothing.
                  └───────────────┘
```

**Nothing else can be built until this layer exists.** Every module reads `employee`; 13 write to `inbox`.

### Layer 1 — Daily operations

```
Employee ──→ Attendance ──→ AttendanceCorrection
   │              └──────────────→ Inbox

Employee ──→ LeaveType ──→ LeavePolicy ──→ LeaveBalance
   │              └──────→ LeaveRequest ──→ Inbox
   │                            ↑
Holiday ────────────────────────┘   (sandwich rule reads holidays)
   ↑
Employee.reportingManagerId + managerChain[]   (approval routing)
```

> ⚠️ **Hidden dependency:** `employees.service.ts` reads `leaveType` and writes `leaveBalance` **when creating an employee** — leave types must exist before the first employee is created, or new employees get no balance rows. `LeaveType` is seeded, with no admin CRUD UI.

> ⚠️ **Hidden dependency:** `Holiday` must exist before any leave request can be correctly costed — the sandwich rule reads it.

### Layer 2 — Money

```
PayGroup ──→ SalaryStructure ──→ SalaryStructureComponent ──→ SalaryComponent
    │              └──→ EmployeeCompensation ←── Employee
    │
StatutoryConfig ──→ [PF | ESI | PT | LWF | TDS engines]
    │
    └──→ PayrollRun ──→ Payslip ──→ (pdf-lib)
              ├──→ PayrollAdjustment
              ├──→ BankFile
              └──→ Form16
    ↑     ↑     ↑
    │     │     └── LoanAdvance (auto-deduction)
    │     └──────── LeaveRequest → LOP calculation
    └────────────── Holiday → working-day count

ExpenseCategory ──→ ExpensePolicy
       └──→ ExpenseClaim ──→ ExpenseLineItem
                 ├──→ TravelRequest ──→ TravelAdvance
                 └──→ ReimbursementBatch ──→ PayrollRun
```

**Payroll ← Leave** (LOP), **Payroll ← Holiday** (working days), **Payroll ↔ Expenses** (reimbursement batches link into a run), **Payroll ← LoanAdvance**.

> ⚠️ **Circular-looking but resolvable:** `expense` reads `payrollRun`, and `payroll` reads `expenseClaim`/`reimbursementBatch`. The actual sequence is: claims exist → a batch collects them → the batch links to a run. Build **Payroll first**, then Expenses, then wire the link.

> ⚠️ **Payroll cannot run** without all four of `PayGroup`, `SalaryStructure`, `SalaryComponent`, `StatutoryConfig` seeded.

### Layer 3 — Employee lifecycle

```
OnboardingTemplate ──→ OnboardingTaskTemplate
       └──→ OnboardingChecklist ←── Employee
                 └──→ OnboardingTask ──→ Inbox
OfferLetter / AppointmentLetter ←── Employee   (pdf + e-signature)

ExitRequest ←── Employee
   ├──→ ExitClearance ──→ Inbox
   ├──→ ExitInterview
   ├──→ RelievingLetter (pdf)
   └──→ FullAndFinal ──→ PayrollRun
        ↑          ↑
        │          └── ProjectMember (handover)
        └── LoanAdvance (outstanding recovery)

DocumentFolder (tree) ──→ Document ──→ PolicyDocument ──→ DocumentAcknowledgment
                              ↑
                        Employee (employee-scoped docs)
EmployeeUpload ←── Employee   (12 fixed categories)

AssetCategory ──→ AssetItem ──→ AssetAssignment ←── Employee
       └──→ AssetRequest ──→ Inbox
                 └──→ (exit clearance reads assignments)
```

> ⚠️ **Exits depends on Payroll** (F&F → `PayrollRun`), **on LoanAdvance** (recovery) and **on ProjectMember** (handover). Building Exits before Payroll leaves F&F stubbed.

> ⚠️ **Exits depends on Assets** for the asset-clearance step (and `it_admin` holds `exits:view:org` purely for that).

### Layer 4 — Talent & culture

```
JobRequisition ←── Department, OfficeLocation
      └──→ JobPosting (publicSlug) ──→ [PUBLIC careers site]
              └──→ Application ←── Candidate
                       ├──→ Interview ──→ InterviewFeedback
                       └──→ HiringOffer ──→ (accept) ──→ Onboarding/Employee

ReviewCycle ──→ ReviewResponse ←── Employee
Goal (self-ref tree) ←── Employee, ReviewCycle
Feedback, OneOnOne ←── User

Announcement ──→ Dashboard widget
Poll ──→ PollResponse ──→ Dashboard widget
RecognitionBadge ──→ Recognition ←── Employee
ENpsSurvey ──→ ENpsResponse

TicketCategory ──→ HelpdeskTicket ──→ TicketComment ──→ Inbox
KbArticle
```

> ⚠️ **Hiring → Onboarding**: accepting an offer converts a candidate into an employee/onboarding record. Onboarding must exist first, or the conversion is a stub.
> ⚠️ **Dashboard reads Announcement + Poll + PollResponse** — the Engage widgets on the home page cannot render until Engage exists.
> ✅ **Helpdesk is fully self-contained** (only `Inbox`) — the single best candidate for an early independent slice.

### Layer 5 — Reporting & aggregation

```
Dashboard  ←── Employee, Holiday, LeaveRequest, LeaveBalance,
               AttendanceRecord, AttendanceCorrection,
               Announcement, Poll, PollResponse
Reports    ←── Employee, AttendanceRecord, LeaveBalance
Planning   ←── Department, Employee, (JobRequisition)
AuditLogs  ←── AuditLog (written throughout by the audit layer)
```

**Dashboard has the widest read surface of any module (10 foreign models).** It must be built last, or built incrementally as each source module lands.

### Layer 6 — Optional / out of core scope

```
Project ──→ ProjectMember, ProjectTask
       └──→ TimesheetEntry ──→ TimesheetPeriod
              ↑
        (Exit reads ProjectMember for handover)

OperationsProject ──→ OperationsProjectMember
        └──→ OperationsTask ──→ OperationsTaskComment, OperationsTaskActivity
        └──→ OperationsDailyUpdate
        └──→ [AI summariser — Anthropic API]

SsoConfig, IntegrationConfig   (leaves)
```

---

## 4. Condensed dependency chain

```
CompanyProfile
     ↓
User + Employee + Role/Permission  ────────────→  Auth
     ↓
Department · OfficeLocation · Designation · EmploymentType · CustomFields
     ↓
Inbox + Mail + AuditLog                    ← 13 modules depend on this leaf
     ↓
     ├──→ Attendance
     ├──→ Holiday ──→ Leave ──────────────┐
     │                                     ↓
     ├──→ PayGroup/Structure/Components/Statutory ──→ Payroll ──┐
     │                                                           ↓
     ├──→ Expenses ──→ ReimbursementBatch ─────────────────────→ ┤
     │                                                           ↓
     ├──→ Assets ──────────────────────────┐                    │
     ├──→ Documents                        ↓                    ↓
     ├──→ Onboarding ──────────────→  Exits (F&F, clearances) ←─┘
     │        ↑                            ↑
     │        └── Hiring (offer→hire)      └── LoanAdvance
     │
     ├──→ Performance
     ├──→ Engage ──────────────┐
     ├──→ Helpdesk  (isolated) │
     ├──→ Planning             │
     │                         ↓
     └──────────────────→  Dashboard  ←── Attendance, Leave, Employee, Holiday
                              ↓
                           Reports
```

---

## 5. Hidden dependencies — easy to miss, expensive to discover late

| # | Dependency | Where it lives | Consequence if missed |
|---|---|---|---|
| 1 | **`Employee.managerChain[]`** is denormalised and recomputed on every manager change | `employees/manager-chain.ts` | Every `team`-scope permission check silently fails. Managers see nothing |
| 2 | **`org-structure:view:self` is in `SELF_BASELINE`** | `packages/rbac/src/matrix.ts` | Without it, no user can resolve a department or location UUID to a label — every profile shows raw IDs |
| 3 | **Employee creation seeds `LeaveBalance` rows** by reading `LeaveType` | `employees.service.ts` | New employees have no leave balances; the leave widget is empty |
| 4 | **Leave duration reads `Holiday`** for the sandwich rule | `leave.service.ts` `computeDuration` | Leave is mis-costed. Payroll LOP is then wrong |
| 5 | **Payroll LOP reads `LeaveRequest`** | `payroll/leave-lop.ts` | Payroll cannot deduct loss of pay |
| 6 | **Payroll working days read `Holiday`** | `payroll-run.service.ts` | Per-day rate is wrong |
| 7 | **Exit F&F reads `LoanAdvance`** for outstanding recovery | `full-and-final.service.ts` | Employees exit without loan recovery |
| 8 | **Exit reads `ProjectMember`** for handover | `exit-request.service.ts` | Handover step is blank |
| 9 | **Exit clearance depends on `AssetAssignment`** | asset-clearance area | IT cannot clear assets |
| 10 | **`it_admin` holds `exits:view:org`** solely for asset clearance | `matrix.ts` | IT admin locked out of the clearance queue |
| 11 | **`recruiter` holds `payroll:approve:org`** (advance-salary approval) and `attendance:approve:org` | `matrix.ts` | Non-obvious grant; queues go unattended if dropped |
| 12 | **`hr_admin` holds `payroll:view` but NOT `payroll:run`** | `matrix.ts` | Separation of duties — must be preserved |
| 13 | **`project_manager` deliberately lacks `operations:view:org`** | `matrix.ts` | PMs would see every other PM's projects |
| 14 | **Leave team scope = direct reports only** (narrower than generic team scope) | `leave.service.ts` `buildScopeFilter` | Skip-level managers get an approvals queue they must not have |
| 15 | **Only the direct manager may approve leave**; org-scope holders override | `leave.service.ts` `decideRequest` | Approval routing breaks; orgs deadlock on unreachable managers |
| 16 | **Dashboard reads Announcement + Poll + PollResponse** | `widgets.service.ts` | Home page widgets 404 until Engage exists |
| 17 | **Dashboard login-trend reads `AuditLog`** rows with `action='auth.login'` | `auth.service.ts` writes them | Chart is empty unless login writes audit rows |
| 18 | **`Permission` is a global catalog** (no `organizationId`), seeded from `PERMISSION_MATRIX` | `prisma/seed.ts` | Nothing authorizes at all if this seed is skipped |
| 19 | **Hiring offer acceptance converts a candidate into an employee** | `hiring-offer.service.ts` | Hiring dead-ends without Onboarding |
| 20 | **Attendance calls Nominatim synchronously** at clock-in | `attendance.service.ts` | Clock-in latency is bound to a third-party public API |
| 21 | **Biometric webhook needs the raw request body** for HMAC | `main.ts` `rawBody: true` | HMAC verification fails if the body is pre-parsed (Express needs `express.raw()` on that route) |
| 22 | **Designation / EmploymentType are seeded lookups** with no admin UI | `seed-designations.ts`, `seed-employment-types.ts` | Employee form dropdowns are empty |
| 23 | **`TicketCategory` is seeded** with no admin CRUD | — | Helpdesk cannot route or apply SLAs |
| 24 | **Expense `autoApproveBelow`** silently skips approval | `expense-policy` | Approval flow appears broken if the policy is misread |
| 25 | **Probation/notice date sync is bidirectional** | `EmployeeFormFields.tsx` + service | Editing months must recompute the end date and vice versa |
| 26 | **`emergencyContacts` capped at 2, phone exactly 10 digits** | `shared-types/employee.ts` | Validation parity is lost silently |
| 27 | **`ea-elevation.ts` / `use-is-ea.ts`** — an undocumented Executive-Assistant privilege elevation in Operations | `operations/ea-elevation.ts` | Behaviour differs for EA users with no visible reason |
| 28 | **13 modules inject `InboxService`** | across the codebase | Build Inbox first or retrofit 13 modules |

---

## 6. Authentication & permission dependencies

Nothing renders until this chain is complete:

```
1. Permission catalog seeded      (module × action × scope tuples)
2. Roles seeded + linked          (PERMISSION_MATRIX → Role → RolePermission)
3. User ↔ Role assignment         (UserRole)
4. Employee record exists         (departmentId, managerChain[])
5. /auth/me returns {roleKeys, permissions[]}
6. Frontend usePermissions() builds an Actor
7. Nav filter + route gate + button gates evaluate hasPermission()
8. Backend guard evaluates the same hasPermission() on every request
```

**Break any link and the entire UI renders empty** — the nav filter fails closed, exactly as designed.

---

## 7. Database dependencies (creation order)

```
1.  CompanyProfile
2.  Permission (catalog)          ← seed from the matrix
3.  Role → RolePermission
4.  Department (tree, self-ref)
5.  OfficeLocation
6.  Designation, EmploymentType   ← seeded lookups
7.  User → UserRole
8.  Employee                      ← needs Department, OfficeLocation, User; sets managerChain
9.  CustomFieldDefinition
10. LeaveType → LeavePolicy       ← MUST precede employee creation (balance seeding)
11. Holiday                       ← MUST precede any leave request
12. PayGroup → SalaryComponent → SalaryStructure → SalaryStructureComponent
13. StatutoryConfig
14. EmployeeCompensation
15. ExpenseCategory → ExpensePolicy
16. AssetCategory
17. TicketCategory
18. RecognitionBadge
19. OnboardingTemplate → OnboardingTaskTemplate
20. everything transactional
```

---

## 8. Recommended implementation order

Derived from the graph above, not from the DTA `CLAUDE.md` phase list.

### Phase 0 — Security & platform prerequisites *(blocking; not HRMS features)*
| Item | Why |
|---|---|
| Remove plaintext passwords; hash-on-next-login migration | HRMS holds salary, PAN, bank details |
| Retire the duplicate plaintext login in `routes/api.routes.js` | Second unguarded auth path |
| Add refresh tokens + rotation + reuse detection + server-side logout | Sessions must be revocable |
| Rate-limit auth endpoints | Currently nothing throttles login |
| Extend `/auth/me` with `roleKeys[]` + `permissions[]` | The whole RBAC UI depends on it |
| Build the shared permissions module (port `hasPermission` + matrix) | Ends the hand-mirroring; unblocks everything |
| Extend `ProtectedRoute` with `requiresModules[]` | Route gating for ~40 new routes |
| Extract `constants/navItems.js` (declarative nav) | ~22 items cannot go in the inline array |
| Tier-1 UI primitives: `Select`, `ServerDataTable`, `Tabs`, `FilterBar`, form fields, `FormDrawer`, `PermissionGate` | Blocks every HRMS screen |
| Add `pdf-lib` + a general upload service + `STORAGE_LOCAL_PATH` | Payslips, letters, documents |
| Extend `AuditLog` (entity/entityId/before-after) + a read endpoint | Compliance |
| Extend `Notification` schema + enum for HRMS inbox | 13 modules will write to it |

**No HRMS module can ship before Phase 0 completes.**

### Phase 1 — Foundation
`CompanyProfile` · `Employee` (+ `User` link, `managerChain`) · `Department` · `OfficeLocation` · `Designation` · `EmploymentType` · `CustomFieldDefinition` · **Inbox** · Employee directory / profile / form / CSV import · Org chart · HRMS Settings (roles, company profile)
→ *Deliverable: a working employee master with org structure and the notification backbone.*

### Phase 2 — Daily operations
`Holiday` (before Leave) · `LeaveType` / `LeavePolicy` / `LeaveBalance` / `LeaveRequest` (+ sandwich rule, direct-manager approval) · `AttendanceRecord` / `AttendanceCorrection` (+ selfie, GPS) · Dashboard v1 (employee + manager branches)
→ *Deliverable: the smallest end-to-end usable HRMS.*

### Phase 3 — Money
`PayGroup` · `SalaryComponent` · `SalaryStructure` · `StatutoryConfig` · **statutory engines (port + tests)** · `EmployeeCompensation` · `PayrollRun` lifecycle · `Payslip` + PDF · `PayrollAdjustment` · `BankFile` · `Form16` · `LoanAdvance` (conditional approval) · then Expenses & Travel · `ReimbursementBatch` → run link
→ *Deliverable: payroll runs end to end. Highest risk phase.*

### Phase 4 — Lifecycle
`Documents` (folders, policies, acknowledgments) · `EmployeeUpload` · `Assets` · `Onboarding` (templates, checklists, offer letters, e-sign) · `Exits` (two-stage approval, clearances, F&F, relieving letter)
→ *Deliverable: hire-to-exit is complete.*

### Phase 5 — Talent & culture
`Helpdesk` *(can be pulled earlier — fully self-contained)* · `Engage` (announcements, polls, recognition, eNPS) · `Performance` (goals, cycles, reviews, feedback, 1:1s) · `Hiring` (requisitions → postings → candidates → pipeline → interviews → offers → **public careers** → onboarding conversion)
→ *Deliverable: functional parity with DTA's HR scope.*

### Phase 6 — Reporting & optional
Dashboard v2 (HR + payroll branches, all widgets) · `Reports` (3 definitions) · `Planning` · Audit-log viewer · Integrations · **[decision] Operations and/or Projects & Timesheets**
→ *Deliverable: full parity.*

### Ordering rules that must not be broken

| Rule | Reason |
|---|---|
| Inbox **before** any module that notifies | 13 modules inject it |
| `Holiday` **before** Leave | Sandwich rule |
| `LeaveType` **before** the first Employee is created | Balance seeding on create |
| Leave **before** Payroll | LOP |
| Payroll **before** Exits | Full & Final |
| Payroll **before** Expenses' batch→run link | `ReimbursementBatch.payrollRunId` |
| `LoanAdvance` **before** Exits | Outstanding recovery |
| Assets **before** Exits | Asset clearance |
| Onboarding **before** Hiring | Offer acceptance converts to an employee |
| Engage **before** Dashboard v2 | Announcement + Poll widgets |
| Attendance + Leave **before** Reports | 2 of 3 report definitions |
| Everything **before** Dashboard v2 | 10 foreign models |

### Migration ordering (AD-11)

The **source is deferred**, but the *order* a migration must follow is already fixed by the graph above and is part of the pipeline built in Phase 1:

```
1. Department · OfficeLocation · Designation · EmploymentType     (lookups first)
2. LeaveType                                                      ← MUST precede employees
3. User            (AD-4: never role 'Customer')
4. Employee        pass 1 — create all, manager references held as CODES
5. Employee        pass 2 — resolve reportingManagerCode → ObjectId
6. managerChain[]  pass 3 — recompute; DERIVED, never imported
7. LeaveBalance    seed per employee × leave type (hidden dependency #3)
```

Three traps this order avoids:
- **AD-2 removes FK constraints**, so a dangling `departmentId` is silently accepted. The pipeline validates references itself.
- **`managerChain` is denormalised.** Importing it directly bakes in a stale hierarchy; hidden dependency #1 then breaks every `team`-scope check.
- **Bulk-inserting employees bypasses the service** that seeds `LeaveBalance`, leaving every imported employee on a zero balance.

**AD-10/AD-11 sanitisation** runs between steps 4 and 5 — in memory, before the first write. See AD-11.

### Modules that can be built in parallel
Once Phase 1 lands, these have **no dependencies on each other**:
- **Helpdesk** (only Inbox) — the cleanest standalone slice
- **Documents** (only User/Role)
- **Assets** (only Employee)
- **Engage** (only Employee/User)
- **Performance** (only Employee/User)
- **Planning** (only Department/Employee)

Attendance and Leave can also proceed in parallel with each other (they share only `Employee` and `Holiday`).

---

## 9. Critical path

```
Phase 0 Security + RBAC + UI primitives
   → Employee + Org + Inbox
      → Holiday + Leave
         → Payroll (statutory engines)
            → Exits (F&F)
```

Everything else hangs off this spine and can be resequenced. **The critical path runs through Payroll**, which is also the highest-risk work: 59 endpoints, 13 models, 5 statutory engines, PDF generation, and money correctness under a 400 MB memory cap.
