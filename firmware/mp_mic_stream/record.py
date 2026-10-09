"""Record the bench INMP441 through firmware/mp_mic_stream and write a WAV.

    record.py PORT SECONDS OUT.wav [--live]

Resets the board, waits for `mp_mic ready`, asks for SECONDS of audio and parses the "MIC"
packets (stereo int16, 16 kHz). Picks the slot that carries the mic, removes its DC offset,
normalises the peak to -1 dBFS (gain capped at +40 dB, so silence stays silence), writes a mono
WAV and prints the numbers that say whether the mic works: levels per slot, gain, dropped packets.
--live also plays the mic on the Mac while it records (ffplay, about 0.2 s behind), with a DC
high-pass, following whichever slot is louder. Speakers and mic make a loop, so a feedback guard
watches the live output: about 0.2 s of sustained loud output (howl builds up, speech comes in
bursts) mutes it for 1 s and halves the live gain for the rest of the take. Headphones avoid the
loop altogether. The WAV is unaffected.
Needs pyserial: run it with /opt/homebrew/opt/esptool/libexec/bin/python3 on this Mac.
"""

import array
import math
import subprocess
import sys
import time
import wave

import serial

FS = 16000
FRAMES = 256
PKT = 4 + FRAMES * 4


def dbfs(x: float) -> float:
    return 20 * math.log10(x / 32768) if x > 0 else -120.0


def main() -> int:
    port, secs, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    live = None
    if "--live" in sys.argv:
        live = subprocess.Popen(
            ["ffplay", "-loglevel", "error", "-nodisp", "-autoexit", "-fflags", "nobuffer", "-flags", "low_delay",
             "-probesize", "32", "-f", "s16le", "-ar", str(FS), "-ch_layout", "mono", "-i", "-"],
            stdin=subprocess.PIPE)
    hp = {"x": [0.0, 0.0], "y": [0.0, 0.0], "e": [0.0, 0.0]}  # live: per-slot high-pass state and energy
    guard = {"gain": 1.0, "hot": 0, "mute": 0}  # live: feedback guard (gain, loud blocks in a row, muted blocks left)
    HOT_DB, HOT_BLOCKS, MUTE_BLOCKS = -24.0, 12, 62  # 12 x 16 ms ~ 0.2 s loud; mute ~1 s
    s = serial.Serial()
    s.port, s.baudrate, s.timeout = port, 2_000_000, 0.2
    s.dtr = s.rts = False
    s.open()
    s.rts = True
    time.sleep(0.2)
    s.rts = False  # EN pulse: a clean boot, whatever was running

    buf, t0 = b"", time.time()
    while b"mp_mic ready" not in buf and time.time() - t0 < 10:
        buf += s.read(512)
    line = buf[buf.find(b"mp_mic ready"):].split(b"\n")[0].decode(errors="replace")
    if not line:
        print("no `mp_mic ready` from the board; last bytes:", buf[-200:])
        return 1
    print(line.strip())
    if "FAILED" in line:
        return 1

    s.reset_input_buffer()
    s.write(b"R" + bytes([secs]))
    print(f"recording {secs} s: talk now (the OLED counts down)", flush=True)

    raw, data, expect, dropped, packets = b"", bytearray(), 0, 0, 0
    deadline = time.time() + secs + 5
    while time.time() < deadline:
        raw += s.read(8192)
        while True:
            i = raw.find(b"MIC")
            end = raw.find(b"END!")
            if end != -1 and (i == -1 or end < i):
                deadline = 0
                break
            if i == -1 or len(raw) - i < PKT:
                raw = raw[i:] if i != -1 else raw[-3:]
                break
            seq = raw[i + 3]
            if packets and seq != expect:
                dropped += (seq - expect) % 256
            expect = (seq + 1) % 256
            block = raw[i + 4:i + PKT]
            data += block
            packets += 1
            if live:
                pcm = array.array("h")
                pcm.frombytes(block)
                mono = array.array("h")
                for k in range(0, len(pcm), 2):
                    for c in (0, 1):
                        x = float(pcm[k + c])
                        y = x - hp["x"][c] + 0.995 * hp["y"][c]
                        hp["x"][c], hp["y"][c] = x, y
                        hp["e"][c] = 0.999 * hp["e"][c] + 0.001 * y * y
                    c = 0 if hp["e"][0] >= hp["e"][1] else 1
                    mono.append(max(-32768, min(32767, int(hp["y"][c] * guard["gain"]))))
                level = dbfs(math.sqrt(sum(v * v for v in mono) / len(mono)))
                guard["hot"] = guard["hot"] + 1 if level > HOT_DB else max(0, guard["hot"] - 1)
                if guard["hot"] >= HOT_BLOCKS:
                    guard.update(hot=0, mute=MUTE_BLOCKS, gain=guard["gain"] / 2)
                    print(f"feedback guard: muted 1 s, live gain now {20 * math.log10(guard['gain']):+.0f} dB", flush=True)
                if guard["mute"]:
                    guard["mute"] -= 1
                    mono = array.array("h", bytes(len(mono) * 2))
                try:
                    live.stdin.write(mono.tobytes())
                    live.stdin.flush()
                except (BrokenPipeError, OSError):
                    live = None  # the player went away (closed or killed): keep recording
            raw = raw[i + PKT:]
    s.close()
    if live:
        try:
            live.stdin.close()
            live.wait(timeout=5)
        except (BrokenPipeError, OSError, subprocess.TimeoutExpired):
            live.kill()

    samples = array.array("h")
    samples.frombytes(bytes(data))
    left, right = samples[0::2], samples[1::2]
    n = len(left)
    if n == 0:
        print("no audio packets arrived")
        return 1

    def stats(ch):
        mean = sum(ch) / len(ch)
        rms = math.sqrt(sum((v - mean) ** 2 for v in ch) / len(ch))
        peak = max(abs(v - mean) for v in ch)
        return mean, rms, peak

    sl, sr = stats(left), stats(right)
    print(f"got {n / FS:.1f} s, {packets} packets, {dropped} dropped")
    print(f"slot L: rms {dbfs(sl[1]):6.1f} dBFS  peak {dbfs(sl[2]):6.1f} dBFS  dc {sl[0]:+.0f}")
    print(f"slot R: rms {dbfs(sr[1]):6.1f} dBFS  peak {dbfs(sr[2]):6.1f} dBFS  dc {sr[0]:+.0f}")
    ch, (mean, rms, peak), name = (left, sl, "L") if sl[1] >= sr[1] else (right, sr, "R")
    gain = min(10 ** (40 / 20), (0.89 * 32767) / peak) if peak else 1.0
    print(f"using slot {name}, gain {20 * math.log10(gain):+.1f} dB")

    outv = array.array("h", (max(-32768, min(32767, int((v - mean) * gain))) for v in ch))
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(FS)
        w.writeframes(outv.tobytes())
    print("wrote", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
