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


class AuthenticationStatus(BaseModel):
    """Which identity provider this process will accept, and whether it can.

    Deliberately credential-free: the Clerk issuer origin is public by design,
    and no secret, key material or token ever appears in this block.
    """

    configured: bool = Field(
        description="False means every protected endpoint answers 503 auth_not_configured."
    )
    provider: Literal["clerk", "development", "signing_secret", "none"] = Field(
        description=(
            "Which verification path a request would take: ``clerk`` (RS256 against the "
            "published JWKS), ``development`` (the local dev/test provider), "
            "``signing_secret`` (ADR-0014's bearer boundary: verified here, issued "
            "elsewhere), or ``none`` (nothing usable)."
        )
    )
    issuer: str = Field(default="", description="Clerk issuer origin; empty when Clerk is off.")
    detail: str = Field(description="Human-readable state for operators.")


class ReadinessResponse(BaseModel):
    """Readiness response. Reports database reachability without crashing.

    ``status`` stays the database gate (docs/azure-architecture.md F5): a
    misconfigured identity provider degrades authentication, not the transport.
    """

    status: Literal["ready", "degraded"]
    database: DatabaseStatus
    authentication: AuthenticationStatus
