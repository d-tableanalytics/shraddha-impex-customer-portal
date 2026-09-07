# Architecture Decisions — HRMS in Shraddha Impex

> Status: **ACCEPTED** — confirmed by the product owner.
> These sixteen decisions close every design blocker raised in `hrms-replication-plan.md` §6.
> Everything downstream (schemas, guards, folder structure, effort) now follows from them.
>
> **AD-1 – AD-6** settle the architecture. **AD-7 – AD-9** settle the Phase 0 platform work. **AD-10** settles data protection. **AD-11** and **AD-12** defer the migration source and the operating state while preparing the architecture for both. **AD-13** sets the capacity-planning band. **AD-14** settles deployment: same domain, `/hrms/` prefix, shared session. **AD-15** settles attendance capture. **AD-16** settles data retention.
> Only operational follow-ons (provisioning, retention policy, deletion approval) and Phase 1+ product questions remain open.

---

## Decision register

| # | Decision | Status |
|---|---|---|
| AD-1 | **Single-tenant** — no `organizationId`, no tenancy layer | ✅ Accepted |
| AD-2 | **MongoDB** — Mongoose schemas, no PostgreSQL | ✅ Accepted |
| AD-3 | **Multi-role** — `User.roles[]` alongside the existing `User.role` | ✅ Accepted |
| AD-4 | **Customer can never be an Employee** — hard invariant | ✅ Accepted |
| AD-5 | **Operations and Projects & Timesheets are out of scope** | ✅ Accepted |
| AD-6 | **JavaScript + Zod** — no TypeScript adoption | ✅ Accepted |
| AD-7 | **S3 file storage** — not local disk | ✅ Accepted |
| AD-8 | **Rate limiting** — targeted limiters on auth and public surfaces | ✅ Accepted |
| AD-9 | **Root-folder tidy-up** before `shared/` is added | ✅ Accepted |
| AD-10 | **Application-level encryption** for sensitive employee fields + **S3 SSE-KMS** | ✅ Accepted |
| AD-11 | **Employee data migration source: NOT DECIDED.** Architecture prepared for a later source-agnostic import | ✅ Accepted (deferred) |
| AD-12 | **State NOT DECIDED.** No hardcoded PT/LWF slabs; statutory config is state-parameterised data | ✅ Accepted (deferred) |
| AD-13 | **Headcount 50–200** — planning assumption only, never hardcoded; architecture stays scalable | ✅ Accepted |
| AD-14 | **Same domain, `/hrms/` prefix** — one SPA, one login, one session. No separate domain or auth system | ✅ Accepted |
| AD-15 | **Attendance captures selfie + GPS** — with consent, permission checks, SSE-KMS storage, presigned access, audit | ✅ Accepted |
| AD-16 | **Retention: selfies 90 days, AuditLog 3 years.** Periods are configurable data, never hardcoded | ✅ Accepted |

---

## AD-1 — Single-tenant

**Decision:** The HRMS serves one organisation. `organizationId` is not carried into any schema.

### Consequences

| Area | Effect |
|---|---|
| Schemas | **~82 schemas lose their `organizationId` field and index.** Roughly 164 fewer lines and one less index per collection |
| `Organization` model | Replaced by a **single `CompanyProfile` document** — name, logo, brand, address, statutory identifiers. Read once, cached |
| Login | **Substantially simpler.** DTA's two-step lookup (query `organization` → `withOrg()` per candidate) existed *only* because RLS was forced on `user`. Now: `User.findOne({ email })`. The `orgSlug` login parameter is **dropped** |
| Tenancy middleware | **Not built.** No `tenantContext.js`, no AsyncLocalStorage, no `withOrg`/`tx` wrapper |
| RLS | **Not applicable.** The guarantee it provided is unnecessary — there is nothing to isolate from |
| Unique indexes | `User(orgId,email)` → `User(email)` *(already unique in Shraddha)*; `Employee(orgId,employeeCode)` → `Employee(employeeCode)`; `Role(orgId,key)` → `Role(key)`; `IntegrationConfig(orgId,kind)` → `IntegrationConfig(kind)` |
| `Permission` catalog | Already global in DTA — unchanged |
| Biometric webhook | `POST /attendance/biometric/:orgSlug` → **`POST /attendance/biometric`** |
| Public careers | No org resolution needed on `/careers/*` |
| Per-tenant theming | Becomes ordinary company branding — `CompanyProfile.brand` still drives logo and colours, but there is only ever one |
| Query discipline | Every service query loses a filter clause. **Lower risk, not higher** — the class of "forgot the tenant filter" bug disappears entirely |

### Risk closed
The 🟠 High risk *"RLS has no MongoDB equivalent"* is **eliminated**, not mitigated. It was only a risk under multi-tenancy.

### Reversibility
Poor. Retrofitting tenancy later means touching every schema, every query and every index. That is the accepted trade — Shraddha Impex is one company with one portal, and an unenforced tenant column would have given a false sense of isolation.

---

## AD-2 — MongoDB

**Decision:** HRMS data lives in the existing MongoDB instance via Mongoose. No second database.

### Consequences

| Area | Effect |
|---|---|
| Schemas | **~82 Mongoose schemas** under `backend/models/hrms/` |
| Primary keys | `ObjectId`, not UUID. All `:id` route params validate as ObjectId |
| **Money** | 🔴 **`Decimal128` is mandatory** for every currency field — `ctc`, `gross`, `netPay`, `totalDeductions`, `employerContributions`, `amount`, `principal`, `outstanding`, `monthlyInstallment`, `budgetMin/Max`, `expectedSalary`, `total`, `dailyLimit`, `monthlyLimit`, `autoApproveBelow`, `estimatedBudget`, `advanceRequested`, `totalAmount`, `netPayable`, `purchasePrice`, `budgetPerHead`, `totalBudget`. JavaScript `Number` is IEEE-754 and **must never** hold currency |
| Referential integrity | No FK constraints. `onDelete: Restrict/Cascade` becomes **explicit service-level checks**. Soft-delete (`deletedAt`) on employee-facing collections, as DTA does |
| Self-referencing trees | `Department.parentId`, `DocumentFolder.parentId`, `Goal.parentGoalId` — app-side recursion or `$graphLookup` |
| Transactions | `mongoose.startSession()` + `withTransaction`, using the existing `utils/mongoSession.js`. **Requires a replica set — Atlas already provides one**, and existing orders/reservations code already depends on it |
| Arrays | `String[]` → native arrays (`roleKeys`, `departmentIds`, `tags`, `labels`, `targetRoleKeys`, `managerChain`) |
| JSON columns | → `Mixed`. DTA has ~20 of them (`approvalChain`, `emergencyContacts`, `dependents`, `customFieldValues`, `lines`, `breakdown`, `totals`, `formula`, `accrual`, `ratings`, `panel`, `itinerary`, `agenda`, `notes`, `actionItems`, `template`, `options`, `answer`, `brand`, `config`). **Mixed is schema-less — Zod validation at the boundary is what constrains them** (see AD-6) |
| Case-insensitive email | Postgres `citext` → lowercase-on-write. **Shraddha's `User` schema already does this** |
| Fuzzy search | `pg_trgm` → text index or anchored regex on `firstName`/`lastName`/`employeeCode`/`email` |
| Dates | Postgres `@db.Date` (date-only) → store as `Date` at UTC midnight, or as a `YYYY-MM-DD` string. **Pick one and hold to it** — DTA's `isoDay` Zod schema (`/^\d{4}-\d{2}-\d{2}$/`) already defines the wire format |

### New risk introduced
🟠 **Loss of FK integrity.** Mitigation: existence checks in services, soft-delete over hard-delete, and `scripts/hrms/verify-hrms-schema.js` to detect orphans.

### New guardrail
`scripts/hrms/verify-money-fields.js` — fails the build if any schema path whose name matches the money list is typed `Number`.

---

## AD-3 — Multi-role

**Decision:** `User` gains `roles: [String]`. The existing `role: String` field stays.

### Model change

```js
// backend/models/User.js  — ADDITIVE ONLY
role:  { type: String, enum: [...existing 6...], default: 'Customer' },  // UNCHANGED
roles: { type: [String], default: [] },   // NEW — HRMS + portal role keys
```

### Consequences

| Area | Effect |
|---|---|
| Existing code | **Nothing breaks.** Every current check (`req.user.role === 'Admin'`, `INVENTORY_ROLES.includes(user.role)`, `ROLE_PERMISSIONS[user.role]`) keeps reading `role` |
| Legacy role mapping | The 6 portal roles are expressed as permission tuples so the new resolver understands them: `Admin → ['*']` wildcard grant; `Sales`, `Inventory Manager`, `Warehouse User`, `Management`, `Customer` → their existing flat permissions, lifted into `{module, action, scope}` form |
| HRMS roles | **8 roles** (see AD-5 — `project_manager` is dropped): `super_admin`, `hr_admin`, `payroll_admin`, `recruiter`, `manager`, `employee`, `it_admin`, `auditor` |
| Effective permissions | Union of all entries in `roles[]` **plus** `role`. Widest scope wins (`org` beats `department` beats `team` beats `self`) |
| `protect` middleware | 🔴 Must now build a full **Actor**: `{ userId, employeeId, departmentId, managerChain[], roleKeys[], permissions[] }`. This adds **one Employee lookup per request** — mitigate with a lean `.select()` and a short-lived in-process cache keyed by userId |
| `/auth/me` | Returns `roleKeys[]` and `permissions[]` alongside the user document. The entire frontend RBAC layer depends on this |
| 🔴 **Naming collision** | `middlewares/rbac.js` exports `hasPermission(user, permissionString)`. The ported HRMS one is `hasPermission(actor, module, action, scope, resource?)`. **Same name, different signature, both live.** Resolution: the new canonical function lives in `shared/permissions` as `hasPermission`; the legacy one is renamed **`hasLegacyPermission`** and re-exported from `middlewares/rbac.js` under its old name for existing call sites. The frontend mirror `utils/permissions.js` gets the same treatment |
| Role assignment UI | The existing `PUT /api/v1/users/:id/roles` extends to write `roles[]`. `assignableRolesFor()` must gate which HRMS roles each actor may grant |

### Migration
`scripts/hrms/backfill-user-roles.js` — for every existing user, seed `roles = [role]`. Idempotent, safe to re-run.

---

## AD-4 — Customer can never be an Employee

**Decision:** A hard invariant, enforced in four places, not a convention.

### Enforcement points

| # | Where | Rule |
|---|---|---|
| 1 | **Employee creation** (`POST /hrms/employees`) | Reject if the target `User` has `role === 'Customer'` or `'Customer' ∈ roles[]`. `409 Conflict`, not a silent skip |
| 2 | **Role assignment** (`PUT /users/:id/roles`) | Reject adding `Customer` to a user who has an `Employee` record. Reject adding any HRMS role to a `Customer` |
| 3 | **Permission resolver** (`shared/permissions`) | The `Customer` role contributes **zero** HRMS permissions. Its only grant stays `create_order` |
| 4 | **Frontend nav** | The entire HRMS nav group is hidden when the actor holds no HRMS module permission — which, by rule 3, is always true for Customers |

### Consequences

| Area | Effect |
|---|---|
| Data model | `Employee.userId` is unique and references a **non-Customer** `User` |
| `SELF_BASELINE` | DTA grants every authenticated user a baseline (dashboard, inbox, own attendance/leave/payslip…). **That baseline must attach to the HRMS roles, never to authentication itself** — otherwise a logged-in Customer inherits it |
| Verification | `scripts/hrms/verify-permissions.js` asserts: *no `User` with `Customer` has an `Employee`, and no `Customer` resolves to any HRMS permission* |
| Risk closed | 🟡 *"Two role systems colliding"* → resolved by construction |

> ⚠️ **This is the single most important invariant in the integration.** A Customer reaching payroll or employee data is the worst failure mode available. It gets a test, a verification script, and a review checklist item.

---

## AD-5 — Operations and Projects & Timesheets are out of scope

**Decision:** Neither module is replicated. Both are excluded from Phase 1 and from the parity definition.

**Rationale:** Neither is an HR function. `operations` is D-Table's internal Jira-style tracker; `projects` is a PSA module whose nav entry DTA has *already removed*. The two overlap heavily. Shraddha Impex has no stated need for either.

### What this removes

| Item | Count | Detail |
|---|---:|---|
| Models | **11** | `OperationsProject`, `OperationsProjectMember`, `OperationsTask`, `OperationsTaskComment`, `OperationsDailyUpdate`, `OperationsTaskActivity`, `Project`, `ProjectMember`, `ProjectTask`, `TimesheetEntry`, `TimesheetPeriod` |
| Endpoints | **38** | 26 Operations + 12 Projects |
| Modules | **2** | plus 8 submodules |
| RBAC module keys | **2** | `operations`, `projects` — and their `SELF_BASELINE` grants |
| Roles | **1** | `project_manager` — its entire distinct purpose was Operations/Projects ownership. **HRMS ships 8 roles, not 9** |
| Frontend components | **4** | `KanbanBoard`*, `MarkdownEditor`, Operations board/drawer/cards, `ReportsTab` (1,209 LOC) |
| Dependencies | **3** | `@dnd-kit/*`, `@uiw/react-md-editor`, **Anthropic API** (`ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` no longer needed) |
| PDF generators | **3** | `operations-report-pdf.js` (880 LOC), `operations-manager-report-pdf.js`, `operations-employee-report-pdf.js` |
| Hidden behaviours | **2** | `ea-elevation.js` / `use-is-ea` (undocumented Executive-Assistant elevation), the cross-PM `otherProjects` field |

\* `KanbanBoard` is still needed **if** the Hiring pipeline ships as a Kanban. It can be built as a simple column layout instead — decide during Phase 5.

### Revised scope

| Metric | Full DTA | **In scope** |
|---|---:|---:|
| Functional modules | 24 | **22** |
| Submodules | 89 | **81** |
| Endpoints | 350 | **312** |
| Models | 93 | **82** |
| RBAC roles | 9 | **8** |
| RBAC module keys | 33 | **31** |

### 🔴 One dependency breaks

`exit-request.service.ts` reads **`ProjectMember`** to surface project handover during offboarding. With Projects excluded, this has no source.

**Resolution:** `ExitRequest.transferNotes` (a free-text field DTA already has) becomes the handover record. The structured project-membership lookup is dropped. **This is a deliberate, documented parity reduction** — the only one arising from AD-5.

Verified as the *only* break: a full scan of cross-module model access shows `projectMember` in `exit` is the sole reference from an in-scope module into either excluded module. Payroll does **not** read timesheets.

### Effort saved
**~6–8 weeks.**

---

## AD-6 — JavaScript + Zod

**Decision:** The HRMS is written in JavaScript (ESM), matching the rest of the portal. Zod provides the safety that TypeScript would have.

### Consequences

| Area | Effect |
|---|---|
| Backend | No build step. `node server.js` continues to run the source directly |
| Frontend | `.jsx` throughout. `jsconfig.json` stays; no `tsconfig.json` |
| Linting | `oxlint` continues to cover the frontend |
| **Validation** | 🔴 **Zod is now load-bearing, not optional.** Every HRMS endpoint validates `req.body` / `req.query` through a `validate(schema)` middleware before touching a model. This is the *only* thing constraining the ~20 `Mixed` fields from AD-2 |
| Schema port | DTA's `packages/shared-types` (~3,500 LOC) ports to `shared/src/schemas/*.js`. **Requires a Zod 3 → Zod 4 pass** — Shraddha has `zod@4` |
| Shared use | The same schemas are imported by the Express validator **and** by `react-hook-form` via `@hookform/resolvers/zod`. One definition, both sides — this is what DTA achieved with `shared-types` and what Shraddha's hand-mirrored `utils/permissions.js` failed to achieve |
| Editor support | JSDoc `@typedef` on the shared schemas gives autocomplete without a toolchain |

### Zod 3 → 4 port notes
The DTA schemas use `z.string().uuid()`, `z.coerce.number()`, `.default()`, `.optional().nullable()`, `z.record(z.string(), z.unknown())`, `z.enum()`, `.regex()`, `.min()/.max()`, `z.infer<>`. Most carry over directly. Items needing attention during the port:
- `z.string().uuid()` → **ObjectId validation instead** (AD-2 changes the key type)
- `z.record(keyType, valueType)` — signature changed in v4
- Error-issue shape changed (`.issues` formatting in `validate.js`)
- `z.infer<>` type exports are dropped (AD-6 — no TypeScript)

### Risk accepted
🟠 **Loss of compile-time type safety across ~60,000 LOC.** Mitigated by: Zod at every boundary, the ported statutory-engine unit tests, per-module `verify-*.js` scripts, and integration tests on payroll / leave duration / permission evaluation.

---

## AD-7 — S3 file storage

**Decision:** HRMS files live in Amazon S3, not on the EC2 instance's local disk.

> ⚠️ **There is nothing to port.** DTA's config schema *declares* `STORAGE_DRIVER=local|s3`, `AWS_S3_BUCKET` and `AWS_REGION` — but **every file path in DTA writes to `STORAGE_LOCAL_PATH`**. The S3 driver was never built. This is net-new work: we build what DTA only declared.

### What goes to S3

| Category | Source |
|---|---|
| Attendance selfies | `POST /attendance/upload-selfie` |
| Employee documents | 12 upload categories (photo, aadhar, pan, marksheets, bank statement, offer/joining/experience/leaving/salary-slip) |
| Expense receipts | per line item |
| Candidate résumés | hiring |
| **Generated PDFs** | payslips, Form 16, offer / appointment / relieving / confirmation letters |
| Document library | company policies, employee documents |
| Bank files | payroll disbursement exports |
| Company logo, announcement media | settings / engage |

### Design

```
utils/hrms/storage.js         ← driver interface, one module, swappable
  put(key, buffer|stream, mime)      → { key, size, etag }
  getStream(key)                     → Readable
  getSignedUrl(key, ttlSeconds)      → https URL
  delete(key)
  exists(key)

drivers:  s3.js      (production — @aws-sdk/client-s3)
          local.js   (development — writes under STORAGE_LOCAL_PATH)
```

Building the driver interface — rather than calling the SDK inline — is what makes local development work without a bucket, and is the piece DTA left unfinished.

### 🔴 Serving pattern: presigned URLs, not proxying

DTA streams every file **through** the API (`GET /employees/:id/uploads/:uploadId` reads from disk and pipes it). Carrying that pattern to S3 would push every payslip and document byte through a process capped at 400 MB.

**Instead:** the endpoint performs the permission check, then returns (or 302-redirects to) a **short-lived presigned URL** (60–300 s TTL). Bytes flow browser ↔ S3 directly and never touch the Node process.

| Consequence | Effect |
|---|---|
| **Memory** | 🟢 **The memory risk is materially eased.** Payroll PDF generation streams to S3; document downloads bypass the process entirely |
| Auth | Unchanged — the permission check still happens on our endpoint before any URL is issued |
| Frontend | `apiFetchBlob`-style download helpers become "fetch URL → navigate". `utils/hrms/downloadBlob.js` adapts |
| Audit | Log the *issuance* of a presigned URL for payslips and employee documents, not just the request |

### 🔴 The public selfie endpoint must be reconsidered

DTA exposes `GET /attendance/selfie/:filename` as **`@Public()`** — an unauthenticated endpoint serving employee photographs. Under AD-7 this becomes an authenticated endpoint that issues a presigned URL. **Do not replicate the public version**; it is a flaw in the source, not a feature.

### Configuration

| Var | Value |
|---|---|
| `STORAGE_DRIVER` | `s3` (prod) / `local` (dev) |
| `STORAGE_LOCAL_PATH` | dev only |
| `AWS_REGION` | e.g. `ap-south-1` |
| `AWS_S3_BUCKET` | private bucket |
| `S3_SIGNED_URL_TTL` | default 300 |

🔴 **Use an IAM instance role on the EC2 box — do not put `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in `.env`.** The SDK picks up instance credentials automatically. This matters more than usual here: `backend/.env` is committed to the repository, so any key placed there is in version control.

**Bucket configuration:** Block Public Access **on**, no public ACLs, default server-side encryption (SSE-S3, or SSE-KMS if AD-13 field-level encryption is also wanted), versioning on for payroll artifacts, and lifecycle rules matching the retention policy.

### Upload flow
`multipart → multer (temp disk) → storage.put() → delete temp`. Shraddha's existing `sweepUploads()` still earns its place, clearing temp files from requests that died mid-flight.

### New dependencies
`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.

### New risk
🟡 **S3 is now in the request path.** An S3 outage blocks uploads and downloads (but not the rest of the HRMS). Accepted — this is the standard trade for durability, and local disk on a single EC2 instance has no backup story at all.

### Risk changed
🟡 *Memory ceiling* → **eased**. Streaming to S3 plus presigned downloads removes the largest payloads from the constrained process.

---

## AD-8 — Rate limiting

**Decision:** Add rate limiting, **targeted at authentication and unauthenticated surfaces** — not globally.

### Foundation already in place
- `express-rate-limit@8.5.2` is **already a dependency**, just never applied. **Zero new packages.**
- `app.set('trust proxy', 1)` is **already set** in `app.js` — essential for correct per-IP limiting behind nginx, and already correct. Without it every user shares the proxy's IP.

### Why targeted, not global
`app.js` carries an explicit comment: *"a single page load costs several requests, and any per-IP ceiling tight enough to matter locked real users out mid-task."* That finding stands. **The existing portal routes stay unthrottled.** What changes is that payroll, salary and PAN data now sit behind the same login, so the login itself — and the unauthenticated write surface — need protection.

### Proposed limiters

| Surface | Route(s) | Limit | Key |
|---|---|---|---|
| 🔴 Login | `POST /api/v1/auth/login` | 5 / 15 min | **IP + email** |
| Token refresh | `POST /api/v1/auth/refresh` | 30 / 15 min | IP |
| Password change / reset | `PUT /auth/me/password`, `POST /hrms/employees/:id/reset-password` | 5 / 15 min | user id |
| 🔴 Public careers | 7 `@Public()` `/careers/*` endpoints — especially `POST /careers/postings/:slug/apply` and offer accept/reject | 10 / hour | IP |
| Biometric webhook | `POST /attendance/biometric` | 120 / min | IP |
| Exports & reports | `/hrms/reports/*/export.csv`, payroll exports, `/inventory/exports/*` | 10 / min | user id |
| Everything else | unchanged | none | — |

**Login keys on IP *and* email.** IP alone lets one NAT'd office lock out its own staff, and lets credential-stuffing spread across accounts from rotating IPs.

### 🔴 Interaction with Phase 0
`routes/api.routes.js` contains a **second login endpoint** (`POST /api/auth/login`) doing a raw plaintext comparison. It was already slated for removal in Phase 0. Under AD-8 that becomes urgent: left in place it is an **unthrottled, unhashed bypass of the throttled login**. Both must land in the same change.

### Store
The default in-memory store is correct here — `ecosystem.config.cjs` runs `exec_mode: 'fork'` with `instances: 1`, so there is a single process. ⚠️ **If PM2 is ever moved to cluster mode, the limiter needs a shared store**, or each worker enforces its own independent ceiling.

### Risk changed
🟡 *No rate limiting on auth* → **closed**.

---

## AD-9 — Root-folder tidy-up

**Decision:** Clean the repository root before `shared/` is added.

### Verified findings

Each file below was inspected and checked for references across `backend/`, `frontend/`, `deploy/`, `.github/`, `ecosystem.config.cjs` and the nginx config. **All are unreferenced.**

| File | Size | What it actually is | Tracked in git? |
|---|---:|---|---|
| `index.js` | 554,335 B | **Stale Vite build output** — begins `const __vite__mapDeps=…` with hashed asset paths | ✅ yes |
| `script.js` | 554,335 B | **Byte-identical duplicate of `index.js`** (verified with `cmp`) | ✅ yes |
| `index.html` | 633 B | **Stale built SPA shell** — references `/assets/index-D6GSKkJS.js`, a hash that no longer exists | ✅ yes |
| `mail-tables-preview.html` | 28,862 B | email-template mockup | — |
| `po-email-preview.html` | 3,912 B | email-template mockup | — |
| `po-modal-header-preview.html` | 3,736 B | UI mockup | — |
| `qty-change-email-preview.html` | 8,104 B | email-template mockup | — |

**Root cause:** these three build artifacts escaped `frontend/dist/` and were committed. `.gitignore` excludes `frontend/dist/` but has no rule covering root-level build output, so nothing stopped it. The deploy workflow builds on the runner and rsyncs `frontend/dist` to the server — **these root copies are pure leakage and are served to nobody.**

### Actions

| # | Action | Detail |
|---|---|---|
| 1 | **Delete** `index.js`, `script.js`, `index.html` | 1,109,303 B ≈ **1.06 MB** of stale build output |
| 2 | **Delete or archive** the 4 `*-preview.html` mockups | 44,614 B. If they document email templates worth keeping, move them to `docs/email-templates/` |
| 3 | **Extend `.gitignore`** | Add `/index.js`, `/script.js`, `/index.html`, `/assets/` so root-level build output cannot recur |
| 4 | **Keep, relocate** `test-sheets/` | The 4 `.xlsx` files are **genuine import-pipeline fixtures**, not junk. Move to `backend/scripts/fixtures/` alongside the `verify-*.js` scripts that consume that pipeline |
| 5 | **Leave `docs/` alone** | It holds business spreadsheets (IMS workbooks, box-number mappings, counting sheets). Distinct in purpose from `documentation/`. See the still-open question below |

**Total removed: 7 files, ~1.15 MB.**

### ⚠️ Not yet executed
This is still the analysis phase. **No file has been deleted.** The list above is a verified proposal; deletion needs an explicit go-ahead, ideally as its own commit so it is trivially revertible.

---

## AD-10 — Application-level encryption for sensitive employee fields

**Decision:** PAN, bank account number, IFSC and government ID numbers are encrypted in the application before they reach MongoDB. HRMS document storage uses **S3 SSE-KMS** (refining AD-7).

### 🔴 Finding: this is a correction, not a replication

Tracing the source before designing the fix produced a material finding.

**DTA has no dedicated fields for any of this.** A search of `schema.prisma` and the whole API for `pan`, `aadhaar`, `uan`, `ifsc`, `accountNumber`, `bankAccount`, `esiNumber` returns nothing structural. What actually happens is in `payroll/bank-file.service.ts`:

```js
// Build employee → bank details map from customFieldValues jsonb.
// Expected keys: bank_account_number, bank_ifsc, bank_name.
const acct = String(cfv.bank_account_number ?? '').trim();
const ifsc = String(cfv.bank_ifsc ?? '').trim();
```

So in the source system:
- Bank account numbers and IFSC codes live in **`Employee.customFieldValues`** — the admin-configurable **unencrypted JSON blob**
- That blob is returned wholesale by `GET /employees/:id`, so **bank account numbers are in the plain employee API response**
- `CustomFieldDefinition.type` offers `text | textarea | number | date | boolean | select | multiselect` — there is **no "sensitive" type**
- `payslip-pdf.ts` declares `bankAccountLast4` and renders `XXXX${last4}` — but both `payroll-run.service.ts:395` and `adhoc-payslip.service.ts:324` pass **`bankAccountLast4: null`**. The masking is stubbed and never populated
- `CLAUDE.md` §8 promises *"field-level encryption for PAN/bank details"*. None exists

**AD-10 therefore does two things, not one:** it creates the fields, and it encrypts them. This is a **deliberate improvement over the source** — logged here because functional parity is the primary objective (requirement 18) and this is a conscious, justified departure from it.

### Fields covered

Promoted **out of `customFieldValues`** into dedicated, typed, encrypted paths on `Employee`:

| Field | Encrypted | Blind index | Note |
|---|---|---|---|
| `panNumber` | ✅ | ✅ | Uniqueness must be enforceable |
| `bankAccountNumber` | ✅ | — | Never searched |
| `bankIfsc` | ✅ | — | Public branch code alone, but with the account it completes a payment instrument |
| `aadhaarNumber` | ✅ | ✅ | Government ID; duplicate detection |
| `uanNumber` | ✅ | — | PF universal account number |
| `esiNumber` | ✅ | — | |
| `passportNumber` | ✅ | — | |
| `bankName` | ❌ | — | Not sensitive |

### Design — envelope encryption with AWS KMS

Symmetric with the SSE-KMS choice below, and reusing the **IAM instance role already being provisioned for AD-7**.

```
utils/hrms/crypto/
  index.js     encryptField(plaintext) / decryptField(envelope) / blindIndex(value)
  kms.js       production — AWS KMS envelope encryption
  local.js     development — key from env, no KMS access needed
```

Stored envelope, per field:
```js
{ v: 1, k: '<KMS-encrypted DEK, base64>', iv: '<12B>', tag: '<16B>', ct: '<ciphertext>' }
```

- **AES-256-GCM** via Node's built-in `crypto` — authenticated, so tampering is detected on decrypt
- KMS `GenerateDataKey` yields a plaintext DEK + an encrypted DEK; the encrypted DEK is stored **alongside each ciphertext**
- The plaintext DEK is **cached in-process (~15 min TTL)**. Without this, a 500-employee payroll run would make thousands of KMS calls; with it, that run costs **one** KMS call plus 500 cheap local decrypts
- Because the encrypted DEK travels with each record, **CMK rotation and DEK reissue are non-breaking** — old records still decrypt

**Why not MongoDB CSFLE:** it requires `mongodb-client-encryption` with native `libmongocrypt` bindings — a native compile on a 3.7 GB box with no swap, which contradicts the established build-on-the-runner pattern. Automatic CSFLE also carries Atlas tier requirements, and explicit CSFLE is equivalent to the above with more ceremony. Node `crypto` + `@aws-sdk/client-kms` gives the same guarantee with no native modules.

**New dependency:** `@aws-sdk/client-kms` (one — `@aws-sdk/client-s3` already arrives with AD-7).

### 🔴 Five consequences that decide whether this is real or theatre

| # | Consequence | Requirement |
|---|---|---|
| 1 | **`toJSON` must mask by default** | Adding `bankAccountNumber` to the schema while `GET /employees/:id` returns the document would **recreate DTA's leak exactly**. Default serialization returns last-4 only (`••••1234`); full plaintext comes from an explicit service call gated on `employees:compensation:view:org` |
| 2 | **Encrypted fields are not queryable or indexable** | Random IVs mean the ciphertext differs every time, so equality search fails. Where uniqueness is required (PAN, Aadhaar), store a **blind index** — `HMAC-SHA256(normalisedValue, indexKey)` in a separate indexed field. Deterministic, uniquely indexable, not reversible |
| 3 | **The generated bank file contains plaintext** | An NACH/CSV disbursement file *is* a list of account numbers. Encrypting the field and then writing that file unprotected is theatre. Mitigation: SSE-KMS at rest (below), **60-second presigned TTL**, `payroll:run:org` only, and every download audited |
| 4 | **Logs must never carry plaintext** | `errorHandler.js` returns `err.stack` when `NODE_ENV !== 'production'`, and Mongoose `ValidationError` messages embed field values. Add an explicit redaction pass, and never log a decrypted object |
| 5 | **`CustomFieldDefinition` must not become a backdoor** | An admin could create a custom field named "PAN" and store it unencrypted — reopening the exact hole being closed. Either add a `sensitive: true` flag on the definition that routes values through the crypto service, or reserve the names |

### Other consequences

| Area | Effect |
|---|---|
| **Payslip masking** | `bankAccountLast4` — stubbed `null` in DTA — can finally be populated, derived from the decrypted value at generation time. **Never the full number** |
| **Bank file service** | Reads the encrypted fields instead of `customFieldValues`. The "skip employees with incomplete bank details" behaviour is preserved |
| **Audit** | Reading a full PAN or bank account is an auditable event distinct from viewing the employee. Add `sensitive.read` actions to `AuditLog` |
| **Key survival** | 🔴 If the CMK is deleted or its policy revoked, **the data is permanently unrecoverable**. Enable key-deletion protection; document in the runbook. Mongo backups then contain ciphertext only — which is the point |
| **Local development** | No KMS access in dev → the `local.js` driver mirrors AD-7's storage-driver pattern, keeping both subsystems consistent |
| **Migration** | If DTA data is ever imported (still-open item 1), `bank_account_number` / `bank_ifsc` must move from `customFieldValues` into the encrypted fields **and be deleted from the blob** — otherwise plaintext persists beside the ciphertext |
| **Performance** | AES-GCM runs at ~GB/s. The only network cost is the cached KMS `Decrypt` for the DEK. Negligible |
| **Cost** | ~$1/month per CMK + ~$0.03 per 10k requests. Trivial |

### S3 SSE-KMS (refines AD-7)

AD-7 left the encryption mode open between SSE-S3 and SSE-KMS. **SSE-KMS is now the decision.**

| Aspect | Effect |
|---|---|
| Bucket default | `aws:kms` with a **customer-managed CMK** (not the AWS-managed `aws/s3` key), so the key policy is ours to control and audit |
| Key reuse | The same CMK may back both S3 and the field encryption above, or a second CMK can separate them. **Recommend two CMKs** — different rotation cadences, and revoking document access need not break payroll decryption |
| IAM | The instance role needs `kms:GenerateDataKey` and `kms:Decrypt` on the CMK(s), in addition to the S3 permissions from AD-7 |
| Bucket Keys | Enable **S3 Bucket Keys** — cuts KMS request cost substantially on high-volume prefixes |
| Presigned URLs | Work unchanged with SSE-KMS; the requester needs no KMS permission of their own |
| CloudTrail | Every key use is logged — this is what makes "who read that payslip" answerable |

### Scope note — customer fields are out of scope

Shraddha's existing `User` model already carries `gstNumber`, `vendorNumber` and `shopNumber` in plaintext. These are **customer** master data, pre-existing, and semi-public (a GST number is printed on every invoice). **AD-10 as stated covers employee fields.** Whether to retro-encrypt customer identifiers is a separate decision and is not assumed here.

### Risks

| Risk | Level |
|---|---|
| 🔴 **CMK loss or policy revocation = permanent data loss** | Critical — mitigated by deletion protection + runbook |
| 🟡 **`toJSON` masking is the single point of failure** for exposure | Medium — needs a test asserting no HRMS response ever contains a full PAN or account number |
| 🟡 **Blind-index key compromise** enables offline dictionary attack on PAN (a low-entropy format) | Medium — separate key from the DEK path; rotate together with re-indexing |
| 🟢 KMS in the request path | Low — DEK caching means a KMS outage degrades gradually, not instantly |

### Risk closed
🟠 *"No field-level encryption for PAN/bank details"* — which in the source was worse than unimplemented, since the values sat unencrypted in a JSON blob returned by the employee API.

---

## AD-11 — Employee data migration source: deferred

**Decision:** The source of employee data is **option E — not decided yet**.

> 🔴 **No source is assumed.** Not the DTA PostgreSQL database, not an Excel or CSV file, not another HR system, not manual entry. Any design that presumes one is wrong.

**Decision:** Build the architecture so that employee data *can* be imported later through a dedicated migration/import process. **Do not implement the migration.**

### What "prepare the architecture" means

The source is unknown, so the pipeline is designed around a **canonical intermediate format** with a thin **source adapter** at the boundary:

```
[ unknown source ]  →  adapter  →  CanonicalEmployeeRecord[]  →  shared pipeline
   (deferred)        (deferred)      (defined in Phase 1)      (built in Phase 1)
                                                                     │
                            validate → sanitise (AD-10) → preview → commit → verify
```

Everything to the right of the adapter is built now. When the source is chosen, **only the adapter is written** — validation, sanitisation, preview, commit, idempotency, audit and verification are already in place.

### Follow the pipeline Shraddha already has

Shraddha's IMS import is a **mature, proven precedent** and the employee import should mirror it rather than invent a second pattern:

| Existing IMS asset | Employee-import equivalent |
|---|---|
| `ImportJob` / `ImportRow` / `ImportError` models | Reuse — add an `employee` import type |
| `GET /inventory/imports/types` · `templates/:type` · `POST /imports` · `:jobId/preview` · `:jobId/errors` · `:jobId/confirm` · `:jobId/resume` · `:jobId/cancel` | Same lifecycle under `/api/v1/hrms/imports` |
| `import.parser.js`, `import.service.js`, `import.templates.js` | Same layering |
| `middlewares/importUpload.js` + `sweepUploads()` | Reuse |
| `exceljs` / `xlsx` | Reuse **if** the source turns out to be a spreadsheet — the adapter decides, not the pipeline |

DTA's own employee import (`csv-import.controller.ts`: `template.csv` → `preview` → `commit`) is the weaker of the two — no job tracking, no per-row errors, no resume/cancel. **Shraddha's is the better pattern; use it.**

### 🔴 Six architectural requirements this places on Phase 1

These must be true *before* any migration runs, or the import has to be redone:

| # | Requirement | Why |
|---|---|---|
| 1 | **`Employee` schema complete and stable**, including the AD-10 encrypted fields | Importing into a half-formed schema means importing twice |
| 2 | **`employeeCode` is the stable natural key** — unique index, upsert-by-code | Makes re-runs idempotent. ObjectIds are assigned by us and cannot be the join key from an external source |
| 3 | **Two-pass manager linking** | Manager references arrive as codes, not IDs. Pass 1 creates every employee; pass 2 resolves `reportingManagerCode → ObjectId`; pass 3 recomputes `managerChain[]`. **`managerChain` is derived — never imported** |
| 4 | **Dependency order enforced** | `Department → OfficeLocation → Designation → EmploymentType → LeaveType → User → Employee → managerChain`. With AD-2 there are no FK constraints, so **nothing catches a dangling reference** — the pipeline must validate it |
| 5 | **`LeaveBalance` seeding** must run for imported employees | DTA seeds balances on create by reading `LeaveType` (hidden dependency #3). A bulk insert that bypasses the service skips it, and every imported employee shows a zero leave balance |
| 6 | **`User` account policy** decided per import | Every Employee needs a User. Create as `invited` with a temp password and send invites, or create silently and invite later? **AD-4 applies absolutely: none may be `Customer`** |

### 🔴 AD-10 sanitisation requirement — mandatory

Recorded here as a hard rule of the import pipeline, per AD-10.

**The rule:**
1. If imported data carries `bank_account_number`, `bank_ifsc`, or any other sensitive value inside `customFieldValues`, those values **MUST** be moved into the dedicated encrypted employee fields.
2. The plaintext **MUST** be removed from `customFieldValues` after successful migration.
3. **No duplicate plaintext copy may be retained.** Anywhere.

**Reserved keys the sanitiser scans for** (case- and separator-insensitive):
`bank_account_number`, `bank_ifsc`, `bank_acct`, `account_number`, `ifsc`, `pan`, `pan_number`, `aadhaar`, `aadhar`, `aadhaar_number`, `uan`, `uan_number`, `esi_number`, `passport_number`.

**🔴 Sanitisation happens in memory, before the first write — never as a later cleanup.**

This is the single most important implementation detail in AD-11. A two-step "write the blob, then delete the key" approach leaves plaintext in:
- the **MongoDB oplog** (retained for the oplog window, and read by every replica)
- **any replica** that applied the write
- **any backup or snapshot** taken between the two steps
- **Atlas point-in-time restore** history

Deleting the field afterwards removes it from the current document and from nothing else. **"Remove plaintext after successful migration" is necessary but not sufficient — it must never be written in the first place.** The sanitiser therefore runs on the in-memory record, before it reaches Mongoose, inside the same transaction as the employee write.

**Conflict rule:** if a record carries both a dedicated field and a blob key for the same value, the **dedicated field wins** and the blob value is discarded, with a warning row on the import job. The dedicated field is the intended path.

**The sanitiser is shared, not migration-only.** Every write path that accepts `customFieldValues` is an ingress: `POST /hrms/employees`, `PATCH /hrms/employees/:id`, the CSV import, *and* the migration. All four call the same `sanitiseCustomFields()` in `utils/hrms/crypto/`. Migration-only sanitisation would leave the ordinary API as an open door.

**Verification** — `scripts/hrms/verify-no-plaintext-sensitive.js` asserts that **no** employee document's `customFieldValues` contains any reserved key. Run it after migration **and on a schedule**: AD-10 consequence #5 notes that an admin could reintroduce the hole at any time by creating a custom field named "PAN", so this is a standing guard, not a one-off check.

### What is explicitly NOT built now

| Deferred | Until |
|---|---|
| The source adapter | The source is chosen |
| Field mapping / column mapping | The source is chosen |
| Any DTA-Postgres-specific extraction | Never, unless DTA is chosen — and it must not be assumed |
| Data-cleansing rules for the actual dataset | The dataset is seen |
| Migration execution and its cutover plan | The source is chosen |
| The historical-data question (do past payslips, leave balances and attendance come across, or only current employee master?) | The source is chosen |

### Consequences

| Area | Effect |
|---|---|
| Phase 1 | Gains the canonical format, the adapter interface, the pipeline shell and the two-pass linking. **~+0.5 week** |
| Phase 0 | `sanitiseCustomFields()` is folded into the AD-10 crypto service — already in scope, no added time |
| Risk | 🟢 **Lowered.** Deferring the source while building the pipeline avoids the far more expensive failure of building an adapter for the wrong system |
| Sequencing | The migration is **unscheduled work** outside the phase plan. It can run any time after Phase 1, and re-run idempotently |
| Go-live | 🟡 Employee data must exist before Phase 2 (Attendance/Leave) is *usable* — though not before it is *built*. Manual entry is a viable interim path for a small headcount |

### Open sub-questions, to be answered with the source

1. Which source? *(the deferred decision)*
2. Only current employee master, or historical payslips, leave balances and attendance too?
3. Headcount — still open item 3, and it decides whether manual entry is a realistic interim
4. Are there sensitive values in the source beyond the reserved key list?
5. One-time cutover, or repeated syncs from a system that stays live?

---

## AD-12 — State not decided; statutory config stays state-parameterised

**Decision:** The operating state is **not decided**. **No PT or LWF slab may be hardcoded.** Statutory configuration must support state-specific rules as data.

> 🔴 **No state is assumed.** Not Madhya Pradesh (despite DTA shipping MP holiday defaults), not Karnataka (despite DTA's hardcoded fallback — see below), not any other.

### What the source already does right — port it

Tracing the engines first showed the **calculation layer is correctly parameterised**, and should be ported as-is:

```ts
export type PtConfig  = Record<string, PtSlab[]>;      // stateCode → slabs
export type LwfConfig = Record<string, LwfStateRule>;  // stateCode → rule
```

- `computePt()` looks up `config[state]`; an unlisted state returns zero with `appliesInState: false`
- `computeLwf()` does the same, and additionally honours `periodicity: 'monthly' | 'biannual' | 'annual'` via `shouldFire(periodicity, month)`
- `StatutoryConfigPayload` is Zod-validated: `{ pf, esi, pt: Record<string, PtSlab[]>, lwf: Record<string, LwfStateRule>, tds }`
- `StatutoryConfig` is **effective-dated** (`effectiveFrom` / `effectiveTo`) — so slab changes are versioned and a historical payroll re-run uses period-correct rates. **This is good design; keep it**
- **No PT or LWF slab data is seeded anywhere** in DTA. The config is genuinely empty until an admin creates one through `POST /statutory-configs`

Only **PT and LWF** are state-specific. PF, ESI and TDS are central (all-India), so AD-12 correctly scopes to those two.

### 🔴 What the source gets wrong — do not port it

State *resolution* is broken, in a way that fails silently.

```js
// payroll-run.service.ts:225   and   adhoc-payslip.service.ts:168
let stateCode = 'KA';                                     // ← HARDCODED: Karnataka
...
if (typeof overridesRaw.stateCode === 'string') stateCode = overridesRaw.stateCode;
```

Three problems compound:

| # | Problem | Evidence |
|---|---|---|
| 1 | **`stateCode` defaults to `'KA'`** in three places | `payroll-run.service.ts:225`, `adhoc-payslip.service.ts:168`, `scripts/rerun-july-payroll.ts:86` |
| 2 | **The only override is a per-employee JSON blob** — `EmployeeCompensation.overrides.stateCode`, set by hand | no UI, no validation |
| 3 | **`Location` has no `state` field at all** — `name, code, address, city, country, timezone` | `schema.prisma` |

So the natural source of truth (the employee's work location) does not exist, and every employee is computed as Karnataka unless someone hand-edits a JSON field.

**The failure mode is silent.** Empty PT config + hardcoded `'KA'` → `computePt` returns `0` with the reason *"PT does not apply in KA"*. Payroll completes, payslips generate, and **no professional tax is deducted for anyone** — indistinguishable from a state that genuinely has no PT.

### The design

**1. Add the missing state field.**
`OfficeLocation` gains `stateCode` (ISO-3166-2 subdivision, e.g. `IN-MP`, or the bare `MP` the engines already expect — pick one and hold to it). `CompanyProfile` gains a `defaultStateCode`.

**2. Define a resolution chain — no silent default.**
```
1. EmployeeCompensation.overrides.stateCode   (explicit per-employee override)
2. Employee → OfficeLocation.stateCode        (the normal path)
3. CompanyProfile.defaultStateCode            (single-site fallback)
4. → BLOCK. Do not guess.
```
Step 4 replaces `let stateCode = 'KA'`.

**3. Distinguish "no PT here" from "not configured yet".** 🔴

This is the core of AD-12. DTA collapses both into a zero. They must be separate:

| Case | Meaning | Behaviour |
|---|---|---|
| State present in config with `slabs: []` and `ptApplicable: false` | Explicitly no PT (Delhi, Haryana, Rajasthan…) | Return zero — **correct and intentional** |
| State **absent** from config | Not configured yet | 🔴 **Block the payroll run** with a named error |

The `StatutoryConfigPayload` therefore carries an explicit registry of configured states, and payroll `compute` runs a **pre-flight check**: every distinct resolved `stateCode` in the run must be configured, or the run fails listing the missing states and affected employee codes. A zero deduction must never be the result of missing configuration.

**4. Seed nothing.**
`seedStatutoryConfig.js` ships **empty** — no slabs, no rates, no state. It is populated through the Settings UI (or a one-off script) once the state and its slabs are confirmed. This satisfies "do not hardcode PT/LWF slabs" literally: the slabs are data, entered per state, versioned by effective date.

**5. Multi-state is free.**
Because the config is `Record<stateCode, …>` and resolution runs per employee, an organisation operating in several states works without further change. Deferring the state costs nothing architecturally.

### ⚠️ One correctness gap to decide on

`pt.ts` carries its own admission:

> *"The `applicableMonths` handling is coarse for now — we return the same amount every month for stability, letting HR override in adjustments if a state's half-yearly rule applies."*

So **PT periodicity is not implemented**, while **LWF periodicity is** (`shouldFire`). States levying PT half-yearly — Tamil Nadu (August + February) — are computed monthly and therefore **over-deducted roughly sixfold**, with a manual adjustment as the stated workaround.

**Recommendation: fix it.** Give `PtStateRule` the same `periodicity` field LWF already has and reuse `shouldFire()`. It is a small change, the pattern already exists in the adjacent file, and the alternative is knowingly shipping incorrect tax. Logged, like AD-10, as a **deliberate departure from parity** in favour of correctness.

Whether this matters depends on the state chosen — which is exactly why it is being flagged now rather than discovered during a payroll run.

### Consequences

| Area | Effect |
|---|---|
| Engines | **Port as-is.** `pt.ts`, `lwf.ts` and their unit tests transfer unchanged (bar the periodicity fix above) |
| `StatutoryConfig` | Keep the effective-dated JSON shape; Zod-validate on write |
| `OfficeLocation` | 🔴 **New field** `stateCode` — absent in DTA |
| `CompanyProfile` | 🔴 **New field** `defaultStateCode` |
| Payroll run | 🔴 **New pre-flight validation** — unconfigured states block the run; the hardcoded `'KA'` fallback is removed |
| Seeds | `seedStatutoryConfig.js` ships empty |
| Settings UI | The Statutory tab must let an admin add a state and its slabs — DTA has the endpoints (`/statutory-configs`) but no seeded content to edit |
| Effort | **Phase 3 unchanged.** This is a redesign of ~40 lines of resolution logic, not new subsystem work |
| Multi-state | Supported by construction |

### Risks

| Risk | Level |
|---|---|
| **Silent zero PT from missing config** *(the DTA behaviour)* | ✅ **Closed** — pre-flight check blocks instead |
| Payroll blocked at go-live because statutory config was never populated | 🟡 Medium — surfaced early by the pre-flight, and a Phase 3 checklist item |
| PT periodicity mis-deduction in half-yearly states | 🟡 Medium — closed if the fix above is accepted |
| Wrong `stateCode` format (`MP` vs `IN-MP`) mixed across config and location | 🟢 Low — pick one, validate with Zod |

### Open sub-questions, to be answered with the state

1. Which state(s) does Shraddha Impex operate in? **Is it more than one?**
2. Does the company employ staff in states with **no** PT (Delhi, Haryana, Rajasthan)?
3. Is PF/ESI registration state-linked in a way that affects the config? *(ESI applicability is area-notified, not purely state-level — worth confirming when the state is known)*
4. Accept the PT-periodicity fix, or replicate DTA's monthly-only behaviour?

---

## AD-13 — Headcount 50–200 (planning assumption only)

**Decision:** Capacity and performance planning assumes **50–200 employees**, sized against the upper bound of **200**.

> 🔴 **This number does not enter the application.** No constant, no schema limit, no fixed-size structure, no query that assumes the set is small. It informs sizing and defaults — nothing else.

### 🔴 The finding: headcount is not this system's scaling factor

Working the numbers at 200 employees, **no headcount-scaled collection is a concern**:

| Collection | Volume at 200 employees | Assessment |
|---|---|---|
| `Employee` | 200 docs × ~3 KB ≈ **600 KB** | Trivial — the whole directory would fit in one query, which is precisely why pagination must be enforced by design rather than by necessity |
| Payroll run working set | 200 × ~20 KB ≈ **4 MB** | Comfortable inside the 400 MB PM2 cap |
| Payslip PDFs | ~30–80 KB each | Fine **if streamed**; fatal as a pattern if accumulated in an array first |
| `LeaveRequest` | ~4,000/year | Trivial |
| `EmployeeCompensation`, `Payslip` | 200 × 12 = 2,400/year | Trivial |

What actually grows is **time-series, not headcount-driven**:

| Collection | Growth | Action |
|---|---|---|
| `AuditLog` | Every mutation + every login. ~**1M rows/year** at this headcount | 🔴 Needs a **retention / TTL / archival policy** — it will outgrow every other collection |
| `InboxItem` | Every notification from 13 modules | Needs a retention policy |
| `AttendanceRecord` | 200 × ~22 days × 12 ≈ **53k/year** | Fine, with an index on `(employeeId, date)` |

**The capacity work is therefore about time-series retention and the shared 400 MB cap — not about employee count.** That reframing is the useful output of this decision.

### Where headcount may appear — as tunable config, never as a constant

```
PAGE_SIZE_DEFAULT      25      (DTA's existing default — unchanged)
PAGE_SIZE_MAX          200     (DTA's existing max — unchanged)
PAYROLL_BATCH_SIZE     100     env-tunable; one batch covers this headcount today
PDF_CONCURRENCY        5       parallel payslip generation
IMPORT_CHUNK_SIZE      500     AD-11 pipeline
ACTOR_CACHE_TTL        60s     AD-3's per-request Employee lookup cache
AUDIT_RETENTION_DAYS   ?       ← needs a policy decision (see below)
```

⚠️ Note `PAGE_SIZE_MAX = 200` means a single page can currently hold the entire workforce. That is fine today and is **exactly the kind of assumption that breaks at 1,000**. It stays configuration, and the directory is built server-paginated regardless.

### Forbidden patterns — enforced, not trusted

| Pattern | Why it is banned |
|---|---|
| `Employee.find({})` with no `.limit()` | Works at 200, dies at 5,000 |
| Loading all employees into an array before a payroll run | Same |
| Accumulating all payslip PDFs before writing | Peak memory becomes N × document size |
| Any `MAX_EMPLOYEES`-style constant | Headcount must never be encoded |
| Client-side pagination on an HRMS list | The `ServerDataTable` from the component backlog exists for this |

**Guardrail:** `scripts/hrms/verify-unbounded-queries.js` fails on any HRMS query lacking a `.limit()` or an explicit pagination call.

### Scalable beyond the estimate

The design must absorb **10× (2,000 employees) as a configuration change, not a rewrite**:

- **Batching code exists even though one batch suffices today** — so scaling is `PAYROLL_BATCH_SIZE`, not new code
- **Stream, never accumulate** — payslip PDFs go to S3 one at a time (AD-7's presigned pattern already keeps file bytes out of the process)
- **Server-side pagination everywhere** from day one
- **Indexes sized for the larger number**: `Employee(employeeCode)` unique, `(status)`, `(departmentId)`, `(reportingManagerId)`; `AttendanceRecord(employeeId, date)`; `LeaveRequest(employeeId, status)`; `AuditLog(actorUserId, createdAt)`

### What NOT to build at this scale

Sharding, read replicas, a Redis job queue, a separate worker process, or an instance upsize. At 50–200 employees all of that is over-engineering — and Redis was already dropped in favour of `node-cron`.

### Consequences

| Area | Effect |
|---|---|
| **Memory budget** | ✅ **Resolved.** A 200-employee payroll run is a ~4 MB working set. Combined with AD-7 keeping file bytes out of the process, the HRMS **fits comfortably in the existing 400 MB PM2 cap — no EC2 upsize needed.** This closes still-open item 11 |
| **AD-11 (migration)** | ✅ **De-risked.** At 50–200, **manual employee entry is a viable interim**, so migration is **not on the critical path for go-live**. The deferral costs nothing |
| Pagination defaults | Unchanged from DTA (25 / 200) |
| Payroll | Single-batch today; batching code still written |
| Effort | **No change to any phase** |
| New requirement | 🟡 An `AuditLog` / `InboxItem` **retention policy** — the only genuine capacity question at this scale |

### Risks

| Risk | Level |
|---|---|
| `AuditLog` unbounded growth (~1M rows/year) | 🟡 **Medium** — needs a retention policy; the largest collection in the system within a year |
| An unbounded query ships because it works fine at 200 | 🟡 **Medium** — closed by `verify-unbounded-queries.js` and load-testing at 10× |
| Memory ceiling | ✅ **Closed** — comfortable at this scale |

---

## AD-14 — Same domain, `/hrms/` route prefix, shared session

**Decision:** The HRMS is served from the **existing Shraddha domain** (`erp.shraddhaimpex.net`) under the **`/hrms/` route prefix**, reusing the existing session architecture.

> 🔴 **No separate HRMS domain. No separate authentication system.** One SPA, one login, one JWT, one `protect` middleware, one Socket.IO connection.

### ✅ The existing infrastructure already supports this — verified

Checking `deploy/nginx/shraddha-impex-app.conf` before asserting anything:

```nginx
location /assets/     { expires 1y; try_files $uri =404; }
location = /index.html{ Cache-Control: no-store }
location /api/        { proxy_pass http://127.0.0.1:4000; proxy_read_timeout 300s; }
location /socket.io/  { proxy_pass … upgrade }
location = /health    { proxy_pass … }
location /            { try_files $uri $uri/ /index.html; }   ← catch-all
```

| Path | Resolution | nginx change |
|---|---|---|
| `/hrms/employees` | not a file → `location /` → `try_files` → `/index.html` → React Router | **none** |
| `/api/v1/hrms/*` | `location /api/` → proxy to :4000 | **none** |

**AD-14 requires zero nginx changes.** React Router already owns the URL space, and the API prefix already proxies. The comment in that file — *"React Router owns the URL space: /login and every other route is the SPA shell"* — was written for exactly this.

Two existing limits, both adequate: `client_max_body_size 20m` (multer caps HRMS uploads at 10 MB) and `proxy_read_timeout 300s` (payroll compute is seconds at AD-13 scale, and AD-7's presigned URLs mean file downloads never traverse nginx at all).

### 🟢 A security opportunity that same-origin unlocks

Tokens currently live in `localStorage` — XSS-exposed, and the auth store's own comment flags this as acceptable only for an internal tool. With HRMS on the same origin, **there is no cross-origin obstacle to httpOnly cookies**, and the plumbing already exists:

- `cookie-parser` is installed and mounted in `app.js`
- `middlewares/auth.js` **already reads `req.cookies.accessToken`** as a fallback beside the Bearer header

**Recommendation for Phase 0:** when refresh tokens are added, put the **refresh token in an httpOnly, Secure, SameSite=Strict cookie** and keep the short-lived access token in memory. Same-origin makes this straightforward; a subdomain split would have forced `SameSite=Lax` plus domain scoping. Given AD-10 puts salary, PAN and bank data behind this login, the upgrade is worth taking while it is cheap.

### Consequences

| Area | Effect |
|---|---|
| **nginx** | ✅ No change |
| **Deployment** | ✅ No change — same `frontend/dist`, same PM2 `shraddha-backend` on :4000, same workflow, same `VITE_API_URL` |
| **Frontend routing** | `/hrms/*` nests under the existing `ProtectedRoute → MainLayout`. Flat portal paths stay untouched |
| **Backend routing** | `/api/v1/hrms/*` mounted in `app.js` beside the existing nine routers |
| **Auth** | One login, one `/auth/me`, one `protect`, one axios instance with its interceptors. **AD-3's multi-role is what makes a single session serve both products** |
| **Socket.IO** | Already authenticates with the same JWT and joins `user:<id>` — the HRMS inbox gets live push with no new connection |
| **Sidebar** | 🔴 Now **~33 items** (12 portal + ~21 HRMS) in one rail. The declarative `navItems.js` **must carry groups** — DTA's four (core / My Work / People & Org / Admin) plus the portal's own. Previously advisable; now unavoidable |
| **Active-item matching** | The existing longest-path segment matcher already handles `/hrms/employees` vs `/hrms/employees/:id` correctly |
| **Bundle** | HRMS roughly doubles the frontend, but every route is already `React.lazy` — **a customer never downloads an HRMS chunk**. Keep HRMS out of the entry chunk |
| **Public careers** | If built (still-open item 7), `/careers/*` must sit **outside** `ProtectedRoute`, as `/login` already does. Note it would put a public job board on the customer ERP domain — worth confirming when that item is decided |

### 🔴 AD-4 becomes visually load-bearing

Customers and employees now share **one login page and one shell**. The invariant "a Customer is never an Employee" stops being purely a data rule and becomes something a user could *see* if it leaked.

Three layers must hold, and all three are already planned:
1. The `Customer` role contributes **zero** HRMS permissions (AD-4, rule 3)
2. The nav filter hides any group where the actor holds no module permission
3. `requiresModules[]` on every `/hrms/*` route bounces a direct URL attempt

**A Customer navigating to `/hrms/employees` must land back at `/`, not at a permission error** — an error message confirms the route exists. Worth an explicit test.

### One shared process, two workloads

The same PM2 process now serves customer bookings **and** payroll. A long synchronous payroll run would block the event loop and degrade customer-facing requests.

At AD-13's headcount this is small (~4 MB, seconds), and **the batching AD-13 already requires protects the event loop as well as memory** — batch boundaries yield. Noting the connection so batching is not later "optimised away" as unnecessary at 200 employees.

### Risks

| Risk | Level |
|---|---|
| HRMS nav leaking to a Customer on the shared shell | 🟡 **Medium** — three independent gates; needs an explicit test |
| Payroll blocking the event loop for portal users | 🟢 **Low** at this scale — mitigated by AD-13 batching |
| Entry-bundle growth | 🟢 **Low** — lazy routes already isolate HRMS |
| Public job board on the customer ERP domain | 🟡 **Medium** — only if still-open item 7 is answered "yes" |

### Risk closed
🟡 *"Same domain and instance, or separate?"* — resolved, and at **zero infrastructure cost**.

---

## AD-15 — Attendance captures selfie + GPS

**Decision:** Every clock-in and clock-out captures a **selfie and GPS coordinates**, matching DTA's behaviour — with **explicit employee consent, permission-checked access, SSE-KMS S3 storage, short-lived presigned URLs, and audit logging**.

### 🔴 Scope fence

**No attendance requirement beyond this decision is assumed.** Explicitly **not** in scope:

| Not building | Note |
|---|---|
| Geofencing | `CLAUDE.md` describes it; **DTA has no implementation**. GPS is captured, never fenced |
| Shift management / rosters / rotational shifts | No model, no endpoints in DTA |
| Face matching or liveness detection | Not in DTA; would change this from a deterrent into biometric processing, with a far heavier legal burden |
| Continuous location tracking | Location is captured **at the punch only** |
| Biometric hardware | Separate, still-open item 5 |

### What is replicated from DTA

- Selfie on **both** clock-in and clock-out
- **Skippable** — denying camera access still permits the punch (DTA already behaves this way, and §"consent" below makes this mandatory rather than merely kind)
- GPS captured at punch
- Reverse-geocoded to a human-readable label ("MG Road, Vijay Nagar, Indore") stored alongside the coordinates

### 🔴 Three defects in the source, corrected here

| # | DTA behaviour | Correction |
|---|---|---|
| 1 | `GET /attendance/selfie/:filename` is **`@Public()`** — an unauthenticated, filename-addressable endpoint serving employee photographs | Authenticated + scope-checked + presigned. **Do not replicate** |
| 2 | `AttendanceRecord` has **one** `geoLat`/`geoLng` pair but **two** location labels (`clockInLocation`, `clockOutLocation`) — so clock-out coordinates overwrite clock-in's, or one punch goes unrecorded | Store **separate coordinates per punch**, matching the labels that are already separate |
| 3 | Reverse geocoding calls Nominatim **synchronously at punch time** | Geocode **after** the record is written; never block a punch on a third-party API |

### The five safeguards

#### 1. Explicit consent

DTA has none — this is new work.

```js
AttendanceConsent {
  employeeId, purpose: 'selfie' | 'location',
  granted: Boolean, grantedAt, withdrawnAt,
  consentTextVersion, ipAddress, userAgent
}
```

A separate collection rather than a flag, so the **history** is auditable — when consent was given, under which wording, and when withdrawn.

Requirements, aligned to India's **DPDP Act 2023**:

| Requirement | Implementation |
|---|---|
| **Free** — consent cannot be a condition of the service | 🔴 **A refusal must still allow the punch.** Attendance is recorded with no selfie and no location. DTA's skippable design already points this way; here it becomes mandatory |
| **Specific** | Separate consent for `selfie` and for `location` — one may be granted without the other |
| **Informed** | The ClockInCard states what is captured, why, where it is stored and for how long — at the point of capture, not buried in a policy |
| **Unambiguous, affirmative** | An explicit opt-in action. No pre-ticked box, no implied consent from clocking in |
| **Withdrawable as easily as given** | A toggle in **Me**, same number of clicks as granting |
| Versioned | `consentTextVersion` — changing the wording requires re-consent |

🔴 **Open policy question:** on withdrawal, are previously captured selfies and locations **erased** or **retained**? The attendance record itself is a business record and must persist; the selfie and coordinates were collected for verification only. Recommend erasure on withdrawal, but this is a policy decision, not an engineering one — see the sub-questions below.

The capture flow checks consent **before** opening the camera or requesting geolocation.

#### 2. Permission checks

Replaces DTA's public endpoint:

```
GET /api/v1/hrms/attendance/records/:id/selfie/:punch    ('in' | 'out')
  attendance:view:self  (resourceParam) — own record
| attendance:view:team  (resourceParam) — a direct report, via managerChain
| attendance:view:org                   — HR / approvers
```

The same gate applies to coordinates and the geocoded label. An arbitrary authenticated user — including any portal Customer, per AD-4 — reaches neither.

#### 3. Secure S3 storage

Per AD-7 and AD-10:
- **SSE-KMS**, private bucket, Block Public Access on
- Non-guessable key: `attendance/selfies/<employeeId>/<recordId>/<uuid>.jpg`
- **Client-side downscale before upload** — 640 px, JPEG ~q0.7, giving ~30–50 KB rather than a multi-megabyte camera capture
- 🔴 **Server-side size cap of ~2 MB** on this route. The global multer limit is 10 MB, which is far too generous for a selfie

#### 4. Short-lived presigned access

- **60-second TTL** — shorter than the 300 s used for documents. A selfie is viewed inline in a table or drawer, once
- The URL is issued only after the permission check above
- A presigned URL is bearer-capable for its lifetime; 60 s bounds that window

#### 5. Audit logging

Capture is not the sensitive act — **viewing** is.

| Event | Logged |
|---|---|
| `attendance.selfie.viewed` | actor, subject employee, record id, punch — **on every presigned URL issued** |
| `attendance.consent.granted` / `.withdrawn` | employee, purpose, consent version |
| `attendance.location.viewed` | actor, subject, record |

These feed `AuditLog`, whose retention policy is still-open item 19 (AD-13).

### 🟡 Nominatim — now a live concern

With GPS confirmed in scope, the reverse-geocoding dependency becomes real. Its public instance requires a max of ~1 request/second and an identifying User-Agent.

At AD-13's headcount: 200 employees × 2 punches × 250 days ≈ **100,000 calls/year** — trivial on average, but **bursty**: 200 people clocking in inside a 15-minute window is a spike, not a trickle.

Design:
- **Asynchronous** — write the attendance record first, geocode after. A punch never waits on a third party
- **Swappable provider**, using the AD-7 driver pattern
- **Cache by coarse coordinate** — rounding to ~4 decimal places (~11 m) collapses an entire office to one lookup
- **Degrade gracefully** — on failure, store raw lat/lng with no label. Never fail the punch
- Set a proper identifying User-Agent per Nominatim's policy

### 🔴 Retention — the largest personal-data store in the system

100,000 selfies/year at ~40 KB ≈ **4 GB/year**. The S3 cost is negligible; **the privacy liability of 100,000 employee photographs is not**.

- An **S3 lifecycle rule is required**, not optional. Recommend deletion after ~90 days — the verification purpose is served within a pay cycle
- This merges with still-open item 17 (retention policy) and item 19 (audit/inbox retention). They should be answered together

### Consequences

| Area | Effect |
|---|---|
| `AttendanceRecord` | 8 fields: `clockInSelfieKey`, `clockInLat`, `clockInLng`, `clockInLocation`, and the four clock-out equivalents — **fixing DTA's single shared coordinate pair** |
| New collection | `AttendanceConsent` |
| New UI | Consent capture in the ClockInCard; a consent toggle in **Me** |
| `ClockInCard` | The source's 845 LOC is largely camera + geolocation handling, and it carries over. Consent gating is additive |
| Endpoints | +2 (consent grant/withdraw, consent status). The public selfie route is **replaced**, not added |
| Phase 2 | Unchanged — the consent work is offset by dropping the synchronous geocode |
| S3 | New prefix + lifecycle rule; SSE-KMS already decided |
| AD-4 | A Customer reaches no attendance route — the shared shell makes this a visible invariant |

### Risks

| Risk | Level |
|---|---|
| Consent implemented as a blocking gate rather than a genuine choice | 🟠 **High** — would breach DPDP's "free" requirement. **A refusal must still allow the punch** |
| 100k employee photographs with no lifecycle rule | 🟠 **High** — closed by the retention decision, which is now required rather than deferred |
| Replicating DTA's public selfie endpoint | 🟠 **High** — flagged explicitly above so it cannot happen by copying |
| Nominatim burst at shift start | 🟢 **Low** — async + coarse cache + graceful degradation |
| Presigned URL forwarded within its 60 s window | 🟢 **Low** — accepted; the alternative is proxying bytes through the 400 MB process |

### Open sub-questions

1. 🔴 **On consent withdrawal — erase past selfies and coordinates, or retain them?**
2. **Retention window for selfies** — 90 days suggested; needs confirmation alongside items 17 and 19
3. **Who may view another employee's selfie?** Direct manager only, or HR too? (The permission model supports either)
4. Is a **shared kiosk device** in use in the warehouse? It changes the capture UX, though not this decision

---

## AD-16 — Data retention

**Decision:**
- **Attendance selfies** — retain **90 days**, then automatically delete from S3.
- **Attendance records** — retained **separately**, per HR policy. Deleting a selfie must never delete the punch.
- **AuditLog** — retain **3 years**, then archive or delete per the configured policy.
- 🔴 **Retention periods are configuration. They must never be hardcoded into business logic.**

### Where retention lives

Following Shraddha's own `InventoryConfig` precedent — a versioned config document with change history, already exposed at `/inventory/config` + `/config/history`:

```js
HrmsRetentionPolicy {            // single document, versioned, with history
  attendanceSelfies: { days: 90,   action: 'delete'  },
  auditLog:          { days: 1095, action: 'archive' },
  inboxItems:        { days: null, action: 'retain'  },   // unset
  payslips:          { days: null, action: 'retain'  },   // unset
  resumes:           { days: null, action: 'retain'  },   // unset
  …
}
```

Surfaced at `GET/PUT /api/v1/hrms/config/retention` plus `/history`, edited in Settings. Every change is audited.

🔴 **`days: null` means retain indefinitely — never "delete immediately".** An unconfigured category must fail toward keeping data, exactly as AD-12 makes an unconfigured state *block* payroll rather than silently deduct zero. Fail-safe in the same direction.

### 🔴 The conflict: "configurable" vs S3 lifecycle rules

An S3 lifecycle rule is the obvious way to expire selfies — but it is configured **in AWS at the bucket/prefix level**, not from application config. Changing the retention in Settings would not change the lifecycle rule, and the two would silently drift.

**Resolution — the application is the authority, S3 is the backstop:**

| Layer | Window | Role |
|---|---|---|
| **Scheduled sweep** (application) | reads `attendanceSelfies.days` from config | **The authority.** Honours the configured value; a change in Settings takes effect on the next run |
| **S3 lifecycle rule** | a **longer** window, e.g. 180 days | **Safety net.** Catches orphans the sweep missed — a failed delete, a record removed out from under its key. Nothing lives forever |

The lifecycle rule is deliberately looser than the policy so it never pre-empts it. It exists to guarantee an upper bound, not to enforce the decision.

### 🔴 Deletion order matters

A selfie lives in S3; its pointer (`clockInSelfieKey`) lives in MongoDB. Deleting one without the other leaves either a broken image or an orphaned object.

**Null the pointer first, then delete the object.**

- If the S3 delete then fails → an orphan, which the lifecycle backstop reaps. No user-visible breakage.
- The reverse order risks a live pointer to a missing object: a presigned URL that 404s, in the UI, on an employee's own record.

The sweep clears `clockInSelfieKey` and `clockOutSelfieKey` and leaves **the attendance record intact** — the punch, its timestamp, its status and its corrections all survive, per the decision.

### Consent withdrawal is a separate trigger

AD-15's withdrawal path is **not** the 90-day sweep. Withdrawal means *erase now*, not *erase eventually*. Both call the same deletion routine; only the trigger differs.

This closes AD-15 sub-question 2 (window = 90 days) and gives sub-question 1 its mechanism — though **whether withdrawal also erases coordinates remains open** (see below).

### AuditLog — 3 years

- **~1M rows/year × 3 = ~3M rows** steady state, roughly 1.5 GB. Manageable.
- **A scheduled job, not a MongoDB TTL index.** A TTL index can only delete, never archive, and its window is part of the index definition — the opposite of configurable. The job reads the config and honours `action: 'archive' | 'delete'`.
- **Archive target:** compressed JSONL to S3, SSE-KMS per AD-10 — audit rows reference sensitive operations. Cheap and durable.
- Runs on the existing `node-cron` daily job in `server.js`, beside `runReservationExpiryChecks`, `runPoSettlement` and `sweepUploads`. **No new infrastructure** — consistent with dropping Redis in favour of cron.
- **Batched**, per AD-13, so a first run over a large backlog does not blow the 400 MB cap.

### 🔴 The sweep must audit itself

Deleting audit rows without recording that they were deleted destroys the very trail the log exists to provide. Every run writes a summary: rows matched, action taken, cut-off date, archive key. Same for the selfie sweep.

These summary rows are themselves audit records — and must be **excluded from their own retention window**, or the record of deletion is eventually deleted too.

### 🟠 One risk this creates

`CLAUDE.md` §8 requires *"audit trail on all payroll/compensation changes"*, and Indian statutory obligations (Income Tax Act, PF rules) commonly demand **7–8 years** on payroll records. **A blanket 3-year audit deletion could conflict with statutory retention for payroll-related rows.**

Mitigations, in order of preference:
1. **Set `auditLog.action: 'archive'`** — nothing is lost, the obligation is met, and this is already the recommended default above
2. **Category-aware retention** — payroll and compensation actions retained longer than routine ones. The config shape supports this without redesign

⚠️ **Confirm with whoever owns compliance** whether any audit category needs a longer *live* window, or must never be deleted at all.

### Consequences

| Area | Effect |
|---|---|
| New model | `HrmsRetentionPolicy` — versioned, with history, following `InventoryConfig` |
| New job | `runHrmsRetentionSweep()` on the existing daily cron. Batched |
| S3 | A lifecycle backstop at a **longer** window than the policy |
| Settings | A Retention tab; every change audited |
| `AttendanceRecord` | Survives selfie deletion. Only the two key fields are cleared |
| AD-15 | Sub-question 2 **closed** (90 days); sub-question 1 gets its mechanism |
| Effort | **Small.** Config + Settings tab in Phase 1; audit sweep in Phase 1 alongside the `AuditLog` schema; selfie sweep in Phase 2 with attendance. No phase moves |
| Forbidden | Any literal `90`, `1095` or `3 * 365` in a service. `verify-unbounded-queries.js` gains a companion check for hardcoded retention constants |

### Risks

| Risk | Level |
|---|---|
| 3-year audit deletion conflicts with statutory payroll retention | 🟠 **High** — mitigated by defaulting to `archive`; **needs compliance confirmation** |
| App config and S3 lifecycle drift apart | ✅ **Closed** — app is authoritative, lifecycle is a looser backstop |
| Selfie deleted, pointer left dangling | ✅ **Closed** — null-then-delete ordering |
| Retention sweep deletes its own audit trail | ✅ **Closed** — sweep summaries excluded from their own window |
| ~100k selfies/year accumulating unbounded | ✅ **Closed** (was 🟠 High under AD-15) |
| `AuditLog` unbounded growth | ✅ **Closed** (was 🟡 Medium under AD-13) |

### Still unspecified — deliberately

AD-16 decides **two** categories. The config is built to hold the rest, seeded unset (= retain):

| Category | Note |
|---|---|
| Payslips, Form 16 | Statutory — likely **7–8 years** in India, not a free choice |
| Résumés of candidates never hired | DPDP points toward erasure once the purpose is served |
| Employee documents post-exit | Statutory floor likely applies |
| `InboxItem` | Low stakes; AD-13 raised it, AD-16 does not decide it |
| Expense receipts, bank files | Bank files contain account numbers (AD-10) |

**Do coordinates follow selfies?** AD-16 names selfies only, and says attendance records are retained per HR policy — so on a literal reading, GPS coordinates and the geocoded label stay with the record. They are personal data too. **Flagged, not assumed.**

---

## Combined effect on the plan

### Effort — revised

| Phase | Was | **Now** | Change |
|---|---|---|---|
| 0 — Security & platform | 4–5 wks | **3.5–4.5 wks** | No tenancy middleware; `KanbanBoard`/`MarkdownEditor` deferred |
| 1 — Foundation | 4–5 wks | **3.5–4.5 wks** | No `organizationId` in ~82 schemas; simpler login |
| 2 — Daily ops | 5–6 wks | **5–6 wks** | unchanged |
| 3 — Money | 8–10 wks | **8–10 wks** | unchanged — still the critical path |
| 4 — Lifecycle | 6–7 wks | **5.5–6.5 wks** | Exit handover simplified to free-text |
| 5 — Talent | 7–8 wks | **7–8 wks** | unchanged |
| 6 — Reporting | 3–4 wks | **2.5–3.5 wks** | No Operations reports |
| | 37–45 wks | **~36–43 weeks** | Operations/Projects were already excluded from the original figure |

### Risk register — revised

| Risk | Before | **After** |
|---|---|---|
| RLS has no MongoDB equivalent | 🟠 High | ✅ **Closed** (AD-1) |
| Two role systems colliding | 🟡 Medium | ✅ **Closed** (AD-3 + AD-4) |
| Multi-tenant query discipline | 🟠 High | ✅ **Closed** (AD-1) |
| Money in MongoDB | 🔴 Critical | 🔴 **Critical** — unchanged, now with a mandated guardrail |
| Payroll correctness | 🔴 Critical | 🔴 **Critical** — unchanged |
| Password migration | 🔴 Critical | 🔴 **Critical** — unchanged |
| Loss of FK integrity | 🟠 High | 🟠 **High** — confirmed by AD-2 |
| Loss of type safety | 🟠 High | 🟠 **High** — confirmed by AD-6, Zod is the mitigation |
| RBAC scope model | 🔴 Critical | 🔴 **Critical** — unchanged |
| `managerChain` drift | 🟠 High | 🟠 **High** — unchanged |
| Memory ceiling | 🟡 Medium | 🟢 **Low** — eased twice: no Operations PDFs (AD-5), and presigned S3 URLs keep file bytes out of the process entirely (AD-7) |
| No rate limiting on auth | 🟡 Medium | ✅ **Closed** (AD-8) |
| File storage had no backup story | 🟡 Medium | ✅ **Closed** (AD-7) — S3 durability, versioning, lifecycle rules |
| **NEW: `hasPermission` name collision** | — | 🟡 **Medium** (AD-3) — resolved by renaming the legacy function |
| **NEW: Actor build cost per request** | — | 🟡 **Medium** (AD-3) — one extra Employee lookup; mitigate with `.select()` + cache |
| **NEW: Exit handover parity reduction** | — | 🟢 **Low** (AD-5) — documented and accepted |
| **NEW: S3 in the request path** | — | 🟡 **Medium** (AD-7) — an S3 outage blocks uploads/downloads; accepted for durability |
| **NEW: Rate limiter store is per-process** | — | 🟢 **Low** (AD-8) — correct today (`fork`, 1 instance); needs a shared store if PM2 moves to cluster mode |
| Sensitive fields unencrypted in a JSON blob | 🟠 High *(worse than documented — see AD-10)* | ✅ **Closed** (AD-10) |
| **NEW: CMK loss = permanent data loss** | — | 🔴 **Critical** (AD-10) — key-deletion protection + runbook |
| **NEW: `toJSON` masking is the single exposure point** | — | 🟡 **Medium** (AD-10) — needs a test asserting no response carries a full PAN or account number |
| **NEW: Blind-index key compromise** | — | 🟡 **Medium** (AD-10) — PAN is low-entropy; separate key, rotate with re-indexing |
| Migration built against the wrong source | 🟡 Medium | ✅ **Closed** (AD-11) — source deferred; only a thin adapter is written once it is known |
| **NEW: Plaintext written then deleted survives in the oplog/backups** | — | 🔴 **Critical** (AD-11) — sanitise in memory before the first write; never as a later cleanup |
| **NEW: Employee data absent when Phase 2 goes live** | — | 🟡 **Medium** (AD-11) — manual entry is a viable interim at low headcount |
| **Silent zero PT from a hardcoded `'KA'` + empty config** | — *(latent defect in the source)* | ✅ **Closed** (AD-12) — pre-flight check blocks an unconfigured state |
| **NEW: Payroll blocked at go-live if statutory config is unpopulated** | — | 🟡 **Medium** (AD-12) — surfaced early by the pre-flight; Phase 3 checklist item |
| **NEW: PT periodicity mis-deduction in half-yearly states** | — | 🟡 **Medium** (AD-12) — closed if the recommended fix is accepted |
| `AuditLog` unbounded growth (~1M rows/year) | 🟡 Medium | ✅ **Closed** (AD-16) — 3-year window, archive by default |
| **NEW: An unbounded query ships because it works at 200** | — | 🟡 **Medium** (AD-13) — closed by `verify-unbounded-queries.js` + a 10× load test |
| Same domain or separate? | 🟡 Medium | ✅ **Closed** (AD-14) — same domain, and at **zero infrastructure cost**: nginx needs no change |
| **NEW: HRMS nav leaking to a Customer on the shared shell** | — | 🟡 **Medium** (AD-14) — three independent gates; needs an explicit test |
| **NEW: Payroll blocking the event loop for portal users** | — | 🟢 **Low** (AD-14) — one shared process; AD-13 batching yields at boundaries |
| Public unauthenticated selfie endpoint | 🟠 High *(defect in the source)* | ✅ **Closed** (AD-15) — authenticated, scope-checked, presigned |
| **NEW: Consent built as a blocking gate** | — | 🟠 **High** (AD-15) — would breach DPDP "free consent"; **a refusal must still allow the punch** |
| ~100k employee photographs/year with no lifecycle rule | 🟠 High | ✅ **Closed** (AD-16) — 90-day sweep + looser S3 backstop |
| **NEW: Nominatim burst at shift start** | — | 🟢 **Low** (AD-15) — async + coarse-coordinate cache + graceful degradation |
| **NEW: 3-year audit deletion vs statutory payroll retention (7–8 yrs)** | — | 🟠 **High** (AD-16) — default to `archive`; **needs compliance confirmation** |
| **NEW: App retention config drifting from the S3 lifecycle rule** | — | ✅ **Closed** (AD-16) — app authoritative, lifecycle a looser backstop |

---

## Still open — needed before Phase 1, not before Phase 0

Phase 0 contains no HRMS features and can start now. These are required before Foundation work begins:

| # | Question | Blocks |
|---|---|---|
| ~~1~~ | ~~Employee data migration source?~~ | ⚠️ **Deliberately deferred — AD-11: option E, not decided.** Pipeline built source-agnostically in Phase 1; adapter written later. **Do not assume a source.** Five sub-questions travel with it (see AD-11) |
| ~~2~~ | ~~Which state's PT and LWF slabs apply?~~ | ⚠️ **Deliberately deferred — AD-12: not decided.** Slabs stay data, never hardcoded; state resolution redesigned; unconfigured states block the run. **Do not assume a state.** Four sub-questions travel with it |
| ~~3~~ | ~~Current headcount?~~ | ✅ **Answered — AD-13: 50–200**, planning only, never hardcoded |
| 4 | **Is there a live payroll system today?** Parallel-run period before cutover? | Phase 3 cutover plan |
| 5 | **Is biometric hardware in use?** | Whether to build the webhook + HMAC + driver layer; Phase 2 |
| ~~6~~ | ~~Is attendance selfie + GPS wanted?~~ | ✅ **Answered — AD-15: both**, with consent, permission checks, SSE-KMS, 60 s presigned access and audit. Three source defects corrected. Four sub-questions travel with it |
| 7 | **Is a public careers site wanted** on the customer-portal domain? | Phase 5; 7 unauthenticated endpoints |
| 8 | **Is SSO required?** (Unwired in DTA — building it is new work, not a port) | Phase 6 |
| 9 | **Which reports are actually needed?** DTA ships only 3 | Phase 6 |
| ~~10~~ | ~~Same domain or subdomain?~~ | ✅ **Answered — AD-14: same domain, `/hrms/` prefix, shared session.** Verified to need **no nginx change** |
| ~~11~~ | ~~Memory budget — upsize the instance, or fit the 400 MB cap?~~ | ✅ **Answered as a consequence of AD-13 + AD-7** — a 200-employee payroll run is a ~4 MB working set; **fits comfortably, no upsize needed** |
| ~~12~~ | ~~File storage — local disk or S3?~~ | ✅ **Answered — AD-7: S3** |
| ~~13~~ | ~~Field-level encryption for PAN / bank details?~~ | ✅ **Answered — AD-10: application-level AES-256-GCM via KMS envelope, + S3 SSE-KMS** |
| ~~14~~ | ~~Rate limiting — does "none" still stand?~~ | ✅ **Answered — AD-8: targeted limiters** |
| ~~15~~ | ~~Root-folder tidy-up~~ | ✅ **Answered — AD-9: clean it** |
| 16 | **AWS provisioning** — S3 bucket (Block Public Access, SSE-KMS default, Bucket Keys on), **1–2 customer-managed CMKs with deletion protection**, and an IAM instance role granting `s3:*Object` + `kms:GenerateDataKey` + `kms:Decrypt` | Phase 0 (storage + crypto services) |
| 17 | ⚠️ **Retention — PARTIALLY answered by AD-16.** Selfies (90 d) and `AuditLog` (3 yr) are decided. **Still unset: payslips / Form 16 (statutory, likely 7–8 yrs), résumés, post-exit employee documents, `InboxItem`, expense receipts, bank files.** Unset = retain, so nothing is at risk — but each needs a value | Phase 3–5, per category |
| 18 | **Approval to execute AD-9** — the 7-file deletion is verified but **not performed**. Confirm, and it lands as its own revertible commit | Before `shared/` is added |

**Every design question is now closed. Phase 0 is fully specified and can begin.**

Items **16, 17 and 18** are operational follow-ons from AD-7, AD-9 and AD-10 — they need an **owner**, not a decision.

The remaining eleven are Phase 1+ product questions. Item 1 is now **deliberately deferred** under AD-11 rather than outstanding.

Items 1 and 2 are **deliberately deferred** (AD-11, AD-12) rather than outstanding — in both cases the architecture absorbs the answer later at low cost. Items 3 and 11 are **answered** (AD-13).

One **new** item arrives with AD-13:

| # | Question | Blocks |
|---|---|---|
| ~~19~~ | ~~`AuditLog` retention?~~ | ✅ **Answered — AD-16: 3 years, archive by default.** `InboxItem` remains unset (= retain) and rolls into item 17 |

The two urgent retention questions are **answered** (AD-16). What remains is a **compliance confirmation, not a design question**:

> 🔴 Does any `AuditLog` category need a **live** window longer than 3 years — or one that must never be deleted? Indian payroll retention commonly runs 7–8 years. Defaulting `action: 'archive'` satisfies this, but it should be confirmed by whoever owns compliance rather than assumed by the build.

Everything else is Phase 3+ and none of it blocks Phase 0 or Phase 1:

| # | Item | Phase |
|---|---|---|
| 4 | Payroll cutover — is there a live system? Parallel-run period? | 3 |
| 5 | Biometric hardware in use? | 2 |
| 7 | Public careers site on the customer ERP domain? | 5 |
| 8 | SSO required? | 6 |
| 9 | Which reports are actually needed? (DTA ships 3) | 6 |
| 17 | Retention values for the remaining categories | 3–5 |
| 16, 18 | AWS provisioning · approve the AD-9 deletion | **operational — need an owner, not a decision** |
