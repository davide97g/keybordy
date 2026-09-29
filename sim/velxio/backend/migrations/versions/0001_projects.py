"""projects table

Revision ID: 0001
Revises:
Create Date: 2026-09-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("source_folder", sa.Text(), nullable=True),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("char_length(btrim(name)) BETWEEN 1 AND 120", name=op.f("ck_projects_name_length")),
        sa.CheckConstraint("jsonb_typeof(payload) = 'object'", name=op.f("ck_projects_payload_object")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_projects")),
    )
    op.create_index("uq_projects_name_ci", "projects", [sa.text("lower(name)")], unique=True)
    op.create_index("ix_projects_updated_at", "projects", [sa.text("updated_at DESC")])


def downgrade() -> None:
    op.drop_index("ix_projects_updated_at", table_name="projects")
    op.drop_index("uq_projects_name_ci", table_name="projects")
    op.drop_table("projects")
