"""/api/projects against a real Postgres (marker `db`), plus the 503 paths."""

import httpx
import pytest
import pytest_asyncio

from app.core.config import settings
from app.database.session import dispose_engine
from app.main import app


def payload(board_kind: str = "esp32", content: str = "void setup() {}") -> dict:
    return {
        "format": "velxio-project",
        "version": 1,
        "exportedAt": "2026-09-29T00:00:00Z",
        "boards": [{"id": "b1", "boardKind": board_kind, "x": 0, "y": 0, "activeFileGroupId": "g1"}],
        "fileGroups": {"g1": [{"name": "sketch.ino", "content": content}]},
        "components": [],
        "wires": [],
        "activeBoardId": "b1",
    }


async def create(client, name="keys8 copy", **extra):
    res = await client.post("/api/projects", json={"name": name, "payload": payload(), **extra})
    assert res.status_code == 201, res.text
    return res.json()


@pytest.mark.db
@pytest.mark.asyncio
async def test_crud_round_trip(client):
    created = await create(client, source_folder="keys8")
    assert created["revision"] == 1
    assert created["board_kinds"] == ["esp32"]
    assert created["source_folder"] == "keys8"

    listed = (await client.get("/api/projects")).json()
    assert [p["id"] for p in listed] == [created["id"]]
    assert "payload" not in listed[0]
    assert listed[0]["board_kinds"] == ["esp32"]

    got = (await client.get(f"/api/projects/{created['id']}")).json()
    assert got["payload"]["fileGroups"]["g1"][0]["content"] == "void setup() {}"

    renamed = await client.patch(f"/api/projects/{created['id']}", json={"name": "  renamed  "})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "renamed"
    assert renamed.json()["revision"] == 1  # rename never bumps the revision

    assert (await client.delete(f"/api/projects/{created['id']}")).status_code == 204
    assert (await client.get(f"/api/projects/{created['id']}")).status_code == 404
    assert (await client.delete(f"/api/projects/{created['id']}")).status_code == 404


@pytest.mark.db
@pytest.mark.asyncio
async def test_names_are_unique_case_insensitively(client):
    await create(client, name="Keys8")
    res = await client.post("/api/projects", json={"name": "keys8", "payload": payload()})
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "name_taken"

    other = await create(client, name="other")
    res = await client.patch(f"/api/projects/{other['id']}", json={"name": "KEYS8"})
    assert res.status_code == 409


@pytest.mark.db
@pytest.mark.asyncio
async def test_autosave_is_optimistic(client):
    project = await create(client)
    url = f"/api/projects/{project['id']}"

    first = await client.put(url, json={"payload": payload(content="a"), "base_revision": 1})
    assert first.status_code == 200
    assert first.json()["revision"] == 2

    stale = await client.put(url, json={"payload": payload(content="b"), "base_revision": 1})
    assert stale.status_code == 409
    detail = stale.json()["detail"]
    assert detail["code"] == "revision_conflict"
    assert detail["current_revision"] == 2

    got = (await client.get(url)).json()
    assert got["payload"]["fileGroups"]["g1"][0]["content"] == "a"


@pytest.mark.db
@pytest.mark.asyncio
async def test_missing_and_invalid(client):
    missing = "00000000-0000-0000-0000-000000000000"
    assert (await client.get(f"/api/projects/{missing}")).status_code == 404
    res = await client.put(f"/api/projects/{missing}", json={"payload": payload(), "base_revision": 1})
    assert res.status_code == 404
    assert (await client.get("/api/projects/not-a-uuid")).status_code == 422

    bad = await client.post("/api/projects", json={"name": "x", "payload": {"format": "zip"}})
    assert bad.status_code == 422
    blank = await client.post("/api/projects", json={"name": "   ", "payload": payload()})
    assert blank.status_code == 422


@pytest.mark.db
@pytest.mark.asyncio
async def test_large_payload_round_trips(client):
    big = "x" * (5 * 1024 * 1024)
    res = await client.post("/api/projects", json={"name": "big", "payload": payload(content=big)})
    assert res.status_code == 201
    got = (await client.get(f"/api/projects/{res.json()['id']}")).json()
    assert len(got["payload"]["fileGroups"]["g1"][0]["content"]) == len(big)


@pytest_asyncio.fixture
async def plain_client(monkeypatch):
    async def make(database_url):
        monkeypatch.setattr(settings, "DATABASE_URL", database_url)
        await dispose_engine()
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    yield make
    await dispose_engine()


@pytest.mark.asyncio
async def test_unconfigured_database_is_503(plain_client):
    async with await plain_client(None) as client:
        res = await client.get("/api/projects")
    assert res.status_code == 503
    assert res.json()["detail"]["code"] == "database_unavailable"


@pytest.mark.asyncio
async def test_unreachable_database_is_503(plain_client):
    async with await plain_client("postgresql+asyncpg://velxio:velxio@127.0.0.1:1/velxio") as client:
        res = await client.get("/api/projects")
    assert res.status_code == 503
