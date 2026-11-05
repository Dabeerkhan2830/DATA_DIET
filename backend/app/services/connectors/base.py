"""Provider-neutral source connector abstractions (Phase 4).

A connector's only job is to *discover metadata* from a configured source and
return it in normalised, bounded batches. Connectors deliberately have no
capability to read file contents, move, archive, or delete anything, or send
data anywhere. Every implementation must honour that contract.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime


class ConnectorError(Exception):
    """Base class for a connector failure (invalid config or unreachable source)."""


class UnauthorizedRootError(ConnectorError):
    """A local-folder source referenced a root that is not allow-listed."""


class PathTraversalError(ConnectorError):
    """A resolved path escaped the configured root (traversal or symlink escape)."""


@dataclass(frozen=True, slots=True)
class DiscoveredRecord:
    """Normalized metadata for one discovered source record.

    This is a *metadata* snapshot only; connectors never read record contents.
    """

    source_key: str
    title: str
    record_type: str
    category: str | None = None
    file_name: str | None = None
    mime_type: str | None = None
    size_bytes: int = 0
    checksum_sha256: str | None = None
    sensitivity: str = "unknown"
    contains_personal_data: bool = False
    source_created_at: datetime | None = None
    source_modified_at: datetime | None = None
    raw_metadata: dict[str, object] | None = None


@dataclass(frozen=True, slots=True)
class DiscoveryError:
    """A per-record or per-path problem encountered while discovering.

    ``path`` is always *relative* to the configured root so no absolute server
    path is ever persisted or returned.
    """

    message: str
    source_key: str | None = None
    path: str | None = None
    severity: str = "error"


@dataclass(frozen=True, slots=True)
class DiscoveryBatch:
    """One bounded page of discovery output."""

    records: tuple[DiscoveredRecord, ...] = ()
    errors: tuple[DiscoveryError, ...] = ()


class SourceConnector(ABC):
    """Abstract, provider-neutral connector interface."""

    @abstractmethod
    def validate(self) -> None:
        """Raise :class:`ConnectorError` if the configuration is invalid."""

    @abstractmethod
    def check_access(self) -> None:
        """Raise :class:`ConnectorError` if the source cannot be reached."""

    @abstractmethod
    def iter_batches(self, *, batch_size: int) -> Iterator[DiscoveryBatch]:
        """Yield discovery output in bounded batches until the source is exhausted."""
