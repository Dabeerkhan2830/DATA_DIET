"""add institutions and asset fields

Revision ID: 0002_add_institutions_and_asset_fields
Revises: 0001_initial
Create Date: 2026-10-17 12:00:00.000000

"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002_add_institutions_and_asset_fields"
down_revision: Union[str, None] = "0001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "institutions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("code", sa.String(length=50), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code"),
    )
    op.create_index(op.f("ix_institutions_code"), "institutions", ["code"], unique=False)

    op.add_column("data_sources", sa.Column("institution_id", sa.Integer(), nullable=True))
    op.create_foreign_key("fk_data_sources_institution_id_institutions", "data_sources", "institutions", ["institution_id"], ["id"], ondelete="RESTRICT")
    op.create_index(op.f("ix_data_sources_institution_id"), "data_sources", ["institution_id"])
    op.create_unique_constraint("uq_datasource_institution_name", "data_sources", ["institution_id", "name"])
    op.drop_constraint("name", "data_sources", type_="unique")  # handle if exists

    op.add_column("inventory_records", sa.Column("institution_id", sa.Integer(), nullable=True))
    op.add_column("inventory_records", sa.Column("description", sa.Text(), nullable=True))
    op.add_column("inventory_records", sa.Column("category", sa.String(length=100), nullable=True))
    op.add_column("inventory_records", sa.Column("source_type", sa.String(length=50), nullable=True))
    op.add_column("inventory_records", sa.Column("file_name", sa.String(length=255), nullable=True))
    op.add_column("inventory_records", sa.Column("mime_type", sa.String(length=100), nullable=True))
    op.add_column("inventory_records", sa.Column("owner_email", sa.String(length=255), nullable=True))
    op.add_column("inventory_records", sa.Column("lifecycle_status", sa.String(length=30), nullable=False, server_default=sa.text("'active'")))
    op.add_column("inventory_records", sa.Column("source_created_at", sa.DateTime(), nullable=True))
    op.add_column("inventory_records", sa.Column("source_modified_at", sa.DateTime(), nullable=True))
    op.create_foreign_key("fk_inventory_records_institution_id_institutions", "inventory_records", "institutions", ["institution_id"], ["id"], ondelete="RESTRICT")
    op.create_index("ix_inventory_records_institution", "inventory_records", ["institution_id"])
    op.create_index("ix_inventory_records_category", "inventory_records", ["category"])
    op.create_index("ix_inventory_records_sensitivity", "inventory_records", ["sensitivity"])
    op.create_index("ix_inventory_records_lifecycle_status", "inventory_records", ["lifecycle_status"])
    op.create_index("ix_inventory_records_source_type", "inventory_records", ["source_type"])
    op.create_index("ix_inventory_records_title", "inventory_records", ["title"])
    op.add_column("app_users", sa.Column("institution_id", sa.Integer(), nullable=True))
    op.create_foreign_key("fk_app_users_institution_id_institutions", "app_users", "institutions", ["institution_id"], ["id"], ondelete="RESTRICT")
    op.create_index("ix_app_users_institution_id", "app_users", ["institution_id"])


def downgrade() -> None:
    """Reverse upgrade() exactly.

    Order matters: indexes and foreign keys are dropped before the columns and
    table they depend on. The unnamed ``name`` unique constraint that MySQL
    auto-generates for 0001's ``sa.UniqueConstraint("name")`` is recreated
    under that same auto-generated name ("name" — verified against MySQL
    8.0.46) so a downgrade/upgrade round trip returns to the 0001 schema.
    """
    # app_users — FK before its index (MySQL needs the index for the constraint)
    op.drop_constraint("fk_app_users_institution_id_institutions", "app_users", type_="foreignkey")
    op.drop_index("ix_app_users_institution_id", table_name="app_users")
    op.drop_column("app_users", "institution_id")

    # inventory_records — FK, then indexes on dropped columns, then columns
    op.drop_constraint(
        "fk_inventory_records_institution_id_institutions", "inventory_records", type_="foreignkey"
    )
    op.drop_index("ix_inventory_records_title", table_name="inventory_records")
    op.drop_index("ix_inventory_records_source_type", table_name="inventory_records")
    op.drop_index("ix_inventory_records_sensitivity", table_name="inventory_records")
    op.drop_index("ix_inventory_records_lifecycle_status", table_name="inventory_records")
    op.drop_index("ix_inventory_records_category", table_name="inventory_records")
    op.drop_index("ix_inventory_records_institution", table_name="inventory_records")
    op.drop_column("inventory_records", "institution_id")
    op.drop_column("inventory_records", "description")
    op.drop_column("inventory_records", "category")
    op.drop_column("inventory_records", "source_type")
    op.drop_column("inventory_records", "file_name")
    op.drop_column("inventory_records", "mime_type")
    op.drop_column("inventory_records", "owner_email")
    op.drop_column("inventory_records", "lifecycle_status")
    op.drop_column("inventory_records", "source_created_at")
    op.drop_column("inventory_records", "source_modified_at")

    # data_sources — restore the original single-column unique on name
    op.drop_constraint("uq_datasource_institution_name", "data_sources", type_="unique")
    op.create_unique_constraint("name", "data_sources", ["name"])
    op.drop_constraint(
        "fk_data_sources_institution_id_institutions", "data_sources", type_="foreignkey"
    )
    op.drop_index("ix_data_sources_institution_id", table_name="data_sources")
    op.drop_column("data_sources", "institution_id")

    # institutions
    op.drop_index("ix_institutions_code", table_name="institutions")
    op.drop_table("institutions")

