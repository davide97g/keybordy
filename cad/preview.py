"""Build the print preview page: the real CAD meshes, placed as the slicer arranged them.

    uv run python preview.py      # after `just cad-slice`; writes out/preview/keybordy-mp-prints.html

For each part it exports a mesh in the CAD frame, deduplicates and quantises the vertices to 0.01 mm
(int16), and base64-encodes them. For each plate it reads the sliced .3mf: which part each build
item is, its rotation, and its bounding-box centre on the bed (from the 3mf's own mesh), plus the time
and grams from the G-code. The page turns each part into its print orientation and puts its centre
there, so what you see is what goes on the bed.
"""
from __future__ import annotations

import base64
import json
import re
import struct
import zipfile
from pathlib import Path

from build123d import export_stl

import macropad as m
import slice as sl

OUT = m.OUT / "preview"
TEMPLATE = m.HERE / "preview" / "template.html"
MESH_PARTS = ["fit_plate", "fit_bores", "cap1", "cap15", "cap2_talk", "knob", "plate", "deck", "tray"]


def read_stl(path: Path) -> list[tuple[float, float, float]]:
    data = path.read_bytes()
    n = struct.unpack_from("<I", data, 80)[0]
    tris = []
    for i in range(n):
        o = 84 + i * 50 + 12
        tris.extend(struct.unpack_from("<9f", data, o)[j * 3:j * 3 + 3] for j in range(3))
    return tris


def pack(verts: list[tuple[float, float, float]]) -> dict:
    index, pos, idx = {}, [], []
    for v in verts:
        q = tuple(int(round(c * 100)) for c in v)
        if q not in index:
            index[q] = len(pos)
            pos.append(q)
        idx.append(index[q])
    assert all(-32768 <= c <= 32767 for p in pos for c in p), "mesh too large for int16 at 0.01 mm"
    pb = struct.pack(f"<{len(pos) * 3}h", *[c for p in pos for c in p])
    ib = struct.pack(f"<{len(idx)}I", *idx)
    return {"p": base64.b64encode(pb).decode(), "i": base64.b64encode(ib).decode(), "tris": len(idx) // 3}


def meshes() -> dict:
    (OUT / "stl").mkdir(parents=True, exist_ok=True)
    out = {}
    for name in MESH_PARTS:
        part = m.PARTS[name][0]()
        f = OUT / "stl" / f"{name}.stl"
        export_stl(part, str(f), tolerance=0.03, angular_tolerance=0.2)
        out[name] = pack(read_stl(f))
        print(f"  mesh {name:10s} {out[name]['tris']:6d} triangles")
    return out


def bounds(model_xml: str):
    xs, ys, zs = [], [], []
    for x, y, z in re.findall(r'<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"', model_xml):
        xs.append(float(x)); ys.append(float(y)); zs.append(float(z))
    return [(min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2]


def plates() -> list[dict]:
    out = []
    for name, (colour, items) in sl.PLATES.items():
        f = sl.OUT / f"{name}.3mf"
        z = zipfile.ZipFile(f)
        model = z.read("3D/3dmodel.model").decode()
        cfg = z.read("Metadata/model_settings.config").decode()
        names = dict(re.findall(r'<object id="(\d+)">\s*<metadata key="name" value="([^"]+)"', cfg))
        comps = {oid: (path, [float(v) for v in t.split()]) for oid, path, t in re.findall(
            r'<object id="(\d+)"[^>]*>\s*<components>\s*<component p:path="([^"]+)"[^>]*transform="([^"]+)"', model)}
        placed = []
        for oid, t in re.findall(r'<item objectid="(\d+)"[^>]*transform="([^"]+)"', model):
            t = [float(v) for v in t.split()]
            path, ct = comps[oid]
            c = bounds(z.read(path.lstrip("/")).decode())
            local = [c[0] + ct[9], c[1] + ct[10], c[2] + ct[11]]
            r = t[:9]   # 3mf: row-major 3x4, points are row vectors: p' = p * R + t
            world = [local[0] * r[0] + local[1] * r[3] + local[2] * r[6] + t[9],
                     local[0] * r[1] + local[1] * r[4] + local[2] * r[7] + t[10],
                     local[0] * r[2] + local[1] * r[5] + local[2] * r[8] + t[11]]
            placed.append({"part": names[oid].removesuffix(".stl"), "rot": r, "at": world})
        head = (sl.OUT / f"{name}.gcode").read_text(errors="ignore")[:200_000]
        tm = re.search(r"^; model printing time: ([^;\n]+)", head, re.M)
        g = re.search(r"^; total filament weight \[g\] : ([\d.]+)", head, re.M)
        out.append({"name": name, "colour": colour, "hex": sl.PAL[colour], "items": placed,
                    "time": tm.group(1).strip() if tm else "?", "grams": float(g.group(1)) if g else None})
        print(f"  plate {name:22s} {len(placed)} items")
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    data = {
        "layout": m.L,
        "meshes": meshes(),
        "plates": plates(),
        "frame": {"tilt_deg": m.TILT, "pcb_top": m.PCB_TOP, "bore_depth": m.BORE_DEPTH, "cap_up": 7.0},
        "orient": {n: m.PARTS[n][1].__name__ for n in MESH_PARTS},
    }
    page = OUT / "keybordy-mp-prints.html"
    page.write_text(TEMPLATE.read_text().replace("__DATA__", json.dumps(data, separators=(",", ":"))))
    print(f"wrote {page.relative_to(m.REPO)} ({page.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
