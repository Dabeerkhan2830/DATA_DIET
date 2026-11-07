"""Bearer-token verification for DataDiet (Phase 7, extended in Phase 6.0).

Two verification paths exist, and which one a deployment uses is decided by
*server-side configuration*, never by the incoming token:

``verify_token``
    Strict HS256, standard library only. Used by the development/test provider
    and by the existing test suite. It is never reachable in staging or
    production (ADR-0025).

``verify_clerk_token``
    RS256 against the identity provider's published JWKS (``app.core.jwks``),
    the path a real Clerk deployment uses. It replaces the HS256 path; it does
    not consult it, and it never falls back to it.

Both share :class:`TokenError`, so the HTTP layer keeps producing the same
stable machine-readable prefixes (`malformed_token`, `invalid_signature`,
`token_expired`, ...). Nothing here logs, persists, or returns a key or a
secret, and no claim is trusted for authorization — see ``app.core.auth``,
which resolves identity against the local directory instead.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from functools import lru_cache
from typing import Any

import jwt
from jwt import PyJWTError

from app.core.jwks import ALLOWED_ALGORITHMS, JwksClient, JwksError, JwksUnavailableError

# Algorithms this module is willing to accept. The value is fixed rather than
# read from the token header, so an attacker-supplied ``alg`` can never select
# the verification strategy.
ALGORITHM = "HS256"

#: Claims that must be present and well typed for a token to be usable.
_REQUIRED_CLAIMS = ("iss", "aud", "exp", "sub")

#: Clock skew tolerated when comparing ``exp``/``nbf``/``iat``, in seconds. A
#: small leeway absorbs ordinary clock drift between deployment and provider;
#: it does not extend a token's useful lifetime by more than this.
DEFAULT_LEEWAY_SECONDS = 30.0


class TokenError(Exception):
    """A bearer token was rejected.

    ``reason`` is a short machine-readable code; ``message`` is safe to surface
    to a client. Neither ever contains the token or the signing secret.
    """

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(segment: str, *, what: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    try:
        return base64.urlsafe_b64decode(segment + padding)
    except Exception as cause:  # noqa: BLE001 - normalised into a TokenError
        raise TokenError("malformed_token", f"{what} is not valid base64url") from cause


def _dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True)


def issue_token(
    *,
    subject: str,
    issuer: str,
    audience: str,
    secret: str,
    expires_in_seconds: int,
    claims: dict[str, Any] | None = None,
    now: float | None = None,
) -> str:
    """Mint a signed HS256 bearer token.

    Only the development/test identity provider and the test suite call this.
    It is never reachable from a request handler in ``ENVIRONMENT=production``.
    """
    if not secret:
        raise TokenError("auth_not_configured", "No signing secret is configured")
    issued_at = int(now if now is not None else time.time())
    payload: dict[str, Any] = {
        "iss": issuer,
        "aud": audience,
        "sub": subject,
        "iat": issued_at,
        "exp": issued_at + int(expires_in_seconds),
    }
    if claims:
        payload.update(claims)

    header = _dumps({"alg": ALGORITHM, "typ": "JWT"})
    header_b64 = _b64url_encode(header.encode("utf-8"))
    payload_b64 = _b64url_encode(_dumps(payload).encode("utf-8"))
    signing_input = f"{header_b64}.{payload_b64}"
    signature = hmac.new(
        secret.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256
    ).digest()
    return f"{signing_input}.{_b64url_encode(signature)}"


def _decode_segment(segment: str, *, what: str) -> dict[str, Any]:
    raw = _b64url_decode(segment, what=what)
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except Exception as cause:  # noqa: BLE001 - normalised into a TokenError
        raise TokenError("malformed_token", f"{what} is not valid JSON") from cause
    if not isinstance(decoded, dict):
        raise TokenError("malformed_token", f"{what} must be a JSON object")
    return decoded


def verify_token(
    token: str,
    *,
    issuer: str,
    audience: str,
    secret: str,
    now: float | None = None,
) -> dict[str, Any]:
    """Validate a bearer token and return its claims, or raise :class:`TokenError`.

    ``issuer``, ``audience`` and ``secret`` always come from server-side
    configuration — never from the request.
    """
    if not secret:
        raise TokenError(
            "auth_not_configured",
            "Bearer-token authentication is not configured on this server",
        )
    if not isinstance(token, str) or not token.strip():
        raise TokenError("missing_token", "A bearer token is required")

    parts = token.strip().split(".")
    if len(parts) != 3:
        raise TokenError("malformed_token", "The bearer token is malformed")

    header_b64, payload_b64, signature_b64 = parts
    header = _decode_segment(header_b64, what="The token header")
    # The algorithm is taken from our own constant, never from the token.
    if header.get("alg") != ALGORITHM:
        raise TokenError("unsupported_algorithm", "Unsupported token algorithm")

    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    actual = _b64url_decode(signature_b64, what="The token signature")
    if not hmac.compare_digest(expected, actual):
        raise TokenError("invalid_signature", "The bearer token signature is invalid")

    claims = _decode_segment(payload_b64, what="The token payload")

    missing = [name for name in _REQUIRED_CLAIMS if name not in claims]
    if missing:
        raise TokenError(
            "missing_claims",
            "The bearer token is missing required claims: " + ", ".join(missing),
        )

    subject = claims["sub"]
    if not isinstance(subject, str) or not subject.strip():
        raise TokenError("missing_claims", "The bearer token has an empty subject")

    if claims["iss"] != issuer:
        raise TokenError("invalid_issuer", "The bearer token was issued by an unexpected issuer")

    # NOTE: compare against the *configured* audience passed in as a keyword
    # argument; never bind that name to the claim first, or the check becomes
    # a tautology that accepts any audience at all.
    claimed_audiences = claims["aud"]
    candidates = claimed_audiences if isinstance(claimed_audiences, list) else [claimed_audiences]
    if not any(isinstance(item, str) and item == audience for item in candidates):
        raise TokenError("invalid_audience", "The bearer token is not intended for this API")

    expires_at = claims["exp"]
    if not isinstance(expires_at, (int, float)) or isinstance(expires_at, bool):
        raise TokenError("missing_claims", "The bearer token has an invalid expiry")
    current = now if now is not None else time.time()
    if current >= float(expires_at):
        raise TokenError("token_expired", "The bearer token has expired; sign in again")

    not_before = claims.get("nbf")
    if isinstance(not_before, (int, float)) and not isinstance(not_before, bool):
        if current < float(not_before):
            raise TokenError("token_not_yet_valid", "The bearer token is not valid yet")

    return claims


# --------------------------------------------------------------------------- #
# Clerk (RS256 + JWKS) verification — Phase 6.0, ADR-0025
# --------------------------------------------------------------------------- #


@lru_cache(maxsize=8)
def get_jwks_client(jwks_url: str) -> JwksClient:
    """One cached JWKS client per URL for the life of the process.

    Caching the *client* (not just the keys) is what keeps JWKS retrieval off
    the request path: repeated verification of tokens naming a known ``kid``
    performs no network I/O at all.
    """
    return JwksClient(jwks_url)


def reset_jwks_clients() -> None:
    """Drop cached JWKS clients (used by tests when configuration changes)."""
    get_jwks_client.cache_clear()


def _token_error_for_jwt_exception(cause: Exception) -> TokenError:
    """Map a PyJWT failure onto this API's stable 401 prefixes."""
    if isinstance(cause, jwt.ExpiredSignatureError):
        return TokenError("token_expired", "The bearer token has expired; sign in again")
    if isinstance(cause, jwt.ImmatureSignatureError):
        return TokenError("token_not_yet_valid", "The bearer token is not valid yet")
    if isinstance(cause, jwt.InvalidIssuerError):
        return TokenError(
            "invalid_issuer", "The bearer token was issued by an unexpected issuer"
        )
    if isinstance(cause, jwt.InvalidAudienceError):
        return TokenError("invalid_audience", "The bearer token is not intended for this API")
    if isinstance(cause, jwt.MissingRequiredClaimError):
        missing = getattr(cause, "claim", None) or "required"
        return TokenError(
            "missing_claims", f"The bearer token is missing required claims: {missing}"
        )
    if isinstance(cause, jwt.InvalidSignatureError):
        return TokenError("invalid_signature", "The bearer token signature is invalid")
    if isinstance(cause, (jwt.InvalidTokenError, PyJWTError)):
        return TokenError("malformed_token", "The bearer token is malformed")
    return TokenError("malformed_token", "The bearer token is malformed")


def verify_clerk_token(
    token: str,
    *,
    issuer: str,
    audience: str,
    jwks_client: JwksClient,
    leeway_seconds: float = DEFAULT_LEEWAY_SECONDS,
) -> dict[str, Any]:
    """Validate a Clerk session token and return its claims.

    ``issuer``, ``audience`` and the JWKS endpoint always come from server-side
    configuration — never from the request. Time checks (``exp``, ``nbf``,
    future-dated ``iat``) are enforced by the verifier against the wall clock
    with :data:`DEFAULT_LEEWAY_SECONDS` of tolerance; tests control token
    lifetimes by minting tokens with the timestamps they want.

    Raises :class:`TokenError` with ``reason`` set to
    ``identity_provider_unavailable`` when no key material could be obtained at
    all; the HTTP layer answers 503 for that one reason, because refusing to
    sign a user out of a live session because the provider's *public-key
    endpoint* blipped would turn an outage into a logout.
    """
    if not issuer:
        raise TokenError(
            "auth_not_configured", "Bearer-token authentication is not configured on this server"
        )
    if not isinstance(token, str) or not token.strip():
        raise TokenError("missing_token", "A bearer token is required")

    try:
        header = jwt.get_unverified_header(token.strip())
    except Exception as cause:  # noqa: BLE001 - normalised into a TokenError
        raise TokenError("malformed_token", "The bearer token is malformed") from cause

    # The allowlist is ours. A header claiming HS256/none is rejected here, and
    # PyJWT would independently refuse it, because ``algorithms`` is pinned.
    if header.get("alg") not in ALLOWED_ALGORITHMS:
        raise TokenError("unsupported_algorithm", "Unsupported token algorithm")

    try:
        key = jwks_client.get_key(header.get("kid"))
    except JwksUnavailableError as cause:
        raise TokenError(cause.reason, cause.message) from cause
    except JwksError as cause:
        raise TokenError(cause.reason, cause.message) from cause

    options: dict[str, Any] = {
        "require": ["exp", "iat", "sub"],
        "verify_signature": True,
        # Clerk only sets ``aud`` when the JWT template names an API instance,
        # so audience checking is enabled exactly when it is configured.
        "verify_aud": bool(audience),
    }
    try:
        claims = jwt.decode(
            token.strip(),
            key,
            algorithms=list(ALLOWED_ALGORITHMS),
            issuer=issuer,
            audience=audience or None,
            leeway=leeway_seconds,
            options=options,
        )
    except Exception as cause:  # noqa: BLE001 - every PyJWT error is a rejection
        raise _token_error_for_jwt_exception(cause) from cause

    subject = claims.get("sub")
    if not isinstance(subject, str) or not subject.strip():
        raise TokenError("missing_claims", "The bearer token has an empty subject")
    return claims
