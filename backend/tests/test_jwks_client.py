"""Tests for the JWKS client: caching, rotation, rate limiting, and fail-closed rules.

The requirements these pin down (Phase 6.0 Part B1, ADR-0025):

* no network request to the JWKS endpoint on every API request;
* ``kid`` rotation is picked up, and an unknown ``kid`` cannot trigger a fetch storm;
* a cached document survives a transient provider outage;
* nothing usable means nothing accepted — never a silent pass.
"""

from __future__ import annotations

import io
import json
import urllib.error
import urllib.request

import pytest
from clerk_fixtures import FakeClock, ScriptedJwks, jwks_document, make_signing_key

from app.core.jwks import (
    DEFAULT_TIMEOUT_SECONDS,
    JwksClient,
    JwksError,
    JwksUnavailableError,
    fetch_jwks_document,
)

JWKS_URL = "https://datadiet-fixture.clerk.accounts.local/.well-known/jwks.json"


def _client(
    *docs: dict, clock: FakeClock | None = None, **kwargs
) -> tuple[JwksClient, ScriptedJwks]:
    scripted = ScriptedJwks(*docs)
    client = JwksClient(JWKS_URL, fetch=scripted, clock=clock or FakeClock(), **kwargs)
    return client, scripted


class _Response(io.BytesIO):
    """Minimal stand-in for the context manager ``urlopen`` returns."""

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def _serve(monkeypatch: pytest.MonkeyPatch, payload: bytes) -> None:
    monkeypatch.setattr(
        "urllib.request.urlopen", lambda request, timeout=None: _Response(payload)
    )


def _fails(monkeypatch: pytest.MonkeyPatch, error: Exception) -> None:
    def refuse(request, timeout=None):  # noqa: ANN001
        raise error

    monkeypatch.setattr("urllib.request.urlopen", refuse)


# --------------------------------------------------------------------------- #
# Caching — the "no per-request network" requirement
# --------------------------------------------------------------------------- #


def test_known_key_is_served_from_cache_without_refetching() -> None:
    key = make_signing_key("kid-1")
    client, scripted = _client(jwks_document(key))

    for _ in range(10):
        assert client.get_key("kid-1") is not None

    assert client.fetch_count == 1
    assert scripted.calls == 1


def test_document_is_refetched_once_the_ttl_expires() -> None:
    key = make_signing_key("kid-1")
    clock = FakeClock()
    client, _ = _client(jwks_document(key), clock=clock, ttl_seconds=60.0)

    client.get_key("kid-1")
    clock.advance(59.0)
    client.get_key("kid-1")
    assert client.fetch_count == 1

    clock.advance(2.0)
    client.get_key("kid-1")
    assert client.fetch_count == 2


def test_cached_keys_survive_a_provider_outage() -> None:
    """A blip while refreshing must not invalidate tokens that were working."""
    key = make_signing_key("kid-1")
    clock = FakeClock()

    def flaky(url: str) -> dict:
        flaky.calls += 1
        if flaky.calls == 1:
            return jwks_document(key)
        raise JwksUnavailableError("The JWKS endpoint could not be reached")

    flaky.calls = 0
    client = JwksClient(JWKS_URL, fetch=flaky, clock=clock, ttl_seconds=30.0)

    assert client.get_key("kid-1") is not None
    clock.advance(31.0)
    assert client.get_key("kid-1") is not None


def test_outage_with_nothing_cached_reports_the_provider_unavailable() -> None:
    def down(url: str) -> dict:
        raise JwksUnavailableError("The JWKS endpoint could not be reached")

    client = JwksClient(JWKS_URL, fetch=down)
    with pytest.raises(JwksUnavailableError) as caught:
        client.get_key("kid-1")
    assert caught.value.reason == "identity_provider_unavailable"


# --------------------------------------------------------------------------- #
# Rotation
# --------------------------------------------------------------------------- #


def test_unknown_kid_triggers_one_refresh_and_then_resolves() -> None:
    """This is how rotation is picked up: a key the server has not seen yet."""
    old = make_signing_key("kid-old")
    new = make_signing_key("kid-new")
    client, scripted = _client(jwks_document(old))

    assert client.get_key("kid-old") is not None
    scripted.publish(jwks_document(old, new))
    assert client.get_key("kid-new") is not None
    assert client.fetch_count == 2


def test_unknown_kid_refreshes_are_rate_limited() -> None:
    """Tokens naming made-up key ids must not turn the API into a JWKS proxy."""
    old = make_signing_key("kid-old")
    client, _ = _client(jwks_document(old), min_refresh_interval_seconds=30.0)

    assert client.get_key("kid-old") is not None
    with pytest.raises(JwksError) as first:
        client.get_key("kid-invented-1")
    assert first.value.reason == "unknown_key_id"
    fetches_after_first_miss = client.fetch_count

    for attempt in range(20):
        with pytest.raises(JwksError) as later:
            client.get_key(f"kid-invented-{attempt}")
        assert later.value.reason == "unknown_key_id"

    assert client.fetch_count == fetches_after_first_miss


def test_rate_limit_expires_so_rotation_is_not_blocked_forever() -> None:
    old = make_signing_key("kid-old")
    new = make_signing_key("kid-new")
    clock = FakeClock()
    client, scripted = _client(
        jwks_document(old),
        clock=clock,
        min_refresh_interval_seconds=30.0,
    )
    client.get_key("kid-old")
    with pytest.raises(JwksError):
        client.get_key("kid-new")

    scripted.publish(jwks_document(old, new))
    # The provider now publishes the key, but the kid-miss refresh is still
    # inside its window, so a flood of unknown kids cannot hammer the endpoint.
    with pytest.raises(JwksError):
        client.get_key("kid-new")
    assert client.fetch_count == 2

    clock.advance(31.0)
    assert client.get_key("kid-new") is not None
    assert client.fetch_count == 3


def test_missing_kid_is_refused_rather_than_tried_against_every_key() -> None:
    key = make_signing_key("kid-1")
    client, _ = _client(jwks_document(key))
    with pytest.raises(JwksError) as caught:
        client.get_key(None)
    assert caught.value.reason == "missing_key_id"


# --------------------------------------------------------------------------- #
# Documents that are unusable
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "document",
    [
        {"keys": []},
        {"keys": ["not-a-jwk"]},
        {"keys": [{"kty": "EC", "kid": "x", "crv": "P-256"}]},
        {"keys": [{"kty": "oct", "kid": "x", "k": "secret"}]},
    ],
)
def test_a_document_without_usable_rs256_keys_fails_closed(document: dict) -> None:
    client, _ = _client(document)
    with pytest.raises(JwksError) as caught:
        client.get_key("kid-1")
    assert caught.value.reason == "malformed_jwks"


def test_keys_that_are_not_rs256_signing_keys_are_skipped() -> None:
    """A JWKS may publish several uses and algorithms; only RS256 sig keys are cached."""
    good = make_signing_key("kid-good")
    encrypted_use = dict(good.jwk, kid="kid-enc", use="enc")
    other_algorithm = dict(good.jwk, kid="kid-other", alg="RS512")
    unreadable_material = dict(good.jwk, kid="kid-broken", n="%%%not-base64%%%")
    client, _ = _client({"keys": [good.jwk, encrypted_use, other_algorithm, unreadable_material]})

    assert client.get_key("kid-good") is not None
    for rejected in ("kid-enc", "kid-other", "kid-broken"):
        with pytest.raises(JwksError) as caught:
            client.get_key(rejected)
        assert caught.value.reason == "unknown_key_id"


def test_published_key_material_carries_no_private_component() -> None:
    """A JWKS is a public artefact; a fixture that leaked a private key would be
    a false model of the provider and a secret in the repository."""
    document = jwks_document(make_signing_key("kid-1"), make_signing_key("kid-2"))
    private_members = {"d", "p", "q", "dp", "dq", "qi"}
    for entry in document["keys"]:
        assert not private_members & set(entry)


# --------------------------------------------------------------------------- #
# Transport rules
# --------------------------------------------------------------------------- #


def test_plain_http_jwks_url_is_refused_before_any_request() -> None:
    """Public keys arrive over a channel the token's trust depends on."""
    with pytest.raises(JwksError) as caught:
        fetch_jwks_document("http://datadiet-fixture.example/.well-known/jwks.json")
    assert caught.value.reason == "insecure_jwks_url"


def test_loopback_http_is_allowed_for_local_fixtures(monkeypatch: pytest.MonkeyPatch) -> None:
    """Local test providers are the one place plain http is acceptable."""
    _serve(monkeypatch, json.dumps(jwks_document(make_signing_key("kid-1"))).encode("utf-8"))
    parsed = fetch_jwks_document("http://127.0.0.1:8099/.well-known/jwks.json")
    assert [key["kid"] for key in parsed["keys"]] == ["kid-1"]


def test_http_error_is_a_provider_failure_not_a_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    _fails(
        monkeypatch,
        urllib.error.HTTPError(JWKS_URL, 503, "Service Unavailable", {}, None),
    )
    with pytest.raises(JwksError) as caught:
        fetch_jwks_document(JWKS_URL)
    assert caught.value.reason == "jwks_http_error"


def test_unreachable_endpoint_is_reported_as_provider_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fails(monkeypatch, urllib.error.URLError("connection refused"))
    with pytest.raises(JwksUnavailableError) as caught:
        fetch_jwks_document(JWKS_URL)
    assert caught.value.reason == "identity_provider_unavailable"


def test_a_socket_timeout_is_reported_as_provider_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fails(monkeypatch, TimeoutError("timed out"))
    with pytest.raises(JwksUnavailableError):
        fetch_jwks_document(JWKS_URL)


def test_non_json_body_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _serve(monkeypatch, b"<html>not a jwks</html>")
    with pytest.raises(JwksError) as caught:
        fetch_jwks_document(JWKS_URL)
    assert caught.value.reason == "malformed_jwks"


def test_json_that_is_not_a_document_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _serve(monkeypatch, json.dumps([{"kid": "kid-1"}]).encode("utf-8"))
    with pytest.raises(JwksError) as caught:
        fetch_jwks_document(JWKS_URL)
    assert caught.value.reason == "malformed_jwks"


def test_fetch_uses_a_bounded_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    """A slow identity provider must not be able to pin a worker indefinitely."""
    seen: dict[str, object] = {}

    def record(request, timeout=None):  # noqa: ANN001
        seen["timeout"] = timeout
        seen["url"] = request.full_url
        return _Response(b'{"keys": []}')

    monkeypatch.setattr("urllib.request.urlopen", record)
    document = fetch_jwks_document(JWKS_URL, timeout=7.5)
    assert seen["timeout"] == 7.5
    assert seen["url"] == JWKS_URL
    assert document == {"keys": []}

    fetch_jwks_document(JWKS_URL)
    assert seen["timeout"] == DEFAULT_TIMEOUT_SECONDS
