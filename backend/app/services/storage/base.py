"""Provider-neutral object storage boundary.

DataDiet is a *metadata* application: discovery connectors deliberately cannot
read file contents (see ``app.services.connectors.base``), so nothing in the
product today stores or serves a blob. This package therefore defines the
boundary only — it exists so that a future archive/retrieval workflow can write
against one interface instead of an SDK, and so the interface itself can be
reviewed and tested before any workflow depends on it.

Operations are limited to what the dormant ``ArchiveItem`` / ``RetrievalRequest``
manifest implies: store, fetch, delete, test for existence, read metadata.
There is no listing, prefix, copy, or lifecycle operation here because no
DataDiet workflow would use one, and an unused method is an untested method.

Failure taxonomy is intentionally narrow, because callers must be able to
distinguish "the object is not there" from "storage is not usable" from
"the deployment is misconfigured" without importing an SDK exception type.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime

#: Azure container names and object-key rules are stricter than a filesystem's,
#: so keys are validated before they reach any provider. A key must never be
#: able to express a path traversal, an absolute path, or a control character.
_MAX_KEY_LENGTH = 1024
_INVALID_KEY_SEGMENTS = frozenset({"", ".", ".."})
_UNSAFE_KEY_CHARS = re.compile(r"[\x00-\x1f\x7f\\]")
#: ``AzStorage``-legal enough: printable, no backslash, no leading/trailing space.
_CONTAINER_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$")


class StorageConfigError(Exception):
    """The storage configuration is unusable.

    Messages must never repeat a connection string, key, or SAS value; they
    carry only the setting *name* that is wrong.
    """


class StorageUnavailableError(Exception):
    """A configured provider could not complete an operation.

    Raised for transport, authentication, and server-side failures alike: a
    caller must not need to know which SDK produced the failure.
    """


class ObjectNotFoundError(Exception):
    """The addressed object (or its container) does not exist."""


class ObjectAlreadyExistsError(Exception):
    """``put(overwrite=False)`` met an existing object.

    Separate from ``StorageUnavailableError`` because the caller's correct
    response is a decision, not a retry: keep the existing bytes, or re-key.
    """


@dataclass(frozen=True)
class ObjectMetadata:
    """What a provider reports about one stored object.

    ``etag`` is opaque and provider-specific — it is recorded for correlation,
    never interpreted. ``content_type`` is the value the provider holds, which
    may be the one supplied at write time or a provider default.
    """

    key: str
    size_bytes: int
    content_type: str | None
    etag: str | None
    last_modified: datetime | None


def validate_object_key(key: str) -> str:
    """Return ``key`` if it is safe to address, else raise ``StorageConfigError``.

    Keys are namespaced flat strings (``archive/1234/abc.pdf``), not filesystem
    paths: DataDiet never accepts or stores an absolute path, and an object key
    that could contain ``..`` or a backslash would let a future caller smuggle a
    traversal through an otherwise trusted record.
    """
    if not key:
        raise StorageConfigError("object key must not be empty")
    if len(key) > _MAX_KEY_LENGTH:
        raise StorageConfigError(f"object key must not exceed {_MAX_KEY_LENGTH} characters")
    if _UNSAFE_KEY_CHARS.search(key):
        raise StorageConfigError("object key must not contain control characters or a backslash")
    if key.startswith("/") or key.endswith("/"):
        raise StorageConfigError("object key must not start or end with '/'")
    if any(part in _INVALID_KEY_SEGMENTS for part in key.split("/")):
        raise StorageConfigError("object key must not contain empty, '.' or '..' segments")
    return key


def validate_container_name(name: str) -> str:
    """Return ``name`` if it is a valid Azure container name, else raise."""
    if not _CONTAINER_NAME.match(name):
        raise StorageConfigError(
            "AZURE_STORAGE_CONTAINER must be 3-63 lowercase letters, digits or "
            "dashes, starting and ending with a letter or digit"
        )
    return name


class ObjectStorage(ABC):
    """The only object-storage interface DataDiet code may depend on.

    Implementations are synchronous, matching the rest of the backend: scans run
    inside the request thread (``app.api.routes.connectors.run_scan``) and no
    worker exists. A provider therefore blocks the calling request, which is
    why every operation carries a timeout at the transport layer.
    """

    #: Recorded in ``ArchiveItem.storage_provider`` style identifiers; stable and
    #: short because it becomes data, not just a log word.
    provider_name: str

    @abstractmethod
    def put(
        self, key: str, data: bytes, *, content_type: str | None = None, overwrite: bool = False
    ) -> ObjectMetadata:
        """Store ``data`` under ``key`` and return its metadata.

        ``overwrite=False`` must fail rather than replace an existing object:
        an archive manifest is append-only evidence, and a silent replacement
        would destroy the record it points at.
        """

    @abstractmethod
    def get(self, key: str) -> bytes:
        """Return the full object body, or raise ``ObjectNotFoundError``."""

    @abstractmethod
    def delete(self, key: str) -> None:
        """Remove the object. Absent is not an error: delete is idempotent."""

    @abstractmethod
    def exists(self, key: str) -> bool:
        """Whether the object is addressable right now."""

    @abstractmethod
    def stat(self, key: str) -> ObjectMetadata:
        """Return metadata without transferring the body."""

    def ensure_container(self) -> None:
        """Create the configured container if it does not already exist.

        Optional by design: a deployment may pre-provision the container, and a
        prototype that cannot create one is still useful for reads.
        """
        raise NotImplementedError(f"{self.provider_name} does not support container provisioning")
