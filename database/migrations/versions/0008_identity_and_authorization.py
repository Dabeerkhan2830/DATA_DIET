"""identity and authorization (Phase 7)

Revision ID: 0008_identity_and_authorization
Revises: 0007_review_decision_integrity
Create Date: 2026-10-19 18:00:00.000000

Phase 7 introduces a real identity boundary. ``app_users`` stops being a
placeholder directory and becomes the authorization subject, and institutional
membership moves into a dedicated ``user_memberships`` table so a single account
can hold a role in exactly one (or, later, several) institutions.

- Adds ``app_users.is_platform_admin`` for cross-institution administration.
  The flag lives on the account rather than in a role, so it cannot be granted
  inside one institution's membership row.
- Creates ``user_memberships`` with one active role per (user, institution).
- Migrates the legacy ``app_users.institution_id`` / ``app_users.role`` columns
  into memberships, then drops them so the database has a single source of
  truth for authorization (the models no longer carry those columns).

Legacy data note: only role values in the documented matrix
(``viewer`` / ``reviewer`` / ``admin``) are migrated. An unrecognized legacy
role yields **no** membership, which leaves the account inert until an
administrator grants one — authorization fails closed rather than guessing.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0008_identity_and_authorization"
down_revision: Union[str, None] = "0007_review_decision_integrity"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "app_users",
        sa.Column(
            "is_platform_admin",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )

    op.create_table(
        "user_memberships",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("app_user_id", sa.Integer(), nullable=False),
        sa.Column("institution_id", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "created_by", sa.String(length=120), nullable=False, server_default=sa.text("'migration'")
        ),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["app_user_id"], ["app_users.id"], ondelete="CASCADE", name="fk_user_memberships_app_user"
        ),
        sa.ForeignKeyConstraint(
            ["institution_id"],
            ["institutions.id"],
            ondelete="RESTRICT",
            name="fk_user_memberships_institution",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("app_user_id", "institution_id", name="uq_user_membership"),
    )
    op.create_index(
        "ix_user_memberships_institution", "user_memberships", ["institution_id"]
    )

    # Backfill only roles that exist in the documented matrix. Anything else is
    # deliberately left without membership so the account cannot act.
    op.execute(
        """
        INSERT INTO user_memberships
            (app_user_id, institution_id, role, is_active, created_by, created_at)
        SELECT au.id, au.institution_id, LOWER(au.role), 1, 'migration', NOW()
        FROM app_users au
        WHERE au.institution_id IS NOT NULL
          AND LOWER(au.role) IN ('viewer', 'reviewer', 'admin')
        """
    )

    # Drop the legacy authorization columns. The FK is dropped before the index
    # it depends on, which is the ordering MySQL requires.
    op.drop_constraint(
        "fk_app_users_institution_id_institutions", "app_users", type_="foreignkey"
    )
    op.drop_index("ix_app_users_institution_id", table_name="app_users")
    op.drop_column("app_users", "institution_id")
    op.drop_column("app_users", "role")


def downgrade() -> None:
    op.add_column(
        "app_users",
        sa.Column("role", sa.String(length=50), nullable=False, server_default=sa.text("'viewer'")),
    )
    op.add_column(
        "app_users",
        sa.Column("institution_id", sa.Integer(), nullable=True),
    )
    op.create_index("ix_app_users_institution_id", "app_users", ["institution_id"])
    op.create_foreign_key(
        "fk_app_users_institution_id_institutions",
        "app_users",
        "institutions",
        ["institution_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    # Best-effort restore: one membership per account (the lowest institution
    # id wins when an account held several).
    op.execute(
        """
        UPDATE app_users au
        SET au.role = (
                SELECT um.role FROM user_memberships um
                WHERE um.app_user_id = au.id AND um.is_active = 1
                ORDER BY um.institution_id LIMIT 1
            ),
            au.institution_id = (
                SELECT um.institution_id FROM user_memberships um
                WHERE um.app_user_id = au.id AND um.is_active = 1
                ORDER BY um.institution_id LIMIT 1
            )
        """
    )

    # The server default was only needed to add a NOT NULL column to a
    # populated table. 0001 defined ``role`` without one, so drop it again:
    # a downgrade must restore the original schema, not an approximate one.
    op.execute("ALTER TABLE app_users ALTER COLUMN role DROP DEFAULT")

    op.drop_constraint("fk_user_memberships_app_user", "user_memberships", type_="foreignkey")
    op.drop_constraint(
        "fk_user_memberships_institution", "user_memberships", type_="foreignkey"
    )
    op.drop_index("ix_user_memberships_institution", table_name="user_memberships")
    op.drop_table("user_memberships")

    op.drop_column("app_users", "is_platform_admin")
