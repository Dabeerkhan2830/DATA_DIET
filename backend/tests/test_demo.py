"""Tests for the synthetic demo endpoints (envelope labeling + shapes)."""

from __future__ import annotations

from fastapi.testclient import TestClient


def _unwrap(response: TestClient.Response) -> tuple[dict, object]:
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["meta"]["classification"] == "synthetic_demo_data"
    assert "SYNTHETIC" in body["meta"]["notice"]
    return body["meta"], body["data"]


def test_dashboard_demo_endpoint(client: TestClient) -> None:
    _, data = _unwrap(client.get("/api/v1/demo/dashboard"))
    assert data["total_records"] == 14
    assert data["duplicate_candidates"] >= 1
    assert sum(data["by_sensitivity"].values()) == data["total_records"]
    assert sum(data["by_risk_band"].values()) == data["total_records"]
    assert sum(data["by_retention_action"].values()) == data["total_records"]
    assert len(data["recent_activity"]) >= 1


def test_inventory_demo_endpoint(client: TestClient) -> None:
    _, data = _unwrap(client.get("/api/v1/demo/inventory"))
    assert isinstance(data, list) and len(data) == 14
    for record in data:
        assert record["record_id"].startswith("SYNTH-"), "all ids must be synthetic"
        assert record["sensitivity"] in {"public", "internal", "confidential", "restricted"}
        assert record["retention_action"] in {
            "retain", "archive", "review", "eligible_for_disposal",
        }


def test_risk_demo_endpoint_is_explainable(client: TestClient) -> None:
    _, data = _unwrap(client.get("/api/v1/demo/risk"))
    assert data["rule_set"] == "datadiet-risk-indicators-v1"
    assert len(data["rules"]) == 5
    for record in data["records"]:
        assert 0 <= record["score"] <= 100
        if record["score"] > 0:
            assert record["indicators"], "a non-zero score must expose indicators"
            assert sum(i["points"] for i in record["indicators"]) == min(
                100, sum(i["points"] for i in record["indicators"])
            )


def test_retention_demo_endpoint(client: TestClient) -> None:
    _, data = _unwrap(client.get("/api/v1/demo/retention"))
    assert len(data["policies"]) == 3
    statuses = {p["status"] for p in data["policies"]}
    assert statuses == {"active", "draft", "retired"}
    assert len(data["active_holds"]) == 2
    assert len(data["approval_queue"]) == 3


def test_connected_sources_is_empty(client: TestClient) -> None:
    """No source connectors exist in Phase 1 — the list must stay empty."""
    _, data = _unwrap(client.get("/api/v1/demo/connected-sources"))
    assert data == []
