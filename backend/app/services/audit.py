"""Append-only audit trail helper.

Every source and scan lifecycle event funnels through :func:`record_event` so
the trail is uniform and machine-readable.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.db.models import AuditEvent


def record_event(
    db: Session,
    *,
    actor: str,
    event_type: str,
    entity_type: str,
    entity_id: object,
    payload: dict[str, Any] | None = None,
    commit: bool = True,
) -> AuditEvent:
    """Persist one audit event and return it.

    ``commit=False`` adds the event and flushes it without committing, so a
    caller can make the governance record and its audit entry atomic inside a
    single transaction (Phase 6 review decisions). Existing callers keep the
    default commit-and-refresh behaviour.
    """
    event = AuditEvent(
        actor=(actor or "system")[:120],
        event_type=event_type[:80],
        entity_type=entity_type[:80],
        entity_id=str(entity_id)[:64],
        payload=payload or {},
    )
    db.add(event)
    if commit:
        db.commit()
        db.refresh(event)
    else:
        db.flush()
    return event
