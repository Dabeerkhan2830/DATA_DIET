"""Migration integrity tests against a real MySQL server.

These tests are skipped unless ``MIGRATION_TEST_DB_URL`` is set, because a
disposable MySQL instance is required (no Docker is available in the primary
development environment, so the instance is provisioned separately — see
``docs/setup.md``).

The URL must point at a *disposable* database: the test drops and recreates it.
Safety is enforced by ``tests/mysql_test_guard.py``: the operator must also set
``MIGRATION_TEST_ALLOW_DROP=1``, the database name must match
``datadiet_(mig|test|ci)[_suffix]``, and the host must be loopback.

    set MIGRATION_TEST_ALLOW_DROP=1
    set MIGRATION_TEST_DB_URL=mysql+pymysql://root:@127.0.0.1:3307/datadiet_mig
    python -m pytest tests/test_migrations_mysql.py -v

The module is the home for everything that needs a live MySQL backend. Besides
the migration checks below it carries one service-level regression,
``test_assessment_timestamp_round_trips_on_mysql``: MySQL DATETIME keeps whole
seconds, and the Phase 7 assess -> decide flow depends on the assessment
timestamp round-tripping exactly (SQLite preserves microseconds, so the main
suite cannot catch that class of defect).

Known pre-existing defect (Phase 5, revision ``0006_classification_results``):
its ``downgrade`` drops ``ix_classification_results_institution`` before dropping
the table, but on MySQL the foreign key ``classification_results_ibfk_2`` uses
that index, so the drop fails with errno 1553. ``0004_review_decisions`` has the
same shape twice, for ``retention_decisions`` and ``retention_assessments``.

Phase 7 repairs what can be repaired **forward**, without editing applied
history: revision ``0010_classification_downgrade_safety`` drops the affected
tables' foreign keys before the older revisions run and restores them on the way
back up (ADR-0016). The supported rollback boundary is therefore
``0005_source_connectors``: the head <-> 0005 round trip and the one-step
round trip pass, stopping the rollback *at* 0006 or 0009 is documented by
``test_partial_rollback_leaves_a_documented_fk_gap``, and going below 0005 is
asserted to fail with the documented error by
``test_rollback_below_the_boundary_fails_as_documented``.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from collections.abc import Generator
from datetime import UTC, datetime

import pytest
from alembic import command
from alembic.config import Config
from mysql_test_guard import disposable_database
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

from app.api.schemas.retention import DecisionCreate
from app.db import models
from app.services import retention as retention_service

MIGRATION_DB_URL = os.environ.get("MIGRATION_TEST_DB_URL", "")

pytestmark = pytest.mark.skipif(
    not MIGRATION_DB_URL,
    reason="MIGRATION_TEST_DB_URL is not set; MySQL migration tests need a disposable MySQL server",
)

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _alembic_config() -> Config:
    cfg = Config(os.path.join(REPO_ROOT, "backend", "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(REPO_ROOT, "database", "migrations"))
    cfg.set_main_option("sqlalchemy.url", MIGRATION_DB_URL)
    return cfg


def _load_operator_script(name: str):
    """Import a repository operator script (``scripts/`` is not a package)."""
    path = os.path.join(REPO_ROOT, "scripts", f"{name}.py")
    spec = importlib.util.spec_from_file_location(f"scripts_{name}", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def fresh_db() -> Generator[None, None, None]:
    """Drop/recreate only a validated, explicitly opted-in disposable database."""
    with disposable_database(os.environ):
        yield


def _schema_snapshot(engine) -> dict[str, str]:
    insp = inspect(engine)
    snapshot: dict[str, str] = {}
    for table in sorted(insp.get_table_names()):
        columns = sorted(
            (
                col["name"],
                str(col["type"]),
                bool(col["nullable"]),
                str(col.get("default") or ""),
            )
            for col in insp.get_columns(table)
        )
        fks = sorted(
            (fk["constrained_columns"], fk["referred_table"], fk["options"].get("ondelete"))
            for fk in insp.get_foreign_keys(table)
        )
        indexes = sorted(
            (ix["name"], ix["column_names"], bool(ix.get("unique")))
            for ix in insp.get_indexes(table)
        )
        uniques = sorted(
            (ux["name"], tuple(ux["column_names"])) for ux in insp.get_unique_constraints(table)
        )
        pk = sorted(insp.get_pk_constraint(table)["constrained_columns"])
        snapshot[table] = repr(
            {"columns": columns, "fks": fks, "indexes": indexes, "uniques": uniques, "pk": pk}
        )
    return snapshot


def test_upgrade_head_reaches_latest(fresh_db: None) -> None:
    cfg = _alembic_config()
    command.upgrade(cfg, "head")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        with engine.connect() as conn:
            version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert version == "0012_audit_platform_admin_reset"

        insp = inspect(engine)
        tables = set(insp.get_table_names())
        assert {
            "institutions",
            "policy_versions",
            "retention_policies",
            "retention_holds",
            "retention_assessments",
            "retention_decisions",
            # Phase 4
            "scan_jobs",
            "scan_results",
            "scan_errors",
            "source_record_mappings",
        } <= tables

        # revision id column must be wide enough for our revision names
        with engine.connect() as conn:
            col = conn.execute(
                text(
                    "SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alembic_version' "
                    "AND COLUMN_NAME = 'version_num'"
                )
            ).scalar()
        assert col and col >= 64, f"alembic_version.version_num is {col}, expected >= 64"
    finally:
        engine.dispose()


def test_phase7_platform_admin_default_is_safe(fresh_db: None) -> None:
    """Migration 0011 revokes the unsafe 0008 TRUE default for every account."""
    cfg = _alembic_config()
    command.upgrade(cfg, "0010_classification_downgrade_safety")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        # Simulate accounts created under 0008, where omitted values inherited TRUE.
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO app_users (email, display_name, is_active) VALUES "
                    "(:email1, :name1, 1), (:email2, :name2, 1)"
                ),
                {
                    "email1": "legacy-admin-1@datadiet.test",
                    "name1": "Legacy Account 1",
                    "email2": "legacy-admin-2@datadiet.test",
                    "name2": "Legacy Account 2",
                },
            )
        with engine.connect() as conn:
            before = conn.execute(
                text("SELECT COUNT(*) FROM app_users WHERE is_platform_admin = 1")
            ).scalar_one()
        assert before == 2
    finally:
        engine.dispose()

    command.upgrade(cfg, "head")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        with engine.connect() as conn:
            # The corrective migration revokes all ambiguous existing grants.
            privileged = conn.execute(
                text("SELECT COUNT(*) FROM app_users WHERE is_platform_admin = 1")
            ).scalar_one()
            version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
        assert privileged == 0
        assert version == "0012_audit_platform_admin_reset"

        # The database-level default must also be FALSE for future raw inserts.
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO app_users (email, display_name, is_active) VALUES "
                    "(:email, :name, 1)"
                ),
                {"email": "new-account@datadiet.test", "name": "New Account"},
            )
        with engine.connect() as conn:
            is_admin = conn.execute(
                text("SELECT is_platform_admin FROM app_users WHERE email = :email"),
                {"email": "new-account@datadiet.test"},
            ).scalar_one()
        assert is_admin in (0, False)
    finally:
        engine.dispose()


def test_0012_records_the_reset_without_changing_access(fresh_db: None) -> None:
    """The forward audit record is durable, idempotent, and privilege-neutral."""
    cfg = _alembic_config()
    command.upgrade(cfg, "0011_platform_admin_default_false")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO app_users "
                    "(email, display_name, is_platform_admin, is_active) "
                    "VALUES (:email, :name, 1, 1)"
                ),
                {"email": "regranted@datadiet.test", "name": "Regranted Admin"},
            )
    finally:
        engine.dispose()

    command.upgrade(cfg, "head")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        with engine.connect() as conn:
            version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
            privileged = conn.execute(
                text("SELECT is_platform_admin FROM app_users WHERE email = :email"),
                {"email": "regranted@datadiet.test"},
            ).scalar_one()
            event_count = conn.execute(
                text(
                    "SELECT COUNT(*) FROM audit_events WHERE event_type = "
                    "'users.platform_admin_reset_recorded'"
                )
            ).scalar_one()
            recorded_count = conn.execute(
                text(
                    "SELECT JSON_EXTRACT(payload, '$.platform_admin_count_after') "
                    "FROM audit_events WHERE event_type = "
                    "'users.platform_admin_reset_recorded'"
                )
            ).scalar_one()
        assert version == "0012_audit_platform_admin_reset"
        assert privileged in (1, True), "0012 must not revoke a post-0011 grant"
        assert event_count == 1
        assert int(recorded_count) == 1
    finally:
        engine.dispose()

    # The audit record is append-only and 0012's downgrade is deliberately a
    # no-op; a round trip must not duplicate or delete the event.
    command.downgrade(cfg, "0011_platform_admin_default_false")
    command.upgrade(cfg, "head")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        with engine.connect() as conn:
            event_count = conn.execute(
                text(
                    "SELECT COUNT(*) FROM audit_events WHERE event_type = "
                    "'users.platform_admin_reset_recorded'"
                )
            ).scalar_one()
        assert event_count == 1
    finally:
        engine.dispose()


def test_preflight_reports_pending_0011_then_head(fresh_db: None) -> None:
    """The read-only preflight classifies a real MySQL target correctly."""
    cfg = _alembic_config()
    command.upgrade(cfg, "0010_classification_downgrade_safety")

    preflight = _load_operator_script("migration_preflight")
    pending = preflight.assess(MIGRATION_DB_URL)

    assert pending.current_revision == "0010_classification_downgrade_safety"
    assert pending.pending == (
        "0011_platform_admin_default_false",
        "0012_audit_platform_admin_reset",
    )
    assert pending.includes_admin_reset is True

    command.upgrade(cfg, "head")
    applied = preflight.assess(MIGRATION_DB_URL)

    assert applied.current_revision == "0012_audit_platform_admin_reset"
    assert applied.pending == ()
    assert applied.includes_admin_reset is False


def test_0011_recovery_promotes_only_the_named_account(fresh_db: None) -> None:
    """bootstrap_admin.py is the audited recovery path after the 0011 reset."""
    command.upgrade(_alembic_config(), "head")
    bootstrap_admin = _load_operator_script("bootstrap_admin")

    engine = create_engine(MIGRATION_DB_URL)
    factory = sessionmaker(bind=engine)
    try:
        with factory() as db:
            db.add_all(
                [
                    models.AppUser(
                        email="verified@datadiet.test",
                        display_name="Verified Admin",
                        is_platform_admin=False,
                        is_active=True,
                    ),
                    models.AppUser(
                        email="bystander@datadiet.test",
                        display_name="Bystander Admin",
                        is_platform_admin=False,
                        is_active=True,
                    ),
                ]
            )
            db.commit()
            admin_id = bootstrap_admin.bootstrap(
                db,
                email="verified@datadiet.test",
                display_name="Verified Admin",
                institution_id=None,
                role="admin",
                actor="ops.test",
            )
        with factory() as db:
            users = {user.email: user for user in db.execute(select(models.AppUser)).scalars()}
            events = db.execute(
                select(models.AuditEvent).where(
                    models.AuditEvent.event_type == "users.bootstrap_admin"
                )
            ).scalars()
            assert users["verified@datadiet.test"].is_platform_admin is True
            assert users["bystander@datadiet.test"].is_platform_admin is False
            assert [
                (event.actor, event.payload["action"], event.payload["email"]) for event in events
            ] == [("ops.test", "promoted", "verified@datadiet.test")]
        assert admin_id > 0
    finally:
        engine.dispose()


def test_foreign_keys_exist_and_restrict(fresh_db: None) -> None:
    command.upgrade(_alembic_config(), "head")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        insp = inspect(engine)
        holds_fks = {
            fk["constrained_columns"][0]: fk
            for fk in insp.get_foreign_keys("retention_holds")
        }
        assert "institution_id" in holds_fks
        assert "asset_id" in holds_fks
        assert holds_fks["asset_id"]["options"].get("ondelete") == "RESTRICT"

        assess_fks = {
            fk["constrained_columns"][0]: fk
            for fk in insp.get_foreign_keys("retention_assessments")
        }
        assert assess_fks["asset_id"]["options"].get("ondelete") == "CASCADE"
        assert assess_fks["policy_id"]["options"].get("ondelete") == "SET NULL"
        assert assess_fks["policy_version_id"]["options"].get("ondelete") == "SET NULL"

        policy_fks = {
            fk["constrained_columns"][0]: fk
            for fk in insp.get_foreign_keys("retention_policies")
        }
        assert policy_fks["current_version_id"]["options"].get("ondelete") == "SET NULL"
        assert policy_fks["institution_id"]["options"].get("ondelete") == "RESTRICT"

        # a policy name+version pair is unique
        uniques = {
            tuple(u["column_names"]) for u in insp.get_unique_constraints("retention_policies")
        }
        assert ("name", "version") in uniques
    finally:
        engine.dispose()


def test_nullability_matches_models(fresh_db: None) -> None:
    command.upgrade(_alembic_config(), "head")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        insp = inspect(engine)
        cols = {c["name"]: c for c in insp.get_columns("retention_assessments")}
        assert cols["recommendation"]["nullable"] is False
        assert cols["rationale"]["nullable"] is False
        assert cols["findings"]["nullable"] is False
        assert cols["policy_id"]["nullable"] is True

        hold_cols = {c["name"]: c for c in insp.get_columns("retention_holds")}
        assert hold_cols["name"]["nullable"] is False
        assert hold_cols["status"]["nullable"] is False
        assert hold_cols["institution_id"]["nullable"] is True
        assert hold_cols["asset_id"]["nullable"] is True

        policy_cols = {c["name"]: c for c in insp.get_columns("retention_policies")}
        assert policy_cols["name"]["nullable"] is False
        assert policy_cols["institution_id"]["nullable"] is True
    finally:
        engine.dispose()


#: The oldest revision a rollback may stop at (ADR-0016). Going further runs
#: 0004's own downgrade, whose index/constraint inversion is unrepairable
#: without editing applied history.
SUPPORTED_ROLLBACK_BOUNDARY = "0005_source_connectors"


def test_downgrade_to_the_supported_boundary_and_reupgrade_round_trip(
    fresh_db: None,
) -> None:
    """The officially supported rollback, end to end, on a real MySQL server."""
    cfg = _alembic_config()
    command.upgrade(cfg, "head")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        first = _schema_snapshot(engine)
    finally:
        engine.dispose()

    command.downgrade(cfg, SUPPORTED_ROLLBACK_BOUNDARY)

    engine = create_engine(MIGRATION_DB_URL)
    try:
        with engine.connect() as conn:
            version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert version == SUPPORTED_ROLLBACK_BOUNDARY

        # Nothing Phase 5-7 added survives this rollback...
        insp = inspect(engine)
        tables = set(insp.get_table_names())
        assert "classification_results" not in tables
        assert "user_memberships" not in tables
        # ...and the identity table reverts to its pre-Phase-7 shape.
        assert "app_users" in tables
        app_user_cols = {c["name"] for c in insp.get_columns("app_users")}
        assert "is_platform_admin" not in app_user_cols
        assert {"email", "display_name", "role", "is_active"} <= app_user_cols
        # ...but every table the boundary keeps is complete.
        assert "retention_decisions" in tables
        assert {"assessment_id", "asset_id", "institution_id"} <= {
            fk["constrained_columns"][0]
            for fk in insp.get_foreign_keys("retention_decisions")
        }
    finally:
        engine.dispose()

    command.upgrade(cfg, "head")

    engine = create_engine(MIGRATION_DB_URL)
    try:
        second = _schema_snapshot(engine)
        assert first == second, "schema after round trip differs from fresh install"
    finally:
        engine.dispose()


def test_rollback_below_the_boundary_fails_as_documented(fresh_db: None) -> None:
    """The unsupported half is asserted to fail, not left to surprise anyone.

    0004's ``downgrade()`` opens by dropping ``ix_retention_decisions_institution``
    while ``retention_decisions_ibfk_3`` still uses it, so InnoDB refuses with
    errno 1553 before a single byte of the schema below 0005 is destroyed
    (ADR-0016). The boundary is therefore enforced by the defect itself — and
    because nothing is half-dropped, the database remains fully recoverable.
    """
    cfg = _alembic_config()
    command.upgrade(cfg, "head")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        before = _schema_snapshot(engine)
    finally:
        engine.dispose()

    command.downgrade(cfg, SUPPORTED_ROLLBACK_BOUNDARY)

    with pytest.raises(OperationalError) as excinfo:
        command.downgrade(cfg, "0002_add_institutions_and_asset_fields")
    message = str(excinfo.value)
    assert "ix_retention_decisions_institution" in message
    assert "1553" in message

    # The rollback stopped before destroying anything: 0005's own downgrade
    # completed, then 0004's refused its first statement — so the database
    # sits at a consistent 0004 schema with the stamp to match.
    engine = create_engine(MIGRATION_DB_URL)
    try:
        with engine.connect() as conn:
            version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert version == "0004_review_decisions"
        assert "retention_decisions" in set(inspect(engine).get_table_names())
        assert {"assessment_id", "asset_id", "institution_id"} <= {
            fk["constrained_columns"][0]
            for fk in inspect(engine).get_foreign_keys("retention_decisions")
        }, "the failed rollback must not have stripped 0004's constraints"
    finally:
        engine.dispose()

    # ...so the documented recovery works: upgrade head restores the schema.
    command.upgrade(cfg, "head")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        with engine.connect() as conn:
            version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert version == "0012_audit_platform_admin_reset"
        assert _schema_snapshot(engine) == before, (
            "the failed rollback must not leave the schema altered in any way"
        )
    finally:
        engine.dispose()


def test_downgrade_one_step_preserves_lower_schema(fresh_db: None) -> None:
    cfg = _alembic_config()
    command.upgrade(cfg, SUPPORTED_ROLLBACK_BOUNDARY)
    engine = create_engine(MIGRATION_DB_URL)
    try:
        baseline = _schema_snapshot(engine)
    finally:
        engine.dispose()

    command.upgrade(cfg, "head")
    command.downgrade(cfg, SUPPORTED_ROLLBACK_BOUNDARY)

    engine = create_engine(MIGRATION_DB_URL)
    try:
        after = _schema_snapshot(engine)
        assert baseline == after, "downgrade to 0005 did not restore the 0005 schema"
        with engine.connect() as conn:
            version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert version == SUPPORTED_ROLLBACK_BOUNDARY
    finally:
        engine.dispose()


def _classification_fk_names(engine) -> set[str]:
    insp = inspect(engine)
    return {
        fk["name"] for fk in insp.get_foreign_keys("classification_results")
    } - {None}


def test_phase7_identity_and_supersession_schema(fresh_db: None) -> None:
    """The Phase 7 tables, the supersession link, and the legacy column drop."""
    command.upgrade(_alembic_config(), "head")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        insp = inspect(engine)
        tables = set(insp.get_table_names())
        assert {"app_users", "user_memberships"} <= tables

        user_cols = {c["name"] for c in insp.get_columns("app_users")}
        assert "is_platform_admin" in user_cols
        # The pre-Phase-7 single-role columns were backfilled and then removed.
        assert "institution_id" not in user_cols
        assert "role" not in user_cols

        decision_cols = {c["name"] for c in insp.get_columns("retention_decisions")}
        assert "supersedes_decision_id" in decision_cols
        uniques = {
            tuple(u["column_names"])
            for u in insp.get_unique_constraints("retention_decisions")
        }
        assert ("supersedes_decision_id",) in uniques

        # 0010's repair leaves both classification FKs in place on a healthy run.
        assert {"classification_results_ibfk_1", "classification_results_ibfk_2"} <= (
            _classification_fk_names(engine)
        )
    finally:
        engine.dispose()


def test_0010_restores_missing_classification_foreign_keys(fresh_db: None) -> None:
    """0010's upgrade() is also the repair procedure for a broken database.

    Simulates the state a failed mid-downgrade leaves behind (table intact,
    constraints gone) and proves that the documented repair — step back one
    revision, then re-apply — re-adds them.
    """
    cfg = _alembic_config()
    command.upgrade(cfg, "head")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "ALTER TABLE classification_results "
                    "DROP FOREIGN KEY classification_results_ibfk_2"
                )
            )
        assert _classification_fk_names(engine) == {"classification_results_ibfk_1"}
    finally:
        engine.dispose()

    # The documented repair for a database that failed mid-downgrade.
    command.downgrade(cfg, "0009_decision_supersession")
    command.upgrade(cfg, "head")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        assert {"classification_results_ibfk_1", "classification_results_ibfk_2"} <= (
            _classification_fk_names(engine)
        )
        assert _retention_decisions_fk_columns(engine) >= {
            "assessment_id",
            "asset_id",
            "institution_id",
            "policy_id",
            "policy_version_id",
            "supersedes_decision_id",
        }
    finally:
        engine.dispose()


def _retention_decisions_fk_columns(engine) -> set[str]:
    insp = inspect(engine)
    return {
        fk["constrained_columns"][0]
        for fk in insp.get_foreign_keys("retention_decisions")
    }


@pytest.mark.parametrize(
    ("stop_at", "expected_decision_fks"),
    [
        # 0009's own downgrade has not run yet, so its FK survives too.
        (
            "0009_decision_supersession",
            {
                "assessment_id",
                "asset_id",
                "institution_id",
                "policy_id",
                "policy_version_id",
                "supersedes_decision_id",
            },
        ),
        # It has run here, so only 0004's five original constraints remain.
        (
            "0006_classification_results",
            {"assessment_id", "asset_id", "institution_id", "policy_id", "policy_version_id"},
        ),
    ],
)
def test_partial_rollback_leaves_a_documented_fk_gap(
    fresh_db: None, stop_at: str, expected_decision_fks: set[str]
) -> None:
    """ADR-0016: the unsupported rollback path, asserted rather than hidden.

    Stopping a rollback at 0009 or 0006 passes through 0010's ``downgrade()``,
    which drops ``classification_results``' foreign keys so 0006's index drops
    can succeed. The table itself survives with every column, index, and unique
    constraint — only referential enforcement is absent — and ``alembic upgrade
    head`` restores all of it. ``retention_decisions`` is untouched by either
    stopping point, because 0010 never modifies it (see the migration
    docstring) — the rollback boundary, not this repair, is what stops a
    deeper rollback.
    """
    cfg = _alembic_config()
    command.upgrade(cfg, "head")
    command.downgrade(cfg, stop_at)

    engine = create_engine(MIGRATION_DB_URL)
    try:
        insp = inspect(engine)
        assert insp.has_table("classification_results"), "the table itself must survive"
        cols = {c["name"] for c in insp.get_columns("classification_results")}
        assert {"asset_id", "institution_id", "input_fingerprint"} <= cols
        assert _classification_fk_names(engine) == set(), (
            "documented gap: neither FK survives this partial rollback"
        )
        # The 0004-era table is never in the blast radius of this repair; only
        # the supersession FK differs, depending on whether 0009 has unwound.
        assert _retention_decisions_fk_columns(engine) == expected_decision_fks
    finally:
        engine.dispose()

    command.upgrade(cfg, "head")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        assert {"classification_results_ibfk_1", "classification_results_ibfk_2"} <= (
            _classification_fk_names(engine)
        )
        assert _retention_decisions_fk_columns(engine) >= {
            "assessment_id",
            "asset_id",
            "institution_id",
        }
    finally:
        engine.dispose()


def test_phase4_source_connectors_schema(fresh_db: None) -> None:
    command.upgrade(_alembic_config(), "head")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        insp = inspect(engine)

        data_source_cols = {c["name"]: c for c in insp.get_columns("data_sources")}
        assert "connector_type" in data_source_cols
        assert "root_key" in data_source_cols
        assert "config" in data_source_cols
        assert data_source_cols["created_by"]["nullable"] is False

        job_fks = {fk["constrained_columns"][0]: fk for fk in insp.get_foreign_keys("scan_jobs")}
        assert job_fks["data_source_id"]["options"].get("ondelete") == "CASCADE"
        assert job_fks["institution_id"]["options"].get("ondelete") == "RESTRICT"
        assert job_fks["retried_from_job_id"]["options"].get("ondelete") == "SET NULL"

        result_fks = {
            fk["constrained_columns"][0]: fk for fk in insp.get_foreign_keys("scan_results")
        }
        assert result_fks["scan_job_id"]["options"].get("ondelete") == "CASCADE"
        assert result_fks["imported_asset_id"]["options"].get("ondelete") == "SET NULL"
        result_uniques = {
            tuple(u["column_names"]) for u in insp.get_unique_constraints("scan_results")
        }
        assert ("scan_job_id", "source_key") in result_uniques

        error_fks = {fk["constrained_columns"][0] for fk in insp.get_foreign_keys("scan_errors")}
        assert "scan_job_id" in error_fks

        mapping_fks = {
            fk["constrained_columns"][0]: fk
            for fk in insp.get_foreign_keys("source_record_mappings")
        }
        assert mapping_fks["data_source_id"]["options"].get("ondelete") == "CASCADE"
        assert mapping_fks["asset_id"]["options"].get("ondelete") == "CASCADE"
        mapping_uniques = {
            tuple(u["column_names"])
            for u in insp.get_unique_constraints("source_record_mappings")
        }
        assert ("data_source_id", "source_key") in mapping_uniques
    finally:
        engine.dispose()


def test_phase5_classification_results_schema(fresh_db: None) -> None:
    command.upgrade(_alembic_config(), "head")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        insp = inspect(engine)
        assert "classification_results" in set(insp.get_table_names())

        cols = {c["name"]: c for c in insp.get_columns("classification_results")}
        assert cols["rule_version"]["nullable"] is False
        assert cols["proposed_sensitivity"]["nullable"] is False
        assert cols["confidence"]["nullable"] is False
        assert cols["input_fingerprint"]["nullable"] is False

        fks = {
            fk["constrained_columns"][0]: fk
            for fk in insp.get_foreign_keys("classification_results")
        }
        assert fks["asset_id"]["options"].get("ondelete") == "CASCADE"
        assert fks["institution_id"]["options"].get("ondelete") == "RESTRICT"

        uniques = {
            tuple(u["column_names"])
            for u in insp.get_unique_constraints("classification_results")
        }
        assert (
            "asset_id",
            "rule_version",
            "input_fingerprint",
        ) in uniques

        indexes = {i["name"] for i in insp.get_indexes("classification_results")}
        assert "ix_classification_results_asset_id" in indexes
        assert "ix_classification_results_rule_version" in indexes
        assert "ix_classification_results_classified_at" in indexes
    finally:
        engine.dispose()


def test_phase6_review_decision_integrity(fresh_db: None) -> None:
    command.upgrade(_alembic_config(), "head")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        insp = inspect(engine)

        # One decision per assessment is enforced by a unique constraint, not
        # only by application code (concurrent double-submit guard).
        unique_columns = {
            tuple(u["column_names"])
            for u in insp.get_unique_constraints("retention_decisions")
        }
        unique_indexes = {
            tuple(i["column_names"])
            for i in insp.get_indexes("retention_decisions")
            if i.get("unique")
        }
        assert ("assessment_id",) in (unique_columns | unique_indexes)

        # The old non-unique index was replaced.
        index_names = {i["name"] for i in insp.get_indexes("retention_decisions")}
        assert "ix_retention_decisions_assessment_id" not in index_names
        assert "ix_retention_decisions_asset_id" in index_names
    finally:
        engine.dispose()


def test_phase6_downgrade_reverses_the_constraint(fresh_db: None) -> None:
    """Phase 6 (0007) is reversible: its downgrade restores the plain index.

    Only 0007 is exercised here (head -> 0006). The wider round trip is
    covered by ``test_downgrade_to_the_supported_boundary_and_reupgrade_round_trip``,
    which additionally traverses 0006's downgrade (repaired by 0010).
    """
    cfg = _alembic_config()
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "0006_classification_results")

    engine = create_engine(MIGRATION_DB_URL)
    try:
        with engine.connect() as conn:
            version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert version == "0006_classification_results"

        insp = inspect(engine)
        index_names = {i["name"] for i in insp.get_indexes("retention_decisions")}
        assert "ix_retention_decisions_assessment_id" in index_names
        unique_columns = {
            tuple(u["column_names"])
            for u in insp.get_unique_constraints("retention_decisions")
        }
        assert ("assessment_id",) not in unique_columns
    finally:
        engine.dispose()

    # Re-upgrading restores the unique constraint.
    command.upgrade(cfg, "head")
    engine = create_engine(MIGRATION_DB_URL)
    try:
        insp = inspect(engine)
        unique_columns = {
            tuple(u["column_names"])
            for u in insp.get_unique_constraints("retention_decisions")
        }
        unique_indexes = {
            tuple(i["column_names"])
            for i in insp.get_indexes("retention_decisions")
            if i.get("unique")
        }
        assert ("assessment_id",) in (unique_columns | unique_indexes)
    finally:
        engine.dispose()


def test_assessment_timestamp_round_trips_on_mysql(fresh_db: None) -> None:
    """Regression (Phase 7): assess -> decide must survive MySQL DATETIME.

    ``assess_asset`` used to return the in-memory microsecond timestamp while
    MySQL stores whole seconds, so the ``expected_assessed_at`` token handed to
    clients always failed the optimistic-concurrency check with
    ``stale_review_conflict`` — even when nothing had changed. SQLite keeps
    microseconds, which is why the main suite could not catch it.
    """
    command.upgrade(_alembic_config(), "head")
    engine = create_engine(MIGRATION_DB_URL)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    try:
        with factory() as db:
            institution = models.Institution(code="RT", name="Round-trip University")
            db.add(institution)
            db.flush()
            source = models.DataSource(
                institution_id=institution.id,
                name="round-trip source",
                source_type="synthetic",
            )
            db.add(source)
            db.flush()
            asset = models.InventoryRecord(
                institution_id=institution.id,
                data_source_id=source.id,
                external_id="SYNTH-RT-1",
                title="Round-trip asset",
                record_type="document",
                category="hr",
                sensitivity="internal",
                lifecycle_status="active",
                created_at=datetime.now(UTC),
            )
            db.add(asset)
            db.commit()
            db.refresh(asset)

            assessment = retention_service.assess_asset(db, asset.id)
            assert assessment.id is not None
            stored = db.get(models.RetentionAssessment, assessment.id)
            assert stored is not None
            db.refresh(stored)
            # What the client received must be exactly what the database holds.
            assert assessment.assessed_at == stored.assessed_at

            # ...so submitting it back must not be refused as stale.
            decision = retention_service.create_decision(
                db,
                assessment.id,
                DecisionCreate(
                    decision="retain",
                    reason="MySQL timestamp round-trip regression.",
                    expected_assessed_at=assessment.assessed_at,
                    expected_policy_version_id=assessment.policy_version_id,
                    expected_holds_active=assessment.holds_active,
                ),
                actor="roundtrip@datadiet.test",
            )
            assert decision.assessment_id == assessment.id
    finally:
        engine.dispose()

