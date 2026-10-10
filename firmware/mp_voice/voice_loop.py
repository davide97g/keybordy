"""Push-to-talk voice loop over Wi-Fi: keybordy MP mic -> davide2 (local) -> keybordy MP speaker.

    voice_loop.py [--port 8778] [--chat] [--llm claude-haiku] [--url http://127.0.0.1:8777] [--voice me] [--peak DB] [--drive K] [--lang it]

With firmware/mp_voice on the board: K1 starts recording, K2 stops. The board POSTs the take
(16 kHz mono int16) to this script, which it finds over mDNS (_keybordy-voice._tcp, announced with
macOS's dns-sd). The take goes to davide2's local Whisper (/v1/audio/transcriptions). By default
the transcript is spoken back in Davide's cloned voice (/v1/speech, voice "me"); with --chat, an
LLM answers as Davide instead (/v1/chat, speak=true), with SYSTEM below as the prompt and the last
few turns as context. --llm picks davide2's LLM backend (claude-haiku is the quick one).
The reply is resampled to 16 kHz with ffmpeg, soft-compressed (tanh, --drive), peaked at --peak
(default -19 dBFS; louder sagged the bench's USB 5 V, see docs/macropad-bench.md) and streamed
back in the same HTTP response, with OLED status lines in between (protocol: mp_voice.ino).
The endpoint listens on the LAN; requests must carry ESP32_OTA_PASS from .env as
X-Keybordy-Token (the board gets it from bench_secrets.h). davide2 stays on localhost.
davide2 must be running: `cd ~/personal/projects/davide2 && OPEN=0 .venv/bin/voice-engine serve`.
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

import atexit
import threading
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FS = 16000
FRAMES = 256
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


def ascii_fold(text, n):
    """The OLED font is ASCII: "perché" -> "perche". No '|' or line breaks (protocol)."""
    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return " ".join(t.replace("|", "/").split())[:n]


def token():
    if os.environ.get("ESP32_OTA_PASS"):
        return os.environ["ESP32_OTA_PASS"]
    with open(os.path.join(HERE, "..", "..", ".env")) as f:
        for line in f:
            k, _, v = line.strip().partition("=")
            if k == "ESP32_OTA_PASS":
                return v.strip().strip("'\"")
    sys.exit("ESP32_OTA_PASS missing (env or .env)")


def handle(status, play, base, voice, chat, llm, lang, peak, drive, take, history):
    a = array.array("h")
    a.frombytes(take[: len(take) // 2 * 2])
    if len(a) < FS // 4:
        status("TALK", "too short, K1 again")
        return
    mean = sum(a) / len(a)
    pk = max(1, max(abs(v - mean) for v in a))
    g = min(10 ** (40 / 20), 32767 * 0.7 / pk)
    clean = array.array("h", (int((v - mean) * g) for v in a))
    log(f"take {len(a) / FS:.1f} s, mic peak {20 * math.log10(pk / 32768):.0f} dBFS")

    try:
        status("LISTEN", "transcribing")
        t = time.time()
        text = transcribe(base, wav_bytes(clean, FS), None if lang == "auto" else lang)
        log(f"heard ({time.time() - t:.1f} s): {text!r}")
        if not text:
            status("?", "did not catch that")
            return
        status("THINK", text)
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
        status("SPEAK", say)
        play(pcm)
        log(f"played {len(pcm) / FS:.1f} s")
    except (BrokenPipeError, ConnectionResetError):
        raise
    except Exception as e:  # keep the loop alive: show it and wait for the next take
        log(f"error: {e}")
        status("ERROR", str(e))
        return
    status("TALK", "K1 record  K2 stop")


def main() -> int:
    port = int(arg("--port", 8778))
    base = arg("--url", "http://127.0.0.1:8777").rstrip("/")
    voice = arg("--voice", "me")
    chat = "--chat" in sys.argv
    llm = arg("--llm", "claude-haiku")
    lang = arg("--lang", "it")  # "auto" lets Whisper guess
    peak = float(arg("--peak", -19))  # mp_speaker_stream/tuned.json says -20 for test tones; see the docstring
    drive = float(arg("--drive", 1.0))
    key = token()
    history = []  # [{"role": ..., "content": ...}] of the last turns, for --chat
    one_at_a_time = threading.Lock()

    health, _ = http(f"{base}/v1/health", timeout=5)
    log(f"davide2 {json.loads(health).get('status')} at {base}, voice {voice}, mode {'chat (' + llm + ')' if chat else 'echo'}, language {lang}, speaker peak {peak:.0f} dBFS, drive {drive}")

    class Take(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path != "/take" or self.headers.get("X-Keybordy-Token") != key:
                log(f"refused {self.path} from {self.client_address[0]}")
                self.send_error(403)
                return
            take = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()

            def status(big, small=""):
                self.wfile.write(f"S {ascii_fold(big, 15)}|{ascii_fold(small, 25)}\n".encode())
                self.wfile.flush()

            def play(pcm):
                self.wfile.write(f"P {len(pcm) * 2}\n".encode() + pcm.tobytes())
                self.wfile.flush()

            with one_at_a_time:
                try:
                    handle(status, play, base, voice, chat, llm, lang, peak, drive, take, history)
                except (BrokenPipeError, ConnectionResetError):
                    log("board hung up")

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("0.0.0.0", port), Take)
    mdns = subprocess.Popen(["dns-sd", "-R", "keybordy-voice", "_keybordy-voice._tcp", "local", str(port)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    atexit.register(mdns.terminate)
    log(f"listening on :{port} as _keybordy-voice._tcp: K1 to record, K2 to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
