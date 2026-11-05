"""Phase 4 tests: source connectors and controlled metadata ingestion.

Everything runs against in-memory SQLite and temporary directories. No network,
no real integration, and no file contents are ever read.
"""

from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest
from conftest import seed_identity_directory
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import Settings
from app.db import models, session
from app.services import scan as scan_service
from app.services.connectors import (
    ConnectorError,
    DiscoveryError,
    LocalFolderConnector,
    PathTraversalError,
    SyntheticConnector,
    UnauthorizedRootError,
)

# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture()
def test_db(monkeypatch: pytest.MonkeyPatch) -> Iterator[sessionmaker[Session]]:
    """In-memory SQLite database wired into the app's session factory."""
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    models.Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(session, "_engine", engine)
    monkeypatch.setattr(session, "_session_factory", factory)
    # This module swaps in its own database, so it must also carry the identity
    # directory the authenticated ``client`` maps onto (Phase 7).
    seed_identity_directory(factory)
    yield factory
    engine.dispose()


@pytest.fixture()
def settings_override(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Settings:
    """Force a controlled Settings into the scan service and connector routes."""
    from app.api.routes import connectors as connectors_route

    settings = Settings(
        environment="test",
        database_url="sqlite+pysqlite:///:memory:",
        local_source_roots={"fixtures": str(tmp_path / "fixtures")},
        scan_max_records=1000,
        scan_batch_size=500,
    )
    monkeypatch.setattr(scan_service, "get_settings", lambda: settings)
    monkeypatch.setattr(connectors_route, "get_settings", lambda: settings)
    return settings


def _create_source(client: TestClient, **overrides: object) -> dict:
    payload: dict[str, object] = {
        "name": overrides.pop("name", "Synthetic source"),
        "connector_type": "synthetic",
        "config": {"count": overrides.pop("count", 5)},
    }
    payload.update(overrides)
    response = client.post("/api/v1/sources", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _make_institution(factory: sessionmaker[Session], *, code: str) -> int:
    with factory() as db:
        institution = models.Institution(code=code, name=f"Institution {code}")
        db.add(institution)
        db.commit()
        db.refresh(institution)
        return institution.id


def _write(path: Path, text: str = "x") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _try_symlink(target: Path, link: Path) -> bool:
    try:
        os.symlink(target, link)
    except (OSError, NotImplementedError):
        return False
    return True


def _try_symlink_dir(target: Path, link: Path) -> bool:
    """Create a directory symlink, falling back to a Windows junction."""
    try:
        os.symlink(target, link, target_is_directory=True)
        return True
    except (OSError, NotImplementedError):
        pass
    if os.name == "nt":
        completed = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True,
            text=True,
            check=False,
        )
        return completed.returncode == 0 and link.exists()
    return False


# --------------------------------------------------------------------------- #
# Synthetic connector
# --------------------------------------------------------------------------- #


def test_synthetic_is_deterministic_and_prefixed() -> None:
    records = [
        record
        for batch in SyntheticConnector(config={"count": 7}).iter_batches(batch_size=3)
        for record in batch.records
    ]
    assert len(records) == 7
    assert all(record.source_key.startswith("SYNTH-") for record in records)
    assert records[0].source_key == "SYNTH-SYNTHETIC-0001"
    assert records[0].size_bytes > 0
    assert records[0].checksum_sha256 is None


def test_synthetic_batching_does_not_change_records() -> None:
    def keys(batch_size: int) -> list[str]:
        return [
            record.source_key
            for batch in SyntheticConnector(config={"count": 7}).iter_batches(
                batch_size=batch_size
            )
            for record in batch.records
        ]

    assert keys(2) == keys(100)
    assert len(list(SyntheticConnector(config={"count": 7}).iter_batches(batch_size=2))) == 4


def test_synthetic_rejects_negative_count() -> None:
    with pytest.raises(ConnectorError):
        SyntheticConnector(config={"count": -1}).validate()


# --------------------------------------------------------------------------- #
# Local folder connector (security)
# --------------------------------------------------------------------------- #


def test_local_folder_discovers_relative_metadata(tmp_path: Path) -> None:
    root = tmp_path / "root"
    _write(root / "a.txt", "hello")
    _write(root / "nested" / "b.csv", "a,b")
    connector = LocalFolderConnector(root_path=str(root))

    records = [r for batch in connector.iter_batches(batch_size=10) for r in batch.records]
    by_key = {r.source_key: r for r in records}
    assert sorted(by_key) == ["a.txt", "nested/b.csv"]
    assert by_key["a.txt"].size_bytes == 5
    # Contents are never read, so no checksum and no guessed sensitivity.
    assert by_key["a.txt"].checksum_sha256 is None
    assert by_key["a.txt"].sensitivity == "unknown"
    assert by_key["a.txt"].file_name == "a.txt"


def test_local_folder_rejects_path_outside_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside.txt"
    _write(outside)
    connector = LocalFolderConnector(root_path=str(root))
    with pytest.raises(PathTraversalError):
        connector._describe(outside)


def test_local_folder_missing_root_fails_validation(tmp_path: Path) -> None:
    connector = LocalFolderConnector(root_path=str(tmp_path / "does-not-exist"))
    with pytest.raises(ConnectorError):
        connector.validate()


def test_local_folder_does_not_follow_file_symlinks(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    secret = tmp_path / "secret.txt"
    _write(secret, "top secret")
    if not _try_symlink(secret, root / "link.txt"):
        pytest.skip("symlinks are not supported in this environment")

    batches = list(LocalFolderConnector(root_path=str(root)).iter_batches(batch_size=10))
    records = [r for batch in batches for r in batch.records]
    errors = [e for batch in batches for e in batch.errors]
    assert records == []
    assert any("Symlink" in error.message for error in errors)


def test_local_folder_does_not_descend_symlinked_dirs(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside"
    _write(outside / "hidden.txt", "hidden")
    if not _try_symlink_dir(outside, root / "linkdir"):
        pytest.skip("directory links are not supported in this environment")

    batches = list(LocalFolderConnector(root_path=str(root)).iter_batches(batch_size=10))
    assert [r for batch in batches for r in batch.records] == []
    errors = [e for batch in batches for e in batch.errors]
    assert any("link" in error.message.lower() for error in errors)


def test_local_folder_batches_are_bounded(tmp_path: Path) -> None:
    root = tmp_path / "root"
    for index in range(7):
        _write(root / f"f{index}.txt")
    sizes = [
        len(batch.records)
        for batch in LocalFolderConnector(root_path=str(root)).iter_batches(batch_size=3)
    ]
    assert sizes == [3, 3, 1]


# --------------------------------------------------------------------------- #
# Connector factory / allow-list
# --------------------------------------------------------------------------- #


def test_build_connector_rejects_unknown_root_key(settings_override: Settings) -> None:
    source = models.DataSource(
        name="local", source_type="local_folder", connector_type="local_folder", root_key="nope"
    )
    with pytest.raises(UnauthorizedRootError):
        scan_service.build_connector(source, settings_override)


def test_build_connector_unknown_type(settings_override: Settings) -> None:
    source = models.DataSource(name="weird", source_type="ftp", connector_type="ftp")
    with pytest.raises(ConnectorError):
        scan_service.build_connector(source, settings_override)


# --------------------------------------------------------------------------- #
# Lifecycle state machine (unit)
# --------------------------------------------------------------------------- #


def test_transition_table_rejects_illegal_moves() -> None:
    assert scan_service.can_transition("PENDING", "RUNNING")
    assert scan_service.can_transition("PENDING", "CANCELLED")
    assert scan_service.can_transition("RUNNING", "COMPLETED_WITH_ERRORS")
    assert not scan_service.can_transition("COMPLETED", "RUNNING")
    assert not scan_service.can_transition("FAILED", "RUNNING")
    assert not scan_service.can_transition("CANCELLED", "RUNNING")
    assert not scan_service.can_transition("RUNNING", "PENDING")


def test_transition_sets_completed_at_for_terminal() -> None:
    job = models.ScanJob(data_source_id=1, status="RUNNING")
    scan_service.transition(job, "FAILED")
    assert job.status == "FAILED"
    assert job.completed_at is not None


# --------------------------------------------------------------------------- #
# API: sources
# --------------------------------------------------------------------------- #


def test_create_and_list_synthetic_source(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    created = _create_source(client, name="Demo source", count=3)
    assert created["connector_type"] == "synthetic"
    assert created["status"] == "active"

    body = client.get("/api/v1/sources").json()
    assert body["total"] == 1
    assert body["items"][0]["name"] == "Demo source"


def test_source_name_is_unique_per_institution(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    _create_source(client, name="Dup")
    response = client.post(
        "/api/v1/sources",
        json={"name": "Dup", "connector_type": "synthetic", "config": {"count": 1}},
    )
    assert response.status_code == 409


def test_local_source_requires_allowlisted_root_key(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    missing = client.post(
        "/api/v1/sources",
        json={"name": "Local", "connector_type": "local_folder"},
    )
    assert missing.status_code == 422

    unknown = client.post(
        "/api/v1/sources",
        json={"name": "Local", "connector_type": "local_folder", "root_key": "nope"},
    )
    assert unknown.status_code == 422


def test_synthetic_source_rejects_root_key(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    response = client.post(
        "/api/v1/sources",
        json={"name": "S", "connector_type": "synthetic", "root_key": "fixtures"},
    )
    assert response.status_code == 422


def test_config_must_not_contain_secrets(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    response = client.post(
        "/api/v1/sources",
        json={
            "name": "S",
            "connector_type": "synthetic",
            "config": {"password": "hunter2"},
        },
    )
    assert response.status_code == 422


def test_response_never_leaks_absolute_paths(
    client: TestClient,
    test_db: sessionmaker,
    settings_override: Settings,
    tmp_path: Path,
) -> None:
    _write(Path(settings_override.local_source_roots["fixtures"]) / "one.txt")
    response = client.post(
        "/api/v1/sources",
        json={"name": "Local", "connector_type": "local_folder", "root_key": "fixtures"},
    )
    assert response.status_code == 201, response.text
    assert str(tmp_path) not in response.text
    assert response.json()["root_key"] == "fixtures"


def test_validate_source_reports_ok(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    created = _create_source(client)
    response = client.post(f"/api/v1/sources/{created['id']}/validate")
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_source_pagination(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    for index in range(3):
        _create_source(client, name=f"Source {index}")
    body = client.get("/api/v1/sources?per_page=2").json()
    assert body["total"] == 3
    assert body["pages"] == 2
    assert len(body["items"]) == 2


def test_institution_isolation_on_source_lookup(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    other = _make_institution(test_db, code="OTHER")
    created = _create_source(client)
    response = client.get(f"/api/v1/sources/{created['id']}?institution_id={other}")
    assert response.status_code == 404


def test_institution_must_exist(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    response = client.post(
        "/api/v1/sources",
        json={
            "name": "S",
            "connector_type": "synthetic",
            "institution_id": 999,
            "config": {"count": 1},
        },
    )
    assert response.status_code == 422


# --------------------------------------------------------------------------- #
# API: scans
# --------------------------------------------------------------------------- #


def test_scan_imports_then_rescan_is_idempotent(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    created = _create_source(client, count=5)

    first = client.post(f"/api/v1/sources/{created['id']}/scans", json={"batch_size": 2})
    assert first.status_code == 201, first.text
    job = first.json()
    assert job["status"] == "COMPLETED"
    assert (job["total_discovered"], job["total_imported"]) == (5, 5)

    second = client.post(f"/api/v1/sources/{created['id']}/scans", json={"batch_size": 2})
    assert second.status_code == 201, second.text
    body = second.json()
    assert body["total_imported"] == 0
    assert body["total_skipped"] == 5

    with test_db() as db:
        count = db.execute(
            select(func.count(models.InventoryRecord.id)).where(
                models.InventoryRecord.data_source_id == created["id"]
            )
        ).scalar()
    assert count == 5


def test_scan_results_and_errors_are_listed(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    created = _create_source(client, count=4)
    job = client.post(f"/api/v1/sources/{created['id']}/scans").json()

    results = client.get(f"/api/v1/scan-jobs/{job['id']}/results").json()
    assert results["total"] == 4
    assert all(item["status"] == "imported" for item in results["items"])
    assert all(item["imported_asset_id"] for item in results["items"])

    errors = client.get(f"/api/v1/scan-jobs/{job['id']}/errors").json()
    assert errors["total"] == 0


def test_duplicate_active_scan_is_rejected(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    created = _create_source(client)
    first = client.post(f"/api/v1/sources/{created['id']}/scans", json={"run": False})
    assert first.status_code == 201
    assert first.json()["status"] == "PENDING"

    second = client.post(f"/api/v1/sources/{created['id']}/scans", json={"run": False})
    assert second.status_code == 409


def test_cancel_pending_then_reject_second_cancel(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    created = _create_source(client)
    job = client.post(f"/api/v1/sources/{created['id']}/scans", json={"run": False}).json()

    cancelled = client.post(f"/api/v1/scan-jobs/{job['id']}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "CANCELLED"

    assert client.post(f"/api/v1/scan-jobs/{job['id']}/cancel").status_code == 409


def test_cancel_completed_scan_is_rejected(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    created = _create_source(client)
    job = client.post(f"/api/v1/sources/{created['id']}/scans").json()
    assert client.post(f"/api/v1/scan-jobs/{job['id']}/cancel").status_code == 409


def test_failed_scan_and_retry(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    # Allow-listed at creation, but the folder does not exist at scan time.
    created = client.post(
        "/api/v1/sources",
        json={"name": "Broken", "connector_type": "local_folder", "root_key": "fixtures"},
    ).json()

    job = client.post(f"/api/v1/sources/{created['id']}/scans").json()
    assert job["status"] == "FAILED"
    assert job["error_message"]

    retried = client.post(f"/api/v1/scan-jobs/{job['id']}/retry")
    assert retried.status_code == 201
    new_job = retried.json()
    assert new_job["id"] != job["id"]
    assert new_job["retried_from_job_id"] == job["id"]
    assert new_job["status"] == "FAILED"


def test_retry_completed_scan_is_rejected(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    created = _create_source(client)
    job = client.post(f"/api/v1/sources/{created['id']}/scans").json()
    assert job["status"] == "COMPLETED"
    assert client.post(f"/api/v1/scan-jobs/{job['id']}/retry").status_code == 409


def test_local_folder_scan_end_to_end(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    fixtures = Path(settings_override.local_source_roots["fixtures"])
    _write(fixtures / "alpha.txt", "alpha")
    _write(fixtures / "beta" / "beta.txt", "beta")

    created = client.post(
        "/api/v1/sources",
        json={"name": "Local", "connector_type": "local_folder", "root_key": "fixtures"},
    ).json()
    job = client.post(f"/api/v1/sources/{created['id']}/scans").json()
    assert job["status"] == "COMPLETED"
    assert job["total_imported"] == 2

    results = client.get(f"/api/v1/scan-jobs/{job['id']}/results").json()
    assert sorted(item["source_key"] for item in results["items"]) == [
        "alpha.txt",
        "beta/beta.txt",
    ]


def test_scan_respects_record_ceiling(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    settings_override.scan_max_records = 3
    created = _create_source(client, count=10)
    job = client.post(f"/api/v1/sources/{created['id']}/scans").json()
    assert job["status"] == "COMPLETED_WITH_ERRORS"
    assert job["total_discovered"] == 3
    assert job["total_errors"] == 1


def test_scan_job_institution_isolation(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    other = _make_institution(test_db, code="OTHER")
    created = _create_source(client)
    job = client.post(f"/api/v1/sources/{created['id']}/scans").json()
    response = client.get(f"/api/v1/scan-jobs/{job['id']}?institution_id={other}")
    assert response.status_code == 404


def test_audit_events_recorded_for_scan(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    created = _create_source(client)
    client.post(f"/api/v1/sources/{created['id']}/scans")
    with test_db() as db:
        event_types = set(db.execute(select(models.AuditEvent.event_type)).scalars().all())
    assert {"scan.created", "scan.started", "scan.completed"} <= event_types


def test_scan_jobs_pagination(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    created = _create_source(client)
    for _ in range(3):
        client.post(f"/api/v1/sources/{created['id']}/scans")
    body = client.get("/api/v1/scan-jobs?per_page=2").json()
    assert body["total"] == 3
    assert body["pages"] == 2


def test_scan_job_can_be_created_then_run(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    created = _create_source(client)
    response = client.post(
        "/api/v1/scan-jobs", json={"data_source_id": created["id"], "run": False}
    )
    assert response.status_code == 201
    job_id = response.json()["id"]
    assert response.json()["status"] == "PENDING"

    run = client.post(f"/api/v1/scan-jobs/{job_id}/run")
    assert run.status_code == 200
    assert run.json()["status"] == "COMPLETED"


def test_double_run_is_rejected(
    client: TestClient, test_db: sessionmaker, settings_override: Settings
) -> None:
    created = _create_source(client)
    job = client.post(f"/api/v1/sources/{created['id']}/scans").json()
    assert client.post(f"/api/v1/scan-jobs/{job['id']}/run").status_code == 409


def test_production_without_auth_config_fails_closed(
    client: TestClient,
    test_db: sessionmaker,
    production_environment: None,
) -> None:
    """ADR-0014: production without a signing secret refuses *everything*.

    The Phase 1-3 per-endpoint write guard (ADR-0010/0011) is retired: its job
    is now done by one dependency on every protected route, and that dependency
    fails closed for reads *and* writes alike. A misconfigured deployment
    exposes no data at all rather than quietly serving read-only data, and it
    never falls back to a development identity.
    """
    # A write...
    response = client.post(
        "/api/v1/sources",
        json={"name": "Prod", "connector_type": "synthetic", "config": {"count": 1}},
    )
    assert response.status_code == 503
    # A stable machine-readable prefix, so the UI can distinguish "this
    # deployment has no auth at all" from any other 503.
    assert response.json()["detail"].startswith("auth_not_configured:")

    # ...a read...
    assert client.get("/api/v1/sources").status_code == 503

    # ...and the development sign-in path, which has no secret to sign with.
    anonymous = client.post(
        "/api/v1/auth/dev-login",
        json={"email": "nobody@datadiet.test", "platform_admin": True},
    )
    assert anonymous.status_code == 503
    assert anonymous.json()["detail"].startswith("auth_not_configured:")

    # Health probes stay observable while everything else is dark.
    assert client.get("/api/v1/health").status_code == 200

    # The public config endpoint tells the UI the truth about that.
    config = client.get("/api/v1/auth/config").json()
    assert config["authentication"] == "unconfigured"
    assert config["dev_login_enabled"] is False


def test_production_rejects_the_development_placeholder_secret(
    client: TestClient, test_db: sessionmaker, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Even when the dev value is *set*, production refuses to verify against it."""
    from app.core.config import DEV_AUTH_JWT_SECRET, get_settings

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("AUTH_JWT_SECRET", DEV_AUTH_JWT_SECRET)
    get_settings.cache_clear()
    try:
        assert client.get("/api/v1/sources").status_code == 503
    finally:
        get_settings.cache_clear()


def test_production_never_offers_development_sign_in(
    client: TestClient, test_db: sessionmaker, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A production deployment with a real secret still has no local sign-in."""
    import secrets

    from app.core.config import get_settings

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("AUTH_JWT_SECRET", secrets.token_urlsafe(48))
    get_settings.cache_clear()
    try:
        with test_db() as db:
            before = db.execute(
                select(models.AuditEvent).where(
                    models.AuditEvent.event_type == "auth.dev_login_denied"
                )
            ).scalars().all()
        # Sign-in itself is refused, and the public denial writes no audit row:
        # attacker-controlled identity fields must never reach the audit log.
        response = client.post(
            "/api/v1/auth/dev-login",
            json={"email": "nobody@datadiet.test", "platform_admin": True},
        )
        assert response.status_code == 503
        with test_db() as db:
            after = db.execute(
                select(models.AuditEvent).where(
                    models.AuditEvent.event_type == "auth.dev_login_denied"
                )
            ).scalars().all()
        assert len(before) == len(after) == 0

        # ...and the public config endpoint says so rather than inviting a
        # development sign-in the server would reject.
        config = client.get("/api/v1/auth/config").json()
        assert config["dev_login_enabled"] is False
        assert config["authentication"] == "bearer_boundary"
    finally:
        get_settings.cache_clear()


# --------------------------------------------------------------------------- #
# Schema integrity (light; MySQL round-trip lives in test_migrations_mysql.py)
# --------------------------------------------------------------------------- #


def test_phase4_tables_and_columns_are_registered() -> None:
    tables = set(models.Base.metadata.tables)
    assert {"scan_jobs", "scan_results", "scan_errors", "source_record_mappings"} <= tables
    assert {"connector_type", "root_key", "config", "last_validation_ok"} <= set(
        models.DataSource.__table__.columns.keys()
    )


def test_migration_file_declares_head() -> None:
    versions = Path(__file__).resolve().parents[2] / "database" / "migrations" / "versions"
    path = versions / "0005_source_connectors.py"
    assert path.exists()
    text = path.read_text(encoding="utf-8")
    assert 'revision: str = "0005_source_connectors"' in text
    assert 'down_revision: Union[str, None] = "0004_review_decisions"' in text


def test_discovery_error_message_is_json_safe() -> None:
    error = DiscoveryError(message="bad", path="a.txt", severity="warning")
    assert json.loads(json.dumps({"message": error.message}))["message"] == "bad"
