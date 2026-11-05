"""Tests for the read-only migration preflight (Phase 8, ADR-0018).

The preflight only reads ``alembic_version`` and the local migration scripts.
Production targets must be MySQL, so these tests inject a small read-only
SQLite-backed revision reader for the classification cases and use a real
subprocess only to prove that a non-MySQL URL is rejected. Nothing here applies
a migration.
"""

from __future__ import annotations

import importlib.util
import os
import sqlite3
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "migration_preflight.py"
HEAD = "0012_audit_platform_admin_reset"
RESET = "0011_platform_admin_default_false"
BEFORE_RESET = "0010_classification_downgrade_safety"
FAKE_MYSQL = "mysql+pymysql://preflight:not-a-secret@127.0.0.1:3306/datadiet_preflight"


def _load_preflight():
    spec = importlib.util.spec_from_file_location("migration_preflight", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # ``from __future__ import annotations`` + dataclasses resolve annotations
    # through sys.modules, so the module must be registered before execution.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def preflight():
    return _load_preflight()


def _database(tmp_path: Path, versions: list[str] | None) -> str:
    """Create a SQLite file with (or without) an ``alembic_version`` table."""
    path = tmp_path / "preflight.db"
    connection = sqlite3.connect(path)
    try:
        if versions is not None:
            connection.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
            connection.executemany(
                "INSERT INTO alembic_version (version_num) VALUES (?)",
                [(version,) for version in versions],
            )
        connection.commit()
    finally:
        connection.close()
    return f"sqlite:///{path.as_posix()}"


def _read_sqlite(preflight, database_url: str) -> str:
    """Test-only revision reader; never accepted as a production target."""
    path = Path(database_url.removeprefix("sqlite:///"))
    if not path.exists():
        raise preflight.PreflightError(2, "database unreachable")
    connection = sqlite3.connect(path)
    try:
        try:
            rows = connection.execute("SELECT version_num FROM alembic_version").fetchall()
        except sqlite3.OperationalError as exc:
            raise preflight.PreflightError(3, "cannot read alembic_version") from exc
    finally:
        connection.close()
    if not rows:
        raise preflight.PreflightError(3, "alembic_version contains no revision")
    if len(rows) > 1:
        raise preflight.PreflightError(3, "alembic_version is ambiguous")
    return str(rows[0][0])


def _assess_with_sqlite(preflight, tmp_path: Path, versions: list[str] | None):
    database_url = _database(tmp_path, versions)
    return preflight.assess(
        FAKE_MYSQL,
        revision_reader=lambda _: _read_sqlite(preflight, database_url),
    )


def _run_cli(database_url: str) -> subprocess.CompletedProcess[str]:
    environment = {
        **os.environ,
        "DATABASE_URL": database_url,
        "ENVIRONMENT": "test",
    }
    return subprocess.run(
        [sys.executable, str(SCRIPT)],
        cwd=str(REPO_ROOT),
        env=environment,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_masked_target_hides_credentials_and_query_parameters(preflight) -> None:
    masked = preflight.masked_target(
        "mysql+pymysql://root:super-secret@127.0.0.1:3307/datadiet_mig"
        "?ssl_key=/keys/client.pem&ssl_password=another-secret"
    )

    assert masked == "mysql+pymysql://127.0.0.1:3307/datadiet_mig"
    assert "super-secret" not in masked
    assert "another-secret" not in masked
    assert "ssl_key" not in masked


def test_at_head_has_nothing_pending(preflight, tmp_path) -> None:
    result = _assess_with_sqlite(preflight, tmp_path, [HEAD])

    assert result.current_revision == HEAD
    assert result.head_revision == HEAD
    assert result.pending == ()
    assert result.includes_admin_reset is False


def test_pending_0011_is_flagged(preflight, tmp_path) -> None:
    result = _assess_with_sqlite(preflight, tmp_path, [BEFORE_RESET])

    assert result.current_revision == BEFORE_RESET
    assert result.pending == (RESET, HEAD)
    assert result.includes_admin_reset is True


def test_unknown_revision_is_rejected(preflight, tmp_path) -> None:
    with pytest.raises(preflight.PreflightError) as failure:
        _assess_with_sqlite(preflight, tmp_path, ["9999_not_a_revision"])

    assert failure.value.status == 4


def test_missing_version_table_is_an_ambiguous_target(preflight, tmp_path) -> None:
    with pytest.raises(preflight.PreflightError) as failure:
        _assess_with_sqlite(preflight, tmp_path, None)

    assert failure.value.status == 3


def test_empty_version_table_is_an_ambiguous_target(preflight, tmp_path) -> None:
    with pytest.raises(preflight.PreflightError) as failure:
        _assess_with_sqlite(preflight, tmp_path, [])

    assert failure.value.status == 3


def test_multiple_version_rows_are_an_ambiguous_target(preflight, tmp_path) -> None:
    with pytest.raises(preflight.PreflightError) as failure:
        _assess_with_sqlite(preflight, tmp_path, [RESET, HEAD])

    assert failure.value.status == 3


def test_unreachable_database_is_reported(preflight, tmp_path) -> None:
    missing = tmp_path / "does-not-exist" / "preflight.db"

    with pytest.raises(preflight.PreflightError) as failure:
        preflight.assess(
            FAKE_MYSQL,
            revision_reader=lambda _: _read_sqlite(
                preflight, f"sqlite:///{missing.as_posix()}"
            ),
        )

    assert failure.value.status == 2


def test_non_mysql_target_is_rejected(preflight, tmp_path) -> None:
    with pytest.raises(preflight.PreflightError) as failure:
        preflight.assess(_database(tmp_path, [HEAD]))

    assert failure.value.status == 6
    assert "only MySQL" in str(failure.value)


def test_error_detail_scrubs_raw_and_encoded_passwords(preflight) -> None:
    detail = preflight._safe_detail(
        RuntimeError(
            "connection failed for p@ss word, p%40ss%20word, and p%40ss+word"
        ),
        "mysql+pymysql://root:p%40ss%20word@127.0.0.1:3307/datadiet_mig",
    )

    assert "p@ss word" not in detail
    assert "p%40ss%20word" not in detail
    assert "p%40ss+word" not in detail
    assert "***" in detail


def test_missing_tls_ca_is_reported_as_a_connection_error(preflight, monkeypatch) -> None:
    def missing_ca(_database_url: str):
        raise FileNotFoundError("CA file /missing/ca.pem does not exist")

    monkeypatch.setattr(preflight, "create_engine", missing_ca)

    with pytest.raises(preflight.PreflightError) as failure:
        preflight._read_stamped_revision(
            "mysql+pymysql://root:super-secret@127.0.0.1:3307/datadiet_mig"
            "?ssl_ca=/missing/ca.pem"
        )

    assert failure.value.status == 2
    assert "super-secret" not in str(failure.value)


def test_multiple_heads_is_an_ambiguous_repository(preflight, monkeypatch) -> None:
    script = preflight.load_script_directory()
    monkeypatch.setattr(script, "get_heads", lambda: ["aaa", "bbb"])

    with pytest.raises(preflight.PreflightError) as failure:
        preflight.assess(FAKE_MYSQL, script_directory=script)

    assert failure.value.status == 5


def test_cli_reports_pending_0011_and_exits_zero(preflight, monkeypatch, capsys) -> None:
    monkeypatch.setattr(
        preflight,
        "get_settings",
        lambda: SimpleNamespace(environment="test", database_url=FAKE_MYSQL),
    )
    monkeypatch.setattr(
        preflight,
        "assess",
        lambda _url: preflight.PreflightResult(
            current_revision=BEFORE_RESET,
            head_revision=HEAD,
            pending=(RESET, HEAD),
        ),
    )

    assert preflight.main() == 0
    output = capsys.readouterr().out
    assert RESET in output
    assert "WARNING" in output
    assert "backup" in output
    assert "recovery plan" in output


def test_cli_fails_clearly_outside_alembic_control(preflight, monkeypatch, capsys) -> None:
    monkeypatch.setattr(
        preflight,
        "get_settings",
        lambda: SimpleNamespace(environment="test", database_url=FAKE_MYSQL),
    )

    def fail(_url: str):
        raise preflight.PreflightError(3, "cannot read alembic_version")

    monkeypatch.setattr(preflight, "assess", fail)

    assert preflight.main() == 3
    output = capsys.readouterr().out
    assert "PREFLIGHT FAILED (3)" in output
    assert "No changes were made." in output


def test_cli_rejects_a_sqlite_target(tmp_path) -> None:
    result = _run_cli(_database(tmp_path, [HEAD]))

    assert result.returncode == 6
    assert "unsupported database dialect" in result.stdout
    assert "already at the repository head" not in result.stdout
