"""Explainable risk indicator rules (Phase 1 foundation).

These are deterministic, documented, unit-tested rules — not an arbitrary
black-box score. Each input feature contributes a fixed number of points, the
total is capped at 100, and every contribution is returned with a human-readable
explanation so dashboards can show *why* a record scored as it did.

Rule table (see docs/decisions.md for the decision record):

======================================  =========  ==================================
Feature                                 Points     Condition
======================================  =========  ==================================
contains_personal_data                  +30        record contains personal data
sensitivity = "restricted"              +30        classification level
sensitivity = "confidential"            +20        classification level
sensitivity = "internal"                +10        classification level
sensitivity = "public"                  +0         classification level
duplicate_candidate                     +10        flagged as duplicate candidate
past_retention_review                   +20        retention review date already passed
unmanaged_source                        +10        source system no longer actively managed
======================================  =========  ==================================

Severity bands: 0–24 low | 25–49 moderate | 50–74 high | 75–100 critical.

Scope note: these indicators quantify *privacy/retention exposure* for the
dashboard only. They are not a security risk rating, and Phase 1 performs no
scanning or automated decision-making.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

SensitivityLevel = Literal["public", "internal", "confidential", "restricted"]
RiskBand = Literal["low", "moderate", "high", "critical"]

SENSITIVITY_POINTS: dict[str, int] = {
    "public": 0,
    "internal": 10,
    "confidential": 20,
    "restricted": 30,
}

MAX_SCORE = 100

BAND_THRESHOLDS: tuple[tuple[int, RiskBand], ...] = (
    (75, "critical"),
    (50, "high"),
    (25, "moderate"),
    (0, "low"),
)


@dataclass(frozen=True)
class RecordRiskFeatures:
    """Input features for the risk indicator rules."""

    record_id: str
    sensitivity: SensitivityLevel
    contains_personal_data: bool
    duplicate_candidate: bool
    past_retention_review: bool
    source_managed: bool


@dataclass(frozen=True)
class RiskIndicator:
    """A single explainable contribution to the risk score."""

    code: str
    label: str
    points: int
    explanation: str


@dataclass(frozen=True)
class RiskAssessment:
    """Result of applying the rules to one record."""

    record_id: str
    score: int
    band: RiskBand
    indicators: tuple[RiskIndicator, ...]


def compute_risk(record: RecordRiskFeatures) -> RiskAssessment:
    """Apply the documented rules and return an explainable assessment."""
    indicators: list[RiskIndicator] = []

    if record.contains_personal_data:
        indicators.append(
            RiskIndicator(
                code="personal_data",
                label="Personal data present",
                points=30,
                explanation="Record is flagged as containing personal data (+30).",
            )
        )

    sensitivity_pts = SENSITIVITY_POINTS[record.sensitivity]
    if sensitivity_pts:
        indicators.append(
            RiskIndicator(
                code="sensitivity",
                label=f"Sensitivity: {record.sensitivity}",
                points=sensitivity_pts,
                explanation=(
                    f"Sensitivity level '{record.sensitivity}' contributes "
                    f"(+{sensitivity_pts})."
                ),
            )
        )

    if record.duplicate_candidate:
        indicators.append(
            RiskIndicator(
                code="duplicate",
                label="Duplicate candidate",
                points=10,
                explanation=(
                    "Record is a duplicate candidate, increasing sprawl and "
                    "breach surface (+10)."
                ),
            )
        )

    if record.past_retention_review:
        indicators.append(
            RiskIndicator(
                code="past_retention_review",
                label="Past retention review date",
                points=20,
                explanation=(
                    "Retention review date has passed without a recorded "
                    "disposition decision (+20)."
                ),
            )
        )

    if not record.source_managed:
        indicators.append(
            RiskIndicator(
                code="unmanaged_source",
                label="Source not actively managed",
                points=10,
                explanation="Source system is no longer actively managed (+10).",
            )
        )

    score = min(MAX_SCORE, sum(indicator.points for indicator in indicators))
    return RiskAssessment(
        record_id=record.record_id,
        score=score,
        band=band_for_score(score),
        indicators=tuple(indicators),
    )


def band_for_score(score: int) -> RiskBand:
    """Map a 0–100 score to a severity band."""
    bounded = max(0, min(MAX_SCORE, score))
    for threshold, band in BAND_THRESHOLDS:
        if bounded >= threshold:
            return band
    return "low"  # pragma: no cover - defensive fallback
