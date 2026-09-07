# DTA HRMS — API & Backend Map

> Every endpoint below was extracted from `apps/api/src/modules/**/*.controller.ts`. **No API was invented.**
> Base URL: `{host}/api/v1` (global prefix from `API_PREFIX`, default `api/v1`). `healthz` / `readyz` are excluded from the prefix.
> Auth: **every route requires a valid JWT** unless marked `@Public()`. Routes with no `@Permissions()` need authentication only.
> Permission notation: `module:action:scope`. Multiple entries on one route are **ANY-OF** (satisfying one is enough).

**Source totals: 350 endpoints · 66 controllers · 85 services · 27 NestJS modules.**

> ⚠️ **SCOPE NOTE.** Per **AD-5** ([`architecture-decisions.md`](architecture-decisions.md)), §17 **Operations** (26 endpoints) and §18 **Projects & Timesheets** (12 endpoints) are **OUT OF SCOPE** and are documented for reference only.
> Per **AD-1** (single-tenant), the biometric webhook loses its org segment — `POST /attendance/biometric/:orgSlug` becomes **`POST /attendance/biometric`** — and `POST /auth/login` drops its optional `orgSlug` parameter.
> **In-scope total: 312 endpoints.**

---

## 0. Cross-cutting request contract

### Request pipeline (in order)
```
Fastify (helmet, cookie, multipart 10MB/5files, rate-limit 300/min)
  → JwtAuthGuard          (APP_GUARD)   — 401 unless @Public()
  → PermissionsGuard      (APP_GUARD)   — 403 unless a @Permissions() spec matches
  → TenancyInterceptor    (APP_INTERCEPTOR) — pushes {organizationId,userId,employeeId} into AsyncLocalStorage
  → AuditInterceptor      (APP_INTERCEPTOR) — writes AuditLog on @Audited() handlers
  → ZodValidationPipe     (per-param)   — validates @Body/@Query against a shared-types schema
  → Controller → Service → PrismaService.tx() → SET LOCAL app.current_org → RLS-filtered SQL
```

### Standard shapes
| Shape | Definition |
|---|---|
| Auth header | `Authorization: Bearer <accessToken>` |
| List query | `?page=1&pageSize=25&search=&sortBy=&sortDir=asc` (`paginationQuerySchema`; `pageSize` max 200) |
| List response | `{ data: T[], total: number, page: number, pageSize: number }` |
| Error | Nest default — `{ statusCode, message, error }` |
| File upload | `multipart/form-data`, single `file()` part + string fields; 10 MB cap |
| File download | Binary stream with `Content-Type` / `Content-Disposition`; consumed by `apiFetchBlob()` |
| Validation failure | 400 with the Zod issue list |

### Tokens
| Token | Payload | TTL |
|---|---|---|
| access | `{ sub: userId, orgId, employeeId, type: 'access' }` | `JWT_ACCESS_TTL` (15m) |
| refresh | `{ sub: userId, orgId, type: 'refresh', jti: uuid }` | `JWT_REFRESH_TTL` (7d) |

---

## 1. Auth — `auth.controller.ts` (4)

| Method | Endpoint | Auth | Request | Response | Model |
|---|---|---|---|---|---|
| POST | `/auth/login` | `@Public` | `{email, password, orgSlug?}` (`loginSchema`) | `{accessToken, refreshToken, accessTokenExpiresAt}` | `User`, `Organization`, `AuditLog` |
| POST | `/auth/refresh` | `@Public` | `{refreshToken}` (min 20 chars) | same as login | `User` |
| POST | `/auth/logout` | JWT | — | `204` | `User` |
| GET | `/auth/me` | JWT | — | `MeResponse` | `User`, `Employee`, `Organization`, `Role`, `Permission` |

**`MeResponse`** (the contract the entire frontend RBAC layer depends on):
```ts
{
  user:   { id, email, displayName, avatarUrl },
  employee: { id, employeeCode, designation, departmentId, locationId,
              reportingManagerId, managerChain: string[] } | null,
  organization: { id, name, slug },
  roleKeys: RoleKey[],                       // 9 possible values
  permissions: { module, action, scope }[]   // the full flattened grant list
}
```

**Login dependencies:** `Organization` (no RLS) → `User` (via `withOrg`) → argon2id verify → `Employee` lookup for `employeeId` → token issue → `User.refreshTokenHash` + `lastLoginAt` update → `AuditLog` insert (`action: 'auth.login'`, feeds the dashboard login-trend chart).

---

## 2. Health — `health.controller.ts` (2)

| Method | Endpoint | Auth |
|---|---|---|
| GET | `/healthz` | `@Public`, outside the API prefix |
| GET | `/readyz` | `@Public`, outside the API prefix |

Backed by `@nestjs/terminus`.

---

## 3. Employees (22)

### `employees.controller.ts`
| Method | Endpoint | Permissions | Request | Response |
|---|---|---|---|---|
| GET | `/employees` | `employees:view:org` \| `:team` \| `:self` | `employeeListQuerySchema`: `page, pageSize, search, departmentId, locationId, status, managerId, roleKey` | `{data: Employee[], total, page, pageSize}` |
| GET | `/employees/:id` | `:org` \| `:team`(`id`) \| `:self`(`id`) | — | `Employee` |
| POST | `/employees` | `employees:create:org` · `@Audited(employee.create)` | `createEmployeeSchema` | `{employee, tempPassword}` |
| PATCH | `/employees/:id` | `:edit:org` \| `:edit:self`(`id`) · `@Audited` | `updateEmployeeSchema` (minus `id`) | `Employee` |
| GET | `/employees/:id/roles` | `employees:edit:org` | — | `RoleKey[]` |
| PATCH | `/employees/:id/roles` | `employees:edit:org` | `{roleKeys[]}` | `RoleKey[]` |
| POST | `/employees/:id/confirm` | `employees:edit:org` | `confirmEmployeeSchema` `{confirmationDate?, remarks?}` | `Employee` |
| GET | `/employees/:id/confirmation-letter` | multi-scope | — | PDF |
| GET | `/employees/:id/uploads` | multi-scope | — | `EmployeeUpload[]` |
| POST | `/employees/:id/uploads` | multi-scope | multipart + `{category, label?}` | `EmployeeUpload` |
| GET | `/employees/:id/uploads/:uploadId` | multi-scope | — | binary |
| DELETE | `/employees/:id/uploads/:uploadId` | multi-scope | — | `204` |
| POST | `/employees/:id/reset-password` | `employees:edit:org` | — | `{tempPassword}` |
| DELETE | `/employees/:id` | `employees:delete:org` | — | `204` (soft delete) |

### `analytics.controller.ts` / `csv-import.controller.ts` / `custom-fields.controller.ts`
| Method | Endpoint | Permissions |
|---|---|---|
| GET | `/employees/analytics/snapshot` | `employees:view:org` |
| GET | `/employees/import/template.csv` | `employees:create:org` |
| POST | `/employees/import/preview` | `employees:create:org` |
| POST | `/employees/import/commit` | `employees:create:org` |
| GET | `/employees/custom-fields` | multi-scope |
| POST | `/employees/custom-fields` | `employees:edit:org` |
| PATCH | `/employees/custom-fields/:id` | `employees:edit:org` |
| DELETE | `/employees/custom-fields/:id` | `employees:edit:org` |

**Dependencies:** `User` (created alongside), `Role`/`UserRole`, `Department`, `Location`, `CustomFieldDefinition`, `EmployeeUpload`, `LeaveType`+`LeaveBalance` (seeded on create), `InboxService`, `MailService`, `ConfirmationLetterService` (pdf-lib), `manager-chain.ts`.

---

## 4. Attendance (11)

| Method | Endpoint | Permissions | Notes |
|---|---|---|---|
| POST | `/attendance/clock-in` | `attendance:submit:self` | Body carries `geoLat`, `geoLng`, optional selfie key. Calls **Nominatim** for the address label. |
| POST | `/attendance/clock-out` | `attendance:submit:self` | same |
| GET | `/attendance/today` | `attendance:view:self` | Drives `ClockInCard` |
| GET | `/attendance` | `:view:org` \| `:team` \| `:self` | Date-range history |
| GET | `/attendance/team-grid` | `:view:org` \| `:team` | Manager grid |
| POST | `/attendance/upload-selfie` | `attendance:submit:self` | multipart → `STORAGE_LOCAL_PATH/selfies/` |
| GET | `/attendance/selfie/:filename` | **`@Public`** | Serves the stored image |
| POST | `/attendance/corrections` | `attendance:submit:self` | `{date, requestedClockIn?, requestedClockOut?, reason}` |
| GET | `/attendance/corrections` | `:view:org` \| `:team` \| `:self` | Queue / own list |
| POST | `/attendance/corrections/:id/decide` | `:approve:org` \| `:team` | `{status, comment?}` |
| POST | `/attendance/biometric/:orgSlug` | **`@Public` + HMAC** | Raw-body HMAC via `BIOMETRIC_WEBHOOK_SECRET`; driver abstraction in `biometric-drivers.ts` |

**Models:** `AttendanceRecord` (`date, clockIn, clockOut, source, status, geoLat, geoLng, notes, clockInSelfie, clockInLocation, clockOutSelfie, clockOutLocation`), `AttendanceCorrection`.
**External:** OpenStreetMap Nominatim (synchronous, at punch time).

---

## 5. Leave (14)

| Method | Endpoint | Permissions | Request / Response |
|---|---|---|---|
| GET | `/leave/types` | `leave:view:self` | `LeaveType[]` |
| GET | `/leave/balances/me` | `leave:view:self` | `LeaveBalance[]` |
| GET | `/leave/balances/:employeeId` | `:view:org` \| `:team` \| `:self` | `LeaveBalance[]` |
| POST | `/leave/requests` | `leave:submit:self` | `{leaveTypeId, startDate, endDate, durationUnit, durationValue, halfDayPeriod?, halfDaySlots?, dayBreakdown?, hourFrom?, hourTo?, reason}` |
| GET | `/leave/requests` | `:view:org` \| `:team` \| `:self` | `LeaveRequest[]` (scope-filtered) |
| POST | `/leave/requests/:id/decide` | `:approve:org` \| `:team` | `{decision, comment?}` |
| POST | `/leave/requests/:id/cancel` | `leave:submit:self` | requester-only, pending-only |
| GET | `/leave/calendar` | `:view:org` \| `:team` | Team calendar window |
| GET | `/holidays` | `leave:view:self` | `?year=` |
| GET | `/holidays/years` | `leave:view:self` | available years |
| POST | `/holidays` | `leave:edit:org` | `{name, date, year, type, region?, description?, isOptional}` |
| PATCH | `/holidays/:id` | `leave:edit:org` | partial |
| DELETE | `/holidays/:id` | `leave:edit:org` | `204` |
| POST | `/holidays/bulk-import` | `leave:edit:org` | array (MP defaults helper on the client) |

**Dependencies:** `Holiday` (sandwich rule), `Employee.reportingManagerId` (approval chain), `LeaveBalance`, `InboxService`, `MailService`, BullMQ `leave-accrual.processor`.

---

## 6. Payroll (59, 12 controllers)

### Master data
| Method | Endpoint | Permissions |
|---|---|---|
| GET / POST / PATCH / DELETE | `/pay-groups[/:id]` | view: `payroll:view` · write: `payroll:structure:edit:org` |
| GET / POST / PATCH / DELETE | `/salary-components[/:id]` | same |
| GET / POST / PATCH / DELETE | `/salary-structures[/:id]` | same |
| POST | `/salary-structures/:id/preview` | multi-scope — dry-run a CTC through the structure |
| GET / POST / PATCH / DELETE | `/statutory-configs[/:id]` | same |
| GET | `/statutory-configs/current` | multi-scope |

### Compensation
| Method | Endpoint | Permissions |
|---|---|---|
| GET | `/compensations/employee/:employeeId` | multi-scope |
| GET | `/compensations/employee/:employeeId/current` | multi-scope |
| POST | `/compensations` | `employees:compensation:edit:org` |
| DELETE | `/compensations/:id` | `employees:compensation:edit:org` |

### Runs
| Method | Endpoint | Permissions | Purpose |
|---|---|---|---|
| GET | `/payroll/runs` | `payroll:view:org` | list (filter by month/year/payGroup) |
| GET | `/payroll/runs/:id` | `payroll:view:org` | detail + totals |
| POST | `/payroll/runs` | `payroll:run:org` | create draft |
| POST | `/payroll/runs/:id/compute` | `payroll:run:org` | **runs the salary engine for every employee** |
| POST | `/payroll/runs/:id/lock` | `payroll:run:org` | freeze + generate payslips |
| POST | `/payroll/runs/:id/disburse` | `payroll:run:org` | mark disbursed |
| POST | `/payroll/runs/:id/rollback` | `payroll:run:org` | undo |

### Adjustments, bank files, exports
| Method | Endpoint | Permissions |
|---|---|---|
| GET / POST | `/payroll/runs/:runId/adjustments` | view / `payroll:run:org` |
| DELETE | `/payroll/runs/:runId/adjustments/:adjustmentId` | `payroll:run:org` |
| POST / GET | `/payroll/runs/:runId/bank-files` | `payroll:run:org` / `payroll:view:org` |
| GET | `/payroll/runs/:runId/bank-files/files/:fileId/download` | `payroll:view:org` |
| GET | `/payroll/runs/:runId/exports/tally` | `payroll:view:org` |
| GET | `/payroll/runs/:runId/exports/quickbooks` | `payroll:view:org` |

### Payslips & Form 16
| Method | Endpoint | Permissions |
|---|---|---|
| GET | `/payslips/mine` | `payroll:view:self` |
| GET | `/payslips/employee/:employeeId` | `payroll:view:org` |
| GET | `/payslips/run/:runId` | `payroll:view:org` |
| POST | `/payslips/adhoc` | `payroll:view:org` — off-cycle payslip |
| GET | `/payslips/:id` | multi-scope |
| GET | `/payslips/:id/pdf` | multi-scope — pdf-lib |
| POST | `/form16/generate` | `payroll:run:org` |
| GET | `/form16/employee/:employeeId` | multi-scope |
| GET | `/form16/:id/pdf` | multi-scope |

### Advance salary / loans
| Method | Endpoint | Permissions | Rule |
|---|---|---|---|
| GET | `/loans/mine` | `payroll:view:self` | |
| GET | `/loans` | multi-scope | approver queue |
| GET | `/loans/:id` | multi-scope | |
| POST | `/loans` | `payroll:view:self` | employee requests |
| POST | `/loans/:id/approve` | `payroll:approve:org` | may attach `conditionText` |
| POST | `/loans/:id/reject` | `payroll:approve:org` | `{rejectReason}` |
| POST | `/loans/:id/accept-condition` | `payroll:view:self` | employee accepts the condition |
| POST | `/loans/:id/decline-condition` | `payroll:view:self` | employee declines |
| DELETE | `/loans/:id` | `payroll:view:self` | withdraw while pending |

**Payload shapes.** `Payslip.lines` is a JSON array of `PayslipLine` (component code, name, type, amount, taxable). `PayrollRun.totals` is a JSON aggregate. `SalaryComponent.formula` and `SalaryStructureComponent.calculation` are JSON evaluated by `salary-formula.ts`. `StatutoryConfig.config` is a JSON bundle consumed by the PF/ESI/PT/LWF/TDS engines.

**Dependencies:** `Employee`, `LeaveRequest` (LOP), `Holiday` (working days), `ExpenseClaim` + `ReimbursementBatch` (reimbursements into a run), `LoanAdvance` (auto-deduction), `UserRole` (approver resolution), pdf-lib.

---

## 7. Expenses & Travel (25)

| Method | Endpoint | Permissions |
|---|---|---|
| GET / GET`:id` / POST / PATCH / DELETE | `/expenses/categories[/:id]` | read: multi-scope · write: `expenses:approve:org` |
| GET | `/expenses/policies` | multi-scope |
| GET | `/expenses/policies/category/:categoryId` | multi-scope |
| POST / DELETE | `/expenses/policies[/:id]` | `expenses:approve:org` |
| GET | `/expenses/claims` | `:view:org` \| `:team` \| `:self` |
| GET | `/expenses/claims/:id` | multi-scope |
| POST | `/expenses/claims` | `expenses:submit:self` |
| POST | `/expenses/claims/:id/submit` | `expenses:submit:self` |
| POST | `/expenses/claims/:id/decide` | `:approve:org` \| `:team` |
| POST | `/expenses/claims/:id/line-items/:lineId/receipt` | `expenses:submit:self` (multipart) |
| GET | `/expenses/claims/line-items/:lineId/receipt` | multi-scope (binary) |
| GET / GET`:id` | `/expenses/travel[/:id]` | multi-scope |
| POST | `/expenses/travel` | `expenses:submit:self` |
| POST | `/expenses/travel/:id/decide` | `:approve:org` \| `:team` |
| POST | `/expenses/travel/:id/disburse` | `expenses:approve:org` |
| GET / POST | `/expenses/reimbursement-batches` | `expenses:approve:org` |
| POST | `/expenses/reimbursement-batches/:id/collect` | `expenses:approve:org` |
| POST | `/expenses/reimbursement-batches/:id/link` | `expenses:approve:org` — links to a `PayrollRun` |

**Claim shape:** `{title, lineItems: [{categoryId, date, amount, description, receiptKey?}], travelRequestId?}`; server computes `total`, builds `approvalChain` JSON, applies `ExpensePolicy.autoApproveBelow`.

---

## 8. Onboarding (16)

| Method | Endpoint | Permissions |
|---|---|---|
| GET / GET`:id` | `/onboarding/templates[/:id]` | `onboarding:view:org` |
| POST / PATCH / DELETE | `/onboarding/templates[/:id]` | `onboarding:edit:org` |
| GET / GET`:id` | `/onboarding/checklists[/:id]` | multi-scope |
| POST | `/onboarding/checklists` | `onboarding:edit:org` |
| PATCH | `/onboarding/checklists/:id/tasks/:taskId` | multi-scope (assignee can tick their own task) |
| GET | `/onboarding/offers` | `onboarding:view:org` |
| GET | `/onboarding/offers/employee/:employeeId` | multi-scope |
| POST | `/onboarding/offers` | `onboarding:edit:org` |
| POST | `/onboarding/offers/:id/send` | `onboarding:edit:org` |
| POST | `/onboarding/offers/:id/sign` | `onboarding:view:self` — **new hire e-signs** |
| POST | `/onboarding/offers/:id/reject` | `onboarding:view:self` |
| GET | `/onboarding/offers/:id/pdf` | multi-scope |

---

## 9. Exits (14)

| Method | Endpoint | Permissions |
|---|---|---|
| GET / GET`:id` | `/exits[/:id]` | multi-scope |
| POST | `/exits` | multi-scope (`exits:submit:self` — employee initiates) |
| POST | `/exits/:id/manager-approve` | `exits:approve:team` |
| POST | `/exits/:id/hr-approve` | `exits:edit:org` |
| POST | `/exits/:id/open-clearances` | `exits:edit:org` |
| PATCH | `/exits/:id/clearances/:clearanceId` | multi-scope (assignee completes their area) |
| PATCH | `/exits/:id` | `exits:edit:org` |
| POST | `/exits/:id/cancel` | multi-scope |
| GET | `/exits/:id/fnf/preview` | `exits:edit:org` |
| POST | `/exits/:id/fnf` | `exits:edit:org` |
| POST | `/exits/:id/fnf/disburse` | `exits:edit:org` |
| POST | `/exits/:id/relieving-letter` | `exits:edit:org` |
| GET | `/exits/:id/relieving-letter/pdf` | multi-scope |

**Cross-module reads:** `LoanAdvance` (outstanding recovery in F&F), `ProjectMember` (handover), `AssetAssignment` (asset clearance), `PayrollRun` (disbursement link).

---

## 10. Documents (11)

| Method | Endpoint | Permissions |
|---|---|---|
| GET | `/documents/folders` | multi-scope |
| POST / PATCH / DELETE | `/documents/folders[/:id]` | `documents:view:org` |
| GET | `/documents` | multi-scope (`?folderId=`, `?employeeId=`) |
| POST | `/documents/upload` | multi-scope (multipart) |
| GET | `/documents/:id/download` | multi-scope (binary) |
| DELETE | `/documents/:id` | `documents:view:org` |
| POST | `/documents/policies` | `documents:view:org` |
| POST | `/documents/acknowledgments` | multi-scope |
| GET | `/documents/:id/acknowledgment-status` | `documents:view:org` |

**Access rule:** `DocumentFolder.visibility` + `roleKeys[]` + `departmentIds[]` are evaluated in `document.service.ts` — folder ACLs are data, not code.

---

## 11. Assets (15)

| Method | Endpoint | Permissions |
|---|---|---|
| GET | `/assets/categories` | multi-scope |
| POST / DELETE | `/assets/categories[/:id]` | `assets:assign:org` |
| GET | `/assets/items` | `assets:view:org` |
| POST | `/assets/items` | `assets:assign:org` |
| POST | `/assets/items/assign` | `assets:assign:org` |
| POST | `/assets/assignments/:id/return` | `assets:assign:org` |
| POST | `/assets/items/:id/status` | `assets:assign:org` |
| GET | `/assets/assignments/mine` | `assets:view:self` |
| GET | `/assets/assignments/employee/:employeeId` | multi-scope |
| GET | `/assets/requests` | multi-scope |
| POST | `/assets/requests` | `assets:view:self` |
| POST | `/assets/requests/:id/decide` | `assets:assign:org` |
| POST | `/assets/requests/:id/fulfill` | `assets:assign:org` |
| POST | `/assets/requests/:id/cancel` | multi-scope |

---

## 12. Hiring / ATS (36, 8 controllers)

### Authenticated
| Method | Endpoint | Permissions |
|---|---|---|
| GET / GET`:id` | `/hiring/requisitions[/:id]` | multi-scope |
| POST | `/hiring/requisitions` | `hiring:edit:org` |
| POST | `/hiring/requisitions/:id/approve` | `hiring:edit:org` |
| POST | `/hiring/requisitions/:id/status` | `hiring:edit:org` |
| GET | `/hiring/postings` | `hiring:view:org` |
| POST | `/hiring/postings` | `hiring:edit:org` |
| POST | `/hiring/postings/:id/publish` | `hiring:edit:org` |
| POST | `/hiring/postings/:id/close` | `hiring:edit:org` |
| GET / GET`:id` | `/hiring/candidates[/:id]` | `hiring:view:org` |
| POST | `/hiring/candidates` | `hiring:edit:org` |
| POST | `/hiring/candidates/:id/resume` | `hiring:edit:org` (multipart) |
| GET | `/hiring/candidates/:id/resume` | `hiring:view:org` (binary) |
| GET / GET`:id` | `/hiring/applications[/:id]` | multi-scope |
| POST | `/hiring/applications` | `hiring:edit:org` |
| POST | `/hiring/applications/:id/move` | `hiring:edit:org` — pipeline stage transition |
| GET | `/hiring/interviews` | multi-scope |
| GET | `/hiring/interviews/mine` | multi-scope — panellist view |
| POST | `/hiring/interviews` | `hiring:edit:org` |
| POST | `/hiring/interviews/:id/status` | `hiring:edit:org` |
| GET | `/hiring/interviews/:id/feedback` | multi-scope |
| POST | `/hiring/interviews/feedback` | multi-scope — panellist submits |
| GET | `/hiring/offers` | `hiring:view:org` |
| POST | `/hiring/offers` | `hiring:edit:org` |
| POST | `/hiring/offers/:id/send` | `hiring:edit:org` |
| GET | `/hiring/offers/:id/pdf` | `hiring:view:org` |
| POST | `/hiring/ai/jd` | `hiring:edit:org` — AI job-description draft |

### Public careers — `public-careers.controller.ts` (7, all `@Public()`)
| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/careers/postings` | published postings |
| GET | `/careers/postings/:slug` | posting detail |
| POST | `/careers/postings/:slug/apply` | creates `Candidate` + `Application` |
| GET | `/careers/offer/:id` | offer detail for the candidate |
| GET | `/careers/offer/:id/pdf` | offer PDF |
| POST | `/careers/offer/:id/accept` | candidate accepts + signs |
| POST | `/careers/offer/:id/reject` | candidate rejects |

> ⚠️ **This is the entire unauthenticated write surface of the system** (plus the biometric webhook and the attendance selfie GET). Any replication must reproduce these deliberately, not by accident.

---

## 13. Performance (18)

| Method | Endpoint | Permissions |
|---|---|---|
| GET | `/performance/goals` | multi-scope |
| POST | `/performance/goals` | `performance:submit:self` |
| PATCH | `/performance/goals/:id` | multi-scope |
| DELETE | `/performance/goals/:id` | multi-scope |
| GET | `/performance/cycles` | multi-scope |
| POST | `/performance/cycles` | `performance:approve:org` |
| POST | `/performance/cycles/:id/phase` | `performance:approve:org` |
| GET | `/performance/cycles/:id/calibration` | `performance:approve:org` |
| GET | `/performance/reviews/mine` | multi-scope |
| GET | `/performance/reviews` | `performance:view:org` |
| POST | `/performance/reviews` | multi-scope |
| POST | `/performance/reviews/:id/submit` | `performance:submit:self` |
| GET | `/performance/feedback/received` | `performance:view:self` |
| GET | `/performance/feedback/given` | `performance:view:self` |
| POST | `/performance/feedback` | `performance:submit:self` |
| GET | `/performance/one-on-ones` | `performance:view:self` |
| POST | `/performance/one-on-ones` | `performance:approve:team` — manager only |
| PATCH | `/performance/one-on-ones/:id` | `performance:view:self` |

---

## 14. Engage (17)

| Method | Endpoint | Permissions |
|---|---|---|
| GET | `/engage/announcements` | `engage:view:self` |
| POST | `/engage/announcements` | `engage:edit:org` |
| POST | `/engage/announcements/:id/publish` | `engage:edit:org` |
| DELETE | `/engage/announcements/:id` | `engage:edit:org` |
| GET | `/engage/polls` | `engage:view:self` |
| POST | `/engage/polls` | `engage:edit:org` |
| POST | `/engage/polls/:id/respond` | `engage:view:self` |
| GET | `/engage/polls/:id/results` | `engage:edit:org` |
| GET | `/engage/recognitions/wall` | `engage:view:self` |
| GET | `/engage/recognitions/received` | `engage:view:self` |
| POST | `/engage/recognitions` | `engage:view:self` — peer-to-peer |
| GET | `/engage/badges` | `engage:view:self` |
| POST | `/engage/badges` | `engage:edit:org` |
| GET | `/engage/enps` | `engage:view:self` |
| POST | `/engage/enps` | `engage:edit:org` |
| POST | `/engage/enps/:id/respond` | `engage:view:self` |
| GET | `/engage/enps/:id/results` | `engage:edit:org` |

---

## 15. Helpdesk (8)

| Method | Endpoint | Permissions |
|---|---|---|
| GET | `/helpdesk/tickets` | `helpdesk:view:self` |
| GET | `/helpdesk/tickets/:id` | `helpdesk:view:self` |
| POST | `/helpdesk/tickets` | `helpdesk:submit:self` |
| PATCH | `/helpdesk/tickets/:id` | `helpdesk:resolve:org` |
| GET | `/helpdesk/tickets/:id/comments` | `helpdesk:view:self` |
| POST | `/helpdesk/tickets/:id/comments` | `helpdesk:view:self` |
| GET | `/helpdesk/kb` | (auth only) |
| POST | `/helpdesk/kb/search` | (auth only) |

Category-scoped resolution (`helpdesk:hr`, `helpdesk:payroll`, `helpdesk:it`) is enforced **inside `ticket.service.ts`**, not on the route decorator.

---

## 16. Organization / Org Structure (15)

| Method | Endpoint | Permissions |
|---|---|---|
| GET / GET`:id` | `/departments[/:id]` | `org-structure:view:self` |
| POST / PATCH / DELETE | `/departments[/:id]` | `org-structure:edit:org` |
| GET / GET`:id` | `/locations[/:id]` | `org-structure:view:self` |
| POST / PATCH / DELETE | `/locations[/:id]` | `org-structure:edit:org` |
| GET | `/organization/current` | `settings:view:org` |
| GET | `/organization/tree` | multi-scope — feeds the org chart |
| GET | `/organization/logo` | **`@Public`** |
| POST | `/organization/logo` | `settings:edit:org` (multipart) |
| PATCH | `/organization/current` | `settings:edit:org` — name + `brand` JSON |

---

## 17. Operations (26)

| Method | Endpoint | Permissions |
|---|---|---|
| GET / GET`:id` | `/operations/projects[/:id]` | multi-scope |
| POST / PATCH / DELETE | `/operations/projects[/:id]` | `operations:edit:org` |
| GET / POST | `/operations/projects/:id/members` | view multi-scope · add `operations:edit:org` |
| DELETE | `/operations/projects/:id/members/:memberId` | `operations:edit:org` |
| GET | `/operations/projects/:projectId/board` | multi-scope — Kanban payload |
| GET | `/operations/tasks/mine` | `operations:view:self` |
| GET | `/operations/projects/:projectId/tasks/:taskId` | multi-scope |
| POST | `/operations/projects/:projectId/tasks` | multi-scope |
| PATCH | `/operations/projects/:projectId/tasks/:taskId` | multi-scope (`edit:self` covers own-card moves) |
| DELETE | `/operations/projects/:projectId/tasks/:taskId` | `operations:edit:org` |
| POST | `/operations/projects/:projectId/tasks/:taskId/comments` | `operations:submit:self` |
| GET | `/operations/updates/mine` | `operations:view:self` |
| POST | `/operations/updates` | `operations:submit:self` |
| DELETE | `/operations/updates/:id` | `operations:submit:self` |
| GET | `/operations/updates/project/:projectId` | `operations:view:self` |
| GET | `/operations/reports/project` | multi-scope |
| GET | `/operations/reports/project.pdf` | multi-scope |
| GET | `/operations/reports/by-manager` | multi-scope |
| GET | `/operations/reports/by-manager.pdf` | multi-scope |
| GET | `/operations/reports/by-employee` | multi-scope |
| GET | `/operations/reports/by-employee.pdf` | multi-scope |
| POST | `/operations/reports/summarize` | multi-scope — **optional Anthropic API call** |

---

## 18. Projects & Timesheets (12)

| Method | Endpoint | Permissions |
|---|---|---|
| GET / GET`:id` | `/projects[/:id]` | `projects:view:self` |
| POST | `/projects` | `projects:edit:org` |
| GET / POST | `/projects/:id/members` | view `:view:self` · write `:edit:org` |
| GET / POST | `/projects/:id/tasks` | view `:view:self` · write `:edit:org` |
| GET | `/projects/timesheets/mine` | `projects:view:self` |
| POST | `/projects/timesheets` | `projects:submit:self` |
| POST | `/projects/timesheets/submit` | `projects:submit:self` |
| POST | `/projects/timesheets/periods/:id/approve` | `projects:approve:team` |
| GET | `/projects/utilization/report` | `projects:view:org` |

---

## 19. Planning (4)

| Method | Endpoint | Permissions |
|---|---|---|
| GET | `/planning/headcount` | `planning:view:org` |
| POST | `/planning/headcount` | `planning:edit:org` |
| GET | `/planning/hiring` | `planning:view:org` |
| POST | `/planning/hiring` | `planning:edit:org` |

---

## 20. Dashboard (4)

| Method | Endpoint | Permissions | Response |
|---|---|---|---|
| GET | `/dashboard/widgets` | `dashboard:view:self` | `DashboardWidgets` — quickAccess, upcomingHolidays, announcements, polls, onLeaveToday, workingRemotely, celebrations |
| GET | `/dashboard/celebrations` | `dashboard:view:self` | birthdays + work anniversaries |
| GET | `/dashboard/summary` | `dashboard:view:self` | **discriminated union on `role`** — `hr_admin` \| `manager` \| `employee` \| `payroll_admin` |
| GET | `/dashboard/login-trend` | `dashboard:view:self` | area-chart series, 7/14/30-day window, sourced from `AuditLog` rows where `action='auth.login'` |

---

## 21. Inbox (4)

| Method | Endpoint | Permissions |
|---|---|---|
| GET | `/inbox` | `inbox:view:self` |
| GET | `/inbox/unread-count` | `inbox:view:self` |
| POST | `/inbox/:id/read` | `inbox:view:self` |
| POST | `/inbox/read-all` | `inbox:view:self` |

---

## 22. RBAC / Roles (4)

| Method | Endpoint | Permissions |
|---|---|---|
| GET | `/roles` | `settings:view:org` |
| POST | `/roles` | `settings:edit:org` — custom role creation |
| PATCH | `/roles/:id` | `settings:edit:org` |
| DELETE | `/roles/:id` | `settings:edit:org` (blocked for `isSystem` roles) |

---

## 23. Integrations (4)

| Method | Endpoint | Permissions |
|---|---|---|
| GET / POST | `/integrations/sso` | `settings:integrations:edit:org` |
| GET / POST | `/integrations` | `settings:integrations:edit:org` |

`sso.service.ts` declares Google and Microsoft OAuth endpoint URLs but is **not wired into `/auth/login`** — configuration storage only.

---

## 24. Reports (3)

| Method | Endpoint | Permissions |
|---|---|---|
| GET | `/reports/catalog` | any `reports*:view` |
| GET | `/reports/:key/run` | any `reports*:view` |
| GET | `/reports/:key/export.csv` | any `reports*:export` |

Only 3 report keys exist: `employees_directory`, `attendance_monthly`, `leave_balances`.

---

## 25. Audit & Admin (2)

| Method | Endpoint | Permissions |
|---|---|---|
| GET | `/audit-logs` | `audit-logs:view:org` |
| POST | `/admin/reset-dtable-seed` | `settings:edit:org` — destructive reseed helper |

---

# Shraddha equivalence assessment

Categories are assigned per the brief: **EXISTING**, **REUSABLE**, **ADAPTABLE**, **MISSING**, **UNKNOWN**.

> Definitions used here:
> - **EXISTING** — Shraddha already has an endpoint that serves the same purpose today.
> - **REUSABLE** — the DTA source can be lifted with little change *conceptually*, but note that Shraddha is JavaScript/Express/Mongoose while DTA is TypeScript/NestJS/Prisma, so "reusable" never means copy-paste.
> - **ADAPTABLE** — Shraddha has infrastructure that must be modified/extended to serve the HRMS need.
> - **MISSING** — no equivalent exists; must be implemented.
> - **UNKNOWN** — requires a product/business decision before it can be classified.

## Infrastructure-level

| Capability | DTA | Shraddha today | Category | Note |
|---|---|---|---|---|
| JWT login | `POST /auth/login` (argon2id, access+refresh, org-scoped) | `POST /api/v1/auth/login` (bcrypt **or plaintext**, single 1d token) | **ADAPTABLE** | Shraddha has login; it lacks refresh tokens, rotation, reuse detection, and hashes are not guaranteed |
| Current user | `GET /auth/me` returns roleKeys + full permission list | `GET /api/v1/auth/me` returns the raw `User` document | **ADAPTABLE** | Shape must gain `permissions[]`/`roleKeys[]` or the HRMS RBAC UI cannot work |
| Token refresh / rotation | `POST /auth/refresh` + reuse detection | — | **MISSING** | |
| Logout (server-side revoke) | `POST /auth/logout` | client-side `localStorage.removeItem` only | **MISSING** | |
| Change own password | (via employee reset) | `PUT /api/v1/auth/me/password` | **EXISTING** | Shraddha's is better placed |
| Update own profile | `PATCH /employees/:id` self-scope | `PATCH /api/v1/auth/me` | **ADAPTABLE** | Different field set |
| Role listing | `GET /roles` | `GET /api/v1/roles` | **ADAPTABLE** | Shraddha's `Role` model has a flat `permissions: [String]`; DTA needs `module × action × scope` |
| Role permission edit | `PATCH /roles/:id` | `PUT /api/v1/roles/:id/permissions` | **ADAPTABLE** | Same reason |
| User CRUD | `POST/PATCH/DELETE /employees` (creates the `User`) | `GET/POST/PATCH /api/v1/users`, `PUT /:id/roles`, `PUT /:id/password` | **ADAPTABLE** | Shraddha's `User` is a customer/staff account, not an employee record |
| Audit log write | `AuditInterceptor` + `@Audited()` | `auditLogger('Action')` middleware on selected routes | **ADAPTABLE** | Same idea, coarser. Shraddha logs after `res.finish` on 2xx; DTA logs structured before/after |
| Audit log read API | `GET /audit-logs` | — (only a frontend `AuditLogTable.jsx`) | **MISSING** | |
| Notifications (in-app) | `InboxItem` + `/inbox/*` | `Notification` + `GET /notifications`, `PUT /mark-read`, `PATCH /:id/read` | **ADAPTABLE** | Shraddha's `Notification.type` enum is `order\|inventory\|reservation`; HRMS needs `entity`, `entityId`, `href`, `actionable` |
| Real-time push | none | **Socket.IO** with per-user rooms + `admins` room, JWT handshake | **EXISTING (bonus)** | DTA has no websockets; Shraddha's socket layer is a net gain |
| Email | `MailService` + `mail-templates.ts`, fire-and-forget | `utils/mailer.js` + blocklist + templated HTML shell | **EXISTING** | Both nodemailer; Shraddha's has recipient blocklisting |
| File upload | `@fastify/multipart` → `STORAGE_LOCAL_PATH` | `multer` (`middlewares/importUpload.js`) → disk + sweeper | **ADAPTABLE** | Shraddha's multer config is import-specific; needs a general employee/document upload path |
| PDF generation | `pdf-lib` — payslips, Form 16, 5 letter types, 3 Operations reports | `jspdf` + `jspdf-autotable` **client-side** (`utils/bookingPdf.js`) | **MISSING (server-side)** | Payslips and statutory letters must be server-generated — they are records, not views |
| Excel/CSV | `csv-parse` import, CSV export | `exceljs` + `xlsx` (both server and client) | **EXISTING** | Shraddha's is stronger |
| Background jobs | BullMQ + Redis (leave accrual) | `node-cron` in `server.js` (daily 00:00) | **ADAPTABLE** | node-cron is in-process and single-instance; adequate for leave accrual |
| Rate limiting | `@fastify/rate-limit` 300/min global | `express-rate-limit` installed but **deliberately not applied** (comment in `app.js`) | **MISSING** | A deliberate product decision in Shraddha; HRMS auth endpoints need reconsideration |
| Multi-tenancy | `organization_id` + Postgres **FORCE RLS** | none — single tenant | **MISSING** | The single biggest architectural gap |
| Scoped authorization | `module × action × scope` + `managerChain` | flat permission strings, role → `['*']` or a list | **MISSING** | No concept of self/team/department/org |
| Transactions | Prisma `$transaction` (used everywhere for tenancy) | `mongoose.startSession()` + `withTransaction` (used in orders/reservations); `utils/mongoSession.js` | **EXISTING** | Requires a replica set — already assumed by existing code |
| Atomic sequences | UUID PKs | `Counter` model + `nextSequence` / `nextSequenceBlock` | **EXISTING (bonus)** | Useful for employee codes |
| Health check | `/healthz`, `/readyz` | `GET /health` | **EXISTING** | |

## HRMS domain APIs — all MISSING in Shraddha

Shraddha has **zero** HR endpoints. Every one of the following is **MISSING** and must be implemented:

| Domain | Endpoints to build | Category |
|---|---|---|
| Employees (core HR) | 22 | MISSING |
| Attendance | 11 | MISSING |
| Leave + Holidays | 14 | MISSING |
| Payroll | 59 | MISSING |
| Expenses & Travel | 25 | MISSING |
| Onboarding | 16 | MISSING |
| Exits | 14 | MISSING |
| Documents | 11 | MISSING |
| Assets | 15 | MISSING |
| Hiring / ATS (incl. 7 public) | 36 | MISSING |
| Performance | 18 | MISSING |
| Engage | 17 | MISSING |
| Helpdesk | 8 | MISSING |
| Org structure | 15 | MISSING |
| Operations | 26 | UNKNOWN — see below |
| Projects & Timesheets | 12 | UNKNOWN — see below |
| Planning | 4 | MISSING |
| Reports | 3 | MISSING |
| Dashboard (HR) | 4 | MISSING |
| Inbox | 4 | ADAPTABLE (Notification exists) |
| RBAC | 4 | ADAPTABLE (Role exists) |
| Integrations | 4 | MISSING |
| Audit read | 1 | MISSING |
| Admin reseed | 1 | MISSING |

### UNKNOWN — needs a decision before classification

| Item | Question |
|---|---|
| **Operations module (26 endpoints)** | It is D-Table's *internal* project tracker, not an HR function. Does Shraddha Impex need it? |
| **Projects & Timesheets (12 endpoints)** | Duplicates Operations. Its nav entry is already removed in DTA. Build one, both, or neither? |
| **Multi-tenancy** | Shraddha is single-organization. Do we carry `organization_id` + RLS forward, or collapse to single-tenant? This decision changes ~every table and ~every query. |
| **Biometric webhook** | Is there biometric hardware at Shraddha Impex? |
| **Nominatim reverse-geocoding** | Acceptable to call a public unkeyed API from production, or substitute a keyed provider / store raw coordinates? |
| **Anthropic API (Operations summariser)** | Keep, drop, or gate behind a flag? |
| **Public careers site** | Does Shraddha Impex want a public-facing jobs page on the same domain as the customer portal? |
| **Statutory scope** | The engines are India-specific (PF/ESI/PT/LWF/TDS). Confirm this matches Shraddha Impex's payroll obligations, and which state slabs apply. |
| **SSO** | `SsoConfig` exists but is unwired in DTA. Build it properly, or omit? |
| **Existing Shraddha `User` vs HRMS `Employee`** | Do Shraddha's ~6 roles (Admin, Sales, Inventory Manager, Warehouse User, Management, Customer) merge with the 9 HRMS roles, or run as a second axis? |

---

# Database models & relationships

## DTA HRMS — 93 Prisma models

### Core spine
```
Organization (tenant root — the ONLY table without RLS)
   │
   ├─1:n─ User ──1:1── Employee
   │        │            │
   │        └─n:m─ Role ─┴──n:m── Permission        (via UserRole / RolePermission)
   │
   ├─1:n─ Department (self-ref tree: parentId, headEmployeeId)
   ├─1:n─ Location
   ├─1:n─ Designation          (ordered lookup)
   ├─1:n─ EmploymentType       (ordered lookup)
   ├─1:n─ LeaveType
   └─1:n─ CustomFieldDefinition
```

`Employee` is the hub — it carries **30 relation fields**:
```
Employee
 ├─ reportingManager ─self-ref─ directReports[]      + denormalised managerChain[] (uuid[])
 ├─ department, location
 ├─ attendanceRecords[], attendanceCorrections[]
 ├─ leaveBalances[], leaveRequests[]
 ├─ compensations[], payslips[], loans[], form16Rows[]
 ├─ expenseClaims[], travelRequests[]
 ├─ onboardingChecklists[], offerLetters[], appointmentLetters[]
 ├─ exitRequests[]
 ├─ documents[], personalDocuments[]  (EmployeeUpload)
 ├─ assetAssignments[], assetRequests[]
 ├─ goals[], reviewResponses[]
 ├─ recognitionsReceived[], recognitionsSent[]
 ├─ projectMemberships[], timesheetEntries[]
 └─ opsProjectsOwned[], opsProjectMemberships[], opsTasksAssigned[], opsDailyUpdates[]
```

### Domain clusters (with the FK chains that matter)

**Attendance** — `AttendanceRecord(employeeId)`, `AttendanceCorrection(employeeId, decidedById)`

**Leave**
```
LeaveType ─1:n─ LeavePolicy   (accrual JSON, effectiveFrom/To)
    ├─1:n─ LeaveBalance(employeeId, year, accrued/used/pending/balance)
    └─1:n─ LeaveRequest(employeeId, approvalChain JSON, dayBreakdown JSON)
Holiday  (standalone; read by the sandwich rule)
```

**Payroll**
```
PayGroup ─1:n─ SalaryStructure ─1:n─ SalaryStructureComponent ─n:1─ SalaryComponent
   │                  │
   │                  └─1:n─ EmployeeCompensation(employeeId, ctc, effectiveFrom, overrides JSON)
   └─1:n─ PayrollRun ─┬─1:n─ Payslip(employeeId, lines JSON, pdfKey)
                      ├─1:n─ PayrollAdjustment(employeeId, componentCode, amount)
                      └─1:n─ BankFile
StatutoryConfig (effective-dated, config JSON)  →  PF/ESI/PT/LWF/TDS engines
LoanAdvance(employeeId) → auto-deducted by the salary engine
Form16(employeeId, financialYear), StatutoryReturn(kind, period)
```

**Expenses**
```
ExpenseCategory ─1:n─ ExpensePolicy(dailyLimit, monthlyLimit, autoApproveBelow)
       └─1:n─ ExpenseLineItem ─n:1─ ExpenseClaim(employeeId, approvalChain JSON)
                                        ├─n:1─ TravelRequest ─1:1─ TravelAdvance
                                        └─n:1─ ReimbursementBatch ──→ PayrollRun
```

**Onboarding**
```
OnboardingTemplate ─1:n─ OnboardingTaskTemplate
        └─1:n─ OnboardingChecklist(employeeId) ─1:n─ OnboardingTask
OfferLetter(employeeId, signature JSON), AppointmentLetter(employeeId)
```

**Exits**
```
ExitRequest(employeeId, replacementEmployeeId)
   ├─1:n─ ExitClearance(area, assigneeUserId)
   ├─1:1─ ExitInterview(feedback JSON, satisfactionScore)
   ├─1:1─ RelievingLetter(pdfKey)
   └─1:1─ FullAndFinal(breakdown JSON, payrollRunId)
```

**Documents**
```
DocumentFolder (self-ref tree; visibility, roleKeys[], departmentIds[])
   └─1:n─ Document(employeeId?) ─1:1─ PolicyDocument
                                └─1:n─ DocumentAcknowledgment(userId, signature JSON)
EmployeeUpload(employeeId, category)   ← separate from Document, 12 fixed categories
```

**Assets**
```
AssetCategory ─1:n─ AssetItem ─1:n─ AssetAssignment(employeeId)
       │                └─1:1─ currentAssignment (denormalised pointer)
       └─1:n─ AssetRequest(employeeId, fulfilledAssetItemId)
```

**Hiring**
```
JobRequisition(departmentId, locationId) ─1:n─ JobPosting(publicSlug)
        └─1:n─ Application ─n:1─ Candidate
                   ├─1:n─ Interview ─1:n─ InterviewFeedback
                   └─1:n─ HiringOffer(signature JSON)
```

**Performance** — `Goal` (self-ref `parentGoalId`, optional `cycleId`), `ReviewCycle ─1:n─ ReviewResponse`, `Feedback(fromUserId,toUserId)`, `OneOnOne(managerUserId, reportUserId)`

**Engage** — `Announcement`, `Poll ─1:n─ PollResponse`, `RecognitionBadge ─1:n─ Recognition(from/toEmployeeId)`, `ENpsSurvey ─1:n─ ENpsResponse`

**Helpdesk** — `TicketCategory ─1:n─ HelpdeskTicket ─1:n─ TicketComment`; `KbArticle`

**Projects** — `Project ─1:n─ {ProjectMember, ProjectTask, TimesheetEntry}`; `TimesheetPeriod ─1:n─ TimesheetEntry`

**Operations** — `OperationsProject ─1:n─ {OperationsProjectMember, OperationsTask, OperationsDailyUpdate}`; `OperationsTask ─1:n─ {OperationsTaskComment, OperationsTaskActivity}`

**Planning** — `HeadcountPlan(departmentId)`, `HiringPlan(requisitionId?, departmentId?)`

**Cross-cutting** — `InboxItem(userId, entity, entityId, href)`, `AuditLog(actorUserId, entity, entityId, payload JSON)`

**Config** — `SsoConfig`, `IntegrationConfig`

### Referential-integrity notes
- `User → Organization`: `onDelete: Restrict`
- `Employee → User`, `Employee → Organization`: `onDelete: Restrict`
- `Role → Organization`, `RolePermission`, `UserRole`: `onDelete: Cascade`
- `Permission` is a **global catalog** — no `organizationId`, unique on `(module, action, scope)`
- Composite uniques: `User(organizationId,email)`, `Employee(organizationId,employeeCode)`, `Role(organizationId,key)`, `IntegrationConfig(organizationId,kind)`
- Indexes on `organizationId`, `(organizationId,status)`, `reportingManagerId`, `departmentId`

## Shraddha — 29 model files (31 models; `Product.js` exports 3)

| Cluster | Models |
|---|---|
| Identity | `User`, `ArchivedUser`, `Role` |
| Catalog | `ProductKoken`, `ProductBIX`, `ProductIMADA`, `MsilCode` |
| Sales | `Order`, `BookingStatusEvent`, `Reservation` |
| Inventory (IMS) | `StockBalance`, `StockMovement`, `StockBatch`, `StockAdjustment`, `StockCount`, `StockCountLine`, `StockHealth`, `InventorySnapshot`, `SnapshotRun`, `InventoryConfig`, `InventoryAlert`, `AlertRule`, `OversoldException`, `Location` |
| Import/Export | `ImportJob`, `ImportRow`, `ImportError`, `ExportJob` |
| Cross-cutting | `AuditLog`, `Notification`, `Counter` |

**Zero overlap with the HRMS domain.** The only shared concepts are `User`, `Role`, `AuditLog`, `Notification` and `Location` — and Shraddha's `Location` is a **stock location**, not an office location. Despite the identical name it is not equivalent (Critical Rule 9).

---

# Environment variables Shraddha must gain

| Var | From DTA | Shraddha has |
|---|---|---|
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL` | ✅ | only `JWT_SECRET`, `JWT_EXPIRES_IN` |
| `STORAGE_LOCAL_PATH`, `STORAGE_DRIVER` | ✅ | — (multer paths hardcoded in `importUpload.js`) |
| `BIOMETRIC_WEBHOOK_SECRET` | ✅ | — |
| `REDIS_ENABLED`, `REDIS_HOST`, `REDIS_PORT` | ✅ | — |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | ✅ (undeclared) | — |
| `MAIL_*` | ✅ | has `SMTP_HOST/PORT/USER/PASS`, `EMAIL_FROM` (different names) |
| `DATABASE_URL` (Postgres) | ✅ | has `MONGODB_URI` |
| `CORS_ORIGIN` | ✅ | has `FRONTEND_URL` |
| `API_PREFIX` | ✅ | hardcoded `/api/v1` in `app.js` |

Shraddha additionally has `BOOKING_CC_EMAILS` and `SUPPORT_TEAM_EMAILS`, which have no HRMS equivalent.
