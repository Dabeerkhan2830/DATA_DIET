"""classification results history (Phase 5)

Revision ID: 0006_classification_results
Revises: 0005_source_connectors
Create Date: 2026-10-19 13:00:00.000000

Phase 5: deterministic, explainable classification of inventoried *metadata*
(never file contents).

Adds a single append-only table, ``classification_results``:

- ``rule_version`` - which versioned rule table produced the proposal, so old
  rows stay interpretable after rules change.
- ``proposed_category`` / ``proposed_sensitivity`` - proposals only; the asset
  row itself is never mutated automatically.
- ``confidence`` + ``confidence_meaning`` - documented certainty semantics.
- ``evidence`` / ``warnings`` / ``conflicts`` - JSON lists explaining the
  outcome (which rules fired, what they observed, what is unresolved).
- ``input_fingerprint`` - SHA-256 over the canonical classification inputs plus
  the rule version. The unique constraint ``(asset_id, rule_version,
  input_fingerprint)`` makes re-runs idempotent: an unchanged re-run reuses the
  stored row instead of appending a duplicate; any input or rule change
  produces a new row, preserving history.

No lifecycle action, hold, policy selection, or archival decision is triggered
by a classification result.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0006_classification_results"
down_revision: Union[str, None] = "0005_source_connectors"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
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
            "classified_at",
            sa.DateTime(),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["asset_id"], ["inventory_records.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["institution_id"], ["institutions.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "asset_id",
            "rule_version",
            "input_fingerprint",
            name="uq_classification_fingerprint",
        ),
    )
    op.create_index(
        "ix_classification_results_asset_id", "classification_results", ["asset_id"]
    )
    op.create_index(
        "ix_classification_results_institution",
        "classification_results",
        ["institution_id"],
    )
    op.create_index(
        "ix_classification_results_rule_version",
        "classification_results",
        ["rule_version"],
    )
    op.create_index(
        "ix_classification_results_classified_at",
        "classification_results",
        ["classified_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_classification_results_classified_at", table_name="classification_results")
    op.drop_index("ix_classification_results_rule_version", table_name="classification_results")
    op.drop_index("ix_classification_results_institution", table_name="classification_results")
    op.drop_index("ix_classification_results_asset_id", table_name="classification_results")
    op.drop_table("classification_results")
