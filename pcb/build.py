"""Generate, route and export the keybordy PCB.

Runs with KiCad's own Python, which ships the pcbnew module:

    just pcb-build   # place + route + fab
    build.py place   # footprints, nets, outline, silkscreen -> keybordy.kicad_pcb
    build.py route   # hand-planned tracks (no autorouter), then GND pours
    build.py fab     # DRC, Gerbers, drill, JLCPCB zip, renders in pcb/fab/

All coordinates are millimetres from the board's top-left corner, top view,
x right and y down. The DevKit lies on its side with USB at the left edge.

Routing: keys on F.Cu, fanned out from the DevKit's near row (J2) through the
gaps between key columns. OLED I2C and 3V3 on F.Cu along the top. Rotary on
B.Cu down the right side. GND is a pour on both layers; every GND pad is
through-hole, so each one ties the two pours together.
"""

import json
import os
import subprocess
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
BOARD_FILE = os.path.join(HERE, "keybordy.kicad_pcb")
KICAD_FP = os.environ.get(
    "KICAD_FP", os.path.expanduser("~/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints"))
LOCAL_FP = os.path.join(HERE, "keybordy.pretty")

# Board origin on the KiCad page, so the board does not sit on the frame corner.
OX, OY = 50.0, 50.0

W, H = 111.5, 72.6        # board outline
CORNER_R = 2.0

U = 19.05                 # MX key pitch
GRID_X0, GRID_Y0 = 3.0, 31.5

# DevKit V1 (DOIT, 30 pins) seen from the top with USB at the left. The top
# row is the side with VIN, the bottom row the side with 3V3; index 0 is the
# USB end. Rows are 25.4 mm apart (measured on the bench board).
DEVKIT_X0 = 9.5           # x of the pins at the USB end
DEVKIT_TOP_Y, DEVKIT_ROW_SPACING = 3.0, 25.4
DEVKIT_TOP = ["VIN", "GND", "D13", "D12", "D14", "D27", "D26", "D25",
              "D33", "D32", "D35", "D34", "VN", "VP", "EN"]
DEVKIT_BOTTOM = ["3V3", "GND", "D15", "D2", "D4", "RX2", "TX2", "D5",
                 "D18", "D19", "D21", "RX0", "TX0", "D22", "D23"]
# The DevKit body overhangs its pins by 10.3 mm at the USB end, 5.6 at the antenna end.
DEVKIT_USB_OVERHANG, DEVKIT_ANT_OVERHANG = 10.3, 5.6

# Leg A of each switch. These are the 8 usable pins on J2, the row nearest the
# keys, ordered so the tracks fan out without crossing. Leg B goes to GND.
KEYS = {"K1": "RX2", "K2": "D18", "K3": "D21", "K4": "D23",
        "K5": "D4", "K6": "TX2", "K7": "D19", "K8": "D22"}

# SSD1306 0.96" module, 27.3 x 27.8 mm, pins along its top edge.
OLED_X, OLED_Y = 81.5, 1.5            # module top-left
OLED_W, OLED_H = 27.3, 27.8
OLED_PIN_Y = 3.0
OLED_PINS = [("GND", "GND"), ("VCC", "+3V3"), ("SCL", "D32"), ("SDA", "D33")]

# KY-040 module lying flat, knob up, its right-angle pins pointing down into a
# horizontal socket. Pin order seen from the top, left to right.
ROT_PIN_Y = 68.5
ROT_PINS = [("CLK", "D35"), ("DT", "D34"), ("SW", "VN"), ("+", "+3V3"), ("GND", "GND")]
ROT_W, ROT_H = 19.0, 27.0             # module outline above the socket

HOLES = [(3.0, H - 3.0), (W - 3.0, H - 3.0), (W - 3.0, 31.4), (58.0, 13.5),
         (GRID_X0 + 2 * U, GRID_Y0 + U)]

SIGNAL_NETS = {f"KEY{k[1]}": pin for k, pin in KEYS.items()}
SIGNAL_NETS.update({"OLED_SCL": "D32", "OLED_SDA": "D33",
                    "ROT_CLK": "D35", "ROT_DT": "D34", "ROT_SW": "VN"})
PIN_TO_NET = {pin: net for net, pin in SIGNAL_NETS.items()}
PIN_TO_NET.update({"GND": "GND", "3V3": "+3V3", "+3V3": "+3V3"})

KICAD_CLI = os.environ.get(
    "KICAD_CLI", os.path.expanduser("~/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"))


def mm(x, y):
    return pcbnew.VECTOR2I_MM(OX + x, OY + y)


def key_center(i):
    """Center of key i (0-based): K1..K4 top row, K5..K8 bottom row."""
    col, row = i % 4, i // 4
    return GRID_X0 + U / 2 + col * U, GRID_Y0 + U / 2 + row * U


def devkit_pin(name, row):
    pins = DEVKIT_TOP if row == "top" else DEVKIT_BOTTOM
    y = DEVKIT_TOP_Y if row == "top" else DEVKIT_TOP_Y + DEVKIT_ROW_SPACING
    return DEVKIT_X0 + pins.index(name) * 2.54, y


class Builder:
    def __init__(self):
        self.board = pcbnew.NewBoard(BOARD_FILE)
        self.nets = {}

    def net(self, name):
        if name not in self.nets:
            n = pcbnew.NETINFO_ITEM(self.board, name)
            self.board.Add(n)
            self.nets[name] = n
        return self.nets[name]

    def footprint(self, lib, name, ref, x, y, deg=0, back=False, value=None):
        libdir = LOCAL_FP if lib == "local" else os.path.join(KICAD_FP, lib + ".pretty")
        fp = pcbnew.FootprintLoad(libdir, name)
        if fp is None:
            sys.exit(f"footprint {lib}:{name} not found")
        fp.SetReference(ref)
        fp.SetValue(value or name)
        fp.Value().SetVisible(False)
        self.board.Add(fp)
        fp.SetPosition(mm(x, y))
        fp.SetOrientationDegrees(deg)
        if back:
            fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_LEFT_RIGHT)
        return fp

    def text(self, s, x, y, size=1.0, layer=pcbnew.F_SilkS, deg=0, bold=False, justify=None):
        t = pcbnew.PCB_TEXT(self.board)
        t.SetText(s)
        t.SetPosition(mm(x, y))
        t.SetLayer(layer)
        t.SetTextSize(pcbnew.VECTOR2I_MM(size, size))
        t.SetTextThickness(pcbnew.FromMM(size * (0.2 if bold else 0.15)))
        t.SetTextAngleDegrees(deg)
        if layer in (pcbnew.B_SilkS, pcbnew.B_Cu):
            t.SetMirrored(True)
        if justify == "left":
            t.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_LEFT)
        elif justify == "right":
            t.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_RIGHT)
        self.board.Add(t)

    def line(self, x1, y1, x2, y2, layer=pcbnew.F_SilkS, width=0.15):
        s = pcbnew.PCB_SHAPE(self.board, pcbnew.SHAPE_T_SEGMENT)
        s.SetStart(mm(x1, y1))
        s.SetEnd(mm(x2, y2))
        s.SetLayer(layer)
        s.SetWidth(pcbnew.FromMM(width))
        self.board.Add(s)

    def rect(self, x1, y1, x2, y2, layer=pcbnew.F_SilkS, width=0.15):
        for a, b, c, d in ((x1, y1, x2, y1), (x2, y1, x2, y2), (x2, y2, x1, y2), (x1, y2, x1, y1)):
            self.line(a, b, c, d, layer, width)

    def arc(self, cx, cy, sx, sy, deg, layer=pcbnew.Edge_Cuts, width=0.1):
        s = pcbnew.PCB_SHAPE(self.board, pcbnew.SHAPE_T_ARC)
        s.SetCenter(mm(cx, cy))
        s.SetStart(mm(sx, sy))
        s.SetArcAngleAndEnd(pcbnew.EDA_ANGLE(deg, pcbnew.DEGREES_T), True)
        s.SetLayer(layer)
        s.SetWidth(pcbnew.FromMM(width))
        self.board.Add(s)

    def pad_net(self, fp, number, net):
        hit = [p for p in fp.Pads() if p.GetNumber() == str(number)]
        if not hit:
            sys.exit(f"{fp.GetReference()} has no pad {number}")
        for p in hit:
            p.SetNet(self.net(net))


def setup_rules(board):
    """JLCPCB 2-layer standard capabilities, with margin."""
    ds = board.GetDesignSettings()
    ds.SetCopperLayerCount(2)
    ds.m_TrackMinWidth = pcbnew.FromMM(0.15)
    ds.m_MinClearance = pcbnew.FromMM(0.15)
    ds.m_ViasMinSize = pcbnew.FromMM(0.5)
    ds.m_MinThroughDrill = pcbnew.FromMM(0.3)
    # 0.45, not JLCPCB's nominal 0.5: the standard MX hotswap footprint has 0.46 mm
    # between a switch pin hole and the 5-pin peg hole, and is fabbed there routinely.
    ds.m_HoleToHoleMin = pcbnew.FromMM(0.45)
    ds.m_CopperEdgeClearance = pcbnew.FromMM(0.3)
    ds.m_SilkClearance = pcbnew.FromMM(0)
    nc = ds.m_NetSettings.GetDefaultNetclass()
    nc.SetTrackWidth(pcbnew.FromMM(0.3))
    nc.SetClearance(pcbnew.FromMM(0.2))
    nc.SetViaDiameter(pcbnew.FromMM(0.7))
    nc.SetViaDrill(pcbnew.FromMM(0.35))


def place():
    b = Builder()
    board = b.board
    setup_rules(board)
    for name in ["GND", "+3V3", *SIGNAL_NETS]:
        b.net(name)

    # Outline: rectangle with rounded corners.
    r = CORNER_R
    b.line(r, 0, W - r, 0, pcbnew.Edge_Cuts, 0.1)
    b.line(W, r, W, H - r, pcbnew.Edge_Cuts, 0.1)
    b.line(W - r, H, r, H, pcbnew.Edge_Cuts, 0.1)
    b.line(0, H - r, 0, r, pcbnew.Edge_Cuts, 0.1)
    b.arc(r, r, 0, r, 90)
    b.arc(W - r, r, W - r, 0, 90)
    b.arc(W - r, H - r, W, H - r, 90)
    b.arc(r, H - r, r, H, 90)

    # Keys: Kailh MX hotswap sockets on the back. The footprint is drawn from
    # the back, so flipping it puts the MX pins where a top-view MX expects them.
    for i, k in enumerate(KEYS):
        x, y = key_center(i)
        fp = b.footprint("local", "SW_MX_HS_CPG151101S11_1u", k, x, y, back=True, value="Kailh MX hotswap")
        b.pad_net(fp, 1, f"KEY{k[1]}")
        b.pad_net(fp, 2, "GND")
        b.text(k, x - U / 2 + 1.0, y - U / 2 + 1.2, 1.0, justify="left", bold=True)

    # DevKit: two 1x15 female headers. The stock footprint runs pin 1 to 15 down
    # +y; rotated -90 it runs along +x from the USB end.
    for ref, row, names in (("J1", "top", DEVKIT_TOP), ("J2", "bottom", DEVKIT_BOTTOM)):
        x0, y0 = devkit_pin(names[0], row)
        fp = b.footprint("Connector_PinSocket_2.54mm", "PinSocket_1x15_P2.54mm_Vertical",
                         ref, x0, y0, deg=90, value=f"DevKit {row} row")
        for n, name in enumerate(names, start=1):
            if name in PIN_TO_NET:
                b.pad_net(fp, n, PIN_TO_NET[name])
            px, py = devkit_pin(name, row)
            ly = py + (2.0 if row == "top" else -2.0)
            b.text(name, px, ly, 0.8, deg=90, justify="right" if row == "top" else "left")

    # DevKit outline on silk, with the USB end marked.
    x_usb = DEVKIT_X0 - DEVKIT_USB_OVERHANG
    x_ant = DEVKIT_X0 + 14 * 2.54 + DEVKIT_ANT_OVERHANG
    y_a = DEVKIT_TOP_Y - 1.75     # a little wider than the board, clear of the header silk
    y_b = DEVKIT_TOP_Y + DEVKIT_ROW_SPACING + 1.75
    b.line(max(x_usb, 0.3), y_a, x_ant, y_a)
    b.line(x_ant, y_a, x_ant, y_b)
    b.line(x_ant, y_b, max(x_usb, 0.3), y_b)
    mid = DEVKIT_TOP_Y + DEVKIT_ROW_SPACING / 2
    b.text("USB", 4.2, mid, 1.2, deg=90, bold=True)
    b.text("ESP32 DevKit V1 - chip up, USB this side", 22.5, mid, 1.0)
    b.text("rows 25.4 mm apart", 22.5, mid + 2.0, 0.8)

    # OLED: 1x4 female header, module above it.
    pins_x0 = OLED_X + OLED_W / 2 - 1.5 * 2.54
    fp = b.footprint("Connector_PinSocket_2.54mm", "PinSocket_1x04_P2.54mm_Vertical",
                     "J3", pins_x0, OLED_PIN_Y, deg=90, value="SSD1306 OLED")
    for n, (label, net) in enumerate(OLED_PINS, start=1):
        b.pad_net(fp, n, PIN_TO_NET.get(net, net))
        b.text(label, pins_x0 + (n - 1) * 2.54, OLED_PIN_Y + 2.2, 0.8, deg=90, justify="right")
    b.rect(OLED_X, OLED_Y, OLED_X + OLED_W, OLED_Y + OLED_H)
    b.text("OLED 128x64 I2C", OLED_X + OLED_W / 2, OLED_Y + OLED_H / 2, 1.0)

    # Rotary: 1x5 right-angle female header, opening facing up, module lies flat
    # above it. Rotated -90 the body points up, so pin 1 is the rightmost pin.
    rx0 = OLED_X + OLED_W / 2 - 2 * 2.54
    fp = b.footprint("Connector_PinSocket_2.54mm", "PinSocket_1x05_P2.54mm_Horizontal",
                     "J4", rx0 + 4 * 2.54, ROT_PIN_Y, deg=-90, value="KY-040 rotary")
    for j, (label, net) in enumerate(ROT_PINS):
        b.pad_net(fp, 5 - j, PIN_TO_NET.get(net, net))
        b.text(label, rx0 + j * 2.54, ROT_PIN_Y + 1.9, 0.8)
    cx = rx0 + 2 * 2.54
    top = ROT_PIN_Y - 10.0 - ROT_H
    b.line(cx - ROT_W / 2, ROT_PIN_Y - 11.0, cx - ROT_W / 2, top)    # open at the bottom, over the socket
    b.line(cx - ROT_W / 2, top, cx + ROT_W / 2, top)
    b.line(cx + ROT_W / 2, top, cx + ROT_W / 2, ROT_PIN_Y - 11.0)
    b.text("KY-040 knob up", cx, top + ROT_H / 2, 1.0)

    for i, (x, y) in enumerate(HOLES, start=1):
        fp = b.footprint("MountingHole", "MountingHole_2.2mm_M2", f"H{i}", x, y, value="M2")
        fp.Reference().SetVisible(False)

    b.text("keybordy", 66.0, 24.0, 2.2, bold=True)
    b.text("rev A  2026-10", 66.0, 27.4, 0.9)
    b.text("keybordy rev A - Kailh MX hotswap sockets on this side", 41.1, H - 1.6, 1.0, layer=pcbnew.B_SilkS)

    board.Save(BOARD_FILE)
    report(board)


def report(board):
    """Print every connector pad with its net and position, to check against the pin map."""
    for fp in sorted(board.GetFootprints(), key=lambda f: f.GetReference()):
        if not fp.GetReference().startswith("J"):
            continue
        for p in sorted(fp.Pads(), key=lambda p: int(p.GetNumber())):
            pos = p.GetPosition()
            print(f"{fp.GetReference()}.{p.GetNumber():>2} {p.GetNetname() or '-':10}"
                  f" x={pcbnew.ToMM(pos.x) - OX:6.2f} y={pcbnew.ToMM(pos.y) - OY:6.2f}")


def gnd_zones(board, net):
    for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
        z = pcbnew.ZONE(board)
        z.SetLayer(layer)
        z.SetNet(net)
        z.SetLocalClearance(pcbnew.FromMM(0.3))
        z.SetMinThickness(pcbnew.FromMM(0.25))
        z.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL)
        z.SetThermalReliefGap(pcbnew.FromMM(0.4))
        z.SetThermalReliefSpokeWidth(pcbnew.FromMM(0.5))
        z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
        o = z.Outline()
        o.NewOutline()
        for x, y in ((0, 0), (W, 0), (W, H), (0, H)):
            o.Append(mm(x, y))
        board.Add(z)


def route():
    board = pcbnew.LoadBoard(BOARD_FILE)
    for z in list(board.Zones()):
        board.Remove(z)
    for t in list(board.GetTracks()):
        board.Remove(t)
    fps = {f.GetReference(): f for f in board.GetFootprints()}

    def pad(ref, number):
        """Position of a footprint's through-hole pad, in board coordinates."""
        for p in fps[ref].Pads():
            if p.GetNumber() == str(number) and p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH:
                pos = p.GetPosition()
                return pcbnew.ToMM(pos.x) - OX, pcbnew.ToMM(pos.y) - OY
        sys.exit(f"{ref} has no through-hole pad {number}")

    def path(net, layer, pts, width=0.3):
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            t = pcbnew.PCB_TRACK(board)
            t.SetStart(mm(x1, y1))
            t.SetEnd(mm(x2, y2))
            t.SetWidth(pcbnew.FromMM(width))
            t.SetLayer(layer)
            t.SetNet(board.FindNet(net))
            board.Add(t)

    def via(net, x, y):
        v = pcbnew.PCB_VIA(board)
        v.SetPosition(mm(x, y))
        v.SetWidth(pcbnew.FromMM(0.7))
        v.SetDrill(pcbnew.FromMM(0.35))
        v.SetNet(board.FindNet(net))
        board.Add(v)

    # Keys, F.Cu. Each track drops from its J2 pin to a lane under the header,
    # runs sideways, then down to the switch. Bottom-row keys go down a gap
    # between key columns (or the left edge for K5) to y=47, the clear band
    # between the rows, then across and down to the switch pin. Lane depths
    # are ordered so no two tracks cross.
    lanes = {"K5": 30.0, "K1": 30.8, "K2": 30.0, "K4": 30.0, "K8": 30.8, "K3": 31.6, "K7": 32.4}
    gaps = {"K5": 5.0, "K6": None, "K7": GRID_X0 + 2 * U - 1.1, "K8": GRID_X0 + 3 * U - 0.15}
    between_rows = 47.0
    for k, pin in KEYS.items():
        sx, sy = devkit_pin(pin, "bottom")
        tx, ty = pad(k, 1)
        net = f"KEY{k[1]}"
        if int(k[1]) <= 4:
            path(net, pcbnew.F_Cu, [(sx, sy), (sx, lanes[k]), (tx, lanes[k]), (tx, ty)])
        elif k == "K5":
            gx = gaps[k]
            path(net, pcbnew.F_Cu, [(sx, sy), (sx, lanes[k]), (gx, lanes[k]), (gx, ty), (tx, ty)])
        elif gaps[k] is None:   # K6: its pin already sits in the gap between columns 1 and 2
            path(net, pcbnew.F_Cu, [(sx, sy), (sx, between_rows), (tx, between_rows), (tx, ty)])
        else:
            gx = gaps[k]
            path(net, pcbnew.F_Cu, [(sx, sy), (sx, lanes[k]), (gx, lanes[k]), (gx, between_rows),
                                    (tx, between_rows), (tx, ty)])

    # OLED I2C, F.Cu: down from J1, along the top, up into J3. SDA wraps SCL.
    for net, pin, label, lane in (("OLED_SCL", "D32", "SCL", 6.5), ("OLED_SDA", "D33", "SDA", 8.0)):
        sx, sy = devkit_pin(pin, "top")
        tx, ty = pad("J3", 1 + [l for l, _ in OLED_PINS].index(label))
        path(net, pcbnew.F_Cu, [(sx, sy), (sx, lane), (tx, lane), (tx, ty)])

    # 3V3, F.Cu: up from J2 pin 1 under the DevKit, along y=10, down the right
    # side to the rotary. The OLED's VCC sits between GND and SCL, so it is fed
    # from below on B.Cu through a via.
    sx, sy = devkit_pin("3V3", "bottom")
    vx, vy = pad("J3", 2)
    rx, ry = pad("J4", 5 - [l for l, _ in ROT_PINS].index("+"))
    path("+3V3", pcbnew.F_Cu, [(sx, sy), (sx, 10.0), (rx, 10.0), (rx, ry)], 0.5)
    via("+3V3", vx, 10.0)
    path("+3V3", pcbnew.B_Cu, [(vx, 10.0), (vx, vy)], 0.5)

    # Rotary, B.Cu: down from J1 to lanes under the DevKit, right to x 83-86,
    # down the right side past the keys, then across into J4. SW is innermost.
    rot = (("ROT_CLK", "D35", "CLK", 20.0, 83.0, 62.0),
           ("ROT_DT", "D34", "DT", 18.5, 84.5, 60.0),
           ("ROT_SW", "VN", "SW", 17.0, 86.0, 58.0))
    for net, pin, label, lane, gx, turn in rot:
        sx, sy = devkit_pin(pin, "top")
        tx, ty = pad("J4", 5 - [l for l, _ in ROT_PINS].index(label))
        path(net, pcbnew.B_Cu, [(sx, sy), (sx, lane), (gx, lane), (gx, turn), (tx, turn), (tx, ty)])

    gnd_zones(board, board.FindNet("GND"))
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    board.Save(BOARD_FILE)


def fab():
    out = os.path.join(HERE, "fab")
    os.makedirs(out, exist_ok=True)
    drc = os.path.join(out, "drc.json")
    subprocess.run([KICAD_CLI, "pcb", "drc", "--format", "json", "--severity-error", "--severity-warning",
                    "--refill-zones", "--save-board", "-o", drc, BOARD_FILE], check=False)
    with open(drc) as f:
        report_json = json.load(f)
    problems = len(report_json.get("violations", [])) + len(report_json.get("unconnected_items", []))
    if problems:
        sys.exit(f"DRC: {problems} problems, see {drc}")
    print("DRC: 0 violations, 0 unconnected")
    gerbers = os.path.join(out, "gerbers")
    os.makedirs(gerbers, exist_ok=True)
    for f in os.listdir(gerbers):
        os.remove(os.path.join(gerbers, f))
    layers = "F.Cu,B.Cu,F.SilkS,B.SilkS,F.Mask,B.Mask,F.Paste,B.Paste,Edge.Cuts"
    subprocess.run([KICAD_CLI, "pcb", "export", "gerbers", "--layers", layers, "--subtract-soldermask",
                    "--no-x2", "--use-drill-file-origin", "-o", gerbers, BOARD_FILE], check=True)
    subprocess.run([KICAD_CLI, "pcb", "export", "drill", "--format", "excellon", "--drill-origin", "absolute",
                    "--excellon-units", "mm", "--excellon-separate-th", "--generate-map", "--map-format", "gerberx2",
                    "-o", gerbers + "/", BOARD_FILE], check=True)
    zip_path = os.path.join(out, "keybordy-gerbers.zip")
    if os.path.exists(zip_path):
        os.remove(zip_path)
    subprocess.run(["zip", "-j", "-q", zip_path] + sorted(os.path.join(gerbers, f) for f in os.listdir(gerbers)),
                   check=True)
    for side in ("top", "bottom"):
        subprocess.run([KICAD_CLI, "pcb", "render", "--side", side, "--quality", "high", "-w", "1600", "-h", "1100",
                        "--background", "opaque", "-o", os.path.join(out, f"render-{side}.png"), BOARD_FILE],
                       check=False)
    subprocess.run([KICAD_CLI, "pcb", "export", "pdf", "--layers", "F.Cu,F.SilkS,Edge.Cuts",
                    "--include-border-title", "-o", os.path.join(out, "print-1to1-top.pdf"), BOARD_FILE], check=True)
    print(f"gerbers: {zip_path}\nDRC report: {drc}")


if __name__ == "__main__":
    {"place": place, "route": route, "fab": fab, "report": lambda: report(pcbnew.LoadBoard(BOARD_FILE))}[sys.argv[1]]()
