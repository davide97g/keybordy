"""Slice the printed parts into Bambu Studio projects, one plate per filament colour.

    uv run python slice.py               # every plate
    uv run python slice.py 01-fit        # one plate
    PLATE=smooth uv run python slice.py  # another bed plate (default textured)

Uses ~/personal/projects/bambulab/tools/bambu-profiles.py (flattened A1 / PLA Basic profiles; the
stock ones slice wrong from the CLI) and checks every G-code with its --check. Output in out/plates/:
<name>.3mf to open in Bambu Studio (File > Open Project) and send, plus the G-code and a log.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path

import macropad as m

BS = "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio"
PROFILES = Path.home() / "personal/projects/bambulab/tools/bambu-profiles.py"
OUT = m.OUT / "plates"
STL = m.OUT / "stl"
BED = os.environ.get("PLATE", "textured")
PAL = m.L["finish"]["palette"]


def count(name: str) -> int:
    return m.PARTS[name][3]


# name: (filament, [(part, copies)]). Print 01-fit first.
PLATES = {
    "01-fit": ("Gray", [("fit_plate", 1), ("fit_bores", 1), ("cap1", 1)]),
    "02-caps-white": (m.L["finish"]["keycaps"], [("cap1", count("cap1"))]),
    "03-gray": (m.L["finish"]["mods"], [("cap15", count("cap15")), ("plate", 1)]),
    "04-green": (m.L["finish"]["ptt"], [("cap2_talk", count("cap2_talk"))]),
    "05-black-deck-knobs": (m.L["finish"]["case"], [("deck", 1), ("knob", count("knob"))]),
    "06-black-tray": (m.L["finish"]["case"], [("tray", 1)]),
}


def profiles(colour: str) -> Path:
    d = OUT / f"profiles-{colour.replace(' ', '_')}"
    subprocess.run([sys.executable, str(PROFILES), str(d), BED], check=True, capture_output=True)
    f = d / "filament.json"
    data = json.loads(f.read_text())
    data["filament_colour"] = [PAL[colour]]
    f.write_text(json.dumps(data, indent=2))
    return d


def slice_plate(name: str) -> str:
    colour, items = PLATES[name]
    d = profiles(colour)
    files = [str(STL / f"{p}.stl") for p, n in items for _ in range(n)]
    log = OUT / f"{name}.log"
    r = subprocess.run([BS, "--load-settings", f"{d}/machine.json;{d}/process.json",
                        "--load-filaments", f"{d}/filament.json",
                        "--slice", "0", "--arrange", "1", "--outputdir", str(OUT),
                        "--export-3mf", f"{name}.3mf", *files], capture_output=True, text=True)
    log.write_text(r.stdout + r.stderr)
    if r.returncode != 0 or not (OUT / "plate_1.gcode").exists():
        raise SystemExit(f"{name}: slicing failed, see {log}")
    gcode = OUT / f"{name}.gcode"
    (OUT / "plate_1.gcode").replace(gcode)
    with zipfile.ZipFile(OUT / f"{name}.3mf") as z:
        plates = [n for n in z.namelist() if re.fullmatch(r"Metadata/plate_\d+\.png", n)]
    if len(plates) != 1:
        raise SystemExit(f"{name}: arranged onto {len(plates)} plates, expected 1")
    chk = subprocess.run([sys.executable, str(PROFILES), "--check", str(gcode), BED], capture_output=True, text=True)
    if chk.returncode != 0:
        raise SystemExit(f"{name}: G-code check failed:\n{chk.stdout}{chk.stderr}")
    head = gcode.read_text(errors="ignore")[:200_000]
    t = re.search(r"^; model printing time: ([^;\n]+)", head, re.M)
    g = re.search(r"^; total filament weight \[g\] : ([\d.]+)", head, re.M)
    parts = ", ".join(f"{p} x{n}" for p, n in items)
    return f"{name:22s} {colour:11s} {t.group(1).strip() if t else '?':>12s}  {g.group(1) if g else '?':>6s} g   {parts}"


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name in sys.argv[1:] or list(PLATES):
        print(slice_plate(name), flush=True)
