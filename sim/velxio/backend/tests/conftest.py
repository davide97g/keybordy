"""Fixtures for tests against Postgres.

Tests marked `db` need TEST_DATABASE_URL (e.g. the dev compose Postgres on
127.0.0.1:5433; `just test-backend` sets it up) and skip without it. The
database is created if missing and migrated once per run with Alembic, so
the migration itself is under test.
"""

import asyncio
import os
from pathlib import Path

import asyncpg
import httpx
import pytest
import pytest_asyncio
from alembic import command
from alembic.config import Config
from sqlalchemy import make_url, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
BACKEND_DIR = Path(__file__).resolve().parent.parent


def pytest_collection_modifyitems(config, items):
    if TEST_DATABASE_URL:
        return
    skip = pytest.mark.skip(reason="TEST_DATABASE_URL not set")
    for item in items:
        if "db" in item.keywords:
            item.add_marker(skip)


async def _ensure_database(url: str) -> None:
    target = make_url(url)
    conn = await asyncpg.connect(
        host=target.host,
        port=target.port or 5432,
        user=target.username,
        password=target.password,
        database="postgres",
    )
    try:
        exists = await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", target.database)
        if not exists:
            await conn.execute(f'CREATE DATABASE "{target.database}"')
    finally:
        await conn.close()


@pytest.fixture(scope="session")
def migrated_db_url() -> str:
    assert TEST_DATABASE_URL
    asyncio.run(_ensure_database(TEST_DATABASE_URL))
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", TEST_DATABASE_URL)
    command.upgrade(cfg, "head")
    return TEST_DATABASE_URL


@pytest_asyncio.fixture
async def client(migrated_db_url):
    from app.database.session import get_session
    from app.main import app

    engine = create_async_engine(migrated_db_url, poolclass=NullPool)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.execute(text("TRUNCATE projects"))

    async def override():
        async with maker() as session:
            yield session

    app.dependency_overrides[get_session] = override
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_session, None)
        await engine.dispose()
