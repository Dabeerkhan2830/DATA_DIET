"""Schemas for health and readiness endpoints."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    """Liveness response. Does not touch the database."""

    status: Literal["ok"] = "ok"
    service: str
    version: str
    environment: str


class DatabaseStatus(BaseModel):
    reachable: bool
    detail: str = Field(description="Short diagnostic, e.g. error summary.")


class ReadinessResponse(BaseModel):
    """Readiness response. Reports database reachability without crashing."""

    status: Literal["ready", "degraded"]
    database: DatabaseStatus
