"""Object-storage providers available to DataDiet.

The factory is the only place that turns configuration into a provider, so a
caller never has to know which SDK a given ``STORAGE_PROVIDER`` value pulls in.
It returns ``None`` when storage is unconfigured rather than a no-op object:
"no storage" must be an absence the type system carries, not a client that
silently succeeds and stores nothing.

Nothing in the product consumes this package yet — DataDiet stores metadata
only, and the archive/retrieval tables that describe a provider are still
dormant placeholders. The boundary and its tests land first so that the
workflow decision can be reviewed independently of the transport.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

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

if TYPE_CHECKING:
    from app.core.config import Settings

__all__ = [
    "ObjectAlreadyExistsError",
    "ObjectMetadata",
    "ObjectNotFoundError",
    "ObjectStorage",
    "StorageConfigError",
    "StorageUnavailableError",
    "build_object_store",
    "validate_container_name",
    "validate_object_key",
]

#: The provider names this factory implements, kept beside the branch that uses
#: them so an unhandled addition is visible rather than silent.
_IMPLEMENTED = ("azure_blob",)


def build_object_store(settings: Settings | None = None) -> ObjectStorage | None:
    """Return the configured provider, or ``None`` when storage is switched off.

    Raises ``StorageConfigError`` for a configuration that cannot produce a
    working client, so a mis-deployed storage setting is a clear operator error
    rather than a mysterious failure at the first write.
    """
    if settings is None:
        from app.core.config import get_settings

        settings = get_settings()

    provider = settings.storage_provider
    if provider == "none":
        return None
    if provider not in _IMPLEMENTED:
        # Reachable the day a name is added to Settings without a branch here.
        # Refusing loudly beats handing back None and quietly storing nothing.
        raise StorageConfigError(f"STORAGE_PROVIDER={provider!r} has no implementation")

    # Imported here so that the default, storage-free deployment never loads the
    # Azure SDK — the dependency is only paid for when it is actually used.
    from app.services.storage.azure_blob import AzureBlobStorage

    return AzureBlobStorage(
        connection_string=settings.azure_storage_connection_string,
        container=settings.azure_storage_container,
        allow_http=settings.azure_storage_allow_http,
        timeout_seconds=settings.azure_storage_timeout_seconds,
    )
