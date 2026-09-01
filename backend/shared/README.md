# `backend/shared` — the single source of truth for HRMS permissions, schemas and constants

Imported by **both** halves of the application:

- **Backend** — relative ESM imports, e.g. `import { hasHrmsPermission } from '../shared/permissions/index.js'`
- **Frontend** — via the Vite alias `@shared`, e.g. `import { HRMS_MODULES } from '@shared/permissions/index.js'`

Nothing in here may be duplicated on either side. `backend/middlewares/rbac.js` and
`frontend/src/utils/permissions.js` are thin re-export shims over this directory — that is
deliberate, and it is what ends the hand-maintained mirror the two files used to be.

---

## Why this lives under `backend/` and not at the repository root

`documentation/hrms-replication-plan.md` proposed a root-level `shared/`. Implementation
found a blocking reason not to, and this note records it.

This repository is **two independent npm projects with no workspace tooling** — there is no
root `package.json`, and `backend/` and `frontend/` each own their own `node_modules`.

Node resolves a bare specifier such as `import { z } from 'zod'` by walking `node_modules`
directories upward **from the importing file**. A file at `<repo>/shared/validation/common.js`
would therefore search `<repo>/shared/node_modules`, then `<repo>/node_modules`, then `/dev/…`
— and **never** `<repo>/backend/node_modules`. Resolving symlinks to their real path (Node's
default) means an npm `file:../shared` dependency does not change this.

The options were:

| Option | Cost |
|---|---|
| Root `shared/` with its own `package.json` + `node_modules` | A third install location, and a new `cd shared && npm ci` step in `.github/workflows/deploy.yml` |
| npm workspaces at the root | Restructures how both projects install; rewrites the deploy pipeline |
| Keep `shared/` dependency-free | Zod schemas could not live here, so they would be duplicated — the exact problem this directory exists to solve |
| **`backend/shared/` (chosen)** | The folder name is slightly misleading. Nothing else. |

Under `backend/`, bare specifiers resolve through `backend/node_modules` for the backend, and
Vite resolves them through `frontend/node_modules` when it bundles. **The deploy pipeline is
completely unchanged** — `npm ci --omit=dev` in `backend/` already covers it, and the frontend
build inlines what it uses.

Reported as an architectural discovery; see the Phase 0 summary.

---

## Layout

```
shared/
├── permissions/
│   ├── constants.js        HRMS modules, actions, scopes, scope ranking, role keys
│   ├── matrix.js           HRMS role → permission tuples (the canonical grant table)
│   ├── has-permission.js   the canonical module × action × scope evaluator
│   ├── legacy.js           the existing portal's flat-string permission model
│   └── index.js
├── constants/
│   └── hrms.js             HRMS enums shared by both halves
├── security/
│   └── sensitive-fields.js reserved sensitive keys (AD-10 / AD-11)
├── validation/
│   └── common.js           shared Zod building blocks (AD-6)
└── index.js
```

## Rules

1. **Pure, portable JavaScript.** No Express, no Mongoose, no React, no `process.env`,
   no filesystem. It must run unchanged in Node and in a browser bundle.
2. **`zod` is the only permitted external import**, and only under `validation/`.
   `permissions/`, `constants/` and `security/` stay dependency-free so they can be imported
   from anywhere — including scripts that run before dependencies are installed.
3. **Always use explicit `.js` extensions** on relative imports. Node ESM requires them.
4. **Legacy and HRMS permission models stay separate.** They are different shapes with
   different semantics; see `permissions/legacy.js`.
