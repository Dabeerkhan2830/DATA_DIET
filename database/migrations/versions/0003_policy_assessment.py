"""policy assessment and holds

Revision ID: 0003_policy_assessment
Revises: 0002_add_institutions_and_asset_fields
Create Date: 2026-10-17 12:10:00.000000
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003_policy_assessment"
down_revision: Union[str, None] = "0002_add_institutions_and_asset_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "policy_versions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("policy_id", sa.Integer(), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default=sa.text("'draft'")),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("applicable_categories", sa.JSON(), nullable=True),
        sa.Column("retention_period_days", sa.Integer(), nullable=True),
        sa.Column("retention_trigger", sa.String(length=30), nullable=True),
        sa.Column("conditions", sa.JSON(), nullable=True),
        sa.Column("recommended_action", sa.String(length=30), nullable=True),
        sa.Column("effective_from", sa.Date(), nullable=True),
        sa.Column("effective_to", sa.Date(), nullable=True),
        sa.Column("created_by", sa.String(length=120), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("approved_by", sa.String(length=120), nullable=True),
        sa.Column("approved_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["policy_id"], ["retention_policies.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_policy_versions_policy_id", "policy_versions", ["policy_id"])
    op.create_index("ix_policy_versions_status", "policy_versions", ["status"])

    op.add_column("retention_policies", sa.Column("institution_id", sa.Integer(), nullable=True))
    op.add_column("retention_policies", sa.Column("description", sa.Text(), nullable=True))
    op.add_column("retention_policies", sa.Column("applicable_categories", sa.JSON(), nullable=True))
    op.add_column("retention_policies", sa.Column("retention_trigger", sa.String(length=30), nullable=True))
    op.add_column("retention_policies", sa.Column("recommended_action", sa.String(length=30), nullable=True))
    op.add_column("retention_policies", sa.Column("current_version_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_retention_policies_current_version_id", "retention_policies", "policy_versions",
        ["current_version_id"], ["id"], ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_retention_policies_institution_id", "retention_policies", "institutions",
        ["institution_id"], ["id"], ondelete="RESTRICT",
    )
    op.create_index("ix_retention_policies_institution", "retention_policies", ["institution_id"])
    op.create_index("ix_retention_policies_status", "retention_policies", ["status"])
    op.alter_column("retention_policies", "version", existing_type=sa.String(length=50), nullable=True)
    op.alter_column("retention_policies", "scope_description", existing_type=sa.Text(), nullable=True)
    op.alter_column("retention_policies", "retention_period_days", existing_type=sa.Integer(), nullable=True)
    op.alter_column("retention_policies", "effective_from", existing_type=sa.Date(), nullable=True)
    op.alter_column("retention_policies", "created_by", existing_type=sa.String(length=120), nullable=True)

    op.add_column("retention_holds", sa.Column("institution_id", sa.Integer(), nullable=True))
    op.add_column("retention_holds", sa.Column("asset_id", sa.Integer(), nullable=True))
    op.add_column("retention_holds", sa.Column("asset_scope", sa.JSON(), nullable=True))
    op.add_column("retention_holds", sa.Column("hold_type", sa.String(length=50), nullable=True))
    op.add_column("retention_holds", sa.Column("status", sa.String(length=20), nullable=False, server_default=sa.text("'active'")))
    op.add_column("retention_holds", sa.Column("released_by", sa.String(length=120), nullable=True))
    op.add_column("retention_holds", sa.Column("release_reason", sa.Text(), nullable=True))
    op.create_foreign_key(
        "fk_retention_holds_institution_id", "retention_holds", "institutions",
        ["institution_id"], ["id"], ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_retention_holds_asset_id", "retention_holds", "inventory_records",
        ["asset_id"], ["id"], ondelete="RESTRICT",
    )
    op.create_index("ix_retention_holds_institution", "retention_holds", ["institution_id"])
    op.create_index("ix_retention_holds_asset_id", "retention_holds", ["asset_id"])
    op.create_index("ix_retention_holds_status", "retention_holds", ["status"])
    op.alter_column("retention_holds", "legal_basis", existing_type=sa.String(length=200), nullable=True)
    op.alter_column("retention_holds", "created_by", existing_type=sa.String(length=120), nullable=True)

    op.create_table(
        "retention_assessments",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("asset_id", sa.Integer(), nullable=False),
        sa.Column("policy_id", sa.Integer(), nullable=True),
        sa.Column("policy_version_id", sa.Integer(), nullable=True),
        sa.Column("policy_version_number", sa.Integer(), nullable=True),
        sa.Column("rule_set", sa.String(length=50), nullable=False),
        sa.Column("assessed_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("recommendation", sa.String(length=50), nullable=False),
        sa.Column("rationale", sa.Text(), nullable=False),
        sa.Column("findings", sa.JSON(), nullable=False),
        sa.Column("holds_active", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("unresolved_conditions", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(["asset_id"], ["inventory_records.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["policy_id"], ["retention_policies.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["policy_version_id"], ["policy_versions.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_retention_assessments_asset_id", "retention_assessments", ["asset_id"])
    op.create_index("ix_retention_assessments_policy_id", "retention_assessments", ["policy_id"])


def downgrade() -> None:
    """Reverse upgrade() on MySQL.

    Foreign keys are dropped before the columns and indexes they depend on
    (MySQL rejects ``DROP INDEX``/``DROP COLUMN`` that a constraint still
    needs — verified against MySQL 8.0.46). ``retention_assessments`` is
    dropped as a whole table, which removes its indexes and constraints too.
    Nullability changes made in upgrade() are restored.
    """
    # retention_assessments: drop the whole table (indexes and FKs included).
    op.drop_table("retention_assessments")

    # retention_holds: named FKs first, then indexes, then columns.
    op.drop_constraint("fk_retention_holds_asset_id", "retention_holds", type_="foreignkey")
    op.drop_constraint("fk_retention_holds_institution_id", "retention_holds", type_="foreignkey")
    op.drop_index("ix_retention_holds_status", table_name="retention_holds")
    op.drop_index("ix_retention_holds_asset_id", table_name="retention_holds")
    op.drop_index("ix_retention_holds_institution", table_name="retention_holds")
    op.drop_column("retention_holds", "release_reason")
    op.drop_column("retention_holds", "released_by")
    op.drop_column("retention_holds", "status")
    op.drop_column("retention_holds", "hold_type")
    op.drop_column("retention_holds", "asset_scope")
    op.drop_column("retention_holds", "asset_id")
    op.drop_column("retention_holds", "institution_id")
    op.alter_column(
        "retention_holds", "legal_basis", existing_type=sa.String(length=200), nullable=False
    )
    op.alter_column(
        "retention_holds", "created_by", existing_type=sa.String(length=120), nullable=False
    )

    # retention_policies: named FKs first, then indexes, then columns.
    # (In MySQL, dropping a column also drops any index that covered only that
    # column, so the explicit DROP INDEX must run before DROP COLUMN.)
    op.drop_constraint(
        "fk_retention_policies_current_version_id", "retention_policies", type_="foreignkey"
    )
    op.drop_constraint(
        "fk_retention_policies_institution_id", "retention_policies", type_="foreignkey"
    )
    op.drop_index("ix_retention_policies_status", table_name="retention_policies")
    op.drop_index("ix_retention_policies_institution", table_name="retention_policies")
    op.drop_column("retention_policies", "current_version_id")
    op.drop_column("retention_policies", "recommended_action")
    op.drop_column("retention_policies", "retention_trigger")
    op.drop_column("retention_policies", "applicable_categories")
    op.drop_column("retention_policies", "description")
    op.drop_column("retention_policies", "institution_id")
    op.alter_column("retention_policies", "version", existing_type=sa.String(length=50), nullable=False)
    op.alter_column("retention_policies", "scope_description", existing_type=sa.Text(), nullable=False)
    op.alter_column(
        "retention_policies", "retention_period_days", existing_type=sa.Integer(), nullable=False
    )
    op.alter_column("retention_policies", "effective_from", existing_type=sa.Date(), nullable=False)
    op.alter_column(
        "retention_policies", "created_by", existing_type=sa.String(length=120), nullable=False
    )

    # policy_versions: table drop removes its indexes and FK.
    op.drop_table("policy_versions")
