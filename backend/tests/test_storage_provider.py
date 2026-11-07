"""Provider-neutral object-storage boundary and its Azure adapter, with fakes.

Every test here runs against an in-memory stand-in for ``azure-storage-blob``:
no socket is opened, so this is the suite CI executes. The real-emulator run
lives in ``test_storage_floci_integration.py`` and is opt-in.

The module is organised by the behaviour under test rather than by class,
because the boundary's promise is the *taxonomy*: a caller learns whether an
object is absent, unreachable, or the deployment is misconfigured without
importing an SDK exception type.
"""

from __future__ import annotations

import logging
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from azure.core.exceptions import (
    HttpResponseError,
    ResourceExistsError,
    ResourceNotFoundError,
    ServiceRequestError,
)

from app.core.config import Settings
from app.services.storage import (
    ObjectAlreadyExistsError,
    ObjectMetadata,
    ObjectNotFoundError,
    ObjectStorage,
    StorageConfigError,
    StorageUnavailableError,
    build_object_store,
)
from app.services.storage import azure_blob as azure_blob_module
from app.services.storage.azure_blob import AzureBlobStorage, _safe_message
from app.services.storage.base import validate_container_name, validate_object_key

#: The emulator-shaped string: http on loopback, so it needs the allow_http opt-in.
LOCAL_CS = (
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;"
    "AccountKey=bG9jYWxlbXVsYXRvcmtleQ==;"
    "BlobEndpoint=http://127.0.0.1:4577/devstoreaccount1;"
)
#: A real deployment-shaped string: https, so it is the safe default path.
CLOUD_CS = (
    "AccountName=datadietstage;AccountKey=bG9jYWxlbXVsYXRvcmtleQ==;"
    "BlobEndpoint=https://datadietstage.blob.core.windows.net;"
)
#: The only secret material in this file. It is a fixed, fake value so the
#: leakage tests can search for it; it is not a credential of anything real.
FAKE_KEY = "bG9jYWxlbXVsYXRvcmtleQ=="
KEY = "archive/42/invoice.pdf"


class _FakeBlobClient:
    """Stands in for ``BlobClient`` over one fake container's dictionary."""

    def __init__(self, store: dict[str, bytes], key: str, *, fail: Exception | None) -> None:
        self._store = store
        self._key = key
        self._fail = fail
        self.calls: list[tuple[str, dict]] = []

    def _boom(self) -> None:
        if self._fail is not None:
            raise self._fail

    def upload_blob(self, data, **kwargs):  # noqa: ANN001 - fake SDK shim
        self.calls.append(("upload", kwargs))
        self._boom()
        if not kwargs.get("overwrite") and self._key in self._store:
            raise ResourceExistsError("The specified blob already exists.")
        self._store[self._key] = bytes(data)
        return SimpleNamespace(etag='"fake-etag"')

    def exists(self, **kwargs):  # noqa: ANN001 - fake SDK shim
        self.calls.append(("exists", kwargs))
        self._boom()
        return self._key in self._store

    def get_blob_properties(self, **kwargs):  # noqa: ANN001 - fake SDK shim
        self.calls.append(("properties", kwargs))
        self._boom()
        if self._key not in self._store:
            raise ResourceNotFoundError("The specified blob does not exist.")
        return SimpleNamespace(
            size=len(self._store[self._key]),
            content_settings=SimpleNamespace(content_type="application/octet-stream"),
            etag='"fake-etag"',
            last_modified=datetime.now(UTC),
        )

    def delete_blob(self, **kwargs):  # noqa: ANN001 - fake SDK shim
        self.calls.append(("delete", kwargs))
        self._boom()
        if self._key not in self._store:
            raise ResourceNotFoundError("The specified blob does not exist.")
        del self._store[self._key]


class _FakeContainerClient:
    def __init__(self, name: str) -> None:
        self.name = name
        self.store: dict[str, bytes] = {}
        self.fail: Exception | None = None
        self.created = 0
        self.blobs: list[_FakeBlobClient] = []

    def get_blob_client(self, key: str) -> _FakeBlobClient:
        blob = _FakeBlobClient(self.store, key, fail=self.fail)
        self.blobs.append(blob)
        return blob

    def download_blob(self, key: str, **kwargs):  # noqa: ANN001 - fake SDK shim
        if self.fail is not None:
            raise self.fail
        if key not in self.store:
            raise ResourceNotFoundError("The specified blob does not exist.")
        payload = self.store[key]
        return SimpleNamespace(readall=lambda: payload)

    def exists(self, **kwargs):  # noqa: ANN001 - fake SDK shim
        return True

    def create_container(self, **kwargs):  # noqa: ANN001 - fake SDK shim
        self.created += 1


class _FakeServiceClient:
    """Stands in for ``BlobServiceClient`` and records its construction."""

    def __init__(self, container: _FakeContainerClient, endpoint: str) -> None:
        self._container = container
        self.primary_endpoint = endpoint
        self.kwargs: dict = {}
        container.service = self

    def get_container_client(self, name: str) -> _FakeContainerClient:
        assert name == self._container.name
        return self._container


@pytest.fixture
def fake_service(monkeypatch: pytest.MonkeyPatch) -> _FakeContainerClient:
    """Route the adapter through fakes and hand back its container."""
    container = _FakeContainerClient("datadiet")
    service = _FakeServiceClient(container, "https://fake.blob.core.windows.net")

    def _from_connection_string(conn_str: str, credential=None, **kwargs):  # noqa: ANN001
        assert conn_str, "the adapter must forward the connection string it validated"
        service.kwargs = kwargs
        return service

    monkeypatch.setattr(
        azure_blob_module.BlobServiceClient,
        "from_connection_string",
        staticmethod(_from_connection_string),
    )
    return container


def make_store(**kwargs: object) -> AzureBlobStorage:
    kwargs.setdefault("connection_string", CLOUD_CS)
    kwargs.setdefault("container", "datadiet")
    return AzureBlobStorage(**kwargs)  # type: ignore[arg-type]


# -- 1. provider configuration validation -------------------------------------


def test_default_settings_select_no_store() -> None:
    settings = Settings(environment="development")
    assert settings.storage_provider == "none"
    assert build_object_store(settings) is None


def test_unknown_provider_name_is_refused_not_ignored() -> None:
    # ``Settings`` narrows the value with a Literal, so this shape only arrives
    # from code; the factory must still refuse rather than return None, which
    # is how a typo would silently become "storage is disabled".
    impostor = SimpleNamespace(
        storage_provider="s3",
        azure_storage_connection_string=CLOUD_CS,
        azure_storage_container="datadiet",
        azure_storage_allow_http=False,
        azure_storage_timeout_seconds=30,
    )
    with pytest.raises(StorageConfigError, match="has no implementation"):
        build_object_store(impostor)


def test_factory_passes_settings_into_the_adapter(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict = {}

    class _Recording:
        def __init__(self, **kwargs: object) -> None:
            seen.update(kwargs)

    monkeypatch.setattr(azure_blob_module, "AzureBlobStorage", _Recording)
    settings = Settings(
        environment="development",
        storage_provider="azure_blob",
        azure_storage_connection_string=CLOUD_CS,
        azure_storage_container="datadiet-stage",
        azure_storage_allow_http=False,
        azure_storage_timeout_seconds=7,
    )
    build_object_store(settings)
    assert seen == {
        "connection_string": CLOUD_CS,
        "container": "datadiet-stage",
        "allow_http": False,
        "timeout_seconds": 7,
    }


def test_settings_require_a_connection_string_for_a_live_provider() -> None:
    with pytest.raises(ValueError, match="AZURE_STORAGE_CONNECTION_STRING is required"):
        Settings(
            environment="development",
            storage_provider="azure_blob",
            azure_storage_connection_string="",
        )


def test_protected_environment_refuses_a_plaintext_storage_transport() -> None:
    with pytest.raises(ValueError, match="AZURE_STORAGE_ALLOW_HTTP"):
        Settings(
            environment="production",
            storage_provider="azure_blob",
            azure_storage_connection_string=CLOUD_CS,
            azure_storage_allow_http=True,
        )


def test_a_missing_store_is_not_a_credential_problem() -> None:
    # "no storage" and "broken storage" must not be confused at startup: the
    # default production deployment never reaches the adapter's validation.
    assert Settings(environment="production").storage_provider == "none"


# -- 2. upload and download ----------------------------------------------------


def test_put_then_get_round_trips_the_body(fake_service: _FakeContainerClient) -> None:
    store = make_store()
    payload = b"%PDF-1.7\n..."
    meta = store.put(KEY, payload, content_type="application/pdf")
    assert isinstance(meta, ObjectMetadata) and meta.key == KEY
    assert store.get(KEY) == payload
    upload = fake_service.blobs[-1].calls[0][1]
    assert upload["content_settings"].content_type == "application/pdf"
    assert upload["timeout"] == 30


def test_put_without_content_type_sends_no_settings(fake_service: _FakeContainerClient) -> None:
    store = make_store()
    store.put(KEY, b"x")
    assert fake_service.blobs[-1].calls[0][1]["content_settings"] is None


def test_the_adapter_passes_no_ignored_sdk_kwargs(fake_service: _FakeContainerClient) -> None:
    # ``require_https`` used to be passed here and does nothing in the SDK; the
    # adapter now enforces the transport itself, so it must send no kwargs.
    assert make_store()._service.kwargs == {}


def test_put_refuses_to_replace_by_default(fake_service: _FakeContainerClient) -> None:
    store = make_store()
    store.put(KEY, b"first")
    with pytest.raises(ObjectAlreadyExistsError):
        store.put(KEY, b"second")
    assert fake_service.store[KEY] == b"first"
    store.put(KEY, b"second", overwrite=True)
    assert fake_service.store[KEY] == b"second"


# -- 3. content integrity ------------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [b"", b"\x00\x01\x02\xff", b"z" * 200_000, "éè".encode()],
    ids=["empty", "control-bytes", "large", "utf8"],
)
def test_bytes_survive_the_boundary(fake_service: _FakeContainerClient, payload: bytes) -> None:
    store = make_store()
    meta = store.put(KEY, payload)
    assert meta.size_bytes == len(payload)
    assert store.get(KEY) == payload
    assert len(store.get(KEY)) == meta.size_bytes


def test_stat_reports_the_object_without_reading_it(fake_service: _FakeContainerClient) -> None:
    store = make_store()
    store.put(KEY, b"12345")
    meta = store.stat(KEY)
    assert (meta.size_bytes, meta.etag, meta.content_type) == (
        5,
        '"fake-etag"',
        "application/octet-stream",
    )
    assert meta.last_modified is not None


# -- 4. existence --------------------------------------------------------------


def test_exists_tracks_the_object(fake_service: _FakeContainerClient) -> None:
    store = make_store()
    assert store.exists(KEY) is False
    store.put(KEY, b"x")
    assert store.exists(KEY) is True


# -- 5. deletion ---------------------------------------------------------------


def test_delete_removes_the_object(fake_service: _FakeContainerClient) -> None:
    store = make_store()
    store.put(KEY, b"x")
    store.delete(KEY)
    assert store.exists(KEY) is False
    assert KEY not in fake_service.store


def test_delete_of_an_absent_object_is_not_an_error(fake_service: _FakeContainerClient) -> None:
    store = make_store()
    store.delete(KEY)  # idempotent by contract
    assert store.exists(KEY) is False


def test_ensure_container_creates_only_when_missing(
    monkeypatch: pytest.MonkeyPatch, fake_service: _FakeContainerClient
) -> None:
    store = make_store()
    store.ensure_container()
    assert fake_service.created == 0  # exists() is True in the fake
    monkeypatch.setattr(fake_service, "exists", lambda **k: False)
    store.ensure_container()
    assert fake_service.created == 1


# -- 6. missing-object handling ------------------------------------------------


def test_get_and_stat_of_a_missing_object_raise_object_not_found(
    fake_service: _FakeContainerClient,
) -> None:
    store = make_store()
    with pytest.raises(ObjectNotFoundError):
        store.get(KEY)
    with pytest.raises(ObjectNotFoundError):
        store.stat(KEY)


def test_an_untyped_404_is_still_reported_as_not_found(
    fake_service: _FakeContainerClient,
) -> None:
    store = make_store()
    error = HttpResponseError("The specified container is being deleted.")
    error.status_code = 404  # some relays lose the typed subclass
    fake_service.fail = error
    with pytest.raises(ObjectNotFoundError):
        store.exists(KEY)


# -- 7. connection-failure handling --------------------------------------------


def test_transport_failure_becomes_storage_unavailable(
    fake_service: _FakeContainerClient,
) -> None:
    store = make_store()
    fake_service.fail = ServiceRequestError("Cannot connect to host.")
    with pytest.raises(StorageUnavailableError, match="endpoint unreachable"):
        store.exists(KEY)
    with pytest.raises(StorageUnavailableError, match="endpoint unreachable"):
        store.get(KEY)


def test_server_error_becomes_storage_unavailable(fake_service: _FakeContainerClient) -> None:
    store = make_store()
    error = HttpResponseError("Server is currently unable to handle the request.")
    error.status_code = 503
    fake_service.fail = error
    with pytest.raises(StorageUnavailableError, match="operation failed"):
        store.exists(KEY)


def test_a_failure_is_never_reported_as_a_configuration_error(
    fake_service: _FakeContainerClient,
) -> None:
    store = make_store()
    fake_service.fail = ServiceRequestError("connection reset")
    with pytest.raises(StorageUnavailableError):
        store.put(KEY, b"x")


# -- 8. invalid configuration --------------------------------------------------


def test_blank_connection_string_is_refused() -> None:
    with pytest.raises(StorageConfigError, match="AZURE_STORAGE_CONNECTION_STRING is required"):
        AzureBlobStorage(connection_string="   ", container="datadiet")


def test_unparseable_connection_string_names_only_the_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _raise(conn_str: str, credential=None, **kwargs):  # noqa: ANN001
        raise ValueError("Invalid connection string")

    monkeypatch.setattr(
        azure_blob_module.BlobServiceClient, "from_connection_string", staticmethod(_raise)
    )
    with pytest.raises(StorageConfigError, match="could not be parsed") as caught:
        AzureBlobStorage(
            connection_string=f"nonsense;AccountKey={FAKE_KEY}", container="datadiet"
        )
    assert FAKE_KEY not in str(caught.value)


@pytest.mark.parametrize(
    "name", ["", "ab", "DataDiet", "-lead", "trail-", "a" * 64, "has_underscore"]
)
def test_container_names_are_validated_before_any_request(name: str) -> None:
    with pytest.raises(StorageConfigError):
        validate_container_name(name)
    with pytest.raises(StorageConfigError):
        AzureBlobStorage(connection_string=CLOUD_CS, container=name)


@pytest.mark.parametrize("name", ["datadiet", "datadiet-stage", "a1b", "a" * 63])
def test_valid_container_names_pass(name: str) -> None:
    assert validate_container_name(name) == name


@pytest.mark.parametrize(
    "key",
    [
        "",
        "a" * 1025,
        "archive/../secrets",
        "/absolute",
        "trailing/",
        "double//slash",
        "back\\slash",
        "line\nbreak",
        "./relative",
    ],
    ids=[
        "empty",
        "too-long",
        "dotdot",
        "absolute",
        "trailing-slash",
        "empty-segment",
        "backslash",
        "control-char",
        "dot-segment",
    ],
)
def test_unsafe_object_keys_are_refused_before_the_sdk_sees_them(
    key: str, fake_service: _FakeContainerClient
) -> None:
    store = make_store()
    with pytest.raises(StorageConfigError):
        validate_object_key(key)
    for operation in (
        lambda: store.put(key, b"x"),
        lambda: store.get(key),
        lambda: store.exists(key),
        lambda: store.stat(key),
        lambda: store.delete(key),
    ):
        with pytest.raises(StorageConfigError):
            operation()
    assert fake_service.blobs == []  # nothing reached the client at all


def test_object_data_must_be_bytes(fake_service: _FakeContainerClient) -> None:
    store = make_store()
    with pytest.raises(StorageConfigError, match="must be bytes"):
        store.put(KEY, "a str")  # type: ignore[arg-type]


def test_timeout_must_be_positive() -> None:
    with pytest.raises(StorageConfigError, match="timeout"):
        AzureBlobStorage(
            connection_string=CLOUD_CS, container="datadiet", timeout_seconds=0
        )


def test_http_endpoint_needs_an_explicit_opt_in(fake_service: _FakeContainerClient) -> None:
    # The fake reports whatever endpoint the connection string resolved to, so
    # this asserts the check reads the *resolved* value rather than the text.
    fake_service.service.primary_endpoint = "http://127.0.0.1:4577/devstoreaccount1"
    with pytest.raises(StorageConfigError, match="not HTTPS"):
        AzureBlobStorage(connection_string=LOCAL_CS, container="datadiet")
    store = AzureBlobStorage(
        connection_string=LOCAL_CS, container="datadiet", allow_http=True
    )
    assert store.provider_name == "azure_blob"


# -- 9. no credential leakage --------------------------------------------------


def test_safe_message_redacts_key_assignments_and_authorization_headers() -> None:
    raw = (
        f"Cannot connect to host AccountKey={FAKE_KEY}&"
        "sig=abcdef&Authorization=SharedKey devstoreaccount1:aaaaBBcc=="
    )
    redacted = _safe_message(raw)
    assert FAKE_KEY not in redacted
    assert "aaaaBBcc==" not in redacted
    assert "abcdef" not in redacted
    assert "Cannot connect to host" in redacted
    assert "\n" not in redacted


def test_safe_message_redacts_a_multiline_and_long_input() -> None:
    assert "\n" not in _safe_message(f"line one\nAccountKey={FAKE_KEY}\nline two")
    assert _safe_message("q" * 500).endswith("…")


def test_error_messages_carry_no_key(fake_service: _FakeContainerClient) -> None:
    store = make_store()
    error = HttpResponseError(
        f"AccountKey={FAKE_KEY} SharedKey devstoreaccount1:zzzz=="
    )
    error.status_code = 403
    fake_service.fail = error
    with pytest.raises(StorageUnavailableError) as caught:
        store.get(KEY)
    assert FAKE_KEY not in str(caught.value)
    assert "zzzz==" not in str(caught.value)


def test_logging_a_failure_does_not_log_a_credential(
    caplog: pytest.LogCaptureFixture, fake_service: _FakeContainerClient
) -> None:
    store = make_store()
    fake_service.fail = ServiceRequestError(f"Failed to connect, AccountKey={FAKE_KEY}")
    with caplog.at_level(logging.DEBUG):
        try:
            store.get(KEY)
        except StorageUnavailableError as error:
            logging.getLogger("datadiet.storage").error("%s", error)
    assert FAKE_KEY not in caplog.text


# -- 10. existing DataDiet behaviour stays put ----------------------------------


def test_the_interface_exposes_only_the_justified_operations() -> None:
    assert set(ObjectStorage.__abstractmethods__) == {"put", "get", "delete", "exists", "stat"}


def test_the_default_app_never_imports_the_storage_sdk() -> None:
    # Evidence for the "nothing existing changed" claim: with the shipped
    # default (STORAGE_PROVIDER=none) building the application must not even
    # load azure-storage-blob, so the new dependency cannot alter an old path.
    code = (
        "import sys;"
        "from app.main import create_app;"
        "create_app();"
        "print('azure.storage.blob' in sys.modules)"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        check=False,
        cwd=str(Path(__file__).resolve().parents[1]),
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip().endswith("False"), result.stdout
