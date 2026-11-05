"""Phase 7 tests: decision supersession (corrections) and review history.

A correction is never an edit. The original decision row is preserved exactly
as recorded, and the replacement points back at it through
``supersedes_decision_id`` (ADR-0015). Every rule — same asset, same
institution, strictly earlier assessment, no self-reference, no successor yet,
no cycle — is evaluated from stored rows, so a client cannot assert lineage.

Nothing here archives, restores, moves, or deletes a file: recording a
decision executes no operation of any kind.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from conftest import seed_identity_directory
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.schemas.retention import DecisionCreate
from app.db import models, session
from app.services import retention as retention_service

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
    seed_identity_directory(factory)
    yield factory
    engine.dispose()


# --------------------------------------------------------------------------- #
# Fixtures for a reviewable asset
# --------------------------------------------------------------------------- #


def _make_institution(test_db: sessionmaker[Session], *, code: str) -> int:
    with test_db() as db:
        row = models.Institution(code=code, name=f"Institution {code}")
        db.add(row)
        db.commit()
        db.refresh(row)
        return row.id


def _make_asset(test_db: sessionmaker[Session], *, external_id: str, institution_id=None) -> int:
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
            category="hr",
            sensitivity="internal",
            lifecycle_status="active",
            created_at=datetime.now(UTC),
        )
        db.add(asset)
        db.commit()
        db.refresh(asset)
        return asset.id


def _activate_policy(
    client: TestClient, *, name: str, institution_id: int | None = None
) -> tuple[int, int]:
    r = client.post(
        f"{BASE}/retention/policies",
        json={
            "name": name,
            "institution_id": institution_id,
            "applicable_categories": ["hr"],
        },
    )
    assert r.status_code == 201, r.text
    policy_id = r.json()["id"]
    r = client.post(
        f"{BASE}/retention/policies/{policy_id}/versions",
        json={
            "applicable_categories": ["hr"],
            "retention_period_days": 365,
            "retention_trigger": "created_at",
        },
    )
    assert r.status_code == 201, r.text
    version_id = r.json()["id"]
    r = client.post(
        f"{BASE}/retention/policies/{policy_id}/activate", json={"version_id": version_id}
    )
    assert r.status_code == 200, r.text
    return policy_id, version_id


def _assess(client: TestClient, asset_id: int) -> dict:
    r = client.post(f"{BASE}/retention/assess/{asset_id}")
    assert r.status_code == 200, r.text
    return r.json()


def _decide(
    client: TestClient,
    assessment_id: int,
    *,
    decision: str = "retain",
    reason: str = "Keep it for operational use",
    supersedes: int | None = None,
    institution_id: int | None = None,
) -> Any:
    payload: dict[str, object] = {"decision": decision, "reason": reason}
    if supersedes is not None:
        payload["supersedes_decision_id"] = supersedes
    url = f"{BASE}/retention/assessments/{assessment_id}/decisions"
    if institution_id is not None:
        url += f"?institution_id={institution_id}"
    return client.post(url, json=payload)


def _history(client: TestClient, asset_id: int, *, institution_id: int | None = None) -> list[dict]:
    url = f"{BASE}/retention/assets/{asset_id}/decisions"
    if institution_id is not None:
        url += f"?institution_id={institution_id}"
    response = client.get(url)
    assert response.status_code == 200, response.text
    return response.json()


def _audit(test_db: sessionmaker[Session], event_type: str) -> list[models.AuditEvent]:
    with test_db() as db:
        return list(
            db.execute(
                select(models.AuditEvent).where(models.AuditEvent.event_type == event_type)
            )
            .scalars()
            .all()
        )


def _build_chain(client: TestClient, asset_id: int, count: int) -> list[dict]:
    """Assess and decide ``count`` times, returning ``[{assessment, decision}]``."""
    steps: list[dict] = []
    previous: int | None = None
    for _ in range(count):
        assessment = _assess(client, asset_id)
        response = _decide(client, assessment["id"], supersedes=previous)
        assert response.status_code == 201, response.text
        decision = response.json()
        steps.append({"assessment": assessment, "decision": decision})
        previous = decision["id"]
    return steps


# --------------------------------------------------------------------------- #
# Happy path
# --------------------------------------------------------------------------- #


def test_supersession_records_a_correction_and_preserves_the_original(
    client: TestClient, test_db: sessionmaker
) -> None:
    asset_id = _make_asset(test_db, external_id="sup-1")
    _activate_policy(client, name="P-sup-1")

    first_assessment = _assess(client, asset_id)
    original = _decide(client, first_assessment["id"], decision="retain", reason="Original call")
    assert original.status_code == 201, original.text
    original_body = original.json()

    second_assessment = _assess(client, asset_id)
    correction = _decide(
        client,
        second_assessment["id"],
        decision="reject",
        reason="Policy was misread; the record must not be retained",
        supersedes=original_body["id"],
    )
    assert correction.status_code == 201, correction.text
    corrected = correction.json()

    # The replacement points back at the original...
    assert corrected["supersedes_decision_id"] == original_body["id"]
    assert corrected["is_superseded"] is False
    assert corrected["superseded_by_decision_id"] is None

    # ...the original still exists, byte-for-byte as recorded, and is annotated
    # as superseded by a derived inverse lookup rather than a stored column.
    history = _history(client, asset_id)
    assert len(history) == 2
    by_id = {row["id"]: row for row in history}
    kept = by_id[original_body["id"]]
    assert kept["decision"] == "retain"
    assert kept["reason"] == original_body["reason"]
    assert kept["decided_at"] == original_body["decided_at"]
    assert kept["is_superseded"] is True
    assert kept["superseded_by_decision_id"] == corrected["id"]

    # Newest first, so the review history reads chronologically backwards.
    assert [row["id"] for row in history] == [corrected["id"], original_body["id"]]

    # The correction is audited with its linkage and the actor's identity.
    events = _audit(test_db, "review.decision_superseded")
    assert len(events) == 1
    assert events[0].actor == "platform.admin@datadiet.test"
    assert events[0].payload["supersedes_decision_id"] == original_body["id"]
    assert events[0].payload["superseded_assessment_id"] == first_assessment["id"]
    # The free-text rationale stays on the decision row, not in the audit log.
    assert "reason" not in events[0].payload
    assert events[0].payload["reason_length"] == len(
        "Policy was misread; the record must not be retained"
    )


def test_effective_decision_skips_superseded_entries(
    client: TestClient, test_db: sessionmaker
) -> None:
    asset_id = _make_asset(test_db, external_id="sup-effective")
    _activate_policy(client, name="P-sup-effective")
    steps = _build_chain(client, asset_id, 3)
    ids = [step["decision"]["id"] for step in steps]

    view = client.get(f"{BASE}/governance/assets/{asset_id}")
    assert view.status_code == 200, view.text
    assert view.json()["effective_decision_id"] == ids[-1]

    # Every link in the chain survives: nothing was deleted or rewritten, and
    # each earlier entry is annotated as superseded by its successor.
    history = {row["id"]: row for row in _history(client, asset_id)}
    assert set(history) == set(ids)
    assert history[ids[-1]]["is_superseded"] is False
    assert all(history[decision_id]["is_superseded"] for decision_id in ids[:-1])
    assert history[ids[0]]["superseded_by_decision_id"] == ids[1]
    assert history[ids[1]]["superseded_by_decision_id"] == ids[2]
    assert history[ids[2]]["superseded_by_decision_id"] is None


def test_supersession_candidates_offer_only_real_choices(
    client: TestClient, test_db: sessionmaker
) -> None:
    asset_id = _make_asset(test_db, external_id="sup-candidates")
    _activate_policy(client, name="P-sup-candidates")

    first = _assess(client, asset_id)
    assert (
        client.get(f"{BASE}/retention/decisions/supersession/source?assessment_id={first['id']}").json()
        == []
    )
    d1 = _decide(client, first["id"]).json()

    second = _assess(client, asset_id)
    candidates = client.get(
        f"{BASE}/retention/decisions/supersession/source?assessment_id={second['id']}"
    ).json()
    assert [c["id"] for c in candidates] == [d1["id"]]

    d2 = _decide(client, second["id"], supersedes=d1["id"]).json()

    third = _assess(client, asset_id)
    candidates = client.get(
        f"{BASE}/retention/decisions/supersession/source?assessment_id={third['id']}"
    ).json()
    # d1 is already superseded, so only the current effective decision is offered.
    assert [c["id"] for c in candidates] == [d2["id"]]

    missing = client.get(f"{BASE}/retention/decisions/supersession/source?assessment_id=999999")
    assert missing.status_code == 404


def test_a_correction_needs_a_substantive_reason(
    client: TestClient, test_db: sessionmaker
) -> None:
    asset_id = _make_asset(test_db, external_id="sup-reason")
    _activate_policy(client, name="P-sup-reason")
    first = _assess(client, asset_id)
    d1 = _decide(client, first["id"]).json()

    second = _assess(client, asset_id)
    too_short = _decide(client, second["id"], reason="oops", supersedes=d1["id"])
    assert too_short.status_code == 422
    assert "supersedes" in too_short.text


# --------------------------------------------------------------------------- #
# Rejections: 404 never discloses another tenant, 409 never rewrites history
# --------------------------------------------------------------------------- #


def test_superseding_a_missing_decision_is_404(
    client: TestClient, test_db: sessionmaker
) -> None:
    asset_id = _make_asset(test_db, external_id="sup-missing")
    _activate_policy(client, name="P-sup-missing")
    assessment = _assess(client, asset_id)
    response = _decide(client, assessment["id"], supersedes=424242)
    assert response.status_code == 404
    assert response.json()["detail"] == "The decision being superseded does not exist."


def test_superseding_across_institutions_is_404(
    client: TestClient, test_db: sessionmaker
) -> None:
    """Tenant boundary: the caller must not learn that the decision exists."""
    tenant_a = _make_institution(test_db, code="SUPA")
    tenant_b = _make_institution(test_db, code="SUPB")
    _activate_policy(client, name="P-sup-a", institution_id=tenant_a)
    _activate_policy(client, name="P-sup-b", institution_id=tenant_b)

    asset_a = _make_asset(test_db, external_id="sup-asset-a", institution_id=tenant_a)
    asset_b = _make_asset(test_db, external_id="sup-asset-b", institution_id=tenant_b)

    assessment_a = _assess(client, asset_a)
    d_a = _decide(client, assessment_a["id"], institution_id=tenant_a)
    assert d_a.status_code == 201, d_a.text

    assessment_b = _assess(client, asset_b)
    response = _decide(
        client,
        assessment_b["id"],
        reason="Cross-tenant correction attempt is refused",
        supersedes=d_a.json()["id"],
        institution_id=tenant_b,
    )
    assert response.status_code == 404
    assert response.json()["detail"] == (
        "The decision being superseded belongs to a different institution."
    )


def test_superseding_a_decision_of_a_different_asset_is_409(
    client: TestClient, test_db: sessionmaker
) -> None:
    _activate_policy(client, name="P-sup-lineage")
    asset_one = _make_asset(test_db, external_id="sup-line-1")
    asset_two = _make_asset(test_db, external_id="sup-line-2")

    first = _assess(client, asset_one)
    d1 = _decide(client, first["id"]).json()

    second = _assess(client, asset_two)
    response = _decide(client, second["id"], supersedes=d1["id"])
    assert response.status_code == 409
    assert "same asset" in response.json()["detail"]


def test_a_decision_cannot_supersede_itself(
    client: TestClient, test_db: sessionmaker
) -> None:
    asset_id = _make_asset(test_db, external_id="sup-self")
    _activate_policy(client, name="P-sup-self")
    assessment = _assess(client, asset_id)
    d1 = _decide(client, assessment["id"]).json()

    response = _decide(client, assessment["id"], supersedes=d1["id"])
    assert response.status_code == 409
    assert "cannot supersede the decision recorded on its own assessment" in (
        response.json()["detail"]
    )


def test_a_chain_only_moves_forward_in_time(
    client: TestClient, test_db: sessionmaker
) -> None:
    """Deciding an older assessment cannot supersede a newer decision."""
    asset_id = _make_asset(test_db, external_id="sup-backwards")
    _activate_policy(client, name="P-sup-backwards")

    older = _assess(client, asset_id)
    newer = _assess(client, asset_id)
    d_new = _decide(client, newer["id"]).json()

    response = _decide(client, older["id"], supersedes=d_new["id"])
    assert response.status_code == 409
    assert "earlier assessment" in response.json()["detail"]


def test_a_decision_can_be_superseded_only_once(
    client: TestClient, test_db: sessionmaker
) -> None:
    asset_id = _make_asset(test_db, external_id="sup-once")
    _activate_policy(client, name="P-sup-once")
    first = _assess(client, asset_id)
    d1 = _decide(client, first["id"]).json()

    second = _assess(client, asset_id)
    assert _decide(client, second["id"], supersedes=d1["id"]).status_code == 201

    third = _assess(client, asset_id)
    response = _decide(
        client, third["id"], reason="A second correction of the same decision", supersedes=d1["id"]
    )
    assert response.status_code == 409
    assert "already been superseded" in response.json()["detail"]


def test_concurrent_supersession_loses_cleanly(
    client: TestClient, test_db: sessionmaker, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two corrections race for one target; the database decides, both are told.

    The pre-insert validation is bypassed here to reproduce the race the unique
    index ``uq_retention_decisions_supersedes`` exists to catch.
    """
    asset_id = _make_asset(test_db, external_id="sup-race")
    _activate_policy(client, name="P-sup-race")
    first = _assess(client, asset_id)
    d1 = _decide(client, first["id"]).json()

    second = _assess(client, asset_id)
    third = _assess(client, asset_id)

    monkeypatch.setattr(
        retention_service,
        "validate_supersession_target",
        lambda db, *, target_id, assessment: db.get(models.RetentionDecision, target_id),
    )

    assert _decide(client, second["id"], supersedes=d1["id"]).status_code == 201
    raced = _decide(client, third["id"], supersedes=d1["id"])
    assert raced.status_code == 409
    assert "concurrent" in raced.json()["detail"]

    # The losing submission left nothing behind: one successor, one history row.
    history = _history(client, asset_id)
    assert len(history) == 2
    assert sum(1 for row in history if row["supersedes_decision_id"] == d1["id"]) == 1


def test_the_database_itself_refuses_a_second_successor(
    client: TestClient, test_db: sessionmaker
) -> None:
    """One decision may be replaced once, and storage — not just code — says so.

    This is the structural reason the history can never fork, race, or loop:
    a second row pointing at the same decision is refused even when every
    application-level check is bypassed.
    """
    asset_id = _make_asset(test_db, external_id="sup-loop")
    _activate_policy(client, name="P-sup-loop")
    steps = _build_chain(client, asset_id, 2)
    first_id = steps[0]["decision"]["id"]
    second_id = steps[1]["decision"]["id"]

    third = _assess(client, asset_id)
    with test_db() as db:
        duplicate = models.RetentionDecision(
            assessment_id=third["id"],
            asset_id=asset_id,
            institution_id=None,
            policy_id=None,
            policy_version_id=None,
            recommendation_reviewed="RETAIN",
            decision="retain",
            reason="A second, illegitimate replacement",
            reviewer="Bypass",
            decided_at=datetime.now(UTC),
            supersedes_decision_id=first_id,
        )
        db.add(duplicate)
        with pytest.raises(IntegrityError):
            db.flush()
        db.rollback()

    # The history is untouched: still the two rows the API recorded.
    history = _history(client, asset_id)
    assert [row["id"] for row in history] == [second_id, first_id]
    assert history[0]["supersedes_decision_id"] == first_id
    assert history[1]["supersedes_decision_id"] is None


def test_a_corrupt_chain_walk_is_refused_instead_of_extended(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The remaining defence for a database *without* that index.

    Reproduces the walk over a bent history — 3 replaces 2, which replaces 1,
    which replaces 2 again — and asserts it is reported as corruption rather
    than traversed without end. A chain that reaches its leaf walks happily.
    """
    edges = {3: 2, 2: 1, 1: 2}  # 1 -> 2 -> 1 is the closed loop
    monkeypatch.setattr(retention_service, "_supersedes_of", lambda db, i: edges.get(i))
    with pytest.raises(ValueError, match="supersession_cycle"):
        retention_service._reject_supersession_cycle(None, SimpleNamespace(id=3))

    linear = {3: 2, 2: 1, 1: None}
    monkeypatch.setattr(retention_service, "_supersedes_of", lambda db, i: linear.get(i))
    retention_service._reject_supersession_cycle(None, SimpleNamespace(id=3))


def test_an_oversized_chain_is_treated_as_corrupt(
    client: TestClient, test_db: sessionmaker, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The chain walk is bounded, so corruption cannot make it spin."""
    asset_id = _make_asset(test_db, external_id="sup-long")
    _activate_policy(client, name="P-sup-long")
    steps = _build_chain(client, asset_id, 3)
    target = steps[-1]["decision"]["id"]

    # Any chain with more than one ancestor is longer than this limit allows.
    monkeypatch.setattr(retention_service, "SUPERSESSION_CHAIN_LIMIT", 1)

    fourth = _assess(client, asset_id)
    response = _decide(
        client, fourth["id"], reason="Bounded walk refuses to keep going", supersedes=target
    )
    assert response.status_code == 409
    assert "cycle" in response.json()["detail"]


# --------------------------------------------------------------------------- #
# Schema / model guarantees
# --------------------------------------------------------------------------- #


def test_the_supersession_column_is_one_way_and_unique() -> None:
    """Only a successor id is stored; the inverse is derived, never denormalised."""
    columns = models.RetentionDecision.__table__.columns
    assert "supersedes_decision_id" in columns
    assert "superseded_by_decision_id" not in columns

    uniques = {
        tuple(constraint.columns.keys())
        for constraint in models.RetentionDecision.__table__.constraints
        if constraint.__class__.__name__ == "UniqueConstraint"
    }
    assert ("supersedes_decision_id",) in uniques

    fk = next(
        fk
        for fk in models.RetentionDecision.__table__.foreign_keys
        if fk.parent.name == "supersedes_decision_id"
    )
    assert fk.ondelete == "RESTRICT", "history rows are never removable by a cascade"


def test_decision_create_rejects_a_non_integer_target() -> None:
    with pytest.raises(ValueError):  # pydantic wraps it in ValidationError
        DecisionCreate(decision="retain", reason="Fine", supersedes_decision_id=0)
