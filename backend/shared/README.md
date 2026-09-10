# `backend/shared/`

What is left here after HRMS moved to its own repository.

This directory used to be the shared HRMS foundation — Zod schemas, the payroll
engine, leave date maths, attendance constants — imported by both this backend
and the frontend through the `@shared` Vite alias. All of that went with HRMS.

**Four things stayed, and each has a live consumer in this repository:**

| Path | Read by | Why it cannot go |
|---|---|---|
| `permissions/constants.js` | `models/User.js`, `modules/users/user.controller.js` | `isHrmsRoleKey` / `isAssignableRoleKey` — this repo still writes `User.roles[]` on the SHARED users collection |
| `permissions/assignment.js` | `utils/hrmsRoleGuard.js`, `models/User.js` | `assertRolesAssignable` — the AD-4 fence stopping a portal-only role holding an `hrms_*` key |
| `permissions/legacy.js`, `matrix.js`, `has-permission.js`, `index.js` | the two above, and `config/moduleRegistry.js` | the graph the first two sit on |
| `validation/common.js` | `middlewares/validate.js` | request validation, nothing to do with HRMS |
| `constants/hrms.js` | `modules/auth/auth.controller.js` | `AUDIT_ACTIONS` — the login / logout / refresh audit vocabulary |

## Why HRMS files survive in a repo with no HRMS

Both portals share ONE database. This backend still creates and edits accounts in
the `users` collection, and those documents carry `roles[]` — HRMS role keys.
Without `hrmsRoleGuard.js` and the `permissions/` graph beneath it, this repo
could hand a customer account an HRMS role and the Employee Portal would honour
it. The fence has to live wherever the writing happens.

`constants/hrms.js` is named for HRMS but is the audit-action vocabulary the
portal's own authentication writes. It is kept whole rather than trimmed to the
five `auth.*` actions it uses, so it stays byte-identical with the Employee
Portal's copy and a diff between the two means something.

See `Employee portal module/SHARED-CONTRACT.md` for the files that must stay
identical across the two repositories.
