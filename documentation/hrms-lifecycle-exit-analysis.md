# HRMS Employee Lifecycle / Exit — DTA analysis

Phase 7. Source read: `DTA_HRMS/apps/api/src/modules/exit/`,
`DTA_HRMS/apps/web/src/pages/exits/`, `apps/web/src/api/exit.ts`,
`packages/shared-types/src/exit.ts`, `apps/api/prisma/schema.prisma`.

DTA is reference only and was not modified.

---

## 1. DTA module structure

```
apps/api/src/modules/exit/
  exit.module.ts                  wires 2 controllers, 3 services
  exit-request.controller.ts      8 endpoints  — the state machine
  exit-request.service.ts         707 LOC      — the core
  full-and-final.controller.ts    5 endpoints  — closure (named ExitCloseController)
  full-and-final.service.ts       253 LOC      — a mini-payroll at exit
  relieving-letter.service.ts     167 LOC      — pdf-lib PDF onto local disk

apps/web/src/pages/exits/
  ExitsPage.tsx           tab shell (3 tabs)
  MyExitTab.tsx           self-service: initiate, track, cancel
  ExitRequestsTab.tsx     HR/manager table + detail drawer + F&F + clearances
  ClearanceQueueTab.tsx   cross-request queue of clearances assigned to me
  format.ts               status colours, reason labels, money
```

Approximate total: ~1,900 LOC. **Onboarding is a separate DTA module**
(`modules/onboarding/`, `pages/onboarding/`) and is not part of Exits — see §14.

---

## 2. Screens / routes

| Route | Tab | Audience (DTA gate) |
|---|---|---|
| `/exits/mine` | My exit | everyone |
| `/exits/requests` | Exit requests | `exits:edit:org` **or** `exits:approve:team` |
| `/exits/clearances` | Clearance queue | everyone (rows filtered to the viewer) |

Tab key lives in the URL via `useParams`; `ExitsPage` splices the Requests tab
into index 1 when permitted.

---

## 3. APIs (13 endpoints)

| Method | Path | Permission (ANY-OF) |
|---|---|---|
| GET | `/exits` | `view:org`, `view:self`, `approve:team` |
| GET | `/exits/:id` | `view:org`, `view:self` |
| POST | `/exits` | `submit:self`, `edit:org` |
| POST | `/exits/:id/manager-approve` | `approve:team`, `edit:org` |
| POST | `/exits/:id/hr-approve` | `edit:org` |
| POST | `/exits/:id/open-clearances` | `edit:org` |
| PATCH | `/exits/:id/clearances/:clearanceId` | `view:self`, `edit:org`, `assets:assign:org` |
| PATCH | `/exits/:id` | `edit:org` |
| POST | `/exits/:id/cancel` | `submit:self`, `edit:org` |
| GET | `/exits/:id/fnf/preview` | `edit:org` |
| POST | `/exits/:id/fnf` | `edit:org` |
| POST | `/exits/:id/fnf/disburse` | `edit:org` |
| POST | `/exits/:id/relieving-letter` | `edit:org` |
| GET | `/exits/:id/relieving-letter/pdf` | `view:org`, `view:self` |

Responses are bare objects/arrays (no envelope).

---

## 4. Models (5)

- **ExitRequest** — employeeId, employeeName (snapshot), initiatedByUserId,
  initiatedAt, reason, reasonCategory, requestedLastDay (date), actualLastDay,
  status, managerApprovedAt, hrApprovedAt, closedAt, replacementEmployeeId,
  transferNotes.
- **ExitClearance** — exitRequestId, area, assigneeUserId, status, completedAt,
  notes. Indexed `[assigneeUserId, status]`.
- **ExitInterview** — feedback JSON, satisfactionScore 1–10, conductedByUserId.
  **No service, no controller, no endpoint. Dead surface — see §13.**
- **FullAndFinal** — gross/deductions/netPayable `Decimal(14,2)`, breakdown JSON,
  disbursedAt, payrollRunId.
- **RelievingLetter** — pdfKey (local disk path), generatedAt.

All cascade-delete from ExitRequest.

---

## 5. Permissions

Module key `exits`; actions `view` / `edit` / `approve` / `submit`.
**Shraddha's RBAC matrix already grants exactly this set** — no new grants needed:

| Role | Grant |
|---|---|
| Employee | `exits:submit:self`, `exits:view:self` |
| HR Admin, Super Admin | `exits:view:org`, `exits:edit:org` |
| Reporting Manager | `exits:approve:team` |
| IT Admin | `exits:view:org` (comment: "needed for the asset-clearance step") |

---

## 6. Employee lifecycle states

DTA's `Employee.status` and Shraddha's `EMPLOYEE_STATUSES` are the same seven:
`invited | active | probation | notice | exited | suspended | inactive`.

The exit workflow touches exactly one transition: **F&F disburse sets
`status = 'exited'`**. Nothing in the exit module sets `notice`, despite a
`notice` status existing and the exit flow having an `in_notice` state — the two
are never connected. Shraddha additionally models `noticeStartDate`,
`noticeMonths`, `noticeEndDate` on Employee, which DTA lacks entirely.

---

## 7. Exit workflow

```
initiated ──manager-approve──▶ manager_approved ──hr-approve──▶ in_notice
                                      │                              │
                                      └────open-clearances───────────┤
                                                                     ▼
                                                          clearance_pending
                                    (auto, when every clearance terminal)
                                                                     ▼
                                                                  cleared
                                          ──POST /fnf──▶ f_and_f_pending
                                     ──POST /fnf/disburse──▶ closed
                                                    (Employee.status → exited)
                                          ──POST /relieving-letter──▶ PDF

any non-terminal state ──cancel──▶ cancelled
```

Clearances are opened as five rows — `it`, `finance`, `admin`, `hr`, `manager` —
each auto-assigned: IT→it_admin, finance/admin/hr→hr_admin (finance is an
acknowledged fallback), manager→the employee's reporting manager.
Each clearance is `pending → in_progress → completed | waived`.
When none remain `pending`/`in_progress`, the request auto-advances to `cleared`.

---

## 8. Status transitions (guards as written)

| Action | Requires status | Sets |
|---|---|---|
| manager-approve | `initiated` | `manager_approved` |
| hr-approve | `manager_approved` | **`in_notice`** (not `hr_approved`) |
| open-clearances | `in_notice` **or `manager_approved`** | `clearance_pending` |
| clearance update | — (none) | auto → `cleared` |
| create F&F | `cleared` or `f_and_f_pending` | `f_and_f_pending` |
| disburse F&F | — (only "not already disbursed") | `closed` |
| relieving letter | `closed` | — |
| cancel | not `closed`/`cancelled` | `cancelled` |
| PATCH `/exits/:id` | **none** | — |

---

## 9. Fields

Create: `employeeId`, `reason` (1–2000), `reasonCategory`
(`resignation|termination|retirement|other`, default resignation),
`requestedLastDay` (ISO day).
Update (HR): `actualLastDay`, `replacementEmployeeId`, `transferNotes` (≤4000).
Clearance update: `status`, `notes` (≤2000), `assigneeUserId`.

---

## 10. Validation

Zod at the controller boundary. `requestedLastDay` is `isoDay` with **no
lower bound server-side** — the UI disables past dates, the API accepts them.
Only one active exit per employee (`status notIn [closed, cancelled]`).

---

## 11. UI/UX

- **My exit**: `Steps` progress over 8 states, `Descriptions` grid (reason
  category / requested LWD / actual LWD / initiated / reason), clearance
  `Progress` bar + per-area rows, success `Alert` for F&F net payable, info
  `Alert` with a Download button for the relieving letter, `danger` Cancel exit
  button in the card `extra`. Empty state: "You have no active exit request."
  with an *Initiate resignation* primary button.
- **Initiate drawer** (480px): Category select (resignation/retirement/other —
  *termination is deliberately not offered*), requested last working day
  DatePicker with past dates disabled, reason textarea (4 rows).
- **Exit requests**: table — Employee / Category / Requested LWD / Initiated /
  Status / Manage. Detail drawer (720px) with a Descriptions block, a
  "State machine" card of six action buttons each disabled off-status, a
  Clearances card, an F&F preview card, and an F&F summary card.
- **Clearance queue**: Employee / Area / Status / Start · Mark done · Waive.
- Status colours: initiated blue, manager_approved cyan, hr_approved purple,
  in_notice gold, clearance_pending orange, cleared lime, f_and_f_pending
  geekblue, closed green, cancelled default.

---

## 12. Dependencies / integrations

| Dependency | Used for | Shraddha status |
|---|---|---|
| Employee | name, manager, DOJ, designation, department, status flip | ✅ exists |
| EmployeeCompensation (CTC) | F&F prorated salary, gratuity, encashment rate | ✅ exists (Payroll, Decimal128) |
| LeaveBalance (EL/PL) | leave encashment | ✅ exists (Leave) |
| Inbox + Mail | notification fan-out on initiate | ❌ no inbox/mail module |
| Role→user lookup | clearance auto-assignment | ✅ via roles |
| **ProjectMember / Project** | notify every PM of the leaver's projects | ❌ **excluded by AD-5** |
| LoanAdvance | loan settlement deduction in F&F | ❌ does not exist |
| PayrollRun | `fullAndFinal.payrollRunId` link | ✅ exists, never written by DTA |
| ExpenseClaim | comment claims reimbursements are included | ❌ **comment only — no code** |
| pdf-lib + local disk | relieving letter PDF | ➜ use S3 + presigned URL |

---

## 13. DTA bugs and questionable behaviour

1. **`preview()` mutates data.** `GET /exits/:id/fnf/preview` calls `compute()`,
   which runs `tx.loanAdvance.update({ outstanding: 0 })`. A read-shaped
   endpoint permanently zeroes loan balances — and `FnFPreviewCard` fires it
   automatically whenever HR opens the drawer on a `cleared` request. Worst
   defect in the module.
2. **`hr_approved` is an unreachable state.** It is in the enum, the DB comment,
   the UI `STEP_ORDER` and the colour map, but `hrApprove()` writes `in_notice`.
   The `Steps` bar therefore jumps 1→3 and misreports progress for every exit.
3. **`open-clearances` accepts `manager_approved`,** so HR approval can be
   skipped entirely — the state machine's own gate is bypassable through the
   documented happy path (the UI offers the button in that state too).
4. **`assertCanView` is unimplemented for managers** (`// TODO: manager scope
   check`). `buildScopeFilter` shows a manager their team's requests in the
   list, then `GET /exits/:id` 403s on the row they were just shown.
5. **F&F money is JavaScript floats** end to end (`z.number()`, `Number()`,
   `+`) despite a `Decimal(14,2)` column.
6. **ExitInterview is dead surface** — modelled, seeded, included in every query
   and returned in the DTO, with no endpoint that can ever create one.
7. **`PATCH /exits/:id` has no status guard** — HR can rewrite `actualLastDay`
   on a `closed` request, after the relieving letter states that date.
8. **`disburse()` has no status guard** — only "not already disbursed", so a
   request can jump to `closed` from any state once an F&F row exists.
9. **Employee can cancel at any non-terminal state**, including `cleared` or
   `f_and_f_pending` after F&F is computed.
10. **No check the employee is active** — an exit can be filed against someone
    already `exited`.
11. **Schema allows an employee to self-file `termination`.** The UI hides the
    option; the API accepts it.
12. **Relieving PDF read is `path.resolve(uploadsRoot, row.pdfKey)`** on local
    disk. The key is server-generated so it is not directly traversable, but
    the file is unbacked-up instance storage outside any access-control layer.
13. **Client-side scoping** in `MyExitTab` (`filter(r => r.employeeId === me)`)
    and `ClearanceQueueTab` — the whole visible set is shipped to the browser.
14. **Waive is offered to everyone** in `ClearancesEditor` (only Start/Done are
    gated on `canEdit`), producing a guaranteed 403 for non-assignees.
15. **F&F arithmetic is crude**: basic hardcoded at 40% of CTC, month divisor
    hardcoded `/30`, notice period hardcoded `30` with a `TODO`, and gratuity
    uses *fractional* years while its own comment says "completed years".
16. **`requestedLastDay` has no server-side lower bound** — a back-dated exit is
    accepted by the API.

---

## 14. Intentionally excluded in Shraddha

- **ProjectMember / Project PM notification fan-out** — AD-5 excludes Operations
  and Projects/Timesheets. Not reintroduced, not faked. The handover
  information DTA attaches to projects is carried by the ExitRequest's
  `replacementEmployeeId` + `transferNotes` pair, which is the closest valid
  equivalent and already part of DTA's own model.
- **Inbox / email fan-out** — no inbox or mail module exists in Shraddha. The
  audit trail records every transition instead; notifications are deferred, not
  stubbed.
- **LoanAdvance settlement** — no loan model exists. Omitted rather than
  invented, and the omission is visible in the F&F breakdown.
- **`hr_approved` status** — not reproduced, because it is unreachable in DTA
  and its presence is what breaks the progress indicator. Shraddha's chain runs
  `initiated → manager_approved → in_notice`, which is what DTA actually does.
- **ExitInterview** — no endpoint exists in DTA to create one, so there is no
  behaviour to port. Not modelled.
- **Onboarding** — a separate DTA module with its own controllers, services,
  templates and page. Out of scope for this phase, which covers Exits and the
  lifecycle transitions the exit workflow drives.
