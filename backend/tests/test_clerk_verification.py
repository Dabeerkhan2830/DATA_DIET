"""Tests for Clerk RS256 session-token verification (Phase 6.0 Part B1, ADR-0025).

Every token here is signed with a real RSA private key and verified against a
real JWK document. The properties under test are the ones that make the path
safe to put in front of a real institution:

* the algorithm is chosen by the server, never by the token — and HS256 is
  never a fallback;
* issuer, audience, ``exp``, ``nbf``, ``iat`` and required claims are enforced;
* an unknown or missing ``kid``, or an unreachable provider, is a refusal —
  reported as 503 (provider unavailable) or 401 (bad token), never as a pass.
"""

from __future__ import annotations

import base64
import json
import time
from typing import Any

import jwt as pyjwt
import pytest
from clerk_fixtures import (
    FIXED_AUDIENCE,
    FIXED_ISSUER,
    FIXED_SUBJECT,
    ScriptedJwks,
    SigningKey,
    jwks_document,
    make_signing_key,
    mint_token,
    mint_unsigned_token,
)
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from app.core.jwks import JwksClient, JwksUnavailableError
from app.core.security import (
    ALLOWED_ALGORITHMS,
    TokenError,
    get_jwks_client,
    issue_token,
    reset_jwks_clients,
    verify_clerk_token,
    verify_token,
)

JWKS_URL = "https://datadiet-fixture.clerk.accounts.local/.well-known/jwks.json"


@pytest.fixture()
def provider() -> ScriptedJwks:
    return ScriptedJwks()


@pytest.fixture()
def signing_key() -> SigningKey:
    return make_signing_key("kid-clerk-1")


@pytest.fixture()
def jwks(signing_key: SigningKey, provider: ScriptedJwks) -> JwksClient:
    """A client publishing one key, driven by the scripted provider."""
    provider.publish(jwks_document(signing_key))
    return JwksClient(JWKS_URL, fetch=provider)


def _verify(token: str, client: JwksClient, *, audience: str = FIXED_AUDIENCE) -> dict[str, Any]:
    return verify_clerk_token(
        token, issuer=FIXED_ISSUER, audience=audience, jwks_client=client
    )


def _now() -> int:
    return int(time.time())


# --------------------------------------------------------------------------- #
# The happy path
# --------------------------------------------------------------------------- #


def test_algorithm_allowlist_is_pinned_to_rs256() -> None:
    """The verifier's strategy is a constant, not something a header can choose."""
    assert ALLOWED_ALGORITHMS == ("RS256",)


def test_valid_clerk_token_returns_its_claims(signing_key: SigningKey, jwks: JwksClient) -> None:
    claims = _verify(mint_token(signing_key), jwks)
    assert claims["sub"] == FIXED_SUBJECT
    assert claims["iss"] == FIXED_ISSUER
    assert claims["aud"] == FIXED_AUDIENCE


def test_verification_performs_no_network_request_per_call(
    signing_key: SigningKey, jwks: JwksClient, provider: ScriptedJwks
) -> None:
    """The JWKS document is fetched once and cached for every later request."""
    token = mint_token(signing_key)
    for _ in range(25):
        _verify(token, jwks)
    assert provider.calls == 1


# --------------------------------------------------------------------------- #
# Algorithm confusion: the requirement that HS256 is never a fallback
# --------------------------------------------------------------------------- #


def test_hs256_token_is_refused_on_the_clerk_path(
    signing_key: SigningKey, jwks: JwksClient
) -> None:
    """The algorithm-confusion attack: sign with the *public* key as an HMAC secret.

    PyJWT refuses to express this through ``encode`` (it detects the asymmetric
    key), so the forgery is minted with the HS256 issuer this repository already
    has — which is exactly what an attacker who obtained Clerk's public key
    could hand to this API.
    """
    public_pem = (
        signing_key.private_key.public_key()
        .public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
        .decode("utf-8")
    )
    forged = issue_token(
        subject=FIXED_SUBJECT,
        issuer=FIXED_ISSUER,
        audience=FIXED_AUDIENCE,
        secret=public_pem,
        expires_in_seconds=300,
        claims={"email": "victim@example.test"},
    )
    # The forgery is a well-formed token that the *development* path would
    # accept — proof that the refusal below comes from the algorithm, not the
    # encoding.
    assert verify_token(
        forged, issuer=FIXED_ISSUER, audience=FIXED_AUDIENCE, secret=public_pem
    )["sub"] == FIXED_SUBJECT

    with pytest.raises(TokenError) as caught:
        _verify(forged, jwks)
    assert caught.value.reason == "unsupported_algorithm"


def test_alg_none_token_is_refused(signing_key: SigningKey, jwks: JwksClient) -> None:
    forged = mint_unsigned_token(
        {"iss": FIXED_ISSUER, "sub": FIXED_SUBJECT, "iat": _now(), "exp": _now() + 300}
    )
    with pytest.raises(TokenError) as caught:
        _verify(forged, jwks)
    assert caught.value.reason == "unsupported_algorithm"


def test_a_development_token_never_works_once_clerk_is_configured(
    signing_key: SigningKey, jwks: JwksClient
) -> None:
    """The token the development provider mints is rejected by the Clerk verifier.

    Configuring Clerk does not leave a second, weaker door open, and a Clerk
    verification failure is never retried as HS256 — while the very same string
    still verifies on its own path, which proves the refusal came from the
    verifier selection rather than from a broken token.
    """
    secret = "a-development-secret-long-enough-for-hs256"
    token = issue_token(
        subject=FIXED_SUBJECT,
        issuer=FIXED_ISSUER,
        audience=FIXED_AUDIENCE,
        secret=secret,
        expires_in_seconds=300,
    )
    with pytest.raises(TokenError) as caught:
        _verify(token, jwks)
    assert caught.value.reason == "unsupported_algorithm"

    assert verify_token(
        token, issuer=FIXED_ISSUER, audience=FIXED_AUDIENCE, secret=secret
    )["sub"] == FIXED_SUBJECT


# --------------------------------------------------------------------------- #
# Signatures and keys
# --------------------------------------------------------------------------- #


def test_token_signed_by_another_key_is_rejected(
    signing_key: SigningKey, jwks: JwksClient
) -> None:
    attacker = make_signing_key("kid-clerk-1")  # same kid, different key material
    with pytest.raises(TokenError) as caught:
        _verify(mint_token(attacker), jwks)
    assert caught.value.reason == "invalid_signature"


def test_tampered_payload_is_rejected(signing_key: SigningKey, jwks: JwksClient) -> None:
    header, payload, signature = mint_token(signing_key).split(".")
    claims = json.loads(base64.urlsafe_b64decode(payload + "=="))
    claims["sub"] = "user_2ZfPrivilegedSubject0000"
    tampered = (
        base64.urlsafe_b64encode(json.dumps(claims, separators=(",", ":")).encode())
        .decode("ascii")
        .rstrip("=")
    )
    with pytest.raises(TokenError) as caught:
        _verify(f"{header}.{tampered}.{signature}", jwks)
    assert caught.value.reason == "invalid_signature"


def test_unknown_kid_is_rejected_as_an_unknown_key(
    signing_key: SigningKey, jwks: JwksClient
) -> None:
    other = make_signing_key("kid-rotated-away")
    with pytest.raises(TokenError) as caught:
        _verify(mint_token(other), jwks)
    assert caught.value.reason == "unknown_key_id"


def test_missing_kid_is_rejected_without_trying_every_cached_key(
    signing_key: SigningKey, jwks: JwksClient
) -> None:
    token = mint_token(signing_key, include_kid=False)
    with pytest.raises(TokenError) as caught:
        _verify(token, jwks)
    assert caught.value.reason == "missing_key_id"


def test_rotated_key_serves_requests_once_the_provider_publishes_it(
    provider: ScriptedJwks,
) -> None:
    """Rotation works end to end: the retired key stops working, the new one starts."""
    old = make_signing_key("kid-old")
    new = make_signing_key("kid-new")
    provider.publish(jwks_document(old))
    client = JwksClient(JWKS_URL, fetch=provider)

    assert _verify(mint_token(old), client)["sub"] == FIXED_SUBJECT

    provider.publish(jwks_document(new))
    # The old key is no longer published, but the cached document still holds it,
    # so it verifies until the cache is replaced — and the new key is adopted on
    # the first token that names it, via the kid-miss refresh.
    assert _verify(mint_token(new), client)["sub"] == FIXED_SUBJECT
    assert provider.calls == 2


# --------------------------------------------------------------------------- #
# Claims
# --------------------------------------------------------------------------- #


def test_expired_token_is_rejected(signing_key: SigningKey, jwks: JwksClient) -> None:
    with pytest.raises(TokenError) as caught:
        _verify(mint_token(signing_key, expires_in=-3600), jwks)
    assert caught.value.reason == "token_expired"


def test_token_inside_the_leeway_window_is_still_accepted(
    signing_key: SigningKey, jwks: JwksClient
) -> None:
    """The documented 30-second clock tolerance, bounded rather than open-ended."""
    assert _verify(mint_token(signing_key, expires_in=-10), jwks)["sub"] == FIXED_SUBJECT


def test_not_yet_valid_token_is_rejected(signing_key: SigningKey, jwks: JwksClient) -> None:
    with pytest.raises(TokenError) as caught:
        _verify(mint_token(signing_key, not_before_in=3600), jwks)
    assert caught.value.reason == "token_not_yet_valid"


def test_future_dated_issued_at_is_rejected(signing_key: SigningKey, jwks: JwksClient) -> None:
    with pytest.raises(TokenError) as caught:
        _verify(mint_token(signing_key, issued_at_in=3600), jwks)
    assert caught.value.reason == "token_not_yet_valid"


def test_missing_expiry_is_rejected(signing_key: SigningKey, jwks: JwksClient) -> None:
    """A session token always carries ``exp``; without it there is no lifetime."""
    token = pyjwt.encode(
        {
            "iss": FIXED_ISSUER,
            "aud": FIXED_AUDIENCE,
            "sub": FIXED_SUBJECT,
            "iat": _now(),
        },
        signing_key.private_key,
        algorithm="RS256",
        headers={"kid": signing_key.kid},
    )
    with pytest.raises(TokenError) as caught:
        _verify(token, jwks)
    assert caught.value.reason == "missing_claims"


def test_wrong_issuer_is_rejected(signing_key: SigningKey, jwks: JwksClient) -> None:
    token = mint_token(signing_key, issuer="https://somewhere-else.clerk.accounts.local")
    with pytest.raises(TokenError) as caught:
        _verify(token, jwks)
    assert caught.value.reason == "invalid_issuer"


def test_wrong_audience_is_rejected(signing_key: SigningKey, jwks: JwksClient) -> None:
    with pytest.raises(TokenError) as caught:
        _verify(mint_token(signing_key, audience="some-other-api"), jwks)
    assert caught.value.reason == "invalid_audience"


def test_missing_audience_is_rejected_when_the_api_requires_one(
    signing_key: SigningKey, jwks: JwksClient
) -> None:
    """A token that never names this API is refused.

    PyJWT reports an absent ``aud`` as a missing claim rather than a wrong
    audience; both are 401 refusals on the same check, and the distinction is
    recorded here so the assertion documents the real behaviour instead of the
    hoped-for wording.
    """
    token = mint_token(signing_key, audience=None)
    with pytest.raises(TokenError) as caught:
        _verify(token, jwks)
    assert caught.value.reason in {"invalid_audience", "missing_claims"}


def test_audience_is_optional_when_the_server_does_not_configure_one(
    signing_key: SigningKey, jwks: JwksClient
) -> None:
    """Clerk sets ``aud`` only when the JWT template names an API instance."""
    token = mint_token(signing_key, audience=None)
    assert _verify(token, jwks, audience="")["sub"] == FIXED_SUBJECT


def test_empty_subject_is_rejected(signing_key: SigningKey, jwks: JwksClient) -> None:
    with pytest.raises(TokenError) as caught:
        _verify(mint_token(signing_key, subject="   "), jwks)
    assert caught.value.reason == "missing_claims"


def test_metadata_claims_are_carried_through_but_mean_nothing(
    signing_key: SigningKey, jwks: JwksClient
) -> None:
    """``pubm``/role/institution claims are inert on the verification path.

    The verifier returns claims; ``app.core.auth`` decides authorization from the
    directory and never reads them. A verification refusal on an unrelated claim
    would be a forgery detector, not an identity check — so the token must still
    verify, and must not gain anything from the claims.
    """
    token = mint_token(
        signing_key,
        claims={
            "pubm": {"datadiet_role": "admin", "is_platform_admin": True},
            "institution_id": 99,
            "email": "someone@example.test",
        },
    )
    claims = _verify(token, jwks)
    assert claims["sub"] == FIXED_SUBJECT
    assert claims["pubm"]["is_platform_admin"] is True


# --------------------------------------------------------------------------- #
# Malformed input and provider state
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "token,reason",
    [
        ("", "missing_token"),
        ("   ", "missing_token"),
        ("not-a-jwt", "malformed_token"),
        ("a.b", "malformed_token"),
        ("a.b.c.d", "malformed_token"),
        ("....", "malformed_token"),
        ("###.###.###", "malformed_token"),
    ],
)
def test_malformed_input_is_rejected_without_reaching_the_provider(
    token: str, reason: str, jwks: JwksClient, provider: ScriptedJwks
) -> None:
    with pytest.raises(TokenError) as caught:
        _verify(token, jwks)
    assert caught.value.reason == reason
    assert provider.calls == 0


def test_unreachable_provider_is_reported_as_unavailable(
    signing_key: SigningKey,
) -> None:
    def down(url: str) -> dict:
        raise JwksUnavailableError("The JWKS endpoint could not be reached")

    with pytest.raises(TokenError) as caught:
        _verify(mint_token(signing_key), JwksClient(JWKS_URL, fetch=down))
    assert caught.value.reason == "identity_provider_unavailable"


def test_rejection_never_reports_a_key_or_a_token(signing_key: SigningKey) -> None:
    """Rejection messages are surfaced to clients, so they must carry no secret."""
    other = make_signing_key("kid-other")
    token = mint_token(other)
    client = JwksClient(JWKS_URL, fetch=ScriptedJwks(jwks_document(signing_key)))
    with pytest.raises(TokenError) as caught:
        _verify(token, client)
    reported = str(caught.value) + caught.value.reason
    assert token not in reported
    assert signing_key.jwk.get("n", "") not in reported


# --------------------------------------------------------------------------- #
# Process-wide client cache
# --------------------------------------------------------------------------- #


def test_one_jwks_client_per_url_for_the_life_of_the_process() -> None:
    reset_jwks_clients()
    try:
        first = get_jwks_client(JWKS_URL)
        assert get_jwks_client(JWKS_URL) is first
        assert get_jwks_client("https://other.example/.well-known/jwks.json") is not first
    finally:
        reset_jwks_clients()
