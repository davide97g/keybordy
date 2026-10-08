"""Shared helpers for the keybordy board generators (pcb/macropad/build.py).

Runs with KiCad's own Python, which ships the pcbnew module. Coordinates passed in
are millimetres in the caller's frame; `Builder(origin)` shifts them onto the
KiCad page so the board does not sit on the frame corner.
"""

import csv
import json
import os
import subprocess
import sys

import pcbnew

KICAD_APP = os.environ.get("KICAD_APP", os.path.expanduser("~/Applications/KiCad/KiCad.app"))
KICAD_FP = os.environ.get("KICAD_FP", os.path.join(KICAD_APP, "Contents/SharedSupport/footprints"))
KICAD_CLI = os.environ.get("KICAD_CLI", os.path.join(KICAD_APP, "Contents/MacOS/kicad-cli"))
LOCAL_FP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "keybordy.pretty")
FREEROUTING = os.environ.get(
    "FREEROUTING_JAR", os.path.expanduser("~/.local/share/freerouting/freerouting-1.9.0.jar"))


class Builder:
    def __init__(self, path, origin=(50.0, 50.0)):
        self.path = path
        self.ox, self.oy = origin
        self.board = pcbnew.NewBoard(path)
        self.nets = {}

    def mm(self, x, y):
        return pcbnew.VECTOR2I_MM(self.ox + x, self.oy + y)

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
        fp.SetPosition(self.mm(x, y))
        fp.SetOrientationDegrees(deg)
        if back:
            fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_LEFT_RIGHT)
        return fp

    def pad_net(self, fp, number, net):
        hit = [p for p in fp.Pads() if p.GetNumber() == str(number)]
        if not hit:
            sys.exit(f"{fp.GetReference()} has no pad {number}")
        for p in hit:
            p.SetNet(self.net(net))

    def text(self, s, x, y, size=1.0, layer=pcbnew.F_SilkS, deg=0, bold=False, justify=None):
        t = pcbnew.PCB_TEXT(self.board)
        t.SetText(s)
        t.SetPosition(self.mm(x, y))
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
        s.SetStart(self.mm(x1, y1))
        s.SetEnd(self.mm(x2, y2))
        s.SetLayer(layer)
        s.SetWidth(pcbnew.FromMM(width))
        self.board.Add(s)

    def circle(self, x, y, r, layer=pcbnew.F_SilkS, width=0.15):
        s = pcbnew.PCB_SHAPE(self.board, pcbnew.SHAPE_T_CIRCLE)
        s.SetCenter(self.mm(x, y))
        s.SetEnd(self.mm(x + r, y))
        s.SetLayer(layer)
        s.SetWidth(pcbnew.FromMM(width))
        self.board.Add(s)

    def arc(self, cx, cy, sx, sy, deg, layer=pcbnew.Edge_Cuts, width=0.1):
        s = pcbnew.PCB_SHAPE(self.board, pcbnew.SHAPE_T_ARC)
        s.SetCenter(self.mm(cx, cy))
        s.SetStart(self.mm(sx, sy))
        s.SetArcAngleAndEnd(pcbnew.EDA_ANGLE(deg, pcbnew.DEGREES_T), True)
        s.SetLayer(layer)
        s.SetWidth(pcbnew.FromMM(width))
        self.board.Add(s)

    def rounded_outline(self, x0, y0, x1, y1, r):
        self.line(x0 + r, y0, x1 - r, y0, pcbnew.Edge_Cuts, 0.1)
        self.line(x1, y0 + r, x1, y1 - r, pcbnew.Edge_Cuts, 0.1)
        self.line(x1 - r, y1, x0 + r, y1, pcbnew.Edge_Cuts, 0.1)
        self.line(x0, y1 - r, x0, y0 + r, pcbnew.Edge_Cuts, 0.1)
        self.arc(x0 + r, y0 + r, x0, y0 + r, 90)
        self.arc(x1 - r, y0 + r, x1 - r, y0, 90)
        self.arc(x1 - r, y1 - r, x1, y1 - r, 90)
        self.arc(x0 + r, y1 - r, x0 + r, y1, 90)

    def polygon(self, pts):
        chain = pcbnew.SHAPE_LINE_CHAIN()
        for x, y in pts:
            chain.Append(self.mm(x, y))
        chain.SetClosed(True)
        return chain

    def zone(self, net, layers, pts, clearance=0.3, priority=0):
        z = pcbnew.ZONE(self.board)
        ls = pcbnew.LSET()
        for layer in layers:
            ls.AddLayer(layer)
        z.SetLayerSet(ls)
        z.SetNet(self.net(net))
        z.SetLocalClearance(pcbnew.FromMM(clearance))
        z.SetMinThickness(pcbnew.FromMM(0.25))
        z.SetPadConnection(pcbnew.ZONE_CONNECTION_THT_THERMAL)    # SMD pads solid, THT with spokes
        z.SetThermalReliefGap(pcbnew.FromMM(0.35))
        z.SetThermalReliefSpokeWidth(pcbnew.FromMM(0.4))
        z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
        z.SetAssignedPriority(priority)
        poly = pcbnew.SHAPE_POLY_SET()
        poly.AddOutline(self.polygon(pts))
        poly.thisown = False    # the zone owns its outline from here; Python must not free it
        z.SetOutline(poly)
        self.board.Add(z)
        return z

    def keepout(self, layers, pts, tracks=False, vias=False, pads=False, pour=False, footprints=False):
        """A rule area. Each flag says what is *allowed* inside it."""
        z = pcbnew.ZONE(self.board)
        ls = pcbnew.LSET()
        for layer in layers:
            ls.AddLayer(layer)
        z.SetLayerSet(ls)
        z.SetIsRuleArea(True)
        z.SetDoNotAllowTracks(not tracks)
        z.SetDoNotAllowVias(not vias)
        z.SetDoNotAllowPads(not pads)
        z.SetDoNotAllowZoneFills(not pour)
        z.SetDoNotAllowFootprints(not footprints)
        poly = pcbnew.SHAPE_POLY_SET()
        poly.AddOutline(self.polygon(pts))
        poly.thisown = False    # the zone owns its outline from here; Python must not free it
        z.SetOutline(poly)
        self.board.Add(z)
        return z


def setup_rules(board):
    """JLCPCB 2-layer standard capabilities, with margin. Netclasses go in later via write_netclasses()."""
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
    nc.SetTrackWidth(pcbnew.FromMM(0.2))
    nc.SetClearance(pcbnew.FromMM(0.2))
    nc.SetViaDiameter(pcbnew.FromMM(0.6))
    nc.SetViaDrill(pcbnew.FromMM(0.3))


def write_netclasses(board_file, netclasses):
    """Add netclasses to the saved .kicad_pro, which KiCad reads with the board.
    netclasses: {name: (track mm, clearance mm, [net patterns])}. Setting them through
    pcbnew's SWIG API crashes the save now and then (the NETCLASS gets freed under KiCad)."""
    pro = board_file.replace(".kicad_pcb", ".kicad_pro")
    d = json.load(open(pro))
    ns = d["net_settings"]
    default = next(c for c in ns["classes"] if c["name"] == "Default")
    ns["classes"] = [default]
    ns["netclass_patterns"] = []
    for i, (name, (track, clearance, patterns)) in enumerate(netclasses.items()):
        c = dict(default, name=name, priority=i, track_width=track, clearance=clearance,
                 via_diameter=0.7 if track >= 0.4 else 0.6, via_drill=0.35 if track >= 0.4 else 0.3)
        ns["classes"].append(c)
        ns["netclass_patterns"] += [{"netclass": name, "pattern": p} for p in patterns]
    json.dump(d, open(pro, "w"), indent=2)


def freeroute(board_file, workdir, passes=60, reuse=False):
    """Export Specctra DSN, run Freerouting headless, import the session back.
    reuse=True imports the last session without routing again."""
    board = pcbnew.LoadBoard(board_file)
    for t in list(board.GetTracks()):
        if not t.IsLocked():    # locked vias (in exposed pads) are part of the placement
            board.Remove(t)
    for z in list(board.Zones()):
        if not z.GetIsRuleArea():
            board.Remove(z)
    dsn = os.path.join(workdir, "route.dsn")
    ses = os.path.join(workdir, "route.ses")
    if reuse and os.path.exists(ses):
        if not pcbnew.ImportSpecctraSES(board, ses):
            sys.exit("SES import failed")
        board.Save(board_file)
        return
    if os.path.exists(ses):
        os.remove(ses)
    if not pcbnew.ExportSpecctraDSN(board, dsn):
        sys.exit("DSN export failed")
    if not os.path.exists(FREEROUTING):
        sys.exit(f"Freerouting jar not found at {FREEROUTING} (set FREEROUTING_JAR)")
    # 1.9.0, not 2.x: on this board 2.5 oscillates and leaves ~30 connections unrouted
    subprocess.run(["java", "-jar", FREEROUTING, "-de", dsn, "-do", ses, "-mp", str(passes)], check=True)
    if not os.path.exists(ses):
        sys.exit("Freerouting wrote no session")
    if not pcbnew.ImportSpecctraSES(board, ses):
        sys.exit("SES import failed")
    board.Save(board_file)


def drc(board_file, out):
    path = os.path.join(out, "drc.json")
    subprocess.run([KICAD_CLI, "pcb", "drc", "--format", "json", "--severity-error", "--severity-warning",
                    "--refill-zones", "--save-board", "-o", path, board_file], check=False)
    with open(path) as f:
        rep = json.load(f)
    return path, rep.get("violations", []), rep.get("unconnected_items", [])


def gerbers(board_file, out, zip_name):
    g = os.path.join(out, "gerbers")
    os.makedirs(g, exist_ok=True)
    for f in os.listdir(g):
        os.remove(os.path.join(g, f))
    layers = "F.Cu,B.Cu,F.SilkS,B.SilkS,F.Mask,B.Mask,F.Paste,B.Paste,Edge.Cuts"
    subprocess.run([KICAD_CLI, "pcb", "export", "gerbers", "--layers", layers, "--subtract-soldermask",
                    "--no-x2", "--use-drill-file-origin", "-o", g, board_file], check=True)
    subprocess.run([KICAD_CLI, "pcb", "export", "drill", "--format", "excellon", "--drill-origin", "plot",
                    "--excellon-units", "mm", "--excellon-separate-th", "--generate-map", "--map-format", "gerberx2",
                    "-o", g + "/", board_file], check=True)
    zip_path = os.path.join(out, zip_name)
    if os.path.exists(zip_path):
        os.remove(zip_path)
    subprocess.run(["zip", "-j", "-q", zip_path] + sorted(os.path.join(g, f) for f in os.listdir(g)), check=True)
    return zip_path


def jlc_assembly(board_file, out, name, parts):
    """JLCPCB BOM and CPL. parts: {ref: {"value", "footprint", "lcsc"}}; parts without an LCSC number are left out."""
    pos = os.path.join(out, "pos.csv")
    subprocess.run([KICAD_CLI, "pcb", "export", "pos", "--format", "csv", "--units", "mm", "--side", "both",
                    "--use-drill-file-origin", "-o", pos, board_file], check=True)
    rows = list(csv.DictReader(open(pos)))
    os.remove(pos)
    cpl = os.path.join(out, f"{name}-cpl.csv")
    bom = os.path.join(out, f"{name}-bom.csv")
    groups = {}
    with open(cpl, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
        for r in rows:
            ref = r["Ref"]
            p = parts.get(ref)
            if not p or not p.get("lcsc"):
                continue
            side = "Bottom" if r["Side"].lower().startswith("b") else "Top"
            w.writerow([ref, f"{float(r['PosX']):.3f}mm", f"{float(r['PosY']):.3f}mm", side, f"{float(r['Rot']):.0f}"])
            groups.setdefault((p["value"], p["footprint"], p["lcsc"]), []).append(ref)
    with open(bom, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Comment", "Designator", "Footprint", "LCSC Part #"])
        for (value, footprint, lcsc), refs in sorted(groups.items(), key=lambda kv: kv[1][0]):
            w.writerow([value, ",".join(sorted(refs, key=natural)), footprint.split(":")[-1], lcsc])
    return bom, cpl


def natural(ref):
    head = ref.rstrip("0123456789")
    tail = ref[len(head):]
    return head, int(tail) if tail else 0


def renders(board_file, out):
    for side in ("top", "bottom"):
        subprocess.run([KICAD_CLI, "pcb", "render", "--side", side, "--quality", "high", "-w", "1600", "-h", "1600",
                        "--background", "opaque", "-o", os.path.join(out, f"render-{side}.png"), board_file],
                       check=False)
