"""Retention and assessment API routes.

Advisory only: nothing here moves, archives, or deletes a file.

Authorization (Phase 7, ADR-0014 / ADR-0010 superseded): every route requires a
verified bearer token resolved against the local user directory, and is checked
against the documented role/permission matrix. A client supplied
``institution_id`` is never proof of identity — it is validated for existence
and then reconciled with the verified identity, and a resource outside the
caller's institution scope answers 404 so another tenant's existence is not
disclosed. In ``ENVIRONMENT=production`` the whole layer fails closed with 503
until a real signing secret/identity provider is configured.

Writes additionally require the matching permission: ``retention:write`` for
policies and holds, ``retention:assess`` to run an assessment, and
``review:decide`` to record a decision.
"""

from __future__ import annotations

import math
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.api.schemas.retention import (
    Assessment,
    Decision,
    DecisionCreate,
    Hold,
    HoldCreate,
    HoldRelease,
    PaginatedRecommendations,
    Policy,
    PolicyActivate,
    PolicyCreate,
    PolicyUpdate,
    PolicyVersion,
    PolicyVersionCreate,
    RecommendationItem,
)
from app.core.auth import (
    PERMISSION_RETENTION_ASSESS,
    PERMISSION_RETENTION_READ,
    PERMISSION_RETENTION_WRITE,
    PERMISSION_REVIEW_DECIDE,
    CurrentUser,
    ensure_institution_access,
    record_scope_denial,
    require_permission,
    resolve_institution_scope,
)
from app.db.models import (
    InventoryRecord,
    RetentionAssessment,
)
from app.db.models import (
    PolicyVersion as PolicyVersionModel,
)
from app.db.session import get_db
from app.services import retention as retention_service

router = APIRouter(prefix="/retention")

ReadDeps = Depends(require_permission(PERMISSION_RETENTION_READ))
WriteDeps = Depends(require_permission(PERMISSION_RETENTION_WRITE))


def _validate_institution_exists(db: Session, institution_id: int | None) -> None:
    if institution_id is None:
        return
    from app.db.models import Institution

    if db.get(Institution, institution_id) is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Institution {institution_id} does not exist",
        )


def _require_policy(db: Session, policy_id: int) -> Policy:
    p = retention_service.get_policy(db, policy_id)
    if not p:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Policy not found")
    return p


def _require_asset(db: Session, asset_id: int) -> InventoryRecord:
    asset = db.get(InventoryRecord, asset_id)
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")
    return asset


def _require_asset_scoped(
    db: Session,
    asset_id: int,
    institution_id: int | None,
    current: CurrentUser,
    *,
    request: Request | None = None,
) -> InventoryRecord:
    """Load an asset and authorize it twice: against the declared filter *and*
    against the verified identity."""
    asset = _require_asset(db, asset_id)
    if institution_id is not None and asset.institution_id != institution_id:
        if request is not None:
            record_scope_denial(request, current, db)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="asset_out_of_scope"
        )
    ensure_institution_access(
        current, asset.institution_id, request=request, db=db if request is not None else None
    )
    return asset


@router.post("/policies", response_model=Policy, status_code=status.HTTP_201_CREATED)
def create_policy(
    data: PolicyCreate,
    request: Request,
    current: CurrentUser = Depends(require_permission(PERMISSION_RETENTION_WRITE)),
    db: Session = Depends(get_db),
) -> Policy:
    _validate_institution_exists(db, data.institution_id)
    ensure_institution_access(current, data.institution_id, request=request, db=db)
    return retention_service.create_policy(db, data)


@router.get("/policies", response_model=list[Policy])
def list_policies(
    status: str | None = Query(default=None),
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_RETENTION_READ)),
    db: Session = Depends(get_db),
) -> list[Policy]:
    _validate_institution_exists(db, institution_id)
    scope = resolve_institution_scope(current, institution_id)
    items, _ = retention_service.list_policies(
        db, page=1, per_page=100, status=status, institution_id=scope
    )
    return items


@router.get("/policies/{policy_id}", response_model=Policy)
def get_policy(
    policy_id: int,
    current: CurrentUser = Depends(require_permission(PERMISSION_RETENTION_READ)),
    db: Session = Depends(get_db),
) -> Policy:
    p = _require_policy(db, policy_id)
    ensure_institution_access(current, p.institution_id)
    return p


@router.patch("/policies/{policy_id}", response_model=Policy)
def update_policy(
    policy_id: int,
    data: PolicyUpdate,
    request: Request,
    current: CurrentUser = Depends(require_permission(PERMISSION_RETENTION_WRITE)),
    db: Session = Depends(get_db),
) -> Policy:
    p = _require_policy(db, policy_id)
    ensure_institution_access(current, p.institution_id, request=request, db=db)
    if data.status is not None and p.status not in ("draft", "approved", "active"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Policy in status {p.status!r} can no longer be updated.",
        )
    if data.status == "active" and p.current_version_id is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A policy cannot be activated before one of its versions is activated.",
        )
    if data.current_version_id is not None:
        v = db.get(PolicyVersionModel, data.current_version_id)
        if v is None or v.policy_id != policy_id:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="current_version_id must reference a version of this policy",
            )
    return retention_service.update_policy(db, p, data)


@router.post(
    "/policies/{policy_id}/versions",
    response_model=PolicyVersion,
    status_code=status.HTTP_201_CREATED,
)
def create_version(
    policy_id: int,
    data: PolicyVersionCreate,
    request: Request,
    current: CurrentUser = Depends(require_permission(PERMISSION_RETENTION_WRITE)),
    db: Session = Depends(get_db),
) -> PolicyVersion:
    p = _require_policy(db, policy_id)
    ensure_institution_access(current, p.institution_id, request=request, db=db)
    if p.status in ("retired", "inactive"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Policy in status {p.status!r} accepts no new versions.",
        )
    return retention_service.create_policy_version(db, p, data)


@router.post("/policies/{policy_id}/activate", response_model=Policy)
def activate_policy(
    policy_id: int,
    data: PolicyActivate,
    request: Request,
    current: CurrentUser = Depends(require_permission(PERMISSION_RETENTION_WRITE)),
    db: Session = Depends(get_db),
) -> Policy:
    p = _require_policy(db, policy_id)
    ensure_institution_access(current, p.institution_id, request=request, db=db)
    v = db.get(PolicyVersionModel, data.version_id)
    if v is None or v.policy_id != policy_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Version not found")
    return retention_service.activate_policy_version(db, p, v)


@router.post("/holds", response_model=Hold, status_code=status.HTTP_201_CREATED)
def create_hold(
    data: HoldCreate,
    request: Request,
    current: CurrentUser = Depends(require_permission(PERMISSION_RETENTION_WRITE)),
    db: Session = Depends(get_db),
) -> Hold:
    _validate_institution_exists(db, data.institution_id)
    ensure_institution_access(current, data.institution_id, request=request, db=db)
    if data.asset_id is not None:
        asset = _require_asset(db, data.asset_id)
        ensure_institution_access(current, asset.institution_id, request=request, db=db)
        if (
            data.institution_id is not None
            and asset.institution_id is not None
            and asset.institution_id != data.institution_id
        ):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    "A hold's institution_id must match the institution of the asset "
                    "it covers."
                ),
            )
    return retention_service.create_hold(db, data)


@router.get("/holds", response_model=list[Hold])
def list_holds(
    status: str | None = Query(default=None),
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_RETENTION_READ)),
    db: Session = Depends(get_db),
) -> list[Hold]:
    _validate_institution_exists(db, institution_id)
    scope = resolve_institution_scope(current, institution_id)
    items, _ = retention_service.list_holds(
        db, page=1, per_page=100, status=status, institution_id=scope
    )
    return items


@router.patch("/holds/{hold_id}/release", response_model=Hold)
def release_hold(
    hold_id: int,
    data: HoldRelease,
    request: Request,
    current: CurrentUser = Depends(require_permission(PERMISSION_RETENTION_WRITE)),
    db: Session = Depends(get_db),
) -> Hold:
    h = retention_service.get_hold(db, hold_id)
    if not h:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Hold not found")
    ensure_institution_access(current, h.institution_id, request=request, db=db)
    if h.status == "released":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Hold already released"
        )
    return retention_service.release_hold(db, h, data)


@router.post("/assess/{asset_id}", response_model=Assessment)
def assess_asset(
    asset_id: int,
    request: Request,
    current: CurrentUser = Depends(require_permission(PERMISSION_RETENTION_ASSESS)),
    db: Session = Depends(get_db),
) -> Assessment:
    _require_asset_scoped(db, asset_id, None, current, request=request)
    return retention_service.assess_asset(db, asset_id)


@router.get("/assessments/{asset_id}/history", response_model=list[Assessment])
def assessment_history(
    asset_id: int,
    current: CurrentUser = Depends(require_permission(PERMISSION_RETENTION_READ)),
    db: Session = Depends(get_db),
) -> list[Assessment]:
    _require_asset_scoped(db, asset_id, None, current)
    return retention_service.get_assessment_history(db, asset_id)


@router.post(
    "/assessments/{assessment_id}/decisions",
    response_model=Decision,
    status_code=status.HTTP_201_CREATED,
)
def create_decision(
    assessment_id: int,
    data: DecisionCreate,
    request: Request,
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_REVIEW_DECIDE)),
    db: Session = Depends(get_db),
) -> Decision:
    """Record an append-only human review decision about one assessment.

    The decision references the assessment and policy versions the reviewer saw
    and is rejected as stale (409) when they no longer match. Approving a
    recommendation is refused while an active hold blocks the asset. Nothing
    here archives, restores, moves, or deletes a file.
    """
    _validate_institution_exists(db, institution_id)
    assessment = db.get(RetentionAssessment, assessment_id)
    if assessment is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Assessment not found"
        )
    if institution_id is not None and assessment.institution_id != institution_id:
        record_scope_denial(request, current, db)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="assessment_out_of_scope"
        )
    ensure_institution_access(
        current, assessment.institution_id, request=request, db=db
    )
    try:
        return retention_service.create_decision(
            db,
            assessment_id,
            data,
            institution_id=institution_id,
            actor=current.email,
            reviewer=current.display_name or current.email,
        )
    except ValueError as e:
        code = str(e)
        if code == "assessment_not_found":
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Assessment not found"
            ) from e
        if code == "assessment_out_of_scope":
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="assessment_out_of_scope"
            ) from e
        if code == "invalid_decision":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Unsupported decision value.",
            ) from e
        if code.startswith("supersession_"):
            raise _supersession_error(code) from e
        raise


#: Human-readable explanations for each supersession rejection code. Codes are
#: raised as ``ValueError`` by the service and mapped here so the messages stay
#: with the HTTP contract rather than leaking into service logic.
_SUPERSESSION_MESSAGES: dict[str, str] = {
    "supersession_not_found": "The decision being superseded does not exist.",
    "supersession_out_of_scope": (
        "The decision being superseded belongs to a different institution."
    ),
    "supersession_wrong_lineage": (
        "A decision may only supersede a decision from an earlier assessment of "
        "the same asset."
    ),
    "supersession_self_reference": (
        "A decision cannot supersede the decision recorded on its own assessment."
    ),
    "supersession_already_superseded": (
        "That decision has already been superseded by another correction; reload "
        "the review history and correct the current effective decision."
    ),
    "supersession_cycle": (
        "The supersession history already contains a cycle and cannot be extended."
    ),
}


def _supersession_error(code: str) -> HTTPException:
    """Map supersession rule violations onto stable HTTP semantics.

    404 for a target that does not exist or belongs to another institution (the
    caller learns nothing about other tenants); 409 for a target that exists but
    cannot legally be superseded in the current history.
    """
    message = _SUPERSESSION_MESSAGES.get(code, code)
    if code in ("supersession_not_found", "supersession_out_of_scope"):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=message)
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)


@router.get("/assessments/{assessment_id}/decisions", response_model=list[Decision])
def list_decisions(
    assessment_id: int,
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_RETENTION_READ)),
    db: Session = Depends(get_db),
) -> list[Decision]:
    assessment = db.get(RetentionAssessment, assessment_id)
    if assessment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Assessment not found")
    if institution_id is not None and assessment.institution_id != institution_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="assessment_out_of_scope"
        )
    ensure_institution_access(current, assessment.institution_id)
    return retention_service.list_decisions_for_assessment(db, assessment_id)


@router.get("/assets/{asset_id}/decisions", response_model=list[Decision])
def list_asset_decisions(
    asset_id: int,
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_RETENTION_READ)),
    db: Session = Depends(get_db),
) -> list[Decision]:
    _require_asset_scoped(db, asset_id, institution_id, current)
    return retention_service.list_decisions_for_asset(
        db, asset_id, institution_id=institution_id
    )


@router.get("/recommendations", response_model=PaginatedRecommendations)
def list_recommendations(
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=20, ge=1, le=100),
    institution_id: int | None = Query(default=None),
    review_status: str | None = Query(default=None),
    recommendation: str | None = Query(default=None),
    severity: str | None = Query(default=None),
    sort: str = Query(default="urgency"),
    search: str | None = Query(default=None, max_length=200),
    assessed_from: datetime | None = Query(default=None),
    assessed_to: datetime | None = Query(default=None),
    deadline_from: date | None = Query(default=None),
    deadline_to: date | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_RETENTION_READ)),
    db: Session = Depends(get_db),
) -> PaginatedRecommendations:
    """Paginated, filterable review queue (latest assessment per asset).

    Filters are validated; severity and review status are derived server-side
    from the assessment findings and the decision history. Sorting is
    deterministic (urgency or age, tie-broken by assessment id). The queue is
    always restricted to the caller's institution scope.
    """
    _validate_institution_exists(db, institution_id)
    scope = resolve_institution_scope(current, institution_id)
    if review_status is not None and review_status not in retention_service.REVIEW_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"review_status must be one of {list(retention_service.REVIEW_STATUSES)}",
        )
    if sort not in retention_service.QUEUE_SORTS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"sort must be one of {list(retention_service.QUEUE_SORTS)}",
        )
    if severity is not None and severity not in retention_service.QUEUE_SEVERITY_BY_RANK:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "severity must be one of "
                f"{list(retention_service.QUEUE_SEVERITY_BY_RANK)}"
            ),
        )
    if recommendation is not None and recommendation not in retention_service.RECOMMENDATION_VALUES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "recommendation must be one of "
                f"{list(retention_service.RECOMMENDATION_VALUES)}"
            ),
        )
    items_raw, total = retention_service.list_recommendations(
        db,
        page=page,
        per_page=per_page,
        institution_id=scope,
        review_status=review_status,
        recommendation=recommendation,
        severity=severity,
        sort=sort,
        search=search,
        assessed_from=assessed_from,
        assessed_to=assessed_to,
        deadline_from=deadline_from,
        deadline_to=deadline_to,
    )
    items = [RecommendationItem(**i) for i in items_raw]
    pages = math.ceil(total / per_page) if per_page else 0
    return PaginatedRecommendations(
        items=items, total=total, page=page, per_page=per_page, pages=pages
    )


@router.get(
    "/decisions/supersession/source",
    response_model=list[Decision],
    summary="Eligible decisions a new decision may supersede",
)
def supersession_candidates(
    assessment_id: int = Query(...),
    current: CurrentUser = Depends(require_permission(PERMISSION_RETENTION_READ)),
    db: Session = Depends(get_db),
) -> list[Decision]:
    """Previous decisions on the same asset's lineage that a correction may replace.

    Read-only; exists so the review form can offer a real, already-authorized
    choice instead of letting the client invent a target.
    """
    assessment = db.get(RetentionAssessment, assessment_id)
    if assessment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Assessment not found")
    ensure_institution_access(current, assessment.institution_id)
    return retention_service.list_supersession_candidates(db, assessment)
