"""Deterministic, explainable data-quality analysis over inventoried metadata.

Phase 5. Findings are computed from metadata that already exists on
:class:`~app.db.models.InventoryRecord`; nothing here opens a file, calls an
external service, merges assets, or writes to the database. The caller decides
what to do with a finding.

Two distinctions matter and are enforced by the tests:

* A **possible duplicate** is two assets that share safe metadata (name+size or
  title+size). It is a hint at ``medium`` severity.
* A **confirmed duplicate** additionally requires equal non-null content
  checksums and equal sizes, at ``high`` severity. Even then ``duplicate_of_id``
  is never written by this module - de-duplication needs a separate, reviewed
  decision.

Missing metadata never lowers risk: an asset with no sensitivity is reported as
unclassified, never as public (see :mod:`app.services.classification`).

Findings are computed on demand from the current inventory rather than stored,
so a listing can never drift from the assets it describes (ADR-0011).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.db.models import ClassificationResult, InventoryRecord, SourceRecordMapping

#: Severity levels, least to most urgent.
SEVERITY_ORDER: tuple[str, ...] = ("info", "low", "medium", "high")

#: How old a source observation may be before it is reported as stale.
STALE_AFTER_DAYS = 365

#: File extensions the application can reason about at all. Anything else is
#: missing evidence, never evidence of safety.
KNOWN_EXTENSIONS: frozenset[str] = frozenset(
    {
        "bat", "cfg", "csv", "db", "doc", "docx", "gif", "gz", "html", "ini",
        "jpeg", "jpg", "json", "log", "md", "mp4", "odt", "parquet", "pdf",
        "png", "ppt", "pptx", "py", "rtf", "sh", "sql", "sqlite", "tar", "tsv",
        "txt", "wav", "xls", "xlsx", "xml", "yaml", "yml", "zip",
    }
)

#: Sensitivity levels the application recognises; anything else is invalid.
KNOWN_SENSITIVITY_LEVELS: frozenset[str] = frozenset(
    {"public", "internal", "confidential", "restricted", "unknown"}
)

#: Recommended category vocabulary (advisory, not a hard enum).
KNOWN_CATEGORIES: frozenset[str] = frozenset(
    {
        "academic_records",
        "administrative",
        "archives",
        "communications",
        "contact_list",
        "datasets",
        "documents",
        "finance",
        "hr",
        "images",
        "logs",
        "research_data",
        "source_code",
        "student_records",
    }
)


@dataclass(frozen=True)
class QualityFinding:
    """One structured, explainable data-quality finding."""

    asset_id: int
    check: str
    severity: str
    message: str
    fields: tuple[str, ...]
    evidence: dict[str, object]
    remediation: str
    duplicate_status: str | None = None
    related_asset_id: int | None = None

    @property
    def severity_rank(self) -> int:
        return SEVERITY_ORDER.index(self.severity) if self.severity in SEVERITY_ORDER else -1

    def as_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "asset_id": self.asset_id,
            "check": self.check,
            "severity": self.severity,
            "message": self.message,
            "fields": list(self.fields),
            "evidence": self.evidence,
            "remediation": self.remediation,
        }
        if self.duplicate_status is not None:
            payload["duplicate_status"] = self.duplicate_status
        if self.related_asset_id is not None:
            payload["related_asset_id"] = self.related_asset_id
        return payload


@dataclass(frozen=True)
class CheckDescriptor:
    """Public metadata for one quality check."""

    check: str
    severity: str
    description: str
    remediation: str


#: Documented check table, served by ``GET /api/v1/classification/checks``.
CHECKS: tuple[CheckDescriptor, ...] = (
    CheckDescriptor(
        "missing-required-metadata",
        "medium",
        "A required inventory field is blank (title, record_type, external_id) "
        "or file metadata (file_name, mime_type) is absent.",
        "Complete the missing metadata from the source system. Missing metadata "
        "is never treated as evidence of low sensitivity.",
    ),
    CheckDescriptor(
        "invalid-extension",
        "low",
        "The file name carries no extension or an extension outside the "
        "recognised set.",
        "Confirm the file type from the source. Extension metadata never proves "
        "file contents.",
    ),
    CheckDescriptor(
        "invalid-category-value",
        "low",
        "The configured category is outside the recommended vocabulary.",
        "Review the category; this is an advisory vocabulary warning.",
    ),
    CheckDescriptor(
        "invalid-sensitivity-value",
        "high",
        "The configured sensitivity is not one of the recognised levels.",
        "Correct the sensitivity; unrecognised values are never treated as low risk.",
    ),
    CheckDescriptor(
        "conflicting-sensitivity",
        "high",
        "The record is flagged as containing personal data but is configured as "
        "public.",
        "Personal data is at least confidential. Any change needs human approval; "
        "classification only proposes.",
    ),
    CheckDescriptor(
        "invalid-classification-evidence",
        "medium",
        "The latest classification result contains unresolved conflicts or an "
        "unsupported value.",
        "Resolve the conflicting metadata, then re-run classification.",
    ),
    CheckDescriptor(
        "possible-duplicate",
        "medium",
        "Two assets share a safe metadata key (file name + size, or title + "
        "size) but no confirmed checksum.",
        "A human must confirm whether these are the same data; nothing is merged.",
    ),
    CheckDescriptor(
        "confirmed-duplicate",
        "high",
        "Two assets share a non-null content checksum and size.",
        "Confirm whether one copy is redundant; de-duplication needs a separate "
        "reviewed decision.",
    ),
    CheckDescriptor(
        "stale-observation",
        "low",
        "The source modification timestamp is older than the staleness threshold.",
        "Re-scan the source to refresh the observation.",
    ),
    CheckDescriptor(
        "inconsistent-source-mapping",
        "medium",
        "The asset's source-record mapping disagrees with the asset's source, "
        "source key, checksum, or linked asset.",
        "Investigate the mapping; do not delete either record automatically.",
    ),
    CheckDescriptor(
        "unmapped-source-record",
        "info",
        "The asset has no source-record mapping, so it was not produced by a "
        "connector scan (or the mapping is absent).",
        "Confirm the asset's origin. This is informational, not an error.",
    ),
    CheckDescriptor(
        "unclassified",
        "info",
        "The asset has no classification result, or its latest result is "
        "unclassified because metadata was insufficient.",
        "Run classification once the metadata is complete; unassessed is not "
        "low risk.",
    ),
)


def check_descriptor(check: str) -> CheckDescriptor | None:
    for descriptor in CHECKS:
        if descriptor.check == check:
            return descriptor
    return None


# --------------------------------------------------------------------------
# single-asset analysis (pure)
# --------------------------------------------------------------------------


def _blank(value: object) -> bool:
    return value is None or not str(value).strip()


def _extension(file_name: object) -> str | None:
    name = str(file_name or "").strip().lower()
    if "." not in name:
        return None
    ext = name.rsplit(".", 1)[-1]
    return ext or None


def _finding(
    asset_id: int,
    check: str,
    *,
    severity: str,
    message: str,
    fields: Sequence[str],
    evidence: dict[str, object],
    remediation: str,
    duplicate_status: str | None = None,
    related_asset_id: int | None = None,
) -> QualityFinding:
    return QualityFinding(
        asset_id=asset_id,
        check=check,
        severity=severity,
        message=message,
        fields=tuple(fields),
        evidence=evidence,
        remediation=remediation,
        duplicate_status=duplicate_status,
        related_asset_id=related_asset_id,
    )


def _duplicate_pair(asset: object, peer: object) -> tuple[str, str] | None:
    """Return ``(status, matched_on)`` when two assets look like duplicates.

    ``status`` is ``confirmed`` only when both assets carry a non-null content
    checksum and the checksums are equal. Otherwise the match is ``possible``.
    """
    size_a = int(getattr(asset, "size_bytes", 0) or 0)
    size_b = int(getattr(peer, "size_bytes", 0) or 0)
    if size_a <= 0 or size_a != size_b:
        return None

    title_a = str(getattr(asset, "title", "") or "").strip().lower()
    title_b = str(getattr(peer, "title", "") or "").strip().lower()
    name_a = str(getattr(asset, "file_name", "") or "").strip().lower()
    name_b = str(getattr(peer, "file_name", "") or "").strip().lower()

    if name_a and name_a == name_b:
        matched_on = "file name and size"
    elif title_a and title_a == title_b:
        matched_on = "title and size"
    else:
        return None

    checksum_a = getattr(asset, "checksum_sha256", None)
    checksum_b = getattr(peer, "checksum_sha256", None)
    if checksum_a and checksum_b and checksum_a == checksum_b:
        return "confirmed", matched_on
    return "possible", matched_on


def _duplicate_finding(
    asset: object,
    peer: object,
    *,
    status: str,
    matched_on: str,
) -> QualityFinding:
    asset_id = int(asset.id)
    peer_id = int(peer.id)
    sizes = (
        int(getattr(asset, "size_bytes", 0) or 0),
        int(getattr(peer, "size_bytes", 0) or 0),
    )
    checksums = (
        getattr(asset, "checksum_sha256", None),
        getattr(peer, "checksum_sha256", None),
    )
    if status == "confirmed":
        return _finding(
            asset_id,
            "confirmed-duplicate",
            severity="high",
            message=f"Shares a content checksum and size with asset {peer_id}.",
            fields=("checksum_sha256", "size_bytes"),
            evidence={
                "related_asset_id": peer_id,
                "matched_on": matched_on,
                "size_bytes": list(sizes),
                "checksum_sha256": list(checksums),
                "note": "Confirmed from checksum metadata only; content was not read.",
            },
            remediation=(
                "Confirm whether one copy is redundant. De-duplication is a "
                "separate, reviewed decision; nothing is merged automatically."
            ),
            duplicate_status="confirmed",
            related_asset_id=peer_id,
        )
    return _finding(
        asset_id,
        "possible-duplicate",
        severity="medium",
        message=f"Shares {matched_on} with asset {peer_id}; identity is not confirmed.",
        fields=("title", "file_name", "size_bytes"),
        evidence={
            "related_asset_id": peer_id,
            "matched_on": matched_on,
            "size_bytes": list(sizes),
            "checksum_sha256": list(checksums),
            "note": "Possible duplicate only: checksums are missing or differ.",
        },
        remediation=(
            "A human must confirm whether these are the same data. Nothing is "
            "merged automatically."
        ),
        duplicate_status="possible",
        related_asset_id=peer_id,
    )


def analyze_asset(
    asset: object,
    *,
    peers: Sequence[object] = (),
    mappings: Sequence[object] = (),
    latest_classification: object | None = None,
    now: datetime | None = None,
    stale_after_days: int = STALE_AFTER_DAYS,
) -> list[QualityFinding]:
    """Run every documented check for one asset and return its findings.

    Deterministic: given the same asset, peers, mappings, classification, and
    ``now`` the findings are identical, ordered by severity, then check, then
    related asset. No database is touched.
    """
    asset_id = int(asset.id)
    findings: list[QualityFinding] = []
    current = now or datetime.now(UTC).replace(tzinfo=None)

    # --- missing required metadata -----------------------------------------
    missing_required: list[str] = []
    if _blank(getattr(asset, "title", None)):
        missing_required.append("title")
    if _blank(getattr(asset, "record_type", None)):
        missing_required.append("record_type")
    if _blank(getattr(asset, "external_id", None)):
        missing_required.append("external_id")
    if missing_required:
        findings.append(
            _finding(
                asset_id,
                "missing-required-metadata",
                severity="high",
                message="Required metadata is missing: " + ", ".join(missing_required) + ".",
                fields=missing_required,
                evidence={"missing_fields": missing_required},
                remediation="Complete the missing metadata from the source system. "
                "Missing metadata is never treated as evidence of low sensitivity.",
            )
        )

    missing_file_metadata: list[str] = []
    if _blank(getattr(asset, "file_name", None)):
        missing_file_metadata.append("file_name")
    if _blank(getattr(asset, "mime_type", None)):
        missing_file_metadata.append("mime_type")
    if missing_file_metadata and not missing_required:
        findings.append(
            _finding(
                asset_id,
                "missing-required-metadata",
                severity="medium",
                message="File metadata is incomplete: " + ", ".join(missing_file_metadata) + ".",
                fields=missing_file_metadata,
                evidence={"missing_fields": missing_file_metadata},
                remediation="Record the file name and MIME type reported by the "
                "source. Missing metadata does not mean the asset is safe.",
            )
        )

    # --- extensions ----------------------------------------------------------
    file_name = getattr(asset, "file_name", None)
    ext = _extension(file_name)
    if not _blank(file_name):
        if ext is None:
            findings.append(
                _finding(
                    asset_id,
                    "invalid-extension",
                    severity="low",
                    message="The file name has no extension.",
                    fields=("file_name",),
                    evidence={"file_name": str(file_name), "extension": None},
                    remediation="Confirm the file type from the source; extension "
                    "metadata is a hint and never proves file contents.",
                )
            )
        elif ext not in KNOWN_EXTENSIONS:
            findings.append(
                _finding(
                    asset_id,
                    "invalid-extension",
                    severity="low",
                    message=f"Unrecognised file extension '.{ext}'.",
                    fields=("file_name",),
                    evidence={"file_name": str(file_name), "extension": ext},
                    remediation="Confirm the real file type. Unknown extensions are "
                    "missing evidence, not evidence of safety.",
                )
            )

    # --- configured values ---------------------------------------------------
    category = str(getattr(asset, "category", "") or "").strip()
    if category and category not in KNOWN_CATEGORIES:
        findings.append(
            _finding(
                asset_id,
                "invalid-category-value",
                severity="low",
                message=f"Category '{category}' is outside the recommended vocabulary.",
                fields=("category",),
                evidence={"category": category},
                remediation="Review the category value; this is advisory.",
            )
        )

    sensitivity = str(getattr(asset, "sensitivity", "") or "").strip()
    if sensitivity and sensitivity not in KNOWN_SENSITIVITY_LEVELS:
        findings.append(
            _finding(
                asset_id,
                "invalid-sensitivity-value",
                severity="high",
                message=f"Configured sensitivity '{sensitivity}' is not a recognised level.",
                fields=("sensitivity",),
                evidence={"sensitivity": sensitivity},
                remediation="Correct the sensitivity. An unrecognised value cannot be "
                "treated as low risk.",
            )
        )

    personal_data = bool(getattr(asset, "contains_personal_data", False))
    if personal_data and sensitivity == "public":
        findings.append(
            _finding(
                asset_id,
                "conflicting-sensitivity",
                severity="high",
                message="Flagged as containing personal data while configured as public.",
                fields=("contains_personal_data", "sensitivity"),
                evidence={"contains_personal_data": True, "sensitivity": "public"},
                remediation="Personal data is at least confidential. Any change needs "
                "human approval; classification only proposes.",
            )
        )

    # --- latest classification evidence --------------------------------------
    if latest_classification is None:
        findings.append(
            _finding(
                asset_id,
                "unclassified",
                severity="info",
                message="No classification result exists for this asset.",
                fields=("category", "sensitivity"),
                evidence={"classification_outcome": None},
                remediation="Run classification once metadata is complete. "
                "Unassessed is not low risk.",
            )
        )
    else:
        outcome = getattr(latest_classification, "outcome", None)
        conflicts = list(getattr(latest_classification, "conflicts", None) or [])
        if conflicts:
            findings.append(
                _finding(
                    asset_id,
                    "invalid-classification-evidence",
                    severity="medium",
                    message="The latest classification has unresolved conflicts.",
                    fields=("category", "sensitivity"),
                    evidence={
                        "conflicts": conflicts,
                        "rule_version": getattr(latest_classification, "rule_version", None),
                    },
                    remediation="Resolve the conflicting metadata, then re-run "
                    "classification.",
                )
            )
        if outcome == "unclassified":
            findings.append(
                _finding(
                    asset_id,
                    "unclassified",
                    severity="medium" if personal_data else "info",
                    message="The latest classification is unclassified: the metadata "
                    "was insufficient.",
                    fields=("category", "sensitivity"),
                    evidence={
                        "classification_outcome": outcome,
                        "confidence": getattr(latest_classification, "confidence", None),
                        "contains_personal_data": personal_data,
                        "warnings": list(getattr(latest_classification, "warnings", None) or []),
                    },
                    remediation="Complete the metadata and re-run classification. "
                    "Unclassified must not be read as public.",
                )
            )

    # --- duplicates -----------------------------------------------------------
    for peer in sorted(peers, key=lambda p: int(p.id)):
        peer_id = int(peer.id)
        if peer_id == asset_id:
            continue
        pair = _duplicate_pair(asset, peer)
        if pair is None:
            continue
        status, matched_on = pair
        findings.append(
            _duplicate_finding(asset, peer, status=status, matched_on=matched_on)
        )

    # --- stale observation ----------------------------------------------------
    modified = getattr(asset, "source_modified_at", None)
    if modified is not None:
        threshold = current - timedelta(days=STALE_AFTER_DAYS)
        if modified < threshold:
            findings.append(
                _finding(
                    asset_id,
                    "stale-observation",
                    severity="low",
                    message=f"Source observation is older than {STALE_AFTER_DAYS} days.",
                    fields=("source_modified_at",),
                    evidence={
                        "source_modified_at": str(modified),
                        "threshold_days": STALE_AFTER_DAYS,
                    },
                    remediation="Re-scan the source to refresh the observation.",
                )
            )

    # --- source mappings ------------------------------------------------------
    findings.extend(_mapping_findings(asset, mappings))

    findings.sort(key=lambda f: (-f.severity_rank, f.check, f.related_asset_id or 0))
    return findings


def _mapping_findings(asset: object, mappings: Sequence[object]) -> list[QualityFinding]:
    """Consistency checks between an asset and its source-record mappings."""
    asset_id = int(asset.id)
    asset_source_id = getattr(asset, "data_source_id", None)
    asset_key = getattr(asset, "external_id", None)
    asset_checksum = getattr(asset, "checksum_sha256", None)

    linked = [m for m in mappings if getattr(m, "asset_id", None) == asset_id]
    keyed = [
        m
        for m in mappings
        if getattr(m, "data_source_id", None) == asset_source_id
        and getattr(m, "source_key", None) == asset_key
    ]

    findings: list[QualityFinding] = []

    if not linked and not keyed:
        findings.append(
            _finding(
                asset_id,
                "unmapped-source-record",
                severity="info",
                message="No source-record mapping exists for this asset.",
                fields=("external_id",),
                evidence={"external_id": asset_key, "data_source_id": asset_source_id},
                remediation="Confirm the asset's origin. This is informational, not "
                "an error.",
            )
        )
        return findings

    inconsistent: list[dict[str, object]] = []
    for mapping in linked:
        if getattr(mapping, "data_source_id", None) != asset_source_id:
            inconsistent.append(
                {
                    "mapping_id": getattr(mapping, "id", None),
                    "reason": "mapping belongs to a different data source",
                    "mapping_data_source_id": getattr(mapping, "data_source_id", None),
                }
            )
        elif getattr(mapping, "source_key", None) != asset_key:
            inconsistent.append(
                {
                    "mapping_id": getattr(mapping, "id", None),
                    "reason": "mapping source key differs from the asset external_id",
                    "mapping_source_key": getattr(mapping, "source_key", None),
                }
            )
        elif (
            asset_checksum
            and getattr(mapping, "checksum_sha256", None)
            and getattr(mapping, "checksum_sha256", None) != asset_checksum
        ):
            inconsistent.append(
                {
                    "mapping_id": getattr(mapping, "id", None),
                    "reason": "mapping checksum differs from the asset checksum",
                    "mapping_checksum_sha256": getattr(mapping, "checksum_sha256", None),
                }
            )
    for mapping in keyed:
        target = getattr(mapping, "asset_id", None)
        if target not in (None, asset_id):
            inconsistent.append(
                {
                    "mapping_id": getattr(mapping, "id", None),
                    "reason": "the source key is linked to a different asset",
                    "linked_asset_id": target,
                }
            )

    if inconsistent:
        findings.append(
            _finding(
                asset_id,
                "inconsistent-source-mapping",
                severity="medium",
                message="The asset and its source-record mapping disagree.",
                fields=("external_id", "data_source_id", "checksum_sha256"),
                evidence={"inconsistencies": inconsistent},
                remediation="Investigate the mapping. Do not delete either record "
                "automatically.",
            )
        )
    return findings


# --------------------------------------------------------------------------
# database-backed listing (used by the API)
# --------------------------------------------------------------------------


def _load_classifications(
    db: Session, asset_ids: Sequence[int]
) -> dict[int, ClassificationResult]:
    """Latest classification result per asset id (single query)."""
    if not asset_ids:
        return {}
    latest = (
        select(func.max(ClassificationResult.id).label("max_id"))
        .where(ClassificationResult.asset_id.in_(list(asset_ids)))
        .group_by(ClassificationResult.asset_id)
        .subquery()
    )
    rows = (
        db.execute(
            select(ClassificationResult).join(
                latest, ClassificationResult.id == latest.c.max_id
            )
        )
        .scalars()
        .all()
    )
    return {row.asset_id: row for row in rows}


def _load_mappings(db: Session, assets: Sequence[InventoryRecord]) -> dict[int, list[object]]:
    """Mappings relevant to each asset: linked by asset_id or by (source, key)."""
    if not assets:
        return {}
    asset_ids = [a.id for a in assets]
    source_ids = sorted({a.data_source_id for a in assets})
    rows = (
        db.execute(
            select(SourceRecordMapping).where(
                or_(
                    SourceRecordMapping.asset_id.in_(asset_ids),
                    SourceRecordMapping.data_source_id.in_(source_ids),
                )
            )
        )
        .scalars()
        .all()
    )
    by_asset: dict[int, list[object]] = {}
    for asset in assets:
        relevant = [
            row
            for row in rows
            if getattr(row, "asset_id", None) == asset.id
            or (
                row.data_source_id == asset.data_source_id
                and row.source_key == asset.external_id
            )
        ]
        if relevant:
            by_asset[asset.id] = relevant
    return by_asset


def analyze_inventory(
    db: Session,
    *,
    institution_id: int | None = None,
    asset_id: int | None = None,
    now: datetime | None = None,
) -> list[QualityFinding]:
    """Analyse assets in one institution scope and return all findings.

    ``institution_id=None`` analyses assets with no institution. Passing
    ``asset_id`` narrows the analysis to that asset but still uses the scope's
    assets as duplicate peers, so cross-institution comparison never happens.
    """
    scope = _load_scope_assets(db, institution_id)
    classifications = _load_classifications(db, [a.id for a in scope])
    mappings = _load_mappings(db, scope)

    findings: list[QualityFinding] = []
    for asset in scope:
        if asset_id is not None and asset.id != asset_id:
            continue
        findings.extend(
            analyze_asset(
                asset,
                peers=scope,
                mappings=mappings.get(asset.id, []),
                latest_classification=classifications.get(asset.id),
                now=now,
            )
        )
    findings.sort(key=lambda f: (-f.severity_rank, f.check, f.asset_id, f.related_asset_id or 0))
    return findings


def _load_scope_assets(
    db: Session, institution_id: int | None, *, asset_id: int | None = None
) -> list[InventoryRecord]:
    query = select(InventoryRecord)
    if institution_id is None:
        query = query.where(InventoryRecord.institution_id.is_(None))
    else:
        query = query.where(InventoryRecord.institution_id == institution_id)
    query = query.order_by(InventoryRecord.id)
    assets = list(db.execute(query).scalars().all())
    if asset_id is not None:
        assets = [a for a in assets if a.id == asset_id]
    return assets
