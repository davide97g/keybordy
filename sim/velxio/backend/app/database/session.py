"""Async engine and session dependency for the project store.

The engine is created lazily from settings.DATABASE_URL, so the rest of the
backend (compile, simulation) starts and works with no database at all.
"""

from collections.abc import AsyncIterator

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings

DATABASE_UNAVAILABLE = {"code": "database_unavailable"}

_engine: AsyncEngine | None = None
_engine_url: str | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def get_sessionmaker() -> async_sessionmaker[AsyncSession] | None:
    global _engine, _engine_url, _sessionmaker
    url = settings.DATABASE_URL
    if not url:
        return None
    if _engine is None or url != _engine_url:
        # A short connect timeout: when Postgres is down the editor should
        # learn it within seconds and fall back to the browser copy.
        _engine = create_async_engine(url, pool_pre_ping=True, connect_args={"timeout": 5})
        _engine_url = url
        _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _sessionmaker


async def get_session() -> AsyncIterator[AsyncSession]:
    maker = get_sessionmaker()
    if maker is None:
        raise HTTPException(status_code=503, detail=DATABASE_UNAVAILABLE)
    async with maker() as session:
        yield session


async def dispose_engine() -> None:
    global _engine, _engine_url, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = _engine_url = _sessionmaker = None
