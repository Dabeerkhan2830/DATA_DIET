"""Source connector abstractions and implementations (Phase 4)."""

from .base import (
    ConnectorError,
    DiscoveredRecord,
    DiscoveryBatch,
    DiscoveryError,
    PathTraversalError,
    SourceConnector,
    UnauthorizedRootError,
)
from .local_folder import LocalFolderConnector
from .synthetic import SyntheticConnector

__all__ = [
    "ConnectorError",
    "DiscoveredRecord",
    "DiscoveryBatch",
    "DiscoveryError",
    "LocalFolderConnector",
    "PathTraversalError",
    "SourceConnector",
    "SyntheticConnector",
    "UnauthorizedRootError",
]
