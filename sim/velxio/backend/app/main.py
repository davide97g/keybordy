import logging
import sys
import asyncio
from contextlib import asynccontextmanager

logging.basicConfig(level=logging.INFO, format='%(levelname)s %(name)s: %(message)s')

# On Windows, asyncio defaults to SelectorEventLoop which does NOT support
# create_subprocess_exec (raises NotImplementedError). Force ProactorEventLoop.
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import compile, compile_chip, compile_rom, flash, libraries, micropython_libs
from app.core.config import settings

logger = logging.getLogger(__name__)


def _asyncio_exception_handler(loop: asyncio.AbstractEventLoop, context: dict) -> None:
    """Prevent unhandled asyncio task exceptions from killing the uvicorn process.

    Normally uvicorn re-raises unhandled task exceptions at the event-loop level,
    which can crash the whole process. The main culprit is a race condition in
    websockets <12.0 (legacy/protocol.py AssertionError during keepalive ping).
    Upgrading websockets>=12.0 is the primary fix; this handler is a safety net.
    """
    exc = context.get("exception")
    msg = context.get("message", "")
    if exc is not None:
        logger.error("Unhandled asyncio task exception (swallowed): %s — %r", msg, exc)
    else:
        # No exception object — let default handler deal with it
        loop.default_exception_handler(context)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    asyncio.get_event_loop().set_exception_handler(_asyncio_exception_handler)
    yield


app = FastAPI(
    title="Arduino Emulator API",
    description="Compilation and simulation API",
    version="1.0.0",
    lifespan=lifespan,
    # Moved from /docs to /api/docs so the frontend /docs/* documentation
    # routes are served by the React SPA without any nginx conflict.
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

# CORS — local Vite dev servers and the configured frontend origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5175",
        settings.FRONTEND_URL,
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(compile.router, prefix="/api/compile", tags=["compilation"])
app.include_router(compile_chip.router, prefix="/api/compile-chip", tags=["custom-chips"])
app.include_router(compile_rom.router, prefix="/api/compile-rom", tags=["custom-chips"])
app.include_router(libraries.router, prefix="/api/libraries", tags=["libraries"])
# MicroPython libraries (issue #214): resolves the official micropython-lib
# index into .py files the frontend writes into the board's workspace.
app.include_router(
    micropython_libs.router, prefix="/api/micropython-libs", tags=["micropython-libraries"]
)
# Hardware flash: subprocesses arduino-cli upload to write a compiled
# sketch to a real USB-attached board. Only useful when the backend runs on
# the host the board is plugged into (a container has no serial ports).
app.include_router(flash.router, prefix="/api/flash", tags=["flash"])

# WebSockets
from app.api.routes import simulation
app.include_router(simulation.router, prefix="/api/simulation", tags=["simulation"])

# IoT Gateway — HTTP proxy for ESP32 web servers
from app.api.routes import iot_gateway
app.include_router(iot_gateway.router, prefix="/api/gateway", tags=["iot-gateway"])

@app.get("/")
def root():
    return {
        "message": "Arduino Emulator API",
        "version": "1.0.0",
        "docs": "/api/docs",
    }


@app.get("/health")
def health_check():
    # Polled by the compose healthcheck.
    return {"status": "healthy"}
