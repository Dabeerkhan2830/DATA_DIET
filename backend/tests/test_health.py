"""Tests for the health and readiness endpoints."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.api.routes import health as health_module


def test_health_returns_ok(client: TestClient) -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "DataDiet API"
    assert body["environment"] in {"development", "test", "production"}


def test_health_docs_available(client: TestClient) -> None:
    response = client.get("/openapi.json")
    assert response.status_code == 200
    paths = response.json()["paths"]
    assert "/api/v1/health" in paths
    assert "/api/v1/health/ready" in paths


def test_readiness_degraded_when_database_unreachable(
    client: TestClient, monkeypatch
) -> None:
    """Without MySQL running, readiness must report degraded with HTTP 503."""
    monkeypatch.setattr(
        health_module,
        "check_database_connection",
        lambda: (False, "Connection refused (test simulation)"),
    )
    response = client.get("/api/v1/health/ready")
    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert body["database"]["reachable"] is False


def test_readiness_ready_when_database_reachable(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(
        health_module,
        "check_database_connection",
        lambda: (True, "SELECT 1 succeeded"),
    )
    response = client.get("/api/v1/health/ready")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["database"]["reachable"] is True
