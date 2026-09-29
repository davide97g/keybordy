import asyncio
import hashlib
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator, model_validator

from app.services import build_queue
from app.services.arduino_cli import ArduinoCLIService
from app.services.espidf_compiler import espidf_compiler

logger = logging.getLogger(__name__)

router = APIRouter()
arduino_cli = ArduinoCLIService()

# ── Async compile job registry ───────────────────────────────────────────────
# In-process job dict for /compile/start + /compile/status/{job_id}. Cold ESP-IDF
# builds can take 5-7 minutes — longer than a typical proxy read timeout on a
# single HTTP request. The async path lets the client poll a short-lived status
# endpoint instead of holding one long-lived POST open.
#
# Single process only (one uvicorn worker), which is all a local install runs.
COMPILE_JOBS: dict[str, dict[str, Any]] = {}
JOB_BY_KEY: dict[str, str] = {}  # content_hash → job_id, for deduplication
JOB_TTL_S = 1800  # purge results 30 min after completion

# ── Artifact cache ────────────────────────────────────────────────────────
# The dedup above only collapses builds that are still in flight, so hitting
# Run twice on the same sketch rebuilt it from scratch: measured 28 s cold and
# 27 s warm for an ESP-IDF P4 example, all of it before the emulator even
# starts. Identical sources build identical bytes, so the first build can be
# served again. Results are stored under the build volume, keyed by the same
# content hash the dedup uses.
ARTIFACT_CACHE_DIR = Path(
    os.environ.get("VELXIO_ARTIFACT_CACHE", "/var/lib/velxio-build/artifacts")
)


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int(os.environ.get(name, "").strip() or default)
    except ValueError:
        logger.warning("[compile] %s is not an integer; using %d", name, default)
        return default
    return max(lo, min(hi, value))


# Entries are bimodal — a 2 KB AVR hex or a 5 MB merged ESP32 flash image —
# so the cache is capped both by count and by bytes (env-tunable).
# 0 bytes = no byte cap.
ARTIFACT_CACHE_MAX_ENTRIES = _env_int("VELXIO_ARTIFACT_CACHE_MAX_ENTRIES", 400, 10, 100_000)
ARTIFACT_CACHE_MAX_BYTES = _env_int("VELXIO_ARTIFACT_CACHE_MAX_BYTES", 0, 0, 1 << 40)
ARTIFACT_CACHE_MAX_AGE_S = 14 * 24 * 3600
# A store walks the whole directory to prune; with thousands of entries that
# is ~100 ms of stat calls, so it runs off the event loop and only every so
# many stores. The cap is therefore soft by up to this many entries.
_ARTIFACT_PRUNE_EVERY = 25
_artifact_stores_since_prune = 0

def _toolchain_epoch() -> str:
    """Fingerprint everything that TURNS a request into build flags.

    A cached binary is only valid while the sdkconfig/CLI generation behind it
    is unchanged — flipping CONFIG_SPIRAM_MEMTEST off, say, must not keep
    serving images built with it on. Hashing the two service modules makes the
    invalidation automatic: edit them, every key changes.

    The CONFIG_* lines themselves do NOT live in those modules: they live in
    the esp-idf-template tree (sdkconfig.defaults.in, the CMakeLists, main.cpp,
    partitions.csv), which the compiler renders and builds. A template-only
    change used to leave the epoch untouched, so every sketch already in the
    cache kept its stale image forever — measured when turning FatFs long
    names on reached only sketches nobody had compiled before (2026-09-06).
    Hash that tree too, path and bytes, in a stable order.
    """
    h = hashlib.sha256()
    here = Path(__file__).resolve().parents[2] / "services"
    for name in ("espidf_compiler.py", "arduino_cli.py"):
        try:
            h.update((here / name).read_bytes())
        except OSError:
            h.update(b"?")
    template_dir = here / "esp-idf-template"
    try:
        for path in sorted(p for p in template_dir.rglob("*") if p.is_file()):
            h.update(str(path.relative_to(template_dir)).encode())
            h.update(path.read_bytes())
    except OSError:
        h.update(b"?")
    return h.hexdigest()[:16]


_TOOLCHAIN_EPOCH = _toolchain_epoch()


def _artifact_path(key: str) -> Path:
    return ARTIFACT_CACHE_DIR / f"{key}.json"


def _artifact_load(key: str) -> dict | None:
    """Return a cached CompileResponse dict, or None. Never raises."""
    path = _artifact_path(key)
    try:
        if not path.is_file():
            return None
        data = json.loads(path.read_text())
        if not isinstance(data, dict):
            return None
        # Age from when it was BUILT, not from the last read: touch-on-read
        # (kept below, it is what the LRU prune orders on) made a popular
        # artifact immortal and served bytes built against libraries that had
        # since changed. Entries stored before built_at existed age by mtime.
        built_at = data.get("built_at") or path.stat().st_mtime
        if time.time() - float(built_at) > ARTIFACT_CACHE_MAX_AGE_S:
            path.unlink(missing_ok=True)
            return None
        os.utime(path, None)  # LRU: touch on read
        return data
    except Exception:
        logger.warning("[compile] artifact cache read failed", exc_info=True)
        return None


def _artifact_store_sync(key: str, result: dict) -> None:
    """Persist a SUCCESSFUL build. Failures are never cached — a compile error
    is usually the user's half-written code, and they will edit and retry.

    Blocking: json.dumps of a 5 MB image plus the write plus (every so many
    stores) the prune walk. Call through `_artifact_store` from the loop.
    """
    global _artifact_stores_since_prune
    if not result.get("success"):
        return
    try:
        ARTIFACT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        # The build log is per-run noise and can be hundreds of KB; a cache hit
        # says so in its place rather than replaying someone else's ninja run.
        slim = dict(result)
        slim["stdout"] = "[served from the build cache - identical sources]"
        slim["built_at"] = time.time()
        tmp = _artifact_path(key).with_suffix(".tmp")
        tmp.write_text(json.dumps(slim))
        tmp.replace(_artifact_path(key))
        _artifact_stores_since_prune += 1
        if _artifact_stores_since_prune >= _ARTIFACT_PRUNE_EVERY:
            _artifact_stores_since_prune = 0
            _artifact_prune()
    except Exception:
        logger.warning("[compile] artifact cache write failed", exc_info=True)


async def _artifact_store(key: str, result: dict) -> None:
    await asyncio.to_thread(_artifact_store_sync, key, result)


def _artifact_prune() -> None:
    """Keep the newest ARTIFACT_CACHE_MAX_ENTRIES files (LRU by mtime), and
    within ARTIFACT_CACHE_MAX_BYTES when a byte cap is set."""
    try:
        entries = []
        with os.scandir(ARTIFACT_CACHE_DIR) as it:
            for entry in it:
                if entry.name.endswith(".json") and entry.is_file():
                    st = entry.stat()
                    entries.append((st.st_mtime, st.st_size, entry.path))
        entries.sort(reverse=True)  # newest first
        total = 0
        for idx, (_mtime, size, path) in enumerate(entries):
            total += size
            over_count = idx >= ARTIFACT_CACHE_MAX_ENTRIES
            over_bytes = ARTIFACT_CACHE_MAX_BYTES > 0 and total > ARTIFACT_CACHE_MAX_BYTES
            if over_count or over_bytes:
                try:
                    os.unlink(path)
                except OSError:
                    pass
    except Exception:
        pass

# ── Concurrency control ──────────────────────────────────────────────────────
# Two lanes, gated by app.services.build_queue. HEAVY = ESP-IDF (cmake + ninja,
# minutes on a cold cache): capped low — the VPS is modest (saw load avg 30 with
# 6 ninja processes peeling each other apart). LIGHT = arduino-cli boards (AVR,
# RP2040, STM32...): seconds each, so they get their own slots and never queue
# behind an ESP-IDF cold build. Before the split a single Semaphore(2) gated
# both, and a Uno blink could sit "compiling" for minutes while two ESP32 builds
# ran.
#
# BuildQueue replaced the two semaphores so the route can tell a waiting user
# that their build is queued. The queue is unbounded on purpose — a build is
# never refused, only delayed.
#
# There is NO per-target lock here any more. There used to be one, taken
# INSIDE the lane slot, keyed on (idf_target, arduino variant): with 78% of
# heavy builds on esp32:esp32:esp32 the second heavy slot spent whole hours
# holding a slot while blocked on it (2026-09-02 12:00: one slot 3647 s of
# build, the other 943 s, queue p50 43 min). The shared resource is the
# persistent build DIRECTORY, and espidf_compiler serialises on exactly that
# (`_variant_lock`, one per variant or replica); arduino-cli builds in a fresh
# temp dir per call and never needed a lock.


def _is_heavy_compile(board_fqbn: str) -> bool:
    """ESP32 boards compile with ESP-IDF when the toolchain is present."""
    return board_fqbn.startswith("esp32:") and espidf_compiler.available


def _build_identity(board_fqbn: str) -> str:
    """The identity of the persistent BUILD DIRECTORY this FQBN compiles in.

    Used to key the per-target duration estimate (`_estimate_key`). It was
    also the key of a route-level build lock until 2026-09; the compiler now
    serialises on its own per-variant locks. The identity is still the build
    dir's, which `_prepare_persistent_project_dir` keys on (idf_target,
    variant), NOT on the FQBN. Several FQBNs map to one variant:
    arduino-esp32's boards.txt gives both `esp32` and `esp32cam`
    `build.variant=esp32`, so they land in the SAME directory.

    Keying the lock on the FQBN therefore left the two of them free to run at
    once inside one build dir. Measured: compiling `esp32:esp32:esp32` and
    `esp32:esp32:esp32cam` concurrently returned BYTE-IDENTICAL firmware (same
    sha256, 285504 bytes) and the esp32cam request got the other sketch's
    binary — its serial printed the other example's output. In the app that
    looked like an example running someone else's program: two gallery tabs
    open, and the second one shows the first one's log and does nothing.

    Falls back to the raw FQBN if the compiler cannot resolve the pair, which
    is the previous behaviour and never less strict than it needs to be for a
    board whose variant we could not read.
    """
    # Only the ESP-IDF lane HAS a shared build dir (the predicate is the same
    # one _run_compile routes on). An AVR / RP2040 / STM32 FQBN has no IDF
    # target at all, and _idf_target defaults unknown boards to 'esp32' — so
    # every non-ESP32 board used to collapse onto the `esp32::esp32` key and
    # queue behind unrelated ESP32 builds for no reason.
    if not board_fqbn.startswith("esp32:"):
        return board_fqbn
    try:
        target = espidf_compiler._idf_target(board_fqbn)
        variant = espidf_compiler._arduino_variant(board_fqbn, target)
        return f"{target}::{variant}"
    except Exception:  # noqa: BLE001 - identity is best-effort; FQBN is a safe fallback
        return board_fqbn


# ── Progress + duration estimation ───────────────────────────────────────────
# A spinner does not tell anyone whether to wait 8 seconds or 4 minutes, and a
# cold ESP-IDF build looks identical to a hung one. Two sources feed the bar the
# frontend draws:
#
#   1. REAL progress, when the build emits it. ninja prefixes every action with
#      `[done/total]`, which is an exact fraction of the work left. Nothing
#      guesses while that number is available.
#   2. A time estimate for the rest — arduino-cli prints no counter at all, and
#      even a ninja build has a silent cmake phase before the first action.
#      `_DURATION_EMA` learns the real duration per build identity as builds
#      complete, so the estimate is this server's actual numbers rather than a
#      constant, from the second build of a given target onwards.

_NINJA_PROGRESS_RE = re.compile(r"^\s*\[(\d+)/(\d+)\]")

# Seed estimates, in seconds, until the EMA has seen a real build. Deliberately
# on the pessimistic side: a bar that arrives early reads as fast, one that
# stalls at 99% reads as broken.
_SEED_ESTIMATE_S = {"heavy": 150.0, "light": 20.0}

# Weight of the newest sample. High enough to follow a cache going cold within
# a couple of builds, low enough that one outlier does not move the bar.
_EMA_ALPHA = 0.3

_DURATION_EMA: dict[str, float] = {}


def _estimate_key(lane: str, board_fqbn: str) -> str:
    return f"{lane}:{_build_identity(board_fqbn)}"


def _estimated_seconds(lane: str, board_fqbn: str) -> float:
    return _DURATION_EMA.get(
        _estimate_key(lane, board_fqbn), _SEED_ESTIMATE_S.get(lane, 60.0)
    )


def _record_duration(lane: str, board_fqbn: str, seconds: float) -> None:
    """Fold one completed build's wall time into the running estimate.

    Only the BUILD is measured — queue time is excluded by the caller, or a
    busy hour would teach the estimator that this target takes ten minutes and
    leave the bar crawling once the queue drains.
    """
    if seconds <= 0 or seconds > 3600:
        return
    key = _estimate_key(lane, board_fqbn)
    prev = _DURATION_EMA.get(key)
    _DURATION_EMA[key] = seconds if prev is None else (
        _EMA_ALPHA * seconds + (1 - _EMA_ALPHA) * prev
    )


def _scan_progress(line: str, job: dict[str, Any]) -> None:
    """Update a job's `progress` / `stage` from one line of build output.

    Cheap enough to run per line: one regex against the head of the string,
    then a few substring checks on the phase keywords.
    """
    match = _NINJA_PROGRESS_RE.match(line)
    if match:
        done, total = int(match.group(1)), int(match.group(2))
        if total <= 0:
            return
        # An ESP-IDF build runs NESTED ninjas: the bootloader is its own
        # ExternalProject with its own small counter, so a raw reading goes
        # [480/500] -> [3/40] and the bar visibly collapses mid-build. Track
        # the largest total seen and ignore counters from a much smaller run —
        # those belong to a sub-project, not to the work the user is waiting on.
        biggest = int(job.get("progress_total", 0))
        if total >= biggest:
            job["progress_total"] = total
        elif total * 4 < biggest:
            return
        # Held below 1.0 — ninja hits [512/512] well before esptool has
        # produced the image the user is actually waiting for.
        fraction = min(0.97, done / total)
        # Never walk backwards: a bar that retreats reads as a bug even when
        # the underlying number is honest.
        job["progress"] = max(float(job.get("progress") or 0.0), fraction)
        job["stage"] = "compiling"
        return
    lowered = line.lower()
    if "linking" in lowered:
        job["stage"] = "linking"
    elif "esptool" in lowered or "creating esp32" in lowered:
        # Deliberately NOT keying on bare "generating": cmake's configure phase
        # prints "Generating done" minutes before any compilation, and the
        # first live ESP32 probe (2026-09-01) showed the card saying
        # "packaging" while cmake was still configuring.
        job["stage"] = "packaging"


def _job_progress(job: dict[str, Any]) -> tuple[float | None, float | None]:
    """(progress 0..1, estimated total seconds) for a status response.

    Returns the measured fraction when the build reported one, otherwise an
    elapsed/estimate ratio capped short of full. A queued job has neither — it
    has not started, and pretending otherwise would show a bar that moves while
    nothing is happening.
    """
    if job.get("state") in ("done", "error"):
        return 1.0, None
    if job.get("stage") == "queued":
        return None, None
    estimate = job.get("estimate_s")
    measured = job.get("progress")
    if measured is not None:
        return float(measured), estimate
    run_started = job.get("run_started_at")
    if run_started is None or not estimate:
        return None, estimate
    elapsed = max(0.0, time.time() - run_started)
    # Asymptotic tail: an overrunning build keeps creeping instead of parking
    # at the cap, so the bar never looks frozen on a slower-than-usual run.
    ratio = elapsed / float(estimate)
    return (min(0.9, ratio) if ratio < 0.9 else 0.9 + 0.09 * (1 - 1 / (1 + ratio - 0.9))), estimate


def _job_display_fields(job_id: str) -> dict[str, Any]:
    """The per-job labels that must survive a wholesale COMPILE_JOBS rewrite.

    `_compile_job` replaces the whole job dict on completion (simpler than
    patching six keys under a race), which used to drop the queue metadata with
    it.
    """
    job = COMPILE_JOBS.get(job_id) or {}
    return {
        key: job[key]
        for key in ("lane", "estimate_s", "run_started_at")
        if key in job
    }


def _job_key(
    files: list[dict[str, str]],
    board_fqbn: str,
    board_options: dict | None = None,
    spiffs_files: list[dict] | None = None,
    libraries: list[str] | None = None,
    language: str | None = None,
    custom_wifi_ssids: list[str] | None = None,
) -> str:
    """Stable content hash of (files, board, options, spiffs, libraries)
    used as the deduplication key.

    File order is normalised so the same set of files in any order produces
    the same key. Board options and SPIFFS files are included so a partition /
    scheme / file change queues a fresh build rather than serving the previous
    cached job.
    """
    h = hashlib.sha256()
    # Bind every key to the code that generates build flags: a binary cached
    # before a sdkconfig change must not be served after it.
    h.update(_TOOLCHAIN_EPOCH.encode())
    h.update(b"\0")
    h.update(board_fqbn.encode())
    h.update(b"\0")
    for f in sorted(files, key=lambda x: x["name"]):
        h.update(f["name"].encode())
        h.update(b"\0")
        h.update(f["content"].encode())
        h.update(b"\0")
    if board_options:
        # Sort keys so option-order doesn't perturb the hash.
        import json
        h.update(json.dumps(board_options, sort_keys=True).encode())
        h.update(b"\0")
    if custom_wifi_ssids:
        # Custom APs suppress the SSID rewrite, so the same source builds
        # DIFFERENT bytes with vs without them — the key must see it. Only
        # presence matters for the rewrite, but hash the sorted list so a
        # rename also invalidates cleanly.
        for ssid in sorted(custom_wifi_ssids):
            h.update(ssid.encode())
            h.update(b"\0")
        h.update(b"\0custom-aps\0")
    if spiffs_files:
        for f in sorted(spiffs_files, key=lambda x: x["name"]):
            h.update(f["name"].encode())
            h.update(b"\0")
            h.update(f["content_b64"].encode())
            h.update(b"\0")
    if libraries:
        # Manifest changes the resolved library set → different binary, so it
        # must not dedup to a job built with a different manifest.
        for name in sorted(libraries):
            h.update(name.encode())
            h.update(b"\0")
    if language and language != "arduino":
        # Pure ESP-IDF mode produces a different binary from the same bytes —
        # never dedup across language modes. Guarded so 'arduino' (explicit or
        # omitted) keeps the historical key.
        h.update(b"lang:")
        h.update(language.encode())
        h.update(b"\0")
    return h.hexdigest()


def _purge_expired_jobs() -> None:
    """Drop completed jobs older than JOB_TTL_S so the dict doesn't grow
    forever. Also evicts the matching JOB_BY_KEY entry so the next request
    with the same content schedules a fresh build instead of dedupping to
    a stale job_id."""
    now = time.time()
    stale = [
        jid for jid, job in COMPILE_JOBS.items()
        if job.get("state") in ("done", "error")
        and now - job.get("finished_at", now) > JOB_TTL_S
    ]
    for jid in stale:
        job = COMPILE_JOBS.pop(jid, None)
        if job is not None:
            key = job.get("key")
            # Only remove the JOB_BY_KEY entry if it still points at this job —
            # a newer job with the same key may have replaced it after this one
            # finished but before TTL elapsed.
            if key and JOB_BY_KEY.get(key) == jid:
                JOB_BY_KEY.pop(key, None)


def _checked_file_name(value: str) -> str:
    """Refuse a client file name that could point outside a build dir.

    Folder prefixes ('src/helper.cpp') are fine; each lane lays them out its
    own way. A NUL, an absolute path or a '..' component is refused here, once,
    instead of trusting every compiler lane to re-check it: the ESP-IDF
    Arduino-mode writer and the SPIFFS writer did not (2026-09-15), and the
    backend runs as root next to build dirs every user shares.
    """
    if '\x00' in value:
        raise ValueError('file names cannot contain a NUL byte')
    if value.startswith(('/', '\\')) or re.match(r'^[A-Za-z]:', value):
        raise ValueError(f'absolute file names are not allowed: {value!r}')
    if '..' in value.replace('\\', '/').split('/'):
        raise ValueError(f"'..' is not allowed in file names: {value!r}")
    return value


class SketchFile(BaseModel):
    name: str
    content: str

    @field_validator('name')
    @classmethod
    def _name_stays_inside(cls, value: str) -> str:
        return _checked_file_name(value)


class SpiffsFileBody(BaseModel):
    """One file destined for the SPIFFS partition image, base64-encoded."""
    name: str
    content_b64: str

    @field_validator('name')
    @classmethod
    def _name_stays_inside(cls, value: str) -> str:
        return _checked_file_name(value)


class CompileRequest(BaseModel):
    # New multi-file API
    files: list[SketchFile] | None = None
    # Legacy single-file API (kept for backward compat)
    code: str | None = None
    board_fqbn: str = "arduino:avr:uno"
    # Per-board ESP32 build options (Partition Scheme, CPU Freq, Flash Mode,
    # PSRAM, etc.). Loose dict so the frontend can add fields without a
    # backend deploy — espidf_compiler.compile validates known keys and
    # ignores the rest. None / missing on non-ESP32 boards.
    board_options: dict[str, str | int | bool] | None = None
    # Optional: the SSIDs of the project's custom WiFi access points (the
    # velxio-wifi-ap parts on the canvas). When non-empty
    # the compiler does NOT rewrite the sketch's SSID literals — the project
    # defines its own airspace, so what the user typed is what exists. Empty
    # / missing keeps the legacy behavior (rewrite to the built-in networks).
    custom_wifi_ssids: list[str] | None = None
    # User-uploaded files to bake into the SPIFFS partition (#162). Empty /
    # None means the SPIFFS region stays blank (current behaviour).
    spiffs_files: list[SpiffsFileBody] | None = None
    # P2 — project library manifest (declared library names). When provided,
    # ESP-IDF library resolution is SCOPED to this set: a user-installed lib is
    # merged only if it's declared here, so a sketch never picks up an unrelated
    # library from the shared dir. None / omitted = legacy scan-all (unchanged).
    libraries: list[str] | None = None
    # Pure ESP-IDF language mode (issue #139). 'espidf' compiles the files as
    # a pure ESP-IDF project: the user provides app_main() and IDF APIs, and
    # the arduino-esp32 component is left out of the build entirely. None /
    # 'arduino' = classic Arduino sketch compile. ESP32 boards only.
    language: str | None = None


class CompileResponse(BaseModel):
    success: bool
    hex_content: str | None = None
    binary_content: str | None = None  # base64-encoded .bin for RP2040
    binary_type: str | None = None     # 'bin' or 'uf2'
    # RP2040 / RP2350 only: base64 of the .uf2 picotool built next to the
    # .bin. The hardware-flash paths (BOOTSEL drive, desktop picotool,
    # browser download) need this one; the emulator keeps loading the .bin.
    uf2_content: str | None = None
    has_wifi: bool = False             # True when sketch uses WiFi (ESP32 only)
    stdout: str
    stderr: str
    error: str | None = None
    core_install_log: str | None = None
    # P2 — set when a manifest-scoped compile only succeeded after the
    # scan-all fallback (i.e. the manifest is missing a dependency). The
    # suggested map is {header: [candidate library names]} so the manifest
    # can be auto-completed (P2.4) or the user prompted to add the lib.
    manifest_incomplete: bool = False
    manifest_suggested_libraries: dict | None = None
    # A stable class for the failure: missing_library | core_install_failed |
    # linker_error | syntax_error | compile_error | unknown. Filled in below
    # from stderr, so every caller gets it without grepping compiler output,
    # and every construction site gets it without remembering to. None when
    # the build succeeded.
    #
    # core_install_failed is the build server's problem and rewriting the
    # sketch cannot fix it.
    error_kind: str | None = None

    @model_validator(mode="after")
    def _classify(self) -> "CompileResponse":
        if self.success:
            self.error_kind = None
        elif not self.error_kind:
            self.error_kind = _classify_compile_error(self.stderr, self.error)
        return self


def _classify_compile_error(stderr: str, error: str | None) -> str:
    """Map raw compiler output to a stable error_kind.

    Rides CompileResponse.error_kind so every API caller gets it. The
    vocabulary is closed on purpose: callers branch on it.
    """
    haystack = f"{error or ''}\n{stderr or ''}".lower()
    if "no such file or directory" in haystack or "fatal error:" in haystack:
        return "missing_library"
    if "core install" in haystack or "failed to install" in haystack:
        return "core_install_failed"
    if "undefined reference" in haystack:
        return "linker_error"
    if "expected" in haystack and "before" in haystack:
        return "syntax_error"
    if "error:" in haystack:
        return "compile_error"
    return "unknown"


def _resolve_files(request: CompileRequest) -> list[dict[str, str]]:
    """Normalise the multi-file vs legacy single-file request bodies."""
    if request.files:
        return [{"name": f.name, "content": f.content} for f in request.files]
    if request.code is not None:
        return [{"name": "sketch.ino", "content": request.code}]
    raise HTTPException(
        status_code=422,
        detail="Provide either 'files' or 'code' in the request body.",
    )


def _manifest_specs(names) -> set[str] | None:
    """The manifest as sent, three-state. None (no field) -> no manifest, the
    compilers scan every installed library. [] -> a manifest that declares
    nothing: an empty set (the ESP-IDF lane treats it as scan-all too).
    Otherwise the specs, trimmed, empties dropped.

    Specs KEEP their pin ("Lib@1.2.3", "Lib@wokwi:<hash>"); the ESP-IDF name
    filter splits the base name itself."""
    if names is None:
        return None
    out: set[str] = set()
    for n in names:
        n = (n or "").strip()
        if not n:
            continue
        # A Wokwi-hosted custom library is "Lib@wokwi:<hash>": that suffix is
        # its install spec, not a pin. Keep the name, drop the spec.
        if "@wokwi:" in n:
            n = n.split("@wokwi:", 1)[0].strip()
        if n:
            out.add(n)
    return out


async def _run_compile(
    request: CompileRequest,
    files: list[dict[str, str]],
    progress_callback: Any = None,
) -> CompileResponse:
    """Do the actual compile (ESP-IDF for esp32:*, arduino-cli otherwise).

    `progress_callback`, if provided, receives every stdout/stderr line as
    cmake + ninja run. Wired into the async compile path so the live build
    output is exposed via /api/compile/status/{job_id}'s `stdout` field.
    AVR / RP2040 builds via arduino-cli don't surface progress yet — those
    typically finish in seconds anyway.

    The per-board manifest (`request.libraries`) scopes ESP-IDF library
    resolution; None / empty -> scan every installed library.
    """
    allowed_libraries = _manifest_specs(request.libraries)

    pure_idf = request.language == "espidf"
    if pure_idf and not request.board_fqbn.startswith("esp32:"):
        return CompileResponse(
            success=False,
            stdout="",
            stderr="",
            error="ESP-IDF language mode is only supported on ESP32 boards.",
        )
    if pure_idf and not espidf_compiler.available:
        return CompileResponse(
            success=False,
            stdout="",
            stderr="",
            error="ESP-IDF toolchain is not available on this server.",
        )

    if request.board_fqbn.startswith("esp32:") and espidf_compiler.available:
        logger.info(
            f"[compile] Using ESP-IDF for {request.board_fqbn}"
            + (" (pure ESP-IDF mode)" if pure_idf else "")
        )
        spiffs_dicts = (
            [f.model_dump() for f in request.spiffs_files]
            if request.spiffs_files else None
        )
        result = await espidf_compiler.compile(
            files, request.board_fqbn,
            progress_callback=progress_callback,
            board_options=request.board_options,
            spiffs_files=spiffs_dicts,
            allowed_libraries=allowed_libraries,
            pure_idf=pure_idf,
            custom_wifi_ssids=request.custom_wifi_ssids,
        )
        return CompileResponse(
            success=result["success"],
            hex_content=result.get("hex_content"),
            binary_content=result.get("binary_content"),
            binary_type=result.get("binary_type"),
            uf2_content=result.get("uf2_content"),
            has_wifi=result.get("has_wifi", False),
            stdout=result.get("stdout", ""),
            stderr=result.get("stderr", ""),
            error=result.get("error"),
            manifest_incomplete=result.get("manifest_incomplete", False),
            manifest_suggested_libraries=result.get("manifest_suggested_libraries"),
        )

    # AVR, RP2040, and ESP32 fallback: use arduino-cli
    core_status = await arduino_cli.ensure_core_for_board(request.board_fqbn)
    core_log = core_status.get("log", "")
    if core_status.get("needed") and not core_status.get("installed"):
        return CompileResponse(
            success=False,
            stdout="",
            stderr=core_log,
            error=f"Failed to install required core: {core_status.get('core_id')}",
        )

    # AVR / RP2040 / ATTiny path. `board_options` is accepted for API
    # symmetry but currently ignored — those toolchains don't expose the
    # ESP32 partition / PSRAM knobs we're surfacing.
    result = await arduino_cli.compile(
        files, request.board_fqbn, board_options=request.board_options,
    )
    return CompileResponse(
        success=result["success"],
        hex_content=result.get("hex_content"),
        binary_content=result.get("binary_content"),
        binary_type=result.get("binary_type"),
        uf2_content=result.get("uf2_content"),
        stdout=result.get("stdout", ""),
        stderr=result.get("stderr", ""),
        error=result.get("error"),
        core_install_log=core_log if core_log else None,
    )


async def _compile_job(
    job_id: str,
    request: CompileRequest,
    files: list[dict[str, str]],
) -> None:
    """Background worker: acquire a build slot, run the compile (which takes
    its own build-dir lock), store result in COMPILE_JOBS.

    `state=pending` while waiting on either gate; transitions to `running`
    only once the actual build is about to start, so clients polling
    /compile/status see an accurate snapshot of where their job is. The finer
    `stage` field distinguishes "queued behind other builds" from "the build
    is running but has not printed anything yet".

    Live build output is appended to COMPILE_JOBS[job_id]['stdout_buffer']
    line-by-line as cmake + ninja emit it, so /compile/status responses
    stream a growing log instead of returning everything at the end.
    """
    job = COMPILE_JOBS[job_id]
    started_at = job["started_at"]
    job_key = job.get("key")

    # Live stdout buffer — written from a worker thread (espidf_compiler
    # drain threads). dict[str].update with a single str assignment is GIL-
    # protected so we don't need an explicit lock; the polling endpoint
    # reads the same field.
    COMPILE_JOBS[job_id]["stdout_buffer"] = ""

    def on_progress_line(line: str) -> None:
        # Cap buffer at 256 KB so a runaway build can't OOM the process.
        # Keep the tail (most recent output) — that's what the user wants
        # to see anyway.
        current = COMPILE_JOBS.get(job_id)
        if current is None:
            return
        new = (current.get("stdout_buffer", "") or "") + line
        if len(new) > 262_144:
            new = new[-262_144:]
        current["stdout_buffer"] = new
        _scan_progress(line, current)

    heavy = _is_heavy_compile(request.board_fqbn)
    lane_name = "heavy" if heavy else "light"
    lane = build_queue.lane_for(heavy)

    def on_queued() -> None:
        # Tell the user WHY nothing is happening yet.
        current = COMPILE_JOBS.get(job_id)
        if current is not None:
            current["stage"] = "queued"
        on_progress_line(
            "[queue] Waiting for a free build slot — your build starts "
            "automatically, and is never dropped.\n"
        )

    try:
        async with lane.slot(on_queued=on_queued):
            # Job may have been purged or replaced while we were queued.
            # Re-fetch and bail out if so.
            if COMPILE_JOBS.get(job_id) is None:
                logger.info(f"[compile] job {job_id} purged before run; skipping")
                return
            COMPILE_JOBS[job_id]["state"] = "running"
            COMPILE_JOBS[job_id]["stage"] = "preparing"
            # Progress and ETA are measured from HERE, not from the moment
            # the job was queued — otherwise every build that waited would
            # render as already half-finished the instant it starts.
            COMPILE_JOBS[job_id]["run_started_at"] = time.time()
            COMPILE_JOBS[job_id]["estimate_s"] = _estimated_seconds(
                lane_name, request.board_fqbn
            )
            build_started = time.monotonic()
            response = await _run_compile(
                request, files, progress_callback=on_progress_line,
            )
        if response.success:
            _record_duration(
                lane_name, request.board_fqbn, time.monotonic() - build_started
            )
        COMPILE_JOBS[job_id] = {
            **_job_display_fields(job_id),
            "state": "done",
            "stage": "done",
            "started_at": started_at,
            "finished_at": time.time(),
            "result": response.model_dump(),
            "key": job_key,
            # Preserve the streamed buffer post-completion so a late poll
            # still has access to the live log (clients usually display
            # result.stdout once state=done, but having both costs nothing).
            "stdout_buffer": COMPILE_JOBS.get(job_id, {}).get("stdout_buffer", ""),
        }
        if job_key:
            await _artifact_store(job_key, response.model_dump())
    except Exception as exc:
        logger.exception(f"[compile] async job {job_id} failed")
        COMPILE_JOBS[job_id] = {
            **_job_display_fields(job_id),
            "state": "error",
            "stage": "done",
            "started_at": started_at,
            "finished_at": time.time(),
            "error": str(exc)[:500],
            "key": job_key,
            "stdout_buffer": COMPILE_JOBS.get(job_id, {}).get("stdout_buffer", ""),
        }


@router.post("/", response_model=CompileResponse)
async def compile_sketch(request: CompileRequest):
    """
    Compile Arduino sketch and return hex/binary in a single response.

    Synchronous path: held open until the build finishes. Works for AVR /
    RP2040 builds (seconds), but ESP-IDF cold builds can run 5-7 minutes
    and may hit a proxy timeout. Use the async path (`/compile/start` +
    `/compile/status/{job_id}`) for those.

    Accepts either `files` (multi-file) or legacy `code` (single file).
    Auto-installs the required board core if not present.
    """
    files = _resolve_files(request)
    lane = build_queue.lane_for(_is_heavy_compile(request.board_fqbn))

    async def _gated_compile() -> CompileResponse:
        # Takes a build slot like the async path, so an API caller cannot
        # bypass the concurrency cap. The build dir itself is protected
        # inside the compiler (per-variant lock).
        async with lane.slot():
            return await _run_compile(request, files)

    try:
        # Shielded: when the client (or a proxy timeout - nginx 504s a cold
        # ESP-IDF build well before it finishes) drops the connection,
        # Starlette cancels this handler. Without the shield the cancellation
        # killed the build subprocess MID-WRITE and left truncated .obj files
        # in the persistent per-target build cache, poisoning every LATER
        # build of that target ("ranlib: file truncated"). The shield lets the
        # build run to completion and keep the cache consistent; only the
        # response is lost.
        #
        # The shield covers the queue wait too. Dropping the slot on
        # disconnect and letting the shielded build run on would put a build
        # outside the concurrency cap — the one thing the lane exists to
        # prevent, so the whole gated coroutine is shielded together.
        #
        # The cost: this path neither reads nor writes the artifact cache
        # (only the async job path does), so a request abandoned while queued
        # still consumes a slot for a build whose result nobody receives.
        # Acceptable because the sync endpoint is the API/legacy path — the
        # editor uses /compile/start — and a corrupted shared build dir is far
        # worse than a wasted slot.
        return await asyncio.shield(asyncio.ensure_future(_gated_compile()))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class CompileStartResponse(BaseModel):
    job_id: str


class CompileStatusResponse(BaseModel):
    state: str  # 'pending' | 'running' | 'done' | 'error'
    started_at: float
    finished_at: float | None = None
    # Live build output. Grows line-by-line during state=running so the
    # frontend can stream it into the compilation console instead of
    # waiting for everything to land at the end. Capped at 256 KB
    # (most recent tail kept).
    stdout: str = ""
    result: CompileResponse | None = None
    error: str | None = None

    # ── Queue + progress telemetry (drives the compile overlay) ──────────
    # What this job is doing right now, finer than `state`:
    #   queued     — waiting for a build slot (nothing is running yet)
    #   preparing  — has a slot; cmake / core setup, no output yet
    #   compiling  — actions are running (ninja is reporting a fraction)
    #   linking / packaging — the tail end of the build
    #   done       — finished, successfully or not
    stage: str = "preparing"
    # 0..1, or null when there is nothing honest to draw (a queued job).
    # Measured from ninja's [done/total] where available, estimated from this
    # server's own recent build times otherwise.
    progress: float | None = None
    # What the estimate above is based on, in seconds. Null while queued.
    estimated_seconds: float | None = None
    # Seconds this job has been BUILDING (excludes queue time), so the timer
    # on screen matches the bar next to it.
    build_seconds: float = 0.0
    # Coarse build-server pressure: 'low' | 'moderate' | 'high' | 'peak'.
    # A bucket, not a count (see app/services/build_queue.py).
    server_load: str = "low"
    # Kept for response-shape compatibility with the frontend, which reads
    # both with these same defaults. Single-user: every build is 'local' and
    # none is prioritised.
    tier: str = "local"
    priority: bool = False


@router.post("/start", response_model=CompileStartResponse)
async def compile_start(request: CompileRequest):
    """
    Queue a compile and return a `job_id` immediately.

    The actual compile runs in a background task; clients then poll
    `GET /compile/status/{job_id}` every couple of seconds until state is
    `done` or `error`. This sidesteps HTTP proxy timeouts — each individual
    request returns in milliseconds.

    Deduplication: identical (files, board_fqbn) submissions while a
    matching job is still pending or running return the existing job_id
    instead of spawning a new build. Prevents the "user clicks compile six
    times → six concurrent ninja processes peeling each other apart"
    failure mode.
    """
    files = _resolve_files(request)
    _purge_expired_jobs()

    spiffs_dicts = (
        [f.model_dump() for f in request.spiffs_files] if request.spiffs_files else None
    )
    heavy = _is_heavy_compile(request.board_fqbn)
    queue_fields = {"lane": "heavy" if heavy else "light"}

    # Fold the same manifest the build will use into the dedup key, so the key
    # matches the bytes the build actually produces.
    allowed_libraries = _manifest_specs(request.libraries)
    key = _job_key(
        files, request.board_fqbn, request.board_options, spiffs_dicts,
        sorted(allowed_libraries) if allowed_libraries else None,
        language=request.language,
        custom_wifi_ssids=request.custom_wifi_ssids,
    )
    existing_id = JOB_BY_KEY.get(key)
    if existing_id is not None:
        existing = COMPILE_JOBS.get(existing_id)
        if existing is not None and existing.get("state") in ("pending", "running"):
            logger.info(f"[compile] dedup hit — reusing job {existing_id}")
            return CompileStartResponse(job_id=existing_id)

    # Same sources, same flags, already built: hand the stored artifact back as
    # an already-finished job so the client's normal poll loop just sees `done`.
    cached = _artifact_load(key)
    if cached is not None:
        job_id = uuid.uuid4().hex
        now = time.time()
        COMPILE_JOBS[job_id] = {
            **queue_fields,
            "state": "done",
            "stage": "done",
            "started_at": now,
            "finished_at": now,
            "run_started_at": now,
            "result": cached,
            "key": key,
            "stdout_buffer": cached.get("stdout", ""),
        }
        logger.info("[compile] artifact cache hit — skipping the build")
        return CompileStartResponse(job_id=job_id)

    job_id = uuid.uuid4().hex
    COMPILE_JOBS[job_id] = {
        **queue_fields,
        "state": "pending",
        # Every job starts as 'queued': the background task has not reached the
        # admission gate yet, and claiming 'preparing' before it does would show
        # a bar for a build that has not started.
        "stage": "queued",
        "started_at": time.time(),
        "key": key,
    }
    JOB_BY_KEY[key] = job_id

    asyncio.create_task(_compile_job(job_id=job_id, request=request, files=files))
    return CompileStartResponse(job_id=job_id)


@router.get("/status/{job_id}", response_model=CompileStatusResponse)
async def compile_status(job_id: str):
    """Poll the status of an async compile job submitted via /compile/start.

    `stdout` carries live cmake + ninja output captured line-by-line as
    the build runs. Clients should poll every 1-2s and re-render the
    full string each time (or compute a length delta). Once state=done,
    `result.stdout` carries the same content too — both are kept so a
    late-arriving poll always has the log available.
    """
    job = COMPILE_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found or expired")
    progress, estimate = _job_progress(job)
    run_started = job.get("run_started_at")
    finished = job.get("finished_at")
    build_seconds = (
        max(0.0, (finished or time.time()) - run_started) if run_started else 0.0
    )
    return CompileStatusResponse(
        state=job["state"],
        started_at=job["started_at"],
        finished_at=finished,
        stdout=job.get("stdout_buffer", "") or "",
        result=job.get("result"),
        error=job.get("error"),
        stage=job.get("stage", "preparing"),
        progress=progress,
        estimated_seconds=estimate,
        build_seconds=build_seconds,
        server_load=build_queue.load_level(),
    )


@router.get("/setup-status")
async def setup_status():
    return await arduino_cli.get_setup_status()


@router.post("/ensure-core")
async def ensure_core(request: CompileRequest):
    fqbn = request.board_fqbn
    result = await arduino_cli.ensure_core_for_board(fqbn)
    return result


@router.get("/boards")
async def list_boards():
    boards = await arduino_cli.list_boards()
    return {"boards": boards}
