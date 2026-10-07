import { defineConfig, normalizePath, type Plugin } from 'vite';
import path from 'node:path';

// The app serves files that live outside app/ (the video's data, the generated soundtrack, the CAD
// meshes, the vendored assets and the simulator's fonts) under fixed URL prefixes.
const video = path.resolve(import.meta.dirname, '..');
const repo = path.resolve(video, '..');
const MOUNTS: Record<string, string> = {
  '/data/': path.join(video, 'data'),
  '/audio/': path.join(video, 'build'),
  '/models/': path.join(video, 'build/models'),
  '/editor/': path.join(video, 'build/editor'),
  '/vendor/': path.join(video, 'public/vendor'),
  '/fonts/': path.join(repo, 'sim/velxio/frontend/public/fonts'),
};

function mounts(): Plugin {
  return {
    name: 'mounts',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? '';
        for (const [prefix, dir] of Object.entries(MOUNTS)) {
          if (url.startsWith(prefix)) { req.url = `/@fs/${encodeURI(normalizePath(dir))}/${url.slice(prefix.length)}`; break; }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [mounts()],
  // VIDEO_NO_HMR=1: no live reload (export renders must not reload mid-run when a file changes)
  server: {
    port: 5181, strictPort: false, hmr: process.env.VIDEO_NO_HMR ? false : undefined, fs: { allow: [repo] },
    // the offline renderer's encoder (scripts/render.ts), same-origin for the page
    proxy: process.env.VIDEO_FRAME_PORT ? { '/frame': `http://localhost:${process.env.VIDEO_FRAME_PORT}` } : undefined,
  },
  resolve: { alias: { '@layout': path.join(repo, 'layout') } },
  build: { target: 'esnext', assetsInlineLimit: 0 },
});
