"""Remove accidental platform-admin grants from Phase 7 migration defaults.

Revision ID: 0011_platform_admin_default_false
Revises: 0010_classification_downgrade_safety
Create Date: 2026-10-19

Security correction: revision 0008 added app_users.is_platform_admin with a
server default of TRUE. That makes pre-existing accounts platform administrators
and also makes SQL inserts that omit the field privileged. Institution-level
admin membership must never imply platform-wide administration.

This forward-only correction:
- changes the database server default to FALSE;
- revokes the accidental flag from every account that exists at migration time.

No migration can reliably distinguish a deliberately granted platform admin
from one that inherited the erroneous TRUE default. Therefore all existing
grants are revoked. A trusted database operator must explicitly re-grant
platform administration to individually verified accounts after this migration.

Downgrade deliberately preserves the secure FALSE default and does not restore
privileges. Restoring the old TRUE default would reintroduce the vulnerability.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0011_platform_admin_default_false"
down_revision: Union[str, None] = "0010_classification_downgrade_safety"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "app_users",
        "is_platform_admin",
        existing_type=sa.Boolean(),
        existing_nullable=False,
        server_default=sa.false(),
    )
    # The 0008 TRUE default cannot distinguish legitimate grants from the
    # accidental grants it made. Fail closed: revoke every existing grant.
    op.execute("UPDATE app_users SET is_platform_admin = 0")


def downgrade() -> None:
    # Intentionally retain the secure default and revoked privileges. This is
    # a security correction, not a reversible business-data transformation.
    # Reinstating TRUE would make every subsequently created account privileged.
    pass
