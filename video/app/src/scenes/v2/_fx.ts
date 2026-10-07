// v2 graphics: a click is a lime die-cut sticker slapped round the key (with the key's action on a tag),
// and the text slams are lime vinyl labels. Pure functions of time.
import { clamp, ease, smoothstep } from '../../engine/util';
import { setFont } from '../_type';
import { slap } from './_logo';

export const LIME = '#d6ff1f', LIME_DEEP = '#8fb300', INK = '#0c0b0e', VINYL = '#f4f1f8';

/**
 * A sticker burst round a click: a rounded-square lime ring with a white vinyl edge slaps on (sticker.css
 * timing), sparks fly out for 140 ms, it stays while the key is held, then peels away. `s` is the key's
 * width on screen (px), `lt` the time since the click.
 */
export function clickBurst(c: CanvasRenderingContext2D, cx: number, cy: number, s: number, lt: number, hold: number, tag?: string, wide = 1) {
  const stay = Math.max(0.34, hold + 0.12), out = 0.2;
  if (lt < 0 || lt > stay + out) return false;
  const sl = slap(lt, 0.3);
  const peel = smoothstep(stay, stay + out, lt);
  const w = s * 1.32 * wide, h = s * 1.32, r = s * 0.26;
  c.save();
  c.translate(cx, cy);
  c.globalAlpha = sl.alpha * (1 - peel);
  // sparks
  if (lt < 0.16) {
    const k = ease.outCubic(lt / 0.16);
    c.strokeStyle = LIME; c.lineCap = 'round'; c.lineWidth = Math.max(3, s * 0.05) * (1 - k * 0.6);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.3, r0 = (w / 2) * (0.95 + 0.35 * k), r1 = r0 + s * 0.28 * (1 - k * 0.5);
      c.beginPath(); c.moveTo(Math.cos(a) * r0 * (wide > 1 ? 1.3 : 1), Math.sin(a) * r0 * 0.85); c.lineTo(Math.cos(a) * r1 * (wide > 1 ? 1.3 : 1), Math.sin(a) * r1 * 0.85); c.stroke();
    }
  }
  c.rotate(sl.rot * 0.35 - 0.06 + peel * 0.25);
  const sc = sl.scale * (1 + 0.06 * peel);
  c.scale(sc, sc);
  // die-cut ring: dark shadow, white vinyl, lime
  c.shadowColor = 'rgba(0,0,0,0.55)'; c.shadowBlur = s * 0.12; c.shadowOffsetY = s * 0.05;
  c.lineJoin = 'round';
  c.strokeStyle = VINYL; c.lineWidth = s * 0.2;
  c.beginPath(); c.roundRect(-w / 2, -h / 2, w, h, r); c.stroke();
  c.shadowColor = 'transparent';
  c.strokeStyle = LIME; c.lineWidth = s * 0.12;
  c.beginPath(); c.roundRect(-w / 2, -h / 2, w, h, r); c.stroke();
  // the tag: the key's action on a lime label at the top-right corner
  if (tag) {
    const fs = Math.min(34, Math.max(18, s * 0.26));
    setFont(c, 'Anybody', fs, 900, 125, 0);
    const tw = c.measureText(tag).width + fs * 0.9, th = fs * 1.45;
    c.save();
    c.translate(w / 2 - tw * 0.25, -h / 2 - th * 0.15);
    c.rotate(0.12 - 0.1 * (1 - clamp(lt / 0.2)));
    c.fillStyle = VINYL; c.beginPath(); c.roundRect(-tw / 2 - fs * 0.14, -th / 2 - fs * 0.14, tw + fs * 0.28, th + fs * 0.28, fs * 0.3); c.fill();
    c.fillStyle = LIME_DEEP; c.beginPath(); c.roundRect(-tw / 2, -th / 2 + fs * 0.1, tw, th, fs * 0.22); c.fill();
    c.fillStyle = LIME; c.beginPath(); c.roundRect(-tw / 2, -th / 2, tw, th, fs * 0.22); c.fill();
    c.fillStyle = INK; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(tag, 0, fs * 0.04);
    c.restore();
  }
  c.restore();
  return true;
}

/** A text slam as a lime vinyl label: slaps on at t0 like the logo sticker, peels off at the end. */
export function stickerSlam(c: CanvasRenderingContext2D, text: string, x: number, y: number, t: number, t0: number, dur: number,
  o: { size?: number; tilt?: number; align?: 'center' | 'left'; maxW?: number } = {}) {
  const lt = t - t0;
  if (lt < 0 || lt > dur) return false;
  let size = o.size ?? 104;
  const sl = slap(lt, 0.34);
  const peel = smoothstep(dur - 0.16, dur, lt);
  setFont(c, 'Anybody', size, 900, 125, -2);
  // (maxW: the label, vinyl edge included, shrinks to fit)
  if (o.maxW) {
    const full = c.measureText(text).width + size * 1.02;
    if (full > o.maxW) { size *= o.maxW / full; setFont(c, 'Anybody', size, 900, 125, -2); }
  }
  const tw = c.measureText(text).width, padX = size * 0.42, padY = size * 0.26, h = size + padY * 2, w = tw + padX * 2;
  c.save();
  c.globalAlpha = sl.alpha * (1 - peel);
  c.translate(o.align === 'left' ? x + w / 2 : x, y + sl.dy * h - peel * size * 0.4);
  c.rotate((o.tilt ?? -3) * Math.PI / 180 + (sl.rot + 6 * Math.PI / 180) * 0.4 + peel * 0.18);
  c.scale(sl.scale, sl.scale);
  const r = size * 0.24, e = size * 0.09;
  c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = size * 0.25; c.shadowOffsetY = size * 0.08;
  c.fillStyle = VINYL; c.beginPath(); c.roundRect(-w / 2 - e, -h / 2 - e, w + 2 * e, h + 2 * e, r + e); c.fill();
  c.shadowColor = 'transparent';
  c.fillStyle = LIME_DEEP; c.beginPath(); c.roundRect(-w / 2, -h / 2 + size * 0.08, w, h, r); c.fill();
  c.fillStyle = LIME; c.beginPath(); c.roundRect(-w / 2, -h / 2, w, h - size * 0.04, r); c.fill();
  // the lifted corner
  c.fillStyle = 'rgba(0,0,0,0.22)';
  c.beginPath(); c.moveTo(w / 2 + e, h / 2 - size * 0.42); c.lineTo(w / 2 - size * 0.42, h / 2 + e); c.lineTo(w / 2 - size * 0.46, h / 2 - size * 0.46); c.fill();
  c.fillStyle = '#d9d4e2';
  c.beginPath(); c.moveTo(w / 2 + e, h / 2 - size * 0.42); c.lineTo(w / 2 - size * 0.42, h / 2 + e); c.lineTo(w / 2 - size * 0.3, h / 2 - size * 0.3); c.fill();
  c.fillStyle = INK; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(text, 0, size * 0.03);
  c.restore();
  return true;
}
