"""Safety guard for the destructive MySQL migration-test fixture.

The migration suite drops and recreates the database named by
``MIGRATION_TEST_DB_URL``. That is only acceptable when an operator explicitly
opts in, the target name follows the disposable-test convention, the host is
loopback, and the target is not the application's configured database.
"""

from __future__ import annotations

import re
from collections.abc import Iterator, Mapping
from contextlib import contextmanager

from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL, make_url

#: Deliberately narrow. A production database is normally just ``datadiet``;
#: names such as ``datadiet_prod`` or ``datadiet_migration`` must not pass.
DISPOSABLE_DATABASE_PATTERN = re.compile(
    r"^datadiet_(?:mig|test|ci)(?:_[a-z0-9]+)*$"
)
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
ALLOW_DROP_VARIABLE = "MIGRATION_TEST_ALLOW_DROP"


class UnsafeTestTarget(RuntimeError):
    """Raised before any destructive SQL when the target is not disposable."""


def _same_database_target(left: URL, right: URL) -> bool:
    return (left.host, left.port, left.database) == (
        right.host,
        right.port,
        right.database,
    )


def validate_disposable_target(
    database_url: str,
    *,
    allow_drop: str | None,
    production_url: str | None = None,
) -> URL:
    """Validate a destructive test target and return its parsed URL.

    Validation is pure: it never creates an engine or touches a database.
    """
    if allow_drop != "1":
        raise UnsafeTestTarget(
            f"refusing to drop a database: set {ALLOW_DROP_VARIABLE}=1 only for "
            "an independently verified disposable MySQL instance"
        )
    if not database_url.strip():
        raise UnsafeTestTarget("MIGRATION_TEST_DB_URL is required")

    try:
        url = make_url(database_url)
    except Exception as exc:  # noqa: BLE001 - all malformed URLs are unsafe
        raise UnsafeTestTarget("MIGRATION_TEST_DB_URL is not a valid SQLAlchemy URL") from exc

    if url.get_backend_name() != "mysql":
        raise UnsafeTestTarget(
            "MIGRATION_TEST_DB_URL must use MySQL; other dialects are not a "
            "supported migration-test target"
        )
    if not url.database or not DISPOSABLE_DATABASE_PATTERN.fullmatch(url.database):
        raise UnsafeTestTarget(
            "MIGRATION_TEST_DB_URL must name a database matching "
            "datadiet_(mig|test|ci)[_suffix]; refusing production-like names"
        )

    host = (url.host or "").strip().lower()
    if host not in LOOPBACK_HOSTS:
        raise UnsafeTestTarget(
            "MIGRATION_TEST_DB_URL must target a loopback host "
            "(127.0.0.1, localhost, or ::1)"
        )

    if production_url:
        try:
            configured = make_url(production_url)
        except Exception:  # noqa: BLE001 - an unparsable app URL cannot be compared
            configured = None
        if configured is not None and _same_database_target(url, configured):
            raise UnsafeTestTarget(
                "MIGRATION_TEST_DB_URL must not target the DATABASE_URL database"
            )

    return url


def validate_from_environment(environment: Mapping[str, str]) -> URL:
    """Validate the two environment variables used by the destructive fixture."""
    return validate_disposable_target(
        environment.get("MIGRATION_TEST_DB_URL", ""),
        allow_drop=environment.get(ALLOW_DROP_VARIABLE),
        production_url=environment.get("DATABASE_URL"),
    )


@contextmanager
def disposable_database(
    environment: Mapping[str, str],
    *,
    engine_factory=None,
) -> Iterator[None]:
    """Validate, then drop/recreate the explicitly selected disposable database.

    The validation call is deliberately the first statement. If it raises, the
    engine factory is never invoked and no destructive SQL is sent.
    """
    url = validate_from_environment(environment)
    factory = engine_factory or create_engine
    engine = factory(url)
    database = url.database
    assert database is not None  # validated above
    try:
        with engine.connect() as connection:
            connection.execute(text(f"DROP DATABASE IF EXISTS `{database}`"))
            connection.execute(
                text(f"CREATE DATABASE `{database}` CHARACTER SET utf8mb4")
            )
            connection.execute(text(f"USE `{database}`"))
        yield
    finally:
        engine.dispose()
