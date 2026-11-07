"""Authentication and authorization for DataDiet (Phase 7, extended in Phase 6.0).

Identity comes from a verified bearer token and is resolved against the local
user directory (``app_users`` / ``user_memberships`` / ``external_identities``).
The directory is authoritative for *authorization*: an identity provider proves
who someone is, while DataDiet decides what that account may do. Token claims
about institution, role, **or Clerk metadata** are therefore never used for
authorization.

Two verification paths exist and the *server's configuration* chooses between
them — a token never chooses (ADR-0025):

``staging`` / ``production``
    Clerk only: RS256 against the provider's cached JWKS. There is no HS256
    fallback, and there is no development provider to fall back to (its route is
    not even registered). Missing or invalid Clerk configuration fails closed.

``development`` / ``test``
    The strict HS256 boundary from ADR-0014, unless a Clerk issuer is
    configured — in which case Clerk is used, and a Clerk verification failure
    still is not retried as HS256.

The layer is fail-closed:

* in a protected environment with no usable Clerk configuration every protected
  request returns 503 — the app never falls back to an anonymous or development
  identity;
* a missing/invalid/expired token returns 401;
* a valid identity lacking the required permission returns 403;
* a resource outside the caller's institution scope returns 404, so the
  existence of another tenant's data is not disclosed.

Client-supplied ``institution_id`` values (query, path, or body) are never
treated as proof of identity: they are validated *against* the verified
identity by :func:`resolve_institution_scope`.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass, field

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import DEV_AUTH_JWT_SECRET, Settings, get_settings
from app.core.security import (
    TokenError,
    get_jwks_client,
    verify_clerk_token,
    verify_token,
)
from app.db.models import AppUser, ExternalIdentity, UserMembership
from app.db.session import get_db
from app.services.audit import record_event

#: Which verification path produced the claims, and therefore which subject
#: resolution rule applies. Never derived from the token itself.
PROVIDER_LOCAL = "local"
PROVIDER_CLERK = "clerk"

# --------------------------------------------------------------------------- #
# Permission vocabulary and role matrix
# --------------------------------------------------------------------------- #

PERMISSION_INVENTORY_READ = "inventory:read"
PERMISSION_GOVERNANCE_READ = "governance:read"
PERMISSION_RETENTION_READ = "retention:read"
PERMISSION_SOURCES_READ = "sources:read"
PERMISSION_RETENTION_ASSESS = "retention:assess"
PERMISSION_REVIEW_DECIDE = "review:decide"
PERMISSION_RETENTION_WRITE = "retention:write"
PERMISSION_SOURCES_WRITE = "sources:write"
PERMISSION_ASSETS_WRITE = "assets:write"
PERMISSION_CLASSIFICATION_WRITE = "classification:write"
PERMISSION_USERS_MANAGE = "users:manage"

ALL_PERMISSIONS: frozenset[str] = frozenset(
    {
        PERMISSION_INVENTORY_READ,
        PERMISSION_GOVERNANCE_READ,
        PERMISSION_RETENTION_READ,
        PERMISSION_SOURCES_READ,
        PERMISSION_RETENTION_ASSESS,
        PERMISSION_REVIEW_DECIDE,
        PERMISSION_RETENTION_WRITE,
        PERMISSION_SOURCES_WRITE,
        PERMISSION_ASSETS_WRITE,
        PERMISSION_CLASSIFICATION_WRITE,
        PERMISSION_USERS_MANAGE,
    }
)

ROLE_VIEWER = "viewer"
ROLE_REVIEWER = "reviewer"
ROLE_ADMIN = "admin"

#: Everything a read-only member may do: see inventory, governance, retention,
#: and source/scan metadata for their own institution.
_VIEWER_PERMISSIONS: frozenset[str] = frozenset(
    {
        PERMISSION_INVENTORY_READ,
        PERMISSION_GOVERNANCE_READ,
        PERMISSION_RETENTION_READ,
        PERMISSION_SOURCES_READ,
    }
)

#: A reviewer adds the two review-workflow actions on top of read access.
_REVIEWER_PERMISSIONS: frozenset[str] = _VIEWER_PERMISSIONS | {
    PERMISSION_RETENTION_ASSESS,
    PERMISSION_REVIEW_DECIDE,
}

#: Minimal, documented role/permission matrix (ADR-0014). ``admin`` is the
#: highest institution-scoped role; cross-institution administration and user
#: management require the ``is_platform_admin`` flag on the account, not a role.
ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    ROLE_VIEWER: _VIEWER_PERMISSIONS,
    ROLE_REVIEWER: _REVIEWER_PERMISSIONS,
    ROLE_ADMIN: _REVIEWER_PERMISSIONS
    | {
        PERMISSION_RETENTION_WRITE,
        PERMISSION_SOURCES_WRITE,
        PERMISSION_ASSETS_WRITE,
        PERMISSION_CLASSIFICATION_WRITE,
    },
}

VALID_ROLES: frozenset[str] = frozenset(ROLE_PERMISSIONS)


# --------------------------------------------------------------------------- #
# Authenticated identity
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class CurrentUser:
    """A verified, active DataDiet account."""

    id: int
    email: str
    display_name: str
    is_platform_admin: bool
    #: Institutions the account holds at least one *active* membership for.
    institutions: frozenset[int] = field(default_factory=frozenset)
    #: Highest role held across active memberships (``None`` when the account
    #: has no active membership and is not a platform administrator).
    role: str | None = None
    permissions: frozenset[str] = field(default_factory=frozenset)

    @property
    def institution_id(self) -> int | None:
        """The account's primary institution scope, or ``None`` when unscoped."""
        if len(self.institutions) == 1:
            return next(iter(self.institutions))
        return None

    def can_access(self, institution_id: int | None) -> bool:
        """Whether this account may read a resource of the given institution."""
        if self.is_platform_admin:
            return True
        # Unscoped rows predate tenancy and belong to no tenant, so every
        # authenticated account may read them.
        if institution_id is None:
            return True
        return institution_id in self.institutions


def _unauthenticated(detail: str, *, code: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=f"{code}: {detail}",
        headers={"WWW-Authenticate": 'Bearer error="invalid_token"'},
    )


def _forbidden(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"forbidden: {detail}")


def _service_unavailable(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=detail)


#: Shared 503 text for "nothing usable is configured", so the message a client
#: sees never depends on which secret happened to be missing.
_AUTH_UNCONFIGURED_MESSAGE = (
    "auth_not_configured: Authentication is not configured for this deployment: "
    "neither a Clerk issuer nor a signing secret is set, so every authenticated "
    "endpoint is unavailable. See docs/decisions.md ADR-0014 and ADR-0025."
)

#: Address suffix used when a provisioned Clerk account has no email claim.
#: ``.invalid`` is reserved by RFC 2606 and can never receive mail, which makes
#: such a row unmistakably a placeholder rather than somebody's address.
PROVISIONAL_EMAIL_DOMAIN = "identity.invalid"


def bearer_boundary_secret(settings: Settings) -> bool:
    """Whether a protected deployment carries a signing secret of its own.

    This is ADR-0014's bearer boundary: the API verifies tokens but issues none,
    so an external system must sign them. The development placeholder never
    qualifies — a protected environment may not be authenticated by a secret that
    is published in the repository.
    """
    return bool(settings.auth_jwt_secret) and settings.auth_jwt_secret != DEV_AUTH_JWT_SECRET


def _bearer_token(request: Request) -> str:
    header = request.headers.get("Authorization", "")
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        raise _unauthenticated(
            "Sign in with a bearer token to use this endpoint.", code="not_authenticated"
        )
    return value.strip()


def _verify_bearer(request: Request) -> tuple[dict, str]:
    """Verify the request's bearer token and report which path verified it.

    The path is chosen from server configuration before any token is parsed, and
    a Clerk failure is never retried as HS256: on the Clerk path the only way
    out of this function with claims is a verified RS256 signature.
    """
    settings = get_settings()
    token = _bearer_token(request)
    if settings.clerk_enabled:
        try:
            claims = verify_clerk_token(
                token,
                issuer=settings.clerk_issuer,
                audience=settings.clerk_audience,
                jwks_client=get_jwks_client(settings.resolved_clerk_jwks_url),
            )
        except TokenError as cause:
            if cause.reason == "identity_provider_unavailable":
                # The provider's public-key endpoint is unreachable and nothing
                # is cached. Refusing service is honest; answering 401 would make
                # the frontend discard a perfectly good session token.
                raise _service_unavailable(
                    "identity_provider_unavailable: The identity provider's signing keys "
                    "could not be retrieved, so this request cannot be verified."
                ) from None
            raise _unauthenticated(cause.message, code=cause.reason) from None
        return claims, PROVIDER_CLERK

    try:
        claims = verify_token(
            token,
            issuer=settings.auth_jwt_issuer,
            audience=settings.auth_jwt_audience,
            secret=settings.auth_jwt_secret,
        )
    except TokenError as cause:
        raise _unauthenticated(cause.message, code=cause.reason) from None
    return claims, PROVIDER_LOCAL


def require_auth_configured() -> None:
    """Fail closed when a protected deployment has no trustworthy authentication.

    In ``staging``/``production`` exactly two things are acceptable, and nothing
    else is: a working Clerk configuration (the supported path, and the one that
    wins whenever it is configured), or the ADR-0014 *bearer boundary* — an
    explicit, strong ``AUTH_JWT_SECRET`` on tokens an external system issued,
    with no browser sign-in. Anything else is refused with 503 for every
    protected endpoint.

    In particular a protected environment can never be authenticated by the
    development placeholder secret or by the development sign-in provider, whose
    route is not even registered, so there is no anonymous path that creates an
    account or grants platform administration. The placeholder is excluded
    explicitly rather than by environment alone, because a settings object built
    outside a protected environment can have had its ``environment`` swapped
    after construction.
    """
    settings = get_settings()
    if settings.protected_environment:
        if settings.clerk_enabled:
            return
        if bearer_boundary_secret(settings):
            return
        raise _service_unavailable(
            "auth_not_configured: This deployment is configured for a protected "
            "environment, but no trusted authentication is usable: CLERK_ISSUER is "
            "missing or invalid and no signing secret is configured. Every "
            "authenticated endpoint is unavailable and the development sign-in "
            "provider is not registered. See docs/decisions.md ADR-0014 and ADR-0025."
        )

    # Development and test. The placeholder secret is legitimate here precisely
    # because it is *not* honoured above; a settings object whose secret was
    # cleared after construction still fails closed.
    if settings.auth_jwt_secret:
        return
    if settings.clerk_enabled:
        return
    raise _service_unavailable(_AUTH_UNCONFIGURED_MESSAGE)


@dataclass(frozen=True)
class AuthenticationReadiness:
    """Credential-free description of the authentication path in force.

    Produced by :func:`describe_authentication` for the readiness probe, which
    has to answer truthfully without being able to raise.
    """

    configured: bool
    provider: str
    issuer: str
    detail: str


def describe_authentication() -> AuthenticationReadiness:
    """Non-raising mirror of :func:`require_auth_configured` and :func:`_verify_bearer`.

    The *provider* is the one ``_verify_bearer`` would actually use — a Clerk
    issuer wins even in development, because that is how the request path
    behaves. The *configured* flag is whether ``require_auth_configured`` would
    let a request through. No secret, key or token is ever reported; the Clerk
    issuer origin is public information by design.
    """
    settings = get_settings()
    if settings.protected_environment:
        if settings.clerk_enabled:
            return AuthenticationReadiness(
                configured=True,
                provider="clerk",
                issuer=settings.clerk_issuer,
                detail="Clerk RS256 verification against the cached JWKS endpoint.",
            )
        if bearer_boundary_secret(settings):
            return AuthenticationReadiness(
                configured=True,
                provider="signing_secret",
                issuer="",
                detail=(
                    "Bearer-token boundary (ADR-0014): tokens are verified here but "
                    "issued elsewhere, and the development sign-in route is not registered."
                ),
            )
        return AuthenticationReadiness(
            configured=False,
            provider="none",
            issuer="",
            detail=(
                "auth_not_configured: CLERK_ISSUER is missing or invalid and no signing "
                "secret is configured, so every authenticated endpoint answers 503."
            ),
        )
    if settings.clerk_enabled:
        return AuthenticationReadiness(
            configured=True,
            provider="clerk",
            issuer=settings.clerk_issuer,
            detail="Clerk RS256 verification is configured and takes precedence.",
        )
    if settings.auth_jwt_secret:
        return AuthenticationReadiness(
            configured=True,
            provider="development",
            issuer="",
            detail=(
                "Development/test signing secret in use; never available in "
                "staging or production."
            ),
        )
    return AuthenticationReadiness(
        configured=False,
        provider="none",
        issuer="",
        detail="auth_not_configured: no Clerk issuer and no signing secret.",
    )


def _resolve_clerk_subject(db: Session, claims: dict) -> AppUser:
    """Map a verified Clerk ``sub`` onto a DataDiet account.

    Clerk's ``sub`` is the *only* thing that names an account here — never the
    email, never ``pubm``/``nbf`` metadata, never a role claim. An identity that
    has no binding is refused unless the operator has explicitly turned on
    permissionless provisioning, and even then provisioning can never grant
    ``is_platform_admin`` or a membership.
    """
    subject = claims.get("sub")
    if not isinstance(subject, str) or not subject.strip():
        raise _unauthenticated(
            "The bearer token carries no subject this server can map to an account.",
            code="invalid_subject",
        )
    subject = subject.strip()

    binding = db.execute(
        select(ExternalIdentity).where(
            ExternalIdentity.provider == PROVIDER_CLERK,
            ExternalIdentity.external_subject == subject,
        )
    ).scalar_one_or_none()

    if binding is not None:
        user = db.get(AppUser, binding.app_user_id)
        if user is None:
            raise _unauthenticated(
                "The authenticated account is unknown or deactivated.", code="unknown_account"
            )
        return user

    if not get_settings().clerk_auto_provision:
        raise _unauthenticated(
            "This identity is not linked to a DataDiet account yet; an administrator "
            "must link it first.",
            code="unknown_account",
        )
    return _provision_clerk_account(db, subject=subject, claims=claims)


def _provision_clerk_account(db: Session, *, subject: str, claims: dict) -> AppUser:
    """Create a *permissionless* account for a verified Clerk identity.

    Reached only when ``CLERK_AUTO_PROVISION=true``. The account is created with
    ``is_platform_admin=false`` and no membership, so it can sign in and see
    nothing until an administrator grants a membership: provisioning is an
    acknowledgement that someone authenticated, never a grant of authority.
    """
    email_claim = claims.get("email")
    observed = email_claim.strip().lower() if isinstance(email_claim, str) else ""
    name_claim = claims.get("name")
    display = name_claim.strip() if isinstance(name_claim, str) and name_claim.strip() else subject

    email = observed or f"clerk-{subject}@{PROVISIONAL_EMAIL_DOMAIN}"
    clash = db.execute(select(AppUser).where(AppUser.email == email)).scalar_one_or_none()
    if clash is not None:
        # Never merge two identities because an address happens to match: the
        # directory would silently inherit whoever already held that email.
        raise _unauthenticated(
            "This identity is not linked to a DataDiet account yet; an administrator "
            "must link it first.",
            code="unknown_account",
        )

    user = AppUser(
        email=email,
        display_name=display[:200],
        is_platform_admin=False,
        is_active=True,
    )
    db.add(user)
    db.flush()
    db.add(
        ExternalIdentity(
            provider=PROVIDER_CLERK,
            external_subject=subject[:120],
            app_user_id=user.id,
            last_email=observed or None,
            bound_by="auto_provision",
        )
    )
    db.commit()
    record_event(
        db,
        actor=email,
        event_type="auth.identity_provisioned",
        entity_type="app_user",
        entity_id=user.id,
        payload={
            "provider": PROVIDER_CLERK,
            "external_subject": subject,
            "via": "auto_provision",
            "is_platform_admin": False,
            "memberships": 0,
        },
    )
    db.refresh(user)
    return user


def _resolve_subject(db: Session, claims: dict) -> AppUser:
    """Map a verified development/test token onto a local account.

    Three subject shapes are accepted, in order:

    1. an ``email`` claim — the standard OIDC way to name an account, so a real
       identity provider and the development provider bind identically;
    2. a numeric ``sub`` — the development provider's account id, also what an
       integration may use when it is told our ids;
    3. anything else is refused, because an opaque subject we cannot map proves
       only that *someone* is calling, not who.

    The *claims* only ever name an account. They never carry roles or
    institution scope — those come from the directory.
    """
    email = claims.get("email")
    subject = claims.get("sub")

    if isinstance(email, str) and email.strip():
        user = db.execute(
            select(AppUser).where(AppUser.email == email.strip().lower())
        ).scalar_one_or_none()
        if user is not None:
            return user

    if isinstance(subject, str) and subject.strip().isdigit():
        user = db.get(AppUser, int(subject))
        if user is not None:
            return user

    if not (isinstance(email, str) and email.strip()) and not (
        isinstance(subject, str) and subject.strip().isdigit()
    ):
        # Nothing here names an account: an opaque provider subject proves only
        # that *someone* is calling, not who.
        raise _unauthenticated(
            "The bearer token carries no subject this server can map to an account.",
            code="invalid_subject",
        )
    raise _unauthenticated(
        "The authenticated account is unknown or deactivated.",
        code="unknown_account",
    )


def build_current_user(
    db: Session, claims: dict, *, provider: str = PROVIDER_LOCAL
) -> CurrentUser:
    """Resolve verified claims against the local user directory.

    ``provider`` records which verification path produced the claims, and so
    which subject rule applies. It is chosen by this server, never read from the
    token, and it changes nothing about *authorization*: roles and institution
    scope come from the directory either way.
    """
    if provider == PROVIDER_CLERK:
        user = _resolve_clerk_subject(db, claims)
    else:
        user = _resolve_subject(db, claims)
    if not user.is_active:
        raise _unauthenticated(
            "The authenticated account is unknown or deactivated.", code="unknown_account"
        )

    memberships = db.scalars(
        select(UserMembership).where(
            UserMembership.app_user_id == user.id,
            UserMembership.is_active.is_(True),
        )
    ).all()
    institutions = frozenset(m.institution_id for m in memberships)

    permissions: set[str] = set()
    role: str | None = None
    for membership in memberships:
        granted = ROLE_PERMISSIONS.get(membership.role)
        if granted is not None:
            permissions |= granted
            if role is None or _role_rank(membership.role) > _role_rank(role):
                role = membership.role

    if user.is_platform_admin:
        permissions |= ALL_PERMISSIONS
        if role is None:
            role = ROLE_ADMIN

    return CurrentUser(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        is_platform_admin=bool(user.is_platform_admin),
        institutions=institutions,
        role=role,
        permissions=frozenset(permissions),
    )


def _role_rank(role: str) -> int:
    order = {ROLE_VIEWER: 0, ROLE_REVIEWER: 1, ROLE_ADMIN: 2}
    return order.get(role, -1)


def get_current_user(
    request: Request,
    db: Session = Depends(get_db),
) -> CurrentUser:
    """FastAPI dependency: authenticate the request or fail closed."""
    require_auth_configured()
    claims, provider = _verify_bearer(request)
    return build_current_user(db, claims, provider=provider)


def require_permission(permission: str) -> Callable[..., CurrentUser]:
    """Dependency factory enforcing one permission from the documented matrix."""

    if permission not in ALL_PERMISSIONS:
        raise ValueError(f"Unknown permission: {permission}")

    def dependency(
        request: Request,
        current: CurrentUser = Depends(get_current_user),
        db: Session = Depends(get_db),
    ) -> CurrentUser:
        if permission in current.permissions:
            return current
        _audit_denied_write(request, current, db, required=f"permission:{permission}")
        raise _forbidden(
            f"This action requires the {permission!r} permission, which "
            f"{current.email} does not have."
        )

    return dependency


#: Methods that would change state if they were allowed. Denied *reads* are not
#: audited, extending ADR-0013's rule that read traffic stays out of the
#: append-only log — otherwise merely probing an API would flood it, and an
#: unauthorized existence probe would be indistinguishable from ordinary
#: navigation. A refused attempt to change something is recorded.
_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def _audit_denied_write(
    request: Request, current: CurrentUser, db: Session, *, required: str
) -> None:
    """Record a refused state-changing request against the caller's identity."""
    if request.method not in _WRITE_METHODS:
        return
    try:
        record_event(
            db,
            actor=current.email,
            event_type="authorization.denied",
            entity_type="endpoint",
            entity_id=request.url.path,
            payload={
                "method": request.method,
                "path": request.url.path,
                "required": required,
                "account_id": current.id,
            },
        )
    except Exception:
        # Auditing must never mask the refusal: a failed log write rolls back
        # and the 403 is still raised by the caller.
        db.rollback()


def require_any_permission(*permissions: str) -> Callable[..., CurrentUser]:
    """Dependency factory enforcing at least one of several permissions."""

    def dependency(current: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if not current.permissions.intersection(permissions):
            required = " or ".join(repr(p) for p in permissions)
            raise _forbidden(
                f"This action requires the {required} permission, which "
                f"{current.email} does not have."
            )
        return current

    return dependency


# --------------------------------------------------------------------------- #
# Institution scoping
# --------------------------------------------------------------------------- #


def resolve_institution_scope(current: CurrentUser, requested: int | None) -> int | None:
    """Validate a client-supplied institution filter against the identity.

    Returns the institution id the query must be filtered by. ``None`` — "every
    institution" — is only ever returned for a platform administrator, so an
    unscoped query can never widen a normal account's visibility. A request
    naming an institution the account does not belong to is answered with 404,
    never 403, so membership of another tenant is not disclosed.
    """
    if current.is_platform_admin:
        return requested
    if requested is not None:
        if requested in current.institutions:
            return requested
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="institution_out_of_scope"
        )
    if not current.institutions:
        raise _forbidden(
            "This account has no active institution membership, so it can see no "
            "institution-scoped records."
        )
    if len(current.institutions) == 1:
        return next(iter(current.institutions))
    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail=(
            "institution_id is required: this account is a member of more than one "
            "institution, so the query must name which one to list."
        ),
    )


def record_scope_denial(request: Request, current: CurrentUser, db: Session) -> None:
    """Record a refused institution-scope check on a state-changing request."""
    _audit_denied_write(request, current, db, required="institution_scope")


def ensure_institution_access(
    current: CurrentUser,
    institution_id: int | None,
    *,
    request: Request | None = None,
    db: Session | None = None,
) -> None:
    """Refuse access to a resource belonging to another institution.

    Write routes pass ``request`` and ``db`` so a refused cross-institution
    mutation is recorded as ``authorization.denied`` before the same 404 is
    returned. The event deliberately omits the requested institution id, so the
    audit trail does not become a directory of other tenants.
    """
    if current.can_access(institution_id):
        return
    if request is not None and db is not None:
        record_scope_denial(request, current, db)
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail="out_of_scope"
    )



def visible_institutions(current: CurrentUser) -> Iterable[int] | None:
    """Institutions the account may enumerate, or ``None`` for unrestricted."""
    if current.is_platform_admin:
        return None
    return current.institutions
