"""Phase 6 tests: unified review workflow and governance integration.

Covers the review queue (filter/pagination/sort), the unified asset governance
view (aggregation, missing data, tenant scope), human review decisions
(validation, staleness, holds, append-only history, audit trail), and the
database-level concurrency guard.

Everything is synthetic. No test asserts that a file was moved, archived, or
deleted, because the system performs no such operation.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from conftest import seed_identity_directory
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import models, session

BASE = "/api/v1"


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
    file_name: str | None = None,
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
            file_name=file_name,
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
) -> tuple[int, int]:
    """Create, version and activate a policy; return ``(policy_id, version_id)``."""
    r = client.post(
        f"{BASE}/retention/policies",
        json={
            "name": name,
            "institution_id": institution_id,
            "applicable_categories": categories,
        },
    )
    assert r.status_code == 201, r.text
    policy_id = r.json()["id"]
    r = client.post(
        f"{BASE}/retention/policies/{policy_id}/versions",
        json={
            "applicable_categories": categories,
            "retention_period_days": period_days,
            "retention_trigger": trigger,
        },
    )
    assert r.status_code == 201, r.text
    version_id = r.json()["id"]
    r = client.post(
        f"{BASE}/retention/policies/{policy_id}/activate",
        json={"version_id": version_id},
    )
    assert r.status_code == 200, r.text
    return policy_id, version_id


def _assess(client: TestClient, asset_id: int) -> dict:
    r = client.post(f"{BASE}/retention/assess/{asset_id}")
    assert r.status_code == 200, r.text
    return r.json()


def _audit_events(test_db: sessionmaker[Session], event_type: str) -> list[models.AuditEvent]:
    with test_db() as db:
        return list(
            db.execute(
                select(models.AuditEvent).where(models.AuditEvent.event_type == event_type)
            )
            .scalars()
            .all()
        )


# --------------------------------------------------------------------------
# Unified asset governance view
# --------------------------------------------------------------------------


def test_governance_view_aggregates_existing_subsystems(
    client: TestClient, test_db: sessionmaker
) -> None:
    aid = _make_asset(
        test_db, external_id="gov-1", category="hr", file_name="pii.csv"
    )
    policy_id, version_id = _activate_policy(
        client, name="P-gov", categories=["hr"], period_days=365
    )
    assessment = _assess(client, aid)
    r = client.post(f"{BASE}/classification/assets/{aid}")
    assert r.status_code == 201, r.text

    r = client.get(f"{BASE}/governance/assets/{aid}")
    assert r.status_code == 200, r.text
    view = r.json()

    assert view["asset"]["id"] == aid
    # Source block: unmapped asset is reported explicitly, never fabricated.
    assert view["source"]["mapping_present"] is False
    assert view["source"]["latest_scan"] is None
    assert view["source"]["notes"]
    # Classification is a system proposal.
    assert view["classification"]["asset_id"] == aid
    assert "classification" in view["provenance"]["system_proposed"]
    # Applicable policy + exact version.
    assert view["applicable_policy"]["policy_id"] == policy_id
    assert view["applicable_policy"]["version_id"] == version_id
    # Assessment + review context tokens.
    assert view["latest_assessment"]["id"] == assessment["id"]
    assert len(view["assessment_history"]) == 1
    ctx = view["review_context"]
    assert ctx["latest_assessment_id"] == assessment["id"]
    assert ctx["expected_policy_version_id"] == version_id
    assert ctx["decisions_recorded"] == 0
    assert ctx["expected_holds_active"] == 0
    # No file operation is ever claimed.
    assert "Not implemented" in view["provenance"]["file_operations"]


def test_governance_view_missing_data_is_explicit(
    client: TestClient, test_db: sessionmaker
) -> None:
    aid = _make_asset(test_db, external_id="gov-empty")

    r = client.get(f"{BASE}/governance/assets/{aid}")
    assert r.status_code == 200, r.text
    view = r.json()

    assert view["classification"] is None
    assert view["applicable_policy"] is None
    assert view["latest_assessment"] is None
    assert view["assessment_history"] == []
    assert view["active_holds"] == []
    assert view["decisions"] == []
    assert view["review_context"]["latest_assessment_id"] is None
    # Quality findings explain the gaps instead of implying the asset is safe.
    checks = {f["check"] for f in view["quality_findings"]}
    assert "unclassified" in checks
    assert "unmapped-source-record" in checks


def test_governance_view_is_institution_scoped(
    client: TestClient, test_db: sessionmaker
) -> None:
    inst1 = _make_institution(test_db, code="G1")
    inst2 = _make_institution(test_db, code="G2")
    aid = _make_asset(test_db, external_id="gov-scope", institution_id=inst1)

    ok = client.get(f"{BASE}/governance/assets/{aid}?institution_id={inst1}")
    assert ok.status_code == 200, ok.text

    mismatch = client.get(f"{BASE}/governance/assets/{aid}?institution_id={inst2}")
    assert mismatch.status_code == 404
    assert mismatch.json()["detail"] == "asset_out_of_scope"

    unknown = client.get(f"{BASE}/governance/assets/{aid}?institution_id=99999")
    assert unknown.status_code == 422


def test_governance_view_unknown_asset(client: TestClient, test_db: sessionmaker) -> None:
    r = client.get(f"{BASE}/governance/assets/424242")
    assert r.status_code == 404
    assert r.json()["detail"] == "asset_not_found"


# --------------------------------------------------------------------------
# Review queue
# --------------------------------------------------------------------------


def test_review_queue_filters_pagination_and_sort(
    client: TestClient, test_db: sessionmaker
) -> None:
    past = datetime.now(UTC) - timedelta(days=400)
    a_old = _make_asset(
        test_db, external_id="q-old", category="hr", created_at=past
    )
    a_new = _make_asset(test_db, external_id="q-new", category="hr")
    a_other = _make_asset(test_db, external_id="q-other", category="finance")
    _activate_policy(client, name="P-q-hr", categories=["hr"], period_days=1)
    # Overdue asset gets DISPOSAL_REVIEW_REQUIRED; the fresh one RETAIN.
    _assess(client, a_old)
    _assess(client, a_new)
    _assess(client, a_other)  # no policy for finance -> NO_APPLICABLE_POLICY

    r = client.get(f"{BASE}/retention/recommendations")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 3
    # urgency: overdue (earliest deadline) first, deterministic on ties.
    assert body["items"][0]["asset_id"] == a_old

    r = client.get(f"{BASE}/retention/recommendations?review_status=open")
    assert r.json()["total"] == 3

    r = client.get(
        f"{BASE}/retention/recommendations?recommendation=NO_APPLICABLE_POLICY"
    )
    assert r.json()["total"] == 1
    assert r.json()["items"][0]["asset_id"] == a_other

    # Pagination is stable.
    page1 = client.get(f"{BASE}/retention/recommendations?sort=age&per_page=2&page=1").json()
    page2 = client.get(f"{BASE}/retention/recommendations?sort=age&per_page=2&page=2").json()
    assert page1["total"] == 3 and page1["pages"] == 2
    assert len(page1["items"]) == 2 and len(page2["items"]) == 1
    ids = [i["asset_id"] for i in page1["items"] + page2["items"]]
    assert len(set(ids)) == 3  # no row appears on two pages

    # Search narrows on permitted metadata (external id / title / file name).
    r = client.get(f"{BASE}/retention/recommendations?search=q-other")
    assert r.json()["total"] == 1

    # Invalid filters are rejected rather than silently returning nothing.
    assert client.get(f"{BASE}/retention/recommendations?sort=weird").status_code == 422
    assert (
        client.get(f"{BASE}/retention/recommendations?severity=nope").status_code == 422
    )
    assert (
        client.get(f"{BASE}/retention/recommendations?review_status=nope").status_code
        == 422
    )


def test_review_queue_severity_and_review_status(
    client: TestClient, test_db: sessionmaker
) -> None:
    aid = _make_asset(test_db, external_id="q-dec", category="hr")
    _activate_policy(client, name="P-q-dec", categories=["hr"], period_days=365)
    assessment = _assess(client, aid)

    before = client.get(f"{BASE}/retention/recommendations").json()["items"][0]
    assert before["review_status"] == "open"
    assert before["decisions_recorded"] == 0

    r = client.post(
        f"{BASE}/retention/assessments/{assessment['id']}/decisions",
        json={
            "decision": "retain",
            "reason": "Keep for operational need",
            "reviewer": "Reviewer",
            "expected_assessed_at": assessment["assessed_at"],
            "expected_policy_version_id": assessment["policy_version_id"],
            "expected_holds_active": 0,
        },
    )
    assert r.status_code == 201, r.text

    after = client.get(f"{BASE}/retention/recommendations?review_status=decided").json()
    assert after["total"] == 1
    item = after["items"][0]
    assert item["review_status"] == "decided"
    assert item["latest_decision"] == "retain"
    assert item["decisions_recorded"] == 1

    assert (
        client.get(f"{BASE}/retention/recommendations?review_status=open").json()["total"]
        == 0
    )


def test_review_queue_institution_isolation(
    client: TestClient, test_db: sessionmaker
) -> None:
    inst1 = _make_institution(test_db, code="Q1")
    inst2 = _make_institution(test_db, code="Q2")
    a1 = _make_asset(test_db, external_id="q-i1", institution_id=inst1)
    a2 = _make_asset(test_db, external_id="q-i2", institution_id=inst2)
    _activate_policy(client, name="P-global", categories=[], period_days=365)
    _assess(client, a1)
    _assess(client, a2)

    r = client.get(f"{BASE}/retention/recommendations?institution_id={inst1}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["asset_id"] == a1


# --------------------------------------------------------------------------
# Human review decisions
# --------------------------------------------------------------------------


def test_decision_validates_reason_and_value(
    client: TestClient, test_db: sessionmaker
) -> None:
    aid = _make_asset(test_db, external_id="dec-val", category="hr")
    _activate_policy(client, name="P-dec-val", categories=["hr"], period_days=365)
    assessment = _assess(client, aid)
    url = f"{BASE}/retention/assessments/{assessment['id']}/decisions"

    # Unknown decision value -> 422 (schema).
    assert (
        client.post(url, json={"decision": "burn", "reason": "x", "reviewer": "R"}).status_code
        == 422
    )
    # Rejection needs a substantive reason.
    short = client.post(
        url, json={"decision": "reject", "reason": "no", "reviewer": "R"}
    )
    assert short.status_code == 422
    # Requesting more information also needs a substantive reason.
    assert (
        client.post(
            url,
            json={"decision": "request_more_information", "reason": "why", "reviewer": "R"},
        ).status_code
        == 422
    )
    # A valid rejection is recorded.
    ok = client.post(
        url,
        json={
            "decision": "reject",
            "reason": "The recommendation contradicts the current legal advice.",
            "reviewer": "Reviewer",
        },
    )
    assert ok.status_code == 201, ok.text
    assert ok.json()["decision"] == "reject"


def test_decision_append_only_one_per_assessment(
    client: TestClient, test_db: sessionmaker
) -> None:
    aid = _make_asset(test_db, external_id="dec-append", category="hr")
    _activate_policy(client, name="P-dec-append", categories=["hr"], period_days=365)
    assessment = _assess(client, aid)
    url = f"{BASE}/retention/assessments/{assessment['id']}/decisions"

    first = client.post(
        url, json={"decision": "retain", "reason": "Keep it", "reviewer": "R1"}
    )
    assert first.status_code == 201, first.text

    second = client.post(
        url, json={"decision": "reject", "reason": "Changed my mind entirely", "reviewer": "R2"}
    )
    assert second.status_code == 409
    assert "never overwritten" in second.json()["detail"]

    # Supersession: re-assess and decide on the new assessment.
    fresh = _assess(client, aid)
    assert fresh["id"] != assessment["id"]
    third = client.post(
        f"{BASE}/retention/assessments/{fresh['id']}/decisions",
        json={"decision": "reject", "reason": "Superseding the earlier decision", "reviewer": "R2"},
    )
    assert third.status_code == 201, third.text

    history = client.get(f"{BASE}/retention/assets/{aid}/decisions").json()
    assert len(history) == 2  # both decisions remain


def test_decision_unique_constraint_blocks_double_insert(
    client: TestClient, test_db: sessionmaker
) -> None:
    aid = _make_asset(test_db, external_id="dec-race", category="hr")
    _activate_policy(client, name="P-dec-race", categories=["hr"], period_days=365)
    assessment = _assess(client, aid)
    client.post(
        f"{BASE}/retention/assessments/{assessment['id']}/decisions",
        json={"decision": "retain", "reason": "Keep it", "reviewer": "R"},
    )

    with test_db() as db:
        db.add(
            models.RetentionDecision(
                assessment_id=assessment["id"],
                asset_id=aid,
                institution_id=None,
                policy_id=None,
                policy_version_id=None,
                recommendation_reviewed="RETAIN",
                decision="reject",
                reason="Direct insert that must fail",
                reviewer="R",
                decided_at=datetime.now(UTC),
            )
        )
        with pytest.raises(IntegrityError):
            db.commit()


def test_decision_stale_assessment_conflict(
    client: TestClient, test_db: sessionmaker
) -> None:
    aid = _make_asset(test_db, external_id="dec-stale", category="hr")
    _activate_policy(client, name="P-dec-stale", categories=["hr"], period_days=365)
    first = _assess(client, aid)

    # A newer assessment appears after the reviewer loaded the page.
    _assess(client, aid)

    r = client.post(
        f"{BASE}/retention/assessments/{first['id']}/decisions",
        json={
            "decision": "retain",
            "reason": "Decide on the version I saw",
            "reviewer": "R",
            "expected_assessed_at": first["assessed_at"],
            "expected_policy_version_id": first["policy_version_id"],
        },
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"].startswith("stale_review_conflict")
    assert _audit_events(test_db, "review.stale_conflict")


def test_decision_stale_policy_version_conflict(
    client: TestClient, test_db: sessionmaker
) -> None:
    aid = _make_asset(test_db, external_id="dec-policy", category="hr")
    policy_id, version1 = _activate_policy(
        client, name="P-dec-policy", categories=["hr"], period_days=365
    )
    assessment = _assess(client, aid)

    # The policy moves on to a new active version after the assessment.
    r = client.post(
        f"{BASE}/retention/policies/{policy_id}/versions",
        json={"applicable_categories": ["hr"], "retention_period_days": 30},
    )
    version2 = r.json()["id"]
    client.post(f"{BASE}/retention/policies/{policy_id}/activate", json={"version_id": version2})

    r = client.post(
        f"{BASE}/retention/assessments/{assessment['id']}/decisions",
        json={
            "decision": "retain",
            "reason": "Decide on the version I saw",
            "reviewer": "R",
            "expected_assessed_at": assessment["assessed_at"],
            "expected_policy_version_id": version1,
        },
    )
    assert r.status_code == 409, r.text
    assert "policy moved to a new version" in r.json()["detail"]


def test_decision_hold_conflict_blocks_approval(
    client: TestClient, test_db: sessionmaker
) -> None:
    past = datetime.now(UTC) - timedelta(days=400)
    aid = _make_asset(test_db, external_id="dec-hold", category="hr", created_at=past)
    _activate_policy(client, name="P-dec-hold", categories=["hr"], period_days=1)
    assessment = _assess(client, aid)
    assert assessment["recommendation"] == "DISPOSAL_REVIEW_REQUIRED"

    r = client.post(f"{BASE}/retention/holds", json={"name": "Legal hold", "asset_id": aid})
    assert r.status_code == 201, r.text

    base = {
        "reason": "Approve for a later authorized workflow",
        "reviewer": "R",
        "expected_assessed_at": assessment["assessed_at"],
        "expected_policy_version_id": assessment["policy_version_id"],
    }
    blocked = client.post(
        f"{BASE}/retention/assessments/{assessment['id']}/decisions",
        json={**base, "decision": "approve_for_later_workflow"},
    )
    assert blocked.status_code == 409, blocked.text
    assert blocked.json()["detail"].startswith("hold_conflict")

    # A non-advancing decision is still allowed while the hold is active.
    retained = client.post(
        f"{BASE}/retention/assessments/{assessment['id']}/decisions",
        json={**base, "decision": "retain"},
    )
    assert retained.status_code == 201, retained.text


def test_decision_hold_stale_token_conflict(
    client: TestClient, test_db: sessionmaker
) -> None:
    aid = _make_asset(test_db, external_id="dec-holdstate", category="hr")
    _activate_policy(client, name="P-dec-holdstate", categories=["hr"], period_days=365)
    assessment = _assess(client, aid)
    client.post(f"{BASE}/retention/holds", json={"name": "New hold", "asset_id": aid})

    r = client.post(
        f"{BASE}/retention/assessments/{assessment['id']}/decisions",
        json={
            "decision": "retain",
            "reason": "Keep it",
            "reviewer": "R",
            "expected_assessed_at": assessment["assessed_at"],
            "expected_policy_version_id": assessment["policy_version_id"],
            "expected_holds_active": 0,  # lies: a hold now exists
        },
    )
    assert r.status_code == 409
    assert "active-hold state changed" in r.json()["detail"]


def test_decision_audit_trail_and_scope(
    client: TestClient, test_db: sessionmaker
) -> None:
    inst1 = _make_institution(test_db, code="D1")
    inst2 = _make_institution(test_db, code="D2")
    aid = _make_asset(test_db, external_id="dec-audit", institution_id=inst1)
    _activate_policy(
        client, name="P-dec-audit", categories=[], institution_id=inst1, period_days=365
    )
    assessment = _assess(client, aid)

    # Cross-institution decision attempt -> 404, nothing recorded.
    r = client.post(
        f"{BASE}/retention/assessments/{assessment['id']}/decisions?institution_id={inst2}",
        json={"decision": "retain", "reason": "Keep it", "reviewer": "R"},
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "assessment_out_of_scope"

    r = client.post(
        f"{BASE}/retention/assessments/{assessment['id']}/decisions?institution_id={inst1}",
        json={"decision": "retain", "reason": "Keep it", "reviewer": "Reviewer A"},
    )
    assert r.status_code == 201, r.text
    decision = r.json()

    events = _audit_events(test_db, "review.decision_created")
    assert len(events) == 1
    event = events[0]
    # Attribution comes from the verified identity, never from a name the
    # request carried: DecisionCreate does not accept a "reviewer" at all.
    assert event.actor == "platform.admin@datadiet.test"
    assert decision["reviewer"] == "Platform Administrator"
    assert event.entity_id == str(decision["id"])
    assert event.payload["decision"] == "retain"
    assert event.payload["assessment_id"] == assessment["id"]
    assert event.payload["institution_id"] == inst1
    # The free-text rationale is not copied into the audit payload.
    assert "reason" not in event.payload


def test_decision_rejection_emits_specific_event(
    client: TestClient, test_db: sessionmaker
) -> None:
    aid = _make_asset(test_db, external_id="dec-rej", category="hr")
    _activate_policy(client, name="P-dec-rej", categories=["hr"], period_days=365)
    assessment = _assess(client, aid)

    r = client.post(
        f"{BASE}/retention/assessments/{assessment['id']}/decisions",
        json={
            "decision": "request_more_information",
            "reason": "The owner and legal basis are missing from the metadata.",
            "reviewer": "R",
        },
    )
    assert r.status_code == 201, r.text
    assert _audit_events(test_db, "review.decision_created")
    assert _audit_events(test_db, "review.information_requested")


def test_decision_unknown_assessment(client: TestClient, test_db: sessionmaker) -> None:
    r = client.post(
        f"{BASE}/retention/assessments/98765/decisions",
        json={"decision": "retain", "reason": "Keep it", "reviewer": "R"},
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "Assessment not found"


def test_production_guard_blocks_governance_writes(
    client: TestClient, test_db: sessionmaker, monkeypatch: pytest.MonkeyPatch
) -> None:
    aid = _make_asset(test_db, external_id="prod-guard", category="hr")
    _activate_policy(client, name="P-prod", categories=["hr"], period_days=365)
    assessment = _assess(client, aid)

    from app.core import config

    settings = config.get_settings()
    monkeypatch.setattr(settings, "environment", "production")
    try:
        r = client.post(
            f"{BASE}/retention/assessments/{assessment['id']}/decisions",
            json={"decision": "retain", "reason": "Keep it", "reviewer": "R"},
        )
        assert r.status_code == 503
    finally:
        monkeypatch.undo()


def test_phase5_endpoints_still_reachable(client: TestClient, test_db: sessionmaker) -> None:
    """Regression guard: Phase 5 surfaces survive the Phase 6 changes."""
    assert client.get(f"{BASE}/classification/rules").status_code == 200
    assert client.get(f"{BASE}/classification/checks").status_code == 200
    aid = _make_asset(test_db, external_id="phase5-ok")
    assert client.get(f"{BASE}/classification/assets/{aid}/quality").status_code == 200
