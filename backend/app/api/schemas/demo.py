"""Schemas for the clearly-labeled synthetic demo endpoints.

Every response from these endpoints is wrapped in :class:`DemoEnvelope`, which
carries an explicit machine-readable notice that the payload is synthetic
sample data produced locally — never real institutional data.
"""

from __future__ import annotations

from datetime import date
from typing import Generic, Literal, TypeVar

from pydantic import BaseModel, Field

from app.services.risk import RiskBand, SensitivityLevel

T = TypeVar("T")

Sensitivity = SensitivityLevel
RetentionAction = Literal["retain", "archive", "review", "eligible_for_disposal"]


class DemoMeta(BaseModel):
    """Machine-readable marker attached to every synthetic payload."""

    classification: Literal["synthetic_demo_data"] = "synthetic_demo_data"
    notice: str = (
        "SYNTHETIC DEMO DATA. Generated locally for UI development. "
        "No real personal or institutional records are included."
    )
    source: Literal["in_process_fixture"] = "in_process_fixture"


class DemoEnvelope(BaseModel, Generic[T]):
    """Envelope wrapping all synthetic demo payloads."""

    meta: DemoMeta = Field(default_factory=DemoMeta)
    data: T


class SensitivityBreakdown(BaseModel):
    public: int
    internal: int
    confidential: int
    restricted: int


class RiskBreakdown(BaseModel):
    low: int
    moderate: int
    high: int
    critical: int


class ActivityItem(BaseModel):
    event_id: str
    event_type: str
    description: str
    actor: str
    occurred_on: date


class DashboardSummary(BaseModel):
    """Aggregated counts for the dashboard (computed from synthetic records)."""

    total_records: int
    duplicate_candidates: int
    pending_approvals: int
    open_retrieval_requests: int
    storage_bytes: int
    by_sensitivity: SensitivityBreakdown
    by_risk_band: RiskBreakdown
    by_retention_action: dict[RetentionAction, int]
    recent_activity: list[ActivityItem]


class InventoryRecord(BaseModel):
    record_id: str = Field(description="SYNTHETIC- prefix marks demo records")
    title: str
    source_name: str
    source_type: str
    record_type: str
    sensitivity: Sensitivity
    contains_personal_data: bool
    duplicate_candidate: bool
    size_bytes: int
    retention_action: RetentionAction
    owner_team: str
    last_reviewed: date | None


class RiskIndicatorView(BaseModel):
    code: str
    label: str
    points: int
    explanation: str


class RiskRecordView(BaseModel):
    record_id: str
    title: str
    sensitivity: Sensitivity
    score: int = Field(ge=0, le=100)
    band: RiskBand
    indicators: list[RiskIndicatorView]


class RiskRuleInfo(BaseModel):
    code: str
    description: str
    points: str


class RiskAnalysisPage(BaseModel):
    """Risk page payload: per-record assessments plus the rule catalogue."""

    rule_set: str
    rules: list[RiskRuleInfo]
    records: list[RiskRecordView]


class RetentionPolicyView(BaseModel):
    policy_id: str
    name: str
    version: str
    status: Literal["active", "draft", "retired"]
    scope: str
    retention_period_days: int
    effective_from: date
    applies_to_count: int
    notes: str


class HoldView(BaseModel):
    hold_id: str
    name: str
    scope: str
    records_in_scope: int


class ApprovalQueueItem(BaseModel):
    request_id: str
    action: str
    record_id: str
    requested_by: str


class SourceView(BaseModel):
    """A connected data source. Phase 1 has none — the list stays empty."""

    name: str
    source_type: str
    status: str


class RetentionPage(BaseModel):
    policies: list[RetentionPolicyView]
    active_holds: list[HoldView]
    approval_queue: list[ApprovalQueueItem]
