"""Service layer for data assets (inventory)."""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.schemas.assets import AssetCreate, AssetUpdate
from app.db.models import InventoryRecord


def create_asset(db: Session, data: AssetCreate) -> InventoryRecord:
    asset = InventoryRecord(
        institution_id=data.institution_id,
        data_source_id=data.data_source_id,
        external_id=data.external_id,
        title=data.title,
        description=data.description,
        record_type=data.record_type,
        category=data.category,
        source_type=data.source_type,
        file_name=data.file_name,
        mime_type=data.mime_type,
        size_bytes=data.size_bytes,
        checksum_sha256=data.checksum_sha256,
        sensitivity=data.sensitivity,
        contains_personal_data=data.contains_personal_data,
        owner_team=data.owner_team,
        owner_email=data.owner_email,
        lifecycle_status=data.lifecycle_status,
        last_reviewed=data.last_reviewed,
        source_created_at=data.source_created_at,
        source_modified_at=data.source_modified_at,
    )
    db.add(asset)
    db.commit()
    db.refresh(asset)
    return asset


def get_asset(db: Session, asset_id: int) -> InventoryRecord | None:
    return db.get(InventoryRecord, asset_id)


def list_assets(
    db: Session,
    *,
    page: int = 1,
    per_page: int = 20,
    search: str | None = None,
    category: str | None = None,
    sensitivity: str | None = None,
    source_type: str | None = None,
    lifecycle_status: str | None = None,
    institution_id: int | None = None,
) -> tuple[Sequence[InventoryRecord], int]:
    query = select(InventoryRecord)
    count_query = select(func.count(InventoryRecord.id))

    if institution_id is not None:
        query = query.where(InventoryRecord.institution_id == institution_id)
        count_query = count_query.where(InventoryRecord.institution_id == institution_id)

    if search:
        like = f"%{search}%"
        cond = or_(
            InventoryRecord.title.ilike(like),
            InventoryRecord.description.ilike(like),
            InventoryRecord.file_name.ilike(like),
            InventoryRecord.external_id.ilike(like),
            InventoryRecord.owner_team.ilike(like),
            InventoryRecord.owner_email.ilike(like),
        )
        query = query.where(cond)
        count_query = count_query.where(cond)

    if category:
        query = query.where(InventoryRecord.category == category)
        count_query = count_query.where(InventoryRecord.category == category)

    if sensitivity:
        query = query.where(InventoryRecord.sensitivity == sensitivity)
        count_query = count_query.where(InventoryRecord.sensitivity == sensitivity)

    if source_type:
        query = query.where(InventoryRecord.source_type == source_type)
        count_query = count_query.where(InventoryRecord.source_type == source_type)

    if lifecycle_status:
        query = query.where(InventoryRecord.lifecycle_status == lifecycle_status)
        count_query = count_query.where(InventoryRecord.lifecycle_status == lifecycle_status)

    total = db.execute(count_query).scalar() or 0
    offset = (page - 1) * per_page
    items = (
        db.execute(
            query.order_by(
                InventoryRecord.updated_at.desc(), InventoryRecord.id.desc()
            )
            .offset(offset)
            .limit(per_page)
        )
        .scalars()
        .all()
    )
    return items, total


def update_asset(db: Session, asset: InventoryRecord, data: AssetUpdate) -> InventoryRecord:
    if data.title is not None:
        asset.title = data.title
    if data.description is not None:
        asset.description = data.description
    if data.category is not None:
        asset.category = data.category
    if data.sensitivity is not None:
        asset.sensitivity = data.sensitivity
    if data.contains_personal_data is not None:
        asset.contains_personal_data = data.contains_personal_data
    if data.owner_team is not None:
        asset.owner_team = data.owner_team
    if data.owner_email is not None:
        asset.owner_email = data.owner_email
    if data.lifecycle_status is not None:
        asset.lifecycle_status = data.lifecycle_status
    if data.last_reviewed is not None:
        asset.last_reviewed = data.last_reviewed
    if data.checksum_sha256 is not None:
        asset.checksum_sha256 = data.checksum_sha256
    if data.size_bytes is not None:
        asset.size_bytes = data.size_bytes
    if data.mime_type is not None:
        asset.mime_type = data.mime_type
    if data.file_name is not None:
        asset.file_name = data.file_name
    db.add(asset)
    db.commit()
    db.refresh(asset)
    return asset
