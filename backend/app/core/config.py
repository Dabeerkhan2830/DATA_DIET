"""Application configuration.

All runtime configuration is read from environment variables (optionally via a
``.env`` file) and validated by Pydantic at startup. Secrets such as database
credentials must only ever live in environment variables / ``.env`` files that
are git-ignored — never in source code or frontend bundles.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Safe, well-known development credentials. Never used in production.
DEV_DATABASE_URL = (
    "mysql+pymysql://datadiet:datadiet_dev_password@localhost:3306/datadiet"
)

# Well-known development/test signing secret. Filled in only when
# ENVIRONMENT != production and AUTH_JWT_SECRET is unset; production strips it
# again, and authentication refuses to accept it even if settings were
# mutated after construction (ADR-0014).
DEV_AUTH_JWT_SECRET = "datadiet-development-only-do-not-use-in-production"


class Settings(BaseSettings):
    """Validated application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        # The backend is started from backend/, so ../.env is the repo root file.
        env_file=("../.env", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        # Validation errors are surfaced by operator CLIs. Never echo the
        # rejected value: a malformed DATABASE_URL or AUTH_JWT_SECRET must not
        # leak credentials into a terminal, issue tracker, or CI log.
        hide_input_in_errors=True,
    )

    app_name: str = "DataDiet API"
    app_version: str = "0.1.0"
    environment: Literal["development", "test", "production"] = "development"
    api_v1_prefix: str = "/api/v1"

    # Database ---------------------------------------------------------------
    database_url: str = DEV_DATABASE_URL
    database_echo: bool = False

    # CORS (frontend dev server) ---------------------------------------------
    cors_origins: list[str] = Field(default=["http://localhost:5173"])

    # Feature gates ----------------------------------------------------------
    # Phase 1: synthetic demo endpoints only. No real integrations exist yet.
    demo_data_enabled: bool = True

    # Phase 4: controlled data ingestion -------------------------------------
    # Allow-listed local directories that may be registered as `local_folder`
    # sources. Key -> absolute directory path. Empty by default, so local-folder
    # connectors stay unavailable until an operator explicitly opts in. The API
    # only ever accepts an allow-list key, never a raw filesystem path, and
    # absolute paths are never returned to clients.
    local_source_roots: dict[str, str] = Field(default_factory=dict)

    # Hard ceiling on the number of records a single scan may ingest. Bounds
    # the work so a large or misconfigured source cannot exhaust the process.
    scan_max_records: int = Field(default=5000, ge=1, le=1_000_000)

    # Default batch size used when a scan does not specify one.
    scan_batch_size: int = Field(default=500, ge=1, le=5000)

    # Phase 7: authentication and authorization --------------------------------
    # Bearer tokens are validated exactly as an OIDC resource server would
    # (signature, issuer, audience, expiry — ADR-0014). The shared HS256 secret
    # is a development placeholder; a real deployment must set a strong, unique
    # AUTH_JWT_SECRET before any protected endpoint answers. Secrets live only in
    # environment variables — never in source or frontend bundles.
    auth_jwt_issuer: str = "datadiet-dev"
    auth_jwt_audience: str = "datadiet-api"
    auth_jwt_secret: str = ""
    auth_token_ttl_seconds: int = Field(default=3600, ge=60, le=86_400)

    # Development/test convenience provider: POST /api/v1/auth/dev-login issues
    # tokens for synthetic users so the whole stack is exercisable without an
    # identity provider. Forced off in production (never merely defaulted), so
    # development identity can never become production authentication.
    auth_dev_provider_enabled: bool = True

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_cors_origins(cls, value: object) -> object:
        """Accept a comma-separated string for CORS_ORIGINS."""
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @field_validator("auth_jwt_secret")
    @classmethod
    def _validate_secret_strength(cls, value: str, info: object) -> str:
        """Refuse a *weak* production secret; an absent one fails closed later.

        A missing secret does not stop the process — health/readiness probes
        must stay observable — but ``app.core.auth.require_auth_configured``
        then answers 503 for every protected endpoint. A secret that is present
        but too short is an outright misconfiguration and refuses to start.
        """
        environment = getattr(info, "data", {}).get("environment", "development")
        if environment == "production" and value and len(value) < 32:
            raise ValueError(
                "AUTH_JWT_SECRET must be at least 32 characters in production. "
                "Generate one with: python -c \"import secrets; "
                "print(secrets.token_urlsafe(48))\""
            )
        return value

    @model_validator(mode="after")
    def _fail_closed_or_default_dev(self) -> Settings:
        """Apply the development defaults, and strip them out of production.

        Outside production an unset secret falls back to the well-known
        development value so ``npm run dev`` works with no setup, mirroring
        ``DEV_DATABASE_URL``. In production both development conveniences are
        removed: the dev login provider is disabled unconditionally and the
        development secret is discarded, leaving the API fail-closed (503) until
        ``AUTH_JWT_SECRET`` is configured with a real value.
        """
        if self.environment != "production":
            if not self.auth_jwt_secret:
                self.auth_jwt_secret = DEV_AUTH_JWT_SECRET
            return self
        self.auth_dev_provider_enabled = False
        if self.auth_jwt_secret == DEV_AUTH_JWT_SECRET:
            self.auth_jwt_secret = ""
        return self

    @field_validator("database_url")
    @classmethod
    def _validate_database_url(cls, value: str) -> str:
        if "://" not in value:
            raise ValueError(
                "DATABASE_URL must be a SQLAlchemy URL such as "
                "mysql+pymysql://user:password@host:3306/database"
            )
        return value


@lru_cache
def get_settings() -> Settings:
    """Return cached settings instance (cache is cleared in tests)."""
    return Settings()
