"""Read-only migration preflight for existing DataDiet databases (ADR-0018).

The command answers the questions an operator must settle *before* running
``alembic upgrade head`` against an existing database, without changing
anything:

* which environment and which database target are configured (no credentials,
  no URL query parameters);
* whether that database is reachable;
* which revision is stamped in ``alembic_version``;
* which revisions this checkout still has to apply, and whether they include
  ``0011_platform_admin_default_false`` -- the correction that resets
  ``is_platform_admin`` for every account (ADR-0017) -- or the forward audit
  record ``0012_audit_platform_admin_reset`` (ADR-0020).
* whether the target is MySQL. SQLite and other dialects are rejected with exit
  code 6 rather than reported as a valid migration target.

The script never calls Alembic upgrade/downgrade and never writes SQL. A
verified backup and a documented administrator recovery plan stay human gates;
see the migration runbook in ``docs/setup.md``.

Usage (from ``backend/`` with the intended DATABASE_URL / ``.env`` set)::

    ..\\.venv\\Scripts\\python.exe ..\\scripts\\migration_preflight.py

Exit codes::

    0  expected state: at the repository head, or on the chain with pending
       migrations (pending migrations are listed with a warning)
    1  unexpected internal error (nothing was applied)
    2  database unreachable, or the configured URL cannot build an engine
    3  not under Alembic control: ``alembic_version`` is missing, empty or
       ambiguous
    4  the stamped revision is not part of this repository's history
    5  repository history is ambiguous (multiple heads)
    6  unsupported database dialect (only MySQL is a valid migration target)
"""

from __future__ import annotations

import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, quote_plus

# Allow running as a plain script from backend/ or the repo root.
_REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO_ROOT / "backend"))

from alembic.config import Config  # noqa: E402
from alembic.script import ScriptDirectory  # noqa: E402
from alembic.util.exc import CommandError  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402
from sqlalchemy.exc import SQLAlchemyError  # noqa: E402

from app.core.config import get_settings  # noqa: E402

#: Revision that removes every accidental platform-admin grant (ADR-0017).
ADMIN_RESET_REVISION = "0011_platform_admin_default_false"

_DEFAULT_MIGRATIONS_DIR = _REPO_ROOT / "database" / "migrations"


class PreflightError(RuntimeError):
    """A failed preflight check; ``status`` is the process exit code."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class PreflightResult:
    """Read-only snapshot of the target database and this checkout."""

    current_revision: str
    head_revision: str
    pending: tuple[str, ...]

    @property
    def includes_admin_reset(self) -> bool:
        """Whether applying the pending revisions includes the 0011 reset."""
        return ADMIN_RESET_REVISION in self.pending


def masked_target(database_url: str) -> str:
    """Render ``driver://host:port/database`` without credentials or query.

    Query parameters are dropped deliberately: they can carry TLS keys or other
    secrets. The host, port and database name are what an operator needs to
    recognise the target.
    """
    url = make_url(database_url)
    host = url.host or ""
    port = f":{url.port}" if url.port is not None else ""
    database = url.database or ""
    return f"{url.drivername}://{host}{port}/{database}"


def load_script_directory(migrations_dir: Path | None = None) -> ScriptDirectory:
    """Load this checkout's Alembic history (read-only)."""
    config = Config()
    config.set_main_option("script_location", str(migrations_dir or _DEFAULT_MIGRATIONS_DIR))
    return ScriptDirectory.from_config(config)


def _require_mysql(database_url: str) -> None:
    """Refuse any target that is not a MySQL database.

    SQLite and other engines are useful in unit tests, but Alembic's production
    history in this repository is supported only on MySQL (``docs/setup.md``
    section 8). Accepting any other dialect would let the preflight report a
    clean result for a target the migrations were never tested against.
    """
    try:
        url = make_url(database_url)
    except Exception as exc:
        raise PreflightError(
            2, "the configured DATABASE_URL cannot be parsed"
        ) from exc
    backend = url.get_backend_name()
    if backend != "mysql":
        raise PreflightError(
            6,
            f"unsupported database dialect {backend!r}; only MySQL is a supported "
            "migration target",
        )


def _safe_detail(exc: BaseException, database_url: str) -> str:
    """One line of error detail with the configured password removed.

    The password is removed in raw and percent-encoded forms, and the full URL
    is removed as a last resort so a driver that repeats the DSN cannot leak a
    credential.
    """
    detail = str(exc).splitlines()[0] if str(exc) else type(exc).__name__
    try:
        password = make_url(database_url).password
    except Exception:  # pragma: no cover - only a malformed URL reaches this
        password = None
    if password:
        for variant in {password, quote(password, safe=""), quote_plus(password, safe="")}:
            if variant:
                detail = detail.replace(variant, "***")
    if database_url:
        detail = detail.replace(database_url, "***")
    return detail[:240]


def _read_stamped_revision(database_url: str) -> str:
    """Return the single revision stamped in ``alembic_version``."""
    _require_mysql(database_url)
    try:
        engine = create_engine(database_url)
    except (SQLAlchemyError, OSError, ValueError, ImportError) as exc:
        raise PreflightError(
            2, f"the configured URL cannot build a database engine ({type(exc).__name__})"
        ) from exc
    try:
        try:
            connection = engine.connect()
        except (SQLAlchemyError, OSError, ValueError) as exc:
            raise PreflightError(
                2, f"database unreachable ({_safe_detail(exc, database_url)})"
            ) from exc
        try:
            try:
                rows = (
                    connection.execute(text("SELECT version_num FROM alembic_version"))
                    .scalars()
                    .all()
                )
            except SQLAlchemyError as exc:
                raise PreflightError(
                    3,
                    "cannot read alembic_version: the target is not under Alembic "
                    "control, or this account lacks permission",
                ) from exc
        finally:
            connection.close()
    finally:
        engine.dispose()

    if not rows:
        raise PreflightError(3, "alembic_version exists but no revision is stamped")
    if len(rows) > 1:
        raise PreflightError(3, f"alembic_version has {len(rows)} rows; the target is ambiguous")
    current = str(rows[0])
    if not current:
        raise PreflightError(3, "alembic_version contains an empty revision")
    return current


def assess(
    database_url: str,
    *,
    script_directory: ScriptDirectory | None = None,
    revision_reader: Callable[[str], str] | None = None,
) -> PreflightResult:
    """Read the target's stamped revision and compare it with this checkout.

    ``revision_reader`` exists for isolated unit tests. Production callers pass
    only the URL; the reader is still protected by :func:`_require_mysql`.
    """
    _require_mysql(database_url)
    script = script_directory or load_script_directory()
    heads = script.get_heads()
    if len(heads) != 1:
        raise PreflightError(5, f"repository history has {len(heads)} heads; expected one")
    head = heads[0]

    reader = revision_reader or _read_stamped_revision
    current = reader(database_url)
    if current == head:
        return PreflightResult(current_revision=current, head_revision=head, pending=())

    try:
        script.get_revision(current)
    except CommandError as exc:
        raise PreflightError(
            4, f"stamped revision {current!r} is not part of this repository"
        ) from exc

    pending: list[str] = []
    revision: str | None = head
    while revision is not None and revision != current:
        script_revision = script.get_revision(revision)
        pending.append(script_revision.revision)
        down = script_revision.down_revision
        if isinstance(down, tuple):
            raise PreflightError(
                5, f"merge revision {script_revision.revision!r} needs an explicit path"
            )
        revision = down
    if revision is None:
        raise PreflightError(4, f"stamped revision {current!r} is not an ancestor of {head!r}")
    return PreflightResult(
        current_revision=current,
        head_revision=head,
        pending=tuple(reversed(pending)),
    )


def main() -> int:
    """Run the preflight and return a process exit code."""
    print("DataDiet migration preflight (read-only; nothing is applied)")
    try:
        settings = get_settings()
    except Exception as exc:
        print(f"PREFLIGHT FAILED (1): settings are invalid ({type(exc).__name__}).")
        return 1

    print(f"  Environment : {settings.environment}")
    try:
        target = masked_target(settings.database_url)
    except Exception:
        print("PREFLIGHT FAILED (2): the configured DATABASE_URL cannot be parsed.")
        return 2
    print(f"  Target      : {target}")

    try:
        result = assess(settings.database_url)
    except PreflightError as exc:
        print(f"PREFLIGHT FAILED ({exc.status}): {exc}")
        print("No changes were made.")
        return exc.status
    except Exception as exc:
        print(f"PREFLIGHT FAILED (1): unexpected {type(exc).__name__}.")
        print("No changes were made.")
        return 1

    print(f"  Current     : {result.current_revision}")
    print(f"  Head        : {result.head_revision}")
    if not result.pending:
        print("  Pending     : (none)")
        print("Result: already at the repository head; nothing to apply.")
        return 0

    print("  Pending     : " + ", ".join(result.pending))
    print()
    print("Result: migrations are pending. Before applying them, verify a backup and")
    print("a documented administrator recovery plan (docs/setup.md migration runbook).")
    if result.includes_admin_reset:
        print()
        print("WARNING: 0011_platform_admin_default_false sets is_platform_admin to")
        print("FALSE for EVERY app_users row. Re-grant only individually verified")
        print("administrators afterwards with scripts/bootstrap_admin.py (audited).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
