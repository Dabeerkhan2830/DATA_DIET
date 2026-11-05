"""Clearly-labeled synthetic demo endpoints for Phase 1 UI development.

These endpoints serve in-process fixtures only. They are NOT integrations with
any institutional system, and they do not read or write the database. Every
response is wrapped in a ``synthetic_demo_data`` envelope.

Phase 7 (ADR-0014): the endpoints are still read-only fixtures, but they now
require an authenticated account — ``inventory:read`` for the dashboard,
inventory, risk and source views, ``retention:read`` for the retention view —
so no API surface is reachable anonymously except the health probes.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.schemas.demo import (
    DashboardSummary,
    DemoEnvelope,
    InventoryRecord,
    RetentionPage,
    RiskAnalysisPage,
    SourceView,
)
from app.core.auth import (
    PERMISSION_INVENTORY_READ,
    PERMISSION_RETENTION_READ,
    CurrentUser,
    require_permission,
)
from app.core.config import get_settings
from app.services import demo_data

router = APIRouter(prefix="/demo")


def _demo_or_404() -> None:
    """Feature gate: demo routes can be disabled via DEMO_DATA_ENABLED=false."""
    if not get_settings().demo_data_enabled:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Synthetic demo endpoints are disabled in this environment.",
        )


@router.get("/dashboard", response_model=DemoEnvelope[DashboardSummary])
def dashboard(
    current: CurrentUser = Depends(require_permission(PERMISSION_INVENTORY_READ)),
) -> DemoEnvelope[DashboardSummary]:
    _demo_or_404()
    return DemoEnvelope(data=demo_data.get_dashboard_summary())


@router.get("/inventory", response_model=DemoEnvelope[list[InventoryRecord]])
def inventory(
    current: CurrentUser = Depends(require_permission(PERMISSION_INVENTORY_READ)),
) -> DemoEnvelope[list[InventoryRecord]]:
    _demo_or_404()
    return DemoEnvelope(data=demo_data.list_inventory())


@router.get("/risk", response_model=DemoEnvelope[RiskAnalysisPage])
def risk(
    current: CurrentUser = Depends(require_permission(PERMISSION_INVENTORY_READ)),
) -> DemoEnvelope[RiskAnalysisPage]:
    _demo_or_404()
    return DemoEnvelope(data=demo_data.get_risk_analysis())


@router.get("/retention", response_model=DemoEnvelope[RetentionPage])
def retention(
    current: CurrentUser = Depends(require_permission(PERMISSION_RETENTION_READ)),
) -> DemoEnvelope[RetentionPage]:
    _demo_or_404()
    return DemoEnvelope(data=demo_data.get_retention_page())


@router.get("/connected-sources", response_model=DemoEnvelope[list[SourceView]])
def connected_sources(
    current: CurrentUser = Depends(require_permission(PERMISSION_INVENTORY_READ)),
) -> DemoEnvelope[list[SourceView]]:
    """Intentionally empty list: no real source connectors exist in Phase 1."""
    _demo_or_404()
    return DemoEnvelope(data=[])
