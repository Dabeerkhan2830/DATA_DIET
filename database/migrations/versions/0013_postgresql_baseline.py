"""PostgreSQL baseline for the schema MySQL received from 0001..0012.

Revision ID: 0013_postgresql_baseline
Revises: 0012_audit_platform_admin_reset
Create Date: 2026-11-04

Phase 6.0 (ADR-0025) makes PostgreSQL the staging target, and revisions
``0002``..``0012`` cannot run there: they carry MySQL-only DDL (``AFTER`` column
positioning, ``ALTER TABLE ... MODIFY``, and ``information_schema`` queries
against ``TABLE_SCHEMA``). Verified against a real PostgreSQL 16 server: applying
the existing history to an empty PostgreSQL database fails inside ``0002``, while
the same history is clean on MySQL.

The brief forbids rewriting applied migrations, so this revision **branches by
dialect instead**:

* **MySQL** (and any other dialect): a no-op. Those databases already hold this
  schema, built by ``0001``..``0012``, and rewriting them is not on the table.
* **PostgreSQL**: creates the equivalent schema here, once, as a baseline.

That keeps a single linear history with one head, applies to both dialects from
the same scripts, and touches no already-applied file. Two properties make the
baseline equivalent rather than merely similar:

* The DDL is written out explicitly instead of generated from ``Base.metadata``
  at run time: a baseline is a frozen description of what existed at ``0012``, so
  a column added by revision ``0015`` must not silently appear here and then
  collide with its own ``add_column``.
* Foreign keys carry **exactly the names the applied history gave them** —
  ``fk_user_memberships_app_user`` from ``0008``,
  ``fk_retention_policies_current_version_id`` from ``0003``,
  ``fk_retention_decisions_supersedes`` from ``0009`` — and constraints the
  history left unnamed stay unnamed here, so each dialect applies its own default
  naming exactly as it did at ``0012``. Later revisions drop constraints by name,
  so an invented name would break them.

``retention_policies.current_version_id`` and ``policy_versions.policy_id``
reference each other, so one of the two edges must be added after both tables
exist; ``0001``/``0003`` do that on MySQL and this revision reproduces the split,
including the constraint name.

Entry path for a **fresh** PostgreSQL database (see ``docs/render-staging.md``;
this is a human-triggered operation, not something the app does at startup):

    alembic stamp 0012_audit_platform_admin_reset
    alembic upgrade head

``stamp`` records the baseline as reached without replaying the MySQL-only DDL;
``upgrade`` then runs this revision plus ``0014``.

Two consequences of ``stamp``, stated rather than hidden:

* ``0012``'s audit row is not inserted on a fresh PostgreSQL database. That row
  records how many platform-admin flags revision ``0011`` revoked; a brand-new
  database has no accounts and nothing was revoked, so the event would assert a
  fact that never happened. ``0012`` also reads ``is_platform_admin = 1``, which
  is MySQL's boolean literal and is not valid against a PostgreSQL ``boolean``.
* The ``version_num`` widening ``0001`` performed on MySQL is repeated here,
  because a stamped database never ran ``0001``. Alembic creates the column as
  ``VARCHAR(32)`` and this project's revision ids are longer, so the next stamp
  would fail. Doing it before creating any table mirrors ``0001``.

Downgrade deliberately refuses to run on PostgreSQL: dropping the baseline means
dropping every table in the deployment, which no migration in this repository
does automatically. Roll back to ``0014`` or ``0013`` and stop; the supported
rollback boundary on PostgreSQL is documented in ``docs/architecture.md``.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0013_postgresql_baseline"
down_revision: Union[str, None] = "0012_audit_platform_admin_reset"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: The revision a PostgreSQL database must be stamped at before upgrading.
BASELINE_STAMP = "0012_audit_platform_admin_reset"


def _is_postgresql() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade() -> None:
    """Create the baseline schema on PostgreSQL; do nothing anywhere else."""
    if not _is_postgresql():
        return

    # Mirrors 0001's MySQL fix: Alembic's default VARCHAR(32) cannot hold this
    # project's revision ids, and a stamped database never ran 0001.
    op.alter_column(
        "alembic_version",
        "version_num",
        existing_type=sa.String(length=32),
        type_=sa.String(length=64),
        existing_nullable=False,
    )

    # --- identity and organization ------------------------------------------ #
    op.create_table(
        "app_users",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("display_name", sa.String(length=200), nullable=False),
        sa.Column("is_platform_admin", sa.Boolean(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("email"),
    )
    op.create_table(
        "institutions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("code", sa.String(length=50), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code"),
    )
    op.create_index("ix_institutions_code", "institutions", ["code"])
    op.create_table(
        "user_memberships",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("app_user_id", sa.Integer(), nullable=False),
        sa.Column("institution_id", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_by", sa.String(length=120), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["app_user_id"], ["app_users.id"], name="fk_user_memberships_app_user",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["institution_id"], ["institutions.id"],
            name="fk_user_memberships_institution", ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("app_user_id", "institution_id", name="uq_user_membership"),
    )
    op.create_index("ix_user_memberships_institution", "user_memberships", ["institution_id"])

    # --- audit -------------------------------------------------------------- #
    op.create_table(
        "audit_events",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("actor", sa.String(length=120), nullable=False),
        sa.Column("event_type", sa.String(length=80), nullable=False),
        sa.Column("entity_type", sa.String(length=80), nullable=False),
        sa.Column("entity_id", sa.String(length=64), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_audit_events_event_type", "audit_events", ["event_type"])
    op.create_index("ix_audit_events_occurred_at", "audit_events", ["occurred_at"])

    # --- sources and inventory ---------------------------------------------- #
    op.create_table(
        "data_sources",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("institution_id", sa.Integer(), nullable=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("source_type", sa.String(length=50), nullable=False),
        sa.Column("connector_type", sa.String(length=50), nullable=True),
        sa.Column("root_key", sa.String(length=100), nullable=True),
        sa.Column("config", sa.JSON(), nullable=True),
        sa.Column("created_by", sa.String(length=120), nullable=False),
        sa.Column("last_validated_at", sa.DateTime(), nullable=True),
        sa.Column("last_validation_ok", sa.Boolean(), nullable=True),
        sa.Column("last_validation_message", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("actively_managed", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["institution_id"], ["institutions.id"],
            name="fk_data_sources_institution_id_institutions", ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("institution_id", "name", name="uq_datasource_institution_name"),
    )
    op.create_index("ix_data_sources_institution_id", "data_sources", ["institution_id"])
    op.create_index("ix_data_sources_connector_type", "data_sources", ["connector_type"])

    op.create_table(
        "inventory_records",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("institution_id", sa.Integer(), nullable=True),
        sa.Column("data_source_id", sa.Integer(), nullable=False),
        sa.Column("external_id", sa.String(length=100), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("record_type", sa.String(length=100), nullable=False),
        sa.Column("category", sa.String(length=100), nullable=True),
        sa.Column("source_type", sa.String(length=50), nullable=True),
        sa.Column("file_name", sa.String(length=255), nullable=True),
        sa.Column("mime_type", sa.String(length=100), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("checksum_sha256", sa.String(length=64), nullable=True),
        sa.Column("sensitivity", sa.String(length=20), nullable=False),
        sa.Column("contains_personal_data", sa.Boolean(), nullable=False),
        sa.Column("duplicate_of_id", sa.Integer(), nullable=True),
        sa.Column("owner_team", sa.String(length=120), nullable=True),
        sa.Column("owner_email", sa.String(length=255), nullable=True),
        sa.Column("lifecycle_status", sa.String(length=30), nullable=False),
        sa.Column("last_reviewed", sa.Date(), nullable=True),
        sa.Column("source_created_at", sa.DateTime(), nullable=True),
        sa.Column("source_modified_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["data_source_id"], ["data_sources.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["duplicate_of_id"], ["inventory_records.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["institution_id"], ["institutions.id"],
            name="fk_inventory_records_institution_id_institutions", ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("data_source_id", "external_id", name="uq_inventory_source_external"),
    )
    op.create_index(
        "ix_inventory_records_data_source_id", "inventory_records", ["data_source_id"]
    )
    op.create_index("ix_inventory_records_institution", "inventory_records", ["institution_id"])
    op.create_index("ix_inventory_records_category", "inventory_records", ["category"])
    op.create_index("ix_inventory_records_sensitivity", "inventory_records", ["sensitivity"])
    op.create_index(
        "ix_inventory_records_lifecycle_status", "inventory_records", ["lifecycle_status"]
    )
    op.create_index("ix_inventory_records_source_type", "inventory_records", ["source_type"])
    op.create_index("ix_inventory_records_title", "inventory_records", ["title"])

    # --- policies ----------------------------------------------------------- #
    # Created without current_version_id's foreign key; that edge is added once
    # policy_versions exists, exactly as 0003 does on MySQL.
    op.create_table(
        "retention_policies",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("institution_id", sa.Integer(), nullable=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("applicable_categories", sa.JSON(), nullable=True),
        sa.Column("retention_trigger", sa.String(length=30), nullable=True),
        sa.Column("retention_period_days", sa.Integer(), nullable=True),
        sa.Column("recommended_action", sa.String(length=30), nullable=True),
        sa.Column("scope_description", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("version", sa.String(length=50), nullable=True),
        sa.Column("effective_from", sa.Date(), nullable=True),
        sa.Column("effective_to", sa.Date(), nullable=True),
        sa.Column("created_by", sa.String(length=120), nullable=True),
        sa.Column("current_version_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["institution_id"], ["institutions.id"],
            name="fk_retention_policies_institution_id", ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", "version", name="uq_policy_name_version"),
    )
    op.create_index(
        "ix_retention_policies_institution", "retention_policies", ["institution_id"]
    )
    op.create_index("ix_retention_policies_status", "retention_policies", ["status"])

    op.create_table(
        "policy_versions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("policy_id", sa.Integer(), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("applicable_categories", sa.JSON(), nullable=True),
        sa.Column("retention_period_days", sa.Integer(), nullable=True),
        sa.Column("retention_trigger", sa.String(length=30), nullable=True),
        sa.Column("conditions", sa.JSON(), nullable=True),
        sa.Column("recommended_action", sa.String(length=30), nullable=True),
        sa.Column("effective_from", sa.Date(), nullable=True),
        sa.Column("effective_to", sa.Date(), nullable=True),
        sa.Column("created_by", sa.String(length=120), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("approved_by", sa.String(length=120), nullable=True),
        sa.Column("approved_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["policy_id"], ["retention_policies.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_policy_versions_policy_id", "policy_versions", ["policy_id"])
    op.create_index("ix_policy_versions_status", "policy_versions", ["status"])

    op.create_foreign_key(
        "fk_retention_policies_current_version_id",
        "retention_policies",
        "policy_versions",
        ["current_version_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # --- assessment, decision and lifecycle --------------------------------- #
    op.create_table(
        "retention_assessments",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("asset_id", sa.Integer(), nullable=False),
        sa.Column("institution_id", sa.Integer(), nullable=True),
        sa.Column("policy_id", sa.Integer(), nullable=True),
        sa.Column("policy_version_id", sa.Integer(), nullable=True),
        sa.Column("policy_version_number", sa.Integer(), nullable=True),
        sa.Column("rule_set", sa.String(length=50), nullable=False),
        sa.Column("assessed_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("recommendation", sa.String(length=50), nullable=False),
        sa.Column("rationale", sa.Text(), nullable=False),
        sa.Column("findings", sa.JSON(), nullable=False),
        sa.Column("holds_active", sa.Integer(), nullable=False),
        sa.Column("unresolved_conditions", sa.JSON(), nullable=False),
        sa.Column("trigger_date", sa.Date(), nullable=True),
        sa.Column("retention_period_days", sa.Integer(), nullable=True),
        sa.Column("retention_deadline", sa.Date(), nullable=True),
        sa.ForeignKeyConstraint(["asset_id"], ["inventory_records.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["institution_id"], ["institutions.id"],
            name="fk_retention_assessments_institution_id", ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(["policy_id"], ["retention_policies.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["policy_version_id"], ["policy_versions.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_retention_assessments_asset_id", "retention_assessments", ["asset_id"]
    )
    op.create_index(
        "ix_retention_assessments_institution", "retention_assessments", ["institution_id"]
    )
    op.create_index(
        "ix_retention_assessments_policy_id", "retention_assessments", ["policy_id"]
    )

    op.create_table(
        "retention_decisions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("assessment_id", sa.Integer(), nullable=False),
        sa.Column("asset_id", sa.Integer(), nullable=False),
        sa.Column("institution_id", sa.Integer(), nullable=True),
        sa.Column("policy_id", sa.Integer(), nullable=True),
        sa.Column("policy_version_id", sa.Integer(), nullable=True),
        sa.Column("recommendation_reviewed", sa.String(length=50), nullable=False),
        sa.Column("decision", sa.String(length=40), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("reviewer", sa.String(length=120), nullable=False),
        sa.Column("decided_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("supersedes_decision_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["assessment_id"], ["retention_assessments.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["asset_id"], ["inventory_records.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["institution_id"], ["institutions.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["policy_id"], ["retention_policies.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["policy_version_id"], ["policy_versions.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["supersedes_decision_id"], ["retention_decisions.id"],
            name="fk_retention_decisions_supersedes", ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("assessment_id", name="uq_retention_decisions_assessment_id"),
        sa.UniqueConstraint("supersedes_decision_id", name="uq_retention_decisions_supersedes"),
    )
    op.create_index("ix_retention_decisions_asset_id", "retention_decisions", ["asset_id"])
    op.create_index(
        "ix_retention_decisions_institution", "retention_decisions", ["institution_id"]
    )

    op.create_table(
        "risk_assessments",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("record_id", sa.Integer(), nullable=False),
        sa.Column("assessed_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("rule_set", sa.String(length=50), nullable=False),
        sa.Column("score", sa.Integer(), nullable=False),
        sa.Column("band", sa.String(length=20), nullable=False),
        sa.Column("indicators", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(["record_id"], ["inventory_records.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_risk_assessments_record_id", "risk_assessments", ["record_id"])

    op.create_table(
        "classification_results",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("asset_id", sa.Integer(), nullable=False),
        sa.Column("institution_id", sa.Integer(), nullable=True),
        sa.Column("rule_version", sa.String(length=50), nullable=False),
        sa.Column("outcome", sa.String(length=30), nullable=False),
        sa.Column("proposed_category", sa.String(length=100), nullable=True),
        sa.Column("proposed_sensitivity", sa.String(length=20), nullable=False),
        sa.Column("confidence", sa.String(length=20), nullable=False),
        sa.Column("confidence_meaning", sa.Text(), nullable=False),
        sa.Column("evidence", sa.JSON(), nullable=False),
        sa.Column("warnings", sa.JSON(), nullable=False),
        sa.Column("conflicts", sa.JSON(), nullable=False),
        sa.Column("input_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("created_by", sa.String(length=120), nullable=False),
        sa.Column(
            "classified_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False
        ),
        sa.ForeignKeyConstraint(["asset_id"], ["inventory_records.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["institution_id"], ["institutions.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "asset_id", "rule_version", "input_fingerprint", name="uq_classification_fingerprint"
        ),
    )
    op.create_index("ix_classification_results_asset_id", "classification_results", ["asset_id"])
    op.create_index(
        "ix_classification_results_institution", "classification_results", ["institution_id"]
    )
    op.create_index(
        "ix_classification_results_rule_version", "classification_results", ["rule_version"]
    )
    op.create_index(
        "ix_classification_results_classified_at", "classification_results", ["classified_at"]
    )

    op.create_table(
        "retention_holds",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("institution_id", sa.Integer(), nullable=True),
        sa.Column("asset_id", sa.Integer(), nullable=True),
        sa.Column("asset_scope", sa.JSON(), nullable=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("hold_type", sa.String(length=50), nullable=True),
        sa.Column("legal_basis", sa.String(length=200), nullable=True),
        sa.Column("scope", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("created_by", sa.String(length=120), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("released_by", sa.String(length=120), nullable=True),
        sa.Column("released_at", sa.DateTime(), nullable=True),
        sa.Column("release_reason", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["asset_id"], ["inventory_records.id"],
            name="fk_retention_holds_asset_id", ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["institution_id"], ["institutions.id"],
            name="fk_retention_holds_institution_id", ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_retention_holds_asset_id", "retention_holds", ["asset_id"])
    op.create_index("ix_retention_holds_institution", "retention_holds", ["institution_id"])
    op.create_index("ix_retention_holds_status", "retention_holds", ["status"])

    op.create_table(
        "lifecycle_actions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("record_id", sa.Integer(), nullable=False),
        sa.Column("policy_id", sa.Integer(), nullable=True),
        sa.Column("action_type", sa.String(length=30), nullable=False),
        sa.Column("status", sa.String(length=30), nullable=False),
        sa.Column("rationale", sa.Text(), nullable=False),
        sa.Column("requested_by", sa.String(length=120), nullable=False),
        sa.Column(
            "requested_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("decided_by", sa.String(length=120), nullable=True),
        sa.Column("decided_at", sa.DateTime(), nullable=True),
        sa.Column("decision_note", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["record_id"], ["inventory_records.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["policy_id"], ["retention_policies.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_lifecycle_actions_record_id", "lifecycle_actions", ["record_id"])

    # --- archive and retrieval ---------------------------------------------- #
    op.create_table(
        "archive_items",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("record_id", sa.Integer(), nullable=False),
        sa.Column("storage_provider", sa.String(length=50), nullable=False),
        sa.Column("archive_location", sa.String(length=500), nullable=False),
        sa.Column("manifest", sa.JSON(), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("archived_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("verified_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["record_id"], ["inventory_records.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_archive_items_record_id", "archive_items", ["record_id"])

    op.create_table(
        "retrieval_requests",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("record_id", sa.Integer(), nullable=False),
        sa.Column("requested_by", sa.String(length=120), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=30), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("fulfilled_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["record_id"], ["inventory_records.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_retrieval_requests_record_id", "retrieval_requests", ["record_id"])

    # --- scanning ----------------------------------------------------------- #
    op.create_table(
        "scan_jobs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("data_source_id", sa.Integer(), nullable=False),
        sa.Column("institution_id", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(length=30), nullable=False),
        sa.Column("batch_size", sa.Integer(), nullable=False),
        sa.Column("total_discovered", sa.Integer(), nullable=False),
        sa.Column("total_imported", sa.Integer(), nullable=False),
        sa.Column("total_skipped", sa.Integer(), nullable=False),
        sa.Column("total_errors", sa.Integer(), nullable=False),
        sa.Column("retried_from_job_id", sa.Integer(), nullable=True),
        sa.Column("requested_by", sa.String(length=120), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["data_source_id"], ["data_sources.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["institution_id"], ["institutions.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["retried_from_job_id"], ["scan_jobs.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_scan_jobs_data_source_id", "scan_jobs", ["data_source_id"])
    op.create_index("ix_scan_jobs_institution", "scan_jobs", ["institution_id"])
    op.create_index("ix_scan_jobs_status", "scan_jobs", ["status"])

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
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("checksum_sha256", sa.String(length=64), nullable=True),
        sa.Column("sensitivity", sa.String(length=20), nullable=False),
        sa.Column("contains_personal_data", sa.Boolean(), nullable=False),
        sa.Column("imported_asset_id", sa.Integer(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["scan_job_id"], ["scan_jobs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["imported_asset_id"], ["inventory_records.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("scan_job_id", "source_key", name="uq_scan_result_job_source"),
    )
    op.create_index("ix_scan_results_scan_job_id", "scan_results", ["scan_job_id"])
    op.create_index("ix_scan_results_status", "scan_results", ["status"])

    op.create_table(
        "scan_errors",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("scan_job_id", sa.Integer(), nullable=False),
        sa.Column("source_key", sa.String(length=512), nullable=True),
        sa.Column("path", sa.String(length=512), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=False),
        sa.Column("severity", sa.String(length=20), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["scan_job_id"], ["scan_jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_scan_errors_scan_job_id", "scan_errors", ["scan_job_id"])
    op.create_index("ix_scan_errors_severity", "scan_errors", ["severity"])

    op.create_table(
        "source_record_mappings",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("data_source_id", sa.Integer(), nullable=False),
        sa.Column("institution_id", sa.Integer(), nullable=True),
        sa.Column("source_key", sa.String(length=512), nullable=False),
        sa.Column("asset_id", sa.Integer(), nullable=True),
        sa.Column("checksum_sha256", sa.String(length=64), nullable=True),
        sa.Column("observation_count", sa.Integer(), nullable=False),
        sa.Column(
            "first_seen_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column(
            "last_seen_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("source_modified_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ["data_source_id"], ["data_sources.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["institution_id"], ["institutions.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["asset_id"], ["inventory_records.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("data_source_id", "source_key", name="uq_source_mapping"),
    )
    op.create_index(
        "ix_source_record_mappings_data_source_id",
        "source_record_mappings",
        ["data_source_id"],
    )
    op.create_index(
        "ix_source_record_mappings_institution", "source_record_mappings", ["institution_id"]
    )
    op.create_index(
        "ix_source_record_mappings_asset_id", "source_record_mappings", ["asset_id"]
    )


def downgrade() -> None:
    """Refuse to undo the baseline instead of dropping the deployment's schema."""
    if _is_postgresql():
        raise RuntimeError(
            "0013_postgresql_baseline cannot be downgraded: reversing it means "
            "dropping every table in the database. The PostgreSQL history is "
            "forward-only (ADR-0025). Use `alembic downgrade "
            "0014_external_identities` or `alembic downgrade "
            "0013_postgresql_baseline`, and restore from a backup if the "
            "baseline itself must be removed."
        )
    # MySQL and other dialects: this revision created nothing, so there is
    # nothing to undo.
    pass
