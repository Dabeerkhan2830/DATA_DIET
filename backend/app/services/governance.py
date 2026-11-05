"""Unified, read-only asset governance view (Phase 6).

Combines, for one authorized asset:

* inventory metadata and its source-record mappings / latest scan,
* the latest classification proposal (Phase 5),
* data-quality findings and suggested remediation (Phase 5),
* the single applicable active retention policy and exact version (Phase 3),
* the latest retention assessment and its full history (Phase 3),
* active holds and their blocking effect, and
* the append-only human review decisions.

This module is strictly read-only. It never runs an assessment, never mutates a
record, and never performs a file operation. Missing information is returned as
explicit ``None`` (with a reason where useful); nothing is fabricated, and no
field implies that a file was archived, restored, or deleted.
"""

from __future__ import annotations

from sqlalchemy import desc, or_, select
from sqlalchemy.orm import Session

from app.api.schemas.assets import Asset
from app.api.schemas.classification import ClassificationResultSchema, QualityFindingSchema
from app.api.schemas.governance import (
    GovernanceDetail,
    GovernancePolicyContext,
    GovernanceProvenance,
    GovernanceReviewContext,
    GovernanceScanSummary,
    GovernanceSourceInfo,
    GovernanceSourceMapping,
)
from app.api.schemas.retention import Hold
from app.db.models import (
    DataSource,
    InventoryRecord,
    RetentionHold,
    ScanJob,
    SourceRecordMapping,
)
from app.services import classification as classification_service
from app.services import data_quality as data_quality_service
from app.services import retention as retention_service

#: Fixed statement returned with every view. Kept in one place so no endpoint
#: can accidentally claim a file operation happened.
FILE_OPERATIONS_NOTE = (
    "Not implemented. This view never archives, restores, moves, or deletes a "
    "file; approving a recommendation is not an execution command."
)


def _scan_summary(job: ScanJob | None) -> GovernanceScanSummary | None:
    if job is None:
        return None
    return GovernanceScanSummary(
        scan_job_id=job.id,
        status=job.status,
        total_discovered=job.total_discovered,
        total_imported=job.total_imported,
        total_skipped=job.total_skipped,
        total_errors=job.total_errors,
        requested_by=job.requested_by,
        started_at=job.started_at,
        completed_at=job.completed_at,
        created_at=job.created_at,
        error_message=job.error_message,
    )


def _active_holds(db: Session, asset: InventoryRecord) -> list[RetentionHold]:
    """Active holds that block this asset (asset-specific or institution-wide).

    Mirrors :func:`retention.count_active_holds_for_asset` so the number shown
    in the view matches the number the decision guard recomputes.
    """
    q = select(RetentionHold).where(
        RetentionHold.status == "active",
        or_(
            RetentionHold.asset_id == asset.id,
            RetentionHold.asset_id.is_(None),
        ),
    )
    if asset.institution_id is not None:
        q = q.where(RetentionHold.institution_id == asset.institution_id)
    return list(db.execute(q.order_by(RetentionHold.id.desc())).scalars().all())


def _source_info(db: Session, asset: InventoryRecord) -> GovernanceSourceInfo:
    source = db.get(DataSource, asset.data_source_id)
    mappings = list(
        db.execute(
            select(SourceRecordMapping)
            .where(SourceRecordMapping.asset_id == asset.id)
            .order_by(SourceRecordMapping.id)
        )
        .scalars()
        .all()
    )
    latest_scan: ScanJob | None = None
    if source is not None:
        latest_scan = (
            db.execute(
                select(ScanJob)
                .where(ScanJob.data_source_id == asset.data_source_id)
                .order_by(desc(ScanJob.created_at), desc(ScanJob.id))
                .limit(1)
            )
            .scalars()
            .first()
        )

    notes: list[str] = []
    if source is None:
        notes.append(
            "The asset's data source no longer exists; source metadata is unavailable."
        )
    if not mappings:
        notes.append(
            "No source-record mapping exists, so this asset was not produced by a "
            "connector scan (or its mapping is absent)."
        )

    return GovernanceSourceInfo(
        data_source_id=asset.data_source_id,
        data_source_name=source.name if source else None,
        source_type=source.source_type if source else asset.source_type,
        connector_type=source.connector_type if source else None,
        institution_id=source.institution_id if source else asset.institution_id,
        mapping_present=bool(mappings),
        mappings=[
            GovernanceSourceMapping(
                mapping_id=m.id,
                source_key=m.source_key,
                data_source_id=m.data_source_id,
                checksum_sha256=m.checksum_sha256,
                observation_count=m.observation_count,
                first_seen_at=m.first_seen_at,
                last_seen_at=m.last_seen_at,
                source_modified_at=m.source_modified_at,
            )
            for m in mappings
        ],
        latest_scan=_scan_summary(latest_scan),
        notes=notes,
    )


def _policy_context(
    db: Session, asset: InventoryRecord
) -> GovernancePolicyContext | None:
    """Read-only policy selection; no assessment row is created here."""
    policy, version, _findings = retention_service.select_policy(db, asset)
    if policy is None:
        return None

    def pick(attr: str) -> object:
        if version is not None and getattr(version, attr, None) is not None:
            return getattr(version, attr)
        return getattr(policy, attr, None)

    return GovernancePolicyContext(
        policy_id=policy.id,
        name=policy.name,
        status=policy.status,
        version_id=version.id if version else None,
        version_number=version.version_number if version else None,
        retention_period_days=pick("retention_period_days"),  # type: ignore[arg-type]
        retention_trigger=pick("retention_trigger"),  # type: ignore[arg-type]
        recommended_action=pick("recommended_action"),  # type: ignore[arg-type]
        applicable_categories=pick("applicable_categories"),  # type: ignore[arg-type]
    )


def asset_governance(
    db: Session, asset_id: int, institution_id: int | None = None
) -> GovernanceDetail:
    """Assemble the unified governance view for one authorized asset.

    Raises ``ValueError("asset_not_found")`` or
    ``ValueError("asset_out_of_scope")`` so the route can map both to a 404.
    """
    asset = db.get(InventoryRecord, asset_id)
    if asset is None:
        raise ValueError("asset_not_found")
    if institution_id is not None and asset.institution_id != institution_id:
        raise ValueError("asset_out_of_scope")

    source_info = _source_info(db, asset)

    classification_row = classification_service.get_latest(db, asset_id)
    classification = (
        ClassificationResultSchema.model_validate(classification_row)
        if classification_row is not None
        else None
    )

    findings = data_quality_service.analyze_inventory(
        db, institution_id=asset.institution_id, asset_id=asset_id
    )
    quality_findings = [QualityFindingSchema(**f.as_dict()) for f in findings]

    policy_context = _policy_context(db, asset)

    assessment_history = retention_service.get_assessment_history(db, asset_id)
    latest_assessment = assessment_history[0] if assessment_history else None

    holds = _active_holds(db, asset)
    current_holds = retention_service.count_active_holds_for_asset(
        db, asset_id, asset.institution_id
    )
    decisions = retention_service.list_decisions_for_asset(
        db, asset_id, institution_id=asset.institution_id
    )

    provenance = GovernanceProvenance(
        observed=["inventory metadata", "source-record mappings", "latest scan"],
        system_proposed=["classification"] if classification else [],
        assessed=["retention assessment"] if latest_assessment else [],
        human_decisions=[f"decision #{d.id}" for d in decisions],
        file_operations=FILE_OPERATIONS_NOTE,
    )

    return GovernanceDetail(
        asset=Asset.model_validate(asset),
        source=source_info,
        classification=classification,
        quality_findings=quality_findings,
        applicable_policy=policy_context,
        latest_assessment=latest_assessment,
        assessment_history=assessment_history,
        active_holds=[Hold.model_validate(h) for h in holds],
        decisions=decisions,
        effective_decision_id=retention_service.effective_decision_id(decisions),
        review_context=GovernanceReviewContext(
            latest_assessment_id=latest_assessment.id if latest_assessment else None,
            expected_assessed_at=(
                latest_assessment.assessed_at if latest_assessment else None
            ),
            expected_policy_version_id=(
                latest_assessment.policy_version_id if latest_assessment else None
            ),
            expected_holds_active=current_holds,
            decisions_recorded=len(decisions),
        ),
        provenance=provenance,
    )
