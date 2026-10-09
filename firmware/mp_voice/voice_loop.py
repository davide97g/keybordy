"""Push-to-talk voice loop: keybordy MP mic -> davide2 (local) -> keybordy MP speaker.

    voice_loop.py PORT [--chat] [--llm claude-haiku] [--url http://127.0.0.1:8777] [--voice me] [--peak DB] [--drive K] [--lang it]

With firmware/mp_voice on the board: K1 starts recording, K2 stops. The take goes to davide2's
local Whisper (/v1/audio/transcriptions). By default the transcript is spoken back in Davide's
cloned voice (/v1/speech, voice "me"); with --chat, an LLM answers as Davide instead (/v1/chat,
speak=true), with SYSTEM below as the prompt (davide2's own persona.md is still a stub) and the
last few turns as context. --llm picks davide2's LLM backend (claude-haiku is the quick one). The reply is resampled to 16 kHz with ffmpeg, scaled to the bench
speaker's tuned peak (firmware/mp_speaker_stream/tuned.json, else -20 dBFS) and streamed back.
Speech is soft-compressed first (tanh, --drive: 1.0 lifts quiet and average parts ~1.2 dB,
1.5 ~4.4 dB; peaks unchanged), then peaked at --peak (default -19 dBFS). On the bench, more
average power is the limit, not peaks: drive 1.5 at -18 dBFS sagged USB 5 V enough to reset the
CH343, and the Mac lost the board mid-reply (2026-10-09). More volume needs the bulk cap at the
amp or its own 5 V supply (docs/macropad-bench.md).
The OLED shows each stage. davide2 must be running: `cd ~/personal/projects/davide2 &&
OPEN=0 .venv/bin/voice-engine serve`.
Needs pyserial: run it with /opt/homebrew/opt/esptool/libexec/bin/python3 on this Mac.
"""

import array
import base64
import io
import json
import math
import os
import subprocess
import sys
import time
import urllib.request
import uuid
import wave

import serial

FS = 16000
FRAMES = 256
MIC_PKT = 4 + FRAMES * 2
WINDOW = 12
ACK = 0x06
HERE = os.path.dirname(os.path.abspath(__file__))
HISTORY_TURNS = 6
SYSTEM = (
    "You are Davide, talking out loud through a small macropad speaker on your own desk. You are a "
    "software engineer from Italy who builds keyboards for fun. Speak in first person, casual and "
    "cheeky, a bit irreverent; friendly swearing is fine. Answer what was actually said, with "
    "meaning, in one or two short sentences you would say aloud. Reply in the language the user "
    "spoke. No markdown, no emoji, no lists: this is turned into speech."
)


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def http(url, data=None, headers=None, timeout=300):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get("content-type", "")


def wav_bytes(samples, rate):
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.tobytes())
    return b.getvalue()


def transcribe(base, wav, lang=None):
    """Whisper in davide2. lang pins the language (auto-detect on short takes guesses wrong:
    Italian "dieci minuti" came back as "Tienke minuten")."""
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"take.wav\"\r\n"
            f"Content-Type: audio/wav\r\n\r\n").encode() + wav
    if lang:
        body += f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\n{lang}".encode()
    body += f"\r\n--{boundary}--\r\n".encode()
    out, _ = http(f"{base}/v1/audio/transcriptions", body, {"content-type": f"multipart/form-data; boundary={boundary}"})
    return json.loads(out).get("text", "").strip()


def to_board_pcm(audio, peak_db, drive=1.0):
    """Any audio davide2 returns -> 16 kHz mono int16: soft-compressed, peak at peak_db."""
    pcm = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "-", "-f", "s16le", "-ac", "1", "-ar", str(FS), "-"],
                         input=audio, check=True, capture_output=True).stdout
    a = array.array("h")
    a.frombytes(pcm[: len(pcm) // 2 * 2])
    pk = max(1, max((abs(v) for v in a), default=1))
    norm = math.tanh(drive) if drive > 0 else 1.0
    out_peak = 32767 * 10 ** (peak_db / 20)
    if drive > 0:  # tanh(drive * x) / tanh(drive): small signals x drive/tanh(drive), peaks stay at 1
        return array.array("h", (int(math.tanh(drive * v / pk) / norm * out_peak) for v in a))
    return array.array("h", (int(v / pk * out_peak) for v in a))


class Board:
    """Parses the board's mixed stream: text lines, MIC packets, END!, ACK bytes."""

    def __init__(self, port):
        self.s = serial.Serial()
        self.s.port, self.s.baudrate, self.s.timeout = port, 2_000_000, 0.02
        self.s.dtr = self.s.rts = False
        self.s.open()
        self.buf = b""
        self.acks = 0

    def reset(self):
        self.s.rts = True
        time.sleep(0.2)
        self.s.rts = False

    def events(self):
        """Yield ('line', str) / ('mic', bytes) / ('end', None) from what has arrived so far."""
        self.buf += self.s.read(max(1, self.s.in_waiting))
        while self.buf:
            if self.buf.startswith(b"MIC"):
                if len(self.buf) < MIC_PKT:
                    return
                yield "mic", self.buf[4:MIC_PKT]
                self.buf = self.buf[MIC_PKT:]
            elif self.buf.startswith(b"END!"):
                self.buf = self.buf[4:]
                yield "end", None
            elif self.buf[0] == 0:
                self.buf = self.buf.lstrip(b"\x00")
            elif self.buf[0] == ACK:
                self.acks += 1
                self.buf = self.buf[1:]
            elif b"MIC".startswith(self.buf[:3]) and len(self.buf) < 3 or b"END!".startswith(self.buf[:4]) and len(self.buf) < 4:
                return  # a tag still arriving
            else:
                nl = self.buf.find(b"\n")
                if nl == -1:
                    if len(self.buf) > 300:
                        self.buf = self.buf[1:]  # boot noise: resync
                        continue
                    return
                line, self.buf = self.buf[:nl], self.buf[nl + 1:]
                # boot chatter at 115200 reads as NULs at 2 Mbaud: keep only printable text
                text = "".join(ch for ch in line.decode(errors="replace") if ch.isprintable()).strip()
                if text:
                    yield "line", text

    def status(self, big, small=""):
        t = f"{big}|{small}".encode("ascii", "replace")[:60]
        self.s.write(b"STA" + bytes([len(t)]) + t)

    def play(self, samples):
        total = (len(samples) + FRAMES - 1) // FRAMES
        self.acks = sent = 0
        t0 = time.time()
        while self.acks < total:
            while sent < total and sent - self.acks < WINDOW:
                block = samples[sent * FRAMES:(sent + 1) * FRAMES]
                if len(block) < FRAMES:
                    block.extend([0] * (FRAMES - len(block)))
                self.s.write(b"SPK" + bytes([sent % 256]) + block.tobytes())
                sent += 1
            for kind, val in self.events():
                if kind == "line" and val == "rec start":
                    log("talk over playback: stopped")
                    return "interrupted"
            if time.time() - t0 > total * FRAMES / FS + 10:
                return f"stalled at {self.acks}/{total}"
        return "ok"


def main() -> int:
    port = sys.argv[1]
    base = arg("--url", "http://127.0.0.1:8777").rstrip("/")
    voice = arg("--voice", "me")
    chat = "--chat" in sys.argv
    llm = arg("--llm", "claude-haiku")
    lang = arg("--lang", "it")  # "auto" lets Whisper guess
    tuned = os.path.join(HERE, "..", "mp_speaker_stream", "tuned.json")
    peak = float(arg("--peak", -19))  # tuned.json says -20 for test tones; see the docstring
    drive = float(arg("--drive", 1.0))

    health, _ = http(f"{base}/v1/health", timeout=5)
    log(f"davide2 {json.loads(health).get('status')} at {base}, voice {voice}, mode {'chat (' + llm + ')' if chat else 'echo'}, language {lang}, speaker peak {peak:.0f} dBFS, drive {drive}")

    b = Board(port)
    b.reset()
    t0 = time.time()
    ready = False
    while not ready and time.time() - t0 < 10:
        for kind, val in b.events():
            if kind == "line" and val.startswith("mp_voice ready"):
                log(val)
                ready = True
    if not ready:
        log("no `mp_voice ready` from the board")
        return 1
    b.status("TALK", "K1 record  K2 stop")
    log("ready: K1 to record, K2 to stop")

    take = bytearray()
    history = []  # [{"role": ..., "content": ...}] of the last turns, for --chat
    while True:
        for kind, val in b.events():
            if kind == "line":
                if val == "rec start":
                    take = bytearray()
                    log("recording")
                elif val.startswith(("rec stop", "key ")):
                    log(val)
            elif kind == "mic":
                take += val
            elif kind == "end":
                handle(b, base, voice, chat, llm, lang, peak, drive, take, history)
                take = bytearray()


def handle(b, base, voice, chat, llm, lang, peak, drive, take, history):
    a = array.array("h")
    a.frombytes(bytes(take))
    if len(a) < FS // 4:
        b.status("TALK", "too short, K1 again")
        return
    mean = sum(a) / len(a)
    pk = max(1, max(abs(v - mean) for v in a))
    g = min(10 ** (40 / 20), 32767 * 0.7 / pk)
    clean = array.array("h", (int((v - mean) * g) for v in a))
    log(f"take {len(a) / FS:.1f} s, mic peak {20 * math.log10(pk / 32768):.0f} dBFS")

    try:
        b.status("LISTEN", "transcribing")
        t = time.time()
        text = transcribe(base, wav_bytes(clean, FS), None if lang == "auto" else lang)
        log(f"heard ({time.time() - t:.1f} s): {text!r}")
        if not text:
            b.status("?", "did not catch that")
            return
        b.status("THINK", text[:24])
        t = time.time()
        if chat:
            msgs = history[-2 * HISTORY_TURNS:] + [{"role": "user", "content": text}]
            out, _ = http(f"{base}/v1/chat", json.dumps({"messages": msgs, "voice": voice, "llm": llm, "system": SYSTEM,
                                                         "speak": True, "format": "wav"}).encode(),
                          {"content-type": "application/json"})
            reply = json.loads(out)
            say, audio = reply["text"].strip(), base64.b64decode(reply["audio"]["base64"])
            history += [{"role": "user", "content": text}, {"role": "assistant", "content": say}]
        else:
            say = text
            audio, _ = http(f"{base}/v1/speech", json.dumps({"text": say, "voice": voice, "format": "wav"}).encode(),
                            {"content-type": "application/json"})
        log(f"davide says ({time.time() - t:.1f} s): {say!r}")
        pcm = to_board_pcm(audio, peak, drive)
        b.status("SPEAK", say[:24])
        result = b.play(pcm)
        log(f"played {len(pcm) / FS:.1f} s: {result}")
    except Exception as e:  # keep the loop alive: show it and wait for the next take
        log(f"error: {e}")
        b.status("ERROR", str(e)[:24])
        return
    b.status("TALK", "K1 record  K2 stop")


def find_port(hint):
    """The board's port: the given one if it exists, else the first usbmodem (it can renumber)."""
    import glob
    if os.path.exists(hint):
        return hint
    ports = sorted(glob.glob("/dev/cu.usbmodem*"))
    return ports[0] if ports else None


if __name__ == "__main__":
    # Survive the board dropping off USB (unplugged, brown-out, reset): wait for it and reconnect.
    hint = sys.argv[1]
    while True:
        port = find_port(hint)
        if not port:
            log("board not on USB: waiting for it")
            while not (port := find_port(hint)):
                time.sleep(1)
            time.sleep(1.5)  # let the USB bridge settle
        sys.argv[1] = port
        try:
            sys.exit(main())
        except KeyboardInterrupt:
            break
        except (serial.SerialException, OSError) as e:
            log(f"lost the board ({e}); reconnecting")
            time.sleep(1)
