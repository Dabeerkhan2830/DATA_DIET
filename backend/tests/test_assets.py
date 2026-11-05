"""Tests for data assets API."""

from __future__ import annotations

from conftest import seed_identity_directory
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import models, session


def setup_test_db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    models.Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    # This test module swaps in its own database, so the identity directory the
    # authenticated ``client`` maps onto has to exist here too (Phase 7).
    seed_identity_directory(factory)
    return engine, factory


def test_create_asset_and_get(client: TestClient, monkeypatch) -> None:
    engine, Session = setup_test_db()
    monkeypatch.setattr(session, "get_engine", lambda: engine)
    monkeypatch.setattr(session, "_engine", engine)
    monkeypatch.setattr(session, "_session_factory", Session)

    # need a data source
    with Session() as s:
        ds = models.DataSource(name="s1", source_type="file")
        s.add(ds)
        s.commit()
        ds_id = ds.id

    payload = {
        "data_source_id": ds_id,
        "external_id": "a1",
        "title": "Asset One",
        "record_type": "document",
        "sensitivity": "unknown",
        "lifecycle_status": "active",
    }
    r = client.post("/api/v1/assets", json=payload)
    assert r.status_code == 201
    body = r.json()
    assert body["title"] == "Asset One"
    assert body["id"] > 0

    r = client.get(f"/api/v1/assets/{body['id']}")
    assert r.status_code == 200
    assert r.json()["title"] == "Asset One"

    r = client.get("/api/v1/assets/999")
    assert r.status_code == 404


def test_list_search_filter_pagination(client: TestClient, monkeypatch) -> None:
    engine, Session = setup_test_db()
    monkeypatch.setattr(session, "get_engine", lambda: engine)
    monkeypatch.setattr(session, "_engine", engine)
    monkeypatch.setattr(session, "_session_factory", Session)

    with Session() as s:
        ds = models.DataSource(name="s2", source_type="db")
        s.add(ds)
        s.commit()
        ds_id = ds.id
        for i in range(5):
            s.add(models.InventoryRecord(
                data_source_id=ds_id,
                external_id=f"e{i}",
                title=f"Doc {i}",
                record_type="doc",
                category="reports" if i % 2 == 0 else "logs",
                sensitivity="internal",
                lifecycle_status="active",
            ))
        s.commit()

    r = client.get("/api/v1/assets?search=Doc")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 5
    assert len(body["items"]) <= 20

    r = client.get("/api/v1/assets?category=reports")
    assert r.status_code == 200
    assert r.json()["total"] == 3

    r = client.get("/api/v1/assets?per_page=2&page=2")
    assert r.status_code == 200
    assert len(r.json()["items"]) == 2


def test_update_asset(client: TestClient, monkeypatch) -> None:
    engine, Session = setup_test_db()
    monkeypatch.setattr(session, "get_engine", lambda: engine)
    monkeypatch.setattr(session, "_engine", engine)
    monkeypatch.setattr(session, "_session_factory", Session)

    with Session() as s:
        ds = models.DataSource(name="s3", source_type="file")
        s.add(ds)
        s.commit()
        ds_id = ds.id
        a = models.InventoryRecord(
            data_source_id=ds_id,
            external_id="e1",
            title="Old",
            record_type="doc",
        )
        s.add(a)
        s.commit()
        aid = a.id

    r = client.patch(f"/api/v1/assets/{aid}", json={"title": "New", "sensitivity": "confidential"})
    assert r.status_code == 200
    assert r.json()["title"] == "New"
    assert r.json()["sensitivity"] == "confidential"

    r = client.patch("/api/v1/assets/123", json={"title": "X"})
    assert r.status_code == 404
