"""Unified asset governance API routes (Phase 6).

Read-only aggregation for one authorized asset. Reuses the existing inventory,
classification, data-quality, retention and decision subsystems — it introduces
no competing decision table and no execution path.

Phase 7: every route requires an authenticated account with
``governance:read``, and the asset is authorized against the verified identity
so a cross-institution id answers 404 rather than disclosing another tenant.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.schemas.governance import GovernanceDetail
from app.core.auth import (
    PERMISSION_GOVERNANCE_READ,
    CurrentUser,
    ensure_institution_access,
    require_permission,
)
from app.db.models import Institution, InventoryRecord
from app.db.session import get_db
from app.services import governance as governance_service

router = APIRouter(prefix="/governance")


@router.get("/assets/{asset_id}", response_model=GovernanceDetail)
def asset_governance(
    asset_id: int,
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_GOVERNANCE_READ)),
    db: Session = Depends(get_db),
) -> GovernanceDetail:
    """Return the unified governance view for one asset.

    ``institution_id`` is validated for existence and enforced against the
    asset; a mismatch is reported as a 404 so scope membership is not disclosed.
    Independently, the asset itself is authorized against the verified caller.
    """
    if institution_id is not None and db.get(Institution, institution_id) is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Institution {institution_id} does not exist",
        )
    # Authorize the asset before aggregating anything: a caller outside the
    # asset's institution never triggers the (potentially expensive) lookup.
    asset = db.get(InventoryRecord, asset_id)
    if asset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="asset_not_found")
    ensure_institution_access(current, asset.institution_id)
    try:
        return governance_service.asset_governance(db, asset_id, institution_id)
    except ValueError as e:
        code = str(e)
        if code in ("asset_not_found", "asset_out_of_scope"):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail=code
            ) from e
        raise
