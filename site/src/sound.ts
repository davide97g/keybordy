// Key sounds, synthesized (no samples to license): a short filtered noise click on top of a low thock.
// Off until the visitor turns it on; the AudioContext is created on that click.
let ctx: AudioContext | null = null;
let on = false;

export const soundOn = () => on;
export function setSound(v: boolean) {
  on = v;
  if (v && !ctx) ctx = new AudioContext();
  if (v) ctx?.resume();
}

/** `big` for the 2u talk bar (deeper), `detent` for a knob tick. */
export function clickSound(big = false, detent = false) {
  if (!on || !ctx) return;
  const t = ctx.currentTime, out = ctx.createGain();
  out.gain.value = detent ? 0.12 : 0.32;
  out.connect(ctx.destination);
  // click: 25 ms of band-passed noise
  const n = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.03), ctx.sampleRate), d = n.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3;
  const src = ctx.createBufferSource(); src.buffer = n;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = detent ? 5200 : big ? 2200 : 3200; bp.Q.value = 1.4;
  src.connect(bp).connect(out); src.start(t);
  if (detent) return;
  // thock: a pitched-down sine
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.setValueAtTime(big ? 150 : 210, t); o.frequency.exponentialRampToValueAtTime(big ? 70 : 95, t + 0.06);
  g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  o.connect(g).connect(out); o.start(t); o.stop(t + 0.1);
}
