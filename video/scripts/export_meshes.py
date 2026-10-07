"""Export the printed parts as fine STL meshes in the CAD frame for the teaser (video/build/models/).

    cd cad && uv run python ../video/scripts/export_meshes.py

The CAD frame is X = layout x, Y = -layout y, Z up, plate top at Z = 0 (see CLAUDE.md). The parts are
exported as designed, not in their print orientation, so the video places them like the assembled view
in cad/preview/template.html. Also writes frame.json with the constants the placement needs.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from build123d import export_stl

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / "cad"))
import macropad as m  # noqa: E402

OUT = HERE.parent / "build" / "models"
PARTS = ["tray", "deck", "plate", "cap1", "cap15", "cap2_talk", "knob"]

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name in PARTS:
        part = m.PARTS[name][0]()
        export_stl(part, str(OUT / f"{name}.stl"), tolerance=0.004, angular_tolerance=0.05)
        print(f"  {name:10s} {(OUT / f'{name}.stl').stat().st_size / 1e6:5.1f} MB")
    frame = {"tilt_deg": m.TILT, "pcb_top": m.PCB_TOP, "bore_depth": m.BORE_DEPTH, "cap_up": 7.0, "cap_h": m.CAP_H, "outer": m.OUTER}
    (OUT / "frame.json").write_text(json.dumps(frame, indent=1))
    print(f"  frame.json {frame}")
