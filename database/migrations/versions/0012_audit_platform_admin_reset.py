"""Forward audit record for the 0011 platform-admin reset.

Revision ID: 0012_audit_platform_admin_reset
Revises: 0011_platform_admin_default_false
Create Date: 2026-10-20

Revision 0011 correctly fails closed by revoking every existing platform-admin
flag, but a ``UPDATE app_users`` cannot itself explain who lost access. This
forward revision adds a durable audit record **after** the reset. It does not
change any account or privilege.

A forward record cannot reconstruct the identities that 0011 revoked. For an
existing database, the operator must therefore export the pre-migration
platform-admin list into the change ticket before applying 0011 (see
``docs/setup.md`` section 8). The event records the post-reset count so the
zero-admin state can be verified against that list. Re-granting remains a
separate, explicitly audited operator action.

The insert is idempotent: downgrading and re-upgrading this revision must not
duplicate the audit event. Downgrade deliberately preserves the append-only
audit row.
"""
from __future__ import annotations

import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0012_audit_platform_admin_reset"
down_revision: Union[str, None] = "0011_platform_admin_default_false"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_EVENT_TYPE = "users.platform_admin_reset_recorded"
_ENTITY_ID = "0011_platform_admin_default_false"


def upgrade() -> None:
    """Record the post-reset state once, without changing access."""
    bind = op.get_bind()
    existing = bind.execute(
        sa.text(
            "SELECT 1 FROM audit_events "
            "WHERE event_type = :event_type AND entity_id = :entity_id"
        ),
        {"event_type": _EVENT_TYPE, "entity_id": _ENTITY_ID},
    ).first()
    if existing is not None:
        return

    count = bind.execute(
        sa.text("SELECT COUNT(*) FROM app_users WHERE is_platform_admin = 1")
    ).scalar_one()
    payload = {
        "reset_revision": _ENTITY_ID,
        "platform_admin_count_after": int(count),
        "control": "forward audit record; 0011 does not identify revoked accounts",
        "pre_migration_export_required": True,
    }
    bind.execute(
        sa.text(
            "INSERT INTO audit_events "
            "(actor, event_type, entity_type, entity_id, payload) "
            "VALUES (:actor, :event_type, 'migration', :entity_id, :payload)"
        ),
        {
            "actor": f"migration:{revision}",
            "event_type": _EVENT_TYPE,
            "entity_id": _ENTITY_ID,
            "payload": json.dumps(payload, separators=(",", ":")),
        },
    )


def downgrade() -> None:
    """Keep the audit record (append-only); the schema is unchanged."""
    pass
