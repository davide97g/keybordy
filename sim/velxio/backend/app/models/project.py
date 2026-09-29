import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, Index, Integer, Text, Uuid, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


class Project(Base):
    """A saved workspace. `payload` is the frontend's .vlx object, stored as-is."""

    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(Text, nullable=False)
    # Provenance when forked from a firmware/<folder> import, e.g. "keys8".
    source_folder: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    # Optimistic concurrency: bumped on every payload save, never on rename.
    revision: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        CheckConstraint("char_length(btrim(name)) BETWEEN 1 AND 120", name="name_length"),
        CheckConstraint("jsonb_typeof(payload) = 'object'", name="payload_object"),
        Index("uq_projects_name_ci", text("lower(name)"), unique=True),
        Index("ix_projects_updated_at", text("updated_at DESC")),
    )
