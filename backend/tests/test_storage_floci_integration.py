"""Opt-in integration test: the Azure adapter against the local Floci emulator.

Skipped unless ``FLOCI_STORAGE_TEST=1`` is set, so CI never needs a container.
To run it locally, with the emulator already listening on loopback:

    $env:FLOCI_STORAGE_TEST = "1"
    $env:AZURE_STORAGE_CONNECTION_STRING = '<from: floci az env>'
    ..\\.venv\\Scripts\\python.exe -m pytest tests/test_storage_floci_integration.py

``floci az env`` prints the emulator's connection string and can be piped
straight into the environment; it is never echoed by this test.

What a pass here does and does not mean:

* It proves the adapter speaks the emulator's blob wire protocol and that bytes
  survive upload, download, metadata read and delete.
* It does **not** prove anything about authentication. The emulator does not
  verify the SharedKey signature — unsigned and deliberately forged requests
  were both accepted against it, writes included — so a green run here says
  nothing about whether real Azure would accept these credentials, and nothing
  that would stop a caller who bypassed this provider. Floci is a functional
  stand-in, never a security boundary.
* It writes only to a dedicated, prefixed test object that the run deletes, and
  refuses to start against a non-loopback endpoint.
"""

from __future__ import annotations

import os
import uuid
from urllib.parse import urlparse

import pytest

from app.core.config import Settings
from app.services.storage import (
    ObjectNotFoundError,
    StorageConfigError,
    build_object_store,
)

pytestmark = pytest.mark.skipif(
    os.environ.get("FLOCI_STORAGE_TEST") != "1",
    reason=(
        "opt-in only: set FLOCI_STORAGE_TEST=1 with AZURE_STORAGE_CONNECTION_STRING "
        "pointing at a local Floci emulator"
    ),
)

#: Loopback hosts only. A real account could be reached by the same code path,
#: and nothing here is safe to run against data that matters.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "localhost.floci.io"})


@pytest.fixture(scope="module")
def emulator_store() -> object:
    """Build the provider from the process environment, against the emulator."""
    connection_string = os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "")
    if not connection_string:
        pytest.skip("FLOCI_STORAGE_TEST is set but AZURE_STORAGE_CONNECTION_STRING is empty")

    settings = Settings(
        environment="development",
        storage_provider="azure_blob",
        azure_storage_connection_string=connection_string,
        azure_storage_container=os.environ.get("AZURE_STORAGE_CONTAINER", "datadiet"),
        # The emulator is http on loopback; asserting the opt-in works is part
        # of what this module tests, so it is set rather than defaulted.
        azure_storage_allow_http=True,
        azure_storage_timeout_seconds=30,
    )
    store = build_object_store(settings)
    assert store is not None

    endpoint = urlparse(store._service.primary_endpoint)  # noqa: SLF001 - test inspects the wire
    assert (endpoint.hostname or "") in _LOOPBACK_HOSTS, (
        f"refusing to run emulator tests against non-loopback host {endpoint.hostname!r}"
    )
    store.ensure_container()
    return store


@pytest.fixture
def test_key() -> str:
    """One unique key per test, so parallel or repeated runs never collide."""
    return f"datadiet-provider-test/{uuid.uuid4().hex}.bin"


def test_upload_download_and_integrity(emulator_store, test_key: str) -> None:
    payload = bytes(range(256)) * 4096  # 1 MiB, every byte value, no coincidence possible
    meta = emulator_store.put(test_key, payload, content_type="application/octet-stream")
    try:
        assert meta.size_bytes == len(payload)
        assert emulator_store.exists(test_key) is True
        downloaded = emulator_store.get(test_key)
        assert len(downloaded) == len(payload)
        assert downloaded == payload
        assert downloaded[:16] + downloaded[-16:] == payload[:16] + payload[-16:]
        stat = emulator_store.stat(test_key)
        assert stat.size_bytes == len(payload)
    finally:
        emulator_store.delete(test_key)


def test_delete_then_absent_reads_behave(emulator_store, test_key: str) -> None:
    emulator_store.put(test_key, b"ephemeral")
    emulator_store.delete(test_key)
    assert emulator_store.exists(test_key) is False
    with pytest.raises(ObjectNotFoundError):
        emulator_store.get(test_key)
    emulator_store.delete(test_key)  # idempotent, even over a real wire


def test_absent_object_reports_not_found(emulator_store) -> None:
    missing = f"datadiet-provider-test/{uuid.uuid4().hex}.absent"
    assert emulator_store.exists(missing) is False
    with pytest.raises(ObjectNotFoundError):
        emulator_store.get(missing)
    with pytest.raises(ObjectNotFoundError):
        emulator_store.stat(missing)


def test_overwrite_guard_holds_over_the_wire(emulator_store, test_key: str) -> None:
    from app.services.storage import ObjectAlreadyExistsError

    emulator_store.put(test_key, b"first")
    try:
        with pytest.raises(ObjectAlreadyExistsError):
            emulator_store.put(test_key, b"second")
        assert emulator_store.get(test_key) == b"first"
    finally:
        emulator_store.delete(test_key)


def test_unreachable_endpoint_reports_unavailable(emulator_store, test_key: str) -> None:
    """A closed port must surface as StorageUnavailableError, not as data loss."""
    from app.services.storage import StorageUnavailableError
    from app.services.storage.azure_blob import AzureBlobStorage

    closed = (
        "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;"
        "AccountKey=cGxhY2Vob2xkZXI="
        ";BlobEndpoint=http://127.0.0.1:1/devstoreaccount1;"
    )
    store = AzureBlobStorage(connection_string=closed, container="datadiet", allow_http=True)
    with pytest.raises(StorageUnavailableError):
        store.get(test_key)


def test_insecure_endpoint_is_refused_before_any_request() -> None:
    from app.services.storage.azure_blob import AzureBlobStorage

    # Same emulator, opt-in withheld: this is the guard that stops a plaintext
    # account key, and it is DataDiet's own, because the SDK performs no such
    # check.
    insecure = (
        "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;"
        "AccountKey=cGxhY2Vob2xkZXI="
        ";BlobEndpoint=http://127.0.0.1:4577/devstoreaccount1;"
    )
    with pytest.raises(StorageConfigError, match="not HTTPS"):
        AzureBlobStorage(connection_string=insecure, container="datadiet")
