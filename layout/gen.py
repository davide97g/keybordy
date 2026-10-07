#!/usr/bin/env python3
"""keybordy MP: lint the layout and pin map, generate what reads them.

    gen.py lint      layout/macropad.json + layout/pins.json against the ESP32-S3 module rules
    gen.py header    write firmware/macropad/main/board_pins.h
    gen.py check     lint, then fail if board_pins.h is stale
    gen.py preview   write layout/preview/keybordy-mp.html (3D concept render) from the template

Stdlib only. Exit code 0 only on PASS. `--json` prints {ok, problems, warnings, budget}.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
LAYOUT = HERE / "macropad.json"
PINS = HERE / "pins.json"
HEADER = REPO / "firmware" / "macropad" / "main" / "board_pins.h"
PREVIEW_IN = HERE / "preview" / "template.html"
PREVIEW_OUT = HERE / "preview" / "keybordy-mp.html"

# ESP32-S3-WROOM-1-N16R8: GPIOs bonded out to pads, and the ones that are spoken for.
MODULE = set(range(0, 22)) | set(range(35, 49))
USB = {19, 20}
PSRAM = {35, 36, 37}  # octal PSRAM on the R8 variant
STRAPS = {0, 3, 45, 46}
UART0 = {43, 44}
ADC1 = set(range(1, 11))  # ADC2 is unusable while Wi-Fi runs

SWITCH_BODY = 14.0      # MX housing footprint, mm
HOLE_CLEAR = 2.2        # screw head radius + margin from a switch body, mm
KNOB_GAP = 2.0          # minimum gap between two knobs, mm


class Report:
    def __init__(self) -> None:
        self.problems: list[str] = []
        self.warnings: list[str] = []

    def err(self, msg: str) -> None:
        self.problems.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)


def load() -> tuple[dict, dict]:
    return json.loads(LAYOUT.read_text()), json.loads(PINS.read_text())


# ── geometry ──────────────────────────────────────────────────────────────────

def key_rect(k: dict, u: float) -> tuple[float, float, float, float]:
    return (k["x"] * u, k["y"] * u, (k["x"] + k["w"]) * u, (k["y"] + k["h"]) * u)


def key_center(k: dict, u: float) -> tuple[float, float]:
    return ((k["x"] + k["w"] / 2) * u, (k["y"] + k["h"] / 2) * u)


def rect_c(c: list[float], size: list[float]) -> tuple[float, float, float, float]:
    return (c[0] - size[0] / 2, c[1] - size[1] / 2, c[0] + size[0] / 2, c[1] + size[1] / 2)


def overlap(a, b, eps: float = 1e-6) -> bool:
    return a[0] < b[2] - eps and b[0] < a[2] - eps and a[1] < b[3] - eps and b[1] < a[3] - eps


def inside(a, outer) -> bool:
    return a[0] >= outer[0] and a[1] >= outer[1] and a[2] <= outer[2] and a[3] <= outer[3]


def rect_dist(p: tuple[float, float], r) -> float:
    dx = max(r[0] - p[0], 0, p[0] - r[2])
    dy = max(r[1] - p[1], 0, p[1] - r[3])
    return math.hypot(dx, dy)


def lint_layout(L: dict, rep: Report) -> None:
    u = L["u_mm"]
    rows, cols = L["matrix"]["rows"], L["matrix"]["cols"]
    pcb = tuple(L["pcb"]["outline_mm"])
    slots: dict[tuple[int, int], str] = {}

    def take(slot: tuple[int, int], who: str) -> None:
        r, c = slot
        if not (0 <= r < rows and 0 <= c < cols):
            rep.err(f"{who}: matrix slot r{r} c{c} is outside the {rows}x{cols} matrix")
        elif slot in slots:
            rep.err(f"{who}: matrix slot r{r} c{c} already used by {slots[slot]}")
        else:
            slots[slot] = who

    ids = [k["id"] for k in L["keys"]]
    for dup in {i for i in ids if ids.count(i) > 1}:
        rep.err(f"key id {dup} is used twice")
    for i, k in enumerate(L["keys"]):
        if k["id"] != f"K{i + 1}":
            rep.warn(f"{k['id']} is entry {i + 1}: keep ids K1..Kn in order, the host keymap indexes them")
        take((k["row"], k["col"]), k["id"])
        for f in ("x", "y", "w", "h"):
            if abs(k[f] * 4 - round(k[f] * 4)) > 1e-9:
                rep.warn(f"{k['id']}: {f}={k[f]} is off the 0.25u grid")
        if k["w"] >= 2 and not k.get("stab"):
            rep.err(f"{k['id']}: {k['w']}u needs a stabilizer (\"stab\": true)")
        if k.get("stab") and k["w"] < 2:
            rep.warn(f"{k['id']}: stabilizer on a {k['w']}u key is unusual")
        if not inside(key_rect(k, u), pcb):
            rep.err(f"{k['id']}: outside the PCB outline")
    for i, a in enumerate(L["keys"]):
        for b in L["keys"][i + 1:]:
            if overlap(key_rect(a, u), key_rect(b, u)):
                rep.err(f"{a['id']} overlaps {b['id']}")

    ep = L["encoder_part"]
    knob_r = ep["knob_d_mm"] / 2
    oled = rect_c(L["oled"]["at"], L["oled"]["module_mm"])
    for e in L["encoders"]:
        take((e["push"]["row"], e["push"]["col"]), f"{e['id']} push")
        body = rect_c(e["at"], ep["body_mm"])
        if not inside(body, pcb):
            rep.err(f"{e['id']}: encoder body outside the PCB outline")
        for k in L["keys"]:
            if rect_dist(tuple(e["at"]), key_rect(k, u)) < knob_r:
                rep.err(f"{e['id']}: knob (⌀{ep['knob_d_mm']}) overlaps {k['id']}")
        if rect_dist(tuple(e["at"]), oled) < knob_r:
            rep.err(f"{e['id']}: knob overlaps the OLED module")
    for i, a in enumerate(L["encoders"]):
        for b in L["encoders"][i + 1:]:
            gap = math.dist(a["at"], b["at"]) - 2 * knob_r
            if gap < 0:
                rep.err(f"{a['id']} and {b['id']}: knobs overlap by {-gap:.1f} mm")
            elif gap < KNOB_GAP:
                rep.warn(f"{a['id']} and {b['id']}: only {gap:.1f} mm between knobs")
    for k in L["keys"]:
        if overlap(key_rect(k, u), oled):
            rep.err(f"{k['id']} overlaps the OLED module")

    for h in L["pcb"]["holes_mm"]:
        if not inside(rect_c(h, [L["pcb"]["hole_d_mm"]] * 2), pcb):
            rep.err(f"mounting hole {h} is outside the PCB outline")
        for k in L["keys"]:
            sw = rect_c(list(key_center(k, u)), [SWITCH_BODY, SWITCH_BODY])
            if rect_dist(tuple(h), sw) < HOLE_CLEAR:
                rep.err(f"mounting hole {h} is within {HOLE_CLEAR} mm of {k['id']}'s switch")

    for name in ("mic", "mic_led", "mcu"):
        at = L[name]["at"]
        if not (pcb[0] <= at[0] <= pcb[2] and pcb[1] <= at[1] <= pcb[3]):
            rep.err(f"{name} at {at} is outside the PCB outline")
    case_inner = (pcb[0] - L["case"]["gap_mm"], pcb[1] - L["case"]["gap_mm"],
                  pcb[2] + L["case"]["gap_mm"], pcb[3] + L["case"]["gap_mm"])
    for name in ("battery", "speaker"):
        box = L[name]["box_mm"]
        if not inside(rect_c(L[name]["at"], box[:2]), case_inner):
            rep.err(f"{name} does not fit inside the case walls")
        for h in L["pcb"]["holes_mm"]:
            r = L["pcb"]["pillar_d_mm"] / 2
            if rect_dist(tuple(h), rect_c(L[name]["at"], box[:2])) < r:
                rep.err(f"{name} hits the screw pillar at {h}")
    if math.dist(L["mic"]["at"], L["speaker"]["at"]) < 40:
        rep.warn("mic is under 40 mm from the speaker: expect feedback and amp noise")


# ── pins ──────────────────────────────────────────────────────────────────────

def pin_of(v) -> int | None:
    if isinstance(v, dict):
        return v.get("gpio")
    return v if isinstance(v, int) else None


def pin_entries(P: dict) -> list[tuple[str, int, dict]]:
    """(role, gpio, raw entry) for every GPIO in pins.json."""
    out: list[tuple[str, int, dict]] = []
    for i, g in enumerate(P["matrix"]["rows"]):
        out.append((f"row{i}", g, {}))
    for i, g in enumerate(P["matrix"]["cols"]):
        out.append((f"col{i}", g, {}))
    for eid, e in P["encoders"].items():
        out += [(f"{eid}.a", e["a"], {}), (f"{eid}.b", e["b"], {})]
    for k, v in P["i2s"].items():
        out.append((f"i2s.{k}", v, {}))
    for k, v in P["oled"].items():
        g = pin_of(v)
        if g is not None:
            out.append((f"oled.{k}", g, v if isinstance(v, dict) else {}))
    for k in ("amp_sd", "vbat_adc", "charge_stat", "mic_led", "boot_button"):
        v = P[k]
        out.append((k, pin_of(v), v if isinstance(v, dict) else {}))
    return out


def lint_pins(L: dict, P: dict, rep: Report) -> dict:
    entries = pin_entries(P)
    seen: dict[int, str] = {}
    for role, g, raw in entries:
        if g not in MODULE:
            rep.err(f"{role}: GPIO{g} is not a pad on the ESP32-S3-WROOM-1")
            continue
        if g in seen:
            rep.err(f"{role}: GPIO{g} already used by {seen[g]}")
        seen[g] = role
        if g in USB:
            rep.err(f"{role}: GPIO{g} is native USB D-/D+")
        if g in PSRAM:
            rep.err(f"{role}: GPIO{g} is wired to the octal PSRAM on N16R8")
        if g in STRAPS and role != "boot_button" and not raw.get("strap"):
            rep.err(f"{role}: GPIO{g} is a strapping pin; add a \"strap\" note on why its boot level is safe")
        if g in UART0 and not raw.get("note") and role != "charge_stat":
            rep.warn(f"{role}: GPIO{g} is UART0; the ROM prints on GPIO43 at boot")
    vbat = pin_of(P["vbat_adc"])
    if vbat not in ADC1:
        rep.err(f"vbat_adc: GPIO{vbat} is not on ADC1 (GPIO1-10); ADC2 stops working with Wi-Fi on")
    if len(P["matrix"]["rows"]) != L["matrix"]["rows"]:
        rep.err(f"pins.json has {len(P['matrix']['rows'])} rows, layout has {L['matrix']['rows']}")
    if len(P["matrix"]["cols"]) != L["matrix"]["cols"]:
        rep.err(f"pins.json has {len(P['matrix']['cols'])} cols, layout has {L['matrix']['cols']}")
    lay_enc = [e["id"] for e in L["encoders"]]
    if sorted(lay_enc) != sorted(P["encoders"]):
        rep.err(f"encoders differ: layout {lay_enc}, pins.json {sorted(P['encoders'])}")
    usable = MODULE - USB - PSRAM
    free = sorted(usable - set(seen))
    return {"used": len(seen), "usable": len(usable), "free": free}


# ── header ────────────────────────────────────────────────────────────────────

def c_list(xs) -> str:
    return "{" + ", ".join(str(x) for x in xs) + "}"


def render_header(L: dict, P: dict) -> str:
    rows, cols = L["matrix"]["rows"], L["matrix"]["cols"]
    keys, encs = L["keys"], L["encoders"]
    slot = [[-1] * cols for _ in range(rows)]
    for i, k in enumerate(keys):
        slot[k["row"]][k["col"]] = i
    for j, e in enumerate(encs):
        slot[e["push"]["row"]][e["push"]["col"]] = len(keys) + j
    o = P["oled"]
    res = pin_of(o["res"])
    lines = [
        "// Generated by layout/gen.py from layout/macropad.json and layout/pins.json.",
        "// Do not edit: change the JSON, then `just mp-gen`.",
        "#pragma once",
        "",
        "#include <stdint.h>",
        "",
        f"#define MATRIX_ROWS {rows}",
        f"#define MATRIX_COLS {cols}",
        f"#define MATRIX_{L['matrix']['diode']} 1",
        f"#define KEY_COUNT {len(keys)}",
        f"#define ENCODER_COUNT {len(encs)}",
        "",
        f"static const uint8_t MATRIX_ROW_PINS[MATRIX_ROWS] = {c_list(P['matrix']['rows'])};",
        f"static const uint8_t MATRIX_COL_PINS[MATRIX_COLS] = {c_list(P['matrix']['cols'])};",
        "",
        "// Slot -> event index: 0..KEY_COUNT-1 are K1..Kn, KEY_COUNT+e is encoder e's push, -1 is empty.",
        "static const int8_t MATRIX_SLOT[MATRIX_ROWS][MATRIX_COLS] = {",
        *[f"    {c_list(r)}," for r in slot],
        "};",
        "",
        "static const char *const KEY_IDS[KEY_COUNT] = {" + ", ".join(f'"{k["id"]}"' for k in keys) + "};",
        "static const char *const ENCODER_IDS[ENCODER_COUNT] = {" + ", ".join(f'"{e["id"]}"' for e in encs) + "};",
        f"static const uint8_t ENCODER_PIN_A[ENCODER_COUNT] = {c_list(P['encoders'][e['id']]['a'] for e in encs)};",
        f"static const uint8_t ENCODER_PIN_B[ENCODER_COUNT] = {c_list(P['encoders'][e['id']]['b'] for e in encs)};",
        "",
        f"#define PIN_I2S_BCLK {P['i2s']['bclk']}",
        f"#define PIN_I2S_WS {P['i2s']['ws']}",
        f"#define PIN_I2S_MIC_SD {P['i2s']['mic_sd']}",
        f"#define PIN_I2S_AMP_DIN {P['i2s']['amp_din']}",
        f"#define PIN_AMP_SD {pin_of(P['amp_sd'])}",
        "",
        f"#define PIN_OLED_SCK {pin_of(o['sck'])}",
        f"#define PIN_OLED_MOSI {pin_of(o['mosi'])}",
        f"#define PIN_OLED_CS {pin_of(o['cs'])}",
        f"#define PIN_OLED_DC {pin_of(o['dc'])}",
        f"#define PIN_OLED_RES {res if res is not None else -1}  // -1: tied to EN",
        "",
        f"#define PIN_VBAT_ADC {pin_of(P['vbat_adc'])}",
        f"#define PIN_CHARGE_STAT {pin_of(P['charge_stat'])}",
        f"#define PIN_MIC_LED {pin_of(P['mic_led'])}",
        f"#define PIN_BOOT {pin_of(P['boot_button'])}",
        "",
    ]
    return "\n".join(lines)


# ── commands ──────────────────────────────────────────────────────────────────

def run_lint(as_json: bool, extra: Report | None = None) -> int:
    L, P = load()
    rep = extra or Report()
    lint_layout(L, rep)
    budget = lint_pins(L, P, rep)
    ok = not rep.problems
    if as_json:
        print(json.dumps({"ok": ok, "problems": rep.problems, "warnings": rep.warnings, "budget": budget}, indent=2))
    else:
        for p in rep.problems:
            print(f"  error: {p}")
        for w in rep.warnings:
            print(f"  warn:  {w}")
        print(f"  pins:  {budget['used']} of {budget['usable']} usable GPIOs, free: "
              + (", ".join(map(str, budget["free"])) or "none"))
        print(f"{'PASS' if ok else 'FAIL'} lint ({len(rep.problems)} errors, {len(rep.warnings)} warnings)")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["lint", "header", "check", "preview"])
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    if a.cmd == "lint":
        return run_lint(a.json)
    if a.cmd == "header":
        L, P = load()
        HEADER.parent.mkdir(parents=True, exist_ok=True)
        HEADER.write_text(render_header(L, P))
        print(f"wrote {HEADER.relative_to(REPO)}")
        return 0
    if a.cmd == "check":
        rep = Report()
        L, P = load()
        if not HEADER.exists() or HEADER.read_text() != render_header(L, P):
            rep.err(f"{HEADER.relative_to(REPO)} is stale: run `just mp-gen`")
        return run_lint(a.json, rep)
    if a.cmd == "preview":
        L, _ = load()
        PREVIEW_OUT.write_text(PREVIEW_IN.read_text().replace("__LAYOUT__", json.dumps(L)))
        print(f"wrote {PREVIEW_OUT.relative_to(REPO)}")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
