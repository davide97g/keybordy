"""The talk bar's Mac side: keybordy MP take -> Echo transcript -> `claude -p` -> Echo voice -> board.

    /usr/bin/python3 host/voice.py [--port 8779]

Hammerspoon (host/hammerspoon/keybordy.lua) starts and restarts it; run it by hand only to debug.
Apple's /usr/bin/python3, not Homebrew's: the app firewall blocks incoming connections to the
latter. Stdlib only, plus ffmpeg and the `claude` CLI.

The board (firmware/mp_pcb) finds it over mDNS as _keybordy-pad._tcp (announced with dns-sd) and
POSTs the take, 16 kHz mono int16 LE. Requests carry ESP32_OTA_PASS from .env as X-Keybordy-Token
(the board has it from bench_secrets.h). The answer goes back in the same HTTP response, line by line:
    S BIG|small\n        OLED status
    T text\n             the answer, scrolling on the OLED while it is spoken
    C question\n         Claude wants a yes or no: the board waits for K22 (yes) or K19 (no)
    P <bytes>\n          then that many bytes of 16 kHz mono int16 LE to play
POST /take answers a take; POST /yes and /no answer Claude's question (K22, K19); POST /new (E1
tap) starts a new Claude session; POST /replay (K20, when the board has no answer in memory, e.g.
after a reboot) sends the last spoken answer again.

The take is transcribed by Echo's Whisper (/v1/audio/transcriptions), then `claude -p` answers in
the folder and with the tools set in the keymap editor (keymap.json "voice"), resuming one session
until /new. The answer is spoken by Echo (/v1/speech, streamed sentence by sentence) in the voice
set there ("me" = Davide) and each sentence goes to the board as soon as it is ready. Echo is
started on the first take if it is not running.

Stdout lines starting with "EV " are JSON events for Hammerspoon's activity log.
"""

import array
import base64
import json
import math
import os
import re
import signal
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FS = 16000
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
HOME = os.path.expanduser("~")
CONFIG_DIR = os.path.join(HOME, ".config", "keybordy")
KEYMAP = os.path.join(CONFIG_DIR, "keymap.json")
SESSION_FILE = os.path.join(CONFIG_DIR, "voice-session.json")
PID_FILE = os.path.join(CONFIG_DIR, "voice.pid")
LAST_PCM = os.path.join(CONFIG_DIR, "last-answer.pcm")   # 16 kHz int16, as the board played it
LAST_TEXT = os.path.join(CONFIG_DIR, "last-answer.txt")
ECHO_URL = "http://127.0.0.1:8777"
ECHO_DIR = os.environ.get("ECHO_DIR", os.path.join(HOME, "personal", "projects", "echo"))
PEAK_DB = -19      # the speaker's clean peak, see firmware/mp_voice/voice_loop.py
DRIVE = 1.0        # tanh soft compression
# Hammerspoon starts this with launchd's bare PATH.
os.environ["PATH"] = os.pathsep.join([os.path.join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin",
                                      os.environ.get("PATH", "/usr/bin:/bin")])

# Defaults for keymap.json "voice"; the editor writes the same fields.
DEFAULTS = {
    "dir": "~",
    "tools": "Read,Glob,Grep,WebSearch,WebFetch",
    "model": "",
    "voice": "me",
    "language": "it",
    "prompt": "",
}
# Tools `claude -p` never gets unless they are listed in "tools".
RISKY = ["Bash", "Edit", "Write", "NotebookEdit"]
SPOKEN = (
    "You are answering out loud through the small speaker of Davide's keybordy macropad, in his own "
    "cloned voice. What you write is turned into speech: no markdown, no lists, no emoji, no code, no "
    "URLs. Answer in one to three short spoken sentences, in the language the user spoke, unless they "
    "ask for more. If you used tools, say what you found, not how. When you need a yes or no from the "
    "user before going on (to confirm an action, or to pick between two things), ask it as your last "
    "sentence and end with the marker [CONFIRM: the question in at most eight words]. The marker is "
    "not spoken; the user answers with a YES or a NO key and you get \"yes\" or \"no\" back."
)
CONFIRM = re.compile(r"\[CONFIRM:?\s*(.*?)\]", re.S)
# What a YES/NO key says to Claude, by the language set in the editor.
YES_NO = {"it": ("Sì.", "No."), "en": ("Yes.", "No.")}


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def event(**kw):
    print("EV " + json.dumps(kw), flush=True)


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def http(url, data=None, headers=None, timeout=300):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def settings():
    try:
        with open(KEYMAP) as f:
            v = json.load(f).get("voice") or {}
    except (OSError, ValueError):
        v = {}
    return {k: (v.get(k) if isinstance(v.get(k), str) else d) for k, d in DEFAULTS.items()}


def token():
    if os.environ.get("ESP32_OTA_PASS"):
        return os.environ["ESP32_OTA_PASS"]
    with open(os.path.join(REPO, ".env")) as f:
        for line in f:
            k, _, v = line.strip().partition("=")
            if k == "ESP32_OTA_PASS":
                return v.strip().strip("'\"")
    sys.exit("ESP32_OTA_PASS missing (env or .env)")


def ascii_fold(text, n):
    """The OLED font is ASCII: "perché" -> "perche". No '|' or line breaks (protocol)."""
    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return " ".join(t.replace("|", "/").split())[:n]


# ── Echo ──────────────────────────────────────────────────────────────────────

echo_lock = threading.Lock()


def echo_up():
    try:
        return json.loads(http(f"{ECHO_URL}/v1/health", timeout=2)).get("status") == "ok"
    except Exception:
        return False


def ensure_echo(status):
    """Starts Echo (models load for a while) unless it already answers. It keeps running after."""
    with echo_lock:
        if echo_up():
            return
        exe = os.path.join(ECHO_DIR, ".venv", "bin", "echo-voice")
        if not os.path.exists(exe):
            raise RuntimeError("Echo not installed")
        status("ECHO", "starting Echo...")
        log(f"starting Echo from {ECHO_DIR}")
        with open(os.path.join(CONFIG_DIR, "echo.log"), "ab") as out:
            subprocess.Popen([exe, "serve"], cwd=ECHO_DIR, env={**os.environ, "OPEN": "0"}, stdout=out,
                             stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
        for _ in range(180):
            if echo_up():
                return
            time.sleep(1)
        raise RuntimeError("Echo did not start")


def transcribe(wav, lang):
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"take.wav\"\r\n"
            f"Content-Type: audio/wav\r\n\r\n").encode() + wav
    if lang and lang != "auto":
        body += f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\n{lang}".encode()
    body += f"\r\n--{boundary}--\r\n".encode()
    out = http(f"{ECHO_URL}/v1/audio/transcriptions", body,
               {"content-type": f"multipart/form-data; boundary={boundary}"})
    return json.loads(out).get("text", "").strip()


def speak(text, voice, lang):
    """Yields (pcm bytes, sample rate, pause s) per sentence as Echo renders them."""
    req = urllib.request.Request(f"{ECHO_URL}/v1/speech", json.dumps(
        {"text": text, "voice": voice, "language": lang or "auto", "format": "pcm", "stream": True}).encode(),
        {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        for raw in r:
            line = raw.decode().strip()
            if not line.startswith("data:"):
                continue
            ev = json.loads(line[5:])
            if ev.get("type") == "chunk":
                yield base64.b64decode(ev["audio"]), int(ev.get("sample_rate", 24000)), float(ev.get("pause", 0))
            elif ev.get("type") == "error":
                raise RuntimeError(ev.get("message", "speech failed"))


def wav_bytes(samples, rate):
    import io
    import wave
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.tobytes())
    return b.getvalue()


def to_board_pcm(pcm, rate, pause):
    """Echo's s16le at `rate` -> 16 kHz int16, soft-compressed, peaked at PEAK_DB, plus the pause."""
    if rate != FS:
        pcm = subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", "-",
                              "-f", "s16le", "-ar", str(FS), "-ac", "1", "-"],
                             input=pcm, check=True, capture_output=True).stdout
    a = array.array("h")
    a.frombytes(pcm[: len(pcm) // 2 * 2])
    pk = max(1, max((abs(v) for v in a), default=1))
    norm = math.tanh(DRIVE)
    out_peak = 32767 * 10 ** (PEAK_DB / 20)
    out = array.array("h", (int(math.tanh(DRIVE * v / pk) / norm * out_peak) for v in a))
    out.extend([0] * int(pause * FS))
    return out


# ── Claude ────────────────────────────────────────────────────────────────────

def load_session():
    try:
        with open(SESSION_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_session(sid, cwd):
    with open(SESSION_FILE, "w") as f:
        json.dump({"id": sid, "dir": cwd} if sid else {}, f)


def tool_note(block):
    """What a tool call is doing, for the OLED's small line."""
    name, inp = block.get("name", "tool"), block.get("input") or {}
    detail = inp.get("query") or inp.get("pattern") or inp.get("file_path") or inp.get("url") or inp.get("command") or ""
    return f"{name} {os.path.basename(detail) if detail.startswith('/') else detail}".strip()


def ask_claude(text, cfg, status):
    """Runs `claude -p` on the transcript, resuming the current session. Returns the answer."""
    cwd = os.path.abspath(os.path.expanduser(cfg["dir"] or "~"))
    allowed = [t.strip() for t in cfg["tools"].split(",") if t.strip()]
    denied = [t for t in RISKY if not any(a == t or a.startswith(t + "(") for a in allowed)]
    cmd = ["claude", "-p", text, "--output-format", "stream-json", "--verbose",
           # The voice gets plain answers: hooks (output styles, session injections) stay out.
           "--settings", json.dumps({"disableAllHooks": True}),
           # Resumed sessions get today's prompt, so edits to it (editor, SPOKEN) apply at once.
           "--system-prompt-snapshot", "off",
           "--append-system-prompt", SPOKEN + (" " + cfg["prompt"] if cfg["prompt"] else "")]
    if allowed:
        cmd += ["--allowedTools", ",".join(allowed)]
    if denied:
        cmd += ["--disallowedTools", ",".join(denied)]
    if cfg["model"]:
        cmd += ["--model", cfg["model"]]
    sess = load_session()
    if sess.get("id") and sess.get("dir") == cwd:
        cmd += ["--resume", sess["id"]]
    for attempt in range(2):
        proc = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        result = None
        for line in proc.stdout:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") == "assistant":
                for block in ev.get("message", {}).get("content", []):
                    if block.get("type") == "tool_use":
                        note = tool_note(block)
                        log(f"claude uses {note}")
                        status("THINK", note)
            elif ev.get("type") == "result":
                result = ev
        err = proc.stderr.read()
        proc.wait()
        if result and not result.get("is_error"):
            save_session(result.get("session_id"), cwd)
            return (result.get("result") or "").strip()
        # A session that cannot be resumed (deleted, other folder): start over once.
        if "--resume" in cmd and attempt == 0:
            log(f"resume failed, new session: {(err or json.dumps(result))[:200]}")
            i = cmd.index("--resume")
            del cmd[i:i + 2]
            continue
        raise RuntimeError((result or {}).get("result") or err.strip()[-200:] or f"claude exit {proc.returncode}")


# ── Requests ──────────────────────────────────────────────────────────────────

def answer(take, status, play):
    cfg = settings()
    a = array.array("h")
    a.frombytes(take[: len(take) // 2 * 2])
    if len(a) < FS // 4:
        status("TALK", "too short: hold the bar")
        return
    mean = sum(a) / len(a)
    pk = max(1, max(abs(v - mean) for v in a))
    g = min(10 ** (40 / 20), 32767 * 0.7 / pk)
    clean = array.array("h", (int((v - mean) * g) for v in a))
    log(f"take {len(a) / FS:.1f} s, mic peak {20 * math.log10(pk / 32768):.0f} dBFS")
    event(kind="take", seconds=round(len(a) / FS, 1))

    ensure_echo(status)
    status("LISTEN", "transcribing")
    t = time.time()
    text = transcribe(wav_bytes(clean, FS), cfg["language"])
    log(f"heard ({time.time() - t:.1f} s): {text!r}")
    if not text:
        status("?", "did not catch that")
        event(kind="heard", text="")
        return
    event(kind="heard", text=text)
    respond(text, cfg, status, play)


def confirm(yes, status, play):
    """K22/K19 on Claude's question: the answer goes on in the same session."""
    cfg = settings()
    text = YES_NO.get(cfg["language"], YES_NO["en"])[0 if yes else 1]
    log(f"key answer: {text}")
    event(kind="take", seconds=0)
    event(kind="heard", text=f"{text} ({'K22' if yes else 'K19'})")
    ensure_echo(status)
    respond(text, cfg, status, play)


def respond(text, cfg, status, play):
    """Claude's answer to `text`, spoken to the board with the text scrolling on the OLED."""
    status("THINK", text)
    t = time.time()
    raw = ask_claude(text, cfg, status)
    m = CONFIRM.search(raw)
    question = (m.group(1).strip() if m else "") or None
    say = CONFIRM.sub("", raw).strip()
    if m and not question:  # the marker without a summary: the last sentence is the question
        question = re.split(r"(?<=[.!?])\s+", say)[-1]
    log(f"claude ({time.time() - t:.1f} s): {say!r}" + (f" asks {question!r}" if question else ""))
    event(kind="reply", text=say + (f"\n[yes/no: {question}]" if question else ""))
    if not say:
        status("?", "no answer")
        return
    status("SPEAK", "")
    if question:
        status_line(status, "C", question)   # the board waits for K22/K19 from here on
    else:
        status_line(status, "T", say)
    t = time.time()
    spoken = array.array("h")
    for pcm, rate, pause in speak(say, cfg["voice"], cfg["language"]):
        out = to_board_pcm(pcm, rate, pause)
        spoken.extend(out)
        play(out)
    log(f"spoke {len(spoken) / FS:.1f} s ({time.time() - t:.1f} s to render)")
    with open(LAST_PCM, "wb") as f:
        f.write(spoken.tobytes())
    with open(LAST_TEXT, "w") as f:
        f.write(say)
    if question:
        status("YES/NO?", "K22 yes   K19 no")
    else:
        status("DONE", "K20 to hear it again")


def status_line(status, kind, text):
    """T and C lines go through the same writer as S: `status` takes the raw line here."""
    status(None, f"{kind} {ascii_fold(text, 190)}")


def replay(status, play):
    try:
        with open(LAST_PCM, "rb") as f:
            pcm = array.array("h")
            pcm.frombytes(f.read())
        with open(LAST_TEXT) as f:
            say = f.read()
    except OSError:
        status("REPLAY", "nothing said yet")
        return
    log(f"replay {len(pcm) / FS:.1f} s")
    event(kind="replay", text=say)
    status("REPLAY", "")
    status_line(status, "T", say)
    play(pcm)
    status("DONE", ascii_fold(say, 25))


def main() -> int:
    port = int(arg("--port", 8779))
    key = token()
    os.makedirs(CONFIG_DIR, exist_ok=True)
    stop_previous()
    one_at_a_time = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path not in ("/take", "/new", "/replay", "/yes", "/no") or self.headers.get("X-Keybordy-Token") != key:
                log(f"refused {self.path} from {self.client_address[0]}")
                self.send_error(403)
                return
            take = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()

            def status(big, small=""):
                line = small if big is None else f"S {ascii_fold(big, 11)}|{ascii_fold(small, 25)}"
                self.wfile.write(f"{line}\n".encode())
                self.wfile.flush()

            def play(pcm):
                self.wfile.write(f"P {len(pcm) * 2}\n".encode() + pcm.tobytes())
                self.wfile.flush()

            if self.path == "/new":
                save_session(None, None)
                log("new session")
                event(kind="new")
                status("NEW", "new Claude session")
                return
            if self.path == "/replay":
                try:
                    replay(status, play)
                except (BrokenPipeError, ConnectionResetError):
                    log("board hung up")
                return
            if not one_at_a_time.acquire(blocking=False):
                status("BUSY", "still answering")
                return
            try:
                if self.path == "/take":
                    answer(take, status, play)
                else:
                    confirm(self.path == "/yes", status, play)
            except (BrokenPipeError, ConnectionResetError):
                log("board hung up")
            except Exception as e:  # keep serving: show it and wait for the next take
                log(f"error: {e}")
                event(kind="error", text=str(e))
                try:
                    status("ERROR", str(e))
                except OSError:
                    pass
            finally:
                one_at_a_time.release()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    mdns = subprocess.Popen(["dns-sd", "-R", "keybordy-pad", "_keybordy-pad._tcp", "local", str(port)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))

    def shutdown(*_):
        mdns.terminate()
        os._exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    threading.Thread(target=watch_parent, args=(shutdown,), daemon=True).start()
    log(f"listening on :{port} as _keybordy-pad._tcp, Echo at {ECHO_URL}, claude {shutil.which('claude') or 'NOT FOUND'}")
    event(kind="ready", port=port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    shutdown()
    return 0


def stop_previous():
    """A Hammerspoon reload can leave the last instance running: stop it so the port is free."""
    try:
        with open(PID_FILE) as f:
            pid = int(f.read().strip())
        cmd = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True).stdout
        if pid != os.getpid() and "voice.py" in cmd:
            os.kill(pid, signal.SIGTERM)
            time.sleep(0.5)
    except (OSError, ValueError):
        pass


def watch_parent(shutdown):
    """Exit with Hammerspoon: when it goes away this process is reparented to launchd."""
    parent = os.getppid()
    while True:
        time.sleep(2)
        if os.getppid() != parent:
            shutdown()


if __name__ == "__main__":
    sys.exit(main())
