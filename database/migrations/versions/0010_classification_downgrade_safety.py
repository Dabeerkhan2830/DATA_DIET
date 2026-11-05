"""Downgrade safety repair for FK-backed indexes (Phase 7)

Revision ID: 0010_classification_downgrade_safety
Revises: 0009_decision_supersession
Create Date: 2026-10-19 18:20:00.000000

Corrects a pre-existing defect **without editing applied history** (ADR-0016).

``0006_classification_results.downgrade()`` drops
``ix_classification_results_asset_id`` and ``ix_classification_results_institution``
while the table's own foreign keys still exist. InnoDB considers those indexes
the support for ``classification_results_ibfk_1``/``_2`` and refuses with errno
1553 ("Cannot drop index ...: needed in a foreign key constraint"), so every
downgrade that traverses 0006 aborts and takes the rest of the rollback chain
with it. Alembic runs a revision's ``downgrade()`` *before* the revisions below
it, so this migration repairs the path ahead:

* ``downgrade()`` drops the table's foreign keys first, which releases their
  supporting indexes so 0006's index drops (and then ``drop_table``) succeed.
* ``upgrade()`` restores them, so the forward schema is unchanged. On a healthy
  database every constraint already exists and each step is an intentional
  no-op; it only re-adds constraints when a previously interrupted rollback
  removed them — i.e. it is also the repair procedure for a database that
  failed mid-downgrade: ``alembic downgrade <one step>`` then
  ``alembic upgrade head``.

**Supported rollback boundary: 0005_source_connectors (ADR-0016).** Rolling
back further reaches ``0004_review_decisions.downgrade()``, which carries the
same inversion twice — for ``retention_decisions`` (three indexes dropped
before the table) and for ``retention_assessments``
(``ix_retention_assessments_institution`` dropped before the constraint
``fk_retention_assessments_institution_id`` that InnoDB treats as its support).

This revision deliberately does **not** repair those. Repairing them would mean
dropping ``retention_decisions``' foreign keys on every rollback including the
supported one, which would leave the 0005 schema referentially incomplete — and
still could not carry the rollback through, because the second inversion is
unrepairable from above: dropping that constraint here would make 0004's own
``drop_constraint`` fail with errno 1091, and leaving it makes the index drop
fail with errno 1553. The only fix would be editing 0004 itself.

Instead the boundary is enforced *by* that defect, and it fails safely: the
first statement of 0004's ``downgrade()`` raises 1553 on
``ix_retention_decisions_institution`` before anything is destroyed, so the
database is left in a consistent 0004 state that ``alembic upgrade head``
restores completely. A ``downgrade 0005`` / ``upgrade head`` round trip is the
supported path and is tested; the below-boundary attempt is asserted to fail
with the documented error *and* to be fully recoverable.

**Other unsupported rollback path (documented):** stopping the rollback *at*
0009, 0006, or 0005 leaves ``classification_results`` without the foreign keys
this revision dropped for it. The table keeps every column, index, and unique
constraint — only referential enforcement is absent — and ``alembic upgrade
head`` restores all of it; the partial-rollback tests assert exactly that.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0010_classification_downgrade_safety"
down_revision: Union[str, None] = "0009_decision_supersession"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: ``classification_results``' foreign keys, mapped as
#: ``constraint name -> (column, definition)``. MySQL numbers unnamed foreign
#: keys in declaration order in CREATE TABLE, which makes these names
#: deterministic for the table 0006 creates wholesale; every name is asserted by
#: the migration test suite against a real MySQL server. Only *these* columns
#: are touched: constraints added by the revisions in between (0007-0009) are
#: dropped by their own downgrades and must not be dropped twice.
#:
#: ``retention_decisions`` is deliberately absent — see the module docstring:
#: repairing 0004's copies of this defect would damage the supported 0005
#: boundary and still could not carry a rollback below it.
_REPAIRS: dict[str, dict[str, tuple[str, str]]] = {
    # 0006: CREATE TABLE in declaration order -> ibfk_1 asset, ibfk_2 inst.
    "classification_results": {
        "classification_results_ibfk_1": (
            "asset_id",
            "FOREIGN KEY (asset_id) REFERENCES inventory_records (id) "
            "ON DELETE CASCADE",
        ),
        "classification_results_ibfk_2": (
            "institution_id",
            "FOREIGN KEY (institution_id) REFERENCES institutions (id) "
            "ON DELETE RESTRICT",
        ),
    },
}


def _is_mysql(bind) -> bool:
    return bind.dialect.name == "mysql"


def _table_exists(bind, table: str) -> bool:
    return sa.inspect(bind).has_table(table)


def _existing_foreign_keys(bind, table: str) -> dict[str, str]:
    """Map constraint name -> column for every FK referencing another table."""
    rows = bind.execute(
        sa.text(
            "SELECT CONSTRAINT_NAME, COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE "
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table "
            "AND REFERENCED_TABLE_NAME IS NOT NULL"
        ),
        {"table": table},
    ).fetchall()
    return {row[0]: row[1] for row in rows}


def upgrade() -> None:
    """Repair-only: restore any foreign key a rollback removed."""
    bind = op.get_bind()
    if not _is_mysql(bind):
        return

    for table, constraints in _REPAIRS.items():
        if not _table_exists(bind, table):
            continue
        present = _existing_foreign_keys(bind, table)
        for name, (_column, definition) in constraints.items():
            if name not in present:
                op.execute(f"ALTER TABLE {table} ADD CONSTRAINT {name} {definition}")


def downgrade() -> None:
    """Drop the FKs ahead of the older revisions so their index drops succeed."""
    bind = op.get_bind()
    if not _is_mysql(bind):
        return

    for table, constraints in _REPAIRS.items():
        if not _table_exists(bind, table):
            continue
        columns = {column for column, _definition in constraints.values()}
        present = _existing_foreign_keys(bind, table)
        for constraint, column in sorted(present.items()):
            if column in columns:
                op.execute(f"ALTER TABLE {table} DROP FOREIGN KEY {constraint}")
