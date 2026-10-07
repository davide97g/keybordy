"""The edit as a cue sheet: scene windows and every timed event, laid on the music's beat grid.

The video (app/src/cues.ts) and the mixer (build.py) both read data/cues.json, so a key press, its
click and its cut land on the same sample. Times are seconds from the start of the soundtrack.

Structure (beats from the start of the edited music, about 120 BPM; one bar = 4 beats). Short on
purpose: about 27 s. build.py anchors beats 0, 16, 24 and 48 on the music's hits (see EDIT there).
    open    0-6     cold open: a light sweeps a keycap in the dark; the first click on beat 5.5
    knob    6-12    macro on the knobs: detents on the eighths of beats 9-11.5
    oled    12-16   the screen wakes (chirp), the riser starts
    build   16-24   the parts fall into place, one layer per beat; the last lock is the drop
    hero    24-30   drop: flash, hero orbit
    montage 30-38   one cut per beat: key presses, the screen follows, four text slams
    talk    38-41   the talk bar held, the mic LED, the waveform
    title   41-48   "keybordy" typed on eighths over a dark silhouette, the music decays
    credit  48-end  the final hit: the MP sticker slaps, the device lights up, made by
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "cues.json"


def out_path(version: int = 1) -> Path:
    """Each cut keeps its own cue sheet: data/cues.json (v1), data/v2/cues.json, ..."""
    return OUT if version == 1 else ROOT / "data" / f"v{version}" / "cues.json"

MONTAGE = ["K1", "K4", "K9", "K15", "K3", "K12", "K6", "K22"]
TITLE = "keybordy"
CREDIT_HOLD = 3.4  # seconds of credit after beat 48


def plan(beats: list[float], duration: float | None = None, version: int = 1) -> dict:
    B = lambda b: float(beats[0] + (beats[1] - beats[0]) * b) if b < 0 else _at(beats, b)  # noqa: E731
    period = (beats[-1] - beats[0]) / (len(beats) - 1)
    ev: list[dict] = []

    def e(t: float, kind: str, **kw):
        ev.append({"t": round(t, 4), "kind": kind, **kw})

    if version >= 4:
        # v4: the opening hit gets its own design; the crash zoom pulls from beat 4 into the first click
        e(B(0), "boom_open")
        e(B(4), "crash", dur=B(5.5) - B(4))
    # open: drone under it, light sweep, one press on the "and" of beat 5
    e(B(0), "drone", dur=B(6) - B(0))
    e(B(0.5), "whoosh", dur=B(4.5) - B(0.5), pan=[-0.7, 0.7])
    e(B(5.5), "press", key="K1", hold=0.16)
    # knob: E1 turns on the eighths of beats 9..11.5
    for i in range(6):
        e(B(9 + i * 0.5), "detent", knob="E1", n=i + 1)
    # oled: wake chirp, the boot animation, the riser to the drop
    e(B(12.5), "chirp")
    e(B(12.5), "oled_boot", dur=B(15) - B(12.5))
    e(B(13), "riser", dur=B(24) - B(13))
    # build: one layer per beat (tray first), then a reversed swell into the drop
    for i, layer in enumerate(["tray", "inner", "pcb", "plate", "sw", "caps", "deck", "knobs"]):
        e(B(16 + i), "land", layer=layer, heavy=layer in ("tray", "deck"))
    e(B(23.25), "reverse_swell", dur=B(24) - B(23.25))
    # hero: the drop
    e(B(24), "drop")
    e(B(24), "braam")
    e(B(28.5), "whoosh", dur=period * 1.5, pan=[0.6, -0.6])
    if version == 1:
        # montage: one key per beat, text slams on every other beat
        for i, k in enumerate(MONTAGE):
            e(B(30 + i), "press", key=k, hold=0.1)
        for i, txt in enumerate(["22 keys.", "3 knobs.", "1 screen.", "your voice."]):
            e(B(30 + 2 * i), "slam", text=txt, dur=period * 2)
    else:
        # v2: four cuts (beats 30-33), then the keymap editor on 34-37: three clicks in the UI (K5, K6,
        # Save); "your voice." moves onto the talk bar
        for i, k in enumerate(MONTAGE[:4]):
            e(B(30 + i), "press", key=k, hold=0.1)
        for i, txt in enumerate(["22 keys.", "1 screen."]):
            e(B(30 + 2 * i), "slam", text=txt, dur=period * 2)
        e(B(34), "slam", text="map every key.", dur=period * 4)
        for b, (target, state) in zip((35, 36, 37), (("cap5", "b"), ("cap6", "c"), ("save", "c"))):
            e(B(b), "ui_click", target=target, state=state)
        e(B(38), "slam", text="your voice.", dur=B(41) - B(38))
    # talk: hold the bar for three beats; the mic LED and the waveform follow
    e(B(38), "press", key="K21", hold=B(40.75) - B(38))
    e(B(38), "listen", dur=B(40.75) - B(38))
    # title: one letter per eighth from beat 42; the final hit on 48 brings the sticker
    e(B(41), "whoosh", dur=period, pan=[-0.3, 0.3])
    for i, ch in enumerate(TITLE):
        e(B(42 + i * 0.5), "letter", i=i, ch=ch)
    if version >= 2:
        # v2: the official logo sticker slaps on before the wordmark is typed beside it
        e(B(41.5), "logo")
    e(B(47.25), "reverse_swell", dur=B(48) - B(47.25))
    e(B(48), "impact")
    e(B(48), "sticker")
    # credit
    e(B(48), "credit")
    end = B(48) + CREDIT_HOLD
    e(end - 0.02, "end")

    bounds = {"open": 0, "knob": 6, "oled": 12, "build": 16, "hero": 24, "montage": 30, "talk": 38, "title": 41, "credit": 48}
    if version >= 2:
        bounds = {**{k: v for k, v in bounds.items() if k not in ("talk", "title", "credit")}, "editor": 34, "talk": 38, "title": 41, "credit": 48}
    names = list(bounds)
    scenes = []
    for i, n in enumerate(names):
        s = B(bounds[n]) if n != "open" else 0.0
        en = B(bounds[names[i + 1]]) if i + 1 < len(names) else end
        scenes.append({"id": n, "start": round(s, 4), "end": round(en, 4)})
    ev.sort(key=lambda x: x["t"])
    return {"duration": round(end, 4), "period": period, "beats": [round(b, 4) for b in beats if b <= end + 1], "scenes": scenes, "events": ev}


def _at(beats: list[float], b: float) -> float:
    i = int(b)
    if i + 1 >= len(beats):
        p = beats[-1] - beats[-2]
        return beats[-1] + (b - (len(beats) - 1)) * p
    return beats[i] + (beats[i + 1] - beats[i]) * (b - i)


def write(c: dict, version: int = 1) -> None:
    out = out_path(version)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(c, indent=1))


if __name__ == "__main__":
    # a plain 120 BPM grid, for working on the picture without the music (build.py writes the real one)
    c = plan([i * 0.5 for i in range(80)])
    write(c)
    print(f"{OUT}: {c['duration']:.2f} s, {len(c['events'])} events")
