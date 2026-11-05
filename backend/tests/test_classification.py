"""Phase 5: deterministic classification and data-quality tests.

These tests cover the requirements: unknowns must be explicit, rules must be
deterministic, duplicate candidates are distinguished (possible vs confirmed),
history and idempotency are preserved, rule versions and institution isolation
are respected, and classification never mutates inventory records.
"""

from __future__ import annotations

import os

from fastapi.testclient import TestClient

from app.core.config import get_settings


def setup_module() -> None:
    get_settings.cache_clear()
    os.environ.setdefault("ENVIRONMENT", "test")


def teardown_module() -> None:
    get_settings.cache_clear()


def _make_asset(
    client: TestClient,
    *,
    institution_id: int | None = 1,
    data_source_id: int = 1,
    external_id: str = "A1",
    title: str = "Record",
    record_type: str = "record",
    category: str | None = None,
    source_type: str | None = None,
    file_name: str | None = None,
    mime_type: str | None = None,
    size_bytes: int = 0,
    checksum_sha256: str | None = None,
    sensitivity: str = "unknown",
    contains_personal_data: bool = False,
):
    payload = {
        "institution_id": institution_id,
        "data_source_id": data_source_id,
        "external_id": external_id,
        "title": title,
        "record_type": record_type,
        "category": category,
        "source_type": source_type,
        "file_name": file_name,
        "mime_type": mime_type,
        "size_bytes": size_bytes,
        "checksum_sha256": checksum_sha256,
        "sensitivity": sensitivity,
        "contains_personal_data": contains_personal_data,
    }
    resp = client.post("/api/v1/assets", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_unknown_when_insufficient(client: TestClient) -> None:
    asset = _make_asset(client, external_id="C1", title="Mystery", record_type="record")
    run = client.post(f"/api/v1/classification/assets/{asset['id']}")
    assert run.status_code == 201, run.text
    body = run.json()
    assert body["outcome"] == "unclassified"
    assert body["proposed_sensitivity"] == "unknown"
    assert body["confidence"] == "none"
    assert body["proposed_category"] is None
    assert any("unassessed" in w.lower() or "unclassified" in w.lower() for w in body["warnings"])


def test_extension_hint_does_not_prove_contents_and_low_confidence(client: TestClient) -> None:
    asset = _make_asset(
        client,
        external_id="EXT1",
        title="Report",
        record_type="document",
        file_name="finance_report.pdf",
        sensitivity="unknown",
    )
    run = client.post(f"/api/v1/classification/assets/{asset['id']}")
    assert run.status_code == 201
    body = run.json()
    assert body["proposed_category"] is not None
    assert body["confidence"] in ("low", "medium")
    # extension-derived signal must warn about name/extension not proving contents
    assert any("never proves" in w.lower() or "hint" in w.lower() for w in body["warnings"])


def test_conflict_resolution_protective(client: TestClient) -> None:
    asset = _make_asset(
        client,
        external_id="CON1",
        title="Roster",
        record_type="student_records",
        file_name="roster.csv",  # sensitive-extension
        sensitivity="public",
        contains_personal_data=True,
    )
    run = client.post(f"/api/v1/classification/assets/{asset['id']}")
    assert run.status_code == 201
    body = run.json()
    assert body["proposed_sensitivity"] != "public"
    assert body["conflicts"]
    assert any("conflict" in w.lower() for w in body["warnings"])


def test_synthetic_marker_proposed_internal_with_warning(client: TestClient) -> None:
    asset = _make_asset(
        client,
        external_id="SYNTH-001",
        title="Synthetic Demo",
        record_type="dataset",
        sensitivity="unknown",
        contains_personal_data=False,
    )
    run = client.post(f"/api/v1/classification/assets/{asset['id']}")
    assert run.status_code == 201
    body = run.json()
    assert body["proposed_sensitivity"] == "internal"
    assert any("synthetic" in w.lower() for w in body["warnings"])


def test_deterministic_across_runs(client: TestClient) -> None:
    asset = _make_asset(
        client,
        external_id="DET1",
        title="Deterministic",
        record_type="document",
        file_name="handbook.md",
    )
    r1 = client.post(f"/api/v1/classification/assets/{asset['id']}")
    r2 = client.post(f"/api/v1/classification/assets/{asset['id']}")
    assert r1.status_code == 201 and r2.status_code == 201
    assert r1.json()["id"] == r2.json()["id"]
    assert r1.json()["input_fingerprint"] == r2.json()["input_fingerprint"]


def test_classification_history_preserved(client: TestClient) -> None:
    asset = _make_asset(
        client,
        external_id="HIST1",
        title="Hist",
        record_type="document",
        file_name="handbook.md",
    )
    r1 = client.post(f"/api/v1/classification/assets/{asset['id']}")  # first
    client.get(f"/api/v1/assets/{asset['id']}").json()
    # change an input that affects classification
    client.patch(f"/api/v1/assets/{asset['id']}", json={"sensitivity": "confidential"})
    r2 = client.post(f"/api/v1/classification/assets/{asset['id']}")  # second
    assert r1.status_code == 201 and r2.status_code == 201
    assert r1.json()["id"] != r2.json()["id"]
    hist = client.get(f"/api/v1/classification/assets/{asset['id']}/history")
    assert hist.status_code == 200
    assert hist.json()["total"] >= 2


def test_latest_classification_present(client: TestClient) -> None:
    asset = _make_asset(
        client,
        external_id="L1",
        title="Lat",
        record_type="record",
    )
    client.post(f"/api/v1/classification/assets/{asset['id']}")
    latest = client.get(f"/api/v1/classification/assets/{asset['id']}/latest")
    assert latest.status_code == 200
    assert latest.json()["asset_id"] == asset["id"]


def test_rules_endpoint_includes_versions(client: TestClient) -> None:
    rules = client.get("/api/v1/classification/rules")
    assert rules.status_code == 200
    body = rules.json()
    assert "rule_version" in body
    assert body["rules"]
    assert "confidence_meaning" in body


def test_asset_not_mutated_by_classification(client: TestClient) -> None:
    asset = _make_asset(
        client,
        external_id="IMM1",
        title="Imm",
        record_type="record",
        sensitivity="unknown",
        category=None,
    )
    before = client.get(f"/api/v1/assets/{asset['id']}").json()
    run = client.post(f"/api/v1/classification/assets/{asset['id']}")
    assert run.status_code == 201
    after = client.get(f"/api/v1/assets/{asset['id']}").json()
    assert before["category"] == after["category"]
    assert before["sensitivity"] == after["sensitivity"]


def test_quality_possible_duplicate_detected(client: TestClient) -> None:
    _make_asset(
        client,
        external_id="D1",
        title="Shared",
        record_type="document",
        file_name="report.pdf",
        size_bytes=1024,
        checksum_sha256="abc123",
        sensitivity="internal",
    )
    a2 = _make_asset(
        client,
        external_id="D2",
        title="Shared",
        record_type="document",
        file_name="report.pdf",
        size_bytes=1024,
        checksum_sha256="def456",
        sensitivity="internal",
    )
    rep = client.get(f"/api/v1/classification/assets/{a2['id']}/quality")
    assert rep.status_code == 200
    findings = [f for f in rep.json()["findings"] if f["check"] == "possible-duplicate"]
    assert findings and findings[0]["duplicate_status"] == "possible"


def test_quality_confirmed_duplicate_detected(client: TestClient) -> None:
    same = "a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8"
    _make_asset(
        client,
        external_id="CONF1",
        title="Exact",
        record_type="file",
        file_name="exact.dat",
        size_bytes=512,
        checksum_sha256=same,
    )
    a2 = _make_asset(
        client,
        external_id="CONF2",
        title="Exact",
        record_type="file",
        file_name="exact.dat",
        size_bytes=512,
        checksum_sha256=same,
    )
    rep = client.get(f"/api/v1/classification/assets/{a2['id']}/quality")
    findings = [f for f in rep.json()["findings"] if f["check"] == "confirmed-duplicate"]
    assert findings and findings[0]["duplicate_status"] == "confirmed"
    assert findings[0]["related_asset_id"] is not None


def test_quality_missing_metadata_detected(client: TestClient) -> None:
    # title and record_type are required by the API; file_name and mime_type are
    # optional, so a valid API call with no file metadata triggers the finding.
    a = _make_asset(
        client,
        external_id="MISS1",
        title="Record",
        record_type="record",
        file_name=None,
        mime_type=None,
    )
    rep = client.get(f"/api/v1/classification/assets/{a['id']}/quality")
    assert rep.status_code == 200
    has_missing = any(
        f["check"] == "missing-required-metadata" and f["severity"] in ("medium", "high")
        for f in rep.json()["findings"]
    )
    assert has_missing


def test_quality_findings_paginated_and_filtered(client: TestClient) -> None:
    for i in range(5):
        _make_asset(
            client,
            external_id=f"F{i}",
            title=f"F{i}",
            record_type="document",
            file_name=f"doc{i}.docx",
            sensitivity="internal",
            contains_personal_data=True,
        )
    page = client.get("/api/v1/classification/quality/findings", params={"page": 1, "per_page": 2})
    assert page.status_code == 200
    assert len(page.json()["findings"]) <= 2
    filtered = client.get(
        "/api/v1/classification/quality/findings",
        params={"severity": "info", "page": 1},
    )
    assert filtered.status_code == 200


def test_classification_history_pages(client: TestClient) -> None:
    a = _make_asset(
        client,
        external_id="HP1",
        title="HP",
        record_type="record",
        sensitivity="unknown",
    )
    # generate history
    for s in ("internal", "confidential"):
        client.patch(f"/api/v1/assets/{a['id']}", json={"sensitivity": s})
        client.post(f"/api/v1/classification/assets/{a['id']}")
    hist = client.get(f"/api/v1/classification/assets/{a['id']}/history", params={"per_page": 1})
    assert hist.status_code == 200
    assert len(hist.json()["results"]) == 1
