#!/usr/bin/env python3
"""Headless checks for a firmware/<name>/ project against the local simulator.

    simcheck.py lint  [name]              static: diagram.json vs sketch vs README
    simcheck.py run   [name] [--script S] compile, boot in QEMU, play S, print serial
    simcheck.py check [name]              lint, then tap every key and assert serial

The browser normally solves the circuit: it applies the pull-ups the firmware
enables and joins a switch's two nets while it is pressed. The QEMU worker
alone does neither (every INPUT_PULLUP pin reads LOW), so this script does
that job: it builds the nets from diagram.json, tracks each GPIO's direction,
output level and pull from the worker's events, and writes the resolved level
of every input with `set_pin`.

Stdlib only; runs on the host with Python 3.9+. `run` and `check` need the
`velxio` container up (`just sim-up`); `lint` does not.

Script steps, separated by `;`:
    wait MS                  let the firmware run
    press PART / release PART
    tap PART [HOLD_MS]       press, hold (default 120), release, settle 120 ms
    bounce PART [HOLD_MS]    tap with contact chatter on both edges
    cw PART [N] / ccw PART [N]   rotary encoder detents (wokwi-ky-040)
    until REGEX [MS]         wait for a serial line matching REGEX, default 20000 ms
    expect REGEX [MS]        same, default 2000 ms (fail on timeout either way)
    reject REGEX [MS]        fail if a line matching REGEX shows up within MS
PART is a part id (k1) or its label (K1). REGEX may be quoted.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import queue
import re
import shlex
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FIRMWARE = REPO / "firmware"
CACHE = REPO / "sim" / ".cache"
URL = os.environ.get("VELXIO_URL", "http://127.0.0.1:3080")
CONTAINER = os.environ.get("VELXIO_CONTAINER", "velxio")
FQBN = "esp32:esp32:esp32"
WORKER = ["/app/.venv/bin/python", "/app/app/services/esp32_worker.py"]
QEMU_LIB = "/app/lib/libqemu-xtensa.so"

BOOT_STRAPS = {0, 2, 5, 12, 15}
USB_SERIAL = {1, 3}
FLASH = set(range(6, 12))
INPUT_ONLY = set(range(34, 40))

# ── Diagram model ─────────────────────────────────────────────────────────────

ESP_NAMES = {"RX2": 16, "TX2": 17, "VN": 39, "VP": 36, "TX0": 1, "RX0": 3}


def esp_pin(name: str) -> int | str | None:
    """A wokwi-esp32-devkit-v1 pin name as a GPIO number, or GND / 3V3 / VIN."""
    if name.startswith("GND"):
        return "GND"
    if name in ("3V3", "VIN"):
        return name
    if name in ESP_NAMES:
        return ESP_NAMES[name]
    m = re.fullmatch(r"D(\d+)", name)
    return int(m.group(1)) if m else None


def pin_label(p: int | str) -> str:
    return f"GPIO{p}" if isinstance(p, int) else str(p)


# Pins of one part that are the same conductor.
def node_of(ptype: str, part: str, pin: str) -> str:
    if ptype == "wokwi-pushbutton":
        m = re.fullmatch(r"([12])\.[lr]", pin)
        if m:
            return f"{part}:{m.group(1)}"
    return f"{part}:{pin}"


@dataclass
class Diagram:
    path: Path
    parts: dict[str, dict]
    esp: str | None
    wires: list[tuple[str, str, str]]  # (node a, node b, color)
    esp_wire_count: dict[str, int] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> "Diagram":
        d = json.loads(path.read_text())
        parts = {p["id"]: p for p in d.get("parts", [])}
        esp = next((i for i, p in parts.items() if "esp32" in p["type"]), None)
        wires, count = [], {}
        for conn in d.get("connections", []):
            a, b, color = conn[0], conn[1], conn[2] if len(conn) > 2 else ""
            if a.startswith("$") or b.startswith("$"):
                continue
            ends = []
            for end in (a, b):
                part, _, pin = end.partition(":")
                if part == esp:
                    count[pin] = count.get(pin, 0) + 1
                ptype = parts.get(part, {}).get("type", "")
                ends.append(node_of(ptype, part, pin))
            wires.append((ends[0], ends[1], color))
        return cls(path, parts, esp, wires, count)

    def label(self, part: str) -> str:
        return self.parts[part].get("attrs", {}).get("label") or part

    def find_part(self, ref: str) -> str:
        for pid in self.parts:
            if pid == ref or self.label(pid) == ref:
                return pid
        for pid in self.parts:
            if pid.lower() == ref.lower() or self.label(pid).lower() == ref.lower():
                return pid
        raise SystemExit(f"no part {ref!r} in {self.path}")

    def of_type(self, ptype: str) -> list[str]:
        return [i for i, p in self.parts.items() if p["type"] == ptype]

    def buttons(self) -> list[str]:
        def key(pid: str):
            m = re.search(r"(\d+)$", self.label(pid))
            return (int(m.group(1)) if m else 1 << 30, pid)
        return sorted(self.of_type("wokwi-pushbutton"), key=key)

    def esp_node(self, node: str) -> int | str | None:
        part, _, pin = node.partition(":")
        return esp_pin(pin) if part == self.esp else None

    def nets(self, extra: list[tuple[str, str]] = ()) -> dict[str, str]:
        """Union-find over wires plus `extra` closed contacts: node -> root."""
        parent: dict[str, str] = {}

        def find(x: str) -> str:
            parent.setdefault(x, x)
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for a, b, *_ in list(self.wires) + list(extra):
            parent[find(a)] = find(b)
        # Every GND.<n> is one conductor; 3V3 and VIN are distinct supplies.
        gnds = [n for n in parent if self.esp_node(n) == "GND"]
        for g in gnds[1:]:
            parent[find(g)] = find(gnds[0])
        return {n: find(n) for n in list(parent)}

    def board_pins_on(self, node: str, nets: dict[str, str]) -> list[int | str]:
        root = nets.get(node)
        if root is None:
            return []
        return [p for n, r in nets.items() if r == root and (p := self.esp_node(n)) is not None]


# ── Static checks ─────────────────────────────────────────────────────────────


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def err(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)

    def dump(self, title: str) -> None:
        print(f"== {title}")
        for m in self.notes:
            print(f"   {m}")
        for m in self.warnings:
            print(f"   WARN  {m}")
        for m in self.errors:
            print(f"   FAIL  {m}")
        if not self.errors:
            print(f"   ok ({len(self.warnings)} warning(s))")


def sketch_files(project: Path) -> list[Path]:
    return sorted(p for p in project.iterdir()
                  if p.suffix in (".ino", ".h", ".hpp", ".c", ".cpp") and p.is_file())


def int_array(src: str, name: str) -> list[int] | None:
    m = re.search(rf"\b{name}\s*\[\s*\]\s*=\s*\{{([^}}]*)\}}", src)
    if not m:
        return None
    return [int(x) for x in re.findall(r"-?\d+", m.group(1))]


def readme_keys() -> dict[str, tuple[str, str]]:
    rows = {}
    readme = REPO / "README.md"
    if readme.exists():
        for m in re.finditer(r"^\|\s*(K\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|", readme.read_text(), re.M):
            rows[m.group(1)] = (m.group(2), m.group(3))
    return rows


def lint(project: Path) -> Report:
    r = Report()
    dpath = project / "diagram.json"
    if not dpath.exists():
        r.err(f"{dpath} missing")
        return r
    d = Diagram.load(dpath)
    if d.esp is None:
        r.err("no ESP32 part in diagram")
        return r
    if d.parts[d.esp]["type"] != "wokwi-esp32-devkit-v1":
        r.err(f"board is {d.parts[d.esp]['type']}; Velxio needs wokwi-esp32-devkit-v1")

    # Board pins: one jumper each, nothing on straps / serial / flash, known names.
    for pin, n in sorted(d.esp_wire_count.items()):
        p = esp_pin(pin)
        if p is None:
            r.err(f"esp:{pin} is not a DevKit V1 pin name")
            continue
        if n > 1:
            r.err(f"esp:{pin} has {n} wires; jumpers only allow one per board pin")
        if isinstance(p, int):
            if p in BOOT_STRAPS:
                r.err(f"esp:{pin} is GPIO{p}, a boot strap pin")
            if p in USB_SERIAL:
                r.err(f"esp:{pin} is GPIO{p}, the USB serial line")
            if p in FLASH:
                r.err(f"esp:{pin} is GPIO{p}, wired to the SPI flash")

    nets = d.nets()
    src = "\n".join(f.read_text() for f in sketch_files(project))

    # Every pushbutton: both sides wired, same color as its wires, no 34-39
    # input without a pull, no side on a supply rail other than GND.
    labels: dict[str, str] = {}
    for b in d.buttons():
        lab = d.label(b)
        if lab in labels:
            r.err(f"label {lab} used by {labels[lab]} and {b}")
        labels[lab] = b
        color = d.parts[b].get("attrs", {}).get("color", "").lower()
        for side in ("1", "2"):
            node = f"{b}:{side}"
            pins = d.board_pins_on(node, nets)
            if not pins:
                r.warn(f"{lab} side {side} is not wired to the board")
            for p in pins:
                if p in ("3V3", "VIN"):
                    r.warn(f"{lab} side {side} goes to {p}; pressing drives the other side HIGH")
                if isinstance(p, int) and p in INPUT_ONLY:
                    r.err(f"{lab} on GPIO{p}: 34-39 have no internal pull-up, the key would float")
        for a, b2, wc in d.wires:
            if (a.startswith(f"{b}:") or b2.startswith(f"{b}:")) and color and wc and wc.lower() != color:
                r.warn(f"{lab} cap is {color} but a wire is {wc}")

    # Rotary encoders rely on the module's pull-ups: + must be 3V3, not VIN.
    for rot in d.of_type("wokwi-ky-040"):
        vcc = d.board_pins_on(f"{rot}:VCC", nets)
        if "VIN" in vcc:
            r.err(f"{rot} VCC on VIN (5 V): its pull-ups would put 5 V on the GPIOs")
        wired = any(d.board_pins_on(f"{rot}:{p}", nets) for p in ("CLK", "DT", "SW"))
        if wired and "3V3" not in vcc:
            r.warn(f"{rot} VCC is not on 3V3; its CLK/DT/SW pull-ups are dead")
        if not wired:
            r.notes.append(f"{rot} (rotary) placed but not wired yet")

    # Sketch pin map vs diagram vs README (keys8 convention: KEY_PINS/GND_PINS).
    keys, gnds = int_array(src, "KEY_PINS"), int_array(src, "GND_PINS")
    if keys is not None:
        gnds = gnds or [-1] * len(keys)
        if len(gnds) != len(keys):
            r.err(f"KEY_PINS has {len(keys)} entries, GND_PINS {len(gnds)}")
        readme = readme_keys()
        for i, (kp, gp) in enumerate(zip(keys, gnds)):
            lab = f"K{i + 1}"
            want_b = "GND" if gp < 0 else gp
            for p in (kp, gp):
                if p in BOOT_STRAPS | USB_SERIAL | FLASH:
                    r.err(f"{lab}: sketch uses GPIO{p}, a reserved pin")
            if kp in INPUT_ONLY:
                r.err(f"{lab}: KEY pin GPIO{kp} is input-only with no pull-up")
            if 0 <= gp and gp in INPUT_ONLY:
                r.err(f"{lab}: GND pin GPIO{gp} is input-only, it cannot drive LOW")
            b = labels.get(lab)
            if b is None:
                r.err(f"sketch has {lab} but no pushbutton is labeled {lab}")
                continue
            sides = [set(d.board_pins_on(f"{b}:{s}", nets)) for s in ("1", "2")]
            if not ({kp} == sides[0] and {want_b} == sides[1]) and not ({kp} == sides[1] and {want_b} == sides[0]):
                got = " / ".join(",".join(pin_label(p) for p in s) or "-" for s in sides)
                r.err(f"{lab}: sketch wants GPIO{kp} + {pin_label(want_b)}, diagram has {got}")
            if readme:
                row = readme.get(lab)
                want = (f"GPIO{kp}", "GND" if gp < 0 else f"GPIO{gp}")
                if row is None:
                    r.warn(f"README pin table has no {lab} row")
                elif row != want:
                    r.err(f"README {lab} says {row[0]} / {row[1]}, sketch says {want[0]} / {want[1]}")
        extra = set(labels) - {f"K{i + 1}" for i in range(len(keys))}
        for lab in sorted(extra):
            r.warn(f"pushbutton {lab} is not in KEY_PINS")
        r.notes.append(f"{len(keys)} keys in sketch, {len(labels)} pushbuttons in diagram")
    return r


# ── Compile ───────────────────────────────────────────────────────────────────


def compile_project(project: Path, fresh: bool = False) -> tuple[str, str]:
    """Firmware image (base64) from the simulator's compile API, cached by source hash."""
    files = [{"name": f.name, "content": f.read_text()} for f in sketch_files(project)]
    if not files:
        raise SystemExit(f"no sketch sources in {project}")
    h = hashlib.sha256(json.dumps([FQBN, files], sort_keys=True).encode()).hexdigest()[:16]
    cached = CACHE / f"{project.name}-{h}.bin.b64"
    if cached.exists() and not fresh:
        return cached.read_text(), "cached"
    body = json.dumps({"files": files, "board_fqbn": FQBN}).encode()
    req = urllib.request.Request(f"{URL}/api/compile/", body, {"content-type": "application/json"})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=900) as resp:
            out = json.load(resp)
    except urllib.error.URLError as e:
        raise SystemExit(f"compile API at {URL} unreachable ({e}); is the simulator up? `just sim-up`")
    if not out.get("success"):
        tail = "\n".join((out.get("stderr") or out.get("error") or "").strip().splitlines()[-25:])
        raise SystemExit(f"compile failed ({out.get('error_kind')}):\n{tail}")
    CACHE.mkdir(parents=True, exist_ok=True)
    for old in CACHE.glob(f"{project.name}-*.bin.b64"):
        old.unlink()
    cached.write_text(out["binary_content"])
    return out["binary_content"], f"compiled in {time.monotonic() - t0:.0f}s"


# ── Emulation ─────────────────────────────────────────────────────────────────


class Failure(Exception):
    pass


class Sim:
    """One QEMU worker in the container, plus the circuit around it."""

    def __init__(self, d: Diagram, firmware_b64: str, timeout_s: int, verbose: bool = False):
        self.d = d
        self.verbose = verbose
        self.closed: set[tuple[str, str]] = set()      # contacts currently closed
        self.dir: dict[int, int] = {}                   # 1 = output
        self.out: dict[int, int] = {}                   # output level
        self.pull: dict[int, int] = {}                  # 1 up, 2 down
        self.sent: dict[int, int] = {}                  # last level written per GPIO
        self.lines: list[tuple[float, str]] = []
        self.partial = ""
        self.actions: list[tuple[float, str]] = []
        self.problems: list[str] = []
        self.system: list[dict] = []
        self.shorts: set[str] = set()
        self.events: "queue.Queue[tuple[float, dict]]" = queue.Queue()
        self.cursor = 0                                 # first line not yet consumed by until/expect
        cmd = ["docker", "exec", "-i", CONTAINER, "timeout", "-s", "KILL", str(timeout_s), *WORKER]
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, bufsize=1)
        self.stderr: list[str] = []
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._read_err, daemon=True).start()
        self.t0 = time.monotonic()
        self._send({"lib_path": QEMU_LIB, "firmware_b64": firmware_b64, "machine": "esp32-picsimlab"})
        self._seed()

    def _seed(self) -> None:
        # Real pull resistors act from the first instruction; the worker only
        # reports them every 100 ms. Seed every wired input HIGH-idle so the
        # sketch does not see a phantom press at boot. floating_inputs() then
        # checks that each switch input really has a pull behind it.
        self.sent.clear()
        for p in self._wired_gpios():
            self._set_pin(p, 1)

    # plumbing
    def _send(self, obj: dict) -> None:
        try:
            self.proc.stdin.write(json.dumps(obj) + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError):
            pass

    def _read(self) -> None:
        for line in self.proc.stdout:
            try:
                self.events.put((time.monotonic(), json.loads(line)))
            except json.JSONDecodeError:
                pass
        self.events.put((time.monotonic(), {"type": "_eof"}))

    def _read_err(self) -> None:
        for line in self.proc.stderr:
            self.stderr.append(line.rstrip())
            if self.verbose:
                print(f"   [worker] {line.rstrip()}", file=sys.stderr)

    def now(self) -> float:
        return (time.monotonic() - self.t0) * 1000

    def _set_pin(self, gpio: int, level: int) -> None:
        if self.sent.get(gpio) != level:
            self.sent[gpio] = level
            self._send({"cmd": "set_pin", "pin": gpio, "value": level})

    def _wired_gpios(self) -> set[int]:
        return {p for n in self.d.nets() if isinstance(p := self.d.esp_node(n), int)}

    # circuit
    def _module_pulls(self, nets: dict[str, str]) -> dict[str, int]:
        """Net root -> 1 for module pull-ups (ky-040 CLK/DT/SW, pulled to its VCC)."""
        out = {}
        for rot in self.d.of_type("wokwi-ky-040"):
            if set(self.d.board_pins_on(f"{rot}:VCC", nets)) & {"3V3", "VIN"}:
                for p in ("CLK", "DT", "SW"):
                    if f"{rot}:{p}" in nets:
                        out[nets[f"{rot}:{p}"]] = 1
        return out

    def resolve(self) -> None:
        nets = self.d.nets(sorted(self.closed))
        members: dict[str, list[int | str]] = {}
        for n, root in nets.items():
            p = self.d.esp_node(n)
            if p is not None:
                members.setdefault(root, []).append(p)
        mod = self._module_pulls(nets)
        for root, pins in members.items():
            strong = []
            for p in pins:
                if p == "GND":
                    strong.append((p, 0))
                elif p in ("3V3", "VIN"):
                    strong.append((p, 1))
                elif self.dir.get(p) == 1:
                    strong.append((p, self.out.get(p, 0)))
            levels = {lv for _, lv in strong}
            if len(levels) > 1:
                desc = " vs ".join(f"{pin_label(p)}={lv}" for p, lv in strong)
                if desc not in self.shorts:
                    self.shorts.add(desc)
                    self.problems.append(f"short circuit at {self.now():.0f} ms: {desc}")
            if strong:
                level = 0 if 0 in levels else 1
            else:
                weak = {1 if self.pull.get(p) == 1 else 0 for p in pins
                        if isinstance(p, int) and self.pull.get(p) in (1, 2)}
                if root in mod:
                    weak.add(1)
                if len(weak) != 1:
                    continue  # floating or fighting pulls: leave the pad where it was
                level = weak.pop()
            for p in pins:
                if isinstance(p, int) and self.dir.get(p) != 1:
                    self._set_pin(p, level)

    def floating_inputs(self) -> list[str]:
        """Switch inputs with nothing holding them when every contact is open."""
        nets = self.d.nets()
        mod = self._module_pulls(nets)
        out = []
        for b in self.d.buttons():
            for side in ("1", "2"):
                node = f"{b}:{side}"
                pins = self.d.board_pins_on(node, nets)
                gpios = [p for p in pins if isinstance(p, int)]
                if not gpios or any(p in ("GND", "3V3", "VIN") for p in pins):
                    continue
                if any(self.dir.get(p) == 1 for p in gpios):
                    continue
                if not any(self.pull.get(p) in (1, 2) for p in gpios) and nets.get(node) not in mod:
                    out.append(f"{self.d.label(b)} side {side} ({', '.join(map(pin_label, gpios))}) "
                               "is an input with no pull and no driver")
        return out

    def undriven_grounds(self) -> list[str]:
        """Switch sides on a GPIO that the sketch never turned into a LOW output."""
        nets = self.d.nets()
        out = []
        for b in self.d.buttons():
            sides = [[p for p in self.d.board_pins_on(f"{b}:{s}", nets)] for s in ("1", "2")]
            if any("GND" in s for s in sides):
                continue
            if not any(self.dir.get(p) == 1 and self.out.get(p, 0) == 0 for s in sides for p in s if isinstance(p, int)):
                out.append(f"{self.d.label(b)}: neither side is GND or a GPIO held LOW, pressing does nothing")
        return out

    # events
    def pump(self, until_ms: float) -> None:
        while True:
            left = (until_ms - self.now()) / 1000
            try:
                t, ev = self.events.get(timeout=max(0.0, min(left, 0.05)))
            except queue.Empty:
                if self.now() >= until_ms:
                    return
                continue
            self._handle(ev)
            if self.now() >= until_ms and self.events.empty():
                return

    def _handle(self, ev: dict) -> None:
        t = ev.get("type")
        if t == "uart_tx":
            if ev.get("uart", 0) != 0:
                return
            ch = chr(ev["byte"])
            if ch == "\n":
                self.lines.append((self.now(), self.partial.rstrip("\r")))
                if self.verbose:
                    print(f"   {self.now():8.0f}  {self.partial.rstrip()}")
                self.partial = ""
            else:
                self.partial += ch
        elif t in ("gpio_dir", "gpio_change", "gpio_pull"):
            p = ev["pin"]
            self.sent.pop(p, None)  # a reconfigured pad may have dropped what we wrote
            if t == "gpio_dir":
                self.dir[p] = ev["dir"]
            elif t == "gpio_change":
                self.out[p] = ev["state"]
            else:
                self.pull[p] = ev["pull"]
            self.resolve()
        elif t == "system":
            self.system.append({"t": round(self.now()), **ev})
            if ev.get("event") == "booted":
                self._seed()
            if ev.get("event") in ("crash", "reboot"):
                self.problems.append(f"{ev.get('event')} at {self.now():.0f} ms: "
                                     f"{ev.get('reason') or ev.get('count') or ''}".rstrip(": "))
        elif t == "error":
            self.problems.append(f"worker error: {ev.get('message')}")
        elif t == "_eof":
            if self.proc.poll() not in (None, 0):
                self.problems.append(f"worker exited with {self.proc.returncode}")
            raise Failure("worker exited")

    # actions
    def _log(self, what: str) -> None:
        self.actions.append((self.now(), what))
        if self.verbose:
            print(f"   {self.now():8.0f}  >> {what}")

    def _contact(self, a: str, b: str, closed: bool) -> None:
        (self.closed.add if closed else self.closed.discard)((a, b))
        self.resolve()

    def button(self, ref: str, down: bool) -> None:
        pid = self.d.find_part(ref)
        ptype = self.d.parts[pid]["type"]
        if ptype == "wokwi-ky-040":
            self._contact(f"{pid}:SW", f"{pid}:GND", down)
        elif ptype == "wokwi-pushbutton":
            self._contact(f"{pid}:1", f"{pid}:2", down)
        else:
            raise SystemExit(f"{ref} is a {ptype}; only pushbuttons and ky-040 can be pressed")
        self._log(f"{'press' if down else 'release'} {self.d.label(pid)}")

    def chatter(self, ref: str, final: bool) -> None:
        # Six 3 ms blips: longer than a loop() pass, well under a 15 ms debounce.
        for i in range(6):
            self.button(ref, final if i % 2 == 0 else not final)
            self.pump(self.now() + 3)
        self.button(ref, final)

    def rotate(self, ref: str, cw: bool, detents: int) -> None:
        pid = self.d.find_part(ref)
        # Contacts to the module's GND: closed = LOW. CW: CLK leads DT.
        seq = [(1, 0), (1, 1), (0, 1), (0, 0)] if cw else [(0, 1), (1, 1), (1, 0), (0, 0)]
        self._log(f"{'cw' if cw else 'ccw'} {self.d.label(pid)} x{detents}")
        for _ in range(detents):
            for clk, dt in seq:
                self._contact(f"{pid}:CLK", f"{pid}:GND", bool(clk))
                self._contact(f"{pid}:DT", f"{pid}:GND", bool(dt))
                self.pump(self.now() + 3)
            self.pump(self.now() + 20)

    def until(self, pattern: str, timeout_ms: float) -> tuple[float, str]:
        rx = re.compile(pattern)
        deadline = self.now() + timeout_ms
        while True:
            for i in range(self.cursor, len(self.lines)):
                if rx.search(self.lines[i][1]):
                    self.cursor = i + 1
                    return self.lines[i]
            if self.now() >= deadline:
                raise Failure(f"no serial line matching /{pattern}/ within {timeout_ms:.0f} ms")
            self.pump(min(deadline, self.now() + 20))

    def reject(self, pattern: str, window_ms: float) -> None:
        start = len(self.lines)
        self.pump(self.now() + window_ms)
        rx = re.compile(pattern)
        for t, line in self.lines[start:]:
            if rx.search(line):
                raise Failure(f"unexpected serial line at {t:.0f} ms: {line!r}")

    def stop(self) -> None:
        self._send({"cmd": "stop"})
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        if self.partial:
            self.lines.append((self.now(), self.partial.rstrip("\r")))
            self.partial = ""


def play(sim: Sim, script: str) -> None:
    for raw in [s.strip() for s in script.split(";") if s.strip()]:
        a = shlex.split(raw)
        op, args = a[0].lower(), a[1:]
        num = lambda i, dflt: float(args[i]) if len(args) > i else dflt  # noqa: E731
        if op == "wait":
            sim.pump(sim.now() + num(0, 100))
        elif op in ("press", "release"):
            sim.button(args[0], op == "press")
            sim.pump(sim.now() + 5)
        elif op in ("tap", "bounce"):
            hold = num(1, 120)
            (sim.chatter if op == "bounce" else sim.button)(args[0], True)
            sim.pump(sim.now() + hold)
            (sim.chatter if op == "bounce" else sim.button)(args[0], False)
            sim.pump(sim.now() + 120)
        elif op in ("cw", "ccw"):
            sim.rotate(args[0], op == "cw", int(num(1, 1)))
        elif op in ("until", "expect"):
            sim.until(args[0], num(1, 20000 if op == "until" else 2000))
        elif op == "reject":
            sim.reject(args[0], num(1, 300))
        else:
            raise SystemExit(f"unknown script step {raw!r}")


def boot_checks(sim: Sim) -> None:
    rst = [line for _, line in sim.lines if line.startswith("rst:")]
    if len(rst) > 1:
        sim.problems.append(f"{len(rst)} resets (rst: lines): boot loop or crash")
    for _, line in sim.lines:
        if re.search(r"Guru Meditation|Backtrace:|abort\(\) was called|Brownout", line):
            sim.problems.append(f"panic on serial: {line}")
            break


def default_script(d: Diagram, bounce: bool) -> str:
    """keys8 convention: the part labeled Kn prints `key n down` / `key n up`."""
    steps = ["until ready", "reject '^key ' 300"]
    for b in d.buttons():
        m = re.fullmatch(r"K(\d+)", d.label(b))
        if m:
            steps += [f"{'bounce' if bounce else 'tap'} {b} 150",
                      f"expect '^key {m.group(1)} down$' 300",
                      f"expect '^key {m.group(1)} up$' 300"]
    return "; ".join(steps)


def key_line_count(res: dict, d: Diagram) -> str | None:
    """Default script: exactly one down and one up per tapped key."""
    taps = sum(1 for b in d.buttons() if re.fullmatch(r"K\d+", d.label(b)))
    got = [s["line"] for s in res["serial"] if s["line"].startswith("key ")]
    if len(got) != 2 * taps:
        return f"{len(got)} key lines for {taps} taps (want {2 * taps}): chatter or phantom presses"
    return None


# ── CLI ───────────────────────────────────────────────────────────────────────


def emulate(project: Path, script: str, args) -> dict:
    d = Diagram.load(project / "diagram.json")
    up = subprocess.run(["docker", "exec", CONTAINER, "true"], capture_output=True, text=True)
    if up.returncode != 0:
        raise SystemExit(f"container {CONTAINER!r} not running ({up.stderr.strip()}); start it with `just sim-up`")
    if args.bin:
        fw = base64.b64encode(Path(args.bin).read_bytes()).decode()
        how = f"from {args.bin}"
    else:
        fw, how = compile_project(project, fresh=args.fresh)
    print(f"== firmware: {how}")
    sim = Sim(d, fw, timeout_s=int(args.timeout) + 30, verbose=args.verbose)
    failure = None
    try:
        play(sim, script)
        sim.pump(sim.now() + args.tail)
    except Failure as e:
        failure = str(e)
    finally:
        sim.stop()
    boot_checks(sim)
    # The keyboard contract: every switch input pulled, every switch grounded.
    # A failure for `check`; for `run` the sketch may simply not use the keys.
    circuit = sim.floating_inputs() + sim.undriven_grounds()
    if args.cmd == "check":
        sim.problems += circuit
        circuit = []
    result = {
        "ok": failure is None and not sim.problems,
        "failure": failure,
        "problems": sim.problems,
        "warnings": circuit,
        "serial": [{"t_ms": round(t), "line": s} for t, s in sim.lines],
        "actions": [{"t_ms": round(t), "action": a} for t, a in sim.actions],
        "gpio": {"outputs": {p: sim.out.get(p, 0) for p, v in sorted(sim.dir.items()) if v == 1},
                 "pulls": {p: {1: "up", 2: "down"}[v] for p, v in sorted(sim.pull.items()) if v}},
        "system": sim.system,
    }
    if failure and sim.stderr:
        result["worker_stderr_tail"] = sim.stderr[-15:]
    return result


def print_run(res: dict) -> None:
    print("== serial (ms since start)")
    merged = [(s["t_ms"], s["line"]) for s in res["serial"]] + [(a["t_ms"], ">> " + a["action"]) for a in res["actions"]]
    for t, line in sorted(merged, key=lambda x: x[0]):
        print(f"   {t:7d}  {line}")
    outs = ", ".join(f"GPIO{p}={v}" for p, v in res["gpio"]["outputs"].items() if int(p) not in FLASH)
    pulls = ", ".join(f"GPIO{p}" for p, v in res["gpio"]["pulls"].items() if v == "up" and int(p) not in FLASH)
    print(f"== gpio: outputs {outs or '-'}; pull-ups {pulls or '-'}")
    for w in res["warnings"]:
        print(f"   WARN  {w}")
    for p in res["problems"]:
        print(f"   FAIL  {p}")
    if res["failure"]:
        print(f"   FAIL  {res['failure']}")
    for line in res.get("worker_stderr_tail", []):
        print(f"   [worker] {line}")
    print("== result: " + ("PASS" if res["ok"] else "FAIL"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["lint", "run", "check"])
    ap.add_argument("name", nargs="?", default="keys8", help="folder under firmware/ (default keys8), or a path")
    ap.add_argument("--script", "-s", help="steps for `run` (default: wait for boot, 1.5 s)")
    ap.add_argument("--bounce", action="store_true", help="check: tap with contact chatter")
    ap.add_argument("--bin", help="firmware image to run instead of compiling; host arduino-cli images "
                    "panic in QEMU, so prefer the default (the simulator's own compile)")
    ap.add_argument("--fresh", action="store_true", help="ignore the compile cache")
    ap.add_argument("--tail", type=float, default=200, help="ms to keep running after the script")
    ap.add_argument("--timeout", type=float, default=120, help="hard cap on the worker, seconds")
    ap.add_argument("--json", action="store_true", help="print the run result as JSON")
    ap.add_argument("--verbose", "-v", action="store_true", help="stream serial, actions and worker logs")
    args = ap.parse_args()
    out = sys.stdout
    if args.json:
        sys.stdout = sys.stderr  # progress to stderr, only the result JSON on stdout

    project = Path(args.name) if "/" in args.name else FIRMWARE / args.name
    if not project.is_dir():
        print(f"no project {project}", file=sys.stderr)
        return 2
    project = project.resolve()

    ok = True
    if args.cmd in ("lint", "check"):
        rep = lint(project)
        rep.dump(f"lint firmware/{args.name}")
        ok = not rep.errors
        if args.cmd == "lint":
            return 0 if ok else 1

    if args.cmd == "run":
        script = args.script or "until ready; wait 1500"
    else:
        script = args.script or default_script(Diagram.load(project / "diagram.json"), args.bounce)
    print(f"== script: {script}")
    res = emulate(project, script, args)
    if args.cmd == "check" and not args.script:
        extra = key_line_count(res, Diagram.load(project / "diagram.json"))
        if extra:
            res["problems"].append(extra)
            res["ok"] = False
    if args.json:
        res["lint_errors"] = rep.errors if args.cmd == "check" else []
        print(json.dumps(res, indent=2), file=out)
    else:
        print_run(res)
    return 0 if ok and res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
