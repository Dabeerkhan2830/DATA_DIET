"""decision supersession (Phase 7)

Revision ID: 0009_decision_supersession
Revises: 0008_identity_and_authorization
Create Date: 2026-10-19 18:10:00.000000

Phase 7 makes the correction of a review decision explicit and append-only.

``retention_decisions.supersedes_decision_id`` points *backwards* at the
decision being replaced. Original rows are never edited or deleted:

- the column is nullable and self-referential with ``ON DELETE RESTRICT``, so a
  superseded decision cannot be dropped from underneath its successor;
- ``uq_retention_decisions_supersedes`` allows at most one successor per
  decision, so two concurrent corrections cannot both claim the same original;
- the service layer additionally rejects self-reference and cycles and requires
  both decisions to belong to the same institution and asset lineage.

Supersession always targets a *new* assessment: ``uq_retention_decisions_
assessment_id`` still guarantees exactly one decision per assessment, so a
correction is re-assess-then-supersede rather than an edit of history.

Downgrade drops the self-referential foreign key before its supporting unique
index, which is the ordering MySQL requires.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0009_decision_supersession"
down_revision: Union[str, None] = "0008_identity_and_authorization"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "retention_decisions",
        sa.Column("supersedes_decision_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_retention_decisions_supersedes",
        "retention_decisions",
        "retention_decisions",
        ["supersedes_decision_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_unique_constraint(
        "uq_retention_decisions_supersedes", "retention_decisions", ["supersedes_decision_id"]
    )


def downgrade() -> None:
    # The unique constraint doubles as the supporting index for the
    # self-referential foreign key, so the constraint must go last.
    op.drop_constraint(
        "fk_retention_decisions_supersedes", "retention_decisions", type_="foreignkey"
    )
    op.drop_constraint(
        "uq_retention_decisions_supersedes", "retention_decisions", type_="unique"
    )
    op.drop_column("retention_decisions", "supersedes_decision_id")
