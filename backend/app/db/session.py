"""SQLAlchemy engine and session management (lazy, fail-soft)."""

from __future__ import annotations

import re
from collections.abc import Generator

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings

_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None

#: Driver connection errors routinely quote the connection target back. These
#: patterns strip credentials out of a diagnostic before it can reach an
#: unauthenticated ``/health/ready`` response.
_URL_USERINFO = re.compile(r"[A-Za-z0-9.+-]+://[^/\s@]*@", re.IGNORECASE)
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(password|passwd|pwd|secret|token|api[_-]?key)\b\s*[=:]\s*[^\s,;]+"
)

#: Readiness diagnostics are public; keep them short enough to be useful
#: without turning them into an exception dump.
_MAX_DETAIL_LENGTH = 200


def get_engine() -> Engine:
    """Return the process-wide engine, creating it on first use."""
    global _engine, _session_factory
    if _engine is None:
        settings = get_settings()
        _engine = create_engine(
            settings.database_url,
            echo=settings.database_echo,
            pool_pre_ping=True,
            pool_recycle=1800,
        )
        _session_factory = sessionmaker(bind=_engine, expire_on_commit=False)
    return _engine


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency yielding a scoped session.

    Raises ``SQLAlchemyError`` to the route layer; routes decide how to map
    connection failures to HTTP responses.
    """
    if _session_factory is None:
        get_engine()
    assert _session_factory is not None
    session = _session_factory()
    try:
        yield session
    finally:
        session.close()


def _safe_detail(exc: BaseException) -> str:
    """Reduce a driver exception to a short, credential-free diagnostic.

    Connection failures quote the DSN back verbatim, and readiness is an
    unauthenticated endpoint, so the message is reduced to the root-cause line
    with any embedded userinfo or secret assignments removed.
    """
    root = getattr(exc, "orig", None)
    if root is None:
        root = exc
    message = str(root).strip().splitlines()[0] if str(root).strip() else ""
    message = _URL_USERINFO.sub("://***@", message)
    message = _SECRET_ASSIGNMENT.sub(r"\1=***", message)
    if len(message) > _MAX_DETAIL_LENGTH:
        message = message[: _MAX_DETAIL_LENGTH - 3] + "..."
    return f"{type(exc).__name__}: {message or 'no detail'}"


def check_database_connection() -> tuple[bool, str]:
    """Probe the database with ``SELECT 1``.

    Returns ``(reachable, detail)`` and never raises, so health checks stay
    fail-soft when the database is unavailable.
    """
    try:
        engine = get_engine()
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        return True, "SELECT 1 succeeded"
    except Exception as exc:  # noqa: BLE001 - health probe must never raise
        return False, _safe_detail(exc)


def dispose_engine() -> None:
    """Dispose the engine (used by tests and graceful shutdown)."""
    global _engine, _session_factory
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _session_factory = None
