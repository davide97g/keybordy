// Entry: preview player (default) or export mode (?export=1, driven by scripts/render.ts).
// Vendored from pdoom-video (MIT); the lyric readout is gone and the soundtrack is build/mix_stereo.wav.
import { Engine, type AdaptiveSampling } from './engine/engine';
import { PW, PH, SCALE, VERTICAL } from './engine/gl';
import { makeTimeline } from './timeline';
import { loadCues } from './cues';
import { VDIR } from './version';

const params = new URLSearchParams(location.search);
const EXPORT = params.has('export');
const ONLY = params.get('only'); // comma-separated scene ids to load (faster stills)
const FROM = params.get('t') ? parseFloat(params.get('t')!) : null;

const canvas = document.getElementById('c') as HTMLCanvasElement;
// physical size: 1920x1080 (1080x1920 upright) times ?scale= (the page CSS keeps showing it at the logical size)
canvas.width = PW;
canvas.height = PH;
if (VERTICAL) document.body.classList.add('vertical');

const engine = new Engine(canvas, makeTimeline);

declare global {
  interface Window { __video: any }
}

let TIMELINE: typeof engine.timeline = [];

async function boot() {
  await loadCues();
  const onlySet = ONLY ? new Set(ONLY.split(',')) : null;
  await engine.init(onlySet ? (e) => onlySet.has(e.id) : undefined);
  TIMELINE = engine.timeline;
  if (EXPORT) setupExport();
  else setupPlayer();
}

// ------------------------------------------------------------------ export API
/** The last frame stream() rendered (a range starting right after it needs no warm-up). */
let lastStreamed = -2;

/**
 * Hands frames to the encoder (scripts/render.ts) as HTTP POSTs, at most `inflight` unanswered at once:
 * the encoder answers once a frame is buffered, which is the backpressure.
 */
function sender(url: string, inflight: number) {
  const pending = new Set<Promise<void>>();
  let failed: Error | null = null;
  return {
    async send(n: number, rgb: Uint8Array) {
      while (pending.size >= inflight) await Promise.race(pending);
      if (failed) throw failed;
      // (Vite's proxy now and then answers 502 when it reuses a connection the encoder had closed: the
      // frame is sent again; the encoder ignores a frame it already has)
      const body = rgb.slice();
      const post = async () => {
        for (let attempt = 0; ; attempt++) {
          const r = await fetch(`${url}?n=${n}`, { method: 'POST', body });
          if (r.ok) return;
          if (r.status !== 502 || attempt >= 4) throw new Error(`encoder refused frame ${n} (${r.status}): ${await r.text()}`);
          await new Promise((res) => setTimeout(res, 50 * (attempt + 1)));
        }
      };
      const p: Promise<void> = post().catch((e) => { failed = e; }).finally(() => pending.delete(p));
      pending.add(p);
    },
    async flush() { await Promise.all(pending); if (failed) throw failed; },
  };
}

function setupExport() {
  document.body.classList.add('export');
  window.__video = {
    engine,
    duration: engine.duration,
    errors: engine.errors,
    /** Output size in px (1920x1080 times scale); stream() sends frames of width*height*3 bytes (rgb24). */
    scale: SCALE,
    vertical: VERTICAL,
    width: PW,
    height: PH,
    timeline: TIMELINE.map(({ id, start, end }) => ({ id, start, end })),
    /** Render a single frame at t (seeks as needed). */
    still(t: number, samples: number | AdaptiveSampling = 1, shutter = 0.5) { return engine.render(t, 1 / 60, true, samples, shutter); },
    /** The last rendered frame as a full-resolution (PW x PH) PNG, base64 (for stills at scale > 1). */
    async png() {
      const px = await engine.readPixelsAsync(), row = PW * 4;
      const img = new ImageData(PW, PH);
      for (let y = 0; y < PH; y++) img.data.set(px.subarray((PH - 1 - y) * row, (PH - y) * row), y * row); // bottom-up -> top-down
      const oc = new OffscreenCanvas(PW, PH);
      oc.getContext('2d')!.putImageData(img, 0, 0);
      const b = new Uint8Array(await (await oc.convertToBlob({ type: 'image/png' })).arrayBuffer());
      let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return btoa(s);
    },
    /**
     * Render [from, to) at fps and POST raw rgb24 frames (bottom-up) to the encoder at `ws` (an http URL;
     * the name is upstream's), at most `inflight` unanswered. Returns a histogram of sub-frames per frame.
     * A range that goes on where the last one ended skips the warm-up.
     */
    async stream(opts: { from: number; to: number; fps: number; ws: string; samples?: number | AdaptiveSampling; shutter?: number; inflight?: number }) {
      const snd = sender(opts.ws, opts.inflight ?? 4);
      const dt = 1 / opts.fps;
      const n0 = Math.round(opts.from * opts.fps), n1 = Math.round(opts.to * opts.fps);
      const S = opts.samples ?? 1, SH = opts.shutter ?? 0.5;
      // warm-up: render one frame before the range so the first frame is sequential for stateful scenes
      if (n0 > 0 && lastStreamed !== n0 - 1) engine.render((n0 - 1) * dt, dt, false, typeof S === 'number' ? S : 1, SH);
      const used: Record<number, number> = {}; // sub-frames per frame -> frames
      const rgba = new Uint8Array(PW * PH * 4), rgb = new Uint8Array(PW * PH * 3);
      for (let n = n0; n < n1; n++) {
        const k = engine.render(n * dt, dt, false, S, SH);
        used[k] = (used[k] ?? 0) + 1;
        await engine.readPixelsAsync(rgba);
        for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]!; rgb[j + 1] = rgba[i + 1]!; rgb[j + 2] = rgba[i + 2]!; }
        await snd.send(n, rgb);
      }
      await snd.flush();
      lastStreamed = n1 - 1;
      return used;
    },
  };
  window.__video.ready = true;
}

// ------------------------------------------------------------------ preview player
function setupPlayer() {
  const audio = new Audio(`audio/${VDIR}mix_stereo.wav`);
  audio.preload = 'auto';
  const ui = document.getElementById('ui')!;
  const scrub = document.getElementById('scrub') as HTMLInputElement;
  const info = document.getElementById('info')!;
  const marks = document.getElementById('marks')!;
  const errs = document.getElementById('errs')!;
  scrub.max = String(engine.duration);
  scrub.step = '0.001';
  if (engine.errors.length) { errs.textContent = engine.errors.join('\n\n'); errs.style.display = 'block'; }

  for (const e of TIMELINE) {
    const m = document.createElement('div');
    m.className = 'mark';
    m.style.left = `${(e.start / engine.duration) * 100}%`;
    m.style.width = `${((e.end - e.start) / engine.duration) * 100}%`;
    m.title = `${e.id} ${e.start.toFixed(2)}–${e.end.toFixed(2)}`;
    m.textContent = e.id;
    m.onclick = () => seek(e.start);
    marks.appendChild(m);
  }

  let t = FROM ?? 0;
  let playing = false;
  let loop: [number, number] | null = null;
  let lastAudioT = 0, lastPerf = 0;
  const seek = (x: number) => { t = Math.max(0, Math.min(engine.duration - 0.001, x)); audio.currentTime = t; };
  seek(t);

  const toggle = () => { playing = !playing; if (playing) { audio.currentTime = t; audio.play(); } else audio.pause(); };
  canvas.onclick = toggle;
  scrub.oninput = () => seek(parseFloat(scrub.value));
  window.addEventListener('keydown', (ev) => {
    if (ev.key === ' ') { ev.preventDefault(); toggle(); }
    if (ev.key === 'ArrowRight') seek(t + (ev.shiftKey ? 5 : 1));
    if (ev.key === 'ArrowLeft') seek(t - (ev.shiftKey ? 5 : 1));
    if (ev.key === '.') seek(t + 1 / 60);
    if (ev.key === ',') seek(t - 1 / 60);
    if (ev.key === 'l') {
      const e = TIMELINE.find((x) => t >= x.start && t < x.end);
      loop = loop ? null : e ? [e.start, e.end] : null;
    }
    if (ev.key === 'h') ui.classList.toggle('hidden');
    if (ev.key === ']') { const e = TIMELINE.find((x) => x.start > t + 0.01); if (e) seek(e.start); }
    if (ev.key === '[') { const es = TIMELINE.filter((x) => x.start < t - 0.3); const e = es[es.length - 1]; if (e) seek(e.start); }
  });

  let frames = 0, fpsT = performance.now(), fps = 0;
  const tick = () => {
    if (playing) {
      // smooth the coarse audio clock with performance.now()
      const now = performance.now();
      if (audio.currentTime !== lastAudioT) { lastAudioT = audio.currentTime; lastPerf = now; }
      t = lastAudioT + (audio.paused ? 0 : (now - lastPerf) / 1000);
      if (loop && t >= loop[1]) seek(loop[0]);
      if (audio.ended) playing = false;
    }
    engine.render(t, 1 / 60);
    scrub.value = String(t);
    frames++;
    const now = performance.now();
    if (now - fpsT > 500) { fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now; }
    const e = TIMELINE.find((x) => t >= x.start && t < x.end);
    info.textContent = `${t.toFixed(2)}s  frame ${Math.round(t * 60)}  beat ${engine.audio.beatAt(t).toFixed(2)}  bar ${engine.audio.barAt(t).toFixed(2)}  [${e?.id ?? '—'}]  ${fps.toFixed(0)}fps${loop ? '  LOOP' : ''}`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // Vite HMR: re-instantiate scenes whose module changed
  if (import.meta.hot) {
    import.meta.hot.on('vite:afterUpdate', (payload: any) => {
      for (const u of payload.updates ?? []) {
        const m = /scenes\/([\w-]+)\.ts/.exec(u.path ?? '');
        if (m) for (const e of TIMELINE) if (e.id === m[1] || (e as any).file === m[1]) engine.reload(e.id);
      }
    });
  }
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f55;position:fixed;top:0;left:0">${String(e?.stack ?? e)}</pre>`);
  window.__video = { error: String(e?.stack ?? e) };
});
