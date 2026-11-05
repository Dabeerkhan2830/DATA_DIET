"""Schemas for the identity endpoints (Phase 7)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

#: Roles an institution-scoped membership may hold (ADR-0014).
RoleValue = Literal["viewer", "reviewer", "admin"]


class AuthConfig(BaseModel):
    """What kind of authentication this deployment actually has.

    Returned without any secret so the frontend can decide whether to show the
    development sign-in form or explain that single sign-on is the deployment's
    responsibility. It never claims an identity provider is configured when one
    is not.
    """

    environment: str
    #: ``development``      — a local sign-in provider is active (dev/test only);
    #: ``bearer_boundary``  — tokens are verified, but no browser sign-in exists
    #:                        here: an external identity provider must issue
    #:                        them (the honest state of a production deployment
    #:                        that has configured a secret);
    #: ``unconfigured``     — nothing is wired up, so protected endpoints 503.
    authentication: Literal["development", "bearer_boundary", "unconfigured"]
    #: True only when ``/auth/dev-login`` will accept a request.
    dev_login_enabled: bool
    issuer: str
    audience: str
    token_ttl_seconds: int
    description: str


class DevLoginRequest(BaseModel):
    """Development/test sign-in for a synthetic account.

    Accepted only outside production. It creates or reuses a local account so
    the whole stack is exercisable without an identity provider — it is *not*
    production authentication, and the server refuses it in production.
    """

    email: str = Field(min_length=3, max_length=255)
    display_name: str | None = Field(default=None, max_length=200)
    institution_id: int | None = Field(default=None, ge=1)
    role: RoleValue = "viewer"
    platform_admin: bool = False

    @field_validator("email")
    @classmethod
    def _normalise_email(cls, value: str) -> str:
        cleaned = value.strip().lower()
        if "@" not in cleaned or cleaned.startswith("@") or cleaned.endswith("@"):
            raise ValueError("email must look like an email address")
        return cleaned

    @field_validator("display_name")
    @classmethod
    def _display_name_default(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class UserProfile(BaseModel):
    """The authenticated account, its scope, and what it may do."""

    id: int
    email: str
    display_name: str
    is_platform_admin: bool
    role: str | None
    institutions: list[int]
    permissions: list[str]


class TokenResponse(BaseModel):
    """A bearer token for the local API.

    The token is stateless: sign-out is discarding it client-side, which is why
    there is no server-side logout endpoint.
    """

    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int
    user: UserProfile


class UserCreate(BaseModel):
    """Create a directory account (platform administrators only)."""

    email: str = Field(min_length=3, max_length=255)
    display_name: str = Field(min_length=1, max_length=200)
    is_platform_admin: bool = False

    @field_validator("email")
    @classmethod
    def _normalise_email(cls, value: str) -> str:
        cleaned = value.strip().lower()
        if "@" not in cleaned or cleaned.startswith("@") or cleaned.endswith("@"):
            raise ValueError("email must look like an email address")
        return cleaned


class UserUpdate(BaseModel):
    """Activate/deactivate an account or correct its display name."""

    display_name: str | None = Field(default=None, min_length=1, max_length=200)
    is_active: bool | None = None
    is_platform_admin: bool | None = None


class MembershipUpsert(BaseModel):
    """Grant, change, or revoke one account's role in one institution."""

    institution_id: int = Field(ge=1)
    role: RoleValue
    is_active: bool = True


class MembershipRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    app_user_id: int
    institution_id: int
    role: str
    is_active: bool
    created_by: str
    created_at: datetime


class UserRead(BaseModel):
    id: int
    email: str
    display_name: str
    is_active: bool
    is_platform_admin: bool
    memberships: list[MembershipRead]
