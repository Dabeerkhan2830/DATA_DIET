"""SQLAlchemy engine and session management (lazy, fail-soft)."""

from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings

_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None


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
        return False, f"{type(exc).__name__}: {exc}"


def dispose_engine() -> None:
    """Dispose the engine (used by tests and graceful shutdown)."""
    global _engine, _session_factory
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _session_factory = None
