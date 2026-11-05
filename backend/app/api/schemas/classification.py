"""Schemas for classification and data-quality (Phase 5)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

Confidence = Literal["high", "medium", "low", "none"]
Outcome = Literal["classified", "partially_classified", "unclassified"]
ProposedSensitivity = Literal["public", "internal", "confidential", "restricted", "unknown"]
Severity = Literal["info", "low", "medium", "high"]


class EvidenceItem(BaseModel):
    rule_id: str
    rule_version: str
    field: str
    observed: str | None = None
    proposed_category: str | None = None
    proposed_sensitivity: str | None = None
    note: str | None = None


class ConflictItem(BaseModel):
    field: str
    values: list[str]
    resolved_to: str
    reason: str


class ClassificationResultSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    asset_id: int
    institution_id: int | None = None
    rule_version: str
    outcome: Outcome
    proposed_category: str | None = None
    proposed_sensitivity: ProposedSensitivity
    confidence: Confidence
    confidence_meaning: str
    evidence: list[EvidenceItem]
    warnings: list[str]
    conflicts: list[ConflictItem]
    input_fingerprint: str
    created_by: str
    classified_at: datetime


class ClassificationResultListResponse(BaseModel):
    results: list[ClassificationResultSchema]
    total: int
    page: int
    per_page: int
    total_pages: int


class RuleDescriptorSchema(BaseModel):
    rule_id: str
    field: str
    effect: str
    confidence: Confidence
    description: str


class ClassificationRulesSchema(BaseModel):
    rule_version: str
    rules: list[RuleDescriptorSchema]
    confidence_meaning: dict[Confidence, str]
    outcomes: list[Outcome]
    sensitivities: list[ProposedSensitivity]
    known_categories: list[str]
    severities: list[Severity]


class QualityFindingSchema(BaseModel):
    asset_id: int
    check: str
    severity: Severity
    message: str
    fields: list[str]
    evidence: dict[str, Any]
    remediation: str
    duplicate_status: str | None = None
    related_asset_id: int | None = None


class QualityReportSchema(BaseModel):
    asset_id: int
    findings: list[QualityFindingSchema]


class PaginatedQualityFindings(BaseModel):
    findings: list[QualityFindingSchema]
    total: int
    page: int
    per_page: int
    total_pages: int
