// The cue sheet (data/cues.json, written by audio/cues.py): scene windows and timed events shared with the
// mixer, so a press, its click and its cut land together. poseAt(t) turns the events into the macropad's
// state at any time, as a pure function, so every scene shows the same device state.
import { clamp, ease, smoothstep } from './engine/util';
import { VDIR, VERSION } from './version';
import { KEYMAP, type Pose } from './model/macropad';
import type { OledState } from './model/oled';

export interface Cue { t: number; kind: string; [k: string]: any }
export interface Cues {
  duration: number;
  period: number;
  beats: number[];
  scenes: { id: string; start: number; end: number }[];
  events: Cue[];
}

export let CUES: Cues;
export async function loadCues() {
  CUES = await (await fetch(`data/${VDIR}cues.json`)).json();
  return CUES;
}

export const events = (kind: string, pred: (c: Cue) => boolean = () => true) => CUES.events.filter((c) => c.kind === kind && pred(c));
export const first = (kind: string, pred?: (c: Cue) => boolean) => events(kind, pred)[0]!;
export const scene = (id: string) => CUES.scenes.find((s) => s.id === id)!;
/** Time of beat b of the soundtrack (fractional, extrapolated past the grid). */
export function beat(b: number) {
  const g = CUES.beats, i = Math.floor(b);
  if (i < 0) return g[0]! + b * CUES.period;
  if (i + 1 >= g.length) return g[g.length - 1]! + (b - (g.length - 1)) * CUES.period;
  return g[i]! + (g[i + 1]! - g[i]!) * (b - i);
}

/**
 * Key travel for a press whose bottom-out (the click) is at t0: 22 ms down, held, 45 ms back up with a
 * small overshoot like a spring-loaded stem.
 */
export function travel(t: number, t0: number, hold: number) {
  const down = 0.022, up = 0.045;
  if (t < t0 - down || t > t0 + hold + up + 0.06) return 0;
  if (t < t0) return ease.inQuad((t - (t0 - down)) / down);
  if (t < t0 + hold) return 1;
  const u = (t - t0 - hold) / up;
  if (u < 1) return 1 - ease.outCubic(u);
  return -0.04 * Math.sin(clamp((u - 1) * up / 0.06) * Math.PI);
}

export function poseAt(t: number): Pose {
  const press: Record<string, number> = {};
  let lastKey: Cue | null = null;
  for (const c of events('press')) {
    const v = travel(t, c.t, c.hold);
    if (v !== 0) press[c.key] = (press[c.key] ?? 0) + v;
    if (c.t <= t && c.key !== 'K21') lastKey = c;
  }
  // knob: each detent snaps in over 35 ms
  const knob: Record<string, number> = {};
  for (const c of events('detent')) knob[c.knob] = (knob[c.knob] ?? 0) + smoothstep(c.t - 0.035, c.t, t);
  // screen: off until it boots, then the logo, the last key's action, the voice prompt
  const boot = first('oled_boot'), listen = first('listen');
  let oled: OledState = { mode: 'off' };
  if (t >= boot.t) oled = t < boot.t + boot.dur ? { mode: 'boot', p: (t - boot.t) / boot.dur } : { mode: 'logo' };
  if (lastKey && t - lastKey.t < 1.2 && t >= boot.t + boot.dur) oled = { mode: 'key', label: KEYMAP[lastKey.key]![0], detail: KEYMAP[lastKey.key]![1] };
  const lastDet = events('detent').filter((c) => c.t <= t).pop();
  if (lastDet && t - lastDet.t < 1.0 && t >= boot.t + boot.dur) oled = { mode: 'knob', name: 'E1 VOLUME', value: 42 + 4 * lastDet.n };
  let mic = 0;
  if (t >= listen.t && t < listen.t + listen.dur) { oled = { mode: 'listen', t: t - listen.t }; mic = smoothstep(listen.t, listen.t + 0.06, t); }
  else if (t >= listen.t + listen.dur && t < listen.t + listen.dur + 1.4) { oled = { mode: 'listen', t: 0, transcript: 'open my notes' }; mic = 1 - smoothstep(listen.t + listen.dur, listen.t + listen.dur + 0.15, t); }
  // v2: the caps never move (a press shows as a sticker burst round the key, see scenes/v2/_fx.ts)
  return { press: VERSION >= 2 ? {} : press, knob, oled, mic, oledGain: t < boot.t ? 0 : 1.7 };
}
