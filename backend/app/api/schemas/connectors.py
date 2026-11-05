"""Schemas for source connectors and scan jobs (Phase 4).

No absolute filesystem path and no secret ever appears in a request or
response. Local-folder sources reference a server-side allow-list *key* only.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

ConnectorType = Literal["synthetic", "local_folder"]
SourceStatus = Literal["active", "inactive"]
ScanStatus = Literal[
    "PENDING",
    "RUNNING",
    "COMPLETED",
    "COMPLETED_WITH_ERRORS",
    "FAILED",
    "CANCELLED",
]

#: Config keys that look like secrets are refused outright.
_FORBIDDEN_CONFIG_KEYS = frozenset(
    {
        "password",
        "passwd",
        "secret",
        "token",
        "api_key",
        "apikey",
        "access_key",
        "private_key",
        "credential",
        "credentials",
    }
)


def _reject_secret_keys(config: dict[str, Any]) -> dict[str, Any]:
    lowered = {str(key).lower() for key in config}
    offending = sorted(lowered & _FORBIDDEN_CONFIG_KEYS)
    if offending:
        raise ValueError(
            "Connector config must not contain secrets; remove: " + ", ".join(offending)
        )
    if len(config) > 40:
        raise ValueError("Connector config has too many keys")
    return config


class SourceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    connector_type: ConnectorType
    institution_id: int | None = None
    #: Key into the server-side LOCAL_SOURCE_ROOTS allow-list (never a path).
    root_key: str | None = Field(default=None, max_length=100)
    config: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _check_shape(self) -> SourceCreate:
        _reject_secret_keys(self.config)
        if self.connector_type == "local_folder" and not self.root_key:
            raise ValueError("A local_folder source requires a root_key")
        if self.connector_type == "synthetic" and self.root_key:
            raise ValueError("A synthetic source must not set a root_key")
        return self


class SourceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    root_key: str | None = Field(default=None, max_length=100)
    config: dict[str, Any] | None = None
    status: SourceStatus | None = None

    @model_validator(mode="after")
    def _check_config(self) -> SourceUpdate:
        if self.config is not None:
            _reject_secret_keys(self.config)
        return self


class Source(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    institution_id: int | None
    name: str
    connector_type: str | None
    root_key: str | None
    config: dict[str, Any] | None
    status: str
    created_by: str
    last_validated_at: datetime | None
    last_validation_ok: bool | None
    last_validation_message: str | None
    created_at: datetime
    updated_at: datetime


class SourceValidationResult(BaseModel):
    id: int
    ok: bool
    message: str
    validated_at: datetime | None


class PaginatedSources(BaseModel):
    items: list[Source]
    total: int
    page: int
    per_page: int
    pages: int


class ScanRequest(BaseModel):
    """Body for starting a scan. Omit the body to use server defaults."""

    batch_size: int | None = Field(default=None, ge=1, le=5000)
    run: bool = True


class ScanCreate(BaseModel):
    data_source_id: int
    batch_size: int | None = Field(default=None, ge=1, le=5000)
    run: bool = True


class ScanJobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    data_source_id: int
    institution_id: int | None
    status: ScanStatus
    batch_size: int
    total_discovered: int
    total_imported: int
    total_skipped: int
    total_errors: int
    retried_from_job_id: int | None
    started_at: datetime | None
    completed_at: datetime | None
    error_message: str | None
    created_at: datetime


class ScanResultRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    scan_job_id: int
    source_key: str
    status: str
    title: str
    record_type: str
    category: str | None
    file_name: str | None
    mime_type: str | None
    size_bytes: int
    sensitivity: str
    contains_personal_data: bool
    imported_asset_id: int | None
    note: str | None
    error_message: str | None
    created_at: datetime


class ScanErrorRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    scan_job_id: int
    source_key: str | None
    path: str | None
    error_message: str
    severity: str
    created_at: datetime


class PaginatedScanJobs(BaseModel):
    items: list[ScanJobRead]
    total: int
    page: int
    per_page: int
    pages: int


class PaginatedScanResults(BaseModel):
    items: list[ScanResultRead]
    total: int
    page: int
    per_page: int
    pages: int


class PaginatedScanErrors(BaseModel):
    items: list[ScanErrorRead]
    total: int
    page: int
    per_page: int
    pages: int
