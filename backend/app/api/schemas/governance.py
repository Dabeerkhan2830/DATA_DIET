"""Schemas for the unified asset governance view (Phase 6).

The view joins existing subsystems for one authorized asset. Every block is
labelled with its provenance so the UI can distinguish observed source metadata
from system-generated proposals, retention assessments, and human decisions.
Nothing here describes a file operation, because no file operation exists yet.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from app.api.schemas.assets import Asset
from app.api.schemas.classification import ClassificationResultSchema, QualityFindingSchema
from app.api.schemas.retention import Assessment, Decision, Hold


class GovernanceSourceMapping(BaseModel):
    """One source-record mapping (observed provenance for this asset)."""

    mapping_id: int
    source_key: str
    data_source_id: int
    checksum_sha256: str | None = None
    observation_count: int
    first_seen_at: datetime | None = None
    last_seen_at: datetime | None = None
    source_modified_at: datetime | None = None


class GovernanceScanSummary(BaseModel):
    """Latest discovery run that produced assets for this data source."""

    scan_job_id: int
    status: str
    total_discovered: int
    total_imported: int
    total_skipped: int
    total_errors: int
    requested_by: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    created_at: datetime | None = None
    error_message: str | None = None


class GovernanceSourceInfo(BaseModel):
    data_source_id: int
    data_source_name: str | None = None
    source_type: str | None = None
    connector_type: str | None = None
    institution_id: int | None = None
    mapping_present: bool
    mappings: list[GovernanceSourceMapping]
    latest_scan: GovernanceScanSummary | None = None
    #: Explicit reasons a field is unavailable; never fabricate a source value.
    notes: list[str]


class GovernancePolicyContext(BaseModel):
    """The single applicable active policy and the exact version applied."""

    policy_id: int
    name: str
    status: str
    version_id: int | None = None
    version_number: int | None = None
    retention_period_days: int | None = None
    retention_trigger: str | None = None
    recommended_action: str | None = None
    applicable_categories: list[str] | None = None


class GovernanceReviewContext(BaseModel):
    """Version tokens the review form echoes back to detect stale reviews.

    All values are derived server-side from the latest assessment and the
    current active-hold count; a client cannot influence them.
    """

    latest_assessment_id: int | None = None
    expected_assessed_at: datetime | None = None
    expected_policy_version_id: int | None = None
    expected_holds_active: int | None = None
    decisions_recorded: int = 0


class GovernanceProvenance(BaseModel):
    """Labels for each information source, so the view is never ambiguous."""

    observed: list[str]
    system_proposed: list[str]
    assessed: list[str]
    human_decisions: list[str]
    #: Fixed statement: the application performs no archive/restore/delete.
    file_operations: str


class GovernanceDetail(BaseModel):
    asset: Asset
    source: GovernanceSourceInfo
    classification: ClassificationResultSchema | None = None
    quality_findings: list[QualityFindingSchema]
    applicable_policy: GovernancePolicyContext | None = None
    latest_assessment: Assessment | None = None
    assessment_history: list[Assessment]
    active_holds: list[Hold]
    decisions: list[Decision]
    #: The decision the institution currently stands behind: the newest entry in
    #: ``decisions`` that no later decision superseded (Phase 7). Superseded
    #: decisions stay in ``decisions`` so history remains auditable.
    effective_decision_id: int | None = None
    review_context: GovernanceReviewContext
    provenance: GovernanceProvenance
