"""Saved projects in Postgres: list, create, open, autosave, rename, delete.

Every route answers 503 {"code": "database_unavailable"} when the database is
not configured or not reachable, so the editor can fall back to the browser.
Autosave (PUT) is optimistic: it only applies on top of the revision the
client loaded, and a stale write gets 409 "revision_conflict".
"""

import logging
import uuid
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.routing import APIRoute
from sqlalchemy import cast, delete, func, select, update
from sqlalchemy.dialects.postgresql import JSONB, JSONPATH
from sqlalchemy.exc import IntegrityError, InterfaceError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.session import DATABASE_UNAVAILABLE, get_session
from app.models.project import Project
from app.schemas.project import (
    ProjectCreate,
    ProjectDetail,
    ProjectRename,
    ProjectSave,
    ProjectSummary,
    SaveResult,
)

logger = logging.getLogger(__name__)


class _DatabaseRoute(APIRoute):
    """Turns "can't reach Postgres" errors into 503 instead of a 500."""

    def get_route_handler(self) -> Callable:
        handler = super().get_route_handler()

        async def wrapped(request: Request) -> Response:
            try:
                return await handler(request)
            except (OperationalError, InterfaceError, OSError, TimeoutError) as exc:
                logger.warning("project store unavailable: %r", exc)
                raise HTTPException(status_code=503, detail=DATABASE_UNAVAILABLE) from exc

        return wrapped


router = APIRouter(route_class=_DatabaseRoute)

_BOARD_KINDS = func.jsonb_path_query_array(
    Project.payload, cast("$.boards[*].boardKind", JSONPATH), type_=JSONB
).label("board_kinds")

_SUMMARY_COLUMNS = (
    Project.id,
    Project.name,
    Project.source_folder,
    Project.revision,
    _BOARD_KINDS,
    Project.created_at,
    Project.updated_at,
)


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail={"code": "not_found"})


def _name_taken() -> HTTPException:
    return HTTPException(status_code=409, detail={"code": "name_taken"})


def _board_kinds(payload: dict[str, Any]) -> list[str]:
    boards = payload.get("boards") or []
    return [b["boardKind"] for b in boards if isinstance(b, dict) and isinstance(b.get("boardKind"), str)]


def _detail(project: Project) -> ProjectDetail:
    return ProjectDetail(
        id=project.id,
        name=project.name,
        source_folder=project.source_folder,
        revision=project.revision,
        board_kinds=_board_kinds(project.payload),
        created_at=project.created_at,
        updated_at=project.updated_at,
        payload=project.payload,
    )


@router.get("", response_model=list[ProjectSummary])
async def list_projects(session: AsyncSession = Depends(get_session)):
    rows = await session.execute(select(*_SUMMARY_COLUMNS).order_by(Project.updated_at.desc()))
    return [ProjectSummary.model_validate(row, from_attributes=True) for row in rows]


@router.post("", response_model=ProjectDetail, status_code=201)
async def create_project(body: ProjectCreate, session: AsyncSession = Depends(get_session)):
    project = Project(name=body.name, payload=body.payload, source_folder=body.source_folder)
    session.add(project)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise _name_taken() from exc
    await session.refresh(project)
    return _detail(project)


@router.get("/{project_id}", response_model=ProjectDetail)
async def get_project(project_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    project = await session.get(Project, project_id)
    if project is None:
        raise _not_found()
    return _detail(project)


@router.put("/{project_id}", response_model=SaveResult)
async def save_project(project_id: uuid.UUID, body: ProjectSave, session: AsyncSession = Depends(get_session)):
    result = await session.execute(
        update(Project)
        .where(Project.id == project_id, Project.revision == body.base_revision)
        .values(payload=body.payload, revision=Project.revision + 1, updated_at=func.now())
        .returning(Project.revision, Project.updated_at)
    )
    row = result.first()
    if row is None:
        current = (
            await session.execute(select(Project.revision, Project.updated_at).where(Project.id == project_id))
        ).first()
        if current is None:
            raise _not_found()
        raise HTTPException(
            status_code=409,
            detail={
                "code": "revision_conflict",
                "current_revision": current.revision,
                "updated_at": current.updated_at.isoformat(),
            },
        )
    await session.commit()
    return SaveResult(id=project_id, revision=row.revision, updated_at=row.updated_at)


@router.patch("/{project_id}", response_model=ProjectSummary)
async def rename_project(project_id: uuid.UUID, body: ProjectRename, session: AsyncSession = Depends(get_session)):
    try:
        result = await session.execute(
            update(Project)
            .where(Project.id == project_id)
            .values(name=body.name, updated_at=func.now())
            .returning(*_SUMMARY_COLUMNS)
        )
        row = result.first()
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise _name_taken() from exc
    if row is None:
        raise _not_found()
    return ProjectSummary.model_validate(row, from_attributes=True)


@router.delete("/{project_id}", status_code=204)
async def delete_project(project_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    result = await session.execute(delete(Project).where(Project.id == project_id).returning(Project.id))
    deleted = result.first()
    await session.commit()
    if deleted is None:
        raise _not_found()
    return Response(status_code=204)
