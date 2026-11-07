"""External identity bindings for identity-provider subjects (Phase 6.0).

Revision ID: 0014_external_identities
Revises: 0013_postgresql_baseline
Create Date: 2026-11-04

Adds the table that lets a Clerk ``sub`` claim resolve to a DataDiet account.
The binding, not the email address, is the identity key:
``(provider, external_subject)`` is unique and is the only thing the
authentication path reads, so a user who changes their address at the provider
keeps the same account, and two accounts sharing an address stay distinguishable.
``last_email`` is recorded for administrators and is never used to resolve a
subject.

Nothing in this table authorizes anything. Roles and institution scope stay in
``user_memberships`` and ``app_users.is_platform_admin``, so a binding with no
membership is an account that can sign in and see nothing.

This revision is **dialect-portable on purpose** — plain ``create_table`` with no
MySQL-only DDL — so it runs unchanged on MySQL (where it adds the table to the
existing schema) and on PostgreSQL (where ``0013`` established the baseline). It
is the pattern later revisions follow: new work is portable, only the historical
divergence is branched.

Downgrade drops the table. That removes identity bindings, which signs those
subjects out (they become unknown identities again); it does not delete any
``app_users`` row, any membership, or any content. On PostgreSQL the drop is the
only supported downgrade step in this branch, and only for this revision.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0014_external_identities"
down_revision: Union[str, None] = "0013_postgresql_baseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "external_identities",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("provider", sa.String(length=40), nullable=False),
        sa.Column("external_subject", sa.String(length=120), nullable=False),
        sa.Column("app_user_id", sa.Integer(), nullable=False),
        sa.Column("last_email", sa.String(length=255), nullable=True),
        sa.Column("bound_by", sa.String(length=40), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["app_user_id"],
            ["app_users.id"],
            name="fk_external_identities_app_user",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "provider", "external_subject", name="uq_external_identity_provider_subject"
        ),
    )
    op.create_index("ix_external_identities_app_user", "external_identities", ["app_user_id"])


def downgrade() -> None:
    op.drop_index("ix_external_identities_app_user", table_name="external_identities")
    op.drop_table("external_identities")
