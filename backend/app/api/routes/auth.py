"""Authentication endpoints (Phase 7, ADR-0014).

There are three surfaces:

``GET  /auth/config``   Public. Reports what kind of authentication this
                        deployment actually has, so the frontend never claims
                        single sign-on exists when it does not.
``POST /auth/dev-login`` Development/test only. Creates or reuses a *synthetic*
                        local account and issues a real, signed HS256 bearer
                        token. It is forcibly disabled in production, so
                        development identity can never become production
                        authentication.
``GET  /auth/me``       Returns the verified identity, institution scope, and
                        permissions derived from the local directory.

There is deliberately **no** logout endpoint: bearer tokens are stateless, so
sign-out is discarding the token client-side. There is also no password
anywhere in this module — DataDiet stores no credentials at all, only a
directory of accounts that a token's verified subject maps onto.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas.auth import (
    AuthConfig,
    DevLoginRequest,
    TokenResponse,
    UserProfile,
)
from app.core.auth import (
    CurrentUser,
    build_current_user,
    get_current_user,
    require_auth_configured,
)
from app.core.config import get_settings
from app.core.security import issue_token
from app.db.models import AppUser, Institution, UserMembership
from app.db.session import get_db
from app.services.audit import record_event

router = APIRouter(prefix="/auth")


def _profile(current: CurrentUser) -> UserProfile:
    return UserProfile(
        id=current.id,
        email=current.email,
        display_name=current.display_name,
        is_platform_admin=current.is_platform_admin,
        role=current.role,
        institutions=sorted(current.institutions),
        permissions=sorted(current.permissions),
    )


def _unconfigured() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=(
            "sign_in_unavailable: Single sign-on is not configured for this "
            "deployment: no identity provider is wired up, and there is no "
            "local sign-in outside development. See docs/decisions.md ADR-0014."
        ),
    )


@router.get("/config", response_model=AuthConfig, summary="How this deployment authenticates")
def auth_config() -> AuthConfig:
    """Public on purpose: it exposes no secret and lets the UI tell the truth."""
    settings = get_settings()
    dev_enabled = (
        settings.environment != "production"
        and settings.auth_dev_provider_enabled
        and bool(settings.auth_jwt_secret)
    )
    if dev_enabled:
        authentication: str = "development"
        description = (
            "Development sign-in is available. It issues local tokens for "
            "synthetic accounts and is disabled in production."
        )
    elif settings.environment == "production" and settings.auth_jwt_secret:
        authentication = "bearer_boundary"
        description = (
            "Bearer-token verification is configured, but this application does "
            "not yet implement the browser sign-in redirect: an external "
            "identity provider must issue tokens."
        )
    else:
        authentication = "unconfigured"
        description = (
            "Authentication is not configured. Every protected endpoint is "
            "unavailable (HTTP 503) until AUTH_JWT_SECRET is set."
        )
    return AuthConfig(
        environment=settings.environment,
        authentication=authentication,
        dev_login_enabled=dev_enabled,
        issuer=settings.auth_jwt_issuer,
        audience=settings.auth_jwt_audience,
        token_ttl_seconds=settings.auth_token_ttl_seconds,
        description=description,
    )


@router.post(
    "/dev-login",
    response_model=TokenResponse,
    summary="Development sign-in (never available in production)",
)
def dev_login(data: DevLoginRequest, db: Session = Depends(get_db)) -> TokenResponse:
    """Issue a real bearer token for a synthetic development account.

    The token goes through exactly the same verification path as any other
    request — there is no bypass — so development exercises production
    authentication rather than a parallel mechanism.
    """
    require_auth_configured()
    settings = get_settings()
    if settings.environment == "production" or not settings.auth_dev_provider_enabled:
        # Refuse before touching the database. In particular, do not create an
        # audit row whose actor/entity are attacker-controlled input: a public
        # unauthenticated request must not be able to write to the audit log.
        raise _unconfigured()

    if data.institution_id is not None and db.get(Institution, data.institution_id) is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Institution {data.institution_id} does not exist",
        )

    user = db.execute(
        select(AppUser).where(AppUser.email == data.email)
    ).scalar_one_or_none()
    created = user is None
    if user is None:
        user = AppUser(
            email=data.email,
            display_name=data.display_name or data.email.split("@")[0],
            is_platform_admin=data.platform_admin,
            is_active=True,
        )
        db.add(user)
        db.flush()
    else:
        if not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="forbidden: this development account is deactivated",
            )
        if data.display_name:
            user.display_name = data.display_name
        # Grants only; development sign-in can never revoke administration.
        if data.platform_admin:
            user.is_platform_admin = True

    if data.institution_id is not None:
        membership = db.execute(
            select(UserMembership).where(
                UserMembership.app_user_id == user.id,
                UserMembership.institution_id == data.institution_id,
            )
        ).scalar_one_or_none()
        if membership is None:
            db.add(
                UserMembership(
                    app_user_id=user.id,
                    institution_id=data.institution_id,
                    role=data.role,
                    is_active=True,
                    created_by="development-provider",
                )
            )
        else:
            membership.role = data.role
            membership.is_active = True

    db.commit()
    db.refresh(user)

    claims = build_current_user(db, {"sub": str(user.id)})
    token = issue_token(
        subject=str(user.id),
        issuer=settings.auth_jwt_issuer,
        audience=settings.auth_jwt_audience,
        secret=settings.auth_jwt_secret,
        expires_in_seconds=settings.auth_token_ttl_seconds,
        # The email is the account's identifier in the directory and the claim
        # an external identity provider would carry; it names, never authorizes.
        claims={"email": user.email},
    )
    record_event(
        db,
        actor=user.email,
        event_type="auth.dev_login",
        entity_type="app_user",
        entity_id=user.id,
        payload={
            "user_id": user.id,
            "institution_id": data.institution_id,
            "role": data.role,
            "platform_admin": bool(user.is_platform_admin),
            "account_created": created,
        },
    )
    return TokenResponse(
        access_token=token,
        expires_in=settings.auth_token_ttl_seconds,
        user=_profile(claims),
    )


@router.get("/me", response_model=UserProfile, summary="The verified caller")
def me(current: CurrentUser = Depends(get_current_user)) -> UserProfile:
    return _profile(current)
