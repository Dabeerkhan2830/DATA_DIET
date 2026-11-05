"""Deterministic synthetic source connector.

Used by tests and by the demo environment. Every identifier carries the
``SYNTH-`` prefix and the metadata is generated from the record index, so the
output is fully reproducible and never contains real identities.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from datetime import UTC, datetime, timedelta

from .base import ConnectorError, DiscoveredRecord, DiscoveryBatch, SourceConnector

#: Fixed epoch so synthetic records are identical across runs and machines.
_BASE_TIMESTAMP = datetime(2025, 1, 1, tzinfo=UTC)

_DEFAULT_CATEGORIES = ["academic_records", "administrative", "research_data"]
_DEFAULT_SENSITIVITIES = ["internal", "confidential", "restricted"]
_DEFAULT_RECORD_TYPES = ["document", "dataset", "record"]

#: Hard ceiling on a synthetic catalogue; keeps a misconfigured source bounded.
_MAX_COUNT = 100_000


class SyntheticConnector(SourceConnector):
    """Deterministic, clearly-labeled synthetic metadata source."""

    def __init__(
        self,
        *,
        config: Mapping[str, object] | None = None,
        source_name: str = "synthetic",
    ) -> None:
        cfg = dict(config or {})
        self._count = int(cfg.get("count", 25))  # type: ignore[arg-type]
        self._categories = _string_list(cfg.get("categories"), _DEFAULT_CATEGORIES)
        self._sensitivities = _string_list(cfg.get("sensitivity_levels"), _DEFAULT_SENSITIVITIES)
        self._record_types = _string_list(cfg.get("record_types"), _DEFAULT_RECORD_TYPES)
        self._source_name = (source_name or "synthetic").strip() or "synthetic"

    def validate(self) -> None:
        if self._count < 0:
            raise ConnectorError("Synthetic source count must be >= 0")
        if self._count > _MAX_COUNT:
            raise ConnectorError(f"Synthetic source count must be <= {_MAX_COUNT}")

    def check_access(self) -> None:
        # A synthetic source is always available; nothing external is touched.
        self.validate()

    def iter_batches(self, *, batch_size: int) -> Iterator[DiscoveryBatch]:
        self.validate()
        size = max(1, batch_size)
        records: list[DiscoveredRecord] = []
        for index in range(1, self._count + 1):
            records.append(self._build_record(index))
            if len(records) >= size:
                yield DiscoveryBatch(records=tuple(records))
                records = []
        if records:
            yield DiscoveryBatch(records=tuple(records))

    def _build_record(self, index: int) -> DiscoveredRecord:
        category = self._categories[(index - 1) % len(self._categories)]
        sensitivity = self._sensitivities[(index - 1) % len(self._sensitivities)]
        record_type = self._record_types[(index - 1) % len(self._record_types)]
        created_at = _BASE_TIMESTAMP + timedelta(days=index)
        modified_at = created_at + timedelta(hours=index % 24)
        slug = self._source_name.upper().replace(" ", "-")
        return DiscoveredRecord(
            source_key=f"SYNTH-{slug}-{index:04d}",
            title=f"Synthetic {record_type} {index:04d}",
            record_type=record_type,
            category=category,
            file_name=f"SYNTH-{slug}-{index:04d}.txt",
            mime_type="text/plain",
            size_bytes=1024 + index * 16,
            checksum_sha256=None,
            sensitivity=sensitivity,
            contains_personal_data=sensitivity in {"confidential", "restricted"},
            source_created_at=created_at,
            source_modified_at=modified_at,
            raw_metadata={"synthetic": True, "index": index},
        )


def _string_list(value: object, fallback: list[str]) -> list[str]:
    if isinstance(value, (list, tuple)) and value:
        items = [str(item) for item in value if str(item).strip()]
        if items:
            return items
    return list(fallback)
