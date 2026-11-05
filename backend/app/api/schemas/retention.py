"""Schemas for retention policies, holds, and assessments."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator, model_validator

PolicyStatus = Literal["draft", "approved", "active", "retired", "inactive"]
PolicyVersionStatus = Literal["draft", "approved", "active", "retired"]
HoldStatus = Literal["active", "released"]
RetentionTrigger = Literal["created_at", "modified_at", "last_reviewed", "source_created_at"]
Recommendation = Literal[
    "RETAIN",
    "ARCHIVE_RECOMMENDED",
    "REVIEW_REQUIRED",
    "DISPOSAL_REVIEW_REQUIRED",
    "BLOCKED_BY_HOLD",
    "NO_APPLICABLE_POLICY",
]
#: A reviewer keeps the record, asks for more information, approves a
#: recommendation for a later, separately authorized workflow, or rejects the
#: recommendation outright. Reasons are mandatory when rejecting or requesting
#: more information (enforced by :class:`DecisionCreate`).
DecisionValue = Literal[
    "retain",
    "request_more_information",
    "approve_for_later_workflow",
    "reject",
]
Severity = Literal["informational", "low", "medium", "high", "blocked"]


class PolicyCreate(BaseModel):
    institution_id: int | None = None
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    applicable_categories: list[str] | None = None
    retention_period_days: int | None = Field(default=None, ge=0)
    retention_trigger: RetentionTrigger | None = None
    recommended_action: str | None = Field(default=None, max_length=30)
    scope_description: str | None = None


class PolicyUpdate(BaseModel):
    description: str | None = None
    applicable_categories: list[str] | None = None
    retention_period_days: int | None = Field(default=None, ge=0)
    retention_trigger: RetentionTrigger | None = None
    recommended_action: str | None = Field(default=None, max_length=30)
    status: PolicyStatus | None = None
    scope_description: str | None = None
    current_version_id: int | None = None


class Policy(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    institution_id: int | None
    name: str
    description: str | None
    applicable_categories: list[str] | None
    retention_trigger: RetentionTrigger | None
    retention_period_days: int | None
    recommended_action: str | None
    status: PolicyStatus
    scope_description: str | None
    current_version_id: int | None
    version: str | None = None
    created_by: str | None = None
    created_at: datetime


class PolicyVersionCreate(BaseModel):
    description: str | None = None
    applicable_categories: list[str] | None = None
    retention_period_days: int | None = Field(default=None, ge=0)
    retention_trigger: RetentionTrigger | None = None
    conditions: dict[str, Any] | None = None
    recommended_action: str | None = Field(default=None, max_length=30)
    effective_from: date | None = None
    effective_to: date | None = None
    status: PolicyVersionStatus = "draft"


class PolicyVersion(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    policy_id: int
    version_number: int
    status: PolicyVersionStatus
    description: str | None
    applicable_categories: list[str] | None
    retention_period_days: int | None
    retention_trigger: RetentionTrigger | None
    conditions: dict[str, Any] | None
    recommended_action: str | None
    effective_from: date | None
    effective_to: date | None
    created_by: str | None
    created_at: datetime
    approved_by: str | None
    approved_at: datetime | None


class PolicyActivate(BaseModel):
    version_id: int


class HoldCreate(BaseModel):
    institution_id: int | None = None
    asset_id: int | None = None
    asset_scope: dict[str, Any] | None = None
    name: str = Field(min_length=1, max_length=200)
    hold_type: str | None = Field(default=None, max_length=50)
    legal_basis: str | None = Field(default=None, max_length=200)
    scope: list[dict[str, Any]] | None = None
    reason: str | None = None

    @field_validator("scope")
    @classmethod
    def _default_scope(
        cls, v: list[dict[str, Any]] | None, info: ValidationInfo
    ) -> list[dict[str, Any]]:
        if v is not None:
            return v
        if info.data.get("asset_scope") is not None:
            return [info.data["asset_scope"]]
        return []


class HoldRelease(BaseModel):
    release_reason: str | None = None


class Hold(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    institution_id: int | None
    asset_id: int | None
    asset_scope: dict[str, Any] | None
    name: str
    hold_type: str | None
    legal_basis: str | None
    scope: list[dict[str, Any]] | None
    status: HoldStatus
    created_by: str | None
    created_at: datetime
    released_by: str | None
    released_at: datetime | None
    release_reason: str | None


class AssessmentFinding(BaseModel):
    code: str
    severity: Severity
    message: str
    evidence: dict[str, Any] | None = None


class Assessment(BaseModel):
    id: int | None = None
    asset_id: int
    institution_id: int | None = None
    policy_id: int | None
    policy_version_id: int | None
    policy_version_number: int | None
    rule_set: str
    assessed_at: datetime
    recommendation: Recommendation
    rationale: str
    findings: list[AssessmentFinding]
    holds_active: int
    unresolved_conditions: list[str]
    trigger_date: date | None = None
    retention_period_days: int | None = None
    retention_deadline: date | None = None


class AssessmentHistoryItem(Assessment):
    id: int | None = None


class DecisionCreate(BaseModel):
    """A human review decision about one assessment.

    Advisory only: recording a decision executes no file operation.

    The reviewer is **not** accepted from the client. The server writes the
    verified identity of the caller onto the decision (ADR-0014), so a
    submitted ``reviewer`` name can never become attribution.

    The caller submits the versions of the assessment and policy that were on
    screen. ``expected_assessed_at`` / ``expected_policy_version_id`` /
    ``expected_holds_active`` are optimistic-concurrency tokens: when they do not
    match the server's current state the submission is rejected as stale rather
    than recorded against the wrong version (Phase 6, ADR-0013).
    """

    decision: DecisionValue
    reason: str = Field(min_length=1, max_length=4000)
    expected_assessed_at: datetime | None = None
    expected_policy_version_id: int | None = None
    expected_holds_active: int | None = None
    #: Optional correction: the id of the earlier decision this one replaces.
    #: The original row is preserved; the server derives and validates the
    #: lineage (Phase 7, ADR-0015).
    supersedes_decision_id: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def _require_substantive_reason(self) -> DecisionCreate:
        """Rejections, information requests, and corrections need a rationale.

        A ``model_validator`` reads every field at once, so the rule does not
        depend on declaration order.
        """
        if len(self.reason.strip()) < 10:
            if self.decision in ("reject", "request_more_information"):
                raise ValueError(
                    "A rejection or request for more information needs a substantive "
                    "reason (at least 10 characters)."
                )
            if self.supersedes_decision_id is not None:
                raise ValueError(
                    "A decision that supersedes an earlier decision needs a substantive "
                    "reason (at least 10 characters) explaining the correction."
                )
        return self


class Decision(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    assessment_id: int
    asset_id: int
    institution_id: int | None
    policy_id: int | None
    policy_version_id: int | None
    recommendation_reviewed: Recommendation
    decision: DecisionValue
    reason: str
    reviewer: str
    decided_at: datetime
    #: The decision this one replaces, or ``None`` for an original decision.
    supersedes_decision_id: int | None = None
    #: Derived (never stored twice): whether a later decision replaced this one.
    is_superseded: bool = False
    superseded_by_decision_id: int | None = None


class RecommendationItem(BaseModel):
    id: int | None = None
    asset_id: int
    asset_title: str | None = None
    institution_id: int | None = None
    recommendation: Recommendation
    rationale: str
    severity: Severity | None = None
    policy_id: int | None = None
    policy_version_id: int | None = None
    policy_version_number: int | None = None
    holds_active: int
    assessed_at: datetime
    findings: list[AssessmentFinding] | None = None
    retention_deadline: date | None = None
    days_overdue: int | None = None
    decisions_recorded: int = 0
    #: ``open`` when the latest assessment has no recorded decision yet,
    #: ``decided`` once one exists. Always derived server-side.
    review_status: Literal["open", "decided"] | None = None
    #: The most recent decision value on the latest assessment, if any.
    latest_decision: DecisionValue | None = None


class PaginatedRecommendations(BaseModel):
    items: list[RecommendationItem]
    total: int
    page: int
    per_page: int
    pages: int
