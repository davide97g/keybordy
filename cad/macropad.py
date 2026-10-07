"""keybordy MP printed parts, built from layout/macropad.json with build123d.

    uv run python macropad.py            # every part: STL in out/stl/, STEP in out/step/, then the fit check
    uv run python macropad.py knob cap1  # only these parts

CAD frame: X = layout x, Y = -layout y (so +Y is the rear), Z up, the plate's top
face at Z = 0. Stack-up, bottom to top:

    tray floor   follows the table: 4 - rear_h at the rear edge, 4 - front_h at the front
    PCB          Z -6.6 .. -5      (MX: plate top to PCB top is 5 mm)
    plate        Z -1.5 .. 0
    deck         Z  0   .. 4       sits on the tray walls and on the plate
    caps / knobs above the deck

Print rules come from ~/personal/projects/bambulab/design-rules.md: switch holes
14.1 mm, MX cross 4.10 x 1.35 x 5.05 deep with a 0.3 mm mouth chamfer, caps and
knobs printed top-down so the bore's mouth is the last layer, nothing standing
thin on the plate, cuts instead of raised detail on faces that go on the plate.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from build123d import (
    Align, Axis, Box, Circle, Cylinder, Keep, Part, Plane, Polygon, Pos, Rectangle, RectangleRounded,
    Rot, SlotOverall, Text, Vector, chamfer, export_step, export_stl, extrude, fillet, loft, split,
)

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
L = json.loads((REPO / "layout" / "macropad.json").read_text())
OUT = HERE / "out"

U = L["u_mm"]
C = L["case"]
EP = L["encoder_part"]
PO = L["pcb"]["outline_mm"]
GAP, WALL = C["gap_mm"], C["wall_mm"]
INNER = [PO[0] - GAP, PO[1] - GAP, PO[2] + GAP, PO[3] + GAP]
OUTER = [INNER[0] - WALL, INNER[1] - WALL, INNER[2] + WALL, INNER[3] + WALL]
DECK = C["deck_mm"]
PLATE = C["plate_mm"]
PCB_TOP = -C["pcb_below_plate_mm"]
PCB_BOT = PCB_TOP - 1.6
FLOOR = C["floor_mm"]

# The floor plane: the tray stands on it. Heights are to the deck's top face.
Y_REAR, Y_FRONT = -OUTER[1], -OUTER[3]
Z_REAR, Z_FRONT = DECK - C["rear_h_mm"], DECK - C["front_h_mm"]
SLOPE = (Z_REAR - Z_FRONT) / (Y_REAR - Y_FRONT)          # dZ/dY, negative: the rear sits lower in Z
TILT = math.degrees(math.atan(-SLOPE))


def z_floor(y: float) -> float:
    return Z_REAR + (y - Y_REAR) * SLOPE


FLOOR_PLANE = Plane(origin=(0, Y_REAR, Z_REAR), z_dir=(0, -SLOPE, 1))


def at(lx: float, ly: float, z: float = 0) -> Pos:
    """Layout mm to a CAD position."""
    return Pos(lx, -ly, z)


def rrect(x0: float, y0: float, x1: float, y1: float, r: float):
    """Rounded rectangle from layout corners (y toward the user)."""
    w, h = x1 - x0, y1 - y0
    return at((x0 + x1) / 2, (y0 + y1) / 2) * RectangleRounded(w, h, min(r, w / 2 - 0.01, h / 2 - 0.01))


def prism(sketch, z0: float, z1: float) -> Part:
    return Pos(0, 0, z0) * extrude(sketch, z1 - z0)


def key_center(k: dict) -> tuple[float, float]:
    return (k["x"] + k["w"] / 2) * U, (k["y"] + k["h"] / 2) * U


def biggest_face(part: Part, normal: Vector):
    n = Vector(normal).normalized()
    faces = [f for f in part.faces() if f.normal_at().normalized().dot(n) > 0.999]
    return max(faces, key=lambda f: f.area)


# ── tray (case bottom) ────────────────────────────────────────────────────────

def tray() -> Part:
    corner = C["corner_r_mm"]
    outer = rrect(*OUTER, corner)
    inner = rrect(*INNER, corner - WALL)
    body = split(prism(outer, -60, 0), bisect_by=FLOOR_PLANE, keep=Keep.TOP)
    # chamfer the edge that sits on the plate: hides elephant foot
    bottom = biggest_face(body, (0, SLOPE, -1))
    body = chamfer(bottom.outer_wire().edges(), 0.8)
    pocket = split(prism(inner, -60, 1), bisect_by=FLOOR_PLANE.offset(FLOOR / math.cos(math.radians(TILT))), keep=Keep.TOP)
    body -= pocket

    # inside the pocket: screw pillars up to the PCB's underside, ribs round the battery and speaker
    inside = None
    pr = L["pcb"]["pillar_d_mm"] / 2
    for h in L["pcb"]["holes_mm"]:
        p = prism(at(*h) * Circle(pr), -60, PCB_BOT)
        inside = p if inside is None else inside + p
    for name in ("battery", "speaker"):
        p = L[name]
        w, d = p["box_mm"][0] + 0.6, p["box_mm"][1] + 0.6
        cx, cy = p["at"]
        top = z_floor(-cy) + FLOOR + 3
        frame = rrect(cx - w / 2 - 1.2, cy - d / 2 - 1.2, cx + w / 2 + 1.2, cy + d / 2 + 1.2, 1.5) \
            - rrect(cx - w / 2, cy - d / 2, cx + w / 2, cy + d / 2, 0.5)
        if name == "battery":   # leave the lead side open
            frame -= at(cx - w / 2 - 0.6, cy) * Rectangle(3, 14)
        inside += prism(frame, -60, top)
    body += inside & pocket

    # screw holes: counterbore from below, M2 clearance through the top 2 mm of each pillar
    for h in L["pcb"]["holes_mm"]:
        body -= at(*h) * Cylinder(2.2, 60, align=(Align.CENTER, Align.CENTER, Align.MAX)) & Pos(0, 0, PCB_BOT - 2) * Box(400, 400, 60, align=(Align.CENTER, Align.CENTER, Align.MAX))
        body -= at(*h, PCB_BOT - 3) * Cylinder(1.2, 4, align=(Align.CENTER, Align.CENTER, Align.MIN))

    # bumpon recesses, square to the floor
    for fx, fy in ((OUTER[0] + 14, OUTER[1] + 14), (OUTER[2] - 14, OUTER[1] + 14),
                   (OUTER[0] + 14, OUTER[3] - 14), (OUTER[2] - 14, OUTER[3] - 14)):
        y = -fy
        body -= Plane(origin=(fx, y, z_floor(y)), z_dir=(0, -SLOPE, 1)) * Cylinder(5.2, 1.2)

    # speaker: hex grille through the floor under it, vertical slots in the front wall
    sx, sy = L["speaker"]["at"]
    sw, sd = L["speaker"]["box_mm"][:2]
    for row in range(-3, 4):
        for col in range(-6, 7):
            x, y = sx + col * 2.6 + (1.3 if row % 2 else 0), sy + row * 2.25
            if abs(x - sx) < sw / 2 - 2 and abs(y - sy) < sd / 2 - 2:
                body -= at(x, y) * Cylinder(0.8, 120)
    zf = z_floor(Y_FRONT)
    for i in range(-4, 5):
        slot = Pos(sx + i * 3.0, Y_FRONT + WALL / 2, (zf + FLOOR + 3 + PCB_BOT - 2.5) / 2) * Box(1.5, WALL + 2, (PCB_BOT - 2.5) - (zf + FLOOR + 3))
        body -= slot

    # rear wall: USB-C and the two slide switches (v0: positions follow the layout, heights assume
    # bottom-side parts centred 1.7 mm under the PCB)
    zc = PCB_BOT - 1.7
    ux = L["usb_c"]["at"][0]
    body -= Pos(ux, Y_REAR - WALL / 2, zc) * Rot(X=90) * extrude(RectangleRounded(10.0, 4.2, 1.6), WALL + 2, both=True)
    for s in L["switches"]:
        body -= Pos(s["at"][0], Y_REAR - WALL / 2, zc) * Rot(X=90) * extrude(RectangleRounded(9.5, 3.8, 1.0), WALL + 2, both=True)
    return body


# ── deck (case top) ───────────────────────────────────────────────────────────

def deck() -> Part:
    body = prism(rrect(*OUTER, C["corner_r_mm"]), 0, DECK)
    top = body.faces().sort_by(Axis.Z)[-1]
    body = fillet(top.outer_wire().edges(), 1.6)

    cuts = []
    cuts.append(rrect(-1.0, 2.25 * U - 1.0, 6 * U + 1.0, 6.25 * U + 1.0, 2.6))
    o = L["oled"]
    ox, oy = o["at"]
    aw, ah = o["active_mm"][0] + 3, o["active_mm"][1] + 3
    cuts.append(rrect(ox - aw / 2, oy - ah / 2, ox + aw / 2, oy + ah / 2, 1.6))
    # one channel round all three knobs: separate holes would leave no wall between them
    kr = EP["knob_d_mm"] / 2 + 1.2
    ex = [e["at"][0] for e in L["encoders"]]
    ey = L["encoders"][0]["at"][1]
    cuts.append(at((min(ex) + max(ex)) / 2, ey) * SlotOverall(max(ex) - min(ex) + 2 * kr, 2 * kr))
    for c in cuts:
        body -= prism(c, -1, DECK + 1)
    # 45-degree chamfer round the top of every opening
    top = body.faces().sort_by(Axis.Z)[-1]
    body = chamfer([e for w in top.inner_wires() for e in w.edges()], 0.8)

    # mic port and LED window
    body -= at(*L["mic"]["at"]) * Cylinder(0.65, 20)
    body -= at(*L["mic_led"]["at"]) * Cylinder(1.0, 20)

    # underside: the OLED module sits in a 1 mm pocket, screws bite into blind pilot holes
    mw, mh = o["module_mm"][0] + 0.4, o["module_mm"][1] + 0.4
    body -= prism(rrect(ox - mw / 2, oy - mh / 2, ox + mw / 2, oy + mh / 2, 0.8), -1, 1.0)
    for h in L["pcb"]["holes_mm"][:4]:
        body -= at(*h) * Cylinder(0.85, 2 * (DECK - 0.6), align=(Align.CENTER, Align.CENTER, Align.CENTER))

    # relief over the encoder bodies, which stand 6.5 mm off the PCB (1.5 mm into the deck)
    for e in L["encoders"]:
        body -= prism(at(*e["at"]) * RectangleRounded(EP["body_mm"][0] + 1.0, EP["body_mm"][1] + 1.0, 1.0), -1, 2.0)

    # wordmark cut 0.5 mm into the top, over the screen
    word = at(2.0, -2.2) * Text("keybordy", font_size=6.0, font="Arial Black", align=(Align.MIN, Align.CENTER))
    body -= prism(word, DECK - 0.5, DECK + 1)
    return body


# ── switch plate ──────────────────────────────────────────────────────────────

def plate() -> Part:
    c = 0.3
    body = prism(rrect(INNER[0] + c, INNER[1] + c, INNER[2] - c, INNER[3] - c, C["corner_r_mm"] - WALL - c), -PLATE, 0)
    holes = []
    for k in L["keys"]:
        cx, cy = key_center(k)
        holes.append(at(cx, cy) * RectangleRounded(14.1, 14.1, 0.25))
        if k.get("stab"):
            for dx in (-11.938, 11.938):
                holes.append(at(cx + dx, cy + 1.0) * RectangleRounded(6.75, 14.0, 0.6))
    for e in L["encoders"]:
        holes.append(at(*e["at"]) * RectangleRounded(14.2, 15.2, 1.0))
    o = L["oled"]
    holes.append(at(*o["at"]) * RectangleRounded(o["module_mm"][0] + 1, o["module_mm"][1] + 1, 1.0))
    holes.append(at(*L["mic"]["at"]) * Circle(1.5))
    holes.append(at(*L["mic_led"]["at"]) * Circle(1.5))
    for h in holes:
        body -= prism(h, -PLATE - 1, 1)
    # standoffs down to the PCB: the corners pass the M2, the centre one takes it
    for i, h in enumerate(L["pcb"]["holes_mm"]):
        body += at(*h, PCB_TOP) * Cylinder(2.75, PCB_TOP * -1 - PLATE + 0.01, align=(Align.CENTER, Align.CENTER, Align.MIN))
        if i < 4:
            body -= at(*h) * Cylinder(1.2, 40)
        else:
            body -= at(*h, PCB_TOP - 1) * Cylinder(0.85, (-0.5 - PCB_TOP) + 1, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return body


# ── keycaps ───────────────────────────────────────────────────────────────────
# The Zero Shot / Stream Deck cap that fits these switches
# (~/personal/projects/kodemotion-26/hardware/keycaps/keycap.scad), stretched to 1.5u and 2u.

CAP_H, EDGE_CH, WALL_CAP, ROOF = 9.0, 0.4, 1.5, 2.0
STEM_D, CROSS, SOCKET, MOUTH, RIB_T = 5.5, (4.10, 1.35), 5.05, 0.3, 0.8


def cap(w_u: float, glyph: str = "") -> Part:
    bw, bd = w_u * U - 1.05, 18.0
    tw, td = bw - 4.0, bd - 4.0
    lean = 2.0 / (CAP_H - EDGE_CH)
    body = loft([
        RectangleRounded(bw, bd, 1.4),
        Pos(0, 0, CAP_H - EDGE_CH) * RectangleRounded(tw, td, 1.0),
        Pos(0, 0, CAP_H) * RectangleRounded(tw - 2 * EDGE_CH, td - 2 * EDGE_CH, 1.0 - EDGE_CH * 0.5),
    ], ruled=True)
    h = CAP_H - ROOF
    hollow = loft([
        Pos(0, 0, -1) * RectangleRounded(bw - 2 * WALL_CAP + 2 * lean, bd - 2 * WALL_CAP + 2 * lean, 1.4),
        Pos(0, 0, h) * RectangleRounded(bw - 2 * WALL_CAP - 2 * lean * h, bd - 2 * WALL_CAP - 2 * lean * h, max(0.5, 1.4 - lean * h)),
    ], ruled=True)
    stems = [0.0] + ([-11.938, 11.938] if w_u >= 2 else [])
    rib_from = SOCKET + 0.35
    ribs = Pos(0, 0, rib_from) * Box(bw, RIB_T, CAP_H, align=(Align.CENTER, Align.CENTER, Align.MIN))
    for sx in stems:
        ribs += Pos(sx, 0, rib_from) * Box(RIB_T, bd, CAP_H, align=(Align.CENTER, Align.CENTER, Align.MIN))
    body -= hollow - (ribs & hollow)

    cross_a = Rectangle(*CROSS) + Rectangle(CROSS[1], CROSS[0])
    for sx in stems:
        stem = Pos(sx, 0, 0) * Cylinder(STEM_D / 2, h + 0.01, align=(Align.CENTER, Align.CENTER, Align.MIN))
        stem -= Pos(sx, 0, -1) * extrude(cross_a, SOCKET + 1)
        for r in (0, 90):
            stem -= Pos(sx, 0, 0) * Rot(Z=r) * loft([
                Pos(0, 0, -0.01) * Rectangle(CROSS[0] + 2 * MOUTH, CROSS[1] + 2 * MOUTH),
                Pos(0, 0, MOUTH) * Rectangle(*CROSS),
            ], ruled=True)
        body += stem

    if glyph == "mic":
        body -= prism(mic_glyph(), CAP_H - 0.5, CAP_H + 1)
    return body


def mic_glyph():
    """A microphone drawn in 0.7 mm strokes (design rules: 0.7 mm strokes, 0.5 mm deep on a top)."""
    s = 0.7
    g = Pos(0, 1.2) * (SlotOverall(7.0, 4.2, rotation=90) - SlotOverall(7.0 - 2 * s, 4.2 - 2 * s, rotation=90))
    arc = (Pos(0, 0.4) * (Circle(3.6) - Circle(3.6 - s))) & Pos(0, -3.0) * Rectangle(10, 6.0)
    return g + arc + Pos(0, -3.95) * Rectangle(s, 1.5) + Pos(0, -4.7) * Rectangle(3.4, s)


# ── knob ──────────────────────────────────────────────────────────────────────

BORE_D, BORE_FLAT, BORE_DEPTH = 6.1, 4.6, 12.0


def d_profile(d: float, flat: float):
    return Circle(d / 2) & Pos(flat - d / 2 - 20, 0) * Rectangle(40, d + 2)


def knob(bore_d: float = BORE_D, flat: float = BORE_FLAT, height: float | None = None) -> Part:
    R, H = EP["knob_d_mm"] / 2, height or EP["knob_h_mm"]
    n = 40
    pts = [((R if i % 2 == 0 else R - 0.4) * math.cos(math.pi * i / n),
            (R if i % 2 == 0 else R - 0.4) * math.sin(math.pi * i / n)) for i in range(2 * n)]
    body = extrude(Polygon(*pts, align=None), H)
    body = chamfer(body.faces().sort_by(Axis.Z)[-1].outer_wire().edges(), 0.6)
    body = chamfer(body.faces().sort_by(Axis.Z)[0].outer_wire().edges(), 0.4)
    depth = min(BORE_DEPTH, H - 2.0)
    body -= Pos(0, 0, -1) * extrude(d_profile(bore_d, flat), depth + 1)
    body -= loft([Pos(0, 0, -0.01) * d_profile(bore_d + 0.8, flat + 0.4), Pos(0, 0, 0.4) * d_profile(bore_d, flat)], ruled=True)
    # indicator groove on the top, over the flat
    body -= Pos(R / 2 - 0.2, 0, H - 0.5) * Box(R - 1.2, 0.8, 1.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return body


# ── fit tests ─────────────────────────────────────────────────────────────────

def fit_plate() -> Part:
    """A 2u slice of the plate: one switch hole and the stab cutouts, plus notches for orientation."""
    body = extrude(RectangleRounded(46, 24, 2), PLATE)
    body -= Pos(0, 0, -1) * extrude(RectangleRounded(14.1, 14.1, 0.25), 4)
    for dx in (-11.938, 11.938):
        body -= Pos(dx, -1.0, -1) * extrude(RectangleRounded(6.75, 14.0, 0.6), 4)
    return body


def fit_bores() -> Part:
    """Three short knobs, D-bores 6.0/4.5, 6.1/4.6, 6.2/4.7, marked by 1-3 notches on the rim."""
    parts = None
    for i, (d, f) in enumerate(((6.0, 4.5), (6.1, 4.6), (6.2, 4.7))):
        k = knob(d, f, height=10)
        for j in range(i + 1):
            a = math.radians(180 + (j - i / 2) * 20)
            k -= Pos(7.4 * math.cos(a), 7.4 * math.sin(a), 0) * Box(2.0, 2.0, 30)
        k = Pos(i * 20, 0, 0) * k
        parts = k if parts is None else parts + k
    return parts


# ── print orientation ─────────────────────────────────────────────────────────

def upside_down(p: Part) -> Part:
    p = Rot(X=180) * p
    return Pos(0, 0, -p.bounding_box().min.Z) * p


def floor_down(p: Part) -> Part:
    """Turn the tray so its floor lies on the bed."""
    p = Rot(X=TILT) * p
    return Pos(0, 0, -p.bounding_box().min.Z) * p


def on_bed(p: Part) -> Part:
    return Pos(0, 0, -p.bounding_box().min.Z) * p


PARTS = {
    # name: (builder, print orientation, filament, count)
    "fit_plate": (fit_plate, on_bed, "Gray", 1),
    "fit_bores": (fit_bores, upside_down, "Gray", 1),
    "cap1": (lambda: cap(1.0), upside_down, L["finish"]["keycaps"], sum(1 for k in L["keys"] if k["w"] == 1)),
    "cap15": (lambda: cap(1.5), upside_down, L["finish"]["mods"], sum(1 for k in L["keys"] if k["w"] == 1.5)),
    "cap2_talk": (lambda: cap(2.0, glyph="mic"), upside_down, L["finish"]["ptt"], sum(1 for k in L["keys"] if k["w"] == 2)),
    "knob": (knob, upside_down, L["finish"]["knobs"], len(L["encoders"])),
    "plate": (plate, upside_down, "Gray", 1),
    "deck": (deck, upside_down, L["finish"]["case"], 1),
    "tray": (tray, floor_down, L["finish"]["case"], 1),
}


def build(names: list[str]) -> dict[str, Part]:
    (OUT / "stl").mkdir(parents=True, exist_ok=True)
    (OUT / "step").mkdir(parents=True, exist_ok=True)
    built = {}
    for name in names:
        fn, orient, _, _ = PARTS[name]
        part = fn()
        assert part.is_valid, f"{name}: invalid solid"
        built[name] = part
        export_step(part, str(OUT / "step" / f"{name}.step"))
        export_stl(orient(part), str(OUT / "stl" / f"{name}.stl"), tolerance=0.01, angular_tolerance=0.1)
        bb = orient(part).bounding_box()
        print(f"  {name:10s} {bb.size.X:6.1f} x {bb.size.Y:6.1f} x {bb.size.Z:5.1f} mm  {part.volume / 1000:6.1f} cm³")
    return built


if __name__ == "__main__":
    names = sys.argv[1:] or list(PARTS)
    build(names)
