"""Phase 6.0 Part B2/B3/B4: Clerk identity mapping through the real HTTP stack.

These tests drive the application the way a Clerk-issued session token would
reach it: signed RS256, verified against a scripted JWKS, and resolved against
the local directory. The properties they exist to protect are the ones the brief
calls non-negotiable:

* the Clerk ``sub`` is the identity key — email is a display convenience, so an
  address change cannot fork an account and two people sharing an address cannot
  be merged;
* an unknown identity gets nothing, not administration: no automatic
  provisioning by default, and provisioning (when explicitly enabled) creates an
  account with no permissions and no membership;
* claims — including Clerk metadata — never carry authorization;
* the development sign-in provider does not exist in a protected environment,
  and a protected environment without usable configuration fails closed while
  health stays observable.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from clerk_fixtures import (
    FIXED_AUDIENCE,
    FIXED_ISSUER,
    ScriptedJwks,
    SigningKey,
    jwks_document,
    make_signing_key,
    mint_token,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core import auth as auth_module
from app.core.config import get_settings
from app.core.jwks import JwksClient, JwksUnavailableError
from app.core.security import issue_token
from app.db import models, session
from app.main import create_app

API = "/api/v1"
JWKS_URL = f"{FIXED_ISSUER}/.well-known/jwks.json"


# --------------------------------------------------------------------------- #
# Harness
# --------------------------------------------------------------------------- #


@dataclass
class ClerkHarness:
    """The pieces a Clerk test needs: a database, a client, and the key material."""

    factory: sessionmaker[Session]
    client: TestClient
    key: SigningKey
    app: FastAPI

    def token(self, subject: str, **overrides: object) -> str:
        return mint_token(self.key, subject=subject, **overrides)  # type: ignore[arg-type]

    def authenticate(self, subject: str, **overrides: object) -> TestClient:
        """Return a client sending a valid session token for ``subject``."""
        self.client.headers["Authorization"] = f"Bearer {self.token(subject, **overrides)}"
        return self.client

    def count(self, model: type) -> int:
        with self.factory() as db:
            return int(db.scalar(select(func.count()).select_from(model)) or 0)


def configure(
    monkeypatch: pytest.MonkeyPatch,
    *,
    environment: str = "test",
    clerk: bool = True,
    auto_provision: bool = False,
    audience: str | None = FIXED_AUDIENCE,
    dev_secret: str | None = None,
) -> None:
    """Set the process environment the way a deployment would, then reload settings."""
    monkeypatch.setenv("ENVIRONMENT", environment)
    if clerk:
        monkeypatch.setenv("CLERK_ISSUER", FIXED_ISSUER)
    else:
        monkeypatch.delenv("CLERK_ISSUER", raising=False)
    monkeypatch.delenv("CLERK_JWKS_URL", raising=False)
    if audience:
        monkeypatch.setenv("CLERK_AUDIENCE", audience)
    else:
        monkeypatch.delenv("CLERK_AUDIENCE", raising=False)
    monkeypatch.setenv("CLERK_AUTO_PROVISION", "true" if auto_provision else "false")
    if dev_secret is None:
        monkeypatch.delenv("AUTH_JWT_SECRET", raising=False)
    else:
        monkeypatch.setenv("AUTH_JWT_SECRET", dev_secret)
    monkeypatch.delenv("AUTH_DEV_PROVIDER_ENABLED", raising=False)
    get_settings.cache_clear()


@pytest.fixture()
def clerk(monkeypatch: pytest.MonkeyPatch) -> Iterator[ClerkHarness]:
    """A test-environment app with Clerk configured and a scripted JWKS."""
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    models.Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(session, "_engine", engine)
    monkeypatch.setattr(session, "_session_factory", factory)

    configure(monkeypatch)
    key = make_signing_key("kid-http-1")
    jwks = JwksClient(JWKS_URL, fetch=ScriptedJwks(jwks_document(key)))
    # The request path builds its client through get_jwks_client(); substituting
    # here keeps the fixtures offline without changing what the code checks.
    monkeypatch.setattr(auth_module, "get_jwks_client", lambda url: jwks)

    app = create_app()
    with TestClient(app) as test_client:
        yield ClerkHarness(factory=factory, client=test_client, key=key, app=app)

    get_settings.cache_clear()
    engine.dispose()


def add_user(
    factory: sessionmaker[Session],
    email: str,
    *,
    is_platform_admin: bool = False,
    is_active: bool = True,
) -> int:
    with factory() as db:
        user = models.AppUser(
            email=email,
            display_name=email.split("@")[0],
            is_platform_admin=is_platform_admin,
            is_active=is_active,
        )
        db.add(user)
        db.commit()
        return int(user.id)


def add_institution(factory: sessionmaker[Session], code: str) -> int:
    with factory() as db:
        institution = models.Institution(code=code, name=code.title(), is_active=True)
        db.add(institution)
        db.commit()
        return int(institution.id)


def add_membership(
    factory: sessionmaker[Session], user_id: int, institution_id: int, role: str
) -> None:
    with factory() as db:
        db.add(
            models.UserMembership(
                app_user_id=user_id,
                institution_id=institution_id,
                role=role,
                is_active=True,
                created_by="test",
            )
        )
        db.commit()


def bind(
    factory: sessionmaker[Session], subject: str, user_id: int, *, last_email: str | None = None
) -> None:
    with factory() as db:
        db.add(
            models.ExternalIdentity(
                provider="clerk",
                external_subject=subject,
                app_user_id=user_id,
                last_email=last_email,
                bound_by="test",
            )
        )
        db.commit()


def bindings_for(factory: sessionmaker[Session], subject: str) -> list[int]:
    with factory() as db:
        rows = db.scalars(
            select(models.ExternalIdentity).where(
                models.ExternalIdentity.provider == "clerk",
                models.ExternalIdentity.external_subject == subject,
            )
        ).all()
        return [row.app_user_id for row in rows]


# --------------------------------------------------------------------------- #
# The sub is the identity key
# --------------------------------------------------------------------------- #


def test_a_bound_subject_signs_in_as_the_linked_account(clerk: ClerkHarness) -> None:
    user_id = add_user(clerk.factory, "reviewer@datadiet.test")
    institution_id = add_institution(clerk.factory, "GENERAL")
    add_membership(clerk.factory, user_id, institution_id, "reviewer")
    bind(clerk.factory, "user_bound_001", user_id, last_email="reviewer@datadiet.test")

    response = clerk.authenticate("user_bound_001").get(f"{API}/auth/me")

    assert response.status_code == 200, response.text
    profile = response.json()
    assert profile["id"] == user_id
    assert profile["email"] == "reviewer@datadiet.test"
    assert profile["is_platform_admin"] is False
    assert profile["role"] == "reviewer"
    assert profile["institutions"] == [institution_id]
    assert "retention:assess" in profile["permissions"]
    assert "users:manage" not in profile["permissions"]


def test_changing_the_email_claim_does_not_create_a_second_account(
    clerk: ClerkHarness,
) -> None:
    """The provider may report any address; only ``sub`` selects the account."""
    user_id = add_user(clerk.factory, "moving@datadiet.test")
    bind(clerk.factory, "user_moving_001", user_id, last_email="moving@datadiet.test")
    client = clerk.authenticate(
        "user_moving_001", claims={"email": "brand.new.address@datadiet.test"}
    )

    profile = client.get(f"{API}/auth/me").json()

    assert profile["id"] == user_id
    assert profile["email"] == "moving@datadiet.test"  # the directory's value, not the claim
    assert clerk.count(models.AppUser) == 1
    assert bindings_for(clerk.factory, "user_moving_001") == [user_id]


def test_two_subjects_sharing_an_email_stay_separate_accounts(clerk: ClerkHarness) -> None:
    """No merging on a shared address: that would silently inherit someone's rights."""
    first = add_user(clerk.factory, "shared@datadiet.test")
    second = add_user(clerk.factory, "shared-2@datadiet.test")
    institution_id = add_institution(clerk.factory, "NORTH")
    add_membership(clerk.factory, second, institution_id, "admin")
    bind(clerk.factory, "user_shared_a", first)
    bind(clerk.factory, "user_shared_b", second)

    same_email = {"claims": {"email": "shared@datadiet.test"}}
    a = clerk.authenticate("user_shared_a", **same_email).get(f"{API}/auth/me")
    b = clerk.authenticate("user_shared_b", **same_email).get(f"{API}/auth/me")

    assert a.json()["id"] == first
    assert b.json()["id"] == second
    assert a.json()["permissions"] == []
    assert "review:decide" in b.json()["permissions"]


def test_one_subject_has_exactly_one_binding(clerk: ClerkHarness) -> None:
    """The unique (provider, subject) constraint is what makes 'email changes are
    safe' true — a second binding for the same identity cannot appear."""
    user_id = add_user(clerk.factory, "unique@datadiet.test")
    bind(clerk.factory, "user_unique_001", user_id)

    with clerk.factory() as db, pytest.raises(IntegrityError):
        db.add(
            models.ExternalIdentity(
                provider="clerk",
                external_subject="user_unique_001",
                app_user_id=user_id,
            )
        )
        db.commit()


def test_deactivated_account_is_refused(clerk: ClerkHarness) -> None:
    user_id = add_user(clerk.factory, "off@datadiet.test", is_active=False)
    bind(clerk.factory, "user_off_001", user_id)

    response = clerk.authenticate("user_off_001").get(f"{API}/auth/me")

    assert response.status_code == 401
    assert "unknown_account" in response.json()["detail"]


# --------------------------------------------------------------------------- #
# Unknown identities gain nothing
# --------------------------------------------------------------------------- #


def test_an_unbound_subject_is_refused_and_creates_nothing(clerk: ClerkHarness) -> None:
    add_user(clerk.factory, "existing@datadiet.test")
    users_before = clerk.count(models.AppUser)

    response = clerk.authenticate("user_never_seen_001").get(f"{API}/auth/me")

    assert response.status_code == 401
    assert "unknown_account" in response.json()["detail"]
    assert clerk.count(models.AppUser) == users_before
    assert clerk.count(models.ExternalIdentity) == 0


@pytest.fixture()
def provisioning(monkeypatch: pytest.MonkeyPatch) -> Iterator[ClerkHarness]:
    """The same harness with the explicit opt-in for permissionless provisioning."""
    configure(monkeypatch, auto_provision=True)
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    models.Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(session, "_engine", engine)
    monkeypatch.setattr(session, "_session_factory", factory)
    key = make_signing_key("kid-http-1")
    monkeypatch.setattr(
        auth_module,
        "get_jwks_client",
        lambda url: JwksClient(JWKS_URL, fetch=ScriptedJwks(jwks_document(key))),
    )
    app = create_app()
    with TestClient(app) as test_client:
        yield ClerkHarness(factory=factory, client=test_client, key=key, app=app)
    get_settings.cache_clear()
    engine.dispose()


def test_provisioning_creates_an_account_with_no_authority(provisioning: ClerkHarness) -> None:
    client = provisioning.authenticate(
        "user_newcomer_001",
        claims={"email": "newcomer@example.test", "pubm": {"is_platform_admin": True}},
    )

    profile = client.get(f"{API}/auth/me")
    assert profile.status_code == 200, profile.text
    body = profile.json()
    assert body["is_platform_admin"] is False
    assert body["role"] is None
    assert body["institutions"] == []
    assert body["permissions"] == []

    # A permissionless account can authenticate but sees no tenant data.
    assets = client.get(f"{API}/assets")
    assert assets.status_code == 403

    assert provisioning.count(models.ExternalIdentity) == 1


def test_provisioning_is_stable_across_requests(provisioning: ClerkHarness) -> None:
    """The second request finds the account the first one created — no duplicate."""
    client = provisioning.authenticate("user_stable_001")
    first = client.get(f"{API}/auth/me").json()["id"]
    second = client.get(f"{API}/auth/me").json()["id"]

    assert first == second
    assert provisioning.count(models.AppUser) == 1


def test_provisioning_refuses_to_merge_onto_an_existing_email(
    provisioning: ClerkHarness,
) -> None:
    """An address collision is not a licence to inherit whoever holds the row."""
    existing_id = add_user(provisioning.factory, "collision@example.test")
    institution_id = add_institution(provisioning.factory, "SOUTH")
    add_membership(provisioning.factory, existing_id, institution_id, "admin")

    response = provisioning.authenticate(
        "user_collision_001", claims={"email": "collision@example.test"}
    ).get(f"{API}/auth/me")

    assert response.status_code == 401
    assert "unknown_account" in response.json()["detail"]
    assert provisioning.count(models.ExternalIdentity) == 0
    assert provisioning.count(models.AppUser) == 1


def test_provisioned_placeholder_email_cannot_receive_mail(provisioning: ClerkHarness) -> None:
    """A subject with no email claim gets an ``.invalid`` address, never a guess."""
    profile = provisioning.authenticate("user_nobody_009").get(f"{API}/auth/me").json()

    assert profile["email"].endswith("@identity.invalid")
    assert profile["display_name"] == "user_nobody_009"


# --------------------------------------------------------------------------- #
# Claims never authorize
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "claims",
    [
        {"pubm": {"datadiet_role": "admin", "is_platform_admin": True}},
        {"role": "admin", "institution_id": 1, "permissions": ["users:manage"]},
        {"datadiet": {"is_platform_admin": True, "scopes": ["*"]}},
        {"email": "platform.admin@datadiet.test"},
    ],
)
def test_no_claim_shape_grants_anything(clerk: ClerkHarness, claims: dict) -> None:
    user_id = add_user(clerk.factory, "plain@datadiet.test")
    bind(clerk.factory, "user_plain_001", user_id)

    body = clerk.authenticate("user_plain_001", claims=claims).get(f"{API}/auth/me").json()

    assert body["is_platform_admin"] is False
    assert body["permissions"] == []
    assert body["role"] is None


def test_administration_stays_a_directory_decision(clerk: ClerkHarness) -> None:
    """The same token shape works differently once the *row* says admin."""
    user_id = add_user(clerk.factory, "promoted@datadiet.test", is_platform_admin=True)
    bind(clerk.factory, "user_promoted_001", user_id)

    body = clerk.authenticate(
        "user_promoted_001", claims={"pubm": {"is_platform_admin": False}}
    ).get(f"{API}/auth/me").json()

    assert body["is_platform_admin"] is True
    assert "users:manage" in body["permissions"]


def test_a_platform_admin_token_still_needs_a_binding(clerk: ClerkHarness) -> None:
    """Being an administrator in the provider is not a DataDiet account."""
    add_user(clerk.factory, "platform@datadiet.test", is_platform_admin=True)

    response = clerk.authenticate("user_platform_ghost").get(f"{API}/auth/me")

    assert response.status_code == 401
    assert clerk.count(models.ExternalIdentity) == 0


def test_institution_scope_is_enforced_for_clerk_callers(clerk: ClerkHarness) -> None:
    """Tenant isolation must not weaken because identity came from a provider."""
    user_id = add_user(clerk.factory, "tenant.a@datadiet.test")
    home = add_institution(clerk.factory, "AAA")
    other = add_institution(clerk.factory, "BBB")
    add_membership(clerk.factory, user_id, home, "viewer")
    bind(clerk.factory, "user_tenant_a", user_id)

    client = clerk.authenticate("user_tenant_a")
    assert client.get(f"{API}/assets", params={"institution_id": home}).status_code == 200
    crossing = client.get(f"{API}/assets", params={"institution_id": other})
    assert crossing.status_code == 404
    assert crossing.json()["detail"] == "institution_out_of_scope"


# --------------------------------------------------------------------------- #
# Provider paths over HTTP
# --------------------------------------------------------------------------- #


def test_a_development_token_is_rejected_once_clerk_is_configured(
    clerk: ClerkHarness,
) -> None:
    token = issue_token(
        subject="1",
        issuer=FIXED_ISSUER,
        audience=FIXED_AUDIENCE,
        secret="a-development-secret-long-enough-for-hs256",
        expires_in_seconds=300,
    )
    clerk.client.headers["Authorization"] = f"Bearer {token}"

    response = clerk.client.get(f"{API}/auth/me")

    assert response.status_code == 401
    assert "unsupported_algorithm" in response.json()["detail"]


def test_a_tampered_token_is_rejected(clerk: ClerkHarness) -> None:
    header, _, _ = clerk.token("user_bound_001").split(".")
    clerk.client.headers["Authorization"] = f"Bearer {header}.e3siIn0.AAAA"

    response = clerk.client.get(f"{API}/auth/me")
    assert response.status_code == 401


def test_an_expired_token_is_rejected_with_the_documented_code(clerk: ClerkHarness) -> None:
    expiring_id = add_user(clerk.factory, "expiring@datadiet.test")
    bind(clerk.factory, "user_expiring_001", expiring_id)

    response = clerk.authenticate("user_expiring_001", expires_in=-3600).get(f"{API}/auth/me")

    assert response.status_code == 401
    assert "token_expired" in response.json()["detail"]


def test_unreachable_key_endpoint_is_503_not_401(
    clerk: ClerkHarness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A provider blip must not look like a bad credential (which would log people out)."""

    def down(url: str) -> dict:
        raise JwksUnavailableError("The JWKS endpoint could not be reached")

    monkeypatch.setattr(
        auth_module, "get_jwks_client", lambda url: JwksClient(JWKS_URL, fetch=down)
    )
    blocked_id = add_user(clerk.factory, "blocked@datadiet.test")
    bind(clerk.factory, "user_blocked_001", blocked_id)

    response = clerk.authenticate("user_blocked_001").get(f"{API}/auth/me")

    assert response.status_code == 503
    assert "identity_provider_unavailable" in response.json()["detail"]


def test_no_credentials_still_answers_401(clerk: ClerkHarness) -> None:
    response = clerk.client.get(f"{API}/auth/me")
    assert response.status_code == 401
    assert "not_authenticated" in response.json()["detail"]


def test_config_reports_clerk_honestly(clerk: ClerkHarness) -> None:
    body = clerk.client.get(f"{API}/auth/config").json()

    assert body["authentication"] == "clerk"
    assert body["identity_provider"] == "clerk"
    assert body["dev_login_enabled"] is False
    assert body["issuer"] == FIXED_ISSUER
    assert body["audience"] == FIXED_AUDIENCE
    assert "no tokens" in body["description"] or "issued by Clerk" in body["description"]


def test_dev_login_refuses_its_own_requests_once_clerk_is_configured(
    clerk: ClerkHarness,
) -> None:
    """The second guard, for the environment where the route *is* registered.

    A test-environment deployment with a Clerk issuer still mounts
    ``/auth/dev-login`` — only protected environments omit it outright — so the
    handler has to refuse. Minting an HS256 token there would hand the caller a
    credential the verification path rejects, which is a trap rather than a sign-in.
    """
    users_before = clerk.count(models.AppUser)

    response = clerk.client.post(
        f"{API}/auth/dev-login",
        json={"email": "anyone@example.test", "platform_admin": True},
    )

    assert response.status_code == 503
    assert "sign_in_unavailable" in response.json()["detail"]
    assert clerk.count(models.AppUser) == users_before
    assert clerk.count(models.AuditEvent) == 0


# --------------------------------------------------------------------------- #
# Protected environments
# --------------------------------------------------------------------------- #


def test_staging_without_clerk_fails_closed_but_health_stays_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch, environment="staging", clerk=False)
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    models.Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(session, "_engine", engine)
    monkeypatch.setattr(session, "_session_factory", factory)

    app = create_app()
    with TestClient(app) as client:
        assert client.get(f"{API}/auth/me").status_code == 503
        assert client.get(f"{API}/assets").status_code == 503

        config = client.get(f"{API}/auth/config").json()
        assert config["authentication"] == "unconfigured"
        assert config["identity_provider"] == "none"
        assert config["dev_login_enabled"] is False

        # Liveness and readiness stay observable so a platform can tell a
        # misconfigured service from a dead one.
        assert client.get(f"{API}/health").status_code == 200
        ready = client.get(f"{API}/health/ready")
        assert ready.status_code == 200
        block = ready.json()["authentication"]
        assert block["configured"] is False
        assert block["provider"] == "none"
        assert block["issuer"] == ""
        assert "auth_not_configured" in block["detail"]
        assert secret_not_leaked(block)
    engine.dispose()


def test_staging_never_registers_the_development_sign_in_route(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Not a hidden button: the path is absent from the app and from OpenAPI."""
    configure(monkeypatch, environment="staging")
    app = create_app()

    with TestClient(app) as client:
        response = client.post(
            f"{API}/auth/dev-login",
            json={"email": "attacker@example.test", "platform_admin": True},
        )
        assert response.status_code == 404
        paths = client.get("/openapi.json").json()["paths"]
        assert f"{API}/auth/dev-login" not in paths
        assert f"{API}/auth/me" in paths  # the rest of the contract is intact
    get_settings.cache_clear()


def test_production_with_a_signing_secret_keeps_the_bearer_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ADR-0014's boundary survives Clerk adoption: verified here, issued elsewhere."""
    secret = "a-production-signing-secret-with-plenty-of-entropy"
    configure(monkeypatch, environment="production", clerk=False, dev_secret=secret)
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    models.Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(session, "_engine", engine)
    monkeypatch.setattr(session, "_session_factory", factory)
    user_id = add_user(factory, "boundary@datadiet.test")

    app = create_app()
    with TestClient(app) as client:
        token = issue_token(
            subject=str(user_id),
            issuer=get_settings().auth_jwt_issuer,
            audience=get_settings().auth_jwt_audience,
            secret=secret,
            expires_in_seconds=300,
        )
        client.headers["Authorization"] = f"Bearer {token}"
        assert client.get(f"{API}/auth/me").json()["id"] == user_id
        assert client.get(f"{API}/auth/config").json()["authentication"] == "bearer_boundary"
        assert client.post(f"{API}/auth/dev-login", json={"email": "x@y.test"}).status_code == 404
    engine.dispose()


def test_a_placeholder_secret_never_authenticates_a_protected_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Settings strips the published development secret in staging/production."""
    configure(
        monkeypatch,
        environment="production",
        clerk=False,
        dev_secret="datadiet-development-only-do-not-use-in-production",
    )
    app = create_app()
    with TestClient(app) as client:
        assert get_settings().auth_jwt_secret == ""
        assert client.get(f"{API}/auth/me").status_code == 503
        assert client.get(f"{API}/auth/config").json()["authentication"] == "unconfigured"


def test_a_protected_environment_refuses_to_start_with_development_sign_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Explicitly enabling the dev provider in staging is fatal, not ignored."""
    from pydantic import ValidationError

    monkeypatch.setenv("ENVIRONMENT", "staging")
    monkeypatch.setenv("AUTH_DEV_PROVIDER_ENABLED", "true")
    monkeypatch.setenv("CLERK_ISSUER", FIXED_ISSUER)
    get_settings.cache_clear()
    with pytest.raises(ValidationError) as caught:
        get_settings()
    assert "AUTH_DEV_PROVIDER_ENABLED" in str(caught.value)


def test_a_protected_environment_refuses_a_plaintext_clerk_issuer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from pydantic import ValidationError

    monkeypatch.setenv("ENVIRONMENT", "staging")
    monkeypatch.setenv("CLERK_ISSUER", "http://institution-12.clerk.accounts.dev")
    monkeypatch.delenv("AUTH_DEV_PROVIDER_ENABLED", raising=False)
    get_settings.cache_clear()
    with pytest.raises(ValidationError) as caught:
        get_settings()
    assert "CLERK_ISSUER" in str(caught.value)


def test_jwks_url_is_derived_from_the_issuer_when_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    settings = get_settings()
    assert settings.resolved_clerk_jwks_url == JWKS_URL
    assert settings.clerk_enabled is True


def test_clerk_is_off_without_an_issuer(monkeypatch: pytest.MonkeyPatch) -> None:
    configure(monkeypatch, clerk=False)
    assert get_settings().clerk_enabled is False
    assert get_settings().resolved_clerk_jwks_url == ""


def test_the_subject_may_be_bound_by_an_operator_after_a_refused_sign_in(
    clerk: ClerkHarness,
) -> None:
    """The supported path: knocked, refused, then linked — and only then effective."""
    refused = clerk.authenticate("user_later_001").get(f"{API}/auth/me")
    assert refused.status_code == 401

    user_id = add_user(clerk.factory, "later@datadiet.test")
    institution_id = add_institution(clerk.factory, "LATER")
    add_membership(clerk.factory, user_id, institution_id, "viewer")
    bind(clerk.factory, "user_later_001", user_id)

    granted = clerk.authenticate("user_later_001").get(f"{API}/auth/me")
    assert granted.status_code == 200
    assert granted.json()["institutions"] == [institution_id]
    assert granted.json()["permissions"] == sorted(
        ["inventory:read", "governance:read", "retention:read", "sources:read"]
    )


def test_a_binding_can_be_moved_to_another_account_without_a_new_subject(
    clerk: ClerkHarness,
) -> None:
    """Reassignment is an operator action on the row; the subject stays stable."""
    old_id = add_user(clerk.factory, "old.hand@datadiet.test")
    new_id = add_user(clerk.factory, "new.hand@datadiet.test")
    bind(clerk.factory, "user_handover_001", old_id)

    with clerk.factory() as db:
        row = db.scalars(
            select(models.ExternalIdentity).where(
                models.ExternalIdentity.external_subject == "user_handover_001"
            )
        ).one()
        row.app_user_id = new_id
        db.commit()

    assert bindings_for(clerk.factory, "user_handover_001") == [new_id]
    assert clerk.authenticate("user_handover_001").get(f"{API}/auth/me").json()["id"] == new_id


def secret_not_leaked(block: dict) -> bool:
    """The readiness block carries state, never key material or tokens."""
    rendered = json.dumps(block)
    return all(
        marker not in rendered for marker in ("BEGIN", "PRIVATE", " ey", "oidc_mrtk", "token")
    )


def test_the_schema_declares_the_identity_table() -> None:
    """Guards against the model drifting away from what migrations create."""
    assert "external_identities" in models.Base.metadata.tables
    columns = set(models.Base.metadata.tables["external_identities"].columns.keys())
    assert {"provider", "external_subject", "app_user_id", "last_email", "bound_by"} <= columns
