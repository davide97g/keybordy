import uuid
from datetime import datetime
from typing import Annotated, Any

from pydantic import BaseModel, Field, StringConstraints, field_validator

ProjectName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


def _check_payload(payload: dict[str, Any]) -> dict[str, Any]:
    # Shape check only. The frontend's vlxFile.validatePayload stays the
    # authority on the full .vlx format.
    if payload.get("format") != "velxio-project":
        raise ValueError("payload.format must be 'velxio-project'")
    if not isinstance(payload.get("boards"), list):
        raise ValueError("payload.boards must be a list")
    if not isinstance(payload.get("fileGroups"), dict):
        raise ValueError("payload.fileGroups must be an object")
    return payload


class ProjectCreate(BaseModel):
    name: ProjectName
    payload: dict[str, Any]
    source_folder: str | None = Field(default=None, max_length=200)

    _payload = field_validator("payload")(_check_payload)


class ProjectSave(BaseModel):
    payload: dict[str, Any]
    base_revision: int = Field(ge=1)

    _payload = field_validator("payload")(_check_payload)


class ProjectRename(BaseModel):
    name: ProjectName


class ProjectSummary(BaseModel):
    id: uuid.UUID
    name: str
    source_folder: str | None
    revision: int
    board_kinds: list[str]
    created_at: datetime
    updated_at: datetime


class ProjectDetail(ProjectSummary):
    payload: dict[str, Any]


class SaveResult(BaseModel):
    id: uuid.UUID
    revision: int
    updated_at: datetime
