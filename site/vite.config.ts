import { defineConfig } from 'vite';
import path from 'node:path';

// The page reuses the teaser's model code (video/app/src/model) and reads the layout and the simulator's
// fonts straight from the repo, so the device on the page is the one in the CAD and in the video.
const repo = path.resolve(import.meta.dirname, '..');

export default defineConfig({
  resolve: {
    alias: {
      '@layout': path.join(repo, 'layout'),
      '@model': path.join(repo, 'video/app/src/model'),
      '@fonts': path.join(repo, 'sim/velxio/frontend/public/fonts'),
    },
    // the model files live outside site/: make their `three` import resolve to the page's copy
    dedupe: ['three'],
  },
  server: { port: 5190, fs: { allow: [repo] } },
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 1000 },
});
