"""API routes for data assets (inventory).

Phase 7 (ADR-0014): reads require ``inventory:read``; creating and updating
assets require ``assets:write``. List queries are always filtered to the
caller's institution scope, and a single-asset lookup answers 404 for assets
outside it so another tenant's identifiers are not confirmed.
"""

from __future__ import annotations

import math

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.api.schemas.assets import Asset, AssetCreate, AssetListResponse, AssetUpdate
from app.core.auth import (
    PERMISSION_ASSETS_WRITE,
    PERMISSION_INVENTORY_READ,
    CurrentUser,
    ensure_institution_access,
    require_permission,
    resolve_institution_scope,
)
from app.db.session import get_db
from app.services import assets as assets_service

router = APIRouter(prefix="/assets")


@router.post("", response_model=Asset, status_code=status.HTTP_201_CREATED)
def create_asset(
    data: AssetCreate,
    request: Request,
    current: CurrentUser = Depends(require_permission(PERMISSION_ASSETS_WRITE)),
    db: Session = Depends(get_db),
) -> Asset:
    # Scope is checked before the row exists, so an unauthorized create never
    # writes anything.
    ensure_institution_access(current, data.institution_id, request=request, db=db)
    asset = assets_service.create_asset(db, data)
    return asset


@router.get("", response_model=AssetListResponse)
def list_assets(
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=20, ge=1, le=100),
    search: str | None = Query(default=None),
    category: str | None = Query(default=None),
    sensitivity: str | None = Query(default=None),
    source_type: str | None = Query(default=None),
    lifecycle_status: str | None = Query(default=None),
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_INVENTORY_READ)),
    db: Session = Depends(get_db),
) -> AssetListResponse:
    scope = resolve_institution_scope(current, institution_id)
    items, total = assets_service.list_assets(
        db,
        page=page,
        per_page=per_page,
        search=search,
        category=category,
        sensitivity=sensitivity,
        source_type=source_type,
        lifecycle_status=lifecycle_status,
        institution_id=scope,
    )
    pages = math.ceil(total / per_page) if per_page else 0
    return AssetListResponse(items=items, total=total, page=page, per_page=per_page, pages=pages)


@router.get("/{asset_id}", response_model=Asset)
def get_asset(
    asset_id: int,
    current: CurrentUser = Depends(require_permission(PERMISSION_INVENTORY_READ)),
    db: Session = Depends(get_db),
) -> Asset:
    asset = assets_service.get_asset(db, asset_id)
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")
    ensure_institution_access(current, asset.institution_id)
    return asset


@router.patch("/{asset_id}", response_model=Asset)
def update_asset(
    asset_id: int,
    data: AssetUpdate,
    request: Request,
    current: CurrentUser = Depends(require_permission(PERMISSION_ASSETS_WRITE)),
    db: Session = Depends(get_db),
) -> Asset:
    asset = assets_service.get_asset(db, asset_id)
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")
    ensure_institution_access(current, asset.institution_id, request=request, db=db)
    asset = assets_service.update_asset(db, asset, data)
    return asset
