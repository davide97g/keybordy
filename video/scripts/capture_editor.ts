#!/usr/bin/env bun
// Screenshots of the keymap editor (host/ui) for the v2 teaser, with demo data: host/ui is served here
// next to a mock of the Hammerspoon API (host/hammerspoon/keybordy_web.lua), so nothing touches the real
// keymap, its token or its activity log. Writes video/build/editor/{a,b,c}.png at 2x and rects.json with
// where the caps and the Save button sit (CSS px), for the click stickers.
//
//   cd video/app && bun ../scripts/capture_editor.ts
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const VIDEO = path.resolve(import.meta.dir, '..');
const REPO = path.resolve(VIDEO, '..');
const OUT = path.join(VIDEO, 'build/editor');
const FRONTEND = path.join(REPO, 'sim/velxio/frontend');
const STATIC: Record<string, string> = {
  '/ui/': path.join(REPO, 'host/ui'),
  '/tokens/': path.join(FRONTEND, 'src/tokens'),
  '/fonts/': path.join(FRONTEND, 'public/fonts'),
  '/keybordy/': path.join(FRONTEND, 'public/keybordy'),
};

// the cap colours, as kb.colors() reads them from the diagram
const diagram = JSON.parse(readFileSync(path.join(REPO, 'firmware/keys8/diagram.json'), 'utf8'));
const colors = Array.from({ length: 8 }, (_, i) => diagram.parts.find((p: any) => p.attrs?.label === `K${i + 1}`)?.attrs?.color ?? '#f4f1f8');

const keymap = {
  version: 1,
  keys: [
    { label: 'Claude Code', action: { type: 'terminal', dir: '~/code', command: 'claude' } },
    { label: 'Notes', action: { type: 'app', app: 'Notes' } },
    { label: 'Terminal', action: { type: 'terminal', dir: '~', command: '' } },
    { label: 'VS Code', action: { type: 'app', app: 'Visual Studio Code' } },
    { label: 'Simulator', action: { type: 'url', url: 'http://localhost:3080/editor?project=keys8' } },
    { label: 'Focus', action: { type: 'shortcut', name: 'Focus 25 min' } },
    { label: 'Slack', action: { type: 'app', app: 'Slack' } },
    { label: 'Music', action: { type: 'app', app: 'Music' } },
  ],
};
const base = Date.parse('2026-10-07T09:41:00');
const evs = [[1, 'Claude Code', 'terminal'], [4, 'VS Code', 'app'], [5, 'Simulator', 'url'], [2, 'Notes', 'app'], [1, 'Claude Code', 'terminal'],
  [6, 'Focus', 'shortcut'], [8, 'Music', 'app'], [3, 'Terminal', 'terminal'], [7, 'Slack', 'app'], [4, 'VS Code', 'app'], [1, 'Claude Code', 'terminal']] as const;
const events = evs.map(([key, label, type], i) => ({ id: i + 1, key, label, type, source: 'board', ok: true, t: base + i * 23000 }));
const state = { rev: 1, keymapRev: 1, accessibility: true, events, keymap, colors, keymapPath: '~/.config/keybordy/keymap.json', mediaKeys: ['PLAY', 'NEXT', 'PREVIOUS', 'MUTE'] };

const sticker = readFileSync(path.join(FRONTEND, 'index.html'), 'utf8').match(/(<svg class="kbs"[\s\S]*?<\/svg>)/)?.[1] ?? '';
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', woff2: 'font/woff2', svg: 'image/svg+xml', png: 'image/png' };
const json = (x: unknown) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === '/') {
      const html = readFileSync(path.join(REPO, 'host/ui/index.html'), 'utf8').replace('__TOKEN__', 'demo').replace('<!-- STICKER -->', sticker);
      return new Response(html, { headers: { 'content-type': TYPES.html! } });
    }
    if (u.pathname === '/api/state') return json(state);
    if (u.pathname === '/api/events') return json({ rev: state.rev, events, keymapRev: 1, accessibility: true });
    if (u.pathname === '/api/shortcuts') return json(['Focus 25 min']);
    if (u.pathname === '/api/apps') return json([]);
    if (u.pathname.startsWith('/api/')) return new Response('demo: read only', { status: 403 });
    for (const [prefix, dir] of Object.entries(STATIC)) {
      if (!u.pathname.startsWith(prefix)) continue;
      const name = u.pathname.slice(prefix.length);
      if (!/^[\w.-]+$/.test(name)) break;
      try { return new Response(readFileSync(path.join(dir, name)), { headers: { 'content-type': TYPES[name.split('.').pop()!] ?? 'application/octet-stream' } }); } catch { break; }
    }
    return new Response('not found', { status: 404 });
  },
});

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
await page.goto(`http://localhost:${server.port}/`);
await page.waitForSelector('#cap-0');
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(800);
const rect = async (sel: string) => { const b = await page.locator(sel).first().boundingBox(); return b && [b.x, b.y, b.width, b.height]; };
const rects: Record<string, unknown> = {};
// a: K1 (Claude Code in a terminal); b: K5 (open a URL); c: K6 (run a Shortcut). DOM clicks: the caps
// are still settling from their entrance animation when a pointer click would land.
const pick = async (i: number) => { await page.evaluate((i) => (document.getElementById(`cap-${i}`) as HTMLButtonElement).click(), i); await page.waitForTimeout(500); };
await page.screenshot({ path: path.join(OUT, 'a.png') });
rects.caps = await Promise.all(Array.from({ length: 8 }, (_, i) => rect(`#cap-${i}`)));
await pick(4);
await page.screenshot({ path: path.join(OUT, 'b.png') });
await pick(5);
await page.screenshot({ path: path.join(OUT, 'c.png') });
rects.save = await rect('button:has-text("Save")');
rects.viewport = [1600, 1000];
writeFileSync(path.join(OUT, 'rects.json'), JSON.stringify(rects, null, 1));
await browser.close();
server.stop(true);
console.log(`wrote ${OUT}/{a,b,c}.png and rects.json`);
