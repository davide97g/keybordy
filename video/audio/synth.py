"""Synthesized sound design for the teaser: sub booms, braams, risers, whooshes, impacts, knob detents,
the OLED chirp, the sticker slap, a fallback switch click, and a synthetic reverb.

Every generator is seeded and returns float32 stereo (n, 2) at SR. Nothing here reads files.
"""
from __future__ import annotations

import numpy as np
from scipy import signal

SR = 48000


def _t(dur: float) -> np.ndarray:
    return np.arange(int(dur * SR)) / SR


def _rng(seed: int) -> np.random.Generator:
    return np.random.default_rng(seed)


def stereo(x: np.ndarray, pan: float = 0.0) -> np.ndarray:
    """Constant-power pan, -1 left .. +1 right."""
    a = (pan + 1) * np.pi / 4
    return np.stack([x * np.cos(a), x * np.sin(a)], axis=1).astype(np.float32)


def wide(x_l: np.ndarray, x_r: np.ndarray) -> np.ndarray:
    return np.stack([x_l, x_r], axis=1).astype(np.float32)


def lp(x: np.ndarray, hz: float, order: int = 2) -> np.ndarray:
    return signal.sosfilt(signal.butter(order, min(hz, SR * 0.45), "low", fs=SR, output="sos"), x, axis=0)


def hp(x: np.ndarray, hz: float, order: int = 2) -> np.ndarray:
    return signal.sosfilt(signal.butter(order, hz, "high", fs=SR, output="sos"), x, axis=0)


def bp(x: np.ndarray, lo: float, hi: float, order: int = 2) -> np.ndarray:
    return signal.sosfilt(signal.butter(order, [lo, min(hi, SR * 0.45)], "band", fs=SR, output="sos"), x, axis=0)


def sweep_lp(x: np.ndarray, f0: float, f1: float, q: float = 0.7, blocks: int = 256) -> np.ndarray:
    """Low-pass whose cutoff moves exponentially from f0 to f1 (block-wise state-variable filter)."""
    n = len(x)
    out = np.zeros_like(x)
    low = band = 0.0
    fc = f0 * (f1 / f0) ** (np.arange(n) / max(1, n - 1))
    for i0 in range(0, n, blocks):
        f = 2 * np.sin(np.pi * min(fc[i0], SR * 0.2) / SR)
        for i in range(i0, min(n, i0 + blocks)):
            high = x[i] - low - q * band
            band += f * high
            low += f * band
            out[i] = low
    return out


def saw(freq: np.ndarray | float, dur: float, phase: float = 0.0) -> np.ndarray:
    f = np.broadcast_to(np.asarray(freq, dtype=np.float64), (int(dur * SR),))
    ph = (np.cumsum(f) / SR + phase) % 1.0
    return 2 * ph - 1


def env_adsr(n: int, a: float, d: float, s: float, r: float) -> np.ndarray:
    e = np.full(n, s, dtype=np.float64)
    na, nd, nr = int(a * SR), int(d * SR), int(r * SR)
    e[:na] = np.linspace(0, 1, na, endpoint=False) if na else e[:na]
    e[na:na + nd] = np.linspace(1, s, nd, endpoint=False)[: max(0, min(nd, n - na))]
    if nr:
        e[-nr:] *= np.linspace(1, 0, nr) ** 2
    return e


def sat(x: np.ndarray, drive: float = 1.0) -> np.ndarray:
    return np.tanh(x * drive) / np.tanh(drive)


# ── hits ──────────────────────────────────────────────────────────────────────

def sub_boom(dur: float = 3.0, f0: float = 62.0, f1: float = 28.0, seed: int = 1) -> np.ndarray:
    t = _t(dur)
    f = f1 + (f0 - f1) * np.exp(-t * 7)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t * 1.25)
    click = hp(_rng(seed).standard_normal(len(t)) * np.exp(-t * 90), 900) * 0.25
    x = sat(body * 1.3 + click, 1.6) * 0.9
    return stereo(x)


def impact(dur: float = 4.0, seed: int = 2, crack: float = 0.5) -> np.ndarray:
    """Cinematic hit: sub drop, a noise crack, a metallic ring, all with a long dark tail."""
    t = _t(dur)
    r = _rng(seed)
    sub = sub_boom(dur, 75, 30, seed)[:, 0]
    nz = r.standard_normal((len(t), 2))
    cr = hp(nz * np.exp(-t * 28)[:, None], 1800) * crack
    body = lp(nz * np.exp(-t * 6)[:, None], 900) * 0.6
    ring = sum(np.sin(2 * np.pi * f * t + r.uniform(0, 6)) * np.exp(-t * d) * a
               for f, d, a in [(311, 2.2, 0.08), (467, 2.8, 0.06), (823, 3.6, 0.04), (1231, 4.5, 0.03)])
    x = sub[:, None] + cr + body + ring[:, None]
    return sat(x, 1.2).astype(np.float32) * 0.9


def braam(dur: float = 4.0, f0: float = 55.0, seed: int = 3) -> np.ndarray:
    """The trailer horn: detuned saw stack, filter opening then closing, with grit."""
    t = _t(dur)
    r = _rng(seed)
    vib = 1 + 0.003 * np.sin(2 * np.pi * 5.1 * t)
    ls, rs = np.zeros(len(t)), np.zeros(len(t))
    for i, (mult, a) in enumerate([(1, 1.0), (1, 1.0), (2, 0.45), (2, 0.45), (1.5, 0.25), (0.5, 0.7), (3, 0.15)]):
        det = 1 + r.uniform(-0.009, 0.009)
        v = saw(f0 * mult * det * vib, dur, r.uniform()) * a
        if i % 2:
            rs += v
        else:
            ls += v
        ls += v * 0.3
        rs += v * 0.3
    env = env_adsr(len(t), 0.06, 0.6, 0.75, 1.6)
    ls = sweep_lp(ls * env, 180, 2600, 0.55)
    rs = sweep_lp(rs * env, 190, 2500, 0.55)
    close = np.exp(-np.maximum(0, t - 0.6) * 0.9)
    ls, rs = ls * close, rs * close
    x = wide(sat(ls * 0.35, 2.2), sat(rs * 0.35, 2.2))
    return (x * 0.8).astype(np.float32)


def riser(dur: float = 4.0, seed: int = 4) -> np.ndarray:
    t = _t(dur)
    r = _rng(seed)
    p = t / dur
    nz = r.standard_normal((len(t), 2))
    # band of noise climbing from ~300 Hz to ~8 kHz: difference of two rising low-passes
    out = np.stack([sweep_lp(nz[:, c], 420, 9000, 0.8) - sweep_lp(nz[:, c], 160, 3400, 0.9) * 0.8 for c in range(2)], 1)
    tone = np.sin(2 * np.pi * np.cumsum(110 * 2 ** (3 * p)) / SR) * 0.25
    shep = sum(np.sin(2 * np.pi * np.cumsum(55 * 2 ** (k + 2 * p)) / SR) * np.sin(np.pi * ((k + 2 * p) / 6)) ** 2 for k in range(6)) * 0.08
    x = out * 0.9 + (tone + shep)[:, None]
    x *= (p ** 2.2)[:, None]
    x[-int(0.02 * SR):] *= np.linspace(1, 0, int(0.02 * SR))[:, None]
    return (x * 0.7).astype(np.float32)


def whoosh(dur: float = 1.2, seed: int = 5, pan_from: float = -0.8, pan_to: float = 0.8) -> np.ndarray:
    t = _t(dur)
    r = _rng(seed)
    p = t / dur
    nz = r.standard_normal(len(t))
    shape = np.sin(np.pi * p) ** 2.5
    x = sweep_lp(nz, 400, 5200, 0.9) * 0.6 + sweep_lp(nz, 120, 1200, 1.2) * 0.4
    pan = pan_from + (pan_to - pan_from) * p
    a = (pan + 1) * np.pi / 4
    x = x * shape
    return np.stack([x * np.cos(a), x * np.sin(a)], 1).astype(np.float32) * 0.8


def reverse_swell(dur: float = 1.5, seed: int = 6) -> np.ndarray:
    """A reversed reverb-like swell that ends sharply: lands into a cut."""
    x = impact(dur, seed, crack=0.2)
    x = reverb(x, 2.2, 0.0, wet=1.0, seed=seed)[: len(x)]
    x = x[::-1].copy()
    x *= np.linspace(0, 1, len(x))[:, None] ** 2
    return x.astype(np.float32) * 0.6


# ── small sounds ──────────────────────────────────────────────────────────────

def detent(seed: int = 7, pitch: float = 1.0) -> np.ndarray:
    """One encoder detent: a tiny metallic tick with a plastic knock."""
    dur = 0.06
    t = _t(dur)
    r = _rng(seed)
    nz = r.standard_normal(len(t))
    tick = hp(nz * np.exp(-t * 900), 3500) * 0.6
    ping = np.sin(2 * np.pi * 3100 * pitch * t) * np.exp(-t * 260) * 0.35 + np.sin(2 * np.pi * 5200 * pitch * t) * np.exp(-t * 400) * 0.18
    knock = lp(nz * np.exp(-t * 200), 1500) * 0.25
    return stereo(tick + ping + knock)


def chirp(seed: int = 8) -> np.ndarray:
    """OLED wake: two clean blips, the second higher."""
    out = []
    for f, d in [(1760, 0.055), (2637, 0.09)]:
        t = _t(d)
        e = np.minimum(1, t / 0.003) * np.exp(-t * 28)
        out.append(np.sin(2 * np.pi * f * t) * e * 0.5 + np.sin(2 * np.pi * f * 2 * t) * e * 0.12)
        out.append(np.zeros(int(0.025 * SR)))
    return stereo(np.concatenate(out))


def sticker_slap(seed: int = 9) -> np.ndarray:
    dur = 0.6
    t = _t(dur)
    r = _rng(seed)
    nz = r.standard_normal(len(t))
    slap = lp(nz * np.exp(-t * 55), 3800) * 0.9
    thump = np.sin(2 * np.pi * 115 * t) * np.exp(-t * 30) * 0.8
    rustle = bp(r.standard_normal(len(t)), 2500, 9000) * np.exp(-((t - 0.08) / 0.07) ** 2) * 0.12
    return stereo(sat(slap + thump + rustle, 1.4))


def switch_click(seed: int = 10, up: bool = False, thock: float = 1.0) -> np.ndarray:
    """Fallback MX click when no recording is available: bottom-out clack (or the lighter upstroke)."""
    dur = 0.12
    t = _t(dur)
    r = _rng(seed)
    nz = r.standard_normal(len(t))
    tr = nz * np.exp(-t * (1400 if up else 900))
    modes = [(1150, 60), (2450, 90), (4700, 140), (380 * thock, 45)]
    body = sum(np.sin(2 * np.pi * f * (1 + r.uniform(-0.04, 0.04)) * t + r.uniform(0, 6)) * np.exp(-t * d) * (0.5 if f < 500 else 0.25)
               for f, d in modes)
    x = hp(tr, 700) * 0.7 + body * (0.35 if up else 1.0) * np.minimum(1, t / 0.0008)
    return stereo(sat(x * (0.55 if up else 1.0), 1.3) * 0.7)


def drone(dur: float, f0: float = 41.2, seed: int = 11) -> np.ndarray:
    """Low dark pad for the cold open."""
    t = _t(dur)
    r = _rng(seed)
    x = sum(np.sin(2 * np.pi * f0 * m * t + r.uniform(0, 6)) * a for m, a in [(1, 0.5), (1.5, 0.15), (2, 0.2), (3.01, 0.05)])
    nz = lp(r.standard_normal((len(t), 2)), 600) * 0.05
    e = np.minimum(1, t / (dur * 0.6)) * np.minimum(1, (dur - t) / 0.3)
    return ((x[:, None] + nz) * e[:, None] * 0.5).astype(np.float32)


# ── space ─────────────────────────────────────────────────────────────────────

def reverb(x: np.ndarray, seconds: float = 2.4, predelay: float = 0.012, wet: float = 0.3, seed: int = 12, damp: float = 3500) -> np.ndarray:
    """Convolution with a synthetic stereo IR (decorrelated decaying noise, darker as it decays)."""
    r = _rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = r.standard_normal((n, 2)) * np.exp(-t * 6.9 / seconds)[:, None]
    ir = lp(ir, damp, 1) * 0.6 + lp(ir, damp * 0.3, 1) * 0.4
    ir[: int(predelay * SR)] = 0
    ir /= np.sqrt((ir ** 2).sum(0)) + 1e-9
    y = np.stack([signal.fftconvolve(x[:, c], ir[:, c]) for c in range(2)], 1)
    out = np.zeros_like(y)
    out[: len(x)] += x * (1 - wet)
    out += y * wet * 2.2
    return out.astype(np.float32)


def burst(seed: int = 13) -> np.ndarray:
    """v3 click burst: a tight crack, a low pop and a short glittery tail (the shards)."""
    dur = 0.7
    t = _t(dur)
    r = _rng(seed)
    crack = hp(r.standard_normal(len(t)) * np.exp(-t * 160), 2500) * 0.7
    pop = np.sin(2 * np.pi * (90 + 160 * np.exp(-t * 40)) * t) * np.exp(-t * 26) * 0.8
    glitter = sum(np.sin(2 * np.pi * f * t + r.uniform(0, 6)) * np.exp(-t * d) * (r.uniform(0.3, 1) * (t > o)) * np.exp(-np.maximum(0, t - o) * 0)
                  for f, d, o in [(r.uniform(5000, 9000), r.uniform(18, 30), r.uniform(0.01, 0.12)) for _ in range(14)]) * 0.05
    x = sat(crack + pop + glitter, 1.4)
    pans = np.linspace(-0.4, 0.4, len(t))
    a = (pans + 1) * np.pi / 4
    return np.stack([x * np.cos(a), x * np.sin(a)], 1).astype(np.float32) * 0.8


def zip_split(dur: float = 1.1, seed: int = 14) -> np.ndarray:
    """v5 edge trace: a bright electric zip that splits left and right as the two light heads run."""
    t = _t(dur)
    r = _rng(seed)
    p = t / dur
    k = 1 - (1 - p) ** 2.2  # the heads' ease
    f = 900 + 2600 * k
    tone = np.sin(2 * np.pi * np.cumsum(f) / SR) * 0.25 + np.sin(2 * np.pi * np.cumsum(f * 1.5) / SR) * 0.08
    buzz = bp(r.standard_normal(len(t)), 2500, 9000) * (0.5 + 0.5 * np.sin(2 * np.pi * 70 * t)) * 0.35
    env = np.minimum(1, t / 0.01) * (1 - p) ** 1.6
    x = (tone + buzz) * env
    w = np.clip(k, 0, 1)  # spreads from the centre to both sides
    left = x * (1 - 0.5 * w) + np.roll(x, int(0.006 * SR)) * 0.5 * w
    right = x * (1 - 0.5 * w) + np.roll(x, int(0.011 * SR)) * 0.5 * w
    return np.stack([left, right], 1).astype(np.float32) * 0.8
