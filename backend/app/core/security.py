"""Bearer-token (JWT, HS256) verification and issuance (Phase 7).

This module is the *resource-server* half of an OIDC/SSO integration: it
validates a bearer token that an identity provider issued. It is deliberately
small, dependency-free (standard library only) and strict.

Verification enforces, in order:

* exactly three ``base64url``-encoded segments;
* ``alg`` is exactly ``HS256`` (``none`` and algorithm confusion are rejected by
  never consulting the token for the algorithm);
* the HMAC-SHA256 signature, compared in constant time;
* ``iss`` equality, ``aud`` membership, and a required, unexpired ``exp``.

Nothing in here logs, persists, or returns the shared secret, and no claim is
trusted for authorization — see ``app.core.auth`` for the authorization layer,
which uses the local user directory rather than token claims.

A real OIDC provider signs with RS256/ES256 and publishes a JWKS document.
Supporting that requires a JWKS client and a crypto library; it is intentionally
not implemented here, and production therefore stays fail-closed until such a
provider (or an HS256 shared secret it actually uses) is configured. See
``docs/decisions.md`` ADR-0014.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

# Algorithms this module is willing to accept. The value is fixed rather than
# read from the token header, so an attacker-supplied ``alg`` can never select
# the verification strategy.
ALGORITHM = "HS256"

# Claims that must be present and well typed for a token to be usable.
_REQUIRED_CLAIMS = ("iss", "aud", "exp", "sub")


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
