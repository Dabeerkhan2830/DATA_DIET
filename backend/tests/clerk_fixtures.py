"""Real RSA key material and JWKS scripts for the Clerk verification tests.

The path under test is the one a staging deployment uses, so the fixtures sign
with genuine RS256 private keys and serve genuine JWK documents. A stubbed
signature check would prove nothing about the algorithm allowlist, the ``kid``
lookup, or key rotation.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

#: Issuer used by the fixtures. Any ``iss`` works — what matters is that the
#: server, not the token, decides which one is valid.
FIXED_ISSUER = "https://datadiet-fixture.clerk.accounts.local"

#: Audience used when a test wants the JWT template to name this API.
FIXED_AUDIENCE = "datadiet-api"

#: Clerk-style subject. Clerk ``sub`` values are opaque strings, not user ids.
FIXED_SUBJECT = "user_2ZfFixtureSubject000000000"

ALG = "RS256"


@dataclass(frozen=True)
class SigningKey:
    """One RSA key pair: the private half mints tokens, the public half is published."""

    kid: str
    private_key: rsa.RSAPrivateKey
    jwk: dict[str, Any] = field(compare=False)


def make_signing_key(kid: str) -> SigningKey:
    """Generate a 2048-bit RSA key pair; the JWK is the *public* half only.

    A real JWKS never carries a private key, and PyJWT would happily serialise
    one if handed the private object — so the public key is what gets published
    here, exactly as an identity provider publishes it.
    """
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk: dict[str, Any] = RSAAlgorithm.to_jwk(private_key.public_key(), as_dict=True)
    jwk["kid"] = kid
    jwk["use"] = "sig"
    jwk["alg"] = ALG
    return SigningKey(kid=kid, private_key=private_key, jwk=jwk)


def jwks_document(*keys: SigningKey) -> dict[str, Any]:
    """A JWKS document publishing exactly the given keys."""
    return {"keys": [key.jwk for key in keys]}


def mint_token(
    signing_key: SigningKey,
    *,
    issuer: str = FIXED_ISSUER,
    audience: str | None = FIXED_AUDIENCE,
    subject: str = FIXED_SUBJECT,
    expires_in: float = 300.0,
    not_before_in: float | None = None,
    issued_at_in: float | None = None,
    claims: dict[str, Any] | None = None,
    kid_override: str | None = None,
    include_kid: bool = True,
    header: dict[str, Any] | None = None,
) -> str:
    """Sign a session token with ``signing_key``'s private half.

    ``include_kid=False`` omits the key id from the header and
    ``kid_override`` names a key the server has never seen — that is how the
    missing-``kid`` and rotation tests are expressed without touching
    production code.

    Lifetimes are expressed as offsets from *now* so the tests do not depend on
    the wall clock: PyJWT has no clock injection, and pretending otherwise
    would test a parameter the verifier ignores.
    """
    now = int(time.time())
    payload: dict[str, Any] = {
        "iss": issuer,
        "sub": subject,
        "iat": now + int(issued_at_in or 0),
        "exp": now + int(expires_in),
    }
    if audience is not None:
        payload["aud"] = audience
    if not_before_in is not None:
        payload["nbf"] = now + int(not_before_in)
    if claims:
        payload.update(claims)

    token_headers: dict[str, Any] = {}
    if include_kid:
        token_headers["kid"] = kid_override or signing_key.kid
    if header:
        token_headers.update(header)

    return jwt.encode(
        payload,
        signing_key.private_key,
        algorithm=ALG,
        headers=token_headers or None,
    )


def mint_unsigned_token(claims: dict[str, Any]) -> str:
    """Forge an ``alg: none`` token, the other classic bypass attempt."""
    return jwt.encode(claims, key=None, algorithm="none")


class ScriptedJwks:
    """A stand-in for the identity provider's JWKS endpoint.

    Mirrors ``app.core.jwks.fetch_jwks_document``'s contract (returns a parsed
    document, raises :class:`JwksError` subclasses on failure) and counts how
    many times it was called, which is how the "no network per request"
    requirement is asserted.

    Every call serves the *currently published* document, so a test controls
    rotation timing with :meth:`publish` rather than by counting calls.
    """

    def __init__(self, *documents: dict[str, Any]) -> None:
        self._documents = list(documents)
        self.calls = 0

    @property
    def current(self) -> dict[str, Any]:
        return self._documents[-1] if self._documents else {"keys": []}

    def publish(self, document: dict[str, Any]) -> None:
        """Serve a new document from now on (simulating key rotation)."""
        self._documents.append(document)

    def __call__(self, url: str) -> dict[str, Any]:
        self.calls += 1
        return self.current


class FakeClock:
    """A monotonic clock the test advances manually, for TTL and rate-limit checks."""

    def __init__(self, start: float = 1_000.0) -> None:
        self._start = start
        self.now = start

    def advance(self, seconds: float) -> None:
        self.now += seconds

    def __call__(self) -> float:
        return self.now
