"""SQLAlchemy 2.0 models - source of truth for the DataDiet schema.

Every table here mirrors the Alembic revision history under
``database/migrations/versions`` (0001-0004). When the schema changes, update a
model **and** add a migration; never edit an applied migration.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """Declarative base for all DataDiet tables."""


class Institution(Base):
    """Institution/tenant boundary for data isolation (Phase 2 foundation)."""

    __tablename__ = "institutions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(50), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (Index("ix_institutions_code", "code"),)


class DataSource(Base):
    """A configured system of record that inventory records originate from."""

    __tablename__ = "data_sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    institution_id: Mapped[int | None] = mapped_column(
        ForeignKey("institutions.id", ondelete="RESTRICT"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    source_type: Mapped[str] = mapped_column(String(50), nullable=False)
    # Phase 4: connector-backed sources. ``connector_type`` is one of
    # ``synthetic`` / ``local_folder``; ``root_key`` is an allow-list key that
    # is resolved server-side (never a client-supplied path). ``config`` holds
    # non-secret connector parameters only.
    connector_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    root_key: Mapped[str | None] = mapped_column(String(100), nullable=True)
    config: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_by: Mapped[str] = mapped_column(String(120), nullable=False, default="system")
    last_validated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_validation_ok: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    last_validation_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    actively_managed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("institution_id", "name", name="uq_datasource_institution_name"),
        Index("ix_data_sources_institution_id", "institution_id"),
        Index("ix_data_sources_connector_type", "connector_type"),
    )


class InventoryRecord(Base):
    """A data asset discovered in the inventory."""

    __tablename__ = "inventory_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    institution_id: Mapped[int | None] = mapped_column(
        ForeignKey("institutions.id", ondelete="RESTRICT"), nullable=True
    )
    data_source_id: Mapped[int] = mapped_column(
        ForeignKey("data_sources.id", ondelete="RESTRICT"), nullable=False
    )
    external_id: Mapped[str] = mapped_column(String(100), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    record_type: Mapped[str] = mapped_column(String(100), nullable=False)
    category: Mapped[str | None] = mapped_column(String(100), nullable=True)
    source_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    file_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    mime_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    checksum_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sensitivity: Mapped[str] = mapped_column(String(20), nullable=False, default="unknown")
    contains_personal_data: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    duplicate_of_id: Mapped[int | None] = mapped_column(
        ForeignKey("inventory_records.id", ondelete="SET NULL"), nullable=True
    )
    owner_team: Mapped[str | None] = mapped_column(String(120), nullable=True)
    owner_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    lifecycle_status: Mapped[str] = mapped_column(String(30), nullable=False, default="active")
    last_reviewed: Mapped[date | None] = mapped_column(Date, nullable=True)
    source_created_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    source_modified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("data_source_id", "external_id", name="uq_inventory_source_external"),
        Index("ix_inventory_records_data_source_id", "data_source_id"),
        Index("ix_inventory_records_institution", "institution_id"),
        Index("ix_inventory_records_category", "category"),
        Index("ix_inventory_records_sensitivity", "sensitivity"),
        Index("ix_inventory_records_lifecycle_status", "lifecycle_status"),
        Index("ix_inventory_records_source_type", "source_type"),
        Index("ix_inventory_records_title", "title"),
    )


class RetentionPolicy(Base):
    """A versioned retention policy (Phase 3 governance)."""

    __tablename__ = "retention_policies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    institution_id: Mapped[int | None] = mapped_column(
        ForeignKey("institutions.id", ondelete="RESTRICT"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    applicable_categories: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    retention_trigger: Mapped[str | None] = mapped_column(String(30), nullable=True)
    retention_period_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    recommended_action: Mapped[str | None] = mapped_column(String(30), nullable=True)
    scope_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    version: Mapped[str | None] = mapped_column(String(50), nullable=True)
    effective_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    effective_to: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    current_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("policy_versions.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("name", "version", name="uq_policy_name_version"),
        Index("ix_retention_policies_institution", "institution_id"),
        Index("ix_retention_policies_status", "status"),
    )


class PolicyVersion(Base):
    """An immutable snapshot of a retention policy's rules."""

    __tablename__ = "policy_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    policy_id: Mapped[int] = mapped_column(
        ForeignKey("retention_policies.id", ondelete="CASCADE"), nullable=False
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    applicable_categories: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    retention_period_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    retention_trigger: Mapped[str | None] = mapped_column(String(30), nullable=True)
    conditions: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    recommended_action: Mapped[str | None] = mapped_column(String(30), nullable=True)
    effective_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    effective_to: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    approved_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    __table_args__ = (
        Index("ix_policy_versions_policy_id", "policy_id"),
        Index("ix_policy_versions_status", "status"),
    )


class RetentionHold(Base):
    """A legal or administrative hold that blocks any disposal recommendation."""

    __tablename__ = "retention_holds"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    institution_id: Mapped[int | None] = mapped_column(
        ForeignKey("institutions.id", ondelete="RESTRICT"), nullable=True
    )
    asset_id: Mapped[int | None] = mapped_column(
        ForeignKey("inventory_records.id", ondelete="RESTRICT"), nullable=True
    )
    asset_scope: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    hold_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    legal_basis: Mapped[str | None] = mapped_column(String(200), nullable=True)
    scope: Mapped[list | None] = mapped_column(JSON, nullable=False, default=list)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    created_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    released_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    released_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    release_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        Index("ix_retention_holds_institution", "institution_id"),
        Index("ix_retention_holds_asset_id", "asset_id"),
        Index("ix_retention_holds_status", "status"),
    )


class RetentionAssessment(Base):
    """An append-only, explainable retention assessment of one asset."""

    __tablename__ = "retention_assessments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    asset_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_records.id", ondelete="CASCADE"), nullable=False
    )
    institution_id: Mapped[int | None] = mapped_column(
        ForeignKey("institutions.id", ondelete="RESTRICT"), nullable=True
    )
    policy_id: Mapped[int | None] = mapped_column(
        ForeignKey("retention_policies.id", ondelete="SET NULL"), nullable=True
    )
    policy_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("policy_versions.id", ondelete="SET NULL"), nullable=True
    )
    policy_version_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rule_set: Mapped[str] = mapped_column(String(50), nullable=False)
    assessed_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    recommendation: Mapped[str] = mapped_column(String(50), nullable=False)
    rationale: Mapped[str] = mapped_column(Text, nullable=False)
    findings: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    holds_active: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    unresolved_conditions: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    trigger_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    retention_period_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    retention_deadline: Mapped[date | None] = mapped_column(Date, nullable=True)

    __table_args__ = (
        Index("ix_retention_assessments_asset_id", "asset_id"),
        Index("ix_retention_assessments_policy_id", "policy_id"),
        Index("ix_retention_assessments_institution", "institution_id"),
    )


class RetentionDecision(Base):
    """An append-only human review decision about one assessment.

    Recording a decision executes no file operation (ADR-0009/0010).
    """

    __tablename__ = "retention_decisions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    assessment_id: Mapped[int] = mapped_column(
        ForeignKey("retention_assessments.id", ondelete="CASCADE"), nullable=False
    )
    asset_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_records.id", ondelete="CASCADE"), nullable=False
    )
    institution_id: Mapped[int | None] = mapped_column(
        ForeignKey("institutions.id", ondelete="RESTRICT"), nullable=True
    )
    policy_id: Mapped[int | None] = mapped_column(
        ForeignKey("retention_policies.id", ondelete="SET NULL"), nullable=True
    )
    policy_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("policy_versions.id", ondelete="SET NULL"), nullable=True
    )
    recommendation_reviewed: Mapped[str] = mapped_column(String(50), nullable=False)
    decision: Mapped[str] = mapped_column(String(40), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    reviewer: Mapped[str] = mapped_column(String(120), nullable=False)
    decided_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    # Phase 7: explicit, append-only correction. A superseding decision points
    # *back* at the decision it replaces; the original row is never edited or
    # deleted, and ``ondelete="RESTRICT"`` makes deleting history impossible.
    # ``uq_retention_decisions_supersedes`` below guarantees at most one
    # successor, so two concurrent corrections cannot both claim one original.
    supersedes_decision_id: Mapped[int | None] = mapped_column(
        ForeignKey("retention_decisions.id", ondelete="RESTRICT"), nullable=True
    )

    __table_args__ = (
        # One decision per assessment, enforced at the database level so a
        # concurrent double-submit cannot create a second row. Correcting a
        # decision is an explicit re-assessment plus a superseding decision
        # (ADR-0013 / ADR-0015).
        UniqueConstraint(
            "assessment_id", name="uq_retention_decisions_assessment_id"
        ),
        # At most one decision may supersede any given decision, so two
        # concurrent corrections cannot both claim the same original.
        UniqueConstraint(
            "supersedes_decision_id", name="uq_retention_decisions_supersedes"
        ),
        Index("ix_retention_decisions_asset_id", "asset_id"),
        Index("ix_retention_decisions_institution", "institution_id"),
    )


class RiskAssessment(Base):
    """An explainable risk score for an inventory record."""

    __tablename__ = "risk_assessments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    record_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_records.id", ondelete="CASCADE"), nullable=False
    )
    assessed_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    rule_set: Mapped[str] = mapped_column(String(50), nullable=False)
    score: Mapped[int] = mapped_column(Integer, nullable=False)
    band: Mapped[str] = mapped_column(String(20), nullable=False)
    indicators: Mapped[list] = mapped_column(JSON, nullable=False, default=list)

    __table_args__ = (Index("ix_risk_assessments_record_id", "record_id"),)


class LifecycleAction(Base):
    """A requested lifecycle action with human approval tracking (advisory)."""

    __tablename__ = "lifecycle_actions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    record_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_records.id", ondelete="RESTRICT"), nullable=False
    )
    policy_id: Mapped[int | None] = mapped_column(
        ForeignKey("retention_policies.id", ondelete="SET NULL"), nullable=True
    )
    action_type: Mapped[str] = mapped_column(String(30), nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False)
    rationale: Mapped[str] = mapped_column(Text, nullable=False)
    requested_by: Mapped[str] = mapped_column(String(120), nullable=False)
    requested_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    decided_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    decision_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (Index("ix_lifecycle_actions_record_id", "record_id"),)


class ArchiveItem(Base):
    """Placeholder manifest for archived records (Phase 5+, no execution yet)."""

    __tablename__ = "archive_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    record_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_records.id", ondelete="RESTRICT"), nullable=False
    )
    storage_provider: Mapped[str] = mapped_column(String(50), nullable=False)
    archive_location: Mapped[str] = mapped_column(String(500), nullable=False)
    manifest: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    archived_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    __table_args__ = (Index("ix_archive_items_record_id", "record_id"),)


class RetrievalRequest(Base):
    """Placeholder authorized-retrieval request (Phase 5+, no execution yet)."""

    __tablename__ = "retrieval_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    record_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_records.id", ondelete="RESTRICT"), nullable=False
    )
    requested_by: Mapped[str] = mapped_column(String(120), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="pending")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    fulfilled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    __table_args__ = (Index("ix_retrieval_requests_record_id", "record_id"),)


class AuditEvent(Base):
    """An append-only audit trail entry."""

    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor: Mapped[str] = mapped_column(String(120), nullable=False)
    event_type: Mapped[str] = mapped_column(String(80), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(80), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(64), nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("ix_audit_events_event_type", "event_type"),
        Index("ix_audit_events_occurred_at", "occurred_at"),
    )


class AppUser(Base):
    """A DataDiet account — the local authorization subject (Phase 7).

    An identity provider proves *who* the caller is; this directory decides
    *what* they may do. Roles and institutional membership therefore live here
    (``UserMembership``) and are never taken from token claims.
    """

    __tablename__ = "app_users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    # Cross-institution administration. Held by an account, never by a role, so
    # it cannot be granted inside a single institution's membership row.
    is_platform_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )


class UserMembership(Base):
    """One account's role inside one institution (Phase 7 tenant boundary).

    Membership rows are append-only in practice: deactivating one records
    ``is_active = false`` rather than deleting the row, so past authorization
    decisions stay auditable.
    """

    __tablename__ = "user_memberships"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    app_user_id: Mapped[int] = mapped_column(
        ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False
    )
    institution_id: Mapped[int] = mapped_column(
        ForeignKey("institutions.id", ondelete="RESTRICT"), nullable=False
    )
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_by: Mapped[str] = mapped_column(String(120), nullable=False, default="system")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("app_user_id", "institution_id", name="uq_user_membership"),
        Index("ix_user_memberships_institution", "institution_id"),
    )


# --- Phase 4: controlled data ingestion ------------------------------------


class ScanJob(Base):
    """A single discovery-and-ingest run against a connector-backed source.

    The lifecycle is ``PENDING -> RUNNING -> COMPLETED | COMPLETED_WITH_ERRORS
    | FAILED`` and ``PENDING -> CANCELLED`` (see ``app/services/scan.py``). Every
    transition is checked; a terminal job never changes again.
    """

    __tablename__ = "scan_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    data_source_id: Mapped[int] = mapped_column(
        ForeignKey("data_sources.id", ondelete="CASCADE"), nullable=False
    )
    institution_id: Mapped[int | None] = mapped_column(
        ForeignKey("institutions.id", ondelete="RESTRICT"), nullable=True
    )
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="PENDING")
    batch_size: Mapped[int] = mapped_column(Integer, nullable=False, default=500)
    total_discovered: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_imported: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_skipped: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_errors: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    retried_from_job_id: Mapped[int | None] = mapped_column(
        ForeignKey("scan_jobs.id", ondelete="SET NULL"), nullable=True
    )
    requested_by: Mapped[str] = mapped_column(String(120), nullable=False, default="system")
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("ix_scan_jobs_data_source_id", "data_source_id"),
        Index("ix_scan_jobs_institution", "institution_id"),
        Index("ix_scan_jobs_status", "status"),
    )


class ScanResult(Base):
    """One discovered source record and what the scan did with it.

    ``status`` is ``imported`` (a new asset was created), ``skipped`` (an
    existing mapping already covered it, or its observation was refreshed) or
    ``error`` (the record could not be normalised). Discovered metadata is
    recorded even when ingestion is skipped, so a rescan never silently loses
    history.
    """

    __tablename__ = "scan_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scan_job_id: Mapped[int] = mapped_column(
        ForeignKey("scan_jobs.id", ondelete="CASCADE"), nullable=False
    )
    source_key: Mapped[str] = mapped_column(String(512), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    record_type: Mapped[str] = mapped_column(String(100), nullable=False)
    category: Mapped[str | None] = mapped_column(String(100), nullable=True)
    file_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    mime_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    checksum_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sensitivity: Mapped[str] = mapped_column(String(20), nullable=False, default="unknown")
    contains_personal_data: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    imported_asset_id: Mapped[int | None] = mapped_column(
        ForeignKey("inventory_records.id", ondelete="SET NULL"), nullable=True
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("scan_job_id", "source_key", name="uq_scan_result_job_source"),
        Index("ix_scan_results_scan_job_id", "scan_job_id"),
        Index("ix_scan_results_status", "status"),
    )


class ScanError(Base):
    """A structured, per-record or per-path error raised during discovery."""

    __tablename__ = "scan_errors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scan_job_id: Mapped[int] = mapped_column(
        ForeignKey("scan_jobs.id", ondelete="CASCADE"), nullable=False
    )
    source_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # Relative path within the configured root only - never an absolute path.
    path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    error_message: Mapped[str] = mapped_column(Text, nullable=False)
    severity: Mapped[str] = mapped_column(String(20), nullable=False, default="error")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("ix_scan_errors_scan_job_id", "scan_job_id"),
        Index("ix_scan_errors_severity", "severity"),
    )


class SourceRecordMapping(Base):
    """Idempotency map from a source record key to the asset it produced.

    A rescan looks up ``(data_source_id, source_key)``; when a row exists the
    record is not imported again. If the source observation changed (checksum or
    modified time) only this observation row is refreshed - historical asset
    metadata is never overwritten.
    """

    __tablename__ = "source_record_mappings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    data_source_id: Mapped[int] = mapped_column(
        ForeignKey("data_sources.id", ondelete="CASCADE"), nullable=False
    )
    institution_id: Mapped[int | None] = mapped_column(
        ForeignKey("institutions.id", ondelete="RESTRICT"), nullable=True
    )
    source_key: Mapped[str] = mapped_column(String(512), nullable=False)
    asset_id: Mapped[int | None] = mapped_column(
        ForeignKey("inventory_records.id", ondelete="CASCADE"), nullable=True
    )
    checksum_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    observation_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    source_modified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    __table_args__ = (
        UniqueConstraint("data_source_id", "source_key", name="uq_source_mapping"),
        Index("ix_source_record_mappings_data_source_id", "data_source_id"),
        Index("ix_source_record_mappings_asset_id", "asset_id"),
        Index("ix_source_record_mappings_institution", "institution_id"),
    )


class ClassificationResult(Base):
    """An append-only, explainable classification proposal for one asset.

    Phase 5: deterministic rules over inventoried *metadata only* propose a
    category and sensitivity. A result is a proposal for human review; it never
    mutates ``InventoryRecord.category``/``sensitivity``, never selects a
    retention policy, and never triggers a lifecycle action. Re-running
    classification with the same inputs and the same rule version reuses the
    stored row (``uq_classification_fingerprint``); any change to inputs or rule
    version creates a new row, so history is preserved across rule updates.
    """

    __tablename__ = "classification_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    asset_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_records.id", ondelete="CASCADE"), nullable=False
    )
    institution_id: Mapped[int | None] = mapped_column(
        ForeignKey("institutions.id", ondelete="RESTRICT"), nullable=True
    )
    rule_version: Mapped[str] = mapped_column(String(50), nullable=False)
    outcome: Mapped[str] = mapped_column(String(30), nullable=False)
    proposed_category: Mapped[str | None] = mapped_column(String(100), nullable=True)
    proposed_sensitivity: Mapped[str] = mapped_column(String(20), nullable=False)
    confidence: Mapped[str] = mapped_column(String(20), nullable=False)
    confidence_meaning: Mapped[str] = mapped_column(Text, nullable=False)
    evidence: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    warnings: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    conflicts: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    input_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by: Mapped[str] = mapped_column(String(120), nullable=False, default="system")
    classified_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "asset_id",
            "rule_version",
            "input_fingerprint",
            name="uq_classification_fingerprint",
        ),
        Index("ix_classification_results_asset_id", "asset_id"),
        Index("ix_classification_results_institution", "institution_id"),
        Index("ix_classification_results_rule_version", "rule_version"),
        Index("ix_classification_results_classified_at", "classified_at"),
    )
