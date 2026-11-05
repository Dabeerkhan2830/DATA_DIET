"""Tests for retention policies, holds, assessments and reviewer decisions.

Everything here is advisory: no test may assert that a file was moved,
archived, or deleted, because the system performs no such operation.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from conftest import seed_identity_directory
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import models, session


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


def _make_institution(test_db: sessionmaker[Session], *, code: str) -> int:
    with test_db() as db:
        institution = models.Institution(code=code, name=f"Institution {code}")
        db.add(institution)
        db.commit()
        db.refresh(institution)
        return institution.id


def _make_asset(
    test_db: sessionmaker[Session],
    *,
    external_id: str,
    institution_id: int | None = None,
    category: str | None = None,
    created_at: datetime | None = None,
) -> int:
    with test_db() as db:
        source = models.DataSource(
            institution_id=institution_id,
            name=f"src-{external_id}",
            source_type="synthetic",
        )
        db.add(source)
        db.flush()
        asset = models.InventoryRecord(
            institution_id=institution_id,
            data_source_id=source.id,
            external_id=external_id,
            title=f"Asset {external_id}",
            record_type="document",
            category=category,
            sensitivity="internal",
            lifecycle_status="active",
            created_at=created_at or datetime.now(UTC),
        )
        db.add(asset)
        db.commit()
        db.refresh(asset)
        return asset.id


def _activate_policy(
    client: TestClient,
    *,
    name: str,
    categories: list[str],
    period_days: int,
    institution_id: int | None = None,
    trigger: str = "created_at",
) -> int:
    """Create, version and activate a policy; return the policy id."""
    r = client.post(
        "/api/v1/retention/policies",
        json={
            "name": name,
            "institution_id": institution_id,
            "applicable_categories": categories,
        },
    )
    assert r.status_code == 201, r.text
    policy_id = r.json()["id"]
    r = client.post(
        f"/api/v1/retention/policies/{policy_id}/versions",
        json={
            "applicable_categories": categories,
            "retention_period_days": period_days,
            "retention_trigger": trigger,
        },
    )
    assert r.status_code == 201, r.text
    version_id = r.json()["id"]
    r = client.post(
        f"/api/v1/retention/policies/{policy_id}/activate",
        json={"version_id": version_id},
    )
    assert r.status_code == 200, r.text
    return policy_id


def test_policy_matching_by_institution(client: TestClient, test_db: sessionmaker) -> None:
    now = datetime.now(UTC)
    inst1 = _make_institution(test_db, code="I1")
    inst2 = _make_institution(test_db, code="I2")
    aid1 = _make_asset(
        test_db, external_id="a1", institution_id=inst1, category="hr", created_at=now
    )
    aid2 = _make_asset(
        test_db, external_id="a2", institution_id=inst2, category="hr", created_at=now
    )

    # Policy for inst1 only
    _activate_policy(
        client, name="P-inst1", institution_id=inst1, categories=["hr"], period_days=30
    )

    r = client.post(f"/api/v1/retention/assess/{aid1}")
    assert r.status_code == 200, r.text
    assert r.json()["recommendation"] == "RETAIN"

    r = client.post(f"/api/v1/retention/assess/{aid2}")
    assert r.status_code == 200, r.text
    # inst2 has no applicable policy
    assert r.json()["recommendation"] == "NO_APPLICABLE_POLICY"


def test_draft_policy_never_applied(client: TestClient, test_db: sessionmaker) -> None:
    aid = _make_asset(test_db, external_id="draft-1", category="finance")
    r = client.post(
        "/api/v1/retention/policies",
        json={"name": "P-draft", "applicable_categories": ["finance"]},
    )
    assert r.status_code == 201

    r = client.post(f"/api/v1/retention/assess/{aid}")
    assert r.status_code == 200
    assert r.json()["recommendation"] == "NO_APPLICABLE_POLICY"


def test_retention_expired_triggers_review(client: TestClient, test_db: sessionmaker) -> None:
    from datetime import timedelta

    aid = _make_asset(
        test_db,
        external_id="exp-1",
        category="hr",
        created_at=datetime.now(UTC) - timedelta(days=400),
    )
    _activate_policy(client, name="P-exp", categories=["hr"], period_days=30)

    r = client.post(f"/api/v1/retention/assess/{aid}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["recommendation"] == "DISPOSAL_REVIEW_REQUIRED"
    assert body["retention_deadline"] is not None
    assert body["unresolved_conditions"] == ["retention_period_expired"]


def test_missing_trigger_date_forces_review(client: TestClient, test_db: sessionmaker) -> None:
    aid = _make_asset(test_db, external_id="nodate-1", category="hr")
    # Use trigger last_reviewed which is None by default
    _activate_policy(
        client, name="P-nodate", categories=["hr"], trigger="last_reviewed", period_days=30
    )

    r = client.post(f"/api/v1/retention/assess/{aid}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["recommendation"] == "REVIEW_REQUIRED"
    assert "retention_trigger_date_missing" in [f["code"] for f in body["findings"]]


def test_cross_institution_asset_scoped(client: TestClient, test_db: sessionmaker) -> None:
    inst1 = _make_institution(test_db, code="X1")
    inst2 = _make_institution(test_db, code="X2")
    aid1 = _make_asset(test_db, external_id="x1", institution_id=inst1, category="hr")

    # A hold for inst2 may not cover inst1's asset.
    r = client.post(
        "/api/v1/retention/holds",
        json={"name": "H-x", "asset_id": aid1, "institution_id": inst2},
    )
    assert r.status_code == 422


def test_hold_release_is_single_shot(client: TestClient, test_db: sessionmaker) -> None:
    aid = _make_asset(test_db, external_id="rel-1", category="hr")
    r = client.post("/api/v1/retention/holds", json={"name": "H-rel", "asset_id": aid})
    assert r.status_code == 201, r.text
    hold_id = r.json()["id"]

    r = client.patch(
        f"/api/v1/retention/holds/{hold_id}/release",
        json={"release_reason": "Matter closed"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "released"

    # Releasing an already-released hold is a state conflict, not a success.
    r = client.patch(
        f"/api/v1/retention/holds/{hold_id}/release",
        json={"release_reason": "again"},
    )
    assert r.status_code == 409


def test_assessment_history_preserved_per_reassessment(
    client: TestClient, test_db: sessionmaker
) -> None:
    aid = _make_asset(test_db, external_id="hist2-1", category="hr")
    _activate_policy(client, name="P-h2", categories=["hr"], period_days=90)

    r = client.post(f"/api/v1/retention/assess/{aid}")
    assert r.status_code == 200, r.text

    r = client.post("/api/v1/retention/holds", json={"name": "H-h2", "asset_id": aid})
    assert r.status_code == 201, r.text
    r = client.post(f"/api/v1/retention/assess/{aid}")
    assert r.status_code == 200, r.text

    r = client.get(f"/api/v1/retention/assessments/{aid}/history")
    assert r.status_code == 200
    hist = r.json()
    assert len(hist) == 2
    # Most recent first; the earlier assessment had no hold.
    assert hist[0]["recommendation"] == "BLOCKED_BY_HOLD"
    assert hist[1]["recommendation"] == "RETAIN"


def test_decision_recorded_and_listed(client: TestClient, test_db: sessionmaker) -> None:
    aid = _make_asset(test_db, external_id="dec-1", category="hr")
    _activate_policy(client, name="P-dec", categories=["hr"], period_days=90)

    r = client.post(f"/api/v1/retention/assess/{aid}")
    assert r.status_code == 200
    ass = r.json()
    ass_id = ass["id"]

    r = client.post(
        f"/api/v1/retention/assessments/{ass_id}/decisions",
        json={"decision": "retain", "reason": "Keep for operational use", "reviewer": "Alex"},
    )
    assert r.status_code == 201, r.text
    dec = r.json()
    assert dec["decision"] == "retain"
    assert dec["assessment_id"] == ass_id

    r = client.get(f"/api/v1/retention/assessments/{ass_id}/decisions")
    assert r.status_code == 200
    assert len(r.json()) == 1

    r = client.post(
        f"/api/v1/retention/assessments/{ass_id}/decisions",
        json={"decision": "retain", "reason": "Duplicate", "reviewer": "Bob"},
    )
    assert r.status_code == 409  # decisions are immutable/one per assessment


def test_assess_response_matches_the_persisted_timestamp(
    client: TestClient, test_db: sessionmaker
) -> None:
    """The assessed timestamp handed to the client must equal the stored one.

    MySQL DATETIME keeps whole seconds while SQLite preserves microseconds, so
    returning the in-memory microsecond value would look correct in SQLite
    tests and then break every real submit: the decision endpoint's
    ``expected_assessed_at`` token would always appear stale. The token the
    response hands out must be accepted verbatim (Phase 7 regression).
    """
    aid = _make_asset(test_db, external_id="ts-roundtrip", category="hr")
    r = client.post(f"/api/v1/retention/assess/{aid}")
    assert r.status_code == 200, r.text
    body = r.json()

    history = client.get(f"/api/v1/retention/assessments/{aid}/history")
    assert history.status_code == 200
    stored = next(row for row in history.json() if row["id"] == body["id"])
    assert body["assessed_at"] == stored["assessed_at"]

    r = client.post(
        f"/api/v1/retention/assessments/{body['id']}/decisions",
        json={
            "decision": "retain",
            "reason": "Timestamp round-trip regression decision.",
            "expected_assessed_at": body["assessed_at"],
            "expected_policy_version_id": body["policy_version_id"],
            "expected_holds_active": body["holds_active"],
        },
    )
    assert r.status_code == 201, r.text


def test_decision_references_assessment_version(
    client: TestClient, test_db: sessionmaker
) -> None:
    aid = _make_asset(test_db, external_id="decv-1", category="hr")
    r = client.post(
        "/api/v1/retention/policies",
        json={"name": "P-dev", "applicable_categories": ["hr"]},
    )
    pid = r.json()["id"]
    r = client.post(f"/api/v1/retention/policies/{pid}/versions", json={})
    vid1 = r.json()["id"]
    client.post(f"/api/v1/retention/policies/{pid}/activate", json={"version_id": vid1})

    r = client.post(f"/api/v1/retention/assess/{aid}")
    ass1 = r.json()

    # Add second version and activate
    r = client.post(
        f"/api/v1/retention/policies/{pid}/versions",
        json={"retention_period_days": 90},
    )
    vid2 = r.json()["id"]
    client.post(f"/api/v1/retention/policies/{pid}/activate", json={"version_id": vid2})

    # Decision is against ass1 (version 1)
    r = client.post(
        f"/api/v1/retention/assessments/{ass1['id']}/decisions",
        json={"decision": "retain", "reason": "Historic", "reviewer": "C"},
    )
    assert r.status_code == 201
    dec = r.json()
    assert dec["policy_version_id"] == vid1
