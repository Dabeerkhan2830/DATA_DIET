"""review decision integrity (Phase 6)

Revision ID: 0007_review_decision_integrity
Revises: 0006_classification_results
Create Date: 2026-10-19 16:00:00.000000

Phase 6: the unified review workflow records human decisions only through the
append-only ``retention_decisions`` table. This revision makes the "one decision
per assessment" rule a database guarantee instead of an application-only check,
so two concurrent submissions cannot both insert a decision.

- Replaces the non-unique ``ix_retention_decisions_assessment_id`` index with the
  unique constraint ``uq_retention_decisions_assessment_id``.
- Correcting a decision is an explicit supersession: re-assessing the asset
  creates a new assessment (and therefore a new decision target). No row is ever
  edited or deleted.

Data note: the unique constraint cannot be created if a database already holds
two decisions for the same assessment. The application never produced that
state; if a development database does, resolve the duplicate manually before
applying this revision. Production downgrades should be planned separately.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0007_review_decision_integrity"
down_revision: Union[str, None] = "0006_classification_results"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create the stronger guarantee first, so a failure leaves the existing
    # non-unique index in place.
    op.create_unique_constraint(
        "uq_retention_decisions_assessment_id",
        "retention_decisions",
        ["assessment_id"],
    )
    op.drop_index(
        "ix_retention_decisions_assessment_id", table_name="retention_decisions"
    )


def downgrade() -> None:
    op.create_index(
        "ix_retention_decisions_assessment_id",
        "retention_decisions",
        ["assessment_id"],
    )
    op.drop_constraint(
        "uq_retention_decisions_assessment_id",
        "retention_decisions",
        type_="unique",
    )
