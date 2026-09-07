# HRMS Replication Plan — Recommended Integration Strategy

> Analysis phase only. **Nothing has been implemented.** This document is the recommendation for what to do next, and what to decide before starting.
>
> **UPDATE — every design blocker is now resolved.** See [`architecture-decisions.md`](architecture-decisions.md) for the ten accepted decisions and their full consequences:
> **AD-1** single-tenant · **AD-2** MongoDB · **AD-3** multi-role · **AD-4** Customer ≠ Employee · **AD-5** Operations & Projects excluded · **AD-6** JavaScript + Zod · **AD-7** S3 storage · **AD-8** targeted rate limiting · **AD-9** root tidy-up · **AD-10** application-level field encryption + SSE-KMS · **AD-11** migration source deferred, pipeline prepared · **AD-12** state deferred, statutory config stays state-parameterised data · **AD-13** headcount 50–200 for planning only · **AD-14** same domain, `/hrms/` prefix, shared session · **AD-15** attendance selfie + GPS with consent and audit · **AD-16** retention: selfies 90 d, audit 3 yr, configurable.
>
> **Revised scope: 22 modules · 81 submodules · 312 endpoints · 82 models · 8 roles · 31 module keys.**
> **Phase 0 is unblocked and can begin.**

---

## 1. Integration options evaluated

### Option A — Reuse substantial DTA HRMS code and adapt it into Shraddha

Lift DTA's NestJS modules and React pages into Shraddha, adapting them where they don't fit.

| | |
|---|---|
| **Requires** | NestJS + Fastify + Prisma + PostgreSQL running alongside Express + Mongoose + MongoDB; Ant Design alongside Tailwind; TypeScript alongside JavaScript; a pnpm workspace over two npm projects |
| **Pros** | Preserves DTA's tested logic verbatim; fastest path to "the screens exist"; keeps strict typing |
| **Cons** | Two backends, two ORMs, two databases, two component libraries, two type systems, two auth models in one product. Two logins or a token-bridging shim. The portal would look like two applications behind one nginx. On a 3.7 GB box with ~15 co-tenant apps and a 400 MB PM2 cap, a second Node runtime plus Postgres is not affordable. **Directly violates requirement 19** (HRMS must become a native part of the portal, not a disconnected application) |
| **Verdict** | ❌ **Rejected** |

### Option B — Extract HRMS functionality and integrate it into Shraddha's existing architecture

Take DTA's modules as units, translate each into Express + Mongoose + Tailwind, and slot them into Shraddha's structure.

| | |
|---|---|
| **Requires** | A per-module translation pass; Shraddha's stack throughout |
| **Pros** | One stack, one database, one login, one design system. Module boundaries survive translation |
| **Cons** | "Extract and integrate" understates the work. Every `.tsx` page is AntD-bound; every service is decorator-bound; every model is Prisma-bound. In practice the translation *is* a rewrite — but framed as extraction, it invites copying structure without re-deriving whether that structure fits Shraddha (e.g. carrying `organizationId` into a single-tenant product, or importing both `operations` and `projects`) |
| **Verdict** | ⚠️ **Close, but the framing is wrong** — it hides the true cost and encourages carrying DTA's accidents across |

### Option C — Use DTA HRMS as the functional reference and rebuild natively in Shraddha's architecture ✅

Treat DTA as the **specification of behaviour**: its data model, business rules, permission matrix, API contracts and screen inventory. Build the HRMS in Express + Mongoose + Tailwind + React 19, following the conventions already proven in Shraddha's inventory module. Port the pure, framework-free logic verbatim (RBAC, statutory engines, salary engine, leave duration rules, Zod schemas).

| | |
|---|---|
| **Requires** | Discipline in treating DTA as the source of truth for *behaviour*, and Shraddha as the source of truth for *structure* |
| **Pros** | One stack, one DB, one auth, one design system, one deployment. HRMS is genuinely native (req. 19). Functional parity is preserved by referencing DTA rule-by-rule (req. 18). Lets us drop DTA's accidents (unused S3 config, unwired SSO, duplicated `projects`/`operations`, unenforceable multi-tenancy) deliberately rather than inheriting them. Reuses Shraddha's real strengths — Socket.IO, event bus, `Counter`, Excel pipeline, mailer, deployment |
| **Cons** | Highest raw line count. Loses TypeScript's compile-time safety (mitigated by Zod at every boundary). Requires ~22 UI primitives before feature work starts. Business rules must be transcribed carefully or parity silently breaks |
| **Verdict** | ✅ **RECOMMENDED** |

---

## 2. Recommendation: **Option C**

### Why

1. **Requirement 19 is decisive.** "The final HRMS should become a native part of the Shraddha portal, not a disconnected application." Option A produces two applications behind one domain. Option C produces one.

2. **The stacks are incompatible at every layer.** NestJS/Fastify vs Express; Prisma/PostgreSQL vs Mongoose/MongoDB; Ant Design vs Tailwind; TypeScript vs JavaScript; React 18 vs 19; router v6 vs v7. There is **no layer** where DTA code runs unchanged inside Shraddha. Given that, "reuse" is a choice about *framing*, not about saving work.

3. **Infrastructure reality.** One EC2 box, 3.7 GB RAM, no swap, ~15 co-tenant production apps, a 400 MB PM2 cap on the existing backend. Adding a second Node process plus PostgreSQL is not viable. The deploy workflow's own comments show the team already treats this box's memory as scarce.

4. **Shraddha already has a proven blueprint.** The inventory module is 13,283 LOC of consistent `routes → controller → service → model` with route-level permission guards, an event bus, transactional writes, an import pipeline and verification scripts. HRMS should look like *that*, not like a foreign body.

5. **The genuinely valuable DTA code is framework-free and ports cleanly.** ~1,400 LOC of pure logic (RBAC evaluation, PF/ESI/PT/LWF/TDS engines with tests, salary engine, LOP, leave duration + sandwich rule, manager-chain, org-chart layout) plus ~3,500 LOC of Zod schemas. That is the expensive, hard-to-re-derive part, and Option C keeps all of it.

6. **Option C lets us not inherit DTA's mistakes.** Unused S3 config, unwired SSO, a Reports module with 3 definitions behind a prominent nav item, two overlapping project subsystems, and multi-tenancy that MongoDB cannot enforce anyway.

### What "functional parity" means under Option C

Parity is measured against **DTA's actual behaviour**, module by module, using `hrms-module-inventory.md` and `hrms-api-map.md` as the checklist:
- Every module, submodule and tab
- Every endpoint, method and permission tuple
- Every form field, validation rule, conditional field and dropdown dependency
- Every business rule (sandwich rule, direct-manager approval, `autoApproveBelow`, probation/notice date sync, conditional advance-salary approval, two-stage exit approval, category-scoped helpdesk resolution, separation of duties in the matrix)

Parity is **not** measured against `DTA_HRMS/CLAUDE.md`, which describes features that were never built (shifts, rosters, geofencing, field-level encryption, S3, Redis dashboard caching).

---

## 3. Proposed target folder structure

> **Proposal only. Nothing has been created.**

```
shraddha-impex-customer-portal/
│
├── shared/                                    ← NEW: the one thing both halves import
│   ├── package.json                           (name: @shraddha/shared, plain ESM .js)
│   └── src/
│       ├── permissions/
│       │   ├── modules.js                     MODULES, ACTIONS, SCOPES constants
│       │   ├── matrix.js                      ROLE → permission[] (ported from packages/rbac)
│       │   ├── has-permission.js              hasPermission(), canAccessModule(), SCOPE_RANK
│       │   └── index.js
│       └── schemas/                           Zod schemas (ported from packages/shared-types)
│           ├── common.js  employee.js  attendance.js  leave.js  payroll.js
│           ├── expense.js onboarding.js exit.js  document.js  asset.js
│           ├── hiring.js  performance.js engage.js helpdesk.js org.js
│           └── index.js
│
├── backend/
│   ├── app.js                                 MODIFIED: mount /api/v1/hrms/*
│   │                                          (AD-14: same origin — no nginx change)
│   ├── server.js                              MODIFIED: HRMS seeds + event subscribers +
│   │                                          runHrmsRetentionSweep() on the daily cron (AD-16)
│   │
│   ├── config/
│   │   ├── database.js                        unchanged
│   │   ├── seedRoles.js                       MODIFIED: + 9 HRMS roles as permission tuples
│   │   └── hrms/                              ← NEW
│   │       ├── seedPermissions.js             the global permission catalog
│   │       ├── seedLeaveTypes.js              MUST run before the first employee
│   │       ├── seedHolidays.js                per year + region
│   │       ├── seedDesignations.js
│   │       ├── seedEmploymentTypes.js
│   │       ├── seedSalaryComponents.js
│   │       ├── seedStatutoryConfig.js         ⚠ AD-12: ships EMPTY — no slabs, no
│   │       │                                 state. Populated once the state is known
│   │       ├── seedTicketCategories.js
│   │       ├── seedAssetCategories.js
│   │       └── seedExpenseCategories.js
│   │
│   ├── middlewares/
│   │   ├── auth.js                            MODIFIED: attach the resolved actor
│   │   ├── rbac.js                            MODIFIED: re-export from shared/, keep legacy authorize()
│   │   ├── requirePermission.js               ← NEW: scoped guard {module,action,scope,resourceParam}
│   │   │                                         (AD-1: no tenantContext.js — single-tenant)
│   │   ├── auditLogger.js                     MODIFIED: before/after capture
│   │   ├── validate.js                        ← NEW: Zod validation middleware
│   │   ├── uploadHrms.js                      ← NEW: multer temp → storage.put() → unlink
│   │   ├── rateLimiters.js                    ← NEW (AD-8): targeted limiters —
│   │   │                                         login (IP+email), refresh, password,
│   │   │                                         public careers, biometric, exports.
│   │   │                                         express-rate-limit already installed
│   │   └── errorHandler.js                    unchanged
│   │
│   ├── models/                                existing 29 files unchanged
│   │   └── hrms/                              ← NEW (~90 Mongoose schemas)
│   │       ├── CompanyProfile.js
│   │       ├── Employee.js                    the hub: managerChain[], probation, notice
│   │       ├── Permission.js  HrmsRole.js
│   │       ├── Department.js  OfficeLocation.js  Designation.js  EmploymentType.js
│   │       ├── CustomFieldDefinition.js
│   │       ├── AttendanceRecord.js  AttendanceCorrection.js
│   │       ├── AttendanceConsent.js       ← AD-15: per-purpose, versioned, withdrawable
│   │       ├── HrmsRetentionPolicy.js     ← AD-16: versioned config + history
│   │       ├── LeaveType.js LeavePolicy.js LeaveBalance.js LeaveRequest.js Holiday.js
│   │       ├── PayGroup.js SalaryComponent.js SalaryStructure.js
│   │       ├── EmployeeCompensation.js  StatutoryConfig.js
│   │       ├── PayrollRun.js Payslip.js PayrollAdjustment.js
│   │       ├── LoanAdvance.js Form16.js BankFile.js StatutoryReturn.js
│   │       ├── ExpenseCategory.js ExpensePolicy.js ExpenseClaim.js
│   │       ├── TravelRequest.js TravelAdvance.js ReimbursementBatch.js
│   │       ├── OnboardingTemplate.js OnboardingChecklist.js OnboardingTask.js
│   │       ├── OfferLetter.js AppointmentLetter.js
│   │       ├── ExitRequest.js ExitClearance.js ExitInterview.js
│   │       ├── RelievingLetter.js FullAndFinal.js
│   │       ├── DocumentFolder.js HrDocument.js PolicyDocument.js
│   │       ├── DocumentAcknowledgment.js EmployeeUpload.js
│   │       ├── AssetCategory.js AssetItem.js AssetAssignment.js AssetRequest.js
│   │       ├── JobRequisition.js JobPosting.js Candidate.js Application.js
│   │       ├── Interview.js InterviewFeedback.js HiringOffer.js
│   │       ├── Goal.js ReviewCycle.js ReviewResponse.js Feedback.js OneOnOne.js
│   │       ├── Announcement.js Poll.js PollResponse.js
│   │       ├── RecognitionBadge.js Recognition.js EnpsSurvey.js EnpsResponse.js
│   │       ├── TicketCategory.js HelpdeskTicket.js TicketComment.js KbArticle.js
│   │       ├── HeadcountPlan.js HiringPlan.js
│   │       └── InboxItem.js
│   │
│   ├── modules/                               existing 9 modules unchanged
│   │   └── hrms/                              ← NEW: one folder per module,
│   │       │                                     mirroring the inventory module's layering
│   │       ├── hrms.routes.js                 aggregator mounted at /api/v1/hrms
│   │       ├── employees/                     employee.routes|controller|service.js
│   │       │                                  customField.*, csvImport.*, analytics.*
│   │       ├── migration/                     ← AD-11: source-agnostic import pipeline
│   │       │   ├── import.routes|controller|service.js  mirrors the IMS import lifecycle
│   │       │   ├── canonical.js               CanonicalEmployeeRecord shape + Zod schema
│   │       │   ├── pipeline.js                validate → sanitise → preview → commit → link → verify
│   │       │   └── adapters/                  ⚠ EMPTY — written when the source is chosen
│   │       ├── org/                           department.* location.* designation.*
│   │       │                                  employmentType.* orgChart.* company.*
│   │       ├── attendance/                    attendance.* correction.* selfie.* biometric.* consent.*
│   │       │                              (AD-15: selfie via presigned S3, never public)
│   │       ├── leave/                         leave.* balance.* holiday.* accrual.job.js
│   │       ├── payroll/
│   │       │   ├── payGroup.* salaryComponent.* salaryStructure.* compensation.*
│   │       │   ├── payrollRun.* payslip.* adjustment.* bankFile.* form16.* loan.*
│   │       │   ├── engines/  salaryEngine.js  salaryFormula.js  leaveLop.js
│   │       │   └── statutory/ pf.js esi.js pt.js lwf.js tds.js index.js
│   │       ├── expenses/                      category.* policy.* claim.* travel.* batch.*
│   │       ├── onboarding/                    template.* checklist.* offerLetter.*
│   │       ├── exits/                         exitRequest.* clearance.* fnf.* relieving.*
│   │       ├── documents/                     folder.* document.* policy.* acknowledgment.*
│   │       ├── assets/                        category.* item.* assignment.* request.*
│   │       ├── hiring/                        requisition.* posting.* candidate.*
│   │       │                                  application.* interview.* offer.* publicCareers.*
│   │       ├── performance/                   goal.* cycle.* review.* feedback.* oneOnOne.*
│   │       ├── engage/                        announcement.* poll.* recognition.* enps.*
│   │       ├── helpdesk/                      ticket.* comment.* kb.*
│   │       ├── planning/                      headcount.* hiringPlan.*
│   │       ├── inbox/                         inbox.routes|controller|service.js
│   │       ├── dashboard/                     dashboard.* widgets.service.js
│   │       └── reports/                       report.* catalog.js
│   │
│   ├── utils/                                 existing 24 files unchanged
│   │   └── hrms/                              ← NEW
│   │       ├── managerChain.js                recompute on manager change
│   │       ├── approvalChain.js               build + advance approval steps
│   │       ├── dateRules.js                   working days, sandwich rule, probation/notice sync
│   │       ├── money.js                       Decimal128 helpers — NEVER Number for currency
│   │       ├── scopeFilter.js                 self/team/department/org → Mongo query
│   │       ├── storage/                       ← AD-7: driver interface
│       │   ├── index.js                   put/getStream/getSignedUrl/delete/exists
│       │   ├── s3.js                      @aws-sdk/client-s3 + presigner (prod, SSE-KMS)
│       │   └── local.js                   STORAGE_LOCAL_PATH (dev only)
│       ├── crypto/                        ← AD-10: same driver pattern
│       │   ├── index.js                   encryptField / decryptField / blindIndex
│       │   ├── kms.js                     AES-256-GCM + KMS envelope, cached DEK (prod)
│       │   ├── local.js                   key from env, no KMS needed (dev only)
│       │   └── sanitiseCustomFields.js    ← AD-10/AD-11: strips reserved keys from
│       │                                  customFieldValues IN MEMORY, before any write.
│       │                                  Shared by create, update, CSV import + migration
│       ├── mask.js                        ← AD-10: last-4 masking for toJSON + payslips
│   │       ├── geocode.js                     ← AD-15: provider-swappable, ASYNC after the
│       │                                  punch, coarse-coordinate cache, degrades to raw lat/lng
│   │       ├── hrmsEvents.js                  EVENTS.LEAVE_APPROVED, PAYROLL_LOCKED, …
│   │       ├── hrmsMailTemplates.js
│   │       └── pdf/
│   │           ├── payslipPdf.js  form16Pdf.js  offerLetterPdf.js
│   │           ├── appointmentLetterPdf.js  relievingLetterPdf.js
│   │           ├── confirmationLetterPdf.js  pdfShared.js
│   │
│   └── scripts/hrms/                          ← NEW
│       ├── migrate-passwords-to-hash.js       PHASE 0 — critical
│       ├── seed-hrms-all.js
│       ├── backfill-manager-chain.js
│       ├── verify-no-plaintext-sensitive.js   ← AD-11: standing guard, not one-off
│       ├── verify-permissions.js
│       ├── verify-payroll.js                  reconcile a run against the engines
│       ├── verify-statutory-coverage.js      ← AD-12: every resolved stateCode configured?
│       ├── verify-unbounded-queries.js       ← AD-13: no HRMS query without a limit
│       ├── verify-no-hardcoded-retention.js  ← AD-16: no literal 90 / 1095 in services
│       ├── verify-leave-balances.js
│       └── verify-hrms-schema.js
│
└── frontend/
    ├── vite.config.js                         MODIFIED: add a dev proxy + @ alias
    └── src/
        ├── routes/index.jsx                   MODIFIED: nest /hrms/* under the existing
        │                                      ProtectedRoute → MainLayout (AD-14).
        │                                      Public /careers/* sits OUTSIDE it
        ├── constants/
        │   ├── navItems.js                    ← NEW: declarative nav (existing + HRMS)
        │   │                              AD-14: ~33 items — GROUPS ARE MANDATORY
        │   └── hrms/                          statuses, enums, option lists
        ├── components/
        │   ├── layout/
        │   │   ├── Sidebar.jsx                MODIFIED: render from navItems.js
        │   │   └── ProtectedRoute.jsx         MODIFIED: + requiresModules[]
        │   ├── ui/                            existing 23 files
        │   │   ├── Select.jsx                 ← NEW (Tier 1 — blocks every form)
        │   │   ├── MultiSelect.jsx            ← NEW
        │   │   ├── ServerDataTable.jsx        ← NEW (wraps existing Pagination)
        │   │   ├── Tabs.jsx                   ← NEW
        │   │   ├── FilterBar.jsx              ← NEW
        │   │   ├── FormDrawer.jsx             ← NEW
        │   │   ├── DetailGrid.jsx             ← NEW (Descriptions equivalent)
        │   │   ├── DateRangePicker.jsx        ← NEW (extends DateField)
        │   │   ├── TimePicker.jsx             ← NEW (hourly leave)
        │   │   ├── FileUpload.jsx             ← NEW
        │   │   ├── Avatar.jsx                 ← NEW
        │   │   ├── TreeView.jsx               ← NEW
        │   │   ├── StatusPill.jsx             ← NEW (generalises StatusBadge)
        │   │   ├── ApprovalActions.jsx        ← NEW
        │   │   ├── PermissionGate.jsx         ← NEW
        │   │   └── form/                      ← NEW: RHF-wired fields
        │   │       ├── TextField.jsx  TextareaField.jsx  SelectField.jsx
        │   │       ├── DateFieldRHF.jsx  NumberField.jsx  CheckboxField.jsx
        │   │       ├── RadioField.jsx  FieldArray.jsx
        │   └── hrms/                          ← NEW: shared HRMS components
        │       ├── EmployeePicker.jsx  DepartmentPicker.jsx
        │       ├── SignaturePad.jsx           (ported)
        │       ├── CameraCapture.jsx          (ported)
        │       ├── OrgChart.jsx               (layout algorithm ported)
        │       ├── LeaveBalanceCard.jsx  ClockInCard.jsx
        │       └── KanbanBoard.jsx            (Phase 5 ONLY, and only if the hiring
        │                                       pipeline ships as a board. AD-5 removed the
        │                                       Operations use case, and with it @dnd-kit
        │                                       and MarkdownEditor entirely)
        ├── pages/
        │   └── hrms/                          ← NEW: one folder per module
        │       ├── Dashboard/  Inbox/  Me/
        │       ├── Employees/     (List, Profile, Edit, Analytics, BulkImport)
        │       ├── Attendance/    (My, Team, Corrections)
        │       ├── Leave/         (My, Approvals, Calendar, Holidays)
        │       ├── Payroll/       (Overview, Payslips, Advances, PayGroups,
        │       │                   Structures, Runs, Statutory)
        │       ├── Expenses/      (Claims, Travel, Categories, Batches)
        │       ├── Onboarding/    (MyOnboarding, Checklists, Templates, Offers)
        │       ├── Exits/         (MyExit, Clearances, Requests)
        │       ├── Documents/     (Library, Policies, Mine, Folders)
        │       ├── Assets/        (Mine, Requests, Inventory, Categories)
        │       ├── Hiring/        (Requisitions, Candidates, Pipeline,
        │       │                   Interviews, Postings, Offers)
        │       ├── Performance/   (Goals, Reviews, Feedback, OneOnOnes, Cycles)
        │       ├── Engage/        (Announcements, Polls, Recognition, ENps)
        │       ├── Helpdesk/      (MyTickets, Queue, KB)
        │       ├── Org/           (Departments, Locations, CustomFields, OrgChart)
        │       ├── Planning/      (Headcount, HiringPlan)
        │       ├── Reports/  AuditLogs/  Settings/
        │       └── Careers/       (public — Home, Posting, OfferAccept)
        ├── services/hrms/                     ← NEW: one API module per domain
        │   ├── employees.js attendance.js leave.js payroll.js expenses.js
        │   ├── onboarding.js exits.js documents.js assets.js hiring.js
        │   ├── performance.js engage.js helpdesk.js org.js planning.js
        │   ├── dashboard.js inbox.js reports.js
        ├── store/hrms/                        ← NEW: UI state only (server state → TanStack Query)
        │   └── hrmsUiStore.js
        ├── hooks/
        │   ├── usePermissions.js              ← NEW (over shared/permissions)
        │   ├── useMe.js                       ← NEW
        │   └── useServerTable.js              ← NEW (page/pageSize/sort/filter state)
        └── utils/hrms/
            ├── formatMoney.js  formatDate.js  statusColors.js
            └── downloadBlob.js                (PDF/CSV download helper)
```

### Structural decisions embodied above

| Decision | Rationale |
|---|---|
| `shared/` as a third top-level folder | Ends the hand-mirrored permission files. 33 modules × 10 actions × 4 scopes cannot be maintained in two places |
| `models/hrms/` and `modules/hrms/` subfolders | ~90 new schemas and 18 new modules would swamp the existing flat folders. Keeps a clean boundary for review |
| `pages/hrms/`, `services/hrms/`, `components/hrms/` | Same reason on the frontend |
| **Extending** `Sidebar.jsx`, `ProtectedRoute.jsx`, `app.js`, `seedRoles.js` rather than forking | Requirement 19 — one nav, one guard, one app |
| `HrDocument.js`, `OfficeLocation.js`, `HrmsRole.js` | **Avoids collisions** with the existing `Location` (stock) and `Role` (flat) models |
| Statutory engines in their own folder with tests | The highest-value ported code; must stay independently verifiable |
| `verify-*.js` scripts under `scripts/hrms/` | Continues Shraddha's existing convention |
| Public careers under `pages/hrms/Careers/` + an unauthenticated router branch | 7 `@Public()` endpoints must be deliberate, not accidental |

---

## 4. Effort estimate

| Phase | Scope | Est. |
|---|---|---|
| **0 — Security & platform** | Password hashing migration + retire the duplicate plaintext login; refresh tokens + rotation; **targeted rate limiters (AD-8)**; `/me` extension; shared permissions module; `requirePermission` middleware; `requiresModules` route gate; declarative nav; 20 UI primitives; `pdf-lib`; **S3 storage driver + presigned URLs, SSE-KMS (AD-7)**; **field-encryption service + blind index + `toJSON` masking (AD-10)**; audit + notification extensions; `User.roles[]` backfill; **root tidy-up (AD-9)** | **4.5–5.5 weeks** |
| **1 — Foundation** | `CompanyProfile`, Employee, org structure, custom fields, Inbox, directory/profile/form/CSV import, org chart, HRMS settings, **source-agnostic migration pipeline + two-pass manager linking (AD-11)** | **4–5 weeks** |
| **2 — Daily ops** | Holidays, Leave (sandwich rule, approvals), Attendance (selfie, GPS, corrections, biometric), Dashboard v1. **Consent capture + presigned selfie access (AD-15)**; async geocoding offsets it | **5–6 weeks** |
| **3 — Money** | Payroll (59 endpoints, 13 models, 5 statutory engines, PDFs, bank files, Form 16, advances) + Expenses & Travel. **State resolution chain + unconfigured-state pre-flight (AD-12)** | **8–10 weeks** |
| **4 — Lifecycle** | Documents, Assets, Onboarding, Exits (handover as free-text per AD-5) | **5.5–6.5 weeks** |
| **5 — Talent** | Helpdesk, Engage, Performance, Hiring + public careers | **7–8 weeks** |
| **6 — Reporting** | Dashboard v2, Reports, Planning, audit viewer, integrations | **2.5–3.5 weeks** |
| | **Total** | **~37–44 weeks of focused work** |

Reflects all six accepted decisions. Operations and Projects & Timesheets are **out of scope** (AD-5) and are not costed here. Assumes a small team working in parallel where the dependency map allows; a single developer would be materially longer.

**Where the decisions moved the number:** AD-1 (single-tenant) trims Phases 0 and 1 — no tenancy middleware, ~82 schemas lose a field and an index, and login sheds its two-step org lookup. AD-5 trims Phases 0, 4 and 6 — two fewer UI primitives, a simpler exit handover, and no Operations reports. AD-2, AD-3, AD-4 and AD-6 are cost-neutral: they confirm assumptions the estimate already made.

---

## 5. High-risk areas

> Post-decision status: **three risks are closed** — *RLS has no MongoDB equivalent* and *multi-tenant query discipline* (both by AD-1), and *two role systems colliding* (by AD-3 + AD-4).
> **Three are newly introduced** — the `hasPermission` name collision and the per-request Actor build cost (AD-3), and the exit-handover parity reduction (AD-5). All three are detailed in [`architecture-decisions.md`](architecture-decisions.md).

| # | Risk | Why | Mitigation |
|---|---|---|---|
| 1 | **Payroll correctness** | 5 statutory engines, LOP, formula evaluation, adjustments, loans. Errors are legally and financially material | Port the engines *and* their Vitest suite; build `verify-payroll.js`; parallel-run against DTA on real data before cutover |
| 2 | **Money in MongoDB** | JavaScript `Number` is IEEE-754 double. Prisma `Decimal` has no automatic equivalent | **Mandate `Decimal128` for every currency field.** Add a schema-lint script that fails on `Number` in a money field |
| 3 | **Password migration** | Live plaintext passwords, a second unguarded login route, no rotation | Phase 0. Accept plaintext once on next login, re-store hashed, then delete the fallback. Retire the duplicate route in the same change |
| 4 | **Losing referential integrity** | Prisma FKs + `onDelete` become application-enforced | Explicit existence checks in services; `verify-hrms-schema.js`; soft-delete rather than hard-delete on employee-facing data |
| 5 | **The RBAC scope model** | Nothing like `self/team/department/org` exists in Shraddha today. Every HRMS endpoint depends on it | Build and test it in Phase 0 in isolation, with the ported unit tests, before any module uses it |
| 6 | **`managerChain` drift** | Denormalised array. If it isn't recomputed on every manager change, team-scope checks silently fail | Recompute in one service function only; `backfill-manager-chain.js`; a verification script |
| 7 | **Business-rule transcription** | The sandwich rule, direct-manager-only approval, `autoApproveBelow`, probation/notice sync, conditional advance approval — all easy to approximate and get subtly wrong | Write the rule as a test *first*, from `hrms-module-inventory.md`, then implement |
| ~~8~~ | ~~**Memory ceiling**~~ | ✅ **Resolved.** At AD-13's 50–200 headcount a payroll run is a ~4 MB working set, and AD-7's presigned URLs keep file bytes out of the process. **Fits the existing 400 MB cap — no upsize needed.** Batching and streaming are still built, so 10× is a config change | — |
| 9 | **Frontend scale** | ~40 new routes, ~90 new page files on top of an existing 19-route app | Build the primitives first; one module per PR; keep `pages/hrms/` isolated |
| 10 | **Two role systems colliding** | `Customer` must never receive HRMS permissions | Multi-role on `User`; explicit deny-list for `Customer`; a permission-verification script |
| 11 | **Loss of type safety** | ~74,000 LOC of strict TypeScript becomes JavaScript | Zod validation at every boundary (already a dependency); the ported schemas are the safety net |
| 12 | **Public careers surface** | 7 unauthenticated write endpoints on a production ERP domain | Rate-limit them specifically; validate hard; consider a subdomain |
| 13 | **Biometric HMAC** | Needs the raw request body; Express parses JSON by default | `express.raw()` on that route only, mounted before `express.json()` |
| 14 | **Nominatim** | Unkeyed public API, strict usage policy, called synchronously at clock-in | Make the provider swappable; cache by coarse coordinate; fall back to storing raw lat/lng |
| 15 | **No test suite in either repo** | Only DTA's statutory engines are tested | Port those tests; add integration tests for payroll, leave duration and permission evaluation at minimum |
| 16 | **Scope creep from the spec** | `CLAUDE.md` describes shifts, rosters, geofencing, encryption, S3 — none of which exist | Parity is measured against **DTA's code**, not its spec. This is stated in every document here |

---

## 6. Blockers

### ✅ Architectural — RESOLVED

All six 🔴 blockers were answered by the product owner and are recorded in [`architecture-decisions.md`](architecture-decisions.md).

| # | Question | Decision |
|---|---|---|
| 1 | Single-tenant or multi-tenant? | **AD-1 — Single-tenant.** No `organizationId`; `Organization` → one `CompanyProfile`; no tenancy middleware; the RLS gap is closed rather than mitigated |
| 2 | MongoDB or PostgreSQL? | **AD-2 — MongoDB.** ~82 Mongoose schemas; `Decimal128` mandatory for money; FK integrity enforced in services |
| 3 | How do the two role systems combine? | **AD-3 — Multi-role.** `User.roles[]` added alongside the existing `role`; legacy 6 roles lifted into permission tuples; nothing existing breaks |
| 4 | Can `Customer` be an employee? | **AD-4 — Never.** Enforced at employee creation, role assignment, the permission resolver and the nav |
| 5 | Operations / Projects in scope? | **AD-5 — Excluded.** −11 models, −38 endpoints, −1 role, −3 dependencies. One parity reduction: exit handover becomes free-text |
| 6 | JavaScript or TypeScript? | **AD-6 — JavaScript + Zod.** Zod becomes load-bearing at every boundary |

**Consequences already folded into this document:** the target folder structure (§3) and the effort estimate (§4) below.

### 🟠 Product / data — still open

| # | Question |
|---|---|
| 7 | **Is existing employee data being migrated?** From where — spreadsheets, an existing HR system, or manual entry? This determines the CSV import format and whether a migration script is needed |
| 8 | **Which statutory rules apply?** The engines are India-specific (PF/ESI/PT/LWF/TDS). **Which state's PT and LWF slabs?** DTA ships Madhya Pradesh holiday defaults — is Shraddha Impex MP-based? |
| 9 | **Payroll cutover** — is there a live payroll system today? Parallel-run period? |
| 10 | **Headcount** — drives pagination, batching, memory planning and whether payroll can run in one pass |
| 11 | **Is biometric hardware in use?** Determines whether the webhook + HMAC + driver layer is needed |
| 12 | **Is attendance selfie + GPS wanted?** Camera and location capture on every punch has privacy and consent implications, and adds `getUserMedia` + geocoding |
| 13 | **Is a public careers site wanted** on the same domain as the customer portal? |
| ~~14~~ | ~~Anthropic-powered Operations summariser?~~ — **moot under AD-5** (Operations excluded) |
| 15 | **Is SSO required?** It is declared but unwired in DTA — building it properly is new work, not a port |
| 16 | **Which reports are actually needed?** DTA ships only 3. Real HR reporting needs are probably wider |

### 🟡 Operational

| # | Question |
|---|---|
| 17 | **Same domain and instance, or separate?** e.g. `erp.shraddhaimpex.net/hrms` vs a subdomain. Affects nginx, CORS and session sharing |
| 18 | **Memory budget** — will the EC2 instance be upsized, or must HRMS fit inside the current 400 MB cap alongside the existing backend? |
| ~~19~~ | ~~File storage — local disk or S3?~~ ✅ **Answered — AD-7: S3**, private bucket, IAM instance role, presigned downloads. *Retention policy still needed for the lifecycle rules* |
| 20 | **Data retention & privacy** — salary, PAN, bank details and performance reviews are sensitive. Is field-level encryption required? (DTA specifies it but does not implement it) |
| ~~21~~ | ~~Rate limiting — does “none” still stand?~~ ✅ **Answered — AD-8: targeted limiters** on auth + public careers + exports; existing portal routes stay unthrottled |
| ~~22~~ | ~~Root-folder tidy-up?~~ ✅ **Answered — AD-9: clean it.** 7 files / ~1.15 MB verified unreferenced. **Not yet deleted** — needs a go-ahead as its own commit |
| 23 | **Are the two `docs/` and `documentation/` folders both intended to persist?** `docs/` currently holds business spreadsheets, not developer docs |

---

## 7. Guardrails for the implementation phase

1. **DTA is read-only.** No file in `DTA_HRMS/` is modified, moved or deleted. It is the reference.
2. **Nothing is copied verbatim** except pure, framework-free logic — and that is re-expressed in JavaScript, reviewed, and tested.
3. **Parity is checked against DTA's code**, using `hrms-module-inventory.md` and `hrms-api-map.md` as the checklist — never against `CLAUDE.md`.
4. **No existing Shraddha behaviour is changed** except the Phase 0 security work and the four deliberate extensions (`Sidebar`, `ProtectedRoute`, `app.js`, `seedRoles.js`).
5. **Every HRMS route is guarded** by `protect` + `requirePermission`. Fail closed, matching both systems' existing posture.
6. **Every HRMS endpoint validates with Zod** before touching a model.
7. **Every money field is `Decimal128`.**
8. **Every module ships with a `verify-*.js` script**, following Shraddha's existing convention.
9. **One module per PR**, in dependency order.
10. **Business rules are written as tests first**, transcribed from the module inventory.

---

## 8. Immediate next step

**All nine blockers are answered. Phase 0 is fully specified and can begin.**

Phase 0 contains no HRMS features and delivers value regardless of what follows: fixing plaintext passwords, adding refresh tokens, building the permission model, moving files to S3 and rate-limiting the login are improvements to the existing portal whether or not the HRMS ever ships.

Three operational follow-ons need an **owner**, not a decision:

| # | Item | Needed for |
|---|---|---|
| 1 | **AWS provisioning** — S3 bucket (Block Public Access, SSE-KMS default, Bucket Keys on), **1–2 customer-managed CMKs with deletion protection**, and an IAM instance role granting `s3:*Object` + `kms:GenerateDataKey` + `kms:Decrypt`. **No keys in `.env`** — it is committed to the repository | storage + crypto services |
| 2 | Decide the **retention policy** for payslips, Form 16s, résumés and attendance selfies | the S3 lifecycle rules |
| 3 | Approve the **AD-9 deletion** (7 files, ~1.15 MB, verified unreferenced) | before `shared/` is added |

**No design questions remain.** Employee data migration is **deliberately deferred** under AD-11 — the pipeline is built source-agnostically in Phase 1, and only a thin adapter is written once the source is known.

The operating state is **also deliberately deferred** under AD-12 — PT/LWF slabs stay data, state resolution is redesigned so an unconfigured state **blocks** the payroll run rather than silently deducting zero, and multi-state works by construction.

Headcount is **answered** — AD-13 sets a planning band of **50–200**, used for sizing only and never encoded. Two consequences worth noting: the HRMS **fits the existing 400 MB PM2 cap with no instance upsize**, and **manual employee entry is a viable interim**, so AD-11's deferred migration is **not on the critical path for go-live**.

Deployment is **settled** — AD-14 puts the HRMS on the existing domain under `/hrms/`, sharing one login and one session, and this was verified to need **no nginx change at all**: `location /` already falls through to the SPA and `location /api/` already proxies. It also unlocks a Phase 0 security upgrade — same-origin makes an **httpOnly refresh-token cookie** practical, and `cookie-parser` plus the cookie branch in `middlewares/auth.js` are already in place.

Attendance capture is **settled** — AD-15 takes both selfie and GPS, with explicit consent, permission-checked presigned access, SSE-KMS storage and audit logging on **viewing**, not just capture. Three defects in the source are corrected rather than copied: the `@Public()` selfie endpoint, the single shared coordinate pair behind two location labels, and the synchronous Nominatim call on every punch.

Retention is **settled** for the two categories that were growing unbounded — AD-16 sets selfies at 90 days and `AuditLog` at 3 years, both as **configurable data with change history**, never constants. The application sweep is authoritative and the S3 lifecycle rule sits behind it at a longer window as a backstop, so the two can never drift.

**No design questions remain that block Phase 0 or Phase 1.** What is left is one compliance confirmation — whether any audit category needs a live window beyond 3 years, since Indian payroll retention commonly runs 7–8 years — plus three operational items that need an **owner** rather than a decision: AWS provisioning, the remaining retention values, and approval of the AD-9 deletion.
