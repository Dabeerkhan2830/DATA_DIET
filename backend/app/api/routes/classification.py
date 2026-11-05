"""API routes for classification and data-quality (Phase 5).

All endpoints are metadata-only: no file content reads, no lifecycle actions,
and no automatic mutatation of inventory records. Classification writes propose,
but never apply; history is immutable and versioned.

Phase 7 (ADR-0014): reading requires ``governance:read`` and running a
classification requires ``classification:write``. The actor recorded on the row
comes from the verified identity, never from a client-supplied query parameter.
"""

from __future__ import annotations

import math

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.api.schemas.classification import (
    ClassificationResultListResponse,
    ClassificationResultSchema,
    ClassificationRulesSchema,
    PaginatedQualityFindings,
    QualityReportSchema,
    RuleDescriptorSchema,
)
from app.core.auth import (
    PERMISSION_CLASSIFICATION_WRITE,
    PERMISSION_GOVERNANCE_READ,
    CurrentUser,
    ensure_institution_access,
    record_scope_denial,
    require_permission,
    resolve_institution_scope,
)
from app.db.models import ClassificationResult, InventoryRecord
from app.db.session import get_db
from app.services import classification as classification_service
from app.services import data_quality as data_quality_service
from app.services.audit import record_event

router = APIRouter(prefix="/classification")


def _require_asset_scoped(
    db: Session,
    asset_id: int,
    institution_id: int | None,
    current: CurrentUser,
    *,
    request: Request | None = None,
) -> InventoryRecord:
    asset = db.get(InventoryRecord, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="asset_not_found")
    if institution_id is not None and asset.institution_id != institution_id:
        if request is not None:
            record_scope_denial(request, current, db)
        raise HTTPException(status_code=404, detail="asset_out_of_scope")
    ensure_institution_access(
        current, asset.institution_id, request=request, db=db if request is not None else None
    )
    return asset


def _to_classification_schema(row: ClassificationResult) -> ClassificationResultSchema:
    return ClassificationResultSchema.model_validate(row)


@router.get("/rules", response_model=ClassificationRulesSchema)
def list_rules(
    current: CurrentUser = Depends(require_permission(PERMISSION_GOVERNANCE_READ)),
) -> ClassificationRulesSchema:
    return ClassificationRulesSchema(
        rule_version=classification_service.RULE_VERSION,
        rules=[
            RuleDescriptorSchema(
                rule_id=rd.rule_id,
                field=rd.field,
                effect=rd.effect,
                confidence=rd.confidence,
                description=rd.description,
            )
            for rd in classification_service.RULE_TABLE
        ],
        confidence_meaning=dict(classification_service.CONFIDENCE_MEANING),
        outcomes=list(classification_service.OUTCOMES),
        sensitivities=list(classification_service.SENSITIVITY_LEVELS),
        known_categories=sorted(classification_service.KNOWN_CATEGORIES),
        severities=list(data_quality_service.SEVERITY_ORDER),
    )


@router.post("/assets/{asset_id}", response_model=ClassificationResultSchema, status_code=201)
def run_classification(
    asset_id: int,
    request: Request,
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_CLASSIFICATION_WRITE)),
    db: Session = Depends(get_db),
) -> ClassificationResultSchema:
    asset = _require_asset_scoped(db, asset_id, institution_id, current, request=request)
    created_by = current.email
    row, created = classification_service.classify_and_persist(
        db, asset, created_by=created_by
    )
    record_event(
        db,
        actor=created_by,
        event_type="classification.run",
        entity_type="asset",
        entity_id=asset_id,
        payload={
            "asset_id": asset_id,
            "rule_version": row.rule_version,
            "outcome": row.outcome,
            "proposed_sensitivity": row.proposed_sensitivity,
            "confidence": row.confidence,
            "created": created,
        },
    )
    return _to_classification_schema(row)


@router.get("/assets/{asset_id}/latest", response_model=ClassificationResultSchema)
def latest_classification(
    asset_id: int,
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_GOVERNANCE_READ)),
    db: Session = Depends(get_db),
) -> ClassificationResultSchema:
    _require_asset_scoped(db, asset_id, institution_id, current)
    row = classification_service.get_latest(db, asset_id)
    if row is None:
        raise HTTPException(status_code=404, detail="no_classification")
    return _to_classification_schema(row)


@router.get("/assets/{asset_id}/history", response_model=ClassificationResultListResponse)
def classification_history(
    asset_id: int,
    institution_id: int | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=20, ge=1, le=100),
    current: CurrentUser = Depends(require_permission(PERMISSION_GOVERNANCE_READ)),
    db: Session = Depends(get_db),
) -> ClassificationResultListResponse:
    _require_asset_scoped(db, asset_id, institution_id, current)
    rows, total = classification_service.get_history(
        db, asset_id, page=page, per_page=per_page
    )
    return ClassificationResultListResponse(
        results=[_to_classification_schema(r) for r in rows],
        total=total,
        page=page,
        per_page=per_page,
        total_pages=(math.ceil(total / per_page) if per_page else 1),
    )


@router.get("/assets/{asset_id}/quality", response_model=QualityReportSchema)
def asset_quality(
    asset_id: int,
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_GOVERNANCE_READ)),
    db: Session = Depends(get_db),
) -> QualityReportSchema:
    asset = _require_asset_scoped(db, asset_id, institution_id, current)
    findings = data_quality_service.analyze_inventory(
        db, institution_id=asset.institution_id, asset_id=asset_id
    )
    return QualityReportSchema(
        asset_id=asset_id,
        findings=[f.as_dict() for f in findings],
    )


@router.get("/quality/findings", response_model=PaginatedQualityFindings)
def quality_findings(
    institution_id: int | None = Query(default=None),
    severity: str | None = Query(default=None),
    check: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=20, ge=1, le=100),
    current: CurrentUser = Depends(require_permission(PERMISSION_GOVERNANCE_READ)),
    db: Session = Depends(get_db),
) -> PaginatedQualityFindings:
    findings = data_quality_service.analyze_inventory(
        db, institution_id=resolve_institution_scope(current, institution_id)
    )
    if severity:
        findings = [f for f in findings if f.severity == severity]
    if check:
        findings = [f for f in findings if f.check == check]
    total = len(findings)
    start = (page - 1) * per_page
    end = start + per_page
    page_findings = findings[start:end]
    return PaginatedQualityFindings(
        findings=[f.as_dict() for f in page_findings],
        total=total,
        page=page,
        per_page=per_page,
        total_pages=(math.ceil(total / per_page) if per_page else 1),
    )


@router.get("/checks", response_model=list)
def quality_checks(
    current: CurrentUser = Depends(require_permission(PERMISSION_GOVERNANCE_READ)),
) -> list[dict[str, object]]:
    return [
        {
            "check": c.check,
            "severity": c.severity,
            "description": c.description,
            "remediation": c.remediation,
        }
        for c in data_quality_service.CHECKS
    ]
