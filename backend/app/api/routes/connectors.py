"""Source connector and scan-job API routes (Phase 4).

Discovery and metadata ingestion only. Nothing here reads record contents,
moves or deletes files, transmits data, or archives anything.

Authorization note (Phase 7, ADR-0014): every route requires a verified bearer
token. Reads need ``sources:read``; creating/updating sources, validating them,
and starting or retrying scans need ``sources:write``. A client-supplied
``institution_id`` is validated for consistency and then reconciled with the
verified identity — it is never proof of access — and a source or scan job
outside the caller's institution answers 404 so another tenant's existence is
not disclosed. Local-folder sources reference a server-side allow-list key
only; absolute paths are never accepted from, or returned to, clients.
"""

from __future__ import annotations

import math

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.schemas.connectors import (
    PaginatedScanErrors,
    PaginatedScanJobs,
    PaginatedScanResults,
    PaginatedSources,
    ScanCreate,
    ScanErrorRead,
    ScanJobRead,
    ScanRequest,
    ScanResultRead,
    Source,
    SourceCreate,
    SourceUpdate,
    SourceValidationResult,
)
from app.core.auth import (
    PERMISSION_SOURCES_READ,
    PERMISSION_SOURCES_WRITE,
    CurrentUser,
    ensure_institution_access,
    record_scope_denial,
    require_permission,
    resolve_institution_scope,
)
from app.core.config import get_settings
from app.db.models import DataSource, Institution
from app.db.session import get_db
from app.services import scan as scan_service

router = APIRouter()

_SOURCE_STATUSES = {"active", "inactive"}


def _validate_institution_exists(db: Session, institution_id: int | None) -> None:
    if institution_id is None:
        return
    if db.get(Institution, institution_id) is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Institution {institution_id} does not exist",
        )


def _pages(total: int, per_page: int) -> int:
    return math.ceil(total / per_page) if per_page else 0


def _get_source(
    db: Session,
    source_id: int,
    institution_id: int | None,
    current: CurrentUser,
    *,
    request: Request | None = None,
) -> DataSource:
    source = db.get(DataSource, source_id)
    if source is None or source.connector_type is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source not found")
    if institution_id is not None and source.institution_id != institution_id:
        # Do not reveal the existence of another institution's source.
        if request is not None:
            record_scope_denial(request, current, db)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source not found")
    ensure_institution_access(
        current, source.institution_id, request=request, db=db if request is not None else None
    )
    return source


def _get_job(
    db: Session,
    job_id: int,
    institution_id: int | None,
    current: CurrentUser,
    *,
    request: Request | None = None,
):
    job = scan_service.get_job(db, job_id)
    if job is None or (institution_id is not None and job.institution_id != institution_id):
        if job is not None and request is not None:
            record_scope_denial(request, current, db)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Scan job not found"
        )
    ensure_institution_access(
        current, job.institution_id, request=request, db=db if request is not None else None
    )
    return job


def _assert_name_available(
    db: Session, name: str, institution_id: int | None, *, exclude_id: int | None = None
) -> None:
    query = select(DataSource.id).where(
        DataSource.name == name, DataSource.institution_id.is_(None)
        if institution_id is None
        else DataSource.institution_id == institution_id
    )
    if exclude_id is not None:
        query = query.where(DataSource.id != exclude_id)
    if db.execute(query).first() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A source named {name!r} already exists in this institution",
        )


def _check_root_key(source_type: str, root_key: str | None) -> None:
    if source_type != "local_folder":
        return
    if not root_key:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A local_folder source requires a root_key",
        )
    allowed = get_settings().local_source_roots
    if root_key not in allowed:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Root key {root_key!r} is not configured. An operator must add it to "
                "LOCAL_SOURCE_ROOTS before this folder can be scanned."
            ),
        )


# -- sources -----------------------------------------------------------------


@router.post("/sources", response_model=Source, status_code=status.HTTP_201_CREATED)
def create_source(
    data: SourceCreate,
    request: Request,
    current: CurrentUser = Depends(require_permission(PERMISSION_SOURCES_WRITE)),
    db: Session = Depends(get_db),
) -> Source:
    _validate_institution_exists(db, data.institution_id)
    ensure_institution_access(current, data.institution_id, request=request, db=db)
    _check_root_key(data.connector_type, data.root_key)
    _assert_name_available(db, data.name, data.institution_id)

    source = DataSource(
        institution_id=data.institution_id,
        name=data.name,
        source_type=data.connector_type,
        connector_type=data.connector_type,
        root_key=data.root_key,
        config=dict(data.config or {}),
        created_by=current.email,
        status="active",
        actively_managed=True,
    )
    db.add(source)
    db.commit()
    db.refresh(source)
    from app.services import audit

    audit.record_event(
        db,
        actor=current.email,
        event_type="source.created",
        entity_type="data_source",
        entity_id=source.id,
        payload={"connector_type": source.connector_type, "institution_id": source.institution_id},
    )
    return source


@router.get("/sources", response_model=PaginatedSources)
def list_sources(
    db: Session = Depends(get_db),
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=20, ge=1, le=100),
    connector_type: str | None = Query(default=None),
    source_status: str | None = Query(default=None, alias="status"),
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_SOURCES_READ)),
) -> PaginatedSources:
    _validate_institution_exists(db, institution_id)
    scope = resolve_institution_scope(current, institution_id)
    query = select(DataSource).where(DataSource.connector_type.is_not(None))
    count_query = select(func.count(DataSource.id)).where(DataSource.connector_type.is_not(None))
    if connector_type:
        query = query.where(DataSource.connector_type == connector_type)
        count_query = count_query.where(DataSource.connector_type == connector_type)
    if source_status:
        query = query.where(DataSource.status == source_status)
        count_query = count_query.where(DataSource.status == source_status)
    if scope is not None:
        query = query.where(DataSource.institution_id == scope)
        count_query = count_query.where(DataSource.institution_id == scope)

    total = db.execute(count_query).scalar() or 0
    items = (
        db.execute(
            query.order_by(DataSource.name.asc())
            .offset((page - 1) * per_page)
            .limit(per_page)
        )
        .scalars()
        .all()
    )
    return PaginatedSources(
        items=[Source.model_validate(item) for item in items],
        total=total,
        page=page,
        per_page=per_page,
        pages=_pages(total, per_page),
    )


@router.get("/sources/{source_id}", response_model=Source)
def get_source(
    source_id: int,
    db: Session = Depends(get_db),
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_SOURCES_READ)),
) -> Source:
    return Source.model_validate(_get_source(db, source_id, institution_id, current))


@router.patch("/sources/{source_id}", response_model=Source)
def update_source(
    source_id: int,
    data: SourceUpdate,
    request: Request,
    db: Session = Depends(get_db),
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_SOURCES_WRITE)),
) -> Source:
    source = _get_source(db, source_id, institution_id, current, request=request)
    if data.name is not None and data.name != source.name:
        _assert_name_available(db, data.name, source.institution_id, exclude_id=source.id)
        source.name = data.name
    if data.root_key is not None:
        if source.connector_type != "local_folder":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Only a local_folder source has a root_key",
            )
        _check_root_key(source.connector_type, data.root_key)
        source.root_key = data.root_key
    if data.config is not None:
        source.config = data.config
    if data.status is not None:
        if data.status not in _SOURCE_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"status must be one of {sorted(_SOURCE_STATUSES)}",
            )
        source.status = data.status
    db.add(source)
    db.commit()
    db.refresh(source)
    return Source.model_validate(source)


@router.post("/sources/{source_id}/validate", response_model=SourceValidationResult)
def validate_source(
    source_id: int,
    request: Request,
    db: Session = Depends(get_db),
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_SOURCES_WRITE)),
) -> SourceValidationResult:
    source = _get_source(db, source_id, institution_id, current, request=request)
    ok, message = scan_service.validate_source(db, source)
    return SourceValidationResult(
        id=source.id, ok=ok, message=message, validated_at=source.last_validated_at
    )


# -- scans -------------------------------------------------------------------


@router.post(
    "/sources/{source_id}/scans",
    response_model=ScanJobRead,
    status_code=status.HTTP_201_CREATED,
)
def start_scan(
    source_id: int,
    request: Request,
    data: ScanRequest | None = None,
    db: Session = Depends(get_db),
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_SOURCES_WRITE)),
) -> ScanJobRead:
    source = _get_source(db, source_id, institution_id, current, request=request)
    return _create_and_maybe_run(db, source, data or ScanRequest(), current)


@router.post("/scan-jobs", response_model=ScanJobRead, status_code=status.HTTP_201_CREATED)
def create_scan(
    data: ScanCreate,
    request: Request,
    db: Session = Depends(get_db),
    current: CurrentUser = Depends(require_permission(PERMISSION_SOURCES_WRITE)),
) -> ScanJobRead:
    source = _get_source(db, data.data_source_id, None, current, request=request)
    request = ScanRequest(batch_size=data.batch_size, run=data.run)
    return _create_and_maybe_run(db, source, request, current)


@router.get("/scan-jobs", response_model=PaginatedScanJobs)
def list_scan_jobs(
    db: Session = Depends(get_db),
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=20, ge=1, le=100),
    data_source_id: int | None = Query(default=None),
    scan_status: str | None = Query(default=None, alias="status"),
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_SOURCES_READ)),
) -> PaginatedScanJobs:
    _validate_institution_exists(db, institution_id)
    items, total = scan_service.list_jobs(
        db,
        data_source_id=data_source_id,
        institution_id=resolve_institution_scope(current, institution_id),
        status=scan_status,
        page=page,
        per_page=per_page,
    )
    return PaginatedScanJobs(
        items=[ScanJobRead.model_validate(item) for item in items],
        total=total,
        page=page,
        per_page=per_page,
        pages=_pages(total, per_page),
    )


@router.get("/scan-jobs/{job_id}", response_model=ScanJobRead)
def get_scan_job(
    job_id: int,
    db: Session = Depends(get_db),
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_SOURCES_READ)),
) -> ScanJobRead:
    return ScanJobRead.model_validate(_get_job(db, job_id, institution_id, current))


@router.post("/scan-jobs/{job_id}/run", response_model=ScanJobRead)
def run_scan_job(
    job_id: int,
    request: Request,
    db: Session = Depends(get_db),
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_SOURCES_WRITE)),
) -> ScanJobRead:
    job = _get_job(db, job_id, institution_id, current, request=request)
    try:
        job = scan_service.run_scan(db, job)
    except scan_service.InvalidTransition as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return ScanJobRead.model_validate(job)


@router.post("/scan-jobs/{job_id}/cancel", response_model=ScanJobRead)
def cancel_scan_job(
    job_id: int,
    request: Request,
    db: Session = Depends(get_db),
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_SOURCES_WRITE)),
) -> ScanJobRead:
    job = _get_job(db, job_id, institution_id, current, request=request)
    try:
        job = scan_service.cancel_job(db, job)
    except scan_service.InvalidTransition as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return ScanJobRead.model_validate(job)


@router.post(
    "/scan-jobs/{job_id}/retry",
    response_model=ScanJobRead,
    status_code=status.HTTP_201_CREATED,
)
def retry_scan_job(
    job_id: int,
    request: Request,
    db: Session = Depends(get_db),
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_SOURCES_WRITE)),
) -> ScanJobRead:
    job = _get_job(db, job_id, institution_id, current, request=request)
    try:
        new_job = scan_service.retry_scan(db, job)
    except scan_service.InvalidTransition as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except scan_service.ActiveScanExists as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return ScanJobRead.model_validate(new_job)


@router.get("/scan-jobs/{job_id}/results", response_model=PaginatedScanResults)
def list_scan_results(
    job_id: int,
    db: Session = Depends(get_db),
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=50, ge=1, le=200),
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_SOURCES_READ)),
) -> PaginatedScanResults:
    _get_job(db, job_id, institution_id, current)
    items, total = scan_service.list_results(db, job_id, page=page, per_page=per_page)
    return PaginatedScanResults(
        items=[ScanResultRead.model_validate(item) for item in items],
        total=total,
        page=page,
        per_page=per_page,
        pages=_pages(total, per_page),
    )


@router.get("/scan-jobs/{job_id}/errors", response_model=PaginatedScanErrors)
def list_scan_errors(
    job_id: int,
    db: Session = Depends(get_db),
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=50, ge=1, le=200),
    institution_id: int | None = Query(default=None),
    current: CurrentUser = Depends(require_permission(PERMISSION_SOURCES_READ)),
) -> PaginatedScanErrors:
    _get_job(db, job_id, institution_id, current)
    items, total = scan_service.list_errors(db, job_id, page=page, per_page=per_page)
    return PaginatedScanErrors(
        items=[ScanErrorRead.model_validate(item) for item in items],
        total=total,
        page=page,
        per_page=per_page,
        pages=_pages(total, per_page),
    )


# -- internals ---------------------------------------------------------------


def _create_and_maybe_run(
    db: Session, source: DataSource, request: ScanRequest, current: CurrentUser
) -> ScanJobRead:
    try:
        job = scan_service.create_job(
            db, source, batch_size=request.batch_size, requested_by=current.email
        )
    except scan_service.ActiveScanExists as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    if request.run:
        job = scan_service.run_scan(db, job)
    return ScanJobRead.model_validate(job)
