"""Unit tests for the documented risk indicator rules (docs/decisions.md)."""

from __future__ import annotations

from app.services.risk import (
    RecordRiskFeatures,
    band_for_score,
    compute_risk,
)


def _features(**overrides: object) -> RecordRiskFeatures:
    base: dict[str, object] = {
        "record_id": "SYNTH-TEST-1",
        "sensitivity": "public",
        "contains_personal_data": False,
        "duplicate_candidate": False,
        "past_retention_review": False,
        "source_managed": True,
    }
    base.update(overrides)
    return RecordRiskFeatures(**base)  # type: ignore[arg-type]


def test_clean_public_record_scores_zero() -> None:
    assessment = compute_risk(_features())
    assert assessment.score == 0
    assert assessment.band == "low"
    assert assessment.indicators == ()


def test_personal_data_adds_thirty() -> None:
    assessment = compute_risk(_features(contains_personal_data=True))
    assert assessment.score == 30
    assert assessment.band == "moderate"
    assert assessment.indicators[0].code == "personal_data"


def test_sensitivity_points_match_documented_table() -> None:
    assert compute_risk(_features(sensitivity="internal")).score == 10
    assert compute_risk(_features(sensitivity="confidential")).score == 20
    assert compute_risk(_features(sensitivity="restricted")).score == 30


def test_duplicate_and_unmanaged_and_past_review() -> None:
    assessment = compute_risk(
        _features(duplicate_candidate=True, source_managed=False, past_retention_review=True)
    )
    assert assessment.score == 10 + 10 + 20
    codes = [i.code for i in assessment.indicators]
    assert codes == ["duplicate", "past_retention_review", "unmanaged_source"]


def test_all_features_capped_at_100() -> None:
    assessment = compute_risk(
        _features(
            sensitivity="restricted",
            contains_personal_data=True,
            duplicate_candidate=True,
            past_retention_review=True,
            source_managed=False,
        )
    )
    # Raw total would be 30+30+10+20+10 = 100
    assert assessment.score == 100
    assert assessment.band == "critical"


def test_band_thresholds() -> None:
    assert band_for_score(0) == "low"
    assert band_for_score(24) == "low"
    assert band_for_score(25) == "moderate"
    assert band_for_score(49) == "moderate"
    assert band_for_score(50) == "high"
    assert band_for_score(74) == "high"
    assert band_for_score(75) == "critical"
    assert band_for_score(100) == "critical"
    assert band_for_score(-5) == "low"  # clamped
    assert band_for_score(150) == "critical"  # clamped


def test_indicators_explain_every_point() -> None:
    assessment = compute_risk(
        _features(
            sensitivity="confidential",
            contains_personal_data=True,
            duplicate_candidate=True,
        )
    )
    assert sum(i.points for i in assessment.indicators) == assessment.score
    for indicator in assessment.indicators:
        assert indicator.explanation
        assert f"+{indicator.points}" in indicator.explanation
