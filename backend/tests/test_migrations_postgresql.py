"""Migration integrity tests against a real PostgreSQL server (ADR-0025).

SQLite is what the main suite runs on, and it is *not* evidence of PostgreSQL
compatibility: the MySQL history stops on PostgreSQL at ``0002`` with a
DatatypeMismatch that SQLite happily accepts. These tests therefore run against
a real PostgreSQL server provided by ``pgserver`` (an embedded, disposable
installation -- no Docker, no shared instance, no network at run time).

What the module proves, in order:

1. the pre-existing MySQL history cannot be replayed from the beginning on
   PostgreSQL, which is *why* ``0013_postgresql_baseline`` exists;
2. the documented entry path works: ``stamp 0012_audit_platform_admin_reset``
   followed by ``upgrade head`` lands on ``0014_external_identities``;
3. the resulting schema is what the ORM models describe (an Alembic
   autogenerate comparison reports no difference);
4. ``0014`` reverses cleanly while ``0013`` is deliberately forward-only;
5. the read-only preflight classifies a real PostgreSQL target correctly.

Nothing here can reach a shared database: the server is started by this module
in a temporary directory, the connection URL is asserted to be loopback, and
only databases named ``datadiet_pgtest*`` are created, used and dropped.

    python -m pytest tests/test_migrations_postgresql.py -v

If ``pgserver`` is not installed (it is a development-only dependency in
``requirements-dev.txt``) every test in this module is skipped with an explicit
reason rather than passing silently.
"""

from __future__ import annotations

import importlib.util
import itertools
import sys
from collections.abc import Generator
from pathlib import Path
from types import SimpleNamespace

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app.db import models

REPO_ROOT = Path(__file__).resolve().parents[2]
HEAD = "0014_external_identities"
BASELINE = "0013_postgresql_baseline"
STAMP_AT = "0012_audit_platform_admin_reset"
FIRST_MYSQL_ONLY_STEP = "0002_add_institutions_and_asset_fields"

try:
    import pgserver
except ImportError:  # pragma: no cover - depends on the dev requirements
    pgserver = None

pytestmark = pytest.mark.skipif(
    pgserver is None,
    reason="pgserver is not installed; PostgreSQL migration tests need a real server",
)

_database_counter = itertools.count(1)


@pytest.fixture(scope="session")
def postgres_admin() -> Generator[str, None, None]:
    """One embedded, disposable PostgreSQL server for the whole module."""
    import tempfile

    datadir = Path(tempfile.mkdtemp(prefix="datadiet_pgtest_"))
    try:
        server = pgserver.get_server(datadir, cleanup_mode="stop")
    except Exception as exc:  # pragma: no cover - environmental
        pytest.skip(f"an embedded PostgreSQL server could not be started: {exc}")
    url = server.get_uri().replace("postgresql://", "postgresql+psycopg2://", 1)
    host = make_url(url).host or ""
    assert host in {"127.0.0.1", "localhost", "::1"}, (
        f"refusing to run against a non-loopback host {host!r}"
    )
    try:
        yield url
    finally:
        server.cleanup()


def _drop_database(admin_url: str, name: str) -> None:
    """Drop a disposable database, closing any session that is still attached.

    ``pg_terminate_backend`` is what makes the teardown deterministic: an
    engine that was disposed with a connection still checked out would otherwise
    hold the database open and make PostgreSQL refuse the drop.
    """
    admin = create_engine(admin_url, isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            conn.execute(
                text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = :name AND pid <> pg_backend_pid()"
                ),
                {"name": name},
            )
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
    finally:
        admin.dispose()


@pytest.fixture()
def pg_url(postgres_admin: str) -> Generator[str, None, None]:
    """A freshly created, disposable database owned by this test only."""
    name = f"datadiet_pgtest{next(_database_counter)}"
    _drop_database(postgres_admin, name)
    admin = create_engine(postgres_admin, isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            conn.execute(text(f"CREATE DATABASE {name}"))
    finally:
        admin.dispose()
    scheme, authority = postgres_admin.split("//", 1)
    yield f"{scheme}//{authority.split('/', 1)[0]}/{name}"

    _drop_database(postgres_admin, name)


def _alembic_config(database_url: str) -> Config:
    cfg = Config(str(REPO_ROOT / "backend" / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "database" / "migrations"))
    cfg.set_main_option("sqlalchemy.url", database_url)
    return cfg


def _install_baseline(cfg: Config) -> None:
    """The documented fresh-PostgreSQL entry path, in one place."""
    command.stamp(cfg, STAMP_AT)
    command.upgrade(cfg, "head")


def _stamped_version(database_url: str) -> str:
    engine = create_engine(database_url)
    try:
        with engine.connect() as conn:
            return str(conn.execute(text("SELECT version_num FROM alembic_version")).scalar())
    finally:
        engine.dispose()


def _tables(database_url: str) -> set[str]:
    engine = create_engine(database_url)
    try:
        return set(inspect(engine).get_table_names())
    finally:
        engine.dispose()


def _load_revision_module(name: str):
    path = REPO_ROOT / "database" / "migrations" / "versions" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"revision_{name}", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_the_repository_has_exactly_one_head(pg_url: str) -> None:
    """A branching history would make the preflight's exit 5 the normal answer."""
    assert ScriptDirectory.from_config(_alembic_config(pg_url)).get_heads() == [HEAD]


def test_the_mysql_history_cannot_be_replayed_from_the_beginning(pg_url: str) -> None:
    """The defect the baseline exists for, asserted rather than narrated.

    MySQL accepts an integer literal as a boolean column default; PostgreSQL
    refuses it. So the two dialects cannot share one replayed DDL script, and
    ``0013`` is a branch rather than a repair of applied history.
    """
    with pytest.raises(Exception) as failure:
        command.upgrade(_alembic_config(pg_url), FIRST_MYSQL_ONLY_STEP)

    assert "DatatypeMismatch" in str(failure.value)
    # PostgreSQL applies DDL transactionally, so the refused revision rolls the
    # whole replay back: the fresh database is left empty, not half-built. That
    # is why the install path is `stamp 0012` and never `upgrade 0001`.
    assert _tables(pg_url) == set()


def test_the_documented_entry_path_reaches_head(pg_url: str) -> None:
    """``stamp 0012`` then ``upgrade head``: the only supported fresh install."""
    cfg = _alembic_config(pg_url)
    command.stamp(cfg, STAMP_AT)
    assert _stamped_version(pg_url) == STAMP_AT

    command.upgrade(cfg, "head")

    assert _stamped_version(pg_url) == HEAD
    tables = _tables(pg_url)
    assert "external_identities" in tables
    assert "retention_policies" in tables
    assert len(tables - {"alembic_version"}) == 21, sorted(tables)


def test_the_version_column_is_widened_for_this_projects_revision_ids(pg_url: str) -> None:
    """Alembic's own VARCHAR(32) cannot hold a 38-character revision id."""
    cfg = _alembic_config(pg_url)
    _install_baseline(cfg)

    engine = create_engine(pg_url)
    try:
        with engine.connect() as conn:
            width = conn.execute(
                text(
                    "SELECT character_maximum_length FROM information_schema.columns "
                    "WHERE table_name = 'alembic_version' AND column_name = 'version_num'"
                )
            ).scalar()
    finally:
        engine.dispose()

    assert width is not None and int(width) >= 64


def test_the_baseline_matches_what_the_orm_models_describe(pg_url: str) -> None:
    """Autogenerate finds no drift: the migrations and ``models.py`` agree.

    This is the cross-check that makes a frozen baseline trustworthy: the
    schema PostgreSQL got from ``0013`` + ``0014`` is the schema the running
    application expects, without replaying a single MySQL statement.
    """
    cfg = _alembic_config(pg_url)
    _install_baseline(cfg)

    engine = create_engine(pg_url)
    connection = engine.connect()
    try:
        # Alembic warns that it cannot sort the intentional
        # retention_policies <-> policy_versions FK cycle; the cycle itself is
        # asserted by the named-constraint test below.
        diffs = compare_metadata(
            MigrationContext.configure(connection), models.Base.metadata
        )
    finally:
        connection.close()
        engine.dispose()

    assert diffs == [], f"schema drift between migrations and models: {diffs}"


def test_the_named_constraints_later_revisions_depend_on_exist(pg_url: str) -> None:
    """Other revisions drop foreign keys by name, so the names must match."""
    cfg = _alembic_config(pg_url)
    _install_baseline(cfg)

    engine = create_engine(pg_url)
    try:
        insp = inspect(engine)

        def fk_names(table: str) -> set[str]:
            return {str(fk["name"]) for fk in insp.get_foreign_keys(table) if fk["name"]}

        assert {
            "fk_retention_policies_current_version_id",
            "fk_retention_policies_institution_id",
        } <= fk_names("retention_policies")
        assert {
            "fk_user_memberships_app_user",
            "fk_user_memberships_institution",
        } <= fk_names("user_memberships")
        assert fk_names("external_identities") == {"fk_external_identities_app_user"}

        uniques = {str(ux["name"]) for ux in insp.get_unique_constraints("external_identities")}
        assert "uq_external_identity_provider_subject" in uniques
        indexed = {str(ix["name"]) for ix in insp.get_indexes("external_identities")}
        assert "ix_external_identities_app_user" in indexed
    finally:
        engine.dispose()


def test_the_identity_binding_round_trips_through_the_orm_on_postgres(pg_url: str) -> None:
    """The table Phase 6.0 signs people in with is usable, not merely created."""
    cfg = _alembic_config(pg_url)
    _install_baseline(cfg)

    engine = create_engine(pg_url)
    try:
        session = sessionmaker(bind=engine)()
        try:
            user = models.AppUser(
                email="binding@datadiet.test",
                display_name="Binding Target",
                is_platform_admin=False,
                is_active=True,
            )
            session.add(user)
            session.flush()
            session.add(
                models.ExternalIdentity(
                    provider="clerk",
                    external_subject="user_2MrVerifiedSubject",
                    app_user_id=user.id,
                    last_email="binding@datadiet.test",
                    bound_by="operator_script",
                )
            )
            session.commit()

            stored = session.execute(
                select(models.ExternalIdentity).where(
                    models.ExternalIdentity.provider == "clerk",
                    models.ExternalIdentity.external_subject == "user_2MrVerifiedSubject",
                )
            ).scalar_one()
            assert stored.app_user_id == user.id
            assert stored.bound_by == "operator_script"
            assert user.is_platform_admin is False

            # A provider subject names one account: a second binding must be
            # refused instead of silently creating a second identity.
            session.add(
                models.ExternalIdentity(
                    provider="clerk",
                    external_subject="user_2MrVerifiedSubject",
                    app_user_id=user.id,
                    bound_by="operator_script",
                )
            )
            with pytest.raises(IntegrityError):
                session.commit()
            session.rollback()
        finally:
            session.close()
    finally:
        engine.dispose()


def test_0014_reverses_and_0013_is_forward_only(pg_url: str) -> None:
    """Rolling back the binding table is safe; rolling back the baseline is not."""
    cfg = _alembic_config(pg_url)
    _install_baseline(cfg)

    command.downgrade(cfg, BASELINE)
    assert _stamped_version(pg_url) == BASELINE
    assert "external_identities" not in _tables(pg_url)
    assert len(_tables(pg_url) - {"alembic_version"}) == 20

    with pytest.raises(RuntimeError) as failure:
        command.downgrade(cfg, STAMP_AT)
    assert "forward-only" in str(failure.value)
    # The refusal is a refusal: the baseline schema is still there.
    assert _stamped_version(pg_url) == BASELINE
    assert len(_tables(pg_url) - {"alembic_version"}) == 20

    command.upgrade(cfg, "head")
    assert _stamped_version(pg_url) == HEAD


def test_0013_does_nothing_unless_the_dialect_is_postgresql() -> None:
    """The guard that keeps a MySQL upgrade of ``0013`` a no-op.

    A disposable MySQL is not available in this environment, so the branch is
    exercised directly: with the bound dialect pretending to be MySQL, the
    baseline must return without issuing a single operation.
    """
    module = _load_revision_module(BASELINE)
    calls: list[str] = []

    class RecordingOp:
        def get_bind(self):
            return SimpleNamespace(dialect=SimpleNamespace(name="mysql"))

        def __getattr__(self, name: str):
            def record(*_args, **_kwargs):
                calls.append(name)

            return record

    module.op = RecordingOp()
    module.upgrade()

    assert module._is_postgresql() is False
    assert calls == [], f"the baseline issued MySQL operations: {calls}"

    module.op = RecordingOp()
    module.downgrade()  # documented no-op on a non-PostgreSQL target
    assert calls == []


def test_the_preflight_reads_a_real_postgresql_target(pg_url: str) -> None:
    """The operator gate classifies the real database, not an injected reader."""
    preflight_module = importlib.util.spec_from_file_location(
        "migration_preflight_for_pg", REPO_ROOT / "scripts" / "migration_preflight.py"
    )
    assert preflight_module is not None and preflight_module.loader is not None
    preflight = importlib.util.module_from_spec(preflight_module)
    sys.modules[preflight_module.name] = preflight
    preflight_module.loader.exec_module(preflight)

    cfg = _alembic_config(pg_url)
    _install_baseline(cfg)

    at_head = preflight.assess(pg_url)
    assert at_head.dialect == "postgresql"
    assert at_head.current_revision == HEAD
    assert at_head.pending == ()
    assert at_head.needs_postgres_baseline is False

    command.stamp(cfg, STAMP_AT)
    fresh = preflight.assess(pg_url)
    assert fresh.dialect == "postgresql"
    assert fresh.pending == (BASELINE, HEAD)
    assert fresh.needs_postgres_baseline is True
    assert fresh.includes_admin_reset is False
