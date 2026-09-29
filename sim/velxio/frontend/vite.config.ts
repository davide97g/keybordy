import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// avr8js / rp2040js / @wokwi/elements are resolved from npm via package.json.
// (The third-party/ clones are reference-only — keep them updated for credits.)

// Backend for `npm run dev`. Defaults to a local uvicorn on :8001; point it
// at the running container (nginx proxies /api and serves /projects) with
//   VELXIO_PROXY=http://127.0.0.1:3080 npm run dev
const backend = process.env.VELXIO_PROXY ?? 'http://127.0.0.1:8001';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: backend,
        changeOrigin: true,
        ws: true,
      },
      '/projects': {
        target: backend,
        changeOrigin: true,
      },
    },
  },
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    include: ['avr8js', 'rp2040js', '@wokwi/elements', 'littlefs'],
  },
  build: {
    // Phase 1d #4 — split heavy long-lived chunks so cache-hits stay
    // meaningful and the cold-load entry stays small.  The previous
    // bundle landed the whole app + Monaco + every MCU sim in one
    // index chunk (>23 MB).  Manual chunks below collapse it into
    // cacheable groups that match the user's actual flow (editor
    // load, run simulator, edit code in Monaco).
    rollupOptions: {
      output: {
        manualChunks: {
          // ngspice WASM client — only loaded when the user opens
          // a circuit with electrical components.
          'spice-wasm': [
            './src/simulation/spice/adapters/NgSpiceWorkerAdapter.ts',
            './src/simulation/spice/wasm/NgSpiceInteractive.ts',
          ],
          // MCU emulators — bulky, infrequent updates.
          'mcu-emulators': ['avr8js', 'rp2040js'],
          // Wokwi visual elements — large but cacheable; only loaded
          // once per session.
          'wokwi-elements': ['@wokwi/elements'],
          // React vendor — stable across deploys, near-permanent cache.
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
    chunkSizeWarningLimit: 8000,
  },
  // Vitest config lives in `vitest.config.ts` (split out so CI can
  // reference it directly and so vite build doesn't pay test deps).
})
