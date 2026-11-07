"""Health and readiness endpoints.

``/health``      — liveness only; always available; never touches the database.
``/health/ready`` — readiness; probes the database and reports degraded status
                   with HTTP 503 when it is unreachable, plus which identity
                   provider this process will accept. Both blocks are
                   credential-free: ``status`` remains the database gate
                   (docs/azure-architecture.md F5) so an unconfigured identity
                   provider degrades authentication without making the platform
                   tear down a service that is otherwise serving traffic.
"""

from __future__ import annotations

from fastapi import APIRouter, Response, status

from app.api.schemas.health import (
    AuthenticationStatus,
    DatabaseStatus,
    HealthResponse,
    ReadinessResponse,
)
from app.core.auth import describe_authentication
from app.core.config import get_settings
from app.db.session import check_database_connection

router = APIRouter(prefix="/health")


@router.get("", response_model=HealthResponse, summary="Liveness probe")
def health() -> HealthResponse:
    settings = get_settings()
    return HealthResponse(
        service=settings.app_name,
        version=settings.app_version,
        environment=settings.environment,
    )


@router.get(
    "/ready",
    response_model=ReadinessResponse,
    summary="Readiness probe (checks database)",
    responses={503: {"description": "Database unreachable"}},
)
def readiness(response: Response) -> ReadinessResponse:
    reachable, detail = check_database_connection()
    if not reachable:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    auth = describe_authentication()
    return ReadinessResponse(
        status="ready" if reachable else "degraded",
        database=DatabaseStatus(reachable=reachable, detail=detail),
        authentication=AuthenticationStatus(
            configured=auth.configured,
            provider=auth.provider,
            issuer=auth.issuer,
            detail=auth.detail,
        ),
    )
