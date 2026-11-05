"""Retention and assessment service."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Any

from fastapi import HTTPException
from fastapi import status as http_status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.schemas.retention import (
    Assessment,
    AssessmentFinding,
    Decision,
    DecisionCreate,
    HoldCreate,
    HoldRelease,
    PolicyCreate,
    PolicyUpdate,
    PolicyVersionCreate,
)
from app.db.models import (
    InventoryRecord,
    PolicyVersion,
    RetentionAssessment,
    RetentionDecision,
    RetentionHold,
    RetentionPolicy,
)
from app.services.audit import record_event

#: Bump when assessment logic changes; stored on every assessment row so
#: historic results stay interpretable.
RULE_SET = "retention-assessment-v2"

#: Recommendation outcomes the assessment engine can return. Exposed so the
#: review queue can validate its `recommendation` filter instead of silently
#: returning an empty page for a typo.
RECOMMENDATION_VALUES: tuple[str, ...] = (
    "RETAIN",
    "ARCHIVE_RECOMMENDED",
    "REVIEW_REQUIRED",
    "DISPOSAL_REVIEW_REQUIRED",
    "BLOCKED_BY_HOLD",
    "NO_APPLICABLE_POLICY",
)

#: Supported retention triggers and the asset field each one reads.
#: ``last_reviewed`` is a date-only column; the others are timestamps.
TRIGGER_FIELDS: dict[str, tuple[str, str]] = {
    "created_at": ("created_at", "asset creation timestamp (ingest time)"),
    "modified_at": ("source_modified_at", "last modification timestamp reported by the source"),
    "source_created_at": ("source_created_at", "creation timestamp reported by the source"),
    "last_reviewed": ("last_reviewed", "date of the last human review (date only)"),
}


def _now() -> datetime:
    return datetime.now(UTC)


def _utc_today() -> date:
    return datetime.now(UTC).date()


def _as_naive_utc(value: datetime | None) -> datetime | None:
    """Normalize a datetime to naive UTC.

    Timezone-aware values are converted to UTC and stripped; naive values are
    treated as UTC (the database stores naive UTC timestamps).
    """
    if value is None:
        return None
    if value.tzinfo is not None:
        return value.astimezone(UTC).replace(tzinfo=None)
    return value


def resolve_trigger_date(asset: InventoryRecord, trigger: str | None) -> tuple[date | None, str]:
    """Return ``(trigger_date, note)`` for an asset.

    ``trigger_date`` is ``None`` when the trigger is unsupported or the source
    field is missing; a missing date never implies disposal.
    """
    if trigger not in TRIGGER_FIELDS:
        return None, f"unsupported retention trigger {trigger!r}"
    field, label = TRIGGER_FIELDS[trigger]
    raw: datetime | date | None = getattr(asset, field, None)
    if raw is None:
        return None, f"{label} is not recorded for this asset"
    if isinstance(raw, datetime):
        naive = _as_naive_utc(raw)
        assert naive is not None
        return naive.date(), label
    return raw, label


def compute_retention_deadline(trigger_date: date, period_days: int) -> date:
    """Retention deadline = trigger date + period, in calendar days (UTC).

    The asset remains within its retention period through the end of the
    deadline day; the period is considered expired the day after.
    """
    return trigger_date + timedelta(days=period_days)


def create_policy(
    db: Session, data: PolicyCreate, created_by: str | None = "system"
) -> RetentionPolicy:
    policy = RetentionPolicy(
        institution_id=data.institution_id,
        name=data.name,
        description=data.description,
        applicable_categories=data.applicable_categories,
        retention_trigger=data.retention_trigger,
        retention_period_days=data.retention_period_days,
        recommended_action=data.recommended_action,
        scope_description=data.scope_description,
        status="draft",
        version="1",
        created_by=created_by or "system",
    )
    db.add(policy)
    db.commit()
    db.refresh(policy)
    return policy


def list_policies(
    db: Session,
    *,
    page: int = 1,
    per_page: int = 20,
    status: str | None = None,
    institution_id: int | None = None,
) -> tuple[Sequence[RetentionPolicy], int]:
    q = select(RetentionPolicy)
    cq = select(func.count()).select_from(RetentionPolicy)
    if institution_id is not None:
        q = q.where(RetentionPolicy.institution_id == institution_id)
        cq = cq.where(RetentionPolicy.institution_id == institution_id)
    if status is not None:
        q = q.where(RetentionPolicy.status == status)
        cq = cq.where(RetentionPolicy.status == status)

    total = db.execute(cq).scalar() or 0
    items = (
        db.execute(
            q.order_by(RetentionPolicy.id.desc())
            .offset((page - 1) * per_page)
            .limit(per_page)
        )
        .scalars()
        .all()
    )
    return items, total


def get_policy(db: Session, policy_id: int) -> RetentionPolicy | None:
    return db.get(RetentionPolicy, policy_id)


def create_policy_version(
    db: Session, policy: RetentionPolicy, data: PolicyVersionCreate
) -> PolicyVersion:
    """Append a new immutable version to a policy.

    Version numbers are append-only; the max existing number is incremented so
    a version number is never reused.
    """
    max_v = (
        db.execute(
            select(func.max(PolicyVersion.version_number)).where(
                PolicyVersion.policy_id == policy.id
            )
        ).scalar()
        or 0
    )
    pv = PolicyVersion(
        policy_id=policy.id,
        version_number=max_v + 1,
        status=data.status,
        description=data.description,
        applicable_categories=data.applicable_categories,
        retention_period_days=data.retention_period_days,
        retention_trigger=data.retention_trigger,
        conditions=data.conditions,
        recommended_action=data.recommended_action,
        effective_from=data.effective_from,
        effective_to=data.effective_to,
        created_by=policy.created_by,
    )
    db.add(pv)
    db.commit()
    db.refresh(pv)
    return pv


def activate_policy_version(
    db: Session, policy: RetentionPolicy, version: PolicyVersion
) -> RetentionPolicy:
    """Make a version the policy's current active version.

    State transitions enforced:
    - the version must belong to the policy and be ``draft`` or ``approved``;
      activating a retired or already-active version is a conflict.
    - the policy must not be ``retired`` or ``inactive``.
    """
    if policy.status in ("retired", "inactive"):
        raise ValueError("policy_not_activatable")
    if version.status not in ("draft", "approved"):
        raise ValueError("version_not_activatable")

    version.status = "active"
    version.approved_at = _now()
    policy.status = "active"
    policy.current_version_id = version.id
    policy.version = str(version.version_number)
    db.add(version)
    db.add(policy)
    db.commit()
    db.refresh(policy)
    return policy


def update_policy(db: Session, policy: RetentionPolicy, data: PolicyUpdate) -> RetentionPolicy:
    if data.description is not None:
        policy.description = data.description
    if data.applicable_categories is not None:
        policy.applicable_categories = data.applicable_categories
    if data.retention_period_days is not None:
        policy.retention_period_days = data.retention_period_days
    if data.retention_trigger is not None:
        policy.retention_trigger = data.retention_trigger
    if data.recommended_action is not None:
        policy.recommended_action = data.recommended_action
    if data.status is not None:
        policy.status = data.status
    if data.scope_description is not None:
        policy.scope_description = data.scope_description
    if data.current_version_id is not None:
        policy.current_version_id = data.current_version_id
    db.add(policy)
    db.commit()
    db.refresh(policy)
    return policy


def create_hold(
    db: Session, data: HoldCreate, created_by: str | None = "system"
) -> RetentionHold:
    hold = RetentionHold(
        institution_id=data.institution_id,
        asset_id=data.asset_id,
        asset_scope=data.asset_scope,
        name=data.name,
        hold_type=data.hold_type,
        legal_basis=data.legal_basis,
        scope=data.scope or [],
        status="active",
        created_by=created_by or "system",
    )
    db.add(hold)
    db.commit()
    db.refresh(hold)
    return hold


def list_holds(
    db: Session,
    *,
    page: int = 1,
    per_page: int = 20,
    status: str | None = None,
    institution_id: int | None = None,
) -> tuple[Sequence[RetentionHold], int]:
    q = select(RetentionHold)
    cq = select(func.count()).select_from(RetentionHold)
    if institution_id is not None:
        q = q.where(RetentionHold.institution_id == institution_id)
        cq = cq.where(RetentionHold.institution_id == institution_id)
    if status is not None:
        q = q.where(RetentionHold.status == status)
        cq = cq.where(RetentionHold.status == status)

    total = db.execute(cq).scalar() or 0
    items = (
        db.execute(
            q.order_by(RetentionHold.id.desc())
            .offset((page - 1) * per_page)
            .limit(per_page)
        )
        .scalars()
        .all()
    )
    return items, total


def get_hold(db: Session, hold_id: int) -> RetentionHold | None:
    return db.get(RetentionHold, hold_id)


def release_hold(
    db: Session, hold: RetentionHold, data: HoldRelease, released_by: str | None = "system"
) -> RetentionHold:
    hold.status = "released"
    hold.released_by = released_by or "system"
    hold.released_at = _now()
    hold.release_reason = data.release_reason
    db.add(hold)
    db.commit()
    db.refresh(hold)
    return hold


def count_active_holds_for_asset(
    db: Session, asset_id: int, institution_id: int | None = None
) -> int:
    q = select(func.count()).select_from(RetentionHold).where(
        RetentionHold.status == "active",
        or_(RetentionHold.asset_id == asset_id, RetentionHold.asset_id.is_(None)),
    )
    if institution_id is not None:
        q = q.where(RetentionHold.institution_id == institution_id)
    return int(db.execute(q).scalar() or 0)


def _effective_categories(
    policy: RetentionPolicy, version: PolicyVersion | None
) -> list[str] | None:
    """Categories from the selected version, else the policy row."""
    if version is not None and version.applicable_categories is not None:
        return version.applicable_categories
    return policy.applicable_categories


def _policy_matches_institution(policy: RetentionPolicy, asset: InventoryRecord) -> bool:
    """A policy applies to an institution, or to all when institution_id is NULL."""
    if policy.institution_id is None:
        return True
    return policy.institution_id == asset.institution_id


def _policy_matches_category(
    policy: RetentionPolicy, version: PolicyVersion | None, asset: InventoryRecord
) -> bool:
    """An empty category list is a wildcard; an uncategorized asset matches
    only wildcard policies (never a policy that names specific categories)."""
    cats = _effective_categories(policy, version) or []
    if not cats:
        return True
    return asset.category is not None and asset.category in cats


def select_policy(
    db: Session, asset: InventoryRecord
) -> tuple[RetentionPolicy | None, PolicyVersion | None, list[AssessmentFinding]]:
    """Pick the single applicable active policy for an asset.

    Only policies with ``status == "active"`` and an activated current version
    are eligible — drafts are never applied. There is no fallback to an
    unrelated category or institution: with no valid match the caller gets
    ``NO_APPLICABLE_POLICY``.

    Precedence when several policies match (deterministic, most specific first):

    1. institution-specific beats institution-wide (NULL institution_id);
    2. a policy naming the asset's category beats a category wildcard;
    3. ties break on the highest policy id (most recently created).
    """
    findings: list[AssessmentFinding] = []
    candidates = db.execute(
        select(RetentionPolicy).where(RetentionPolicy.status == "active")
    ).scalars().all()

    eligible: list[tuple[tuple[int, int, int], RetentionPolicy, PolicyVersion]] = []
    skipped_no_version: list[RetentionPolicy] = []
    for policy in candidates:
        if not _policy_matches_institution(policy, asset):
            continue
        version = (
            db.get(PolicyVersion, policy.current_version_id) if policy.current_version_id else None
        )
        if version is None or version.status != "active":
            skipped_no_version.append(policy)
            continue
        if not _policy_matches_category(policy, version, asset):
            continue
        institution_score = 1 if policy.institution_id is not None else 0
        category_score = 0 if not (_effective_categories(policy, version) or []) else 1
        eligible.append(((institution_score, category_score, policy.id), policy, version))

    for policy in skipped_no_version:
        findings.append(
            AssessmentFinding(
                code="policy_version_not_activated",
                severity="medium",
                message=(
                    f"Active policy '{policy.name}' has no activated current version "
                    "and was not applied."
                ),
                evidence={"policy_id": policy.id, "current_version_id": policy.current_version_id},
            )
        )

    if not eligible:
        return None, None, findings

    eligible.sort(key=lambda item: item[0], reverse=True)
    _, best_policy, best_version = eligible[0]

    if len(eligible) > 1:
        findings.append(
            AssessmentFinding(
                code="policy_precedence_applied",
                severity="informational",
                message=(
                    f"{len(eligible)} active policies matched; the most specific was "
                    f"selected (institution-specific beats institution-wide, a named "
                    f"category beats a wildcard, ties break on the highest policy id)."
                ),
                evidence={
                    "selected_policy_id": best_policy.id,
                    "considered_policy_ids": [p.id for _, p, _ in eligible],
                },
            )
        )
    return best_policy, best_version, findings


def _store_assessment(db: Session, assessment: Assessment) -> RetentionAssessment:
    ra = RetentionAssessment(
        asset_id=assessment.asset_id,
        policy_id=assessment.policy_id,
        policy_version_id=assessment.policy_version_id,
        policy_version_number=assessment.policy_version_number,
        rule_set=assessment.rule_set,
        assessed_at=assessment.assessed_at,
        recommendation=assessment.recommendation,
        rationale=assessment.rationale,
        findings=[f.model_dump() for f in assessment.findings],
        holds_active=assessment.holds_active,
        unresolved_conditions=assessment.unresolved_conditions,
        institution_id=assessment.institution_id,
        trigger_date=assessment.trigger_date,
        retention_period_days=assessment.retention_period_days,
        retention_deadline=assessment.retention_deadline,
    )
    db.add(ra)
    db.commit()
    db.refresh(ra)
    assessment.id = ra.id
    # The response must report exactly what was persisted. MySQL DATETIME has
    # whole-second precision, so returning the in-memory microsecond timestamp
    # would never round-trip through the decision endpoint's optimistic
    # concurrency check (``expected_assessed_at``): every submit would be
    # refused as ``stale_review_conflict`` even though nothing changed. Copying
    # the refreshed value keeps the response and the stored row identical on
    # every backend, not just SQLite.
    assessment.assessed_at = ra.assessed_at
    return ra


def assess_asset(db: Session, asset_id: int, institution_id: int | None = None) -> Assessment:
    asset = db.get(InventoryRecord, asset_id)
    if not asset:
        raise ValueError("asset_not_found")
    if institution_id is not None and asset.institution_id != institution_id:
        raise ValueError("asset_out_of_scope")

    findings: list[AssessmentFinding] = []
    holds_active = count_active_holds_for_asset(db, asset_id, institution_id)
    policy, version, selection_findings = select_policy(db, asset)
    findings.extend(selection_findings)

    if asset.sensitivity == "unknown":
        findings.append(
            AssessmentFinding(
                code="sensitivity_unassessed",
                severity="high",
                message="Sensitivity is unassessed; cannot assume eligibility for disposal.",
                evidence={"sensitivity": asset.sensitivity},
            )
        )

    if holds_active > 0:
        findings.append(
            AssessmentFinding(
                code="hold_active",
                severity="blocked",
                message="Active retention hold blocks disposal recommendations.",
                evidence={"holds_active": holds_active},
            )
        )

    def build(
        recommendation: str,
        rationale: str,
        unresolved: list[str],
        *,
        trigger_date: date | None = None,
        period_days: int | None = None,
        deadline: date | None = None,
    ) -> Assessment:
        return Assessment(
            asset_id=asset_id,
            policy_id=policy.id if policy else None,
            policy_version_id=version.id if version else None,
            policy_version_number=version.version_number if version else None,
            rule_set=RULE_SET,
            assessed_at=_now(),
            recommendation=recommendation,  # type: ignore[arg-type]
            rationale=rationale,
            findings=findings,
            holds_active=holds_active,
            unresolved_conditions=unresolved,
            institution_id=asset.institution_id,
            trigger_date=trigger_date,
            retention_period_days=period_days,
            retention_deadline=deadline,
        )

    # 1. An active hold overrides every other consideration.
    if holds_active > 0:
        assessment = build(
            "BLOCKED_BY_HOLD",
            "Active retention hold blocks disposal recommendations. "
            "No disposal action is possible while the hold is active.",
            ["active_hold"],
        )
        _store_assessment(db, assessment)
        return assessment

    # 2. No eligible policy: never imply disposal.
    if policy is None:
        findings.append(
            AssessmentFinding(
                code="no_applicable_policy",
                severity="medium",
                message=(
                    "No active policy applies to this asset's institution and category; "
                    "human review required."
                ),
                evidence={"policy": "none", "asset_category": asset.category},
            )
        )
        assessment = build(
            "NO_APPLICABLE_POLICY",
            "No applicable active policy; a missing policy never implies disposal. "
            "Human review required.",
            ["no_active_policy"],
        )
        _store_assessment(db, assessment)
        return assessment

    # 3. Retention trigger and deadline. The selected version is the immutable
    #    snapshot that governs; the policy row is only a denormalized fallback
    #    for versions that leave these fields unset.
    trigger = (
        version.retention_trigger
        if version and version.retention_trigger
        else policy.retention_trigger
    )
    period_days = (
        version.retention_period_days
        if version and version.retention_period_days is not None
        else policy.retention_period_days
    )
    trigger_date, trigger_note = resolve_trigger_date(asset, trigger)

    if period_days is None:
        findings.append(
            AssessmentFinding(
                code="retention_period_not_configured",
                severity="medium",
                message="The selected policy version has no retention period configured.",
                evidence={
                    "policy_id": policy.id,
                    "policy_version_id": version.id if version else None,
                },
            )
        )
        assessment = build(
            "REVIEW_REQUIRED",
            "The applicable policy has no retention period, so no deadline can be "
            "calculated. Insufficient metadata never implies disposal.",
            ["retention_period_missing"],
        )
        _store_assessment(db, assessment)
        return assessment

    if trigger_date is None:
        findings.append(
            AssessmentFinding(
                code="retention_trigger_date_missing",
                severity="medium",
                message=f"Retention deadline cannot be calculated: {trigger_note}.",
                evidence={
                    "retention_trigger": trigger,
                    "retention_period_days": period_days,
                },
            )
        )
        assessment = build(
            "REVIEW_REQUIRED",
            "The retention trigger date is unavailable, so no deadline can be "
            "calculated. Insufficient metadata never implies disposal.",
            ["retention_trigger_date_missing"],
        )
        _store_assessment(db, assessment)
        return assessment

    deadline = compute_retention_deadline(trigger_date, period_days)
    today = _utc_today()
    days_remaining = (deadline - today).days

    findings.append(
        AssessmentFinding(
            code="retention_deadline_calculated",
            severity="informational",
            message=(
                f"Retention runs from {trigger_date.isoformat()} for {period_days} days "
                f"until {deadline.isoformat()}."
            ),
            evidence={
                "retention_trigger": policy.retention_trigger,
                "trigger_date": trigger_date.isoformat(),
                "retention_period_days": period_days,
                "retention_deadline": deadline.isoformat(),
                "days_remaining": days_remaining,
                "policy_id": policy.id,
                "policy_version_id": version.id if version else None,
                "policy_version_number": version.version_number if version else None,
            },
        )
    )

    if days_remaining >= 0:
        assessment = build(
            "RETAIN",
            f"The retention period runs until {deadline.isoformat()} "
            f"({days_remaining} day(s) remaining); the record must be retained.",
            [],
            trigger_date=trigger_date,
            period_days=period_days,
            deadline=deadline,
        )
        _store_assessment(db, assessment)
        return assessment

    assessment = build(
        "DISPOSAL_REVIEW_REQUIRED",
        f"The retention period expired on {deadline.isoformat()} "
        f"{-days_remaining} day(s) ago. Expiry requires human review; it does not "
        "authorize disposal, and this system performs no deletion.",
        ["retention_period_expired"],
        trigger_date=trigger_date,
        period_days=period_days,
        deadline=deadline,
    )
    _store_assessment(db, assessment)
    return assessment


def get_assessment_history(db: Session, asset_id: int) -> list[Assessment]:
    items = (
        db.execute(
            select(RetentionAssessment)
            .where(RetentionAssessment.asset_id == asset_id)
            .order_by(RetentionAssessment.assessed_at.desc())
        )
        .scalars()
        .all()
    )
    return [_assessment_from_model(ra) for ra in items]


def _assessment_from_model(ra: RetentionAssessment) -> Assessment:
    return Assessment(
        id=ra.id,
        asset_id=ra.asset_id,
        policy_id=ra.policy_id,
        policy_version_id=ra.policy_version_id,
        policy_version_number=ra.policy_version_number,
        rule_set=ra.rule_set,
        assessed_at=ra.assessed_at,
        recommendation=ra.recommendation,  # type: ignore[arg-type]
        rationale=ra.rationale,
        findings=[AssessmentFinding(**f) if isinstance(f, dict) else f for f in ra.findings],
        holds_active=ra.holds_active,
        unresolved_conditions=ra.unresolved_conditions,
        institution_id=ra.institution_id,
        trigger_date=ra.trigger_date,
        retention_period_days=ra.retention_period_days,
        retention_deadline=ra.retention_deadline,
    )


#: Severity derivation for the review queue: an item's severity is the most
#: urgent finding severity on its latest assessment. This is a categorical
#: maximum over an existing, documented vocabulary — never an invented score.
QUEUE_SEVERITY_RANK: dict[str, int] = {
    "informational": 0,
    "info": 0,
    "low": 1,
    "medium": 2,
    "high": 3,
    "blocked": 4,
}
QUEUE_SEVERITY_BY_RANK: tuple[str, ...] = (
    "informational",
    "low",
    "medium",
    "high",
    "blocked",
)

#: Supported queue sort modes (both use the assessment id as a deterministic
#: tie-break so pagination is stable).
QUEUE_SORTS: tuple[str, ...] = ("urgency", "age")

#: Supported review-status filters.
REVIEW_STATUSES: tuple[str, ...] = ("open", "decided")


def _derive_queue_severity(findings: object) -> str | None:
    """Most urgent finding severity, or ``None`` when there are no findings."""
    best = -1
    for finding in findings or []:
        if isinstance(finding, dict):
            severity = finding.get("severity")
        else:
            severity = getattr(finding, "severity", None)
        best = max(best, QUEUE_SEVERITY_RANK.get(str(severity), -1))
    if best < 0:
        return None
    return QUEUE_SEVERITY_BY_RANK[best]


def _queue_sort_key(item: dict[str, Any], sort: str) -> tuple[Any, ...]:
    """Deterministic ordering key for review-queue items.

    ``urgency`` (default) puts active-hold items first, then the earliest
    retention deadline (missing deadlines last), then the oldest assessment,
    then the newest assessment id. ``age`` puts the oldest assessment first.
    """
    assessed = item["assessed_at"]
    assessment_id = item.get("id") or 0
    if sort == "age":
        return (assessed, assessment_id)
    holds = int(item.get("holds_active") or 0)
    deadline = item.get("retention_deadline") or date.max
    return (0 if holds > 0 else 1, deadline, assessed, -assessment_id)


def _decision_summaries(
    db: Session, assessment_ids: Sequence[int]
) -> tuple[dict[int, int], dict[int, str]]:
    """Return ``(decision_count, latest_decision)`` per assessment id."""
    if not assessment_ids:
        return {}, {}
    rows = db.execute(
        select(
            RetentionDecision.assessment_id,
            RetentionDecision.decision,
        )
        .where(RetentionDecision.assessment_id.in_(list(assessment_ids)))
        .order_by(RetentionDecision.decided_at.asc(), RetentionDecision.id.asc())
    ).all()
    counts: dict[int, int] = {}
    latest: dict[int, str] = {}
    for assessment_id, decision in rows:
        counts[assessment_id] = counts.get(assessment_id, 0) + 1
        # Ascending order: the last row per assessment is the most recent.
        latest[assessment_id] = decision
    return counts, latest


def list_recommendations(
    db: Session,
    *,
    page: int = 1,
    per_page: int = 20,
    institution_id: int | None = None,
    review_status: str | None = None,
    recommendation: str | None = None,
    severity: str | None = None,
    sort: str = "urgency",
    search: str | None = None,
    assessed_from: datetime | None = None,
    assessed_to: datetime | None = None,
    deadline_from: date | None = None,
    deadline_to: date | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """Latest assessment per asset, with review-queue filters and sorting.

    Filters expressible in SQL run in SQL. Severity and review status are
    derived (from JSON findings and the decision table) so they are applied in
    Python, followed by the deterministic sort and pagination. One row per asset
    is held in memory at most — the whole inventory is never loaded.
    """
    latest_id = (
        select(func.max(RetentionAssessment.id).label("max_id"))
        .group_by(RetentionAssessment.asset_id)
        .subquery()
    )
    q = select(RetentionAssessment).join(
        latest_id, RetentionAssessment.id == latest_id.c.max_id
    )
    if institution_id is not None:
        q = q.where(RetentionAssessment.institution_id == institution_id)
    if recommendation is not None:
        q = q.where(RetentionAssessment.recommendation == recommendation)
    if assessed_from is not None:
        q = q.where(RetentionAssessment.assessed_at >= _as_naive_utc(assessed_from))
    if assessed_to is not None:
        q = q.where(RetentionAssessment.assessed_at <= _as_naive_utc(assessed_to))
    if deadline_from is not None:
        q = q.where(RetentionAssessment.retention_deadline >= deadline_from)
    if deadline_to is not None:
        q = q.where(RetentionAssessment.retention_deadline <= deadline_to)
    if search:
        like = f"%{search.strip().lower()}%"
        q = q.join(
            InventoryRecord, InventoryRecord.id == RetentionAssessment.asset_id
        ).where(
            or_(
                func.lower(InventoryRecord.title).like(like),
                func.lower(InventoryRecord.external_id).like(like),
                func.lower(func.coalesce(InventoryRecord.file_name, "")).like(like),
            )
        )

    rows = list(db.execute(q).scalars().all())
    if not rows:
        return [], 0

    decision_counts, latest_decisions = _decision_summaries(db, [r.id for r in rows])
    asset_ids = {r.asset_id for r in rows}
    titles = {
        asset_id: title
        for asset_id, title in db.execute(
            select(InventoryRecord.id, InventoryRecord.title).where(
                InventoryRecord.id.in_(list(asset_ids))
            )
        ).all()
    }

    items: list[dict[str, Any]] = []
    for ra in rows:
        decisions = decision_counts.get(ra.id, 0)
        status = "decided" if decisions > 0 else "open"
        if review_status is not None and status != review_status:
            continue
        item_severity = _derive_queue_severity(ra.findings)
        if severity is not None and item_severity != severity:
            continue
        items.append(
            {
                "id": ra.id,
                "asset_id": ra.asset_id,
                "asset_title": titles.get(ra.asset_id),
                "institution_id": ra.institution_id,
                "recommendation": ra.recommendation,
                "rationale": ra.rationale,
                "severity": item_severity,
                "policy_id": ra.policy_id,
                "policy_version_id": ra.policy_version_id,
                "policy_version_number": ra.policy_version_number,
                "holds_active": ra.holds_active,
                "assessed_at": ra.assessed_at,
                "findings": ra.findings,
                "retention_deadline": ra.retention_deadline,
                "days_overdue": (
                    (_utc_today() - ra.retention_deadline).days
                    if ra.retention_deadline
                    else None
                ),
                "decisions_recorded": int(decisions),
                "review_status": status,
                "latest_decision": latest_decisions.get(ra.id),
            }
        )

    items.sort(key=lambda item: _queue_sort_key(item, sort))
    total = len(items)
    start = (page - 1) * per_page
    return items[start : start + per_page], total



# --------------------------------------------------------------------------
# Human review decisions (advisory; nothing here executes a file operation)
# --------------------------------------------------------------------------

#: A reviewer may keep the record, ask for more information, approve a
#: recommendation for a later, separately authorized workflow, or reject the
#: recommendation. Recording any of these executes no file operation.
DECISION_VALUES = ("retain", "request_more_information", "approve_for_later_workflow", "reject")

#: Safety bound for walking a supersession chain; a chain longer than this is
#: treated as corrupt rather than traversed unbounded.
SUPERSESSION_CHAIN_LIMIT = 200


def _supersession_successor(db: Session, decision_id: int) -> int | None:
    """Return the id of the decision superseding ``decision_id``, if any."""
    return db.execute(
        select(RetentionDecision.id).where(
            RetentionDecision.supersedes_decision_id == decision_id
        )
    ).scalar()


def _supersedes_of(db: Session, decision_id: int) -> int | None:
    """Return the id of the decision ``decision_id`` replaces, if any."""
    return db.execute(
        select(RetentionDecision.supersedes_decision_id).where(
            RetentionDecision.id == decision_id
        )
    ).scalar()


def _reject_supersession_cycle(db: Session, target: RetentionDecision) -> None:
    """Refuse to extend a history that already contains a cycle.

    The API can only build a chain that moves strictly backwards in time, and
    ``uq_retention_decisions_supersedes`` makes a loop arithmetically
    impossible: a node pointing back into a loop needs an edge value the loop
    has already consumed. This guard exists so that a chain corrupted out of
    band — a manual repair, a restore, a database missing that index — is
    refused instead of silently extended.
    """
    seen: set[int] = set()
    cursor: int | None = target.id
    while cursor is not None:
        if cursor in seen or len(seen) > SUPERSESSION_CHAIN_LIMIT:
            raise ValueError("supersession_cycle")
        seen.add(cursor)
        cursor = _supersedes_of(db, cursor)


def validate_supersession_target(
    db: Session, *, target_id: int, assessment: RetentionAssessment
) -> RetentionDecision:
    """Check that ``target_id`` may be superseded by a decision on ``assessment``.

    Raises ``ValueError`` with a stable ``supersession_*`` code, which the route
    maps onto HTTP semantics. Every rule is enforced server-side from stored
    rows: the client cannot assert lineage, institution, or freshness.

    Rules (ADR-0015):

    * the target exists;
    * both rows belong to the same institution (tenant boundary);
    * the target belongs to the *same asset*;
    * the target comes from a **strictly earlier** assessment of that asset, so
      a chain only ever moves forward in time — including the current
      assessment would be a self-reference, and moving backwards would let two
      decisions swap places;
    * the target has no successor yet (also enforced by
      ``uq_retention_decisions_supersedes`` for concurrent submissions);
    * the target's chain contains no cycle.
    """
    if not isinstance(target_id, int) or target_id < 1:
        raise ValueError("supersession_not_found")
    target = db.get(RetentionDecision, target_id)
    if target is None:
        raise ValueError("supersession_not_found")

    if (
        target.institution_id is not None
        and assessment.institution_id is not None
        and target.institution_id != assessment.institution_id
    ):
        raise ValueError("supersession_out_of_scope")

    if target.asset_id != assessment.asset_id:
        raise ValueError("supersession_wrong_lineage")
    if target.assessment_id == assessment.id:
        raise ValueError("supersession_self_reference")
    if target.assessment_id > assessment.id:
        raise ValueError("supersession_wrong_lineage")

    if _supersession_successor(db, target.id) is not None:
        raise ValueError("supersession_already_superseded")

    _reject_supersession_cycle(db, target)
    return target


def list_supersession_candidates(
    db: Session, assessment: RetentionAssessment
) -> list[RetentionDecision]:
    """Decisions on this asset that a decision on ``assessment`` may supersede.

    Read-only, so the review form offers real choices instead of letting the
    client invent a target. A candidate is an earlier-assessment decision of
    the same institution that has not already been superseded. Cycle checking
    happens at creation time, where the full chain is walked.
    """
    rows = list(
        db.execute(
            select(RetentionDecision)
            .where(RetentionDecision.asset_id == assessment.asset_id)
            .order_by(RetentionDecision.decided_at.desc(), RetentionDecision.id.desc())
        )
        .scalars()
        .all()
    )
    earlier = [
        r
        for r in rows
        if r.assessment_id < assessment.id
        and not (
            r.institution_id is not None
            and assessment.institution_id is not None
            and r.institution_id != assessment.institution_id
        )
    ]
    if not earlier:
        return []
    already_superseded = set(
        db.execute(
            select(RetentionDecision.supersedes_decision_id).where(
                RetentionDecision.supersedes_decision_id.is_not(None),
                RetentionDecision.asset_id == assessment.asset_id,
            )
        ).scalars()
    )
    return [r for r in earlier if r.id not in already_superseded]


def decision_schemas(
    db: Session, rows: Sequence[RetentionDecision]
) -> list[Decision]:
    """Convert decision rows to schemas and annotate supersession both ways.

    ``supersedes_decision_id`` is stored; ``superseded_by_decision_id`` is the
    inverse lookup, derived here so history shows the whole chain without
    denormalising a second column that could drift out of sync.
    """
    items = list(rows)
    if not items:
        return []
    ids = [r.id for r in items]
    successors = dict(
        db.execute(
            select(
                RetentionDecision.supersedes_decision_id,
                RetentionDecision.id,
            ).where(RetentionDecision.supersedes_decision_id.in_(ids))
        ).all()
    )
    out: list[Decision] = []
    for row in items:
        schema = Decision.model_validate(row)
        successor_id = successors.get(row.id)
        schema.is_superseded = successor_id is not None
        schema.superseded_by_decision_id = successor_id
        out.append(schema)
    return out


def effective_decision_id(rows: Sequence[Decision]) -> int | None:
    """The current effective decision: the newest one nobody has superseded.

    Superseded decisions stay visible in history; only this one represents the
    outcome the institution currently stands behind.
    """
    for row in rows:
        if not row.is_superseded:
            return row.id
    return None


def _concurrent_submission_error(
    supersedes: RetentionDecision | None, exc: IntegrityError
) -> HTTPException:
    """Explain a lost race for the one-decision / one-successor constraints.

    The database refuses the second submission (unique index
    ``uq_retention_decisions_supersedes`` and the one-decision-per-assessment
    constraint); nothing from the losing submission is persisted, so both the
    decision and its audit record roll back together.
    """
    if supersedes is not None:
        detail = (
            "Another correction already supersedes that decision (a concurrent "
            "submission won). Reload the review history and correct the current "
            "effective decision instead."
        )
    else:
        detail = (
            "This assessment already has a recorded decision (a concurrent "
            "submission won). Re-assess the asset and decide on the new "
            "assessment."
        )
    return HTTPException(status_code=http_status.HTTP_409_CONFLICT, detail=detail)


def create_decision(
    db: Session,
    assessment_id: int,
    data: DecisionCreate,
    institution_id: int | None = None,
    actor: str | None = None,
    reviewer: str | None = None,
) -> RetentionDecision:
    """Record one append-only human review decision about an assessment.

    ``actor`` and ``reviewer`` come from the *verified* caller (the route
    extracts them from the authenticated identity); the request body carries
    neither, so attribution cannot be asserted by the client.

    Enforced server-side, never trusted from the client:

    * the assessment exists and (when a scope is supplied) belongs to the
      institution;
    * the submitted decision is a known value;
    * the assessment and policy versions on screen still match the server
      (optimistic concurrency) — otherwise the submission is a stale conflict;
    * approving a recommendation for a later workflow is refused while an
      active hold blocks the asset;
    * the assessment has no prior decision (one decision per assessment; the
      unique index backstops concurrent races);
    * when correcting an earlier decision, the supersession link passes
      :func:`validate_supersession_target` — same asset, same institution, a
      strictly earlier assessment, at most one successor, no cycle;
    * the decision and its audit event commit in a single transaction.

    Correcting a decision is an explicit, recorded supersession: re-assess the
    asset, then decide on the new assessment with ``supersedes_decision_id``
    naming the decision being replaced. The original row is never edited or
    erased (``ON DELETE RESTRICT``), and the unique constraint on
    ``supersedes_decision_id`` lets exactly one correction win a race.
    """
    assessment = db.get(RetentionAssessment, assessment_id)
    if assessment is None:
        raise ValueError("assessment_not_found")
    if institution_id is not None and assessment.institution_id != institution_id:
        raise ValueError("assessment_out_of_scope")
    if data.decision not in DECISION_VALUES:
        raise ValueError("invalid_decision")

    actor_label = actor or reviewer or "system"
    reviewer_label = reviewer or actor_label

    # --- optimistic concurrency: decide against the versions on screen ------
    conflicts: list[str] = []
    expected_assessed = _as_naive_utc(data.expected_assessed_at)
    if expected_assessed is not None:
        if expected_assessed != _as_naive_utc(assessment.assessed_at):
            conflicts.append("the assessment timestamp changed")
        newest_id = db.execute(
            select(func.max(RetentionAssessment.id)).where(
                RetentionAssessment.asset_id == assessment.asset_id
            )
        ).scalar()
        if newest_id is not None and int(newest_id) > assessment_id:
            conflicts.append("a newer assessment exists for this asset")

    if data.expected_policy_version_id is not None:
        if data.expected_policy_version_id != assessment.policy_version_id:
            conflicts.append("the assessment's policy version changed")
        elif assessment.policy_id is not None:
            policy = db.get(RetentionPolicy, assessment.policy_id)
            if policy is not None and policy.current_version_id != data.expected_policy_version_id:
                conflicts.append(
                    "the applicable policy moved to a new version after the assessment"
                )

    current_holds = count_active_holds_for_asset(
        db, assessment.asset_id, assessment.institution_id
    )
    if (
        data.expected_holds_active is not None
        and data.expected_holds_active != current_holds
    ):
        conflicts.append("the active-hold state changed")

    if conflicts:
        detail = (
            "stale_review_conflict: "
            + "; ".join(conflicts)
            + ". The review page is out of date; reload it and decide on the current "
            "assessment and policy version."
        )
        record_event(
            db,
            actor=actor_label,
            event_type="review.stale_conflict",
            entity_type="retention_assessment",
            entity_id=assessment_id,
            payload={
                "assessment_id": assessment_id,
                "asset_id": assessment.asset_id,
                "conflicts": conflicts,
                "attempted_decision": data.decision,
            },
        )
        raise HTTPException(status_code=http_status.HTTP_409_CONFLICT, detail=detail)

    # --- governance invariant: an active hold blocks approving a workflow ---
    if data.decision == "approve_for_later_workflow" and current_holds > 0:
        detail = (
            "hold_conflict: an active retention hold blocks approving any "
            "lifecycle-advancing recommendation. Active holds override incompatible "
            "recommendations; release the hold or record a different decision."
        )
        record_event(
            db,
            actor=actor_label,
            event_type="review.hold_conflict",
            entity_type="retention_assessment",
            entity_id=assessment_id,
            payload={
                "assessment_id": assessment_id,
                "asset_id": assessment.asset_id,
                "holds_active": current_holds,
                "attempted_decision": data.decision,
            },
        )
        raise HTTPException(status_code=http_status.HTTP_409_CONFLICT, detail=detail)

    existing = (
        db.execute(
            select(RetentionDecision).where(RetentionDecision.assessment_id == assessment_id)
        )
        .scalars()
        .first()
    )

    # --- Phase 7: explicit, append-only correction (ADR-0015) ---------------
    # Validated before the "already decided" check so a correction that targets
    # this very assessment reports the precise reason rather than a generic one.
    supersedes: RetentionDecision | None = None
    if data.supersedes_decision_id is not None:
        supersedes = validate_supersession_target(
            db, target_id=data.supersedes_decision_id, assessment=assessment
        )

    if existing is not None:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                "This assessment already has a recorded decision. Re-assess the asset "
                "and decide on the new assessment; past decisions are never overwritten."
            ),
        )

    decision = RetentionDecision(
        assessment_id=assessment_id,
        asset_id=assessment.asset_id,
        institution_id=assessment.institution_id,
        policy_id=assessment.policy_id,
        policy_version_id=assessment.policy_version_id,
        recommendation_reviewed=assessment.recommendation,
        decision=data.decision,
        reason=data.reason,
        reviewer=reviewer_label,
        decided_at=_now(),
        supersedes_decision_id=supersedes.id if supersedes is not None else None,
    )
    db.add(decision)
    try:
        db.flush()
    except IntegrityError as exc:  # raced with a concurrent submission
        db.rollback()
        raise _concurrent_submission_error(supersedes, exc) from exc

    # Decision and audit trail share one transaction: a partial write is
    # impossible, so the governance history stays consistent.
    audit_payload: dict[str, Any] = {
        "assessment_id": assessment_id,
        "asset_id": assessment.asset_id,
        "institution_id": assessment.institution_id,
        "policy_id": assessment.policy_id,
        "policy_version_id": assessment.policy_version_id,
        "recommendation_reviewed": assessment.recommendation,
        "decision": data.decision,
    }
    record_event(
        db,
        actor=actor_label,
        event_type="review.decision_created",
        entity_type="retention_decision",
        entity_id=decision.id,
        payload=audit_payload,
        commit=False,
    )
    if data.decision == "reject":
        record_event(
            db,
            actor=actor_label,
            event_type="review.decision_rejected",
            entity_type="retention_decision",
            entity_id=decision.id,
            payload=dict(audit_payload),
            commit=False,
        )
    elif data.decision == "request_more_information":
        record_event(
            db,
            actor=actor_label,
            event_type="review.information_requested",
            entity_type="retention_decision",
            entity_id=decision.id,
            payload=dict(audit_payload),
            commit=False,
        )
    if supersedes is not None:
        # The free-text rationale lives on the append-only decision row itself;
        # the audit event records the linkage, actor, and timestamps (ADR-0013
        # keeps rationale text out of the audit payload).
        record_event(
            db,
            actor=actor_label,
            event_type="review.decision_superseded",
            entity_type="retention_decision",
            entity_id=decision.id,
            payload={
                **audit_payload,
                "supersedes_decision_id": supersedes.id,
                "superseded_assessment_id": supersedes.assessment_id,
                "superseded_decision": supersedes.decision,
                "reason_length": len(data.reason),
            },
            commit=False,
        )

    try:
        db.commit()
    except IntegrityError as exc:  # raced with a concurrent submission
        db.rollback()
        raise _concurrent_submission_error(supersedes, exc) from exc
    db.refresh(decision)
    return decision



def list_decisions_for_assessment(db: Session, assessment_id: int) -> list[Decision]:
    rows = list(
        db.execute(
            select(RetentionDecision)
            .where(RetentionDecision.assessment_id == assessment_id)
            .order_by(RetentionDecision.decided_at.desc(), RetentionDecision.id.desc())
        )
        .scalars()
        .all()
    )
    return decision_schemas(db, rows)


def list_decisions_for_asset(
    db: Session, asset_id: int, institution_id: int | None = None
) -> list[Decision]:
    q = (
        select(RetentionDecision)
        .where(RetentionDecision.asset_id == asset_id)
        .order_by(RetentionDecision.decided_at.desc(), RetentionDecision.id.desc())
    )
    if institution_id is not None:
        q = q.where(RetentionDecision.institution_id == institution_id)
    rows = list(db.execute(q).scalars().all())
    return decision_schemas(db, rows)
