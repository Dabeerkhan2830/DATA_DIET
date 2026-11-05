"""Local-folder source connector with strict, root-boundary enforcement.

Safety properties (all tested):

- The scan root is resolved once; every discovered path is resolved and must
  remain inside that root. Traversal (``..``) and symlink escapes are rejected.
- Symlinks are **never** followed. A symlinked file is reported as a skipped
  error; a symlinked directory is never descended into.
- File *contents* are never read. Only metadata (name, size, timestamps) is
  reported, so no checksum is computed by default.
- Only directories configured in the server-side allow-list can ever be used;
  the connector receives an already-approved absolute path, never one supplied
  by a client. Absolute paths are never echoed into results or errors.
"""

from __future__ import annotations

import mimetypes
import os
import stat
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

from .base import (
    ConnectorError,
    DiscoveredRecord,
    DiscoveryBatch,
    DiscoveryError,
    PathTraversalError,
    SourceConnector,
)


class LocalFolderConnector(SourceConnector):
    """Discover metadata from one allow-listed local directory tree."""

    def __init__(self, *, root_path: str, follow_symlinks: bool = False) -> None:
        if follow_symlinks:
            raise ConnectorError("Following symlinks is not permitted for local sources")
        self._root = Path(root_path).expanduser().resolve(strict=False)

    @property
    def root(self) -> Path:
        return self._root

    def validate(self) -> None:
        if not self._root.exists():
            raise ConnectorError("Configured source root does not exist")
        if not self._root.is_dir():
            raise ConnectorError("Configured source root is not a directory")

    def check_access(self) -> None:
        self.validate()
        if not os.access(self._root, os.R_OK | os.X_OK):
            raise ConnectorError("Configured source root is not readable")

    def iter_batches(self, *, batch_size: int) -> Iterator[DiscoveryBatch]:
        self.check_access()
        size = max(1, batch_size)
        records: list[DiscoveredRecord] = []
        errors: list[DiscoveryError] = []

        for current_dir, dir_names, file_names in os.walk(self._root, followlinks=False):
            current = Path(current_dir)
            # Never descend into a symlink or other directory link (e.g. a
            # Windows junction) that resolves outside the root.
            retained_dirs: list[str] = []
            for dir_name in dir_names:
                candidate = current / dir_name
                if candidate.is_symlink() or not self._resolves_inside(candidate):
                    errors.append(
                        DiscoveryError(
                            message="Directory link was not followed",
                            path=self._relative(candidate),
                            severity="warning",
                        )
                    )
                    continue
                retained_dirs.append(dir_name)
            dir_names[:] = retained_dirs

            for file_name in sorted(file_names):
                candidate = current / file_name
                try:
                    records.append(self._describe(candidate))
                except PathTraversalError as exc:
                    errors.append(
                        DiscoveryError(message=str(exc), path=self._relative(candidate))
                    )
                except OSError as exc:
                    errors.append(
                        DiscoveryError(
                            message=_describe_oserror(exc),
                            path=self._relative(candidate),
                        )
                    )

                if len(records) >= size:
                    yield DiscoveryBatch(records=tuple(records), errors=tuple(errors))
                    records = []
                    errors = []

        if records or errors:
            yield DiscoveryBatch(records=tuple(records), errors=tuple(errors))

    # -- internals -----------------------------------------------------------

    def _relative(self, path: Path) -> str:
        try:
            return path.relative_to(self._root).as_posix()
        except ValueError:
            # Outside the root: never echo an absolute path back.
            return path.name

    def _resolves_inside(self, candidate: Path) -> bool:
        """True when ``candidate`` resolves to a real path inside the root.

        Catches symlinks and other directory links (Windows junctions) that
        would otherwise let discovery walk outside the configured root.
        """
        try:
            resolved = candidate.resolve(strict=True)
        except OSError:
            return False
        return resolved != self._root and resolved.is_relative_to(self._root)

    def _describe(self, candidate: Path) -> DiscoveredRecord:
        if candidate.is_symlink():
            raise PathTraversalError("Symlink was not followed")

        resolved = candidate.resolve(strict=True)
        if not resolved.is_relative_to(self._root):
            raise PathTraversalError("Resolved path escaped the configured root")

        info = os.stat(resolved)
        if not stat.S_ISREG(info.st_mode):
            raise PathTraversalError("Only regular files are discovered")

        relative = resolved.relative_to(self._root).as_posix()
        mime_type, _ = mimetypes.guess_type(candidate.name)
        return DiscoveredRecord(
            source_key=relative,
            title=candidate.name,
            record_type=_record_type(candidate.name),
            category="file",
            file_name=candidate.name,
            mime_type=mime_type,
            size_bytes=info.st_size,
            checksum_sha256=None,  # contents are never read
            sensitivity="unknown",  # no content inspection
            contains_personal_data=False,
            source_created_at=_to_utc(info.st_ctime),
            source_modified_at=_to_utc(info.st_mtime),
            raw_metadata={"relative_path": relative},
        )


def _record_type(file_name: str) -> str:
    suffix = file_name.rsplit(".", 1)
    if len(suffix) == 2 and suffix[1]:
        return suffix[1].lower()[:100]
    return "file"


def _to_utc(timestamp: float) -> datetime:
    """Convert an epoch timestamp to a naive UTC datetime (DB-friendly)."""
    return datetime.fromtimestamp(timestamp, tz=UTC).replace(tzinfo=None)


def _describe_oserror(exc: OSError) -> str:
    """Map an OS error to a message that never leaks an absolute path."""
    if isinstance(exc, PermissionError):
        return "Permission denied while reading metadata"
    if isinstance(exc, FileNotFoundError):
        return "Path disappeared during the scan"
    return "Could not read file metadata"
