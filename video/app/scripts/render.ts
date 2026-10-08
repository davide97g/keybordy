#!/usr/bin/env bun
// Offline renderer (vendored from pdoom-video, MIT). Drives the app in headless Chrome (?export=1) and either
//   stills:  bun scripts/render.ts stills --t 1.5,23,40.2 [--only id1,id2] [--out dir]
//   sheet:   bun scripts/render.ts sheet --from 20 --to 35 [--n 12] [--cols 4] [--only ids] [--out file.png]   (or --times a,b,c | --cuts)
//   perf:    bun scripts/render.ts perf --from 20 --to 25 [--only ids] [--samples 1] [--shutter 0.5]   (avg ms per frame incl. GPU sync and the export's pixel readback)
//   video:   bun scripts/render.ts video [--from 0] [--to 156.65] [--fps 60] [--crf 16] [--x264 aq-mode=3] [--samples 1] [--shutter 0.5] [--out ../out/keybordy-mp-teaser.mp4] [--noaudio]
//            [--workers 2] [--chunk 8] [--mem-gb 1] [--spool-gb 20]
//            --samples N averages N sub-frames per frame over shutter×(1/fps): motion blur + temporal AA;
//            --samples auto picks the count per 32x32 tile (12, 36, 108 or 324, see Engine.render; --refine frame: per frame)
//            --workers N headless Chromes render chunks of --chunk frames into one ffmpeg, in order (see video())
//   --scale N (all modes): render at N× the 1920x1080 layout (--scale 2 = true 3840x2160); stills are then saved
//            full-res from the pixel buffer, videos are encoded at the physical size.
//   --thumb (all modes): thumbnail plates (?thumb=1, see src/version.ts THUMB); outputs as usual, pass --out.
//   --vertical (all modes): the upright cut for Reels and Shorts (?aspect=9x16, 1080x1920 logical), any version;
//            default outputs go to out/[vN/]9x16/.
// Uses the Vite dev server at --url (default http://localhost:5181); starts a private one if unreachable.
import { chromium, type Page } from 'playwright-core';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const mode = argv[0] ?? 'stills';
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k: string) => argv.includes(`--${k}`);
const APP = path.resolve(import.meta.dir, '..');
const SCALE = Math.max(1, Math.round(+opt('scale', '1')!));
// --v N: which cut (see src/version.ts); each has its own soundtrack and default output folder
const VERSION = Math.max(1, Math.round(+opt('v', '1')!));
const VDIR = VERSION === 1 ? '' : `v${VERSION}/`;
const VERTICAL = flag('vertical');
const ODIR = `${VDIR}${VERTICAL ? '9x16/' : ''}`; // default output folder under out/
const LW = VERTICAL ? 1080 : 1920, LH = VERTICAL ? 1920 : 1080; // logical size
const OW = LW * SCALE, OH = LH * SCALE; // output size
// --samples N (fixed) or --samples auto [--min-samples 4] [--max-samples 324] [--tol 3] [--refine tiles|frame]
// (adaptive, see Engine.render)
const SAMPLES = opt('samples', '1') === 'auto'
  ? { min: +opt('min-samples', '4')!, max: +opt('max-samples', '324')!, tol: +opt('tol', '3')!, refine: opt('refine', 'tiles') as 'tiles' | 'frame' }
  : +opt('samples', '1')!;
const hist = (h: Record<string, number>) => Object.entries(h).sort((a, b) => +a[0] - +b[0]).map(([k, v]) => `${k}:${v}`).join(' ');
const ROOT = path.resolve(APP, '..'); // video/

async function reachable(url: string) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

async function ensureServer(frameServerPort?: number): Promise<{ url: string; stop: () => void }> {
  const url = opt('url', 'http://localhost:5181')!;
  if (!frameServerPort && await reachable(url)) return { url, stop: () => {} };
  // a port nothing listens on (a random one could land on a stale server from a killed render)
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = probe.port;
  probe.stop(true);
  // no live reload: a file saved mid-render must not reload the page. VIDEO_FRAME_PORT makes Vite proxy
  // /frame to the encoder, so the page posts its frames same-origin (Chrome's local network access check
  // stalls requests from the page to another localhost port).
  const env: Record<string, string> = { ...process.env as Record<string, string>, VIDEO_NO_HMR: '1' };
  if (frameServerPort) env.VIDEO_FRAME_PORT = String(frameServerPort);
  const proc = Bun.spawn(['bunx', 'vite', '--port', String(port), '--strictPort'], { cwd: APP, stdout: 'ignore', stderr: 'ignore', env });
  const u = `http://localhost:${port}`;
  for (let i = 0; i < 100 && !(await reachable(u)); i++) await Bun.sleep(100);
  return { url: u, stop: () => proc.kill() };
}

async function openPage(url: string) {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: !flag('headed'),
    args: ['--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  const page = await browser.newPage({ viewport: { width: LW, height: LH }, deviceScaleFactor: 1 });
  const logs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  page.on('crash', () => console.error('[page crashed]'));
  const only = opt('only');
  await page.goto(`${url}/?export=1${only ? `&only=${only}` : ''}${SCALE !== 1 ? `&scale=${SCALE}` : ''}${VERSION !== 1 ? `&v=${VERSION}` : ''}${VERTICAL ? '&aspect=9x16' : ''}${flag('thumb') ? '&thumb=1' : ''}`);
  await page.waitForFunction(() => (window as any).__video?.ready || (window as any).__video?.error, null, { timeout: 120000 });
  const err = await page.evaluate(() => (window as any).__video.error);
  if (err) throw new Error(`app failed to boot:\n${err}\n${logs.join('\n')}`);
  const size: [number, number] = await page.evaluate(() => [(window as any).__video.width ?? 1920, (window as any).__video.height ?? 1080]);
  if (size[0] !== OW || size[1] !== OH) throw new Error(`app renders ${size[0]}x${size[1]}, expected ${OW}x${OH} (--scale ${SCALE})`);
  const sceneErrors: string[] = await page.evaluate(() => (window as any).__video.errors);
  if (sceneErrors.length) console.error('SCENE ERRORS:\n' + sceneErrors.join('\n'));
  return { browser, page, logs };
}

async function stills(page: Page, times: number[], outDir: string) {
  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  for (const t of times) {
    const k: number = await page.evaluate(([t, s, sh]) => (window as any).__video.still(t, s, sh), [t, SAMPLES, +opt('shutter', '0.5')!] as const);
    const f = path.join(outDir, `f_${t.toFixed(2).padStart(7, '0')}.png`);
    if (typeof SAMPLES !== 'number') console.log(`t=${t}: ${k} sub-frames`);
    // at scale > 1 the canvas is shown downscaled on the page: save the full-res pixel buffer instead
    if (SCALE !== 1) await Bun.write(f, Buffer.from(await page.evaluate(() => (window as any).__video.png()), 'base64'));
    else await page.screenshot({ path: f, clip: { x: 0, y: 0, width: LW, height: LH } });
    files.push(f);
  }
  return files;
}

async function sheet(page: Page, times: number[], cols: number, out: string) {
  const dataUrl: string = await page.evaluate(async ({ times, cols, vertical }) => {
    const P = (window as any).__video;
    const cw = vertical ? 270 : 480, ch = vertical ? 480 : 270, pad = 4, lab = 18;
    const rows = Math.ceil(times.length / cols);
    const cv = document.createElement('canvas');
    cv.width = cols * (cw + pad) + pad; cv.height = rows * (ch + lab + pad) + pad;
    const c = cv.getContext('2d')!;
    c.fillStyle = '#222'; c.fillRect(0, 0, cv.width, cv.height);
    const src = document.getElementById('c') as HTMLCanvasElement;
    times.forEach((t: number, i: number) => {
      P.still(t);
      const x = pad + (i % cols) * (cw + pad), y = pad + Math.floor(i / cols) * (ch + lab + pad);
      c.drawImage(src, x, y + lab, cw, ch);
      c.fillStyle = '#ddd'; c.font = '13px monospace'; c.fillText(`${t.toFixed(2)}s`, x + 2, y + 13);
    });
    return cv.toDataURL('image/png');
  }, { times, cols, vertical: VERTICAL });
  mkdirSync(path.dirname(out), { recursive: true });
  await Bun.write(out, Buffer.from(dataUrl.split(',')[1]!, 'base64'));
}

/**
 * Render [from, to) into one encoder. `--workers N` headless Chromes (default 2; each its own GPU process)
 * take chunks of `--chunk` frames in order; the server puts their frames back in order and writes them to a
 * single ffmpeg, so the file is the same as with one worker. A frame is acknowledged once it is written or
 * waiting in a bounded reorder buffer, and each page keeps at most a few frames unacknowledged, so memory stays
 * bounded at 4K. One worker already keeps the GPU busy in the heavy scenes; a second one fills the gaps in the
 * light ones (2D drawing, readback, transfer).
 */
async function video(from: number, to: number, fps: number, out: string) {
  mkdirSync(path.dirname(out), { recursive: true });
  const crf = opt('crf', '16')!;
  const audio = path.join(ROOT, `build/${VDIR}mix_stereo.wav`);
  // (frames come as rgb24: the same YUV out of the scaler as from rgba, a quarter fewer bytes to move)
  const args = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${OW}x${OH}`, '-r', String(fps), '-i', 'pipe:0'];
  if (!flag('noaudio')) args.push('-ss', String(from), '-t', String(to - from), '-i', audio);
  // Frames are sRGB (toSRGB in the final pass): convert with the BT.709 matrix and tag the stream,
  // otherwise ffmpeg converts with BT.601 while players and YouTube decode untagged HD as BT.709.
  // scale tags the matrix and range; primaries and transfer need setparams (the -color_* output flags don't reach the stream).
  args.push('-vf', 'vflip,scale=out_color_matrix=bt709,setparams=color_primaries=bt709:color_trc=bt709', '-c:v', 'libx264', '-preset', opt('preset', 'slow')!, '-crf', crf, '-pix_fmt', 'yuv420p', '-tune', 'grain', '-x264-params', opt('x264', 'aq-mode=3')!);
  if (!flag('noaudio')) args.push('-c:a', 'aac', '-b:a', '320k', '-shortest');
  args.push('-movflags', '+faststart', out);
  const ff = Bun.spawn(args, { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' });


  const f0 = Math.round(from * fps), f1 = Math.round(to * fps), total = f1 - f0;
  const chunk = Math.max(1, +opt('chunk', '8')!);
  const workers = Math.max(1, Math.min(+opt('workers', '2')!, Math.ceil(total / chunk)));
  // reorder buffer: frames waiting for an earlier one or for the encoder, acknowledged while under ~1 GB in
  // memory; past that they go to a spool on disk (up to --spool-gb, default 20), so the renderers never wait
  // for x264 in the light scenes and x264 catches up in the heavy ones, where the CPU is free
  const frameBytes = OW * OH * 3;
  const cap = Math.max(4, Math.floor((+opt('mem-gb', '1')! * 1e9) / frameBytes));
  const spoolCap = Math.floor((+opt('spool-gb', '20')! * 1e9) / frameBytes);
  const spoolDir = path.join(tmpdir(), `kb-spool-${process.pid}`);
  mkdirSync(spoolDir, { recursive: true });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { ff.kill(9); rmSync(spoolDir, { recursive: true, force: true }); process.exit(130); });
  const spooled = new Set<number>();
  let spoolPeak = 0;
  const spoolFile = (n: number) => path.join(spoolDir, `${n}.rgb`);
  const toSpool = (n: number, buf: Uint8Array) => {
    // (written synchronously: the frame must be on disk before drain() looks for it)
    writeFileSync(spoolFile(n), buf);
    spooled.add(n);
    spoolPeak = Math.max(spoolPeak, spooled.size);
  };
  const waiting = new Map<number, Uint8Array>();
  let next = f0, written = 0, cursor = f0, ending = false;

  // any failure stops the render: frame POSTs are refused from then on, which makes every page's stream() throw
  let failure: Error | null = null, rejectFailed!: (e: Error) => void, resolveWritten!: () => void;
  const failed = new Promise<never>((_, rej) => { rejectFailed = rej; });
  failed.catch(() => {});
  const allWritten = new Promise<void>((res) => { resolveWritten = res; });
  const fail = (e: unknown) => {
    if (failure) return;
    failure = e instanceof Error ? e : new Error(String(e));
    console.error(`render failed: ${failure.message}`);
    rejectFailed(failure);
  };
  void ff.exited.then((code) => { if (!ending) fail(new Error(`ffmpeg exited early (code ${code})`)); });

  const t0 = performance.now();
  let draining = false;
  const drain = async () => {
    if (draining || failure) return;
    draining = true;
    try {
      while (!failure && (waiting.has(next) || spooled.has(next))) {
        let buf = waiting.get(next);
        if (buf) waiting.delete(next);
        else {
          buf = await Bun.file(spoolFile(next)).bytes();
          spooled.delete(next);
          rmSync(spoolFile(next));
        }
        ff.stdin.write(buf);
        await ff.stdin.flush();
        next++; written++;
        if (written % 60 === 0 || written === total) {
          const el = (performance.now() - t0) / 1000;
          process.stdout.write(`\r${written}/${total} frames  ${(written / el).toFixed(1)} fps  eta ${((total - written) / (written / el)).toFixed(0)}s   `);
        }
        if (written === total) resolveWritten();
      }
    } catch (e) { fail(e); } finally { draining = false; }
  };
  // Frames come in as HTTP POSTs (/frame?n=N, raw rgb24 body). (The upstream WebSocket hand-off stalled
  // here: no acknowledgement ever reached the page.) A POST is answered once its frame is in the reorder
  // buffer or the spool, so a page never runs more than a few frames ahead of the encoder.
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': '*' };
  const server = Bun.serve({
    port: 0,
    maxRequestBodySize: OW * OH * 3 + 1024,
    error(e) { console.error(`frame server error: ${e.message}`); return new Response(String(e), { status: 500, headers: cors }); },
    async fetch(req) {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (failure) return new Response(failure.message, { status: 500, headers: cors });
      try {
        const n = +(new URL(req.url).searchParams.get('n') ?? -1);
        const buf = new Uint8Array(await req.arrayBuffer());
        if (n < f0 || n >= f1) throw new Error(`frame ${n} is outside the range`);
        if (buf.length !== frameBytes) throw new Error(`got ${buf.length} bytes for frame ${n}`);
        if (n < next || waiting.has(n) || spooled.has(n)) return new Response('dup', { headers: cors }); // a retried frame
        while (!failure && n !== next && waiting.size >= cap && spooled.size >= spoolCap) await Bun.sleep(10);
        if (waiting.size < cap || n === next) waiting.set(n, buf);
        else toSpool(n, buf);
        void drain();
        return new Response('ok', { headers: cors });
      } catch (e) { fail(e); return new Response(String(e), { status: 500, headers: cors }); }
    },
  });
  // chunks in order from a shared cursor
  const take = () => { if (cursor >= f1) return null; const a = cursor; cursor = Math.min(f1, a + chunk); return [a, cursor] as const; };
  const vite = await ensureServer(server.port);
  const url = vite.url;
  const pages: Awaited<ReturnType<typeof openPage>>[] = [];
  const used: Record<string, number> = {};
  const closePages = async () => {
    for (const p of pages.splice(0)) {
      if (p.logs.length) console.error('BROWSER LOG:\n' + p.logs.slice(0, 40).join('\n'));
      await p.browser.close().catch(() => {});
    }
  };
  let ok = false;
  try {
    const opened = await Promise.allSettled(Array.from({ length: workers }, () => openPage(url)));
    for (const o of opened) if (o.status === 'fulfilled') pages.push(o.value);
    for (const o of opened) if (o.status === 'rejected') throw o.reason;
    const rendering = Promise.all(pages.map(async ({ page }) => {
      for (let r = take(); r && !failure; r = take()) {
        const h: Record<string, number> = await page.evaluate((o) => (window as any).__video.stream(o), {
          from: r[0] / fps, to: r[1] / fps, fps, ws: '/frame', samples: SAMPLES, shutter: +opt('shutter', '0.5')!, inflight: 4,
        });
        for (const [c, m] of Object.entries(h)) used[c] = (used[c] ?? 0) + m;
      }
    }));
    rendering.catch(() => {});
    // (a page error stops the render; a failure on this side stops waiting for the pages)
    await Promise.race([rendering, failed]).catch((e) => { fail(e); throw failure; });
    await Promise.race([allWritten, failed]);
    // every frame is in ffmpeg: close its input first (it needs nothing from the browsers), then the
    // browsers, whose close() has been seen to hang after a long render
    ending = true;
    await ff.stdin.flush();
    await ff.stdin.end();
    await Promise.race([closePages(), Bun.sleep(10000)]);
    const code = await ff.exited;
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    ok = true;
  } finally {
    ending = true;
    // (killed, ffmpeg leaves an unplayable file rather than a finished-looking truncated one)
    if (!ok) ff.kill(9);
    await Promise.race([closePages(), Bun.sleep(10000)]);
    server.stop(true);
    vite.stop();
    rmSync(spoolDir, { recursive: true, force: true });
  }
  console.log(`\nwrote ${out} (${written} frames in ${((performance.now() - t0) / 1000).toFixed(1)}s, ${workers} workers${spoolPeak ? `, up to ${spoolPeak} frames spooled to disk` : ''})`);
  console.log(`sub-frames per frame (count:frames): ${hist(used)}`);
}

const { url, stop } = await ensureServer();
if (mode === 'video') {
  try {
    // (the duration comes from the audio analysis, the same in every page)
    const { browser, page } = await openPage(url);
    const dur: number = await page.evaluate(() => (window as any).__video.duration);
    await browser.close();
    await video(+opt('from', '0')!, +opt('to', String(dur))!, +opt('fps', '60')!, path.resolve(opt('out', path.join(ROOT, `out/${ODIR}keybordy-mp-teaser.mp4`))!));
  } finally { stop(); }
  process.exit(0);
}
const { browser, page, logs } = await openPage(url);
try {
  if (mode === 'gpu') {
    console.log(await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2')!;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    }));
  } else if (mode === 'stills') {
    const times = (opt('t') ?? '0').split(',').map(Number);
    const files = await stills(page, times, opt('out', path.join(ROOT, `out/${ODIR}stills`))!);
    console.log(files.join('\n'));
  } else if (mode === 'sheet') {
    const from = +opt('from', '0')!, to = +opt('to', '10')!, n = +opt('n', '12')!;
    let times = Array.from({ length: n }, (_, i) => from + ((to - from) * i) / Math.max(1, n - 1));
    if (opt('times')) times = opt('times')!.split(',').map(Number);
    if (flag('cuts')) {
      // 4 frames around every timeline boundary: 2 frames before, 2 after
      const tl: { id: string; start: number }[] = await page.evaluate(() => (window as any).__video.timeline);
      times = tl.slice(1).flatMap((e) => [e.start - 0.1, e.start - 1 / 60, e.start + 1 / 60, e.start + 0.1]);
    }
    const out = opt('out', path.join(ROOT, `out/sheets/sheet_${from}-${to}.png`))!;
    await sheet(page, times, +opt('cols', '4')!, out);
    console.log(out);
  } else if (mode === 'perf') {
    const from = +opt('from', '0')!, to = +opt('to', '5')!;
    const r = await page.evaluate(async ({ from, to, samples, shutter }) => {
      const P = (window as any).__video;
      const ms: number[] = [];
      const buf = new Uint8Array(P.width * P.height * 4);
      P.still(from);
      const used: Record<number, number> = {};
      for (let t = from; t < to; t += 1 / 60) {
        const a = performance.now();
        const k = P.engine.render(t, 1 / 60, false, samples, shutter);
        used[k] = (used[k] ?? 0) + 1;
        await P.engine.readPixelsAsync(buf);
        ms.push(performance.now() - a);
      }
      ms.sort((a, b) => a - b);
      return { n: ms.length, avg: ms.reduce((a, b) => a + b, 0) / ms.length, p50: ms[ms.length >> 1], p95: ms[Math.floor(ms.length * 0.95)], max: ms[ms.length - 1], used };
    }, { from, to, samples: SAMPLES, shutter: +opt('shutter', '0.5')! });
    console.log(`frames ${r.n}  avg ${r.avg.toFixed(1)}ms  p50 ${r.p50.toFixed(1)}  p95 ${r.p95.toFixed(1)}  max ${r.max.toFixed(1)}  sub-frames ${hist(r.used)}`);
  }
  if (logs.length) console.error('BROWSER LOG:\n' + logs.slice(0, 40).join('\n'));
} finally {
  await browser.close();
  stop();
}
