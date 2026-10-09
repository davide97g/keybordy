"""Let the bench board find its own loudest clean speaker level, with its own mic.

    tune.py PORT

Resets the board (firmware/mp_audio_tune), sends 'T' and reads its sweep: per 2 dB step, the mic's
fundamental, THD+N, 2nd/3rd harmonics and crest factor. A step counts when the mic hears the
tone 3 dB over the room's broadband noise (the tone is one Goertzel bin, so that is a wide margin
in its band). It is clean when
  - the gain is linear: (mic fundamental - played level) stays within 1.5 dB of the reference,
    the median of the quietest third of the audible steps (supply sag compresses it, and on the
    bench it collapses outright: -14 dBFS read 7 dB low on 2026-10-09), and
  - the 3rd harmonic stays within 10 dB of the reference (clipping raises it).
THD+N is printed but not used: at bench distances the room noise dominates it.
The pick is the top of the run of clean steps that starts at the first audible one, minus
MARGIN_DB (4 dB: ears hear crackle about a step before the mic sees compression). It goes into firmware/mp_speaker_stream/tuned.json, which play.py uses as its default
peak, and the board plays a chime at that level.
Needs pyserial: run it with /opt/homebrew/opt/esptool/libexec/bin/python3 on this Mac.
"""

import json
import os
import re
import statistics
import sys
import time

import serial

MARGIN_DB = 4
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "mp_speaker_stream", "tuned.json")


def readline_until(s, pattern, timeout):
    buf, t0 = b"", time.time()
    while time.time() - t0 < timeout:
        buf += s.read(256)
        if re.search(pattern, buf):
            return buf.decode(errors="replace")
    return buf.decode(errors="replace")


def main() -> int:
    port = sys.argv[1]
    s = serial.Serial()
    s.port, s.baudrate, s.timeout = port, 2_000_000, 0.1
    s.dtr = s.rts = False
    s.open()
    s.rts = True
    time.sleep(0.2)
    s.rts = False
    text = readline_until(s, rb"mp_audio_tune ready[^\n]*\n", 10)
    m = re.search(r"mp_audio_tune ready[^\n]*", text)
    if not m or "FAILED" in m.group(0):
        print("board not ready:", text[-200:])
        return 1
    print(m.group(0))
    s.reset_input_buffer()
    s.write(b"T")
    print("beep: be quiet; 2 s of silence, then the sweep", flush=True)
    text = readline_until(s, rb"tune done", 40)

    noise = re.search(r"noise (-?[\d.]+)", text)
    steps = [dict(zip(("lvl", "fund", "thdn", "h2", "h3", "crest"), map(float, m.groups())))
             for m in re.finditer(r"step (-?\d+) fund (-?[\d.]+) thdn (-?[\d.]+) h2 (-?[\d.]+) h3 (-?[\d.]+) crest (-?[\d.]+)", text)]
    if not steps:
        print("no sweep data:", text[-300:])
        return 1
    noise_db = float(noise.group(1)) if noise else -120.0
    for st in steps:
        st["gain"] = st["fund"] - st["lvl"]
    raw_out = os.path.join(os.path.dirname(OUT), "tune-last.json")
    with open(raw_out, "w") as f:
        json.dump({"noise_dbfs": noise_db, "steps": steps}, f, indent=1)
    audible = [st for st in steps if st["fund"] > noise_db + 3]
    if len(audible) < 3:
        print(f"the mic barely hears the speaker (noise {noise_db:.1f} dBFS): move them closer and retry")
        for st in steps:
            print(f"  {st['lvl']:+4.0f} dB  mic {st['fund']:6.1f}  thd+n {st['thdn']:6.1f}")
        return 1
    ref = audible[: max(3, len(audible) // 3)]  # the quietest audible steps are the clean reference
    gain_ref = statistics.median(st["gain"] for st in ref)
    crest_ref = statistics.median(st["crest"] for st in ref)
    h3_ref = statistics.median(st["h3"] for st in ref)

    def is_clean(st):
        return st["fund"] > noise_db + 3 and st["gain"] >= gain_ref - 1.5 and st["h3"] <= h3_ref + 10

    print(f"\nroom noise {noise_db:.1f} dBFS; reference gain {gain_ref:+.1f} dB, h3 {h3_ref:.1f} dB")
    print(" level   mic fund  gain  THD+N   h2    h3   crest  verdict")
    for st in steps:
        fails = [w for w, ok in (("compressed", st["gain"] >= gain_ref - 1.5), ("clipping", st["h3"] <= h3_ref + 10)) if not ok]
        if st["gain"] < gain_ref - 6:
            why = "collapsed (supply sag)"  # the tone itself drops away: no need to hear it over the room
        else:
            why = "too quiet to judge" if st["fund"] <= noise_db + 3 else (", ".join(fails) or "clean")
        print(f"{st['lvl']:+5.0f}   {st['fund']:7.1f}  {st['gain']:+5.1f}  {st['thdn']:6.1f} {st['h2']:6.1f} {st['h3']:6.1f} {st['crest']:6.1f}  {why}")
    # the run of clean steps from the first audible one upwards ends at the first failure
    run_top = None
    for st in sorted((x for x in steps if x["lvl"] >= audible[0]["lvl"]), key=lambda x: x["lvl"]):
        if not is_clean(st):
            break
        run_top = st["lvl"]
    if run_top is None:
        print("no clean level found")
        return 1
    peak = int(run_top - MARGIN_DB)
    print(f"\nloudest clean step {run_top:+.0f} dBFS -> speaker peak {peak:+d} dBFS ({MARGIN_DB} dB margin)")
    with open(OUT, "w") as f:
        json.dump({"peak_dbfs": peak, "loudest_clean_dbfs": run_top, "noise_dbfs": noise_db,
                   "tuned_at": time.strftime("%Y-%m-%d %H:%M"), "steps": steps}, f, indent=1)
    print("saved", os.path.normpath(OUT))
    s.write(b"C" + int(peak).to_bytes(1, "big", signed=True))
    readline_until(s, rb"chime done", 5)
    s.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
