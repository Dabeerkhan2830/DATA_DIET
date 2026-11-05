"""DataDiet FastAPI application factory.

Run from the repository's ``backend/`` directory:

    uvicorn app.main:app --reload
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.config import get_settings


def create_app() -> FastAPI:
    """Build the FastAPI application with middleware and routes."""
    settings = get_settings()

    application = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        description=(
            "DataDiet — intelligent data lifecycle and privacy management.\n\n"
            "**Lifecycle actions (archive, restore, move, delete, dispose) are "
            "NOT implemented** and Phase 1 has no destructive actions at all. "
            "Authentication and authorization are implemented for development "
            "and test; a production deployment must configure an identity "
            "provider or signing secret — see docs/decisions.md ADR-0014."
        ),
        contact={"name": "DataDiet team"},
        license_info={"name": "Proprietary"},
    )

    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        # Bearer tokens are sent in an Authorization header, so credentials
        # (cookies) stay off. The method list must cover every verb the API
        # exposes, otherwise a cross-origin browser preflight rejects writes.
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )

    application.include_router(api_router, prefix=settings.api_v1_prefix)

    @application.get("/", include_in_schema=False)
    def root() -> dict[str, str]:
        return {
            "service": settings.app_name,
            "docs": "/docs",
            "health": f"{settings.api_v1_prefix}/health",
        }

    return application


app = create_app()
