"""Application configuration.

All runtime configuration is read from environment variables (optionally via a
``.env`` file) and validated by Pydantic at startup. Secrets such as database
credentials must only ever live in environment variables / ``.env`` files that
are git-ignored — never in source code or frontend bundles.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# Safe, well-known development credentials. Never used in production.
DEV_DATABASE_URL = (
    "mysql+pymysql://datadiet:datadiet_dev_password@localhost:3306/datadiet"
)

# Well-known development/test signing secret. Filled in only when
# ENVIRONMENT is development or test and AUTH_JWT_SECRET is unset; staging and
# production strip it again, and authentication refuses to accept it even if
# settings were mutated after construction (ADR-0014, ADR-0025).
DEV_AUTH_JWT_SECRET = "datadiet-development-only-do-not-use-in-production"

#: Environments that must never trust a development convenience.
PROTECTED_ENVIRONMENTS = frozenset({"staging", "production"})

#: How an operator can turn a boolean environment variable on.
_TRUTHY = frozenset({"1", "true", "yes", "on"})


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
    environment: Literal["development", "test", "staging", "production"] = "development"
    api_v1_prefix: str = "/api/v1"

    # Database ---------------------------------------------------------------
    # ``postgresql+psycopg2://`` is the staging/production target (ADR-0025).
    # The driver suffix is required, not decorative: SQLAlchemy resolves a bare
    # ``postgresql://`` URL to the psycopg-3 driver, which is not installed.
    database_url: str = DEV_DATABASE_URL
    database_echo: bool = False

    # CORS (frontend dev server) ---------------------------------------------
    # ``NoDecode`` keeps this field out of pydantic-settings' JSON decoding, which
    # otherwise runs in the env/dotenv source *before* any validator and rejects
    # the documented comma-separated form (and even a single origin) outright.
    cors_origins: Annotated[list[str], NoDecode] = Field(default=["http://localhost:5173"])

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
    # identity provider. Forced off — and the route itself not even registered —
    # in staging and production, so development identity can never become
    # protected-environment authentication.
    auth_dev_provider_enabled: bool = True

    # Phase 6.0: Clerk (RS256 + JWKS) identity provider --------------------
    # ``CLERK_ISSUER`` is the ``iss`` value Clerk writes into its session
    # tokens, i.e. the instance's frontend API origin, for example
    # ``https://institution-12.clerk.accounts.dev``. Setting it is what turns
    # Clerk verification on; there is no implicit default.
    # ``CLERK_JWKS_URL`` is derived from the issuer when left empty, which is
    # the shape Clerk documents (``<issuer>/.well-known/jwks.json``).
    # ``CLERK_AUDIENCE`` must be set when the Clerk JWT template names an API
    # instance (``aud``); empty means "this template carries no audience".
    clerk_issuer: str = ""
    clerk_jwks_url: str = ""
    clerk_audience: str = ""

    # Whether an unknown Clerk subject may be given a *permissionless* DataDiet
    # account automatically. Off by default: an unrecognised identity is refused
    # (401) and an administrator attaches it to an account explicitly. When on,
    # provisioning can never grant ``is_platform_admin`` or a membership, so it
    # still authorises nobody — it only records who knocked.
    clerk_auto_provision: bool = False

    # Phase 6.x: object storage provider --------------------------------------
    # A provider boundary exists so the future archive/retrieval workflow can
    # write against one interface; no DataDiet workflow consumes it yet, because
    # the application is metadata-only and connectors cannot read file contents.
    # ``none`` is the default so behaviour is unchanged until an operator opts
    # in, exactly like ``LOCAL_SOURCE_ROOTS`` for local-folder discovery.
    #
    # The connection string is the credential carrier (endpoint, account name
    # and account key or SAS all live inside it) — there is deliberately no
    # separate AZURE_STORAGE_ENDPOINT, because two sources of truth for one
    # endpoint is how a request ends up signed for one account and sent to
    # another. It is a secret: environment variable or platform secret store
    # only, never source, never a VITE_ name, never logged.
    storage_provider: Literal["none", "azure_blob"] = "none"
    azure_storage_connection_string: str = ""
    azure_storage_container: str = "datadiet"
    # A local emulator (Floci) is plain HTTP on loopback, so the exception has to
    # be sayable explicitly — and it is refused outright in a protected
    # environment rather than silently trusted. The adapter enforces the rule
    # itself: the SDK's ``require_https`` keyword is ignored by
    # ``from_connection_string`` in the installed version, so nothing upstream
    # checks the scheme.
    azure_storage_allow_http: bool = False
    azure_storage_timeout_seconds: int = Field(default=30, ge=1, le=300)

    @property
    def protected_environment(self) -> bool:
        """Whether this deployment may not use any development convenience."""
        return self.environment in PROTECTED_ENVIRONMENTS

    @property
    def clerk_enabled(self) -> bool:
        """Clerk verification is on exactly when an issuer has been configured."""
        return bool(self.clerk_issuer and self.resolved_clerk_jwks_url)

    @property
    def resolved_clerk_jwks_url(self) -> str:
        """The JWKS endpoint: the configured one, or Clerk's documented default."""
        if self.clerk_jwks_url:
            return self.clerk_jwks_url
        if not self.clerk_issuer:
            return ""
        return f"{self.clerk_issuer.rstrip('/')}/.well-known/jwks.json"

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_cors_origins(cls, value: object) -> object:
        """Accept ``CORS_ORIGINS`` as a comma-separated list or a JSON array.

        Deployed platforms (App Service application settings, for instance) can
        only carry flat strings, so the comma form is the portable one; the JSON
        form stays supported because it is what pydantic-settings documents for
        list fields.
        """
        if isinstance(value, str):
            text = value.strip()
            if text.startswith("["):
                try:
                    parsed = json.loads(text)
                except json.JSONDecodeError as cause:
                    raise ValueError(
                        "CORS_ORIGINS looks like a JSON array but is not valid JSON"
                    ) from cause
                if not isinstance(parsed, list):
                    raise ValueError("CORS_ORIGINS as JSON must be an array of origins")
                return parsed
            return [origin.strip() for origin in text.split(",") if origin.strip()]
        return value

    @field_validator("auth_jwt_secret")
    @classmethod
    def _validate_secret_strength(cls, value: str, info: object) -> str:
        """Refuse a *weak* protected-environment secret; an absent one fails closed later.

        A missing secret does not stop the process — health/readiness probes
        must stay observable — but ``app.core.auth.require_auth_configured``
        then answers 503 for every protected endpoint. A secret that is present
        but too short is an outright misconfiguration and refuses to start.
        """
        environment = getattr(info, "data", {}).get("environment", "development")
        if environment in PROTECTED_ENVIRONMENTS and value and len(value) < 32:
            raise ValueError(
                "AUTH_JWT_SECRET must be at least 32 characters in staging and production. "
                "Generate one with: python -c \"import secrets; "
                "print(secrets.token_urlsafe(48))\""
            )
        return value

    @model_validator(mode="after")
    def _fail_closed_or_default_dev(self) -> Settings:
        """Apply the development defaults, and strip them out of protected environments.

        In ``development``/``test`` an unset secret falls back to the well-known
        development value so ``npm run dev`` works with no setup, mirroring
        ``DEV_DATABASE_URL``. In ``staging``/``production`` both development
        conveniences are removed: the dev login provider is disabled
        unconditionally (and its route is never registered — see
        ``app.api.routes.auth``), and the development secret is discarded,
        leaving the API fail-closed until Clerk is configured.

        Three further protected-environment rules:

        * explicitly enabling the development provider through the process
          environment is a fatal misconfiguration — the deployment refuses to
          start rather than silently ignoring an operator's stated intent;
        * a Clerk issuer or JWKS URL that is not ``https`` is refused, because
          accepting a public key over a plaintext channel would make the
          signature check only as strong as the network path;
        * a *missing* Clerk configuration is deliberately **not** fatal here: it
          leaves ``clerk_enabled`` false, every protected endpoint answers 503
          ``auth_not_configured``, and ``/health`` and ``/health/ready`` stay
          observable so a platform can tell a misconfigured service from a dead
          one.
        """
        if not self.protected_environment:
            if not self.auth_jwt_secret:
                self.auth_jwt_secret = DEV_AUTH_JWT_SECRET
            return self

        if os.environ.get("AUTH_DEV_PROVIDER_ENABLED", "").strip().lower() in _TRUTHY:
            raise ValueError(
                "AUTH_DEV_PROVIDER_ENABLED must not be enabled when ENVIRONMENT is "
                "staging or production: the development sign-in provider creates "
                "accounts and grants platform administration anonymously. Configure "
                "CLERK_ISSUER instead."
            )
        self.auth_dev_provider_enabled = False
        if self.auth_jwt_secret == DEV_AUTH_JWT_SECRET:
            self.auth_jwt_secret = ""

        for name, value in (
            ("CLERK_ISSUER", self.clerk_issuer),
            ("CLERK_JWKS_URL", self.clerk_jwks_url),
        ):
            if value and not value.lower().startswith("https://"):
                raise ValueError(f"{name} must be an https:// URL in a protected environment")
        return self

    @model_validator(mode="after")
    def _validate_storage(self) -> Settings:
        """Refuse an object-storage configuration that cannot produce a working client.

        Two rules, both fail-closed and both naming only the setting — never a
        value, since ``AZURE_STORAGE_CONNECTION_STRING`` embeds an account key:

        * selecting a provider without giving it a connection string is a
          deployment that would fail at the first write, which is far worse than
          refusing to start;
        * allowing plain HTTP is a development-only concession. In staging or
          production it would carry the SharedKey credential — and every
          archived byte — over an unencrypted transport, so it stops startup the
          same way a non-HTTPS ``CLERK_ISSUER`` does.
        """
        if self.storage_provider == "none":
            return self
        if not self.azure_storage_connection_string.strip():
            raise ValueError(
                "AZURE_STORAGE_CONNECTION_STRING is required when STORAGE_PROVIDER is not 'none'"
            )
        if self.protected_environment and self.azure_storage_allow_http:
            raise ValueError(
                "AZURE_STORAGE_ALLOW_HTTP must not be enabled when ENVIRONMENT is staging or "
                "production: it permits the storage credential to cross a plaintext transport"
            )
        return self

    @field_validator("database_url")
    @classmethod
    def _validate_database_url(cls, value: str) -> str:
        if "://" not in value:
            raise ValueError(
                "DATABASE_URL must be a SQLAlchemy URL such as "
                "postgresql+psycopg2://user:password@host:5432/database"
            )
        return value


@lru_cache
def get_settings() -> Settings:
    """Return cached settings instance (cache is cleared in tests)."""
    return Settings()
