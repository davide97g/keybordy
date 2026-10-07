"""Put the printed parts and stand-in blocks for the electronics where they go, and report collisions.

    uv run python fitcheck.py

Stand-ins are boxes at the layout's positions: PCB, switch housings, caps (up and pressed), encoder
bodies and shafts, knobs, battery, speaker, ESP32 module, hotswap sockets, OLED module. Heights that
are not on a datasheet yet are marked; the check is only as good as them.
"""
from __future__ import annotations

import itertools
import sys

from build123d import Align, Box, Cylinder, Pos

import macropad as m

L, U = m.L, m.U
CAP_UP = 7.0          # cap skirt over the plate's top, key up (MX, estimated)
TRAVEL = 4.0
OLED_DEPTH = 5.0      # module thickness under the pocket (estimated; measure the module)


def block(lx, ly, w, d, z0, z1):
    return m.at(lx, ly, z0) * Box(w, d, z1 - z0, align=(Align.CENTER, Align.CENTER, Align.MIN))


def parts() -> dict:
    p = {"tray": m.tray(), "deck": m.deck(), "plate": m.plate()}
    po = L["pcb"]["outline_mm"]
    p["pcb"] = m.prism(m.rrect(*po, L["pcb"]["corner_r_mm"]), m.PCB_BOT, m.PCB_TOP)
    for h in L["pcb"]["holes_mm"]:
        p["pcb"] -= m.at(*h) * Cylinder(1.1, 40)
    cap = {1.0: m.cap(1.0), 1.5: m.cap(1.5), 2.0: m.cap(2.0, "mic")}
    caps_up = caps_down = housings = sockets = None
    for k in L["keys"]:
        cx, cy = m.key_center(k)
        up = m.at(cx, cy, CAP_UP) * cap[k["w"]]
        dn = m.at(cx, cy, CAP_UP - TRAVEL) * cap[k["w"]]
        hs = block(cx, cy, 15.6, 15.6, 0, 6.0) + block(cx, cy, 14.0, 14.0, m.PCB_TOP, -m.PLATE)
        so = block(cx - 0.6, cy - 3.8, 10.9, 5.9, m.PCB_BOT - 1.8, m.PCB_BOT)
        caps_up = up if caps_up is None else caps_up + up
        caps_down = dn if caps_down is None else caps_down + dn
        housings = hs if housings is None else housings + hs
        sockets = so if sockets is None else sockets + so
    p.update(caps_up=caps_up, caps_pressed=caps_down, switches=housings, sockets=sockets)
    ep = L["encoder_part"]
    shaft_top = m.PCB_TOP + ep["shaft_top_above_pcb_mm"]
    knob = m.knob()
    enc = knobs = None
    for e in L["encoders"]:
        b = block(*e["at"], *ep["body_mm"], m.PCB_TOP, m.PCB_TOP + 6.5) \
            + m.at(*e["at"], m.PCB_TOP + 6.5) * m.extrude(m.d_profile(6.0, 4.5), shaft_top - m.PCB_TOP - 6.5)
        k = m.at(*e["at"], shaft_top - m.BORE_DEPTH) * knob
        enc = b if enc is None else enc + b
        knobs = k if knobs is None else knobs + k
    p.update(encoders=enc, knobs=knobs)
    for name in ("battery", "speaker"):
        q = L[name]
        z0 = m.z_floor(-(q["at"][1] + q["box_mm"][1] / 2)) + m.FLOOR + 0.3   # level block on the high (front) edge
        p[name] = block(*q["at"], *q["box_mm"][:2], z0, z0 + q["box_mm"][2])
    mx, my = L["mcu"]["at"]
    p["esp32"] = block(mx, my + 2, 18.0, 25.5, m.PCB_BOT - 3.2, m.PCB_BOT)
    o = L["oled"]
    p["oled"] = block(*o["at"], *o["module_mm"], 1.0 - OLED_DEPTH, 1.0)
    return p


# Pairs that are meant to overlap in this simplified model.
EXPECTED = {
    frozenset({"caps_up", "caps_pressed"}), frozenset({"switches", "plate"}),
    frozenset({"switches", "caps_up"}), frozenset({"switches", "caps_pressed"}),
    frozenset({"sockets", "pcb"}), frozenset({"encoders", "pcb"}),
}


def main() -> int:
    p = parts()
    bad = 0
    for a, b in itertools.combinations(p, 2):
        if frozenset({a, b}) in EXPECTED:
            continue
        v = (p[a] & p[b]).volume
        if v > 0.5:
            bb = (p[a] & p[b]).bounding_box()
            print(f"  clash: {a} x {b}: {v:.1f} mm³ around x {bb.min.X:.1f}..{bb.max.X:.1f}, "
                  f"layout y {-bb.max.Y:.1f}..{-bb.min.Y:.1f}, z {bb.min.Z:.1f}..{bb.max.Z:.1f}")
            bad += 1
    print(f"{'PASS' if not bad else 'FAIL'} fit ({bad} clashes, {len(p)} parts)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
