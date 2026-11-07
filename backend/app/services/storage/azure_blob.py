"""Azure Blob Storage implementation of the DataDiet object-storage boundary.

One SDK, one container, five operations. The class exists to keep every
``azure.storage.blob`` symbol behind ``ObjectStorage``, so services and routes
never import the SDK and the failure taxonomy in ``app.services.storage.base``
is the only error surface callers see.

Two properties are stated plainly because both were measured against the local
Floci emulator rather than assumed:

* **Floci does not verify the SharedKey signature.** Unsigned and deliberately
  forged requests were both accepted, including writes. A local emulator run
  therefore proves request/response plumbing and byte integrity only — never
  that credentials are enforced. No caller may treat this provider as an
  authorisation boundary, in development or otherwise.
* **The SDK does not police the transport.** ``require_https`` is accepted by
  ``from_connection_string`` only as an ignored ``**kwargs`` entry — the string
  appears nowhere in the installed ``azure-storage-blob``/``azure-core``
  packages, and an ``http://`` endpoint built a working client with the flag
  left off. So the HTTPS rule below is enforced by this class, and a deployment
  that assumes the SDK does it silently gets a plaintext account key.
"""

from __future__ import annotations

import re
from typing import Any

from azure.core.exceptions import (
    AzureError,
    HttpResponseError,
    ResourceExistsError,
    ResourceNotFoundError,
    ServiceRequestError,
)
from azure.storage.blob import BlobClient, BlobServiceClient, ContentSettings

from app.services.storage.base import (
    ObjectAlreadyExistsError,
    ObjectMetadata,
    ObjectNotFoundError,
    ObjectStorage,
    StorageConfigError,
    StorageUnavailableError,
    validate_container_name,
    validate_object_key,
)

#: Redact anything credential-shaped before an SDK message reaches a caller. The
#: transport puts the account key in an Authorization *header*, never in a URL,
#: but a connection string can appear verbatim in a constructor error and a
#: future SDK could quote a query string carrying a SAS token.
_KEY_ASSIGNMENT = re.compile(r"(?i)\b(accountkey|sas|sig|sr|sk)\s*=\s*[^&\s'\"]+")
_SHARED_KEY = re.compile(r"(?i)sharedkey\s+\S+:\S+")
_MAX_MESSAGE_LENGTH = 300


def _safe_message(value: object) -> str:
    """Return a single-line, credential-free rendering of an SDK error."""
    text = _KEY_ASSIGNMENT.sub(r"\1=<redacted>", str(value))
    text = " ".join(_SHARED_KEY.sub("SharedKey <redacted>", text).split())
    return text if len(text) <= _MAX_MESSAGE_LENGTH else text[:_MAX_MESSAGE_LENGTH] + "…"


def _metadata(key: str, props: Any) -> ObjectMetadata:
    settings = props.content_settings
    return ObjectMetadata(
        key=key,
        size_bytes=int(props.size or 0),
        content_type=settings.content_type if settings else None,
        etag=props.etag,
        last_modified=props.last_modified,
    )


class AzureBlobStorage(ObjectStorage):
    """``ObjectStorage`` backed by one Azure (or Floci) blob container."""

    provider_name = "azure_blob"

    def __init__(
        self,
        *,
        connection_string: str,
        container: str,
        allow_http: bool = False,
        timeout_seconds: int = 30,
    ) -> None:
        if not connection_string.strip():
            raise StorageConfigError(
                "AZURE_STORAGE_CONNECTION_STRING is required when STORAGE_PROVIDER=azure_blob"
            )
        validate_container_name(container)
        if timeout_seconds < 1:
            raise StorageConfigError("storage timeout must be at least one second")

        self._container_name = container
        self._timeout_seconds = timeout_seconds
        try:
            # No ``require_https``: the SDK swallows it (see the module
            # docstring), so passing it would advertise a guarantee that no
            # longer exists, and the transport check below is the real one.
            self._service = BlobServiceClient.from_connection_string(connection_string)
        except (AttributeError, TypeError, ValueError) as cause:
            # The SDK parses the connection string, so a malformed one surfaces
            # here. The input is never echoed: it is a credential.
            raise StorageConfigError(
                f"AZURE_STORAGE_CONNECTION_STRING could not be parsed ({type(cause).__name__})"
            ) from cause

        # ``primary_endpoint`` is where the SDK actually resolved the account
        # to, which is the only thing worth checking — a connection string can
        # carry ``DefaultEndpointsProtocol`` and an explicit ``BlobEndpoint``
        # that disagree.
        endpoint = (self._service.primary_endpoint or "").lower()
        if not allow_http and not endpoint.startswith("https://"):
            raise StorageConfigError(
                "the blob endpoint is not HTTPS, which would send the account key over a "
                "plaintext transport; set AZURE_STORAGE_ALLOW_HTTP=true only for a loopback "
                "emulator"
            )
        self._container = self._service.get_container_client(container)

    @classmethod
    def from_connection_string(cls, connection_string: str, container: str) -> AzureBlobStorage:
        """Build a provider from an explicit pair, for scripts and integration tests.

        Deliberately not used by the application factory, which reads settings.
        """
        return cls(connection_string=connection_string, container=container)

    # -- ObjectStorage ------------------------------------------------------

    def put(
        self, key: str, data: bytes, *, content_type: str | None = None, overwrite: bool = False
    ) -> ObjectMetadata:
        validate_object_key(key)
        if not isinstance(data, (bytes, bytearray)):
            raise StorageConfigError("object data must be bytes")
        blob = self._blob(key)
        settings = ContentSettings(content_type=content_type) if content_type else None
        try:
            result = blob.upload_blob(
                bytes(data),
                overwrite=overwrite,
                content_settings=settings,
                timeout=self._timeout_seconds,
            )
        except ResourceExistsError as cause:
            raise ObjectAlreadyExistsError(key) from cause
        except AzureError as cause:
            raise self._translate(key, cause) from cause
        return ObjectMetadata(
            key=key,
            size_bytes=len(data),
            content_type=content_type,
            etag=getattr(result, "etag", None),
            last_modified=None,
        )

    def get(self, key: str) -> bytes:
        validate_object_key(key)
        try:
            return self._container.download_blob(key, timeout=self._timeout_seconds).readall()
        except ResourceNotFoundError as cause:
            raise ObjectNotFoundError(key) from cause
        except AzureError as cause:
            raise self._translate(key, cause) from cause

    def exists(self, key: str) -> bool:
        validate_object_key(key)
        try:
            return bool(self._blob(key).exists())
        except AzureError as cause:
            raise self._translate(key, cause) from cause

    def stat(self, key: str) -> ObjectMetadata:
        validate_object_key(key)
        try:
            props = self._blob(key).get_blob_properties(timeout=self._timeout_seconds)
        except ResourceNotFoundError as cause:
            raise ObjectNotFoundError(key) from cause
        except AzureError as cause:
            raise self._translate(key, cause) from cause
        return _metadata(key, props)

    def delete(self, key: str) -> None:
        validate_object_key(key)
        try:
            self._blob(key).delete_blob(timeout=self._timeout_seconds)
        except ResourceNotFoundError:
            # Idempotent by contract: an absent object is already deleted.
            return
        except AzureError as cause:
            raise self._translate(key, cause) from cause

    def ensure_container(self) -> None:
        try:
            if not self._container.exists():
                self._container.create_container(timeout=self._timeout_seconds)
        except ResourceExistsError:
            return
        except AzureError as cause:
            raise StorageUnavailableError(
                f"could not ensure container {self._container_name!r}: {_safe_message(cause)}"
            ) from cause

    # -- internals ----------------------------------------------------------

    def _blob(self, key: str) -> BlobClient:
        return self._container.get_blob_client(key)

    def _translate(self, key: str, cause: AzureError) -> Exception:
        """Map an SDK failure onto the provider-neutral taxonomy.

        ``ResourceNotFoundError`` is handled by each caller because "absent"
        means something different per operation; anything left here is either a
        404 the SDK did not type, an unreachable endpoint, or a server error —
        and all three must be distinguishable from a bad configuration.
        """
        status = getattr(cause, "status_code", None)
        reason = _safe_message(cause)
        if status == 404 or isinstance(cause, ResourceNotFoundError):
            return ObjectNotFoundError(key)
        if isinstance(cause, ServiceRequestError):
            return StorageUnavailableError(f"storage endpoint unreachable for {key!r}: {reason}")
        if isinstance(cause, HttpResponseError):
            return StorageUnavailableError(f"storage operation failed for {key!r}: {reason}")
        return StorageUnavailableError(f"storage error for {key!r}: {reason}")
