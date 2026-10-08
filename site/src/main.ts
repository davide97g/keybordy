import './style.css';
import { Oled, type OledState } from '@model/oled';
import L from '@layout/macropad.json';
import { Stage, type ShotName } from './scene';
import { MAP, ACTIONS, TYPES, KEYBOARD } from './keymap';
import { clickSound, setSound, soundOn } from './sound';

/** Set once the trailer is on YouTube: the trailer buttons then link to it instead of the channel. */
const YT_TRAILER = '';
const CHANNEL_SUB = 'https://www.youtube.com/channel/UCp-6Cv5ksm2mY-xLJqvLVKw?sub_confirmation=1';

const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => [...r.querySelectorAll(s)] as T[];
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
const html = document.documentElement;

// ── title: one letter per beat, like the trailer ──────────────────────────
for (const el of $$('.type')) {
  const word = el.dataset.type ?? el.textContent ?? '';
  el.textContent = '';
  [...word].forEach((c, i) => { const s = document.createElement('span'); s.className = 'ch'; s.style.setProperty('--i', String(i)); s.textContent = c; el.append(s); });
}
for (const sel of ['.mini-keys i', '.wave-bars i']) $$(sel).forEach((el, i) => el.style.setProperty('--k', String(i)));

// ── the 3D stage ───────────────────────────────────────────────────────────
const canvas = $<HTMLCanvasElement>('#gl');
let stage: Stage | null = null;
const loader = $('#loader'), fill = $('#loader-fill'), pct = $('#loader-pct');
const setProgress = (f: number) => { const p = Math.round(clamp(f) * 100); fill.style.width = `${p}%`; pct.textContent = String(p); };

function booted() {
  loader.classList.add('is-done');
  html.classList.add('is-booted');
  $$('.type').forEach((el) => el.classList.add('is-in'));
  stage?.boot();
  setTimeout(() => { if (!interacted) toast(finePointer ? 'Try it: click a key, or type 1–6 and Q–Y. Hold space to talk.' : 'Tap a key on the device.'); }, 5200);
}

async function start() {
  try {
    await Promise.all(['900 20px "Anybody"', '600 10px "Martian Mono"', '400 10px "Martian Mono"', '700 10px "Martian Mono"'].map((f) => document.fonts.load(f)));
  } catch { /* fonts are a nicety */ }
  try {
    stage = new Stage(canvas);
    await stage.init(setProgress);
  } catch (e) {
    console.error(e);
    stage = null;
    html.classList.add('no-gl');
    canvas.remove();
    booted();
    return;
  }
  setProgress(1);
  if (import.meta.env.DEV) (window as unknown as { stage: Stage }).stage = stage;
  stage.onLayer = (i) => $$('#layers li').forEach((li, j) => li.classList.toggle('is-on', j === i || i >= 0 && reduced));
  stage.onKnob = (v) => { $('#knob-val').textContent = String(v); $('#knob-bar').style.width = `${v}%`; };
  stage.onPress = (id) => { if (soundOn()) clickSound(id === 'K21'); };
  addEventListener('resize', () => stage?.resize());
  setTimeout(booted, 250);
  requestAnimationFrame(loop);
}

// ── scroll: which shot, how far between two, and each chapter's own progress ─
const chapters = $$('[data-shot]');
const trailer = $('#trailer');
let sy = scrollY;
function scrollState() {
  if (!stage) return;
  sy = scrollY;
  const vh = innerHeight;
  const anchors = chapters.map((el, i) => {
    const r = el.getBoundingClientRect(), top = r.top + sy;
    if (i === 0) return 0;
    return top + r.height / 2 - vh / 2;
  });
  let i = 0;
  while (i < anchors.length - 1 && sy >= anchors[i + 1]!) i++;
  const a = anchors[i]!, b = anchors[i + 1] ?? a;
  const raw = b > a ? clamp((sy - a) / (b - a)) : 0;
  stage.from = chapters[i]!.dataset.shot as ShotName;
  stage.to = (chapters[i + 1] ?? chapters[i]!).dataset.shot as ShotName;
  stage.blend = clamp((raw - 0.18) / 0.64);
  for (const el of chapters) {
    const r = el.getBoundingClientRect();
    stage.local[el.dataset.shot as ShotName] = clamp((vh - r.top) / (r.height + vh));
  }
  const tTop = trailer.getBoundingClientRect().top;
  const on = tTop > 0;
  if (on !== stage.active) { stage.active = on; canvas.classList.toggle('is-hidden', !on); }
}

function loop() {
  scrollState();
  stage?.frame();
  requestAnimationFrame(loop);
}

// ── pointer and keyboard drive the device ───────────────────────────────────
let interacted = false;
const isUI = (t: EventTarget | null) => t instanceof Element && !!t.closest('a, button, input, .card, .final, dialog, .solid, .nav, .hero-copy');
addEventListener('pointermove', (e) => {
  if (!stage) return;
  stage.pointer.set((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1));
  if (finePointer && stage.active) {
    const id = isUI(e.target) ? null : stage.pick(e.clientX, e.clientY);
    document.body.style.cursor = id ? 'pointer' : '';
  }
}, { passive: true });
let held: string | null = null;
addEventListener('pointerdown', (e) => {
  if (!stage?.active || isUI(e.target) || e.button !== 0) return;
  const id = stage.pick(e.clientX, e.clientY);
  if (!id) return;
  held = id; interacted = true;
  stage.down(id, true);
});
const release = () => { if (held && stage) stage.up(held); held = null; };
addEventListener('pointerup', release);
addEventListener('pointercancel', release);

const keysDown = new Set<string>();
addEventListener('keydown', (e) => {
  if (!stage?.active || e.metaKey || e.ctrlKey || e.altKey || $<HTMLDialogElement>('#player').open) return;
  if (e.target instanceof HTMLElement && e.target.closest('input, textarea, button, a') && e.code === 'Space') return;
  const id = KEYBOARD[e.code];
  if (!id) return;
  if (e.code === 'Space') e.preventDefault();
  if (e.repeat || keysDown.has(e.code)) return;
  keysDown.add(e.code); interacted = true;
  stage.down(id, true);
});
addEventListener('keyup', (e) => {
  if (!keysDown.delete(e.code)) return;
  const id = KEYBOARD[e.code];
  if (id) stage?.up(id);
});
addEventListener('blur', () => { for (const c of keysDown) { const id = KEYBOARD[c]; if (id) stage?.up(id); } keysDown.clear(); release(); });

// ── reveals ────────────────────────────────────────────────────────────────
const io = new IntersectionObserver((es) => {
  for (const e of es) if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
}, { rootMargin: '0px 0px -10% 0px', threshold: 0.12 });
$$('.reveal, .reveal-slap').forEach((el) => io.observe(el));
// chapters toggle, so their label slaps in again on the way back
const cio = new IntersectionObserver((es) => { for (const e of es) e.target.classList.toggle('is-in', e.isIntersecting); }, { threshold: 0.3 });
$$('.chapter:not(.hero)').forEach((el) => cio.observe(el));

// count-ups
const nio = new IntersectionObserver((es) => {
  for (const e of es) {
    if (!e.isIntersecting) continue;
    nio.unobserve(e.target);
    const el = e.target as HTMLElement, n = Number(el.dataset.count), t0 = performance.now();
    const step = (now: number) => {
      const p = reduced ? 1 : clamp((now - t0) / 1300), v = Math.round(n * (1 - (1 - p) ** 4));
      el.textContent = v.toLocaleString('en-US');
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}, { threshold: 0.5 });
$$('[data-count]').forEach((el) => nio.observe(el));

// ── nav ────────────────────────────────────────────────────────────────────
const nav = $('#nav');
let lastY = scrollY;
addEventListener('scroll', () => {
  const y = scrollY;
  nav.classList.toggle('is-scrolled', y > 20);
  nav.classList.toggle('is-away', y > lastY + 4 && y > 700);
  if (y < lastY - 4) nav.classList.remove('is-away');
  lastY = y;
}, { passive: true });
const navLinks = $$<HTMLAnchorElement>('.nav-links a');
const sio = new IntersectionObserver((es) => {
  for (const e of es) if (e.isIntersecting) navLinks.forEach((a) => a.classList.toggle('is-active', a.hash === `#${e.target.id}`));
}, { rootMargin: '-45% 0px -50% 0px' });
['story', 'trailer', 'yours', 'build'].forEach((id) => sio.observe($(`#${id}`)));

// ── magnetic buttons and tilt cards ─────────────────────────────────────────
if (finePointer && !reduced) {
  for (const el of $$('.magnetic')) {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left - r.width / 2) * 0.22, y = (e.clientY - r.top - r.height / 2) * 0.32;
      el.style.transition = 'transform .15s ease-out';
      el.style.transform = `translate(${x}px, ${y}px)`;
    });
    el.addEventListener('pointerleave', () => { el.style.transition = 'transform .6s cubic-bezier(.2,1.45,.35,1)'; el.style.transform = ''; });
  }
  for (const el of $$('.tilt')) {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      el.style.setProperty('--mx', `${px * 100}%`); el.style.setProperty('--my', `${py * 100}%`);
      const k = el.classList.contains('trailer-card') ? 3 : 6;
      el.style.transition = 'transform .12s ease-out';
      el.style.transform = `perspective(1000px) rotateX(${(0.5 - py) * k}deg) rotateY(${(px - 0.5) * k}deg)`;
    });
    el.addEventListener('pointerleave', () => { el.style.transition = 'transform .7s cubic-bezier(.16,1,.3,1)'; el.style.transform = ''; });
  }
}
// keycap buttons press on the keyboard too
for (const el of $$('.btn')) {
  el.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') el.classList.add('is-down'); });
  el.addEventListener('keyup', () => el.classList.remove('is-down'));
  el.addEventListener('blur', () => el.classList.remove('is-down'));
}

// ── OLED panels drawn by the model's own OLED code ─────────────────────────
function panel(cv: HTMLCanvasElement) {
  const o = new Oled(), g = cv.getContext('2d')!;
  return (s: OledState) => { o.draw(s); g.drawImage(o.big, 0, 0, cv.width, cv.height); };
}
{
  // specs tile: logo, a key, a knob, listening, on a loop while it is on screen
  const draw = panel($<HTMLCanvasElement>('#oled-tile'));
  let vis = false, t0 = performance.now();
  new IntersectionObserver(([e]) => { vis = !!e?.isIntersecting; }).observe($('#oled-tile'));
  draw({ mode: 'logo' });
  const tick = () => {
    if (vis) {
      const t = ((performance.now() - t0) / 1000) % 9;
      if (t < 2) draw({ mode: 'logo' });
      else if (t < 3.6) draw({ mode: 'key', label: 'CLAUDE', detail: 'terminal › claude' });
      else if (t < 5.6) draw({ mode: 'knob', name: 'VOLUME', value: Math.round(42 + Math.sin((t - 3.6) * 1.6) * 30) });
      else if (t < 7.6) draw({ mode: 'listen', t });
      else draw({ mode: 'listen', t, transcript: 'open my notes' });
    }
    setTimeout(tick, 60);
  };
  tick();
}

// ── the 2D keymap: the real layout, top view ────────────────────────────────
const typeChips = new Map<string, HTMLElement>();
{
  const chips = $('#chips');
  for (const t of TYPES) {
    const c = document.createElement('span'); c.className = 'chip'; c.textContent = t.name; chips.append(c); typeChips.set(t.id, c);
  }
  const U = L.u_mm, W = 6 * U, H = 6.25 * U, box = $('#pad2d');
  box.style.aspectRatio = `${W} / ${H}`;
  const pc = (v: number, of: number) => `${(v / of) * 100}%`;
  const draw = panel($<HTMLCanvasElement>('#oled-pad'));
  const scr = $<HTMLCanvasElement>('#oled-pad');
  const o = L.oled, [ox, oy] = o.at as [number, number], [aw, ah] = o.active_mm as [number, number];
  const bw = aw + 5, bh = ah + 7;
  Object.assign(scr.style, { position: 'absolute', left: pc(ox - bw / 2, W), top: pc(oy - bh / 2, H), width: pc(bw, W), margin: '0', aspectRatio: `${bw} / ${bh}`, borderWidth: '4px' });
  box.append(scr);
  let auto = true, autoI = 0;
  const show = (id: string) => {
    const [label, type] = MAP[id]!;
    $$('.k2', box).forEach((k) => k.classList.toggle('is-on', k.dataset.id === id));
    for (const [tid, c] of typeChips) c.classList.toggle('is-on', tid === type);
    if (id === 'K21') draw({ mode: 'listen', t: performance.now() / 1000 });
    else draw({ mode: 'key', label, detail: ACTIONS[id]![1] });
  };
  for (const k of L.keys) {
    const b = document.createElement('button');
    b.className = `k2 ${(k as { role?: string }).role ?? ''}`;
    b.dataset.id = k.id;
    b.textContent = k.id;
    b.setAttribute('aria-label', `${k.id}: ${MAP[k.id]![0]}`);
    const g = 1.4;
    Object.assign(b.style, { left: pc(k.x * U + g / 2, W), top: pc(k.y * U + g / 2, H), width: pc(k.w * U - g, W), height: pc(k.h * U - g, H) });
    const on = () => { auto = false; show(k.id); if (soundOn()) clickSound(k.id === 'K21'); };
    b.addEventListener('pointerenter', () => { if (finePointer) on(); });
    b.addEventListener('focus', on);
    b.addEventListener('click', on);
    box.append(b);
  }
  // knobs: drag or scroll to turn
  const names: Record<string, string> = { E1: 'VOLUME', E2: 'SCROLL', E3: 'LIGHT' };
  const vals: Record<string, number> = { E1: 42, E2: 50, E3: 70 };
  for (const e of L.encoders) {
    const [ex, ey] = e.at as [number, number], d = L.encoder_part.knob_d_mm;
    const kn = document.createElement('div');
    kn.className = 'k2knob'; kn.tabIndex = 0; kn.setAttribute('role', 'slider');
    kn.setAttribute('aria-label', names[e.id]!); kn.setAttribute('aria-valuemin', '0'); kn.setAttribute('aria-valuemax', '100');
    Object.assign(kn.style, { left: pc(ex - d / 2, W), top: pc(ey - d / 2, H), width: pc(d, W) });
    const turn = (n: number) => {
      auto = false;
      vals[e.id] = clamp(vals[e.id]! + n * 2, 0, 100);
      kn.style.rotate = `${vals[e.id]! * 3.0}deg`;
      kn.setAttribute('aria-valuenow', String(vals[e.id]));
      draw({ mode: 'knob', name: names[e.id]!, value: vals[e.id]! });
      if (soundOn()) clickSound(false, true);
    };
    kn.style.rotate = `${vals[e.id]! * 3.0}deg`;
    kn.addEventListener('wheel', (ev) => { ev.preventDefault(); turn(ev.deltaY > 0 ? -1 : 1); }, { passive: false });
    kn.addEventListener('keydown', (ev) => { if (ev.key === 'ArrowUp' || ev.key === 'ArrowRight') turn(1); if (ev.key === 'ArrowDown' || ev.key === 'ArrowLeft') turn(-1); });
    let lastX = 0, dragging = false;
    kn.addEventListener('pointerdown', (ev) => { dragging = true; lastX = ev.clientX + ev.clientY * -1; kn.setPointerCapture(ev.pointerId); });
    kn.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const v = ev.clientX - ev.clientY, dv = v - lastX;
      if (Math.abs(dv) > 6) { turn(Math.sign(dv)); lastX = v; }
    });
    kn.addEventListener('pointerup', () => { dragging = false; });
    box.append(kn);
  }
  draw({ mode: 'logo' });
  // idle demo until somebody touches it
  let vis = false;
  new IntersectionObserver(([e]) => { vis = !!e?.isIntersecting; }).observe(box);
  const order = ['K1', 'K4', 'K8', 'K9', 'K16', 'K18', 'K21', 'K10'];
  setInterval(() => { if (auto && vis && !reduced) show(order[autoI++ % order.length]!); }, 1500);
  box.addEventListener('pointerleave', () => { auto = true; });
}

// marquee: the action names
{
  const words = [...new Set(Object.values(MAP).map(([l]) => l))];
  const track = $('#marquee');
  const one = words.flatMap((w) => [w, '·']);
  for (const w of [...one, ...one]) { const s = document.createElement('span'); s.textContent = w; if (w === '·') s.className = 'dot'; track.append(s); }
}

// ── trailer ────────────────────────────────────────────────────────────────
const loopV = $<HTMLVideoElement>('#trailer-loop');
new IntersectionObserver(([e]) => {
  if (e?.isIntersecting && !reduced) { loopV.preload = 'auto'; loopV.play().catch(() => {}); } else loopV.pause();
}, { threshold: 0.25 }).observe(loopV);

const player = $<HTMLDialogElement>('#player'), pv = $<HTMLVideoElement>('#player-video');
function openTrailer() {
  const vertical = innerWidth < innerHeight * 0.8;
  player.classList.toggle('is-vertical', vertical);
  pv.poster = vertical ? '/media/poster-vertical.jpg' : '/media/poster.jpg';
  pv.src = vertical ? '/media/trailer-vertical.mp4' : '/media/trailer.mp4';
  player.showModal();
  pv.play().catch(() => {});
  loopV.pause();
}
$$('[data-open-trailer]').forEach((b) => b.addEventListener('click', openTrailer));
$('#player-close').addEventListener('click', () => player.close());
player.addEventListener('click', (e) => { if (e.target === player) player.close(); });
player.addEventListener('close', () => { pv.pause(); pv.removeAttribute('src'); pv.load(); });
if (YT_TRAILER) {
  for (const a of $$<HTMLAnchorElement>('#yt-trailer, .player-bar a')) a.href = YT_TRAILER;
  $('#yt-trailer-label').textContent = 'Watch the full trailer on YouTube';
  $('.player-bar span').textContent = 'Also on YouTube.';
} else {
  for (const a of $$<HTMLAnchorElement>('#yt-trailer')) a.href = CHANNEL_SUB;
}

// ── sound toggle and toast ─────────────────────────────────────────────────
const soundBtn = $('#sound');
soundBtn.addEventListener('click', () => {
  const on = soundBtn.getAttribute('aria-pressed') !== 'true';
  soundBtn.setAttribute('aria-pressed', String(on));
  setSound(on);
  if (on) clickSound(false);
  toast(on ? 'Key sounds on.' : 'Key sounds off.');
});
let toastT = 0;
function toast(msg: string) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('is-on');
  clearTimeout(toastT);
  toastT = window.setTimeout(() => t.classList.remove('is-on'), 3600);
}

start();
