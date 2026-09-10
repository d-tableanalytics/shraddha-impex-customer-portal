import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/*
 * NO `@shared` ALIAS ANY MORE, AND THAT IS THE POINT.
 *
 * This config used to alias `@shared` to `../backend/shared` so the SPA could
 * import the HRMS permission matrix and Zod schemas straight out of the backend
 * tree. That dragged two more workarounds along with it:
 *
 *   - a `zod` alias, because `backend/shared/schemas/*.js` imports `zod` and
 *     Node resolves a bare specifier by walking `node_modules` upward from the
 *     IMPORTING file — so those files looked in `backend/node_modules`, which is
 *     a sibling of this project rather than an ancestor. It worked on a
 *     developer machine by accident and failed in CI, where only `frontend/` is
 *     installed;
 *   - `server.fs.allow: ['..']`, so the dev server was permitted to read files
 *     outside this directory at all.
 *
 * All three existed only for HRMS. With HRMS in its own repository, nothing
 * under `src/` imports `@shared`, and this frontend no longer reaches outside
 * its own folder for anything — which is what makes the build self-contained.
 *
 * If a future portal needs to share code with this one, do NOT reintroduce a
 * relative path into a sibling project: publish it, or duplicate it deliberately
 * the way `Employee portal module/SHARED-CONTRACT.md` describes.
 */

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // Use default chunking strategy
    }
  },
  test: {
    // jsdom, because several tests render real components.
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
  },
})
