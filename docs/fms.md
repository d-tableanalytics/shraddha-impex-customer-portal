# FMS in the Customer Portal

The FMS (O2D) screens — My Tasks, Order Tracker, Stages, Order History, Exit
Register, Analytics, New Order and the FMS bell — for staff who work here,
chiefly Sales.

## How it works

There is **one FMS, and it runs in the Employee Portal**: the stage engine, the
escalation / daily-summary / Zoho-retry jobs, and the stage mirrors into the
Work Queue. This portal does not run any of it. Its frontend calls the Employee
API's `/api/v1/o2d` directly, with the session it already has — both portals
sign tokens with the same `JWT_SECRET`, so there is no second login.

```
 Customer Portal SPA ──/api/v1/*──────▶ Customer Portal API   (bookings, pricing, inventory…)
        │
        └── src/fms/ ──/api/v1/o2d/*──▶ Employee Portal API   (FMS: the only engine)
                        /api/v1/auth/me     └─ decides who may see FMS
```

**This portal's backend is untouched.** Its portal fence strips every O2D
permission by design, so it cannot say who may use FMS; the Employee API,
which enforces O2D, answers that instead (`src/fms/store/userStore.js`). No
shared-contract file changed.

## What is where

| Path | What |
|---|---|
| `frontend/src/fms/pages`, `components`, `services/o2d`, `services/delegation.js`, `services/fileUrl.js`, `utils/permissions.js`, `shared/constants` | **Verbatim** copies of the Employee Portal's files, listed with hashes in `frontend/fms-port.manifest.json`. Do not edit them here. |
| `frontend/src/fms/services/api.js` | Adapter: axios aimed at the Employee API, with this portal's token. A 401 refreshes through this portal's own single-flight `refreshAccessToken()` and retries once. It never signs anybody out. |
| `frontend/src/fms/services/apiBase.js` | Adapter: reads `VITE_EMPLOYEE_API_URL`. |
| `frontend/src/fms/store/userStore.js` | Adapter: the user as the Employee API resolves them (`/auth/me`). |
| `frontend/src/fms/FmsSession.jsx`, `navigation.js` | Glue: load/clear that session with this portal's, and the sidebar group. |

Routes are the Employee Portal's (`/fms/o2d/...`), so notification links open
the same screen in either portal.

## Turning it on

| Where | Setting |
|---|---|
| This repository → GitHub → Settings → Variables | `EMPLOYEE_API_URL` = the Employee API's origin (no `/api/v1`). CI and deploy pass it to the build as `VITE_EMPLOYEE_API_URL`. |
| Employee Portal API environment | Add `https://erp.shraddhaimpex.net` to `CORS_ORIGINS`. |
| Local development | Nothing: the build falls back to `http://localhost:5001`. The Employee backend's `.env` needs `CORS_ORIGINS=http://localhost:5173`. |

With either missing, FMS is simply not offered — no menu, no bell, and the
routes send you home. Nothing else in this portal changes.

## Keeping it in step

```bash
cd frontend
npm run fms:check   # CI runs this: no copy was edited here
npm run fms:diff    # which Employee Portal files changed since the last sync
npm run fms:sync    # copy them across, re-record the hashes; then run the tests
```

`fms:diff` / `fms:sync` read `../../Employee portal module/frontend` by
default; pass `--from <path>` for another checkout. The Employee Portal's O2D
page tests are copied too and run here as part of `npm test`.
