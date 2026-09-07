import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// `@shared` resolves to backend/shared — the single source of truth for HRMS
// permissions, constants and Zod schemas, imported by both halves of the app.
//
// It lives under backend/ rather than at the repository root because this repo
// is two independent npm projects with no workspace tooling: Node resolves a
// bare specifier like `zod` by walking node_modules upward from the importing
// FILE, so a root-level shared/ could never see backend/node_modules. Under
// backend/ the backend resolves it natively and Vite resolves it through
// frontend/node_modules when bundling. See backend/shared/README.md.
const shared = fileURLToPath(new URL('../backend/shared', import.meta.url))

/**
 * `zod` is the ONE bare specifier the shared module imports, and it cannot
 * resolve itself.
 *
 * Node resolves a bare specifier by walking `node_modules` upward from the
 * IMPORTING FILE, so `backend/shared/schemas/*.js` looks in
 * `backend/node_modules` - never in `frontend/node_modules`, which is a
 * sibling rather than an ancestor. On a developer machine that works by
 * accident, because `backend/node_modules` is there from working on the API.
 * The CI frontend job installs only `frontend/`, so the same import fails:
 *
 *   [vite]: Rolldown failed to resolve import "zod" from
 *   "backend/shared/schemas/employee.js"
 *
 * Pointing it at the frontend's own copy - `zod` is a declared dependency
 * here - makes the build self-contained. It also means the bundle carries
 * exactly ONE zod: without this the shared schemas were compiled against
 * backend's copy and the frontend's own code against frontend's, which is the
 * same "loaded twice under two identities" problem the test alias below
 * exists to prevent.
 */
const zod = fileURLToPath(new URL('./node_modules/zod', import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': shared,
      zod,
    },
  },
  server: {
    fs: {
      // The dev server must be allowed to read outside frontend/ to serve the
      // shared module. Production builds inline it and are unaffected.
      allow: ['..'],
    },
  },
  build: {
    rollupOptions: {
      // Use default chunking strategy
    }
  },
  test: {
    // jsdom, because the HRMS tests render real components. The pure ones
    // (permission matrices, nav filtering) do not need it and are unaffected.
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    // Node also resolves `@shared`; without this the shared module is loaded
    // twice under two identities and instanceof checks across it would fail.
    alias: { '@shared': shared },
  },
})
