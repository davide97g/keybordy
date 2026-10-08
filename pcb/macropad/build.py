"""Generate, route and export the keybordy MP PCB from layout/macropad.json and layout/pins.json.

Runs with KiCad's own Python, which ships the pcbnew module:

    just mp-pcb          # place + route + fab
    build.py place       # footprints, nets, outline, keep-outs, silkscreen -> keybordy-mp.kicad_pcb
    build.py route       # Freerouting (Specctra DSN/SES, ~/.local/share/freerouting), then GND pours
    build.py reroute     # re-import the last route.ses (after a re-place that kept the pads), then pours
    build.py fab         # DRC, Gerbers, drill, JLCPCB BOM + CPL, renders in pcb/macropad/fab/

Coordinates are the layout's: millimetres from the key field's top-left corner, x right,
y toward the user, top view. Every SMD part sits on the bottom (B.Cu), the side of the
hotswap sockets, so JLCPCB assembles one side. On top: the switches (plugged into the
sockets), the encoders, the OLED wire pads and the speaker pads, all hand-soldered.

The schematic lives in this file: `parts()` lists every footprint with its pads' nets.
"""

import json
import os
import shutil
import subprocess
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.dirname(HERE))
import kb  # noqa: E402

BOARD_FILE = os.path.join(HERE, "keybordy-mp.kicad_pcb")
FAB = os.path.join(HERE, "fab")
L = json.load(open(os.path.join(REPO, "layout", "macropad.json")))
P = json.load(open(os.path.join(REPO, "layout", "pins.json")))
U = L["u_mm"]
BACK, TOP = True, False

# ESP32-S3-WROOM-1 pad number of each GPIO (KiCad symbol RF_Module:ESP32-S3-WROOM-1).
MODULE_PAD = {4: 4, 5: 5, 6: 6, 7: 7, 15: 8, 16: 9, 17: 10, 18: 11, 8: 12, 19: 13, 20: 14, 3: 15, 46: 16,
              9: 17, 10: 18, 11: 19, 12: 20, 13: 21, 14: 22, 21: 23, 47: 24, 48: 25, 45: 26, 0: 27,
              35: 28, 36: 29, 37: 30, 38: 31, 39: 32, 40: 33, 41: 34, 42: 35, 44: 36, 43: 37, 2: 38, 1: 39}

# LCSC numbers (checked 2026-10-07 against JLCPCB's parts list; re-check stock before ordering).
LCSC = {
    "ESP32-S3-WROOM-1-N16R8": "C2913202", "TYPE-C-31-M-12": "C165948", "USBLC6-2SC6": "C7519",
    "BQ24075RGTR": "C15464", "AP2112K-3.3": "C51118", "MAX98357AETE+T": "C910544", "ICS-43434": "C5656610",
    "1N4148W": "C81598", "Kailh MX hotswap": "C41430893", "MSK12C02": "C431540", "TS-1187A": "C318884",
    "S2B-PH-SM4-TB": "C295747", "LTST-C230KRKT": "C125107",
    "10k": "C25804", "5.1k": "C23186", "1k": "C21190", "100k": "C25803", "1.8k": "C4177",
    "100nF": "C14663", "1uF": "C15849", "4.7uF": "C19666", "10uF": "C15850",    # 10uF is 0805 (C15850, 25 V); C19702 is 0603
}

R0603, C0603 = "Resistor_SMD:R_0603_1608Metric", "Capacitor_SMD:C_0603_1608Metric"

# Pour and routing classes: (track mm, clearance mm, net patterns).
NETCLASSES = {
    "Power": (0.5, 0.2, ["VBUS", "VSYS", "VBAT", "+3V3"]),
    "Speaker": (0.25, 0.2, ["SPK_P", "SPK_N"]),    # 0.5 mm-pitch amp pins
    "Ground": (0.4, 0.2, ["GND"]),
}


def gpio(v):
    return v if isinstance(v, int) else v["gpio"]


def module_nets():
    """Module pad -> net, from layout/pins.json."""
    m = P["matrix"]
    by_gpio = {}
    for i, g in enumerate(m["rows"]):
        by_gpio[g] = f"ROW{i}"
    for i, g in enumerate(m["cols"]):
        by_gpio[g] = f"COL{i}"
    for e, ab in P["encoders"].items():
        by_gpio[ab["a"]] = f"{e}A"
        by_gpio[ab["b"]] = f"{e}B"
    i2s = P["i2s"]
    by_gpio.update({i2s["bclk"]: "I2S_BCLK", i2s["ws"]: "I2S_WS", i2s["mic_sd"]: "MIC_SD", i2s["amp_din"]: "AMP_DIN"})
    by_gpio[gpio(P["amp_sd"])] = "AMP_SD"
    o = P["oled"]
    by_gpio.update({gpio(o["sck"]): "OLED_SCK", gpio(o["mosi"]): "OLED_MOSI", gpio(o["cs"]): "OLED_CS",
                    gpio(o["dc"]): "OLED_DC"})
    by_gpio[gpio(P["vbat_adc"])] = "VBAT_ADC"
    by_gpio[gpio(P["charge_stat"])] = "CHG_N"
    by_gpio[gpio(P["mic_led"])] = "MIC_LED"
    by_gpio[gpio(P["boot_button"])] = "BOOT"
    by_gpio.update({19: "USB_DN", 20: "USB_DP"})
    if o["res"] != "EN":
        sys.exit("pins.json: OLED RES is expected on EN")
    pads = {1: "GND", 40: "GND", 41: "GND", 2: "+3V3", 3: "EN"}
    for g, net in by_gpio.items():
        pads[MODULE_PAD[g]] = net
    return pads


def key_center(k):
    return (k["x"] + k["w"] / 2) * U, (k["y"] + k["h"] / 2) * U


class Part:
    def __init__(self, ref, fp, value, x, y, deg=0, back=BACK, pads=None, lcsc=None):
        self.ref, self.fp, self.value, self.x, self.y, self.deg, self.back = ref, fp, value, x, y, deg, back
        self.pads = pads or {}
        self.lcsc = lcsc if lcsc is not None else LCSC.get(value)


def R(ref, value, x, y, a, b, deg=0):
    return Part(ref, R0603, value, x, y, deg, pads={1: a, 2: b})


def C(ref, value, x, y, a, b="GND", deg=0):
    return Part(ref, C0603, value, x, y, deg, pads={1: a, 2: b})


def parts():
    out = []
    add = out.append

    # ── keys: hotswap socket on the back, diode under the lower half of the key ──
    rows, cols = L["matrix"]["rows"], L["matrix"]["cols"]
    for n, k in enumerate(L["keys"], start=1):
        cx, cy = key_center(k)
        add(Part(f"SW{n}", "local:SW_MX_HS_CPG151101S11_1u", "Kailh MX hotswap", cx, cy,
                 pads={1: f"KD{n}", 2: f"COL{k['col']}"}))
        add(Part(f"D{n}", "Diode_SMD:D_SOD-123", "1N4148W", cx, cy + 5.4, 0,
                 pads={1: f"ROW{k['row']}", 2: f"KD{n}"}))
    assert rows == 5 and cols == 6

    # ── encoders (top, hand-soldered), push in matrix row 4; pull-ups and diode inside the footprint ──
    for i, e in enumerate(L["encoders"], start=1):
        ex, ey = e["at"]
        en = e["id"]
        add(Part(en, "local:RotaryEncoder_Bourns_PEC11R_Vertical", "PEC11R-4220F-S0024", ex, ey, back=TOP,
                 pads={"A": f"{en}A", "B": f"{en}B", "C": "GND", "S1": f"COL{e['push']['col']}",
                       "S2": f"ED{i}"}, lcsc=""))
        add(R(f"R{40 + 2 * i}", "10k", ex - 3.6, ey - 2.5, "+3V3", f"{en}A"))
        add(R(f"R{41 + 2 * i}", "10k", ex - 3.6, ey + 2.5, "+3V3", f"{en}B"))
        add(Part(f"D{30 + i}", "Diode_SMD:D_SOD-123", "1N4148W", ex + 3.4, ey, 90,
                 pads={1: f"ROW{e['push']['row']}", 2: f"ED{i}"}))

    # ── ESP32-S3 module, antenna flush with the rear edge ──
    mx, my = L["mcu"]["at"]
    add(Part("U1", "RF_Module:ESP32-S3-WROOM-1", "ESP32-S3-WROOM-1-N16R8", mx, -6.0 + 12.75, pads=module_nets()))
    add(Part("C1", "Capacitor_SMD:C_0805_2012Metric", "10uF", 34.6, 2.0, 0, pads={1: "+3V3", 2: "GND"}))
    add(C("C2", "100nF", 34.6, 4.0, "+3V3"))
    add(R("R1", "10k", 34.6, 5.8, "+3V3", "EN"))
    add(C("C3", "1uF", 34.6, 7.6, "EN"))
    add(Part("SW30", "Button_Switch_SMD:SW_Push_1P1T_XKB_TS-1187A", "TS-1187A", 36.0, 15.5,
             pads={1: "EN", 2: "GND"}))
    add(R("R2", "10k", 9.6, 19.0, "+3V3", "BOOT", 90))
    add(Part("SW31", "Button_Switch_SMD:SW_Push_1P1T_XKB_TS-1187A", "TS-1187A", 5.0, 15.5,
             pads={1: "BOOT", 2: "GND"}))
    add(R("R3", "10k", 9.6, 8.5, "+3V3", "CHG_N", 90))
    add(R("R4", "100k", 7.6, 3.0, "VBAT", "VBAT_ADC", 90))
    add(R("R5", "100k", 9.6, 3.0, "VBAT_ADC", "GND", 90))
    add(C("C4", "100nF", 5.6, 3.0, "VBAT_ADC", deg=90))

    # ── 3V3 regulator ──
    add(Part("U4", "Package_TO_SOT_SMD:SOT-23-5", "AP2112K-3.3", 39.2, 4.2, 90,
             pads={1: "VSYS", 2: "GND", 3: "VSYS", 5: "+3V3"}))
    add(C("C5", "1uF", 39.2, 8.0, "VSYS"))
    add(C("C6", "1uF", 39.2, 1.2, "+3V3"))

    # ── USB-C, ESD, CC pull-downs ──
    ux, _ = L["usb_c"]["at"]
    usb = {p: "VBUS" for p in ("A4", "A9", "B4", "B9")}
    usb.update({p: "GND" for p in ("A1", "A12", "B1", "B12", "SH")})
    usb.update({"A5": "USB_CC1", "B5": "USB_CC2", "A6": "USB_DP", "B6": "USB_DP", "A7": "USB_DN", "B7": "USB_DN"})
    add(Part("J1", "Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12", "TYPE-C-31-M-12", ux, -6.5 + 3.65, 180,
             pads=usb))
    add(R("R6", "5.1k", ux - 3.9, 4.4, "USB_CC1", "GND", 90))
    add(R("R7", "5.1k", ux + 3.9, 4.4, "USB_CC2", "GND", 90))
    add(Part("U2", "Package_TO_SOT_SMD:SOT-23-6", "USBLC6-2SC6", ux, 6.6, 90,
             pads={1: "USB_DN", 6: "USB_DN", 3: "USB_DP", 4: "USB_DP", 2: "GND", 5: "VBUS"}))

    # ── charger: BQ24075, ILIM-programmed input (~860 mA), ~490 mA charge, no NTC (10k fixed) ──
    bx, by = 49.0, 11.5    # place() hand-routes stubs at fixed coordinates round U3: move them with it
    add(Part("U3", "Package_DFN_QFN:VQFN-16-1EP_3x3mm_P0.5mm_EP1.68x1.68mm", "BQ24075RGTR", bx, by, 0,
             pads={1: "TS", 2: "VBAT", 3: "VBAT", 4: "GND", 5: "VBUS", 6: "GND", 8: "GND", 9: "CHG_N",
                   10: "VSYS", 11: "VSYS", 12: "ILIM", 13: "VBUS", 15: "SYSOFF", 16: "ISET", 17: "GND"}))
    add(C("C7", "4.7uF", bx + 4.6, by - 2.6, "VBUS"))
    add(Part("C8", "Capacitor_SMD:C_0805_2012Metric", "10uF", bx + 4.6, by, 0, pads={1: "VSYS", 2: "GND"}))
    add(Part("C9", "Capacitor_SMD:C_0805_2012Metric", "10uF", bx + 4.6, by + 2.8, 0, pads={1: "VBAT", 2: "GND"}))
    add(R("R8", "1.8k", bx - 4.4, by - 2.0, "ISET", "GND"))
    add(R("R9", "1.8k", bx - 4.4, by, "ILIM", "GND"))
    add(R("R10", "10k", bx - 4.4, by + 2.0, "TS", "GND"))
    add(Part("J2", "Connector_JST:JST_PH_S2B-PH-SM4-TB_1x02-1MP_P2.00mm_Horizontal", "S2B-PH-SM4-TB", 46.0, 30.0, 0,
             pads={1: "GND", 2: "VBAT"}))

    # ── power switch: SYSOFF to GND runs from the battery, to VBAT cuts it off ──
    px, _ = next(s["at"] for s in L["switches"] if s["id"] == "PWR")
    add(Part("SW32", "Button_Switch_SMD:SW_SPDT_Shouhan_MSK12C02", "MSK12C02", px, -6.0 + 2.0, 180,
             pads={1: "GND", 2: "SYSOFF", 3: "VBAT"}))

    # ── mic: port through the board, VDD through the MIC switch, 1k in the shared clocks ──
    mcx, mcy = L["mic"]["at"]
    add(Part("U5", "Sensor_Audio:InvenSense_ICS-43434-6_3.5x2.65mm", "ICS-43434", mcx, mcy - 0.71, 0,
             pads={1: "MIC_WS", 2: "GND", 3: "GND", 4: "MIC_SCK", 5: "MIC_VDD", 6: "MIC_SD"}))
    add(C("C10", "100nF", mcx + 3.4, mcy - 1.6, "MIC_VDD", deg=90))
    add(R("R11", "1k", mcx - 3.6, mcy + 1.0, "I2S_WS", "MIC_WS", 90))
    add(R("R12", "1k", mcx + 5.2, mcy + 1.0, "I2S_BCLK", "MIC_SCK", 90))
    add(R("R13", "100k", mcx - 5.4, mcy + 1.0, "MIC_SD", "GND", 90))
    sx, _ = next(s["at"] for s in L["switches"] if s["id"] == "MIC")
    add(Part("SW33", "Button_Switch_SMD:SW_SPDT_Shouhan_MSK12C02", "MSK12C02", sx, -6.0 + 2.0, 180,
             pads={1: "+3V3", 2: "MIC_VDD", 3: "GND"}))

    # ── mic LED: reverse-mount, shines up through its hole ──
    lx, ly = L["mic_led"]["at"]
    add(Part("D30", "local:LED_1206_ReverseMount_LiteOn", "LTST-C230KRKT", lx, ly, 0,
             pads={1: "GND", 2: "LED_A"}))
    add(R("R14", "1k", lx + 4.0, ly - 1.0, "MIC_LED", "LED_A", 90))
    add(R("R15", "100k", lx + 5.8, ly - 1.0, "MIC_LED", "GND", 90))

    # ── amp next to the speaker; SD_MODE high picks the left channel ──
    ax, ay = 3.2, 96.6     # place() hand-routes stubs at fixed coordinates round U6: move them with it
    add(Part("U6", "Package_DFN_QFN:TQFN-16-1EP_3x3mm_P0.5mm_EP1.23x1.23mm", "MAX98357AETE+T", ax, ay, 0,
             pads={1: "AMP_DIN", 3: "GND", 4: "AMP_SD", 7: "VSYS", 8: "VSYS", 9: "SPK_P", 10: "SPK_N",
                   11: "GND", 14: "I2S_WS", 15: "GND", 16: "I2S_BCLK", 17: "GND"}))
    add(Part("C11", "Capacitor_SMD:C_0805_2012Metric", "10uF", ax - 0.2, ay + 3.8, 0, pads={1: "VSYS", 2: "GND"}))
    add(C("C12", "100nF", ax + 3.3, ay + 3.8, "VSYS"))

    # ── hand-soldered connections on top ──
    add(Part("J3", "Connector_PinHeader_2.54mm:PinHeader_1x07_P2.54mm_Vertical", "OLED wires", 75.5, -2.6, 90,
             back=TOP, pads={1: "+3V3", 2: "GND", 3: "OLED_MOSI", 4: "OLED_SCK", 5: "OLED_CS", 6: "OLED_DC", 7: "EN"},
             lcsc=""))
    add(Part("J4", "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical", "Speaker wires", -3.0, 95.0, 0,
             back=TOP, pads={1: "SPK_N", 2: "SPK_P"}, lcsc=""))
    return out


def place():
    # a .kicad_pro left by an earlier run crashes pcbnew's save once new netclasses are set
    for ext in (".kicad_pro", ".kicad_prl"):
        stale = BOARD_FILE.replace(".kicad_pcb", ext)
        if os.path.exists(stale):
            os.remove(stale)
    b = kb.Builder(BOARD_FILE, origin=(60.0, 60.0))
    board = b.board
    kb.setup_rules(board)
    x0, y0, x1, y1 = L["pcb"]["outline_mm"]
    b.rounded_outline(x0, y0, x1, y1, L["pcb"]["corner_r_mm"])

    for p in parts():
        lib, name = p.fp.split(":")
        fp = b.footprint(lib, name, p.ref, p.x, p.y, p.deg, p.back, p.value)
        for pad, net in p.pads.items():
            b.pad_net(fp, pad, net)
        if p.ref == "U1":
            tidy_module(fp)

    # GND vias in the exposed pads: heat out of the charger and amp, ground into the top pour.
    fps = {f.GetReference(): f for f in board.GetFootprints()}
    for ref, pad, n, pitch in (("U1", "41", 3, 1.2), ("U3", "17", 2, 0.9), ("U6", "17", 1, 0)):
        c = next(p for p in fps[ref].Pads() if p.GetNumber() == pad and p.GetAttribute() == pcbnew.PAD_ATTRIB_SMD)
        cx, cy = pcbnew.ToMM(c.GetPosition().x) - b.ox, pcbnew.ToMM(c.GetPosition().y) - b.oy
        for i in range(n):
            for j in range(n):
                v = pcbnew.PCB_VIA(board)
                v.SetPosition(b.mm(cx + (i - (n - 1) / 2) * pitch, cy + (j - (n - 1) / 2) * pitch))
                v.SetWidth(pcbnew.FromMM(0.6))
                v.SetDrill(pcbnew.FromMM(0.3))
                v.SetNet(b.net("GND"))
                v.SetLocked(True)
                board.Add(v)

    # Hand-routed stubs round the amp and the charger, where 0.5 mm pitch beats Freerouting: GND pins
    # into the exposed pads, amp outputs out to the speaker pads.
    for net, pts, w in (("GND", [(50.463, 12.25), (49.6, 12.25)], 0.2), ("GND", [(49.25, 12.963), (49.25, 12.1)], 0.2),
                        ("GND", [(48.25, 12.963), (48.25, 12.1)], 0.2),
                        ("GND", [(1.76, 96.35), (3.2, 96.35)], 0.2), ("GND", [(4.64, 96.85), (3.2, 96.85)], 0.2),
                        ("GND", [(3.45, 95.16), (3.45, 96.6)], 0.2),
                        ("SPK_N", [(1.76, 96.85), (0.9, 96.85), (-1.0, 95.0), (-3.0, 95.0)], 0.25),
                        ("SPK_P", [(1.76, 97.35), (0.9, 97.35), (-0.7, 97.54), (-3.0, 97.54)], 0.25)):
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            t = pcbnew.PCB_TRACK(board)
            t.SetStart(b.mm(x1, y1))
            t.SetEnd(b.mm(x2, y2))
            t.SetWidth(pcbnew.FromMM(w))
            t.SetLayer(pcbnew.B_Cu)
            t.SetNet(b.net(net))
            t.SetLocked(True)
            board.Add(t)

    # 2u talk bar: Cherry PCB-mount stabilizer holes.
    for k in L["keys"]:
        if k.get("stab"):
            cx, cy = key_center(k)
            for dx in (-11.938, 11.938):
                for dy, d in ((-6.985, 3.048), (8.255, 3.988)):
                    h = b.footprint("MountingHole", "MountingHole_2.2mm_M2",
                                    f"ST{len([f for f in board.GetFootprints() if f.GetReference().startswith('ST')]) + 1}",
                                    cx + dx, cy + dy, value="stab")
                    for pad in h.Pads():
                        pad.SetDrillSize(pcbnew.VECTOR2I_MM(d, d))
                        pad.SetSize(pcbnew.VECTOR2I_MM(d, d))
                    h.Reference().SetVisible(False)

    # Mounting holes, with room for the tray pillars below and the plate standoffs above.
    pr = L["pcb"]["pillar_d_mm"] / 2 + 0.2
    for i, (x, y) in enumerate(L["pcb"]["holes_mm"], start=1):
        fp = b.footprint("MountingHole", "MountingHole_2.2mm_M2", f"H{i}", x, y, value="M2")
        fp.Reference().SetVisible(False)

    # Antenna: no copper over the module's antenna end (flush with the rear edge) or 15 mm either side,
    # short of mounting hole H1 (no copper either).
    mx, _ = L["mcu"]["at"]
    b.keepout([pcbnew.F_Cu, pcbnew.B_Cu], [(-1.7, y0 - 1), (mx + 24, y0 - 1), (mx + 24, 0.2), (-1.7, 0.2)],
              footprints=True)
    check_pillars(board, b, pr)

    # No track over the mic LED's hole (Freerouting does not know NPTH-to-copper clearance).
    lx, ly = L["mic_led"]["at"]
    b.keepout([pcbnew.F_Cu, pcbnew.B_Cu], [(lx - 1.2, ly - 1.6), (lx + 1.2, ly - 1.6), (lx + 1.2, ly + 1.6),
                                          (lx - 1.2, ly + 1.6)], pads=True, footprints=True)

    silk(b)
    board.Save(BOARD_FILE)
    kb.write_netclasses(BOARD_FILE, NETCLASSES)
    print(f"placed {len(board.GetFootprints())} footprints, {board.GetNetCount() - 1} nets")


def check_pillars(board, b, r):
    """Nothing on the bottom may sit on a tray pillar (they press on the PCB round each screw hole)."""
    bad = []
    for fp in board.GetFootprints():
        if not fp.IsFlipped():
            continue
        box = fp.GetCourtyard(pcbnew.B_CrtYd).BBox()
        for x, y in L["pcb"]["holes_mm"]:
            cx, cy = pcbnew.ToMM(b.mm(x, y).x), pcbnew.ToMM(b.mm(x, y).y)
            dx = max(pcbnew.ToMM(box.GetLeft()) - cx, 0, cx - pcbnew.ToMM(box.GetRight()))
            dy = max(pcbnew.ToMM(box.GetTop()) - cy, 0, cy - pcbnew.ToMM(box.GetBottom()))
            if (dx * dx + dy * dy) ** 0.5 < r:
                bad.append(f"{fp.GetReference()} is within {r:.1f} mm of the hole at ({x}, {y})")
    if bad:
        sys.exit("\n".join(bad))


def tidy_module(fp):
    """The stock module footprint has 0.2 mm thermal vias (JLC's standard minimum is 0.3) and a wide
    antenna keep-out that also covers mounting hole H1; drop both (place() draws the keep-out again)."""
    for pad in list(fp.Pads()):
        if pad.GetAttribute() == pcbnew.PAD_ATTRIB_PTH and pcbnew.ToMM(pad.GetDrillSize().x) < 0.3:
            fp.Remove(pad)
    for z in list(fp.Zones()):    # place() draws its own antenna keep-out
        fp.Remove(z)
    # its courtyard spans the whole antenna keep-out; keep only the module body
    for g in list(fp.GraphicalItems()):
        if g.GetLayer() in (pcbnew.F_CrtYd, pcbnew.B_CrtYd):
            fp.Remove(g)
    layer = pcbnew.B_CrtYd if fp.IsFlipped() else pcbnew.F_CrtYd
    r = pcbnew.PCB_SHAPE(fp, pcbnew.SHAPE_T_RECT)
    c = fp.GetPosition()
    r.SetStart(pcbnew.VECTOR2I(c.x - pcbnew.FromMM(9.25), c.y - pcbnew.FromMM(12.95)))
    r.SetEnd(pcbnew.VECTOR2I(c.x + pcbnew.FromMM(9.25), c.y + pcbnew.FromMM(13.5)))
    r.SetLayer(layer)
    r.SetWidth(pcbnew.FromMM(0.05))
    fp.Add(r)


def silk(b):
    F, B = pcbnew.F_SilkS, pcbnew.B_SilkS
    for n, k in enumerate(L["keys"], start=1):
        cx, cy = key_center(k)
        b.text(k["id"], cx - k["w"] * U / 2 + 1.0, cy - U / 2 + 1.4, 1.0, justify="left", bold=True)
    b.text("keybordy MP", 30.75, -3.2 + 46.0, 2.0, layer=B, bold=True)
    b.text("rev A  2026-10  JLCPCB assembles this side", 30.75, 46.0, 0.9, layer=B)
    for i, lab in enumerate(("3V3", "GND", "DIN", "CLK", "CS", "DC", "RST")):
        b.text(lab, 75.5 + 2.54 * i, -0.6, 0.8, deg=90, justify="right")
    b.text("OLED", 83.1, -4.9, 0.9)
    b.text("SPK", -3.0, 92.4, 0.9)
    b.text("+", -1.2, 97.54, 1.0, bold=True)
    # J2 is flipped: pin 1 (GND) lands at x 47, pin 2 (VBAT) at x 45. One mark per pin.
    b.text("BAT", 46.0, 37.8, 1.0, layer=B, bold=True)
    b.text("+", 45.0, 36.3, 1.2, layer=B, bold=True)
    b.text("-", 47.0, 36.3, 1.2, layer=B, bold=True)
    b.text("PWR", L["switches"][0]["at"][0], -1.4, 0.9, layer=B)
    b.text("MIC", L["switches"][1]["at"][0], -1.4, 0.9, layer=B)
    b.text("RST", 36.0, 19.2, 0.9, layer=B)
    b.text("BOOT", 5.0, 19.2, 0.9, layer=B)
    b.text("BAT", 8.6, 6.2, 0.7, layer=B)


def route(reuse=False, tries=4):
    """Freerouting 1.9 is not deterministic here (0 to ~7 connections left per run), so route up to
    `tries` times and keep the session with the fewest unconnected items."""
    os.makedirs(FAB, exist_ok=True)
    ses, best_ses = os.path.join(HERE, "route.ses"), os.path.join(HERE, "route-best.ses")
    best = None
    for i in range(1 if reuse else tries):
        kb.freeroute(BOARD_FILE, HERE, reuse=reuse)
        # pcbnew's SWIG types break after a session import, so pour in a fresh interpreter
        subprocess.run([sys.executable, os.path.abspath(__file__), "pour"], check=True)
        _, _, unconnected = kb.drc(BOARD_FILE, FAB)
        print(f"route attempt {i + 1}: {len(unconnected)} unconnected")
        if best is None or len(unconnected) < best:
            best = len(unconnected)
            shutil.copy(ses, best_ses)
        if not unconnected:
            return
    if not reuse:
        shutil.copy(best_ses, ses)
        kb.freeroute(BOARD_FILE, HERE, reuse=True)
        subprocess.run([sys.executable, os.path.abspath(__file__), "pour"], check=True)


def pour():
    board = pcbnew.LoadBoard(BOARD_FILE)
    b = kb.Builder.__new__(kb.Builder)
    b.board, b.ox, b.oy, b.nets = board, 60.0, 60.0, {"GND": board.FindNet("GND")}
    # pcbnew's SWIG lists break once zones are removed or filled: gather what stitch() needs first
    # (vias may go under the encoders: their frames carry no net, and the pour there needs tying in)
    yards = [fp.GetCourtyard(layer).BBox() for fp in board.GetFootprints() if not fp.GetReference().startswith("E")
             for layer in (pcbnew.F_CrtYd, pcbnew.B_CrtYd) if fp.GetCourtyard(layer).OutlineCount()]
    gnd = board.FindNet("GND")
    have = {(v.GetPosition().x, v.GetPosition().y) for v in board.GetTracks() if v.GetClass() == "PCB_VIA"}
    for z in list(board.Zones()):
        if not z.GetIsRuleArea():
            board.Remove(z)
    x0, y0, x1, y1 = L["pcb"]["outline_mm"]
    ring = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    pours = [b.zone("GND", [pcbnew.F_Cu], ring, clearance=0.3), b.zone("GND", [pcbnew.B_Cu], ring, clearance=0.3)]
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    n = stitch(board, b, pours, yards, gnd, have, (x0, y0, x1, y1))
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    n += stitch_islands(board, b, pours, gnd)
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    board.Save(BOARD_FILE)
    print(f"GND poured on both layers, {n} stitching vias")


def via(board, pos, net):
    v = pcbnew.PCB_VIA(board)
    v.SetPosition(pos)
    v.SetWidth(pcbnew.FromMM(0.6))
    v.SetDrill(pcbnew.FromMM(0.3))
    v.SetNet(net)
    board.Add(v)


def stitch_islands(board, b, pours, gnd, ring=0.65):
    """One via into every pour fragment the grid missed, where both layers have copper for it."""
    fills = [pours[0].GetFilledPolysList(pcbnew.F_Cu), pours[1].GetFilledPolysList(pcbnew.B_Cu)]
    vias = [v.GetPosition() for v in board.GetTracks() if v.GetClass() == "PCB_VIA"]
    step = pcbnew.FromMM(0.25)
    n = 0
    for f in fills:
        for i in range(f.OutlineCount()):
            o = f.Outline(i)
            if any(o.PointInside(v) for v in vias):
                continue
            bb = o.BBox()
            done = False
            y = bb.GetTop()
            while y <= bb.GetBottom() and not done:
                x = bb.GetLeft()
                while x <= bb.GetRight() and not done:
                    r = pcbnew.FromMM(ring)
                    probe = [pcbnew.VECTOR2I(int(x + dx * r), int(y + dy * r)) for dx, dy in
                             ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1), (.7, .7), (-.7, .7), (.7, -.7), (-.7, -.7))]
                    if all(o.PointInside(q) for q in probe) and all(g.Contains(q) for g in fills for q in probe):
                        via(board, pcbnew.VECTOR2I(x, y), gnd)
                        vias.append(pcbnew.VECTOR2I(x, y))
                        n += 1
                        done = True
                    x += step
                y += step
    return n


def stitch(board, b, pours, yards, gnd, have, box, pitch=4.0, ring=0.65):
    """GND vias on a grid wherever both pours cover a via and its clearance, clear of every courtyard:
    ties the two layers together and joins pour islands that the tracks cut apart."""
    # the zones as created: after a fill, board.Zones() hands back untyped SWIG objects
    fills = [pours[0].GetFilledPolysList(pcbnew.F_Cu), pours[1].GetFilledPolysList(pcbnew.B_Cu)]
    x0, y0, x1, y1 = box
    n = 0
    y = y0 + 2.0
    while y < y1 - 1.5:
        x = x0 + 2.0
        while x < x1 - 1.5:
            p = b.mm(x, y)
            probe = [p] + [b.mm(x + ring * dx, y + ring * dy)
                           for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (.7, .7), (-.7, .7), (.7, -.7), (-.7, -.7))]
            if (p.x, p.y) not in have and all(f.Contains(q) for f in fills for q in probe) \
                    and not any(r.Contains(p) for r in yards):
                via(board, p, gnd)
                n += 1
            x += pitch
        y += pitch
    return n


def fab():
    os.makedirs(FAB, exist_ok=True)
    path, violations, unconnected = kb.drc(BOARD_FILE, FAB)
    silk = [v for v in violations if v["type"].startswith("silk") or v["type"] == "text_height"]
    # a thermal-relief pad with fewer spokes than KiCad likes; it is also on a routed GND track
    starved = [v for v in violations if v["type"] == "starved_thermal"]
    violations = [v for v in violations if v not in silk and v not in starved]
    if silk or starved:
        print(f"DRC: {len(silk)} silkscreen and {len(starved)} starved-thermal warnings, not blocking")
    if violations or unconnected:
        kinds = {}
        for v in violations:
            kinds[v["type"]] = kinds.get(v["type"], 0) + 1
        sys.exit(f"DRC: {len(violations)} violations {kinds}, {len(unconnected)} unconnected, see {path}")
    print("DRC: 0 violations, 0 unconnected")
    z = kb.gerbers(BOARD_FILE, FAB, "keybordy-mp-gerbers.zip")
    table = {p.ref: {"value": p.value, "footprint": p.fp, "lcsc": p.lcsc} for p in parts()}
    bom, cpl = kb.jlc_assembly(BOARD_FILE, FAB, "keybordy-mp", table)
    kb.renders(BOARD_FILE, FAB)
    print(f"gerbers: {z}\nBOM: {bom}\nCPL: {cpl}")


if __name__ == "__main__":
    {"place": place, "route": route, "reroute": lambda: route(reuse=True), "pour": pour, "fab": fab}[sys.argv[1]]()
