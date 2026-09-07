# DTA Hiring / Recruitment — analysis and replication plan

Phase 7. Written from the DTA source, not from documentation: every claim below
is traceable to a file in `DTA_HRMS/apps/api/src/modules/hiring`,
`apps/web/src/pages/hiring` or `packages/shared-types/src/hiring.ts`.

---

## 1. DTA module structure

`apps/api/src/modules/hiring/` — eight controllers, seven services:

| File | Lines | What it owns |
|---|---:|---|
| `job-requisition.{controller,service}.ts` | 86 / 211 | The hiring request and its approval |
| `job-posting.{controller,service}.ts` | 64 / 262 | The public advert, its slug, publish/close, public apply |
| `candidate.{controller,service}.ts` | 92 / 167 | The person, plus résumé upload/download |
| `application.{controller,service}.ts` | 72 / 190 | One candidate × one requisition; the Kanban row |
| `interview.{controller,service}.ts` | 106 / 305 | Scheduling, panel, status, and feedback |
| `hiring-offer.{controller,service}.ts` | 68 / 314 | Offer, PDF letter, send, accept, reject |
| `public-careers.controller.ts` | 113 | Six `@Public()` routes |
| `ai-jd.{controller,service}.ts` | 18 / 57 | JD drafting |

`apps/web/src/pages/hiring/` — six tabs behind one page
(`HiringPage.tsx`, 60 lines) plus `apps/web/src/pages/careers/OfferAcceptPage.tsx`.

---

## 2. DTA screens / routes

`/hiring/:tab`, tab order following the funnel left to right
(`HiringPage.tsx:26-42`):

| Tab | Key | Gate |
|---|---|---|
| Requisitions | `requisitions` | `hiring:edit:org` |
| Candidates | `candidates` | `hiring:edit:org` |
| Pipeline | `pipeline` | `hiring:view:org` OR `:team` |
| My interviews | `interviews` | always — panelists need it |
| Postings | `postings` | `hiring:edit:org` |
| Offers | `offers` | `hiring:edit:org` |

Default tab is `pipeline`. Public: `/careers`, `/careers/:slug`,
`/careers/offer/:id`.

---

## 3. DTA APIs

Authenticated, under `hiring/`:

```
GET  /requisitions                      view:org | view:team
GET  /requisitions/:id                  view:org | view:team
POST /requisitions                      edit:org
POST /requisitions/:id/approve          edit:org
POST /requisitions/:id/status           edit:org

GET  /candidates                        view:org | view:team
POST /candidates                        edit:org
POST /candidates/:id/resume             edit:org      (multipart)
GET  /candidates/:id/resume             view:org

GET  /applications?requisitionId=       view:org | view:team
GET  /applications/:id                  view:org | view:team
POST /applications                      edit:org
POST /applications/:id/move             edit:org

GET  /interviews?applicationId=         view:org | view:team
GET  /interviews/mine                   (any authenticated)
POST /interviews                        edit:org
POST /interviews/:id/status             edit:org
GET  /interviews/:id/feedback           view:org | view:team
POST /interviews/feedback               panelist OR edit:org

GET  /postings                          view:org | view:team
POST /postings                          edit:org
POST /postings/:id/publish              edit:org
POST /postings/:id/close                edit:org

GET  /offers                            view:org | view:team
POST /offers                            edit:org
POST /offers/:id/send                   edit:org

POST /ai/generate-jd                    edit:org
```

Public (`@Public()`, no authentication — `public-careers.controller.ts`):

```
GET  /careers/postings
GET  /careers/postings/:slug
POST /careers/postings/:slug/apply
GET  /careers/offer/:id
GET  /careers/offer/:id/pdf
POST /careers/offer/:id/accept
POST /careers/offer/:id/reject
```

---

## 4. DTA models

`JobRequisition`, `JobPosting`, `Candidate`, `Application`, `Interview`,
`InterviewFeedback`, `HiringOffer`. Money (`budgetMin`, `budgetMax`,
`expectedSalary`, `ctc`) is Postgres `Decimal`.

---

## 5. DTA permissions

Only two keys, both of which already exist in the Shraddha matrix:

- `hiring:view` at `org` (hr_admin, recruiter, super_admin, auditor) and at
  `team` (manager — "interviewer view", `matrix.js:186`)
- `hiring:edit` at `org` (hr_admin, recruiter, super_admin)

Nothing new is invented for the replication.

---

## 6. DTA workflows / status transitions

**Requisition** — `draft → approved → open → filled | cancelled`.
`approve` is guarded (`draft` only). `setStatus` is **not** guarded at all
(`job-requisition.service.ts:139-160`) — any status to any status.

**Posting** — `publish` sets `publishedAt` and flips an `approved` requisition
to `open`; `close` sets `closedAt`.

**Application** — `applied → screening → interview → offer → hired`, with
`rejected` reachable from any stage. Guarded: cannot move *from* `hired`/
`rejected`; `hired` requires an accepted offer; `rejected` requires a reason.
Reaching `hired` flips the requisition to `filled` once hires ≥ headcount.

**Interview** — scheduling auto-advances an `applied`/`screening` application to
`interview`. Status is free-form (`scheduled|completed|cancelled|no_show`).
Feedback is one row per (interview, interviewer), panelist-only, unique.

**Offer** — create (auto-moves the application to `offer`) → send (renders the
PDF, mails a link) → accept | reject, both from the **public** career page.

---

## 7. Fields and validation

Taken verbatim from `packages/shared-types/src/hiring.ts` — titles ≤200,
headcount 1–100, résumé/notice 0–365 days, panel 1–10 users, duration 15–300
minutes, ratings 1–5, rejection reason ≤500, justification ≤2000.

---

## 8. UI/UX behaviour

One page, six tabs, tab in the URL. Pipeline is a Kanban of six stage columns.
Interviews shows panel chips and a feedback drawer with 1–5 star ratings and a
four-way decision. Offers is a table with Send / view-PDF actions.

---

## 9. Integrations and dependencies

- **Org Structure** — requisitions reference Department and Location.
- **Employee Master** — panel members are Users; DTA reads `User.displayName`.
- **Storage** — résumés and offer PDFs.
- **Inbox / Mail** — requisition-approved and interview-scheduled notices, and
  the offer email. Not built here (Inbox is not a Shraddha module).

DTA does **not** auto-provision an Employee on offer acceptance — its own
comment says so (`hiring-offer.service.ts:26-30`).

---

## 10. 🔴 Defects corrected, and what is intentionally excluded

### Corrected

1. **The public offer endpoints are keyed by the offer UUID alone.**
   `GET /careers/offer/:id` returns the candidate's name, email, designation and
   **CTC**; `/pdf` serves the signed letter; `/accept` and `/reject` decide the
   offer — all with no token, no rate limit and no proof the caller is the
   candidate. Anyone holding or guessing an id can read someone's salary or
   accept an offer on their behalf. This is the same class of defect AD-15
   found in the attendance selfie endpoint.
   → Replaced with a **single-purpose, unguessable access token** mailed with
   the offer, rate-limited, and compared in constant time. The id alone opens
   nothing.

2. **A requisition can be approved by its own creator.** `approve` checks only
   `hiring:edit:org`, which the creator holds.
   → Self-approval refused, as Payroll already refuses self-approved
   corrections.

3. **`setStatus` enforces no state machine.** `cancelled → open`, `filled →
   draft` are all accepted.
   → Transitions declared as data and enforced.

4. **`application.create` never checks that the candidate exists.** Postgres
   would catch it by foreign key; MongoDB will not (AD-2).
   → References resolved before the write.

5. **Stage moves may skip arbitrarily** (`applied → offer` directly).
   → Forward-by-one, or reject, enforced.

6. **Résumés are streamed through the API from local disk.** AD-7 requires the
   S3 abstraction and presigned access.
   → Stored via the existing `candidate-resume` category, read through the
   authorised `issueReadUrl` path, retention-swept under `resumes`.

7. **`interview.setStatus` accepts any status** including reviving a cancelled
   interview. → Transitions enforced.

8. **Money is a JS `number`.** → `Decimal128`, per AD-2, reusing
   `shared/payroll/money.js`.

### Intentionally excluded

- **Inbox and email notifications.** Inbox is not a Shraddha module; sending
  mail for offers is deferred rather than faked. The offer's access token is
  returned to the recruiter to deliver.
- **Offer letter PDF rendering.** DTA uses `pdf-lib`; the offer record, its
  token flow and the accept/reject workflow are complete, but no PDF is
  generated. Payroll deferred payslip PDFs for the same reason.
- **Employee auto-provisioning on acceptance** — DTA stubs it too.
- **Job-board integrations** (`boardIntegrations`) — DTA stores the array and
  never reads it.
- **The drawn signature pad.** DTA's offer page asks the candidate to draw a
  signature on a canvas and posts it as a base64 data URL. Replaced with a typed
  full legal name, recorded alongside the acceptance timestamp, the IP address
  and the user agent. The reasoning is that the drawn image adds no evidential
  weight a typed name plus those three does not already carry, while a
  base64 image body on an *unauthenticated* endpoint is a megabyte-scale write
  surface open to the internet — the one place in this module where that
  trade is clearly not worth taking.

## 11. What was built

### Backend

| File | What it holds |
| --- | --- |
| `shared/constants/hiring.js` | Enums, the three transition tables, résumé MIME types and magic bytes, `MAX_RESUME_BYTES`, offer-token TTL |
| `shared/schemas/hiring.js` | Every request schema (Zod 4), shared verbatim with the React forms |
| `models/hrms/HiringModels.js` | `JobRequisition`, `JobPosting`, `Candidate`, `Application`, `Interview`, `InterviewFeedback`, `HiringOffer` |
| `modules/hrms/hiring/requisition.service.js` | Requisitions + postings, self-approval refusal, slug minting |
| `modules/hrms/hiring/candidate.service.js` | Candidates, résumé upload via `putObject`, presigned reads via `issueReadUrl` |
| `modules/hrms/hiring/application.service.js` | The pipeline, forward-by-one transitions, the Kanban board |
| `modules/hrms/hiring/interview.service.js` | Scheduling, panel, panelist-only feedback |
| `modules/hrms/hiring/offer.service.js` | Offers and the hashed, expiring candidate access token |
| `modules/hrms/hiring/careers.service.js` | The public advert listing and the anonymous application |
| `modules/hrms/hiring/aiJd.service.js` | The JD drafting template |
| `modules/hrms/hiring/hiring.routes.js` | The authenticated router |
| `modules/hrms/hiring/careers.routes.js` | The public router, rate-limited, mounted above `protect` |

### Frontend

| File | What it renders |
| --- | --- |
| `pages/Hrms/hiring/HiringPage.jsx` | The shell: six tabs, tab in the URL, permission-gated |
| `pages/Hrms/hiring/RequisitionsTab.jsx` | The requisition table, raise dialog, approve, cancel-with-reason |
| `pages/Hrms/hiring/CandidatesTab.jsx` | The candidate table, add dialog with résumé upload, on-demand résumé links |
| `pages/Hrms/hiring/PipelineTab.jsx` | The Kanban board, forward-by-one moves, reject-with-reason |
| `pages/Hrms/hiring/InterviewsTab.jsx` | "Assigned to me" and "All interviews", schedule drawer, feedback dialog and viewer |
| `pages/Hrms/hiring/PostingsTab.jsx` | Adverts, the drafting aid, publish, copy link, close |
| `pages/Hrms/hiring/OffersTab.jsx` | Offers, the draft drawer, and the shown-once candidate link |
| `pages/Careers/*` | The three public pages: role list, advert + apply, offer + accept/decline |
| `services/hrms/hiring.js` | The authenticated API client |
| `services/careers.js` | The public, credential-free client |

### Deliberate UI departures from DTA

1. **Pipeline moves are buttons, not drag-and-drop.** DTA lets a card be
   dropped on any column; the server now permits only forward-by-one or a
   rejection, and offering a gesture the API will refuse is worse than not
   offering it. Buttons also keep the board usable by keyboard and on a phone.
2. **Pipeline is gated on `hiring:view:org`, not on either view grant.** The
   board is every applicant for a requisition — org-wide data by construction.
   `hiring:view:team` (which the matrix calls the interviewer view) opens "My
   interviews" and nothing else.
3. **The default tab is the first one the viewer can use,** not DTA's fixed
   `pipeline`. A panellist dropped onto Pipeline would see a board they cannot
   open.
4. **The offer link is presented in a blocking, copy-once dialog.** DTA has no
   token to present.

