"""Source scanning and controlled metadata ingestion (Phase 4).

The service discovers metadata through a :class:`~app.services.connectors.base.SourceConnector`
and registers new records into the existing inventory. It never reads record
contents, moves files, deletes anything, or transmits data.

Lifecycle (every transition is checked):

    PENDING --start--> RUNNING --ok-----------> COMPLETED
                                --partial------> COMPLETED_WITH_ERRORS
                                --failure------> FAILED
                                --cancel-------> CANCELLED
    PENDING --cancel---------------------------> CANCELLED

Terminal jobs (COMPLETED / COMPLETED_WITH_ERRORS / FAILED / CANCELLED) never
change again. Rescans are idempotent: ``source_record_mappings`` maps a source
key to the asset it produced, so a record is never imported twice and historical
asset metadata is never overwritten.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Sequence
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.db.models import (
    DataSource,
    InventoryRecord,
    ScanError,
    ScanJob,
    ScanResult,
    SourceRecordMapping,
)
from app.services import audit
from app.services.connectors import (
    ConnectorError,
    DiscoveredRecord,
    LocalFolderConnector,
    SourceConnector,
    SyntheticConnector,
    UnauthorizedRootError,
)

#: All valid scan states.
ALL_STATUSES: tuple[str, ...] = (
    "PENDING",
    "RUNNING",
    "COMPLETED",
    "COMPLETED_WITH_ERRORS",
    "FAILED",
    "CANCELLED",
)

#: Terminal states: a job here can never transition again.
TERMINAL_STATUSES: frozenset[str] = frozenset(
    {"COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED", "CANCELLED"}
)

#: Allowed transitions between scan states.
VALID_TRANSITIONS: dict[str, frozenset[str]] = {
    "PENDING": frozenset({"RUNNING", "CANCELLED"}),
    "RUNNING": frozenset({"COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED", "CANCELLED"}),
    "COMPLETED": frozenset(),
    "COMPLETED_WITH_ERRORS": frozenset(),
    "FAILED": frozenset(),
    "CANCELLED": frozenset(),
}

_VALID_SENSITIVITIES = frozenset(
    {"public", "internal", "confidential", "restricted", "unknown"}
)


class InvalidTransition(ValueError):
    """Raised when a scan job is asked to make a transition it must not make."""


class ActiveScanExists(ValueError):
    """Raised when a source already has a queued or running scan."""


def can_transition(current: str, target: str) -> bool:
    """Return whether ``current -> target`` is a legal scan transition."""
    return target in VALID_TRANSITIONS.get(current, frozenset())


def transition(job: ScanJob, target: str) -> None:
    """Apply a status transition, raising :class:`InvalidTransition` if illegal."""
    if not can_transition(job.status, target):
        raise InvalidTransition(f"Cannot move a scan from {job.status!r} to {target!r}")
    job.status = target
    if target in TERMINAL_STATUSES:
        job.completed_at = _utcnow()


def build_connector(source: DataSource, settings: Settings | None = None) -> SourceConnector:
    """Construct the connector for a source, resolving allow-listed roots.

    Raises :class:`UnauthorizedRootError` when a local source references a root
    that is not configured server-side, and :class:`ConnectorError` for an
    unknown connector type.
    """
    settings = settings or get_settings()
    connector_type = source.connector_type or source.source_type
    if connector_type == "synthetic":
        return SyntheticConnector(config=source.config, source_name=source.name)
    if connector_type == "local_folder":
        root_key = source.root_key
        if not root_key:
            raise UnauthorizedRootError("Local source has no allow-listed root configured")
        root_path = settings.local_source_roots.get(root_key)
        if not root_path:
            raise UnauthorizedRootError(
                f"Root key {root_key!r} is not in the server allow-list"
            )
        return LocalFolderConnector(root_path=root_path)
    raise ConnectorError(f"Unsupported connector type: {connector_type!r}")


def validate_source(
    db: Session, source: DataSource, settings: Settings | None = None
) -> tuple[bool, str]:
    """Validate a source's configuration and access; persist the outcome."""
    ok = True
    message: str
    try:
        connector = build_connector(source, settings)
        connector.validate()
        connector.check_access()
        message = "Configuration valid and source reachable"
    except ConnectorError as exc:
        ok = False
        message = _safe_message(exc)
    source.last_validated_at = _utcnow()
    source.last_validation_ok = ok
    source.last_validation_message = message
    db.add(source)
    db.commit()
    db.refresh(source)
    audit.record_event(
        db,
        actor=source.created_by or "system",
        event_type="source.validated",
        entity_type="data_source",
        entity_id=source.id,
        payload={"ok": ok, "message": message},
    )
    return ok, message


def active_job_exists(db: Session, data_source_id: int) -> bool:
    """Return whether the source has a queued or running scan."""
    count = db.execute(
        select(func.count(ScanJob.id)).where(
            ScanJob.data_source_id == data_source_id,
            ScanJob.status.in_(("PENDING", "RUNNING")),
        )
    ).scalar()
    return bool(count)


def create_job(
    db: Session,
    source: DataSource,
    *,
    requested_by: str = "system",
    batch_size: int | None = None,
    retried_from_job_id: int | None = None,
    settings: Settings | None = None,
) -> ScanJob:
    """Create a PENDING scan job for a source, refusing duplicate active scans."""
    settings = settings or get_settings()
    if active_job_exists(db, source.id):
        raise ActiveScanExists(f"Source {source.id} already has a queued or running scan")
    resolved_batch = batch_size if batch_size is not None else settings.scan_batch_size
    job = ScanJob(
        data_source_id=source.id,
        institution_id=source.institution_id,
        status="PENDING",
        batch_size=max(1, min(int(resolved_batch), 5000)),
        requested_by=(requested_by or "system")[:120],
        retried_from_job_id=retried_from_job_id,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    audit.record_event(
        db,
        actor=job.requested_by,
        event_type="scan.created",
        entity_type="scan_job",
        entity_id=job.id,
        payload={
            "data_source_id": source.id,
            "connector_type": source.connector_type,
            "retried_from_job_id": retried_from_job_id,
        },
    )
    return job


def cancel_job(db: Session, job: ScanJob) -> ScanJob:
    """Cancel a job if its state allows it; raise :class:`InvalidTransition` otherwise."""
    if not can_transition(job.status, "CANCELLED"):
        raise InvalidTransition(f"A scan in status {job.status!r} cannot be cancelled")
    job.status = "CANCELLED"
    job.completed_at = _utcnow()
    db.add(job)
    db.commit()
    db.refresh(job)
    audit.record_event(
        db,
        actor=job.requested_by,
        event_type="scan.cancelled",
        entity_type="scan_job",
        entity_id=job.id,
        payload={"data_source_id": job.data_source_id},
    )
    return job


def run_scan(
    db: Session,
    job: ScanJob,
    *,
    connector: SourceConnector | None = None,
    settings: Settings | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> ScanJob:
    """Discover and ingest records for a PENDING job, returning the final job."""
    settings = settings or get_settings()
    if job.status != "PENDING":
        raise InvalidTransition(f"Cannot run a scan in status {job.status!r}")

    transition(job, "RUNNING")
    job.started_at = _utcnow()
    db.add(job)
    db.commit()
    db.refresh(job)
    audit.record_event(
        db,
        actor=job.requested_by,
        event_type="scan.started",
        entity_type="scan_job",
        entity_id=job.id,
        payload={"data_source_id": job.data_source_id},
    )

    source = db.get(DataSource, job.data_source_id)
    if source is None:
        return _fail(db, job, "Source no longer exists")

    try:
        active_connector = connector or build_connector(source, settings)
        active_connector.validate()
        active_connector.check_access()
    except ConnectorError as exc:
        return _fail(db, job, _safe_message(exc))

    seen: set[str] = set()
    truncated = False
    try:
        for batch in active_connector.iter_batches(batch_size=job.batch_size):
            if should_cancel is not None and should_cancel():
                db.commit()
                return cancel_job(db, job)

            for record in batch.records:
                if job.total_discovered >= settings.scan_max_records:
                    truncated = True
                    break
                job.total_discovered += 1
                _ingest_record(db, job, source, record, seen)

            for error in batch.errors:
                _record_error(
                    db,
                    job,
                    message=error.message,
                    source_key=error.source_key,
                    path=error.path,
                    severity=error.severity,
                )

            db.add(job)
            db.commit()
            db.refresh(job)
            if truncated:
                break
    except Exception:  # noqa: BLE001 - convert any failure into a FAILED job
        db.rollback()
        return _fail(db, job, "Scan failed unexpectedly while discovering records")

    if truncated:
        _record_error(
            db,
            job,
            message=f"Scan stopped after {settings.scan_max_records} records (limit reached)",
            severity="warning",
        )

    transition(job, _final_status(job))
    db.add(job)
    db.commit()
    db.refresh(job)
    audit.record_event(
        db,
        actor=job.requested_by,
        event_type="scan.completed",
        entity_type="scan_job",
        entity_id=job.id,
        payload={
            "status": job.status,
            "discovered": job.total_discovered,
            "imported": job.total_imported,
            "skipped": job.total_skipped,
            "errors": job.total_errors,
        },
    )
    return job


def retry_scan(
    db: Session,
    previous: ScanJob,
    *,
    requested_by: str = "system",
    settings: Settings | None = None,
) -> ScanJob:
    """Create and run a fresh job for the same source as a finished job."""
    if previous.status not in {"FAILED", "COMPLETED_WITH_ERRORS", "CANCELLED"}:
        raise InvalidTransition(
            f"Only a failed, partially-complete or cancelled scan can be retried "
            f"(current: {previous.status!r})"
        )
    source = db.get(DataSource, previous.data_source_id)
    if source is None:
        raise LookupError("Source no longer exists")
    job = create_job(
        db,
        source,
        requested_by=requested_by,
        batch_size=previous.batch_size,
        retried_from_job_id=previous.id,
        settings=settings,
    )
    audit.record_event(
        db,
        actor=requested_by,
        event_type="scan.retried",
        entity_type="scan_job",
        entity_id=job.id,
        payload={"retried_from_job_id": previous.id},
    )
    return run_scan(db, job, settings=settings)


def get_job(db: Session, job_id: int) -> ScanJob | None:
    return db.get(ScanJob, job_id)


def list_jobs(
    db: Session,
    *,
    data_source_id: int | None = None,
    institution_id: int | None = None,
    status: str | None = None,
    page: int = 1,
    per_page: int = 20,
) -> tuple[Sequence[ScanJob], int]:
    query = select(ScanJob)
    count_query = select(func.count(ScanJob.id))
    if data_source_id is not None:
        query = query.where(ScanJob.data_source_id == data_source_id)
        count_query = count_query.where(ScanJob.data_source_id == data_source_id)
    if institution_id is not None:
        query = query.where(ScanJob.institution_id == institution_id)
        count_query = count_query.where(ScanJob.institution_id == institution_id)
    if status:
        query = query.where(ScanJob.status == status)
        count_query = count_query.where(ScanJob.status == status)

    total = db.execute(count_query).scalar() or 0
    items = (
        db.execute(
            query.order_by(ScanJob.id.desc())
            .offset((page - 1) * per_page)
            .limit(per_page)
        )
        .scalars()
        .all()
    )
    return items, total


def list_results(
    db: Session, job_id: int, *, page: int = 1, per_page: int = 50
) -> tuple[Sequence[ScanResult], int]:
    count = (
        db.execute(
            select(func.count(ScanResult.id)).where(ScanResult.scan_job_id == job_id)
        ).scalar()
        or 0
    )
    items = (
        db.execute(
            select(ScanResult)
            .where(ScanResult.scan_job_id == job_id)
            .order_by(ScanResult.id.asc())
            .offset((page - 1) * per_page)
            .limit(per_page)
        )
        .scalars()
        .all()
    )
    return items, count


def list_errors(
    db: Session, job_id: int, *, page: int = 1, per_page: int = 50
) -> tuple[Sequence[ScanError], int]:
    count = (
        db.execute(
            select(func.count(ScanError.id)).where(ScanError.scan_job_id == job_id)
        ).scalar()
        or 0
    )
    items = (
        db.execute(
            select(ScanError)
            .where(ScanError.scan_job_id == job_id)
            .order_by(ScanError.id.asc())
            .offset((page - 1) * per_page)
            .limit(per_page)
        )
        .scalars()
        .all()
    )
    return items, count


# -- internals ---------------------------------------------------------------


def _final_status(job: ScanJob) -> str:
    if job.total_errors == 0:
        return "COMPLETED"
    if (job.total_imported + job.total_skipped) > 0:
        return "COMPLETED_WITH_ERRORS"
    return "FAILED"


def _ingest_record(
    db: Session,
    job: ScanJob,
    source: DataSource,
    record: DiscoveredRecord,
    seen: set[str],
) -> None:
    """Register one discovered record, updating a ScanResult row."""
    source_key = (record.source_key or "").strip()
    if not source_key:
        _record_result(
            db, job, record, status="error", error_message="Record has no source key"
        )
        _record_error(db, job, message="Record has no source key", severity="error")
        return

    if source_key in seen:
        _record_result(
            db,
            job,
            record,
            status="skipped",
            note="Duplicate source key within this scan",
        )
        job.total_skipped += 1
        return
    seen.add(source_key)

    now = _utcnow()
    mapping = db.execute(
        select(SourceRecordMapping).where(
            SourceRecordMapping.data_source_id == source.id,
            SourceRecordMapping.source_key == source_key,
        )
    ).scalar_one_or_none()

    if mapping is not None:
        mapping.observation_count += 1
        mapping.last_seen_at = now
        changed = False
        if (
            record.source_modified_at is not None
            and mapping.source_modified_at != record.source_modified_at
        ):
            mapping.source_modified_at = record.source_modified_at
            changed = True
        if record.checksum_sha256 and mapping.checksum_sha256 != record.checksum_sha256:
            mapping.checksum_sha256 = record.checksum_sha256
            changed = True
        db.add(mapping)
        _record_result(
            db,
            job,
            record,
            status="skipped",
            note=(
                "Source observation refreshed; asset left unchanged"
                if changed
                else "Already imported; skipped"
            ),
            imported_asset_id=mapping.asset_id,
        )
        job.total_skipped += 1
        return

    asset = _build_asset(job, source, source_key, record)
    db.add(asset)
    db.flush()
    mapping = SourceRecordMapping(
        data_source_id=source.id,
        institution_id=job.institution_id,
        source_key=source_key,
        asset_id=asset.id,
        checksum_sha256=record.checksum_sha256,
        observation_count=1,
        first_seen_at=now,
        last_seen_at=now,
        source_modified_at=record.source_modified_at,
    )
    db.add(mapping)
    db.flush()
    _record_result(
        db, job, record, status="imported", imported_asset_id=asset.id
    )
    job.total_imported += 1


def _build_asset(
    job: ScanJob, source: DataSource, source_key: str, record: DiscoveredRecord
) -> InventoryRecord:
    sensitivity = record.sensitivity if record.sensitivity in _VALID_SENSITIVITIES else "unknown"
    return InventoryRecord(
        institution_id=job.institution_id,
        data_source_id=source.id,
        external_id=_external_id(source_key),
        title=(record.title or source_key)[:300],
        record_type=(record.record_type or "file")[:100],
        category=record.category,
        source_type=source.connector_type or source.source_type,
        file_name=record.file_name,
        mime_type=record.mime_type,
        size_bytes=max(0, int(record.size_bytes)),
        checksum_sha256=record.checksum_sha256,
        sensitivity=sensitivity,
        contains_personal_data=bool(record.contains_personal_data),
        lifecycle_status="active",
        source_created_at=record.source_created_at,
        source_modified_at=record.source_modified_at,
    )


def _record_result(
    db: Session,
    job: ScanJob,
    record: DiscoveredRecord,
    *,
    status: str,
    note: str | None = None,
    error_message: str | None = None,
    imported_asset_id: int | None = None,
) -> None:
    db.add(
        ScanResult(
            scan_job_id=job.id,
            source_key=(record.source_key or "")[:512],
            status=status,
            title=(record.title or record.source_key or "unknown")[:300],
            record_type=(record.record_type or "file")[:100],
            category=record.category,
            file_name=record.file_name,
            mime_type=record.mime_type,
            size_bytes=max(0, int(record.size_bytes)),
            checksum_sha256=record.checksum_sha256,
            sensitivity=(
                record.sensitivity if record.sensitivity in _VALID_SENSITIVITIES else "unknown"
            ),
            contains_personal_data=bool(record.contains_personal_data),
            imported_asset_id=imported_asset_id,
            note=note,
            error_message=error_message,
        )
    )


def _record_error(
    db: Session,
    job: ScanJob,
    *,
    message: str,
    source_key: str | None = None,
    path: str | None = None,
    severity: str = "error",
) -> None:
    job.total_errors += 1
    db.add(
        ScanError(
            scan_job_id=job.id,
            source_key=source_key[:512] if source_key else None,
            path=path[:512] if path else None,
            error_message=message[:2000],
            severity=severity if severity in {"error", "warning"} else "error",
        )
    )


def _fail(db: Session, job: ScanJob, message: str) -> ScanJob:
    if can_transition(job.status, "FAILED"):
        transition(job, "FAILED")
    job.error_message = message[:2000]
    _record_error(db, job, message=message, severity="error")
    db.add(job)
    db.commit()
    db.refresh(job)
    audit.record_event(
        db,
        actor=job.requested_by,
        event_type="scan.failed",
        entity_type="scan_job",
        entity_id=job.id,
        payload={"message": message},
    )
    return job


def _external_id(source_key: str) -> str:
    """Fit a source key into the inventory's 100-char external id column."""
    if len(source_key) <= 100:
        return source_key
    return "h:" + hashlib.sha256(source_key.encode("utf-8")).hexdigest()


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _safe_message(exc: Exception) -> str:
    """Return a short, path-free message safe to persist and return."""
    text = str(exc).strip()
    return text[:2000] if text else exc.__class__.__name__
