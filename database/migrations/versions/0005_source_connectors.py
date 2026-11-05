"""source connectors and controlled ingestion

Revision ID: 0005_source_connectors
Revises: 0004_review_decisions
Create Date: 2026-10-19 12:00:00.000000

Phase 4: provider-neutral source connectors and controlled, metadata-only
ingestion.

Adds:

- ``data_sources`` connector columns (``connector_type``, ``root_key``,
  ``config``, ``created_by``, validation bookkeeping). ``root_key`` is an
  allow-list key resolved server-side; no raw filesystem path is stored or
  returned. ``config`` holds non-secret parameters only.
- ``scan_jobs`` - one discovery run with a bounded lifecycle and counters.
- ``scan_results`` - per-record outcome (imported / skipped / error) plus the
  discovered metadata snapshot.
- ``scan_errors`` - structured per-record/per-path errors (relative paths only).
- ``source_record_mappings`` - idempotency map so rescans never duplicate
  assets.

Nothing here moves, reads the contents of, or deletes any file.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005_source_connectors"
down_revision: Union[str, None] = "0004_review_decisions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- data_sources: connector configuration ------------------------------
    op.add_column("data_sources", sa.Column("connector_type", sa.String(length=50), nullable=True))
    op.add_column("data_sources", sa.Column("root_key", sa.String(length=100), nullable=True))
    op.add_column("data_sources", sa.Column("config", sa.JSON(), nullable=True))
    op.add_column(
        "data_sources",
        sa.Column(
            "created_by",
            sa.String(length=120),
            nullable=False,
            server_default=sa.text("'system'"),
        ),
    )
    op.add_column("data_sources", sa.Column("last_validated_at", sa.DateTime(), nullable=True))
    op.add_column("data_sources", sa.Column("last_validation_ok", sa.Boolean(), nullable=True))
    op.add_column(
        "data_sources", sa.Column("last_validation_message", sa.Text(), nullable=True)
    )
    op.create_index(
        "ix_data_sources_connector_type", "data_sources", ["connector_type"]
    )

    # --- scan_jobs ----------------------------------------------------------
    op.create_table(
        "scan_jobs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("data_source_id", sa.Integer(), nullable=False),
        sa.Column("institution_id", sa.Integer(), nullable=True),
        sa.Column(
            "status", sa.String(length=30), nullable=False, server_default=sa.text("'PENDING'")
        ),
        sa.Column("batch_size", sa.Integer(), nullable=False, server_default=sa.text("500")),
        sa.Column("total_discovered", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("total_imported", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("total_skipped", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("total_errors", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("retried_from_job_id", sa.Integer(), nullable=True),
        sa.Column(
            "requested_by",
            sa.String(length=120),
            nullable=False,
            server_default=sa.text("'system'"),
        ),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["data_source_id"], ["data_sources.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["institution_id"], ["institutions.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["retried_from_job_id"], ["scan_jobs.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_scan_jobs_data_source_id", "scan_jobs", ["data_source_id"])
    op.create_index("ix_scan_jobs_institution", "scan_jobs", ["institution_id"])
    op.create_index("ix_scan_jobs_status", "scan_jobs", ["status"])

    # --- scan_results -------------------------------------------------------
    op.create_table(
        "scan_results",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("scan_job_id", sa.Integer(), nullable=False),
        sa.Column("source_key", sa.String(length=512), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("record_type", sa.String(length=100), nullable=False),
        sa.Column("category", sa.String(length=100), nullable=True),
        sa.Column("file_name", sa.String(length=255), nullable=True),
        sa.Column("mime_type", sa.String(length=100), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("checksum_sha256", sa.String(length=64), nullable=True),
        sa.Column(
            "sensitivity",
            sa.String(length=20),
            nullable=False,
            server_default=sa.text("'unknown'"),
        ),
        sa.Column(
            "contains_personal_data",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("imported_asset_id", sa.Integer(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["scan_job_id"], ["scan_jobs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["imported_asset_id"], ["inventory_records.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("scan_job_id", "source_key", name="uq_scan_result_job_source"),
    )
    op.create_index("ix_scan_results_scan_job_id", "scan_results", ["scan_job_id"])
    op.create_index("ix_scan_results_status", "scan_results", ["status"])

    # --- scan_errors --------------------------------------------------------
    op.create_table(
        "scan_errors",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("scan_job_id", sa.Integer(), nullable=False),
        sa.Column("source_key", sa.String(length=512), nullable=True),
        sa.Column("path", sa.String(length=512), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=False),
        sa.Column(
            "severity", sa.String(length=20), nullable=False, server_default=sa.text("'error'")
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["scan_job_id"], ["scan_jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_scan_errors_scan_job_id", "scan_errors", ["scan_job_id"])
    op.create_index("ix_scan_errors_severity", "scan_errors", ["severity"])

    # --- source_record_mappings --------------------------------------------
    op.create_table(
        "source_record_mappings",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("data_source_id", sa.Integer(), nullable=False),
        sa.Column("institution_id", sa.Integer(), nullable=True),
        sa.Column("source_key", sa.String(length=512), nullable=False),
        sa.Column("asset_id", sa.Integer(), nullable=True),
        sa.Column("checksum_sha256", sa.String(length=64), nullable=True),
        sa.Column("observation_count", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column(
            "first_seen_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("source_modified_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ["data_source_id"], ["data_sources.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["institution_id"], ["institutions.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["asset_id"], ["inventory_records.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("data_source_id", "source_key", name="uq_source_mapping"),
    )
    op.create_index(
        "ix_source_record_mappings_data_source_id",
        "source_record_mappings",
        ["data_source_id"],
    )
    op.create_index(
        "ix_source_record_mappings_asset_id", "source_record_mappings", ["asset_id"]
    )
    op.create_index(
        "ix_source_record_mappings_institution", "source_record_mappings", ["institution_id"]
    )


def downgrade() -> None:
    """Reverse the Phase 4 additions.

    New tables are dropped whole (their indexes and constraints go with them).
    The ``data_sources`` columns are dropped after their index. ``created_by``
    carried a server default, so dropping it is safe on MySQL.
    """
    op.drop_table("source_record_mappings")
    op.drop_table("scan_errors")
    op.drop_table("scan_results")
    op.drop_table("scan_jobs")

    op.drop_index("ix_data_sources_connector_type", table_name="data_sources")
    op.drop_column("data_sources", "last_validation_message")
    op.drop_column("data_sources", "last_validation_ok")
    op.drop_column("data_sources", "last_validated_at")
    op.drop_column("data_sources", "created_by")
    op.drop_column("data_sources", "config")
    op.drop_column("data_sources", "root_key")
    op.drop_column("data_sources", "connector_type")
