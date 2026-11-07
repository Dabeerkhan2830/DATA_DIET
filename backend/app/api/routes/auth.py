"""Authentication endpoints (Phase 7, extended by Clerk in Phase 6.0).

There are four surfaces:

``GET  /auth/config``   Public. Reports what kind of authentication this
                        deployment actually has, so the frontend never claims
                        single sign-on exists when it does not.
``GET  /auth/me``       Returns the verified identity, institution scope, and
                        permissions derived from the local directory. Works
                        identically for a Clerk session token and for a
                        development token: everything after verification is the
                        same directory lookup.
``router``              The two routes above. Always registered.
``dev_router``          ``POST /auth/dev-login`` — the development/test provider
                        only. ``create_app`` registers it *conditionally*, so in
                        a staging or production deployment the route does not
                        exist (404 from the router) rather than being a button
                        that is hidden; the handler still re-checks, so an
                        accidentally-registered route cannot be used either.

A Clerk-authenticated caller brings their own session token, issued by Clerk's
own SDK rather than by this API, so there is deliberately **no** sign-in,
callback, or token-exchange endpoint for Clerk here. There is likewise no logout
endpoint: bearer tokens are stateless, so sign-out is discarding the token
client-side (Clerk's SDK ends the browser session on the frontend). There is no
password anywhere in this module — DataDiet stores no credentials at all, only a
directory of accounts that a verified subject maps onto.
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
    PROVIDER_LOCAL,
    CurrentUser,
    bearer_boundary_secret,
    build_current_user,
    get_current_user,
    require_auth_configured,
)
from app.core.config import get_settings
from app.core.security import issue_token
from app.db.models import AppUser, Institution, UserMembership
from app.db.session import get_db
from app.services.audit import record_event

#: Always registered. ``/auth/me`` answers for both providers, which is the
#: point: authorization never depends on which identity provider was used.
router = APIRouter(prefix="/auth")

#: Registered only outside staging and production, and it refuses its own
#: requests whenever a Clerk issuer is configured (such a token could not be
#: verified, so issuing one would be a trap).
dev_router = APIRouter(prefix="/auth")


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
            "local sign-in outside development. See docs/decisions.md ADR-0014 "
            "and ADR-0025."
        ),
    )


@router.get("/config", response_model=AuthConfig, summary="How this deployment authenticates")
def auth_config() -> AuthConfig:
    """Public on purpose: it exposes no secret and lets the UI tell the truth."""
    settings = get_settings()
    # A Clerk-configured deployment verifies RS256 only, so an HS256 token from
    # the development provider would be minted and then refused. Reporting the
    # provider as available in that state would be a lie the UI then believes.
    dev_enabled = (
        not settings.protected_environment
        and settings.auth_dev_provider_enabled
        and bool(settings.auth_jwt_secret)
        and not settings.clerk_enabled
    )

    if settings.clerk_enabled:
        authentication: str = "clerk"
        identity_provider = "clerk"
        issuer = settings.clerk_issuer
        audience = settings.clerk_audience
        description = (
            "Session tokens are issued by Clerk and verified here with RS256 "
            "against Clerk's published keys. Sign in through Clerk; this API "
            "issues no tokens. A Clerk identity must already be linked to a "
            "DataDiet account to see anything."
        )
    elif dev_enabled:
        # Only true outside staging and production: a protected environment
        # forces the provider off in settings construction and never registers
        # the route.
        authentication = "development"
        identity_provider = "local"
        issuer = settings.auth_jwt_issuer
        audience = settings.auth_jwt_audience
        description = (
            "Development sign-in is available. It issues local tokens for "
            "synthetic accounts and is disabled in staging and production."
        )
    elif bearer_boundary_secret(settings):
        # ADR-0014's bearer boundary: reached in a protected environment that
        # carries its own signing secret, and in development/test when the
        # provider is switched off but a real secret is configured.
        authentication = "bearer_boundary"
        identity_provider = "local"
        issuer = settings.auth_jwt_issuer
        audience = settings.auth_jwt_audience
        description = (
            "Bearer-token verification is configured, but this application does "
            "not implement the browser sign-in redirect: an external identity "
            "provider must issue tokens."
        )
    else:
        authentication = "unconfigured"
        identity_provider = "none"
        issuer = "" if settings.protected_environment else settings.auth_jwt_issuer
        audience = "" if settings.protected_environment else settings.auth_jwt_audience
        description = (
            "Authentication is not configured. Every protected endpoint is "
            "unavailable (HTTP 503) until a Clerk issuer or a signing secret is "
            "set, and the development sign-in route is not registered in "
            "staging and production."
        )
    return AuthConfig(
        environment=settings.environment,
        authentication=authentication,
        dev_login_enabled=dev_enabled,
        identity_provider=identity_provider,
        issuer=issuer,
        audience=audience,
        token_ttl_seconds=settings.auth_token_ttl_seconds,
        description=description,
    )


@router.get("/me", response_model=UserProfile, summary="The verified caller")
def me(current: CurrentUser = Depends(get_current_user)) -> UserProfile:
    return _profile(current)


@dev_router.post(
    "/dev-login",
    response_model=TokenResponse,
    summary="Development sign-in (never registered in staging or production)",
)
def dev_login(data: DevLoginRequest, db: Session = Depends(get_db)) -> TokenResponse:
    """Issue a real bearer token for a synthetic development account.

    The token goes through exactly the same verification path as any other
    request — there is no bypass — so development exercises the real
    authentication code rather than a parallel mechanism.

    Two independent guards protect this. ``create_app`` does not register the
    route at all in a protected environment, and this handler refuses before
    touching the database even if the route somehow exists. In particular it
    does not create an audit row whose actor/entity are attacker-controlled
    input: a public unauthenticated request must not be able to write to the
    audit log.
    """
    require_auth_configured()
    settings = get_settings()
    if (
        settings.protected_environment
        or not settings.auth_dev_provider_enabled
        or settings.clerk_enabled
    ):
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

    claims = build_current_user(db, {"sub": str(user.id)}, provider=PROVIDER_LOCAL)
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
