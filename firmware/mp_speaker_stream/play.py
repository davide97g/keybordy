"""Play audio on the bench speaker through firmware/mp_speaker_stream.

    play.py PORT FILE [--peak DB]        any file ffmpeg can decode (mp3, m4a, wav, ...)
    play.py PORT --tune NAME [--peak DB] a built-in public-domain tune: ode, elise, twinkle, auguri, scale
    play.py PORT --tune sweep            1 kHz sine at -24, -20, -16, -12 dBFS, 2 s each: where crackle starts
    play.py PORT --tune check            1 kHz sine, 3 s at -30 dBFS then 3 s at -12 dBFS (crackle test:
                                         crackle on the quiet half = a loose I2S contact; only on the loud
                                         half = the 5 V supply sagging)

Resets the board, waits for `mp_speaker ready`, sends the title, then streams 32 kHz mono int16
in 16 ms packets. The board acks each packet once it is queued to I2S; WINDOW packets stay in
flight, so the speaker's DMA sets the pace. Every track is scaled so its peak lands at --peak
(default: tuned.json from mp_audio_tune/tune.py, else -21 dBFS): on the bench, with the amp's 5 V coming through the DevKit and jumpers, a
1 kHz sine crackles from -16 dBFS (supply sag) and is clean at -20.
Needs pyserial: run it with /opt/homebrew/opt/esptool/libexec/bin/python3 on this Mac.
"""

import array
import math
import os
import subprocess
import sys
import time

import serial

FS = 32000
FRAMES = 512
WINDOW = 12  # packets in flight, ~190 ms

NOTE = {n: i for i, n in enumerate("C C# D D# E F F# G G# A A# B".split())}
TUNES = {
    # (note, beats); "R" is a rest. Tempo in beats per minute.
    "ode": (132, "E4 1 E4 1 F4 1 G4 1 G4 1 F4 1 E4 1 D4 1 C4 1 C4 1 D4 1 E4 1 E4 1.5 D4 .5 D4 2 "
                 "E4 1 E4 1 F4 1 G4 1 G4 1 F4 1 E4 1 D4 1 C4 1 C4 1 D4 1 E4 1 D4 1.5 C4 .5 C4 2"),
    "elise": (150, "E5 .5 D#5 .5 E5 .5 D#5 .5 E5 .5 B4 .5 D5 .5 C5 .5 A4 1.5 R .5 C4 .5 E4 .5 A4 .5 B4 1.5 "
                   "R .5 E4 .5 G#4 .5 B4 .5 C5 1.5 R .5 E4 .5 E5 .5 D#5 .5 E5 .5 D#5 .5 E5 .5 B4 .5 D5 .5 "
                   "C5 .5 A4 1.5 R .5 C4 .5 E4 .5 A4 .5 B4 1.5 R .5 E4 .5 C5 .5 B4 .5 A4 2"),
    "twinkle": (120, "C4 1 C4 1 G4 1 G4 1 A4 1 A4 1 G4 2 F4 1 F4 1 E4 1 E4 1 D4 1 D4 1 C4 2"),
    "auguri": (120, "G4 .75 G4 .25 A4 1 G4 1 C5 1 B4 2 G4 .75 G4 .25 A4 1 G4 1 D5 1 C5 2 "
                    "G4 .75 G4 .25 G5 1 E5 1 C5 1 B4 1 A4 2 F5 .75 F5 .25 E5 1 C5 1 D5 1 C5 3"),
    "scale": (180, "C4 1 D4 1 E4 1 F4 1 G4 1 A4 1 B4 1 C5 2 R 1 C5 1 B4 1 A4 1 G4 1 F4 1 E4 1 D4 1 C4 2"),
}


def hz(name: str) -> float:
    pitch, octave = name[:-1], int(name[-1])
    return 440.0 * 2 ** ((NOTE[pitch] + 12 * (octave + 1) - 69) / 12)


def check_tone(levels=(-30, -12), secs=3) -> array.array:
    out = array.array("h")
    for db in levels:
        a = 32767 * 10 ** (db / 20)
        n = secs * FS
        for i in range(n):
            env = min(1.0, i / (0.02 * FS), (n - i) / (0.02 * FS))
            out.append(int(a * env * math.sin(2 * math.pi * 1000 * i / FS)))
        out.extend([0] * (FS // 2))
    return out


def synth(tune: str) -> array.array:
    if tune == "check":
        return check_tone()
    if tune == "sweep":
        return check_tone((-24, -20, -16, -12), 2)
    bpm, score = TUNES[tune]
    toks = score.split()
    out = array.array("h")
    for name, beats in zip(toks[0::2], toks[1::2]):
        n = int(FS * float(beats) * 60 / bpm)
        f = 0.0 if name == "R" else hz(name)
        for i in range(n):
            if not f:
                out.append(0)
                continue
            t = i / FS
            # a soft plucked tone: fundamental + two harmonics, fast attack, exponential decay
            env = min(1.0, i / (0.005 * FS)) * math.exp(-3.0 * t) * min(1.0, (n - i) / (0.01 * FS))
            v = math.sin(2 * math.pi * f * t) + 0.35 * math.sin(4 * math.pi * f * t) + 0.12 * math.sin(6 * math.pi * f * t)
            out.append(int(v / 1.47 * env * 30000))
    return out


def decode(path: str) -> array.array:
    pcm = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", str(FS), "-"],
                         check=True, capture_output=True).stdout
    a = array.array("h")
    a.frombytes(pcm[: len(pcm) // 2 * 2])
    return a


def main() -> int:
    args = sys.argv[1:]
    peak_db = -21.0
    tuned = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tuned.json")
    if os.path.exists(tuned):  # written by firmware/mp_audio_tune/tune.py: the board's own measurement
        import json
        peak_db = float(json.load(open(tuned))["peak_dbfs"])
    if "--peak" in args:
        k = args.index("--peak")
        peak_db = float(args[k + 1])
        del args[k:k + 2]
    port = args[0]
    if args[1] == "--tune" and args[2] in ("check", "sweep"):
        samples = synth(args[2])
        title = "1 kHz -30 / -12 dB" if args[2] == "check" else "1 kHz -24 -20 -16 -12"
        peak_db = None  # the test tones carry their own levels
    elif args[1] == "--tune":
        samples, title = synth(args[2]), {"ode": "Ode to Joy", "elise": "Fur Elise", "twinkle": "Twinkle", "auguri": "Tanti auguri", "scale": "C major scale"}.get(args[2], args[2])
    else:
        samples, title = decode(args[1]), os.path.splitext(os.path.basename(args[1]))[0]
    peak = max(1, max(abs(v) for v in samples))
    g = 1.0 if peak_db is None else 32767 * 10 ** (peak_db / 20) / peak
    gain_db = 20 * math.log10(g)
    samples = array.array("h", (max(-32768, min(32767, int(v * g))) for v in samples))

    s = serial.Serial()
    s.port, s.baudrate, s.timeout = port, 2_000_000, 0.05
    s.dtr = s.rts = False
    s.open()
    s.rts = True
    time.sleep(0.2)
    s.rts = False
    buf, t0 = b"", time.time()
    while b"mp_speaker ready" not in buf and time.time() - t0 < 10:
        buf += s.read(512)
    line = buf[buf.find(b"mp_speaker ready"):].split(b"\n")[0].decode(errors="replace")
    if not line:
        print("no `mp_speaker ready` from the board; last bytes:", buf[-200:])
        return 1
    print(line.strip())
    if "FAILED" in line:
        return 1
    s.reset_input_buffer()

    t = title.encode("ascii", "replace")[:38]
    s.write(b"TTL" + bytes([len(t)]) + t)
    total = (len(samples) + FRAMES - 1) // FRAMES
    print(f"playing {title}: {len(samples) / FS:.1f} s, gain {gain_db:+.1f} dB"
          + (f", peak {peak_db:.0f} dBFS" if peak_db is not None else ""), flush=True)
    sent = acked = 0
    t_start = time.time()
    while acked < total:
        while sent < total and sent - acked < WINDOW:
            block = samples[sent * FRAMES:(sent + 1) * FRAMES]
            if len(block) < FRAMES:
                block.extend([0] * (FRAMES - len(block)))
            s.write(b"SPK" + bytes([sent % 256]) + block.tobytes())
            sent += 1
        got = s.read(max(1, s.in_waiting))
        acked += got.count(b"K")
        if time.time() - t_start > len(samples) / FS + 10:
            print(f"stalled: {acked}/{total} packets acked")
            break
    s.write(b"EOS!")
    tail = b""
    t1 = time.time()
    while b"play done" not in tail and time.time() - t1 < 2:
        tail += s.read(256)
    s.close()
    print(f"done: {acked}/{total} packets in {time.time() - t_start:.1f} s (real time {len(samples) / FS:.1f} s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
