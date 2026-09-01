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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': shared,
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
