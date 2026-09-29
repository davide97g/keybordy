"""Admission gate for compile jobs.

The compile route gates its two build lanes with a `BuildQueue`: a FIFO
waiting list in front of a fixed number of build slots. It replaced a plain
`asyncio.Semaphore` because a semaphore could not tell the route whether a job
had to wait, so nothing could tell the user WHY their build had not started.

The queue is deliberately unbounded: a build is never refused and never
dropped, no matter how deep the queue gets. Waiting longer is the only thing
that ever happens to a job.

`load_level()` is the only queue fact the API reports, and it is a coarse
label rather than a depth or a position.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections import deque
from contextlib import asynccontextmanager
from typing import AsyncIterator, Callable, Optional

logger = logging.getLogger(__name__)


def _env_slots(name: str, default: int) -> int:
    """Read a lane capacity from the environment, clamped to something sane.

    Exposed as env vars so the lanes can be widened on a bigger box without
    rebuilding the image.
    """
    try:
        value = int(os.environ.get(name, "").strip() or default)
    except ValueError:
        logger.warning("[queue] %s is not an integer; using %d", name, default)
        return default
    return max(1, min(64, value))


class BuildQueue:
    """One lane's admission gate. Not thread-safe; single event loop only.

    Every mutation happens inside a synchronous block with no `await` in it,
    so the counters can never be observed halfway through an admission.
    """

    def __init__(self, name: str, capacity: int) -> None:
        self.name = name
        self.capacity = max(1, capacity)
        self._active = 0
        self._waiters: deque[asyncio.Future[None]] = deque()

    # ── introspection (server-side only) ─────────────────────────────────
    @property
    def active(self) -> int:
        return self._active

    @property
    def waiting(self) -> int:
        return len(self._waiters)

    @property
    def pressure(self) -> float:
        """Running + waiting, as a multiple of capacity. 1.0 = lane exactly full."""
        return (self._active + len(self._waiters)) / float(self.capacity)

    # ── admission ────────────────────────────────────────────────────────
    def _pump(self) -> None:
        while self._active < self.capacity and self._waiters:
            future = self._waiters.popleft()
            if future.done():
                # Cancelled while queued: nothing to give the slot to.
                continue
            self._active += 1
            future.set_result(None)

    def _release(self) -> None:
        self._active -= 1
        self._pump()

    @asynccontextmanager
    async def slot(
        self,
        *,
        on_queued: Optional[Callable[[], None]] = None,
    ) -> AsyncIterator[None]:
        """Hold one of this lane's build slots for the body of the block.

        `on_queued` fires exactly once, and only when the job did NOT get a
        slot immediately — the caller uses it to tell the user their build is
        waiting rather than stalled.
        """
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._waiters.append(future)
        self._pump()

        if not future.done() and on_queued is not None:
            try:
                on_queued()
            except Exception:  # noqa: BLE001 - a UI callback must not break admission
                logger.warning("[queue] on_queued callback threw", exc_info=True)

        try:
            await future
        except BaseException:
            # Cancelled (or the loop tore down) while waiting. If the slot had
            # already been handed over, give it back; otherwise leave the line.
            if future.done() and not future.cancelled():
                self._release()
            else:
                try:
                    self._waiters.remove(future)
                except ValueError:
                    pass
            raise

        try:
            yield
        finally:
            self._release()


# ── The lanes ────────────────────────────────────────────────────────────────
# HEAVY = ESP-IDF (cmake + ninja, minutes on a cold cache): capped low because
# six concurrent ninja processes measured a load average of 30 and made every
# build slower than running them two at a time.
# LIGHT = arduino-cli boards (AVR, RP2040, ATtiny...): seconds each, so they get
# their own lane and never queue behind an ESP-IDF cold build.
HEAVY = BuildQueue("heavy", _env_slots("VELXIO_HEAVY_BUILD_SLOTS", 2))
LIGHT = BuildQueue("light", _env_slots("VELXIO_LIGHT_BUILD_SLOTS", 3))

_LANES = (HEAVY, LIGHT)


def lane_for(heavy: bool) -> BuildQueue:
    return HEAVY if heavy else LIGHT


# ── Coarse load signal ───────────────────────────────────────────────────────
# Four buckets. The frontend paints them as a four-segment "build server load"
# meter.
_LOAD_LEVELS = ("low", "moderate", "high", "peak")


def load_level() -> str:
    """Overall build-server pressure as one of `_LOAD_LEVELS`."""
    active = sum(lane.active for lane in _LANES)
    waiting = sum(lane.waiting for lane in _LANES)
    capacity = sum(lane.capacity for lane in _LANES)
    pressure = (active + waiting) / float(capacity or 1)
    if pressure < 0.5:
        return "low"
    if pressure < 1.0:
        return "moderate"
    if pressure < 2.0:
        return "high"
    return "peak"


def debug_snapshot() -> dict:
    """Full queue state, for server-side diagnostics."""
    return {
        lane.name: {
            "active": lane.active,
            "waiting": lane.waiting,
            "capacity": lane.capacity,
        }
        for lane in _LANES
    }
