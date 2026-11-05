"""Phase 7 tests: authentication (N) and the token verification boundary.

Everything here uses synthetic accounts only. No password exists anywhere in
DataDiet: the local directory of accounts plus a signed bearer token is the
whole model (ADR-0014).

Covered:

* the public ``/auth/config`` report never claims a provider it does not have;
* missing / malformed / forged / expired / wrong-issuer / wrong-audience
  tokens are all refused as 401;
* the algorithm is taken from the server, never from the token header;
* verified claims *name* an account but never grant roles or institution scope;
* production fails closed when authentication is not configured;
* denied state changes are audited, denied reads are not (ADR-0013).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import DEV_AUTH_JWT_SECRET, get_settings
from app.db import models

BASE = "/api/v1"


# --------------------------------------------------------------------------- #
# A tiny forger, so every claim can be controlled precisely
# --------------------------------------------------------------------------- #


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def forge(
    payload: dict[str, object],
    *,
    secret: str | None = None,
    header: dict[str, object] | None = None,
) -> str:
    """Build a token by hand with full control over header, claims, and key."""
    settings = get_settings()
    head = header or {"alg": "HS256", "typ": "JWT"}
    signing_input = f"{_b64(json.dumps(head).encode())}.{_b64(json.dumps(payload).encode())}"
    key = (secret if secret is not None else settings.auth_jwt_secret).encode()
    signature = hmac.new(key, signing_input.encode("ascii"), hashlib.sha256).digest()
    return f"{signing_input}.{_b64(signature)}"


def claims_for(subject: str, **extra: object) -> dict[str, object]:
    settings = get_settings()
    payload: dict[str, object] = {
        "sub": subject,
        "iss": settings.auth_jwt_issuer,
        "aud": settings.auth_jwt_audience,
        "exp": int(time.time()) + 600,
        "iat": int(time.time()),
    }
    payload.update(extra)
    return payload


def get_json(client: TestClient, path: str, token: str):
    return client.get(path, headers={"Authorization": f"Bearer {token}"})


# --------------------------------------------------------------------------- #
# Public configuration report
# --------------------------------------------------------------------------- #


def test_auth_config_is_public_and_honest_in_development(client: TestClient) -> None:
    response = client.get(f"{BASE}/auth/config")
    assert response.status_code == 200
    body = response.json()
    assert body["authentication"] == "development"
    assert body["dev_login_enabled"] is True
    # It reports *how* verification works, never the key itself.
    assert "secret" not in json.dumps(body).lower()
    assert get_settings().auth_jwt_secret not in json.dumps(body)


def test_auth_config_says_unconfigured_in_production_without_a_secret(
    client: TestClient, production_environment: None
) -> None:
    body = client.get(f"{BASE}/auth/config").json()
    assert body["authentication"] == "unconfigured"
    assert body["dev_login_enabled"] is False


# --------------------------------------------------------------------------- #
# Refusing bad credentials
# --------------------------------------------------------------------------- #


def test_missing_token_is_401(anonymous_client: TestClient) -> None:
    response = anonymous_client.get(f"{BASE}/auth/me")
    assert response.status_code == 401
    assert response.json()["detail"].startswith("not_authenticated:")
    assert response.headers["WWW-Authenticate"].startswith("Bearer")


@pytest.mark.parametrize(
    ("token", "expected"),
    [
        ("", "not_authenticated"),
        ("not-a-jwt", "malformed_token"),
        ("a.b", "malformed_token"),
        ("a.b.c.d", "malformed_token"),
        ("!!!.!!!.!!!", "malformed_token"),
    ],
)
def test_malformed_tokens_are_401(anonymous_client: TestClient, token: str, expected: str) -> None:
    # An empty value never reaches token parsing at all: the scheme check fails.
    response = anonymous_client.get(
        f"{BASE}/auth/me", headers={"Authorization": f"Bearer {token}".rstrip()}
    )
    assert response.status_code == 401
    assert response.json()["detail"].startswith(f"{expected}:")


def test_wrong_signature_is_401(anonymous_client: TestClient) -> None:
    token = forge(claims_for("1"), secret="a-completely-different-signing-key-value")
    assert get_json(anonymous_client, f"{BASE}/auth/me", token).status_code == 401


def test_expired_token_is_401(anonymous_client: TestClient) -> None:
    payload = claims_for("1")
    payload["exp"] = int(time.time()) - 1
    payload["iat"] = int(time.time()) - 61
    token = forge(payload)
    response = get_json(anonymous_client, f"{BASE}/auth/me", token)
    assert response.status_code == 401
    assert response.json()["detail"].startswith("token_expired:")


def test_a_token_that_is_not_yet_valid_is_401(anonymous_client: TestClient) -> None:
    payload = claims_for("1")
    payload["nbf"] = int(time.time()) + 600
    response = get_json(anonymous_client, f"{BASE}/auth/me", forge(payload))
    assert response.status_code == 401
    assert response.json()["detail"].startswith("token_not_yet_valid:")


def test_wrong_issuer_is_401(anonymous_client: TestClient) -> None:
    payload = claims_for("1")
    payload["iss"] = "https://some-other-issuer.example"
    response = get_json(anonymous_client, f"{BASE}/auth/me", forge(payload))
    assert response.status_code == 401
    assert response.json()["detail"].startswith("invalid_issuer:")


def test_wrong_audience_is_401(anonymous_client: TestClient) -> None:
    payload = claims_for("1")
    payload["aud"] = "someone-elses-api"
    response = get_json(anonymous_client, f"{BASE}/auth/me", forge(payload))
    assert response.status_code == 401
    assert response.json()["detail"].startswith("invalid_audience:")


def test_audience_accepts_a_list_containing_the_configured_value(
    anonymous_client: TestClient,
) -> None:
    settings = get_settings()
    payload = claims_for("1", aud=[settings.auth_jwt_audience, "another-api"])
    token = forge(payload)
    # Account 1 exists in this database, so a 200 proves the audience check
    # accepted the list and the configured value matched one entry.
    response = get_json(anonymous_client, f"{BASE}/auth/me", token)
    assert response.status_code == 200

    # ...but a list that omits our audience is still refused.
    payload["aud"] = ["another-api", "and-another"]
    assert get_json(anonymous_client, f"{BASE}/auth/me", forge(payload)).status_code == 401


def test_missing_required_claims_are_401(anonymous_client: TestClient) -> None:
    settings = get_settings()
    token = forge({"iss": settings.auth_jwt_issuer, "aud": settings.auth_jwt_audience})
    response = get_json(anonymous_client, f"{BASE}/auth/me", token)
    assert response.status_code == 401
    assert response.json()["detail"].startswith("missing_claims:")
    assert "exp" in response.json()["detail"]


@pytest.mark.parametrize("alg", ["none", "RS256", "HS512"])
def test_the_algorithm_comes_from_the_server_not_the_token(
    anonymous_client: TestClient, alg: str
) -> None:
    """An ``alg`` header is never consulted: only HS256 signed here is accepted."""
    token = forge(claims_for("1"), header={"alg": alg, "typ": "JWT"})
    response = get_json(anonymous_client, f"{BASE}/auth/me", token)
    assert response.status_code == 401
    assert response.json()["detail"].startswith("unsupported_algorithm:")


def test_an_unusable_subject_is_401(anonymous_client: TestClient) -> None:
    token = forge(claims_for("opaque-subject-from-an-idp"))
    response = get_json(anonymous_client, f"{BASE}/auth/me", token)
    assert response.status_code == 401
    assert response.json()["detail"].startswith("invalid_subject:")


def test_an_unknown_account_is_401(anonymous_client: TestClient) -> None:
    token = forge(claims_for("999999"))
    response = get_json(anonymous_client, f"{BASE}/auth/me", token)
    assert response.status_code == 401
    assert response.json()["detail"].startswith("unknown_account:")


def test_a_deactivated_account_is_401(
    client: TestClient, anonymous_client: TestClient, db: Session
) -> None:
    signed_in = client.post(
        f"{BASE}/auth/dev-login", json={"email": "later.disabled@datadiet.test"}
    ).json()
    token = signed_in["access_token"]
    assert get_json(anonymous_client, f"{BASE}/auth/me", token).status_code == 200

    user = db.execute(
        select(models.AppUser).where(models.AppUser.email == "later.disabled@datadiet.test")
    ).scalar_one()
    user.is_active = False
    db.commit()

    response = get_json(anonymous_client, f"{BASE}/auth/me", token)
    assert response.status_code == 401
    assert response.json()["detail"].startswith("unknown_account:")


# --------------------------------------------------------------------------- #
# Identity resolution: claims name, the directory authorizes
# --------------------------------------------------------------------------- #


def test_dev_login_returns_the_verified_profile_and_permissions(
    client: TestClient, db: Session
) -> None:
    institution = models.Institution(code="AUTH1", name="Auth One")
    db.add(institution)
    db.commit()
    db.refresh(institution)

    body = client.post(
        f"{BASE}/auth/dev-login",
        json={
            "email": "member@datadiet.test",
            "institution_id": institution.id,
            "role": "reviewer",
            "platform_admin": False,
        },
    ).json()
    profile = body["user"]
    assert profile["institutions"] == [institution.id]
    assert profile["role"] == "reviewer"
    assert "review:decide" in profile["permissions"]
    assert "users:manage" not in profile["permissions"]
    assert "assets:write" not in profile["permissions"]

    me = get_json(client, f"{BASE}/auth/me", body["access_token"]).json()
    assert me["email"] == "member@datadiet.test"
    assert me["is_platform_admin"] is False


def test_token_claims_never_grant_scope_or_role(
    client: TestClient, db: Session, anonymous_client: TestClient
) -> None:
    """A token asserting ``role=admin`` still gets the directory's permissions."""
    institution = models.Institution(code="AUTH2", name="Auth Two")
    db.add(institution)
    db.commit()
    db.refresh(institution)

    signed_in = client.post(
        f"{BASE}/auth/dev-login",
        json={
            "email": "lowpriv@datadiet.test",
            "institution_id": institution.id,
            "role": "viewer",
            "platform_admin": False,
        },
    ).json()
    real = signed_in["user"]
    assert real["role"] == "viewer"

    token = forge(
        claims_for(
            str(real["id"]),
            email=real["email"],
            role="admin",
            institution_id=999,
            is_platform_admin=True,
            permissions=["users:manage", "assets:write"],
        )
    )
    me = get_json(anonymous_client, f"{BASE}/auth/me", token).json()
    assert me["role"] == "viewer"
    assert me["institutions"] == [institution.id]
    assert me["is_platform_admin"] is False
    assert "users:manage" not in me["permissions"]
    assert "assets:write" not in me["permissions"]

    # And the asserted administration is not accepted for a management route.
    assert get_json(anonymous_client, f"{BASE}/users", token).status_code == 403


def test_an_opaque_subject_falls_back_to_the_email_claim(
    client: TestClient, anonymous_client: TestClient
) -> None:
    """How a real OIDC provider (whose ``sub`` is opaque) would bind an account."""
    client.post(f"{BASE}/auth/dev-login", json={"email": "oidc.user@datadiet.test"})
    token = forge(claims_for("ad|provider|opaque-id", email="oidc.user@datadiet.test"))
    me = get_json(anonymous_client, f"{BASE}/auth/me", token)
    assert me.status_code == 200
    assert me.json()["email"] == "oidc.user@datadiet.test"


def test_sign_out_is_discarding_the_token(client: TestClient, anonymous_client: TestClient) -> None:
    """Bearer tokens are stateless: there is no server-side session to end."""
    token = client.post(f"{BASE}/auth/dev-login", json={"email": "signout@datadiet.test"}).json()[
        "access_token"
    ]
    assert get_json(anonymous_client, f"{BASE}/auth/me", token).status_code == 200
    # The client drops the header; the same token still verifies (by design),
    # so the *client* must stop sending it.
    assert get_json(anonymous_client, f"{BASE}/auth/me", token).status_code == 200
    assert anonymous_client.get(f"{BASE}/auth/me").status_code == 401


# --------------------------------------------------------------------------- #
# Authorization failures and their audit trail
# --------------------------------------------------------------------------- #


def test_denied_write_is_audited_and_denied_read_is_not(
    client: TestClient, db: Session, scoped_client
) -> None:
    institution = models.Institution(code="AUTH3", name="Auth Three")
    db.add(institution)
    db.commit()
    db.refresh(institution)

    viewer = scoped_client(institution.id, role="viewer")

    # A refused state change is recorded against the caller...
    denied_write = viewer.post(
        f"{BASE}/assets",
        json={
            "data_source_id": 1,
            "external_id": "nope",
            "title": "Nope",
            "record_type": "document",
        },
    )
    assert denied_write.status_code == 403

    # ...a refused read is not, extending ADR-0013's "reads are not audited".
    denied_read = viewer.get(f"{BASE}/users")
    assert denied_read.status_code == 403

    events = db.execute(
        select(models.AuditEvent).where(models.AuditEvent.event_type == "authorization.denied")
    ).scalars().all()
    db.expire_all()
    assert len(events) == 1
    assert events[0].actor == f"viewer.{institution.id}@datadiet.test"
    assert events[0].payload["method"] == "POST"
    assert events[0].payload["required"] == "permission:assets:write"


def test_scope_filters_are_validated_against_the_identity(
    client: TestClient, db: Session, scoped_client
) -> None:
    mine = models.Institution(code="AUTH4", name="Auth Four")
    other = models.Institution(code="AUTH5", name="Auth Five")
    db.add_all([mine, other])
    db.commit()
    db.refresh(mine)
    db.refresh(other)

    viewer = scoped_client(mine.id, role="viewer")

    # Naming one's own institution is fine.
    assert viewer.get(f"{BASE}/assets?institution_id={mine.id}").status_code == 200
    # Naming another tenant's institution is a 404, never a 403: membership of
    # another tenant is not disclosed.
    assert viewer.get(f"{BASE}/assets?institution_id={other.id}").status_code == 404


def test_out_of_scope_write_is_audited_without_disclosure(
    client: TestClient, db: Session, scoped_client
) -> None:
    mine = models.Institution(code="AUTH8", name="Auth Eight")
    other = models.Institution(code="AUTH9", name="Auth Nine")
    db.add_all([mine, other])
    db.commit()
    db.refresh(mine)
    db.refresh(other)

    admin = scoped_client(mine.id, role="admin")
    response = admin.post(
        f"{BASE}/retention/policies",
        json={"institution_id": other.id, "name": "Cross-tenant policy"},
    )

    # Same 404 as an authorized tenant's missing resource: the response does
    # not confirm that the other institution exists.
    assert response.status_code == 404
    assert response.json()["detail"] == "out_of_scope"

    db.expire_all()
    events = db.execute(
        select(models.AuditEvent).where(
            models.AuditEvent.event_type == "authorization.denied"
        )
    ).scalars().all()
    assert len(events) == 1
    assert events[0].actor == f"admin.{mine.id}@datadiet.test"
    assert events[0].payload["method"] == "POST"
    assert events[0].payload["required"] == "institution_scope"
    assert "institution_id" not in events[0].payload

    # A read probe is not written to the audit log.
    assert admin.get(f"{BASE}/assets?institution_id={other.id}").status_code == 404
    db.expire_all()
    assert (
        len(
            db.execute(
                select(models.AuditEvent).where(
                    models.AuditEvent.event_type == "authorization.denied"
                )
            ).scalars().all()
        )
        == 1
    )


def test_a_member_of_several_institutions_must_name_one(
    client: TestClient, db: Session, scoped_client
) -> None:
    a = models.Institution(code="AUTH6", name="Auth Six")
    b = models.Institution(code="AUTH7", name="Auth Seven")
    db.add_all([a, b])
    db.commit()
    db.refresh(a)
    db.refresh(b)

    multi = scoped_client(a.id, role="viewer", email="multi@datadiet.test")
    # Add a second active membership directly (the dev provider grants one per
    # sign-in, so this mirrors a second grant made by an administrator).
    user = db.execute(
        select(models.AppUser).where(models.AppUser.email == "multi@datadiet.test")
    ).scalar_one()
    db.add(
        models.UserMembership(
            app_user_id=user.id, institution_id=b.id, role="viewer", is_active=True
        )
    )
    db.commit()

    unscoped = multi.get(f"{BASE}/assets")
    assert unscoped.status_code == 422
    assert unscoped.json()["detail"].startswith("institution_id is required:")

    assert multi.get(f"{BASE}/assets?institution_id={a.id}").status_code == 200
    assert multi.get(f"{BASE}/assets?institution_id={b.id}").status_code == 200


def test_dev_login_cannot_revoke_administration(client: TestClient, db: Session) -> None:
    """Development sign-in grants, never revokes — so it cannot be an escalation."""
    first = client.post(
        f"{BASE}/auth/dev-login",
        json={"email": "admin.grant@datadiet.test", "platform_admin": True},
    ).json()
    assert first["user"]["is_platform_admin"] is True

    second = client.post(
        f"{BASE}/auth/dev-login",
        json={"email": "admin.grant@datadiet.test", "platform_admin": False},
    ).json()
    assert second["user"]["is_platform_admin"] is True

    user = db.execute(
        select(models.AppUser).where(models.AppUser.email == "admin.grant@datadiet.test")
    ).scalar_one()
    assert user.is_platform_admin is True


def test_dev_login_is_audited(client: TestClient, db: Session) -> None:
    client.post(f"{BASE}/auth/dev-login", json={"email": "audited.login@datadiet.test"})
    events = db.execute(
        select(models.AuditEvent).where(
            models.AuditEvent.event_type == "auth.dev_login",
            models.AuditEvent.actor == "audited.login@datadiet.test",
        )
    ).scalars().all()
    assert len(events) == 1
    # The audit carries no credential material of any kind.
    assert "token" not in json.dumps(events[0].payload).lower()


def test_dev_login_rejects_a_deactivated_account(client: TestClient, db: Session) -> None:
    client.post(f"{BASE}/auth/dev-login", json={"email": "off@datadiet.test"})
    user = db.execute(
        select(models.AppUser).where(models.AppUser.email == "off@datadiet.test")
    ).scalar_one()
    user.is_active = False
    db.commit()

    response = client.post(f"{BASE}/auth/dev-login", json={"email": "off@datadiet.test"})
    assert response.status_code == 403


def test_dev_login_validates_the_requested_institution(
    client: TestClient, db: Session
) -> None:
    response = client.post(
        f"{BASE}/auth/dev-login", json={"email": "ghost@datadiet.test", "institution_id": 424242}
    )
    assert response.status_code == 422


def test_dev_login_rejects_an_implausible_email(client: TestClient) -> None:
    response = client.post(f"{BASE}/auth/dev-login", json={"email": "not-an-email"})
    assert response.status_code == 422


# --------------------------------------------------------------------------- #
# Production fail-closed
# --------------------------------------------------------------------------- #


def test_the_development_secret_is_never_a_production_secret() -> None:
    """A belt-and-braces assertion on the placeholder's own value."""
    assert len(DEV_AUTH_JWT_SECRET) >= 32
    assert "do-not-use-in-production" in DEV_AUTH_JWT_SECRET
    # Outside production the placeholder is what makes local development work;
    # in production it is stripped, so it can never appear in a verified token.
    assert get_settings().auth_jwt_secret
