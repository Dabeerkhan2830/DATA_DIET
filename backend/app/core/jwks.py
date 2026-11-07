"""Clerk JWT verification: RS256 signatures checked against a cached JWKS.

This is the *resource-server* half of a real identity-provider integration
(ADR-0025). Clerk signs session tokens with RS256 and publishes the matching
public keys at ``https://<issuer>/.well-known/jwks.json``. Verification here
therefore needs two things the previous HS256 path did not: an asymmetric
signature check, and the current set of public keys.

The rules that matter for safety:

* **The algorithm is never taken from the token.** ``ALLOWED_ALGORITHMS`` is a
  module constant and is passed to the verifier as an explicit allowlist, so a
  header claiming ``HS256`` (or ``none``) cannot select the verification
  strategy — and an HS256 token is *never* accepted on this path, not even as a
  fallback when the JWKS lookup fails.
* **Keys are cached, not fetched per request.** A verified request performs no
  network I/O. The cache is refreshed when the document's age exceeds
  :data:`DEFAULT_TTL_SECONDS`, and — separately — when a token names a ``kid``
  we do not have, which is how key rotation is picked up.
* **Rotation is rate limited.** A single request may trigger at most one
  refresh, and refreshes triggered by unknown ``kid`` values must be
  :data:`DEFAULT_MIN_REFRESH_INTERVAL_SECONDS` apart, so a flood of tokens with
  made-up ``kid`` values cannot turn the API into a proxy for the identity
  provider.
* **Fail closed.** No usable key means the token is refused. A transport or
  parse failure with no cached document at all is reported as an identity
  provider that is unavailable (:data:`JwksUnavailableError`), which callers
  surface as 503 rather than silently signing people out.

Nothing in this module logs a token, a key, or a secret value.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey

#: The only signature algorithm this verifier will ever use. Clerk's supported
#: JWT templates sign with RS256; the list is fixed here rather than read from
#: the token header.
ALLOWED_ALGORITHMS: tuple[str, ...] = ("RS256",)

#: How long a fetched JWKS document stays fresh for tokens whose ``kid`` is
#: already known. Rotation is handled by the ``kid``-miss path, so this can be
#: generous without weakening anything.
DEFAULT_TTL_SECONDS = 300.0

#: Minimum spacing between refreshes triggered by an unknown ``kid``.
DEFAULT_MIN_REFRESH_INTERVAL_SECONDS = 30.0

#: Hard timeout for one JWKS HTTP attempt. A slow identity provider must not
#: pin a worker.
DEFAULT_TIMEOUT_SECONDS = 5.0

USER_AGENT = "DataDiet-JWKS-Client/1.0"


class JwksError(Exception):
    """A JWKS document could not be used. ``reason`` is a stable code."""

    reason = "jwks_unavailable"

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message


class JwksUnavailableError(JwksError):
    """No JWKS document could be obtained *and* none is cached."""

    reason = "identity_provider_unavailable"

    def __init__(self, message: str) -> None:
        super().__init__(self.reason, message)


def fetch_jwks_document(url: str, *, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> dict[str, Any]:
    """Retrieve one JWKS document over HTTP(S).

    ``http`` is refused outright except for loopback, which only local test
    fixtures use: public keys are not secret, but a signed token's trust is only
    as good as the channel the key arrived over.
    """
    lowered = url.lower()
    if not lowered.startswith("https://") and not any(
        lowered.startswith(f"http://{host}") for host in ("127.0.0.1", "localhost", "[::1]")
    ):
        raise JwksError(
            "insecure_jwks_url", "The JWKS URL must use https outside local development"
        )
    request = urllib.request.Request(
        url, headers={"Accept": "application/json", "User-Agent": USER_AGENT}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
    except urllib.error.HTTPError as cause:
        raise JwksError(
            "jwks_http_error", f"The JWKS endpoint returned HTTP {cause.code}"
        ) from cause
    except (urllib.error.URLError, TimeoutError, OSError) as cause:
        raise JwksUnavailableError(
            "The JWKS endpoint could not be reached"
        ) from cause
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as cause:
        raise JwksError("malformed_jwks", "The JWKS document is not valid JSON") from cause
    if not isinstance(parsed, dict) or not isinstance(parsed.get("keys"), list):
        raise JwksError("malformed_jwks", "The JWKS document has no 'keys' array")
    return parsed


def _rsa_public_key(jwk: dict[str, Any]) -> RSAPublicKey | None:
    """Convert one JWK to an RSA public key, or ``None`` if it is unusable.

    Unsupported key types are skipped rather than fatal: a JWKS may legally
    publish several algorithms, and only ``RS256`` is in scope here.
    """
    if jwk.get("kty") != "RSA":
        return None
    if jwk.get("use") not in (None, "sig"):
        return None
    if jwk.get("alg") not in (None, *ALLOWED_ALGORITHMS):
        return None
    if not (jwk.get("kid") and jwk.get("n") and jwk.get("e")):
        return None
    try:
        key = jwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(jwk))
    except Exception:  # noqa: BLE001 - a bad key is skipped, never trusted
        return None
    return key if isinstance(key, RSAPublicKey) else None


FetchJwks = Callable[[str], dict[str, Any]]


class JwksClient:
    """A cached ``kid`` -> RSA public key resolver for one JWKS endpoint."""

    def __init__(
        self,
        jwks_url: str,
        *,
        fetch: FetchJwks = fetch_jwks_document,
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
        min_refresh_interval_seconds: float = DEFAULT_MIN_REFRESH_INTERVAL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.jwks_url = jwks_url
        self._fetch = fetch
        self._ttl = ttl_seconds
        self._min_refresh_interval = min_refresh_interval_seconds
        self._clock = clock
        self._keys: dict[str, RSAPublicKey] = {}
        self._fetched_at: float | None = None
        self._last_forced_refresh: float | None = None
        self.fetch_count = 0

    # -- retrieval ---------------------------------------------------------- #

    def _load(self) -> dict[str, RSAPublicKey]:
        document = self._fetch(self.jwks_url)
        self.fetch_count += 1
        keys: dict[str, RSAPublicKey] = {}
        for entry in document["keys"]:
            if not isinstance(entry, dict):
                continue
            key = _rsa_public_key(entry)
            if key is not None:
                keys[str(entry["kid"])] = key
        if not keys:
            raise JwksError(
                "malformed_jwks", "The JWKS document contains no usable RS256 key"
            )
        self._keys = keys
        self._fetched_at = self._clock()
        return keys

    def _refresh(self, *, forced: bool) -> dict[str, RSAPublicKey]:
        """Fetch, keeping any previously cached keys when the fetch fails.

        A transient outage must not invalidate tokens that were working a second
        ago; the retained cache is bounded by the TTL checks in :meth:`get_key`.
        """
        if forced:
            self._last_forced_refresh = self._clock()
        try:
            return self._load()
        except JwksUnavailableError:
            if self._keys:
                return self._keys
            raise
        except JwksError:
            if self._keys:
                return self._keys
            raise

    def get_key(self, kid: str | None) -> RSAPublicKey:
        """Resolve ``kid`` to its public key or raise :class:`JwksError`.

        The cache is consulted first, so a request for a known key performs no
        network I/O at all.
        """
        now = self._clock()
        expired = self._fetched_at is None or (now - self._fetched_at) >= self._ttl

        if not self._keys or expired:
            return self._resolve_after_refresh(kid, force=True)

        if kid is None:
            # Clerk always labels its keys. Without a ``kid`` we cannot pick a
            # key, and trying every cached key is a signature-bending smell.
            raise JwksError(
                "missing_key_id", "The bearer token header carries no 'kid'"
            )

        key = self._keys.get(kid)
        if key is not None:
            return key
        return self._resolve_after_refresh(kid, force=False)

    def _resolve_after_refresh(self, kid: str | None, *, force: bool) -> RSAPublicKey:
        now = self._clock()
        if not force and self._last_forced_refresh is not None:
            if (now - self._last_forced_refresh) < self._min_refresh_interval:
                raise JwksError(
                    "unknown_key_id", "The bearer token was signed with an unknown key"
                )
        keys = self._refresh(forced=not force)
        if kid is None:
            raise JwksError("missing_key_id", "The bearer token header carries no 'kid'")
        key = keys.get(kid)
        if key is None:
            raise JwksError(
                "unknown_key_id", "The bearer token was signed with an unknown key"
            )
        return key
