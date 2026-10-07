"""The soundtrack: music edit, cue sheet, sound design, mix and master.

    uv run python build.py            # v1: data/cues.json, data/audio.json, build/mix_stereo.wav, build/mix_51.wav
    uv run python build.py --v 2      # v2: the same under data/v2/ and build/v2/ (logo cue, sticker slaps)
    uv run python build.py --v 3      # v3: v2 with a burst under every click instead of the sticker slap
    uv run python build.py --v 4      # v4: v3 with a bigger opening hit and the crash-zoom whoosh
    uv run python build.py --v 5      # v5: v4 plus the zip of the light running round the case

EDIT. "Total War" (AudioAtlant, Pixabay) runs at 120 BPM with its hits on one grid: the opening hit at
0.6 s, another at 8.6 s, the drop at 52.575 s and the final hit at 64.575 s (each the peak of a short
swell, measured with analyze.py and a 25 ms loudness scan). The edit keeps that grid, so beat b of the
video is at 0.02 + 0.5 b seconds:
    A  the intro, from its first hit (our beat 0) through the second (our beat 16), faded out over beats 18-20
    B  from the near-silent break before the drop (our beat 18) to the end: the drop lands on our beat 24
       and the final hit on our beat 48, then the tail under the credit.
Everything else is sound design laid on data/cues.json (cues.py): real switch recordings (kbsim, MIT)
for the keys, Kenney (CC0) ticks for the detents, a few Pixabay cinematic hits, and synth.py.
"""
from __future__ import annotations

import json
from pathlib import Path

import librosa
import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from scipy import signal
from scipy.ndimage import minimum_filter1d
import zlib

import cues
import synth as S
from synth import SR

ROOT = Path(__file__).resolve().parent.parent
V = ROOT / "public" / "vendor"
BUILD = ROOT / "build"
DATA = ROOT / "data"

MUSIC = V / "music" / "audioatlant-total-war-epic-action-cinematic-trailer-main-513668.mp3"
T0 = 0.02            # our beat 0, seconds into the soundtrack
PERIOD = 0.5         # 120 BPM
A_HIT = 0.6          # music time of our beat 0 (A)
B_DROP = 52.575      # music time of our beat 24 (B)
TARGET_LUFS = -14.0
CEILING_DB = -1.0


def load(path: Path, mono: bool = False) -> np.ndarray:
    y, _ = librosa.load(str(path), sr=SR, mono=mono)
    y = np.atleast_2d(y)
    if y.shape[0] == 1:
        y = np.vstack([y, y])
    return y.T.astype(np.float32)  # (n, 2)


def fade(n: int, a: int, b: int, up: bool) -> np.ndarray:
    """Equal-power ramp over samples [a, b)."""
    g = np.zeros(n) if up else np.ones(n)
    a, b = max(0, a), min(n, b)
    x = np.linspace(0, 1, max(1, b - a))
    g[a:b] = np.sin(x * np.pi / 2) if up else np.cos(x * np.pi / 2)
    if up:
        g[b:] = 1
    else:
        g[b:] = 0
    return g


def music_edit(duration: float) -> np.ndarray:
    m = load(MUSIC)
    n = int(duration * SR)
    beat = lambda b: T0 + PERIOD * b  # noqa: E731
    out = np.zeros((n, 2), np.float32)
    # A: our time t is music time t - T0 + A_HIT
    a_off = int((A_HIT - T0) * SR)
    a = m[a_off:a_off + n]
    a = np.pad(a, ((0, n - len(a)), (0, 0)))
    ga = fade(n, int(beat(18) * SR), int(beat(20) * SR), up=False)
    # B: our time t is music time t - beat(24) + B_DROP
    b_off = int((B_DROP - beat(24)) * SR)
    b = m[b_off:b_off + n]
    b = np.pad(b, ((0, n - len(b)), (0, 0)))
    gb = fade(n, int(beat(17.5) * SR), int(beat(18.5) * SR), up=True)
    out = a * ga[:, None] + b * gb[:, None]
    out *= fade(n, n - int(0.7 * SR), n, up=False)[:, None]
    return out


class Bus:
    def __init__(self, n: int):
        self.x = np.zeros((n + SR * 6, 2), np.float32)

    def add(self, t: float, s: np.ndarray, gain_db: float = 0.0, pan: float | None = None, length: float | None = None):
        if pan is not None:
            s = S.stereo(s.mean(1) if s.ndim == 2 else s, pan)
        if length is not None:
            k = int(length * SR)
            s = s[:k].copy()
            r = min(len(s), int(0.05 * SR))
            s[-r:] *= np.linspace(1, 0, r)[:, None]
        i = int(round(t * SR))
        if i < 0:
            s, i = s[-i:], 0
        s = s * (10 ** (gain_db / 20))
        self.x[i:i + len(s)] += s[: len(self.x) - i]


def trim(x: np.ndarray, thresh_db: float = -50) -> np.ndarray:
    """Drop leading silence so a sample's transient lands on its cue time."""
    e = np.abs(x).max(1)
    i = int(np.argmax(e > e.max() * 10 ** (thresh_db / 20)))
    return x[max(0, i - 24):]


def limiter(x: np.ndarray, ceiling_db: float, look_ms: float = 5, rel_ms: float = 90) -> np.ndarray:
    """Look-ahead peak limiter driven by the 4x oversampled peak (approximate true peak)."""
    c = 10 ** (ceiling_db / 20)
    up = signal.resample_poly(x, 4, 1, axis=0)
    pk = np.abs(up).max(1)[: len(x) * 4].reshape(-1, 4).max(1)
    pk = np.pad(pk, (0, len(x) - len(pk)), mode="edge")
    need = np.minimum(1, c / np.maximum(pk, 1e-9))
    la = int(look_ms * SR / 1000)
    need = minimum_filter1d(need, size=2 * la + 1)
    g = np.empty_like(need)
    rel = np.exp(-1 / (rel_ms * SR / 1000))
    cur = 1.0
    for i, v in enumerate(need):
        cur = v if v < cur else v + (cur - v) * rel
        g[i] = cur
    g = np.convolve(g, np.ones(la) / la, mode="same")
    return x * g[:, None]


def true_peak_db(x: np.ndarray) -> float:
    return 20 * np.log10(np.abs(signal.resample_poly(x, 4, 1, axis=0)).max() + 1e-12)


def main(version: int = 1) -> None:
    vd = "" if version == 1 else f"v{version}"
    build, data = BUILD / vd, DATA / vd
    build.mkdir(parents=True, exist_ok=True)
    data.mkdir(parents=True, exist_ok=True)
    grid = [round(T0 + PERIOD * i, 4) for i in range(70)]
    c = cues.plan(grid, version=version)
    cues.write(c, version)
    dur = c["duration"]
    n = int(dur * SR)
    L = json.loads((ROOT.parent / "layout" / "macropad.json").read_text())
    keys = {k["id"]: k for k in L["keys"]}

    # samples
    sw = V / "clicks" / "kbsim-cream"
    press_s = [trim(load(sw / "press" / f"GENERIC_R{i}.mp3")) for i in range(5)]
    rel_s = trim(load(sw / "release" / "GENERIC.mp3"))
    space_s, space_rel = trim(load(sw / "press" / "SPACE.mp3")), trim(load(sw / "release" / "SPACE.mp3"))
    enter_s = trim(load(sw / "press" / "ENTER.mp3"))
    ticks = [trim(load(V / "clicks" / "knob" / f"kenney-ui-{k}.ogg")) for k in ("click4", "click5", "switch13", "switch14")]
    sub = trim(load(V / "sfx" / "descent-sub-boom-massive-cinematic-sound-effect-405929.mp3"))
    braam = trim(load(V / "sfx" / "ascent-braam-magma-brass-d-cinematic-trailer-sound-effect-222269.mp3"))
    paper = trim(load(V / "sfx" / "oxidvideos-paper-slide-short-478835.mp3"))
    blip = trim(load(V / "sfx" / "kenney-confirmation_002.ogg"))

    music = music_edit(dur)
    fx = Bus(n)       # dry-ish sound design
    verb = Bus(n)     # sent to the hall
    low = Bus(n)      # sub content (also feeds the LFE)
    U = L["u_mm"]
    pan_of = lambda k: float(np.clip(((k["x"] + k["w"] / 2) * U - 57) / 70, -0.7, 0.7))  # noqa: E731
    letters = 0
    for e in c["events"]:
        t, kind = e["t"], e["kind"]
        if kind == "press":
            k = keys[e["key"]]
            if e["key"] == "K21":
                s, r, g = space_s, space_rel, 0.0
            elif e["key"] == "K22":
                s, r, g = enter_s, rel_s, -1.0
            else:
                s, r, g = press_s[(k["row"] + zlib.crc32(e["key"].encode())) % 5], rel_s, -1.0
            first_click = t < c["scenes"][1]["start"]
            g += 4.0 if first_click else 0.0
            fx.add(t - 0.004, s, g, pan_of(k))
            fx.add(t + e["hold"] + 0.01, r, g - 5, pan_of(k))
            fx.add(t - 0.002, S.switch_click(seed=zlib.crc32(e["key"].encode()) % 997, thock=0.8), g - 12, pan_of(k))  # body under the recording
            if version == 2 and e["key"] != "K21":  # the sticker burst round the key
                fx.add(t + 0.012, S.sticker_slap(seed=zlib.crc32(e["key"].encode()) % 97), g - 17, pan_of(k))
            if version >= 3:  # the key goes off: crack, pop, shards
                fx.add(t, S.burst(seed=int(t * 100)), g - 12, pan_of(k))
                verb.add(t, S.burst(seed=int(t * 100)), g - 20, pan_of(k))
            verb.add(t, s, g - (2 if first_click else 9), pan_of(k))
        elif kind == "detent":
            fx.add(t - 0.002, ticks[e["n"] % len(ticks)], -6, 0.35)
            fx.add(t - 0.002, S.detent(seed=e["n"], pitch=1 + 0.03 * (e["n"] % 3)), -14, 0.35)
            verb.add(t, ticks[e["n"] % len(ticks)], -16, 0.35)
        elif kind == "drone":
            low.add(t, S.drone(e["dur"] + 0.6), -10)
        elif kind == "whoosh":
            p0, p1 = e["pan"]
            fx.add(t, S.whoosh(e["dur"], seed=int(t * 100), pan_from=p0, pan_to=p1), -12)
        elif kind == "chirp":
            fx.add(t, S.chirp(), -14, -0.25)
            fx.add(t + 0.01, blip, -16, -0.25)
            verb.add(t, S.chirp(), -18, -0.25)
        elif kind == "riser":
            x = S.riser(e["dur"])
            fx.add(t, x / np.abs(x).max(), -15)
            verb.add(t, x / np.abs(x).max(), -20)
        elif kind == "land":
            heavy = e["heavy"]
            fx.add(t - 0.003, press_s[e["layer"].__len__() % 5], -2 if heavy else -5, 0.0)
            fx.add(t - 0.003, S.switch_click(seed=len(e["layer"]) * 13, thock=0.5), -8, 0.0)
            low.add(t, S.sub_boom(1.6 if heavy else 0.8, 70 if heavy else 95, 32, seed=len(e["layer"])), -6 if heavy else -13)
            verb.add(t, S.impact(1.5, seed=len(e["layer"]), crack=0.3), -20 if heavy else -26)
        elif kind == "reverse_swell":
            x = S.reverse_swell(e["dur"] + 0.02)
            fx.add(t - 0.02, x / np.abs(x).max(), -18)
        elif kind == "drop":
            low.add(t - 0.01, sub, -8)
            fx.add(t, S.impact(4.0, seed=21), -10)
        elif kind == "braam":
            fx.add(t - 0.03, braam, -11)
        elif kind == "slam":
            low.add(t, S.sub_boom(0.6, 110, 45, seed=int(t * 10)), -17)
            fx.add(t, S.whoosh(0.25, seed=int(t * 10), pan_from=0.2, pan_to=-0.2), -20)
            if version >= 2:  # the line is a sticker now: it slaps on
                fx.add(t + 0.01, S.sticker_slap(seed=int(t * 10)), -13, -0.1)
        elif kind == "boom_open":
            low.add(t - 0.01, sub, -5)
            fx.add(t - 0.02, braam, -9)
            fx.add(t, S.impact(4.0, seed=51, crack=0.8), -7)
            verb.add(t, S.impact(3.0, seed=52), -12)
            if version >= 5:  # the light running round the case
                fx.add(t + 0.01, S.zip_split(1.1), -13)
                verb.add(t + 0.01, S.zip_split(1.1), -20)
        elif kind == "crash":
            x = S.whoosh(e["dur"] + 0.15, seed=61, pan_from=0.5, pan_to=-0.1)
            x *= np.linspace(0.2, 1.0, len(x))[:, None] ** 2  # it pulls in: louder toward the key
            fx.add(t, x, -6)
            r = S.riser(e["dur"], seed=62)
            fx.add(t, r / np.abs(r).max(), -14)
        elif kind == "ui_click":
            fx.add(t - 0.003, trim(load(V / "sfx" / "kenney-select_001.ogg")), -9, 0.15)
            fx.add(t + 0.01, S.sticker_slap(seed=int(t * 10)), -15, 0.15)
            verb.add(t, S.sticker_slap(seed=int(t * 10)), -24, 0.15)
        elif kind == "logo":
            fx.add(t + 0.015, S.sticker_slap(seed=41), -8, -0.3)
            fx.add(t + 0.02, paper, -15, -0.3)
            fx.add(t + 0.11, press_s[2], -6, -0.3)
            verb.add(t, S.sticker_slap(seed=41), -18, -0.3)
        elif kind == "listen":
            fx.add(t + 0.02, blip, -15, 0.1)
        elif kind == "letter":
            p = -0.5 + letters / 7
            fx.add(t - 0.004, press_s[letters % 5], -3, p)
            verb.add(t, press_s[letters % 5], -12, p)
            letters += 1
        elif kind == "impact":
            low.add(t - 0.01, sub, -7)
            fx.add(t, S.impact(4.0, seed=33), -9)
            verb.add(t, S.impact(3.0, seed=34), -16)
        elif kind == "sticker":
            fx.add(t + 0.02, S.sticker_slap(), -9, 0.25)
            fx.add(t + 0.03, paper, -14, 0.25)

    fx_x, verb_x, low_x = fx.x[:n], verb.x, low.x[:n]
    wet = S.reverb(verb_x, 2.6, 0.02, wet=1.0, seed=7, damp=4200)[:n]
    room = S.reverb(fx_x, 0.6, 0.004, wet=1.0, seed=8, damp=6000)[:n] * 0.18
    sfx = fx_x + room + wet * 0.55 + low_x

    # duck the music a little under the loud design (sidechain from the sfx envelope)
    env = np.abs(S.lp(np.abs(sfx).max(1), 12, 1))
    duck = 1 / (1 + 1.4 * np.clip(env / (env.max() + 1e-9), 0, 1))
    stereo = music * 0.85 * duck[:, None] + sfx
    stereo = S.hp(stereo, 25, 4).astype(np.float32)  # no rumble under the subs

    meter = pyln.Meter(SR)
    gain = TARGET_LUFS - meter.integrated_loudness(stereo)
    stereo = limiter(stereo * 10 ** (gain / 20), CEILING_DB - 0.3)
    print(f"stereo: {meter.integrated_loudness(stereo):.1f} LUFS, true peak {true_peak_db(stereo):.2f} dBTP, {dur:.2f} s")
    sf.write(build / "mix_stereo.wav", stereo, SR, subtype="PCM_24")

    # 5.1 (L R C LFE Ls Rs): music across the front with a delayed, darker copy in the rears; the design's
    # centre (its mid) in C, its sides in L/R; the hall in the rears; everything under 110 Hz in the LFE
    g = 10 ** (gain / 20)
    mid, side = sfx.mean(1), (sfx[:, 0] - sfx[:, 1]) / 2
    d = int(0.018 * SR)
    rear_m = S.lp(np.pad(music, ((d, 0), (0, 0)))[:n], 5000) * 0.5
    ch = np.zeros((n, 6), np.float32)
    mus = music * 0.85 * duck[:, None]
    ch[:, 0] = mus[:, 0] + (fx_x[:, 0] - fx_x.mean(1)) + side * 0.5 + fx_x.mean(1) * 0.35
    ch[:, 1] = mus[:, 1] + (fx_x[:, 1] - fx_x.mean(1)) - side * 0.5 + fx_x.mean(1) * 0.35
    ch[:, 2] = (fx_x.mean(1) + low_x.mean(1)) * 0.7 + mus.mean(1) * 0.15
    ch[:, 3] = S.lp(low_x.mean(1) + mus.mean(1) * 0.5, 110, 4) * 0.8
    ch[:, 4] = rear_m[:, 0] * duck + wet[:, 0] * 0.6 + room[:, 0]
    ch[:, 5] = rear_m[:, 1] * duck + wet[:, 1] * 0.6 + room[:, 1]
    ch *= g
    down = np.stack([ch[:, 0] + 0.707 * ch[:, 2] + 0.707 * ch[:, 4], ch[:, 1] + 0.707 * ch[:, 2] + 0.707 * ch[:, 5]], 1)
    adj = TARGET_LUFS - meter.integrated_loudness(down)
    ch = limiter(ch * 10 ** (adj / 20), CEILING_DB - 0.3)
    print(f"5.1: downmix {meter.integrated_loudness(np.stack([ch[:, 0] + 0.707 * ch[:, 2] + 0.707 * ch[:, 4], ch[:, 1] + 0.707 * ch[:, 2] + 0.707 * ch[:, 5]], 1)):.1f} LUFS, true peak {true_peak_db(ch):.2f} dBTP")
    sf.write(build / "mix_51.wav", ch, SR, subtype="PCM_24")

    # analysis for the video engine (engine/audio.ts): beat grid, loudness envelopes, hit onsets
    hop = SR // 100
    mono = stereo.mean(1)
    frames = len(mono) // hop
    rms = np.sqrt((mono[: frames * hop].reshape(frames, hop) ** 2).mean(1))
    lowb = np.sqrt((S.lp(mono, 150, 2)[: frames * hop].reshape(frames, hop) ** 2).mean(1))
    norm = lambda v: (v / (v.max() + 1e-9)).round(4).tolist()  # noqa: E731
    hits = [[e["t"], 1.0] for e in c["events"] if e["kind"] in ("drop", "impact", "land", "slam")]
    beats = [b for b in c["beats"] if b <= dur]
    (data / "audio.json").write_text(json.dumps({
        "duration": dur, "bpm": 120.0, "fps": 100, "beats": beats, "downbeats": beats[::4],
        "sections": [{"name": s["id"], "start": s["start"], "end": s["end"]} for s in c["scenes"]],
        "features": {"rms": norm(rms), "low": norm(lowb)}, "onsets": {"kick": hits},
    }))
    print(f"wrote {build / 'mix_stereo.wav'}, {build / 'mix_51.wav'}, {cues.out_path(version)}, {data / 'audio.json'}")


if __name__ == "__main__":
    import sys
    main(int(sys.argv[sys.argv.index("--v") + 1]) if "--v" in sys.argv else 1)
