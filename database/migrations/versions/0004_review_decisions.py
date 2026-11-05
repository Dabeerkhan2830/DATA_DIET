"""review decisions and assessment scope fields

Revision ID: 0004_review_decisions
Revises: 0003_policy_assessment
Create Date: 2026-10-18 12:00:00.000000

Adds:
- retention_decisions: append-only human review decisions about an assessment
  (reviewer, decision, reason, and the policy version reviewed).
- retention_assessments gains institution_id (tenant scoping), trigger_date,
  retention_period_days and retention_deadline (explainable retention math).

Intentionally irreversible data note: downgrading drops retention_decisions,
which destroys the human decision history. That is acceptable only for
development databases; production downgrades must be planned separately.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004_review_decisions"
down_revision: Union[str, None] = "0003_policy_assessment"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "retention_assessments", sa.Column("institution_id", sa.Integer(), nullable=True)
    )
    op.add_column(
        "retention_assessments", sa.Column("trigger_date", sa.Date(), nullable=True)
    )
    op.add_column(
        "retention_assessments",
        sa.Column("retention_period_days", sa.Integer(), nullable=True),
    )
    op.add_column(
        "retention_assessments", sa.Column("retention_deadline", sa.Date(), nullable=True)
    )
    op.create_foreign_key(
        "fk_retention_assessments_institution_id",
        "retention_assessments",
        "institutions",
        ["institution_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_index(
        "ix_retention_assessments_institution", "retention_assessments", ["institution_id"]
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
        sa.Column(
            "decided_at",
            sa.DateTime(),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["assessment_id"], ["retention_assessments.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["asset_id"], ["inventory_records.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["institution_id"], ["institutions.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["policy_id"], ["retention_policies.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["policy_version_id"], ["policy_versions.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_retention_decisions_assessment_id", "retention_decisions", ["assessment_id"]
    )
    op.create_index("ix_retention_decisions_asset_id", "retention_decisions", ["asset_id"])
    op.create_index(
        "ix_retention_decisions_institution", "retention_decisions", ["institution_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_retention_decisions_institution", table_name="retention_decisions")
    op.drop_index("ix_retention_decisions_asset_id", table_name="retention_decisions")
    op.drop_index("ix_retention_decisions_assessment_id", table_name="retention_decisions")
    op.drop_table("retention_decisions")

    op.drop_index("ix_retention_assessments_institution", table_name="retention_assessments")
    op.drop_constraint(
        "fk_retention_assessments_institution_id", "retention_assessments", type_="foreignkey"
    )
    op.drop_column("retention_assessments", "retention_deadline")
    op.drop_column("retention_assessments", "retention_period_days")
    op.drop_column("retention_assessments", "trigger_date")
    op.drop_column("retention_assessments", "institution_id")
