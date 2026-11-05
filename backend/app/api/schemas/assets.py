"""Schemas for data assets (inventory) API."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Sensitivity = Literal["public", "internal", "confidential", "restricted", "unknown"]
LifecycleStatus = Literal[
    "active", "under_review", "archived", "pending_disposal"
]


class AssetCreate(BaseModel):
    institution_id: int | None = None
    data_source_id: int
    external_id: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=300)
    description: str | None = Field(default=None)
    record_type: str = Field(min_length=1, max_length=100)
    category: str | None = Field(default=None, max_length=100)
    source_type: str | None = Field(default=None, max_length=50)
    file_name: str | None = Field(default=None, max_length=255)
    mime_type: str | None = Field(default=None, max_length=100)
    size_bytes: int = Field(default=0, ge=0)
    checksum_sha256: str | None = Field(default=None, max_length=64)
    sensitivity: Sensitivity = "unknown"
    contains_personal_data: bool = False
    owner_team: str | None = Field(default=None, max_length=120)
    owner_email: str | None = Field(default=None)
    lifecycle_status: LifecycleStatus = "active"
    last_reviewed: date | None = None
    source_created_at: datetime | None = None
    source_modified_at: datetime | None = None


class AssetUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = None
    category: str | None = Field(default=None, max_length=100)
    sensitivity: Sensitivity | None = None
    contains_personal_data: bool | None = None
    owner_team: str | None = Field(default=None, max_length=120)
    owner_email: str | None = Field(default=None)
    lifecycle_status: LifecycleStatus | None = None
    last_reviewed: date | None = None
    checksum_sha256: str | None = Field(default=None, max_length=64)
    size_bytes: int | None = Field(default=None, ge=0)
    mime_type: str | None = Field(default=None, max_length=100)
    file_name: str | None = Field(default=None, max_length=255)


class Asset(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    institution_id: int | None
    data_source_id: int
    external_id: str
    title: str
    description: str | None
    record_type: str
    category: str | None
    source_type: str | None
    file_name: str | None
    mime_type: str | None
    size_bytes: int
    checksum_sha256: str | None
    sensitivity: Sensitivity
    contains_personal_data: bool
    duplicate_of_id: int | None
    owner_team: str | None
    owner_email: str | None
    lifecycle_status: LifecycleStatus
    last_reviewed: date | None
    source_created_at: datetime | None
    source_modified_at: datetime | None
    created_at: datetime
    updated_at: datetime


class AssetListResponse(BaseModel):
    items: list[Asset]
    total: int
    page: int
    per_page: int
    pages: int
