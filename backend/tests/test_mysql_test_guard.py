"""Tests for the destructive MySQL migration-test guard (Phase 9 remediation).

These tests never touch a database. They prove that unsafe targets and a
missing explicit opt-in are rejected before any engine is created or any
destructive SQL is sent.
"""

from __future__ import annotations

import pytest
from mysql_test_guard import (
    UnsafeTestTarget,
    disposable_database,
    validate_disposable_target,
    validate_from_environment,
)

VALID = "mysql+pymysql://root:@127.0.0.1:3307/datadiet_mig"


def _environment(**overrides: str) -> dict[str, str]:
    environment = {
        "MIGRATION_TEST_DB_URL": VALID,
        "MIGRATION_TEST_ALLOW_DROP": "1",
    }
    environment.update(overrides)
    return environment


def test_missing_opt_in_is_refused() -> None:
    with pytest.raises(UnsafeTestTarget, match="MIGRATION_TEST_ALLOW_DROP"):
        validate_disposable_target(VALID, allow_drop=None)


def test_missing_url_is_refused() -> None:
    with pytest.raises(UnsafeTestTarget, match="MIGRATION_TEST_DB_URL"):
        validate_from_environment({"MIGRATION_TEST_ALLOW_DROP": "1"})


@pytest.mark.parametrize(
    "database_url",
    [
        "sqlite:///datadiet_mig.db",
        "postgresql+psycopg://root@127.0.0.1:5432/datadiet_mig",
    ],
)
def test_non_mysql_targets_are_refused(database_url: str) -> None:
    with pytest.raises(UnsafeTestTarget, match="must use MySQL"):
        validate_disposable_target(database_url, allow_drop="1")


@pytest.mark.parametrize(
    "database_url",
    [
        "mysql+pymysql://root@127.0.0.1:3306/datadiet",
        "mysql+pymysql://root@127.0.0.1:3306/datadiet_prod",
        "mysql+pymysql://root@127.0.0.1:3306/datadiet_migration",
        "mysql+pymysql://root@127.0.0.1:3306/production",
        "mysql+pymysql://root@127.0.0.1:3306/",
    ],
)
def test_production_like_names_are_refused(database_url: str) -> None:
    with pytest.raises(UnsafeTestTarget, match="datadiet_"):
        validate_disposable_target(database_url, allow_drop="1")


@pytest.mark.parametrize(
    "database_url",
    [
        "mysql+pymysql://root@db.example.com:3306/datadiet_mig",
        "mysql+pymysql://root@10.0.0.5:3306/datadiet_mig",
    ],
)
def test_non_loopback_hosts_are_refused(database_url: str) -> None:
    with pytest.raises(UnsafeTestTarget, match="loopback"):
        validate_disposable_target(database_url, allow_drop="1")


def test_application_database_is_refused() -> None:
    production = "mysql+pymysql://datadiet:secret@127.0.0.1:3306/datadiet_mig"
    with pytest.raises(UnsafeTestTarget, match="DATABASE_URL"):
        validate_disposable_target(
            production, allow_drop="1", production_url=production
        )


@pytest.mark.parametrize(
    "database_url",
    [
        "mysql+pymysql://root:@127.0.0.1:3307/datadiet_mig",
        "mysql+pymysql://root:@localhost:3306/datadiet_test",
        "mysql+pymysql://root:@[::1]:3306/datadiet_ci",
        "mysql+pymysql://root:@127.0.0.1:3306/datadiet_test_phase9",
    ],
)
def test_valid_disposable_targets_are_accepted(database_url: str) -> None:
    url = validate_disposable_target(database_url, allow_drop="1")
    assert url.get_backend_name() == "mysql"


def test_validation_happens_before_any_engine_is_created() -> None:
    calls: list[object] = []

    def never_called(url: object) -> object:
        calls.append(url)
        raise AssertionError("the engine factory must not be reached")

    with pytest.raises(UnsafeTestTarget):
        with disposable_database(
            _environment(MIGRATION_TEST_ALLOW_DROP="0"),
            engine_factory=never_called,
        ):
            pass  # pragma: no cover - the context manager must fail first

    assert calls == []


def test_unsafe_target_is_rejected_before_any_engine_is_created() -> None:
    calls: list[object] = []

    def never_called(url: object) -> object:
        calls.append(url)
        raise AssertionError("the engine factory must not be reached")

    with pytest.raises(UnsafeTestTarget):
        with disposable_database(
            _environment(MIGRATION_TEST_DB_URL="mysql+pymysql://root@prod.example/datadiet"),
            engine_factory=never_called,
        ):
            pass  # pragma: no cover - the context manager must fail first

    assert calls == []
