"""Deterministic, explainable classification over inventoried metadata (Phase 5).

The engine proposes a *category* and a *sensitivity* from metadata that already
exists on :class:`~app.db.models.InventoryRecord`. It never opens a file, never
calls an external service, and never writes the proposal back onto the asset:
classification is a proposal for human review, kept separate from retention
policy selection, retention assessment, and any lifecycle operation.

Design rules
------------

* **Versioned rule table.** Every rule lives in this module in a documented,
  ordered table (:data:`RULE_TABLE`) and carries a stable ``rule_id``. Route
  handlers never branch on ad-hoc conditions; they call :func:`classify`.
  Bump :data:`RULE_VERSION` whenever a rule's behaviour changes - stored rows
  keep their version, so history stays interpretable (ADR-0011).
* **Deterministic.** Identical inputs under the same rule version always produce
  an identical result (the timestamp is metadata about *when*, not an input).
* **No content claims.** A file name, extension, or MIME type is a *hint*, never
  proof of what a file contains. Every extension-derived rule is capped at
  ``low`` confidence and emits a warning saying so.
* **Honest unknowns.** When the metadata cannot support a proposal the engine
  returns ``unclassified`` with ``proposed_sensitivity="unknown"``. It never
  silently assigns a low sensitivity to an asset it does not understand.
* **Protective bias.** Where signals disagree, the outcome with the *highest
  protection* wins (see :data:`SENSITIVITY_RANK`), the conflict is reported, and
  overall confidence is capped.

Confidence semantics (documented, returned with every result)
-------------------------------------------------------------

=========  ==========================================================================
Level      Meaning
=========  ==========================================================================
high       Explicit, human-configured metadata stated the value; nothing disagreed.
medium     One documented metadata signal stated the value and nothing contradicted
           it, or conflicting signals were resolved by the protective rule.
low        The only support is a weak hint (file extension or name pattern), or
           several signals disagreed and were resolved.
none       No evidence supported a value. The outcome is ``unclassified``.
=========  ==========================================================================

Outcome values: ``classified`` (both a category and a sensitivity were proposed),
``partially_classified`` (only one of the two), ``unclassified`` (neither).
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import ClassificationResult, InventoryRecord

#: Bump whenever a rule's behaviour, precedence, or vocabulary changes.
RULE_VERSION = "classification-v1"

#: Documented confidence levels, ordered weakest to strongest.
CONFIDENCE_LEVELS: tuple[str, ...] = ("none", "low", "medium", "high")

CONFIDENCE_MEANING: dict[str, str] = {
    "high": "Explicit, human-configured metadata stated the value and nothing "
    "contradicted it. Still a metadata proposal, not an inspection of file "
    "contents.",
    "medium": "One documented metadata signal stated the value and nothing "
    "contradicted it, or conflicting signals were resolved by the protective "
    "tie-break.",
    "low": "The only support is a weak hint (file extension or file-name "
    "pattern), or several signals disagreed and were resolved. Treat as a "
    "starting point for review.",
    "none": "No metadata supported a value. The outcome is 'unclassified'; "
    "sensitivity stays 'unknown' and must not be read as low risk.",
}

#: Proposal outcomes.
OUTCOMES: tuple[str, ...] = ("classified", "partially_classified", "unclassified")

#: Sensitivity levels the engine can propose. ``unknown`` is the honest
#: fallback and is never treated as ``public``.
SENSITIVITY_LEVELS: tuple[str, ...] = (
    "public",
    "internal",
    "confidential",
    "restricted",
    "unknown",
)

#: Higher number = more protective. Used for the protective tie-break so the
#: engine never resolves a conflict toward *less* protection.
SENSITIVITY_RANK: dict[str, int] = {
    "unknown": -1,
    "public": 0,
    "internal": 1,
    "confidential": 2,
    "restricted": 3,
}

#: Recommended category vocabulary (not an enum: existing free-text values are
#: tolerated but warned about rather than rejected).
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

#: File extensions we can reason about at all. Anything else yields an
#: ``extension_unknown`` warning - absence of a recognised extension is
#: missing evidence, never evidence of safety.
KNOWN_EXTENSIONS: frozenset[str] = frozenset(
    {
        "bat", "cfg", "csv", "db", "doc", "docx", "gif", "gz", "html", "ini",
        "jpeg", "jpg", "json", "log", "md", "mp4", "odt", "parquet", "pdf",
        "png", "ppt", "pptx", "py", "rtf", "sh", "sql", "sqlite", "tar", "tsv",
        "txt", "wav", "xls", "xlsx", "xml", "yaml", "yml", "zip",
    }
)

#: Extensions whose *presence in a file name* is a documented signal for a
#: higher sensitivity. This is metadata-only inference and is reported as
#: ``low`` confidence evidence - never as proof of contents.
SENSITIVE_EXTENSIONS: frozenset[str] = frozenset(
    {"csv", "db", "json", "parquet", "sqlite", "tsv", "xls", "xlsx", "xml"}
)

#: Extension -> category hint. Weak signal only (``low`` confidence).
EXTENSION_CATEGORIES: dict[str, str] = {
    "csv": "datasets",
    "tsv": "datasets",
    "xls": "datasets",
    "xlsx": "datasets",
    "parquet": "datasets",
    "db": "datasets",
    "sqlite": "datasets",
    "doc": "documents",
    "docx": "documents",
    "odt": "documents",
    "pdf": "documents",
    "ppt": "documents",
    "pptx": "documents",
    "rtf": "documents",
    "txt": "documents",
    "md": "documents",
    "html": "documents",
    "gz": "archives",
    "tar": "archives",
    "zip": "archives",
    "py": "source_code",
    "sh": "source_code",
    "sql": "source_code",
    "bat": "source_code",
    "log": "logs",
    "gif": "images",
    "jpeg": "images",
    "jpg": "images",
    "png": "images",
    "wav": "images",
    "mp4": "images",
}

#: ``record_type`` -> category (``None`` means "no signal").
RECORD_TYPE_CATEGORIES: dict[str, str | None] = {
    "student_records": "student_records",
    "contact_list": "contact_list",
    "finance_ledger": "finance",
    "document": "documents",
    "documents": "documents",
    "dataset": "datasets",
    "datasets": "datasets",
    "spreadsheet": "datasets",
    "presentation": "documents",
    "email": "communications",
    "file": None,  # generic bucket: no information
    "record": None,
}

#: ``source_type`` -> category (``None`` means "no signal").
SOURCE_TYPE_CATEGORIES: dict[str, str | None] = {
    "academic_system": "academic_records",
    "finance_system": "finance",
    "hris": "hr",
    "lms": "academic_records",
    "email": "communications",
    "email_archive": "communications",
    "file_share": "documents",
    "sharepoint": "documents",
    "database": "datasets",
    "synthetic": None,  # deliberately neutral
    "local_folder": None,
}


@dataclass(frozen=True)
class FilenamePattern:
    """An approved, documented file-name pattern rule.

    Patterns are approved hints reviewed with the institution; matching a name
    never proves the contents of the file.
    """

    rule_id: str
    pattern: str
    category: str
    rationale: str


#: Approved file-name patterns, matched against ``file_name`` only. Regexes are
#: anchored loosely on purpose (they are hints) and are listed in the rules
#: metadata endpoint so reviewers can see exactly what matched.
FILENAME_PATTERNS: tuple[FilenamePattern, ...] = (
    FilenamePattern(
        "name-roster", r"roster", "student_records", "Class/employee roster naming."
    ),
    FilenamePattern(
        "name-transcript", r"transcript", "student_records", "Academic transcript naming."
    ),
    FilenamePattern(
        "name-gradebook", r"gradebook|\bgrades?\b", "student_records", "Grade record naming."
    ),
    FilenamePattern(
        "name-contact-list", r"contact[-_ ]?list", "contact_list", "Contact list naming."
    ),
    FilenamePattern(
        "name-invoice", r"invoice|payroll", "finance", "Invoice or payroll naming."
    ),
    FilenamePattern(
        "name-budget", r"\bbudget\b|ledger", "finance", "Budget or ledger naming."
    ),
    FilenamePattern(
        "name-policy", r"\bpolicy\b|handbook", "administrative", "Policy document naming."
    ),
    FilenamePattern(
        "name-audit-log", r"audit[-_ ]?log", "logs", "Audit log naming."
    ),
)


@dataclass(frozen=True)
class RuleDescriptor:
    """Public metadata for one rule, served by the rules endpoint."""

    rule_id: str
    field: str
    effect: str
    confidence: str
    description: str


#: The ordered rule table. ``field`` names the asset field(s) a rule reads;
#: ``effect`` says what the rule can propose. Served verbatim by
#: ``GET /api/v1/classification/rules`` so the rule set is inspectable.
RULE_TABLE: tuple[RuleDescriptor, ...] = (
    RuleDescriptor(
        "category-explicit",
        "category",
        "category",
        "high",
        "An explicitly configured asset category is proposed unchanged; "
        "values outside the recommended vocabulary are proposed with a warning.",
    ),
    RuleDescriptor(
        "category-record-type",
        "record_type",
        "category",
        "medium",
        "A known record_type maps to its recommended category.",
    ),
    RuleDescriptor(
        "category-name-pattern",
        "file_name",
        "category",
        "medium",
        "An approved file-name pattern matches; a name hint never proves "
        "file contents.",
    ),
    RuleDescriptor(
        "category-source-type",
        "source_type",
        "category",
        "medium",
        "A known source_type maps to its recommended category.",
    ),
    RuleDescriptor(
        "category-extension",
        "file_name",
        "category",
        "low",
        "A recognised file extension hints at a category. Extension and name "
        "metadata never prove file contents.",
    ),
    RuleDescriptor(
        "sensitivity-explicit",
        "sensitivity",
        "sensitivity",
        "high",
        "An explicitly configured sensitivity is proposed unchanged.",
    ),
    RuleDescriptor(
        "sensitivity-personal-data",
        "contains_personal_data",
        "sensitivity",
        "medium",
        "The record is flagged as containing personal data, which is at least "
        "confidential and can never be proposed as public.",
    ),
    RuleDescriptor(
        "sensitivity-sensitive-extension",
        "file_name",
        "sensitivity",
        "low",
        "A file name carries a commonly restricted extension (spreadsheet or "
        "structured data). Weak metadata hint only.",
    ),
    RuleDescriptor(
        "sensitivity-synthetic",
        "external_id,title,source_type",
        "sensitivity",
        "medium",
        "A synthetic-data indicator is present, so no real personal data is "
        "in scope; the proposal is capped at internal and flagged.",
    ),
)


def _rule_descriptor(rule_id: str) -> RuleDescriptor | None:
    """Look up a rule descriptor by id (used by tests and tooling)."""
    for descriptor in RULE_TABLE:
        if descriptor.rule_id == rule_id:
            return descriptor
    return None


@dataclass(frozen=True)
class Evidence:
    """One piece of supporting evidence, tied to the rule that produced it."""

    rule_id: str
    rule_version: str
    field: str
    observed: str | None
    proposed_category: str | None = None
    proposed_sensitivity: str | None = None
    note: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {k: v for k, v in asdict(self).items() if v is not None}


@dataclass(frozen=True)
class Conflict:
    """An unresolved disagreement between two rules with equal standing."""

    field: str
    values: tuple[str, ...]
    resolved_to: str
    reason: str

    def as_dict(self) -> dict[str, object]:
        return {
            "field": self.field,
            "values": list(self.values),
            "resolved_to": self.resolved_to,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class ClassificationOutcome:
    """The full, explainable result of classifying one asset's metadata."""

    outcome: str
    proposed_category: str | None
    proposed_sensitivity: str
    confidence: str
    confidence_meaning: str
    evidence: tuple[Evidence, ...]
    warnings: tuple[str, ...]
    conflicts: tuple[Conflict, ...]
    input_fingerprint: str
    classified_at: datetime

    def evidence_dicts(self) -> list[dict[str, object]]:
        return [e.as_dict() for e in self.evidence]

    def warning_list(self) -> list[str]:
        return list(self.warnings)

    def conflict_dicts(self) -> list[dict[str, object]]:
        return [c.as_dict() for c in self.conflicts]


_SYNTHETIC_PREFIX = "SYNTH-"


def _confidence_rank(level: str) -> int:
    return CONFIDENCE_LEVELS.index(level)


def _weakest(levels: Iterable[str]) -> str:
    levels = list(levels)
    if not levels:
        return "none"
    return min(levels, key=_confidence_rank)


def _extension_of(file_name: str | None) -> str | None:
    """Lower-cased extension of ``file_name``, or ``None`` when unrecognisable."""
    if not file_name or "." not in file_name:
        return None
    candidate = file_name.rsplit(".", 1)[-1].strip().lower()
    return candidate or None


def _synthetic_indicators(inputs: dict[str, object]) -> list[str]:
    """Names the synthetic-data markers found, in deterministic order."""
    markers: list[str] = []
    external_id = str(inputs.get("external_id") or "")
    title = str(inputs.get("title") or "")
    source_type = str(inputs.get("source_type") or "")
    if external_id.startswith(_SYNTHETIC_PREFIX):
        markers.append("external_id starts with the SYNTH- synthetic prefix")
    if "synthetic" in title.lower():
        markers.append("title contains the word 'synthetic'")
    if source_type == "synthetic":
        markers.append("source_type is 'synthetic'")
    return markers


def _fingerprint(inputs: dict[str, object]) -> str:
    """Stable SHA-256 over the canonical classification inputs + rule version.

    Used for idempotent re-runs: identical inputs under the same rule version
    reuse the stored result instead of appending a duplicate history row.
    """
    payload = json.dumps(
        {"rule_version": RULE_VERSION, "inputs": inputs},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def extract_inputs(asset: InventoryRecord) -> dict[str, object]:
    """The exact metadata fields the engine reads, as a canonical dict."""
    return {
        "asset_id": asset.id,
        "category": asset.category,
        "contains_personal_data": bool(asset.contains_personal_data),
        "external_id": asset.external_id,
        "file_name": asset.file_name,
        "mime_type": asset.mime_type,
        "record_type": asset.record_type,
        "sensitivity": asset.sensitivity,
        "source_type": asset.source_type,
        "title": asset.title,
    }


def classify(
    asset: InventoryRecord,
    *,
    classified_at: datetime | None = None,
) -> ClassificationOutcome:
    """Classify one asset's metadata deterministically.

    Pure with respect to the database: pass an asset (or any object with the
    same fields) and get back an explainable proposal. The caller persists the
    outcome; this function never writes anything.
    """
    inputs = extract_inputs(asset)
    evidence: list[Evidence] = []
    warnings: list[str] = []
    conflicts: list[Conflict] = []

    proposed_category, category_confidence, category_conflicts = _propose_category(
        inputs, evidence, warnings
    )
    proposed_sensitivity, sensitivity_confidence, sensitivity_conflicts = (
        _propose_sensitivity(inputs, evidence, warnings)
    )
    conflicts.extend(category_conflicts)
    conflicts.extend(sensitivity_conflicts)

    if proposed_category is None and proposed_sensitivity == "unknown":
        outcome = "unclassified"
        confidence = "none"
        warnings.append(
            "Metadata was insufficient to propose either a category or a "
            "sensitivity; the asset stays unclassified. Unassessed does not "
            "mean low risk."
        )
    elif proposed_category is None or proposed_sensitivity == "unknown":
        outcome = "partially_classified"
        confidence = _weakest(
            c for c in (category_confidence, sensitivity_confidence) if c != "none"
        )
        warnings.append(
            "Only one of category or sensitivity could be proposed; the "
            "outcome is partial and needs human review."
        )
    else:
        outcome = "classified"
        confidence = _weakest((category_confidence, sensitivity_confidence))

    when = classified_at or datetime.now(UTC).replace(tzinfo=None)
    return ClassificationOutcome(
        outcome=outcome,
        proposed_category=proposed_category,
        proposed_sensitivity=proposed_sensitivity,
        confidence=confidence,
        confidence_meaning=CONFIDENCE_MEANING[confidence],
        evidence=tuple(evidence),
        warnings=tuple(warnings),
        conflicts=tuple(conflicts),
        input_fingerprint=_fingerprint(inputs),
        classified_at=when,
    )


def _propose_category(
    inputs: dict[str, object],
    evidence: list[Evidence],
    warnings: list[str],
) -> tuple[str | None, str, list[Conflict]]:
    """Apply the category rules in documented order; return value, confidence, conflicts."""
    candidates: list[tuple[int, str, str, str]] = []  # (order, confidence, rule_id, value)
    order = 0

    configured = str(inputs.get("category") or "").strip()
    if configured:
        in_vocab = configured in KNOWN_CATEGORIES
        if not in_vocab:
            warnings.append(
                f"Configured category '{configured}' is outside the recommended "
                "vocabulary; it is proposed as-is for human review."
            )
        evidence.append(
            Evidence(
                rule_id="category-explicit",
                rule_version=RULE_VERSION,
                field="category",
                observed=configured,
                proposed_category=configured,
                note=None
                if in_vocab
                else "outside recommended vocabulary; proposed unchanged",
            )
        )
        candidates.append((order, "high", "category-explicit", configured))
        order += 1

    file_name = str(inputs.get("file_name") or "")
    if file_name:
        for pattern in FILENAME_PATTERNS:
            if re.search(pattern.pattern, file_name, flags=re.IGNORECASE):
                evidence.append(
                    Evidence(
                        rule_id="category-name-pattern",
                        rule_version=RULE_VERSION,
                        field="file_name",
                        observed=pattern.rule_id,
                        proposed_category=pattern.category,
                        note=f"matched pattern '{pattern.rule_id}': {pattern.rationale}",
                    )
                )
                candidates.append(
                    (order, "medium", f"category-name-pattern:{pattern.rule_id}", pattern.category)
                )
                order += 1

    record_type = str(inputs.get("record_type") or "").strip()
    mapped = RECORD_TYPE_CATEGORIES.get(record_type)
    if record_type and mapped:
        evidence.append(
            Evidence(
                rule_id="category-record-type",
                rule_version=RULE_VERSION,
                field="record_type",
                observed=record_type,
                proposed_category=mapped,
            )
        )
        candidates.append((order, "medium", "category-record-type", mapped))
        order += 1

    source_type = str(inputs.get("source_type") or "").strip()
    mapped = SOURCE_TYPE_CATEGORIES.get(source_type)
    if source_type and mapped:
        evidence.append(
            Evidence(
                rule_id="category-source-type",
                rule_version=RULE_VERSION,
                field="source_type",
                observed=source_type,
                proposed_category=mapped,
            )
        )
        candidates.append((order, "medium", "category-source-type", mapped))
        order += 1

    extension = _extension_of(file_name or None)
    if extension:
        if extension not in KNOWN_EXTENSIONS:
            warnings.append(
                f"File extension '.{extension}' is not recognised; extension "
                "metadata is missing or unsupported and cannot support a "
                "classification on its own."
            )
        mapped = EXTENSION_CATEGORIES.get(extension)
        if mapped:
            evidence.append(
                Evidence(
                    rule_id="category-extension",
                    rule_version=RULE_VERSION,
                    field="file_name",
                    observed=extension,
                    proposed_category=mapped,
                    note="extension hint only; a file name never proves contents",
                )
            )
            candidates.append((order, "low", "category-extension", mapped))
            order += 1
            warnings.append(
                "The proposed category is based only on a file extension hint; "
                "an extension never proves what a file contains."
            )

    if not candidates:
        warnings.append(
            "No category evidence found in the metadata; no category is "
            "proposed. Absence of evidence is not evidence of a low-risk "
            "category."
        )
        return None, "none", []

    conflicts = _report_conflicts(candidates, field="category", warnings=warnings)
    confidence = "low" if conflicts else candidates[0][1]
    return candidates[0][3], confidence, conflicts


def _propose_sensitivity(
    inputs: dict[str, object],
    evidence: list[Evidence],
    warnings: list[str],
) -> tuple[str, str, list[Conflict]]:
    """Apply the sensitivity rules; protective bias on disagreement."""
    candidates: list[tuple[int, str, str, str]] = []
    order = 0

    configured = str(inputs.get("sensitivity") or "").strip()
    if configured in SENSITIVITY_LEVELS and configured != "unknown":
        evidence.append(
            Evidence(
                rule_id="sensitivity-explicit",
                rule_version=RULE_VERSION,
                field="sensitivity",
                observed=configured,
                proposed_sensitivity=configured,
            )
        )
        candidates.append((order, "high", "sensitivity-explicit", configured))
        order += 1
    elif configured and configured not in SENSITIVITY_LEVELS:
        warnings.append(
            f"Configured sensitivity '{configured}' is not a recognised level; "
            "it is ignored and the proposal falls back to other signals."
        )

    if bool(inputs.get("contains_personal_data")):
        evidence.append(
            Evidence(
                rule_id="sensitivity-personal-data",
                rule_version=RULE_VERSION,
                field="contains_personal_data",
                observed="true",
                proposed_sensitivity="confidential",
                note="personal data is at least confidential; never proposed as public",
            )
        )
        candidates.append((order, "medium", "sensitivity-personal-data", "confidential"))
        order += 1

    extension = _extension_of(str(inputs.get("file_name") or None))
    if extension in SENSITIVE_EXTENSIONS:
        evidence.append(
            Evidence(
                rule_id="sensitivity-sensitive-extension",
                rule_version=RULE_VERSION,
                field="file_name",
                observed=extension,
                proposed_sensitivity="confidential",
                note="restricted-extension hint only; never proof of contents",
            )
        )
        candidates.append((order, "low", "sensitivity-sensitive-extension", "confidential"))
        order += 1

    markers = _synthetic_indicators(inputs)
    if markers:
        evidence.append(
            Evidence(
                rule_id="sensitivity-synthetic",
                rule_version=RULE_VERSION,
                field="external_id",
                observed="; ".join(markers),
                proposed_sensitivity="internal",
                note="synthetic indicators mean no real personal data is in scope; "
                "capped at internal",
            )
        )
        candidates.append((order, "medium", "sensitivity-synthetic", "internal"))
        order += 1
        warnings.append(
            "Synthetic-data indicators found: this proposal describes a "
            "synthetic fixture, not a real record. Synthetic markers do not "
            "prove that other assets are free of personal data."
        )

    if not candidates:
        warnings.append(
            "No sensitivity evidence found; the proposal stays 'unknown'. "
            "'unknown' means unassessed and must not be read as low risk."
        )
        return "unknown", "none", []

    distinct = {c[3] for c in candidates}
    if len(distinct) > 1:
        # Protective tie-break: when signals disagree the more protective value
        # wins, regardless of which rule fired first.
        winner = max(distinct, key=lambda value: SENSITIVITY_RANK[value])
    else:
        winner = candidates[0][3]

    conflicts = _report_conflicts(
        candidates,
        field="sensitivity",
        warnings=warnings,
        chosen=winner,
        protective=True,
    )
    confidence = "none"
    for _, conf, _, value in candidates:
        if value == winner and _confidence_rank(conf) > _confidence_rank(confidence):
            confidence = conf
    if conflicts:
        confidence = "low"
    return winner, confidence, conflicts


def _report_conflicts(
    candidates: Sequence[tuple[int, str, str, str]],
    *,
    field: str,
    warnings: list[str],
    chosen: str | None = None,
    protective: bool = False,
) -> list[Conflict]:
    """Record disagreements between rules as explicit, inspectable conflicts.

    Returns the conflicts (empty when every candidate agrees) and appends a
    matching human-readable warning.
    """
    distinct = sorted({c[3] for c in candidates})
    if len(distinct) < 2:
        return []
    resolved_to = chosen if chosen is not None else candidates[0][3]
    reason = (
        "protective tie-break: the more protective value wins when signals "
        "disagree"
        if protective
        else "documented rule precedence: the earlier/stronger rule wins when "
        "signals disagree"
    )
    warnings.append(
        f"Conflicting {field} evidence ({', '.join(distinct)}) resolved to "
        f"'{resolved_to}' by {reason}; the disagreement is unresolved and needs "
        "human review."
    )
    return [
        Conflict(
            field=field,
            values=tuple(distinct),
            resolved_to=resolved_to,
            reason=reason,
        )
    ]


def classify_and_persist(
    db: Session,
    asset: InventoryRecord,
    *,
    created_by: str = "system",
    classified_at: datetime | None = None,
) -> tuple[ClassificationResult, bool]:
    """Classify ``asset`` and store an immutable history row.

    Idempotency (documented, tested): if a result for the same ``(asset_id,
    rule_version, input_fingerprint)`` already exists it is returned unchanged
    (``created=False``). Any change to the asset's relevant metadata or to the
    rule version appends a new row, so history is never overwritten.

    The asset row itself is never mutated - a classification is a proposal.
    """
    outcome = classify(asset, classified_at=classified_at)
    existing = db.execute(
        select(ClassificationResult).where(
            ClassificationResult.asset_id == asset.id,
            ClassificationResult.rule_version == RULE_VERSION,
            ClassificationResult.input_fingerprint == outcome.input_fingerprint,
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing, False

    row = ClassificationResult(
        asset_id=asset.id,
        institution_id=asset.institution_id,
        rule_version=RULE_VERSION,
        outcome=outcome.outcome,
        proposed_category=outcome.proposed_category,
        proposed_sensitivity=outcome.proposed_sensitivity,
        confidence=outcome.confidence,
        confidence_meaning=outcome.confidence_meaning,
        evidence=outcome.evidence_dicts(),
        warnings=outcome.warning_list(),
        conflicts=outcome.conflict_dicts(),
        input_fingerprint=outcome.input_fingerprint,
        created_by=(created_by or "system")[:120],
        classified_at=outcome.classified_at,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row, True


def get_latest(db: Session, asset_id: int) -> ClassificationResult | None:
    """Most recent classification result for an asset, or ``None``."""
    return db.execute(
        select(ClassificationResult)
        .where(ClassificationResult.asset_id == asset_id)
        .order_by(ClassificationResult.id.desc())
        .limit(1)
    ).scalar_one_or_none()


def get_history(
    db: Session,
    asset_id: int,
    *,
    page: int = 1,
    per_page: int = 20,
) -> tuple[list[ClassificationResult], int]:
    """Paginated, newest-first classification history for an asset."""
    from sqlalchemy import func as _func

    total = db.execute(
        select(_func.count()).select_from(ClassificationResult).where(
            ClassificationResult.asset_id == asset_id
        )
    ).scalar_one()
    rows = db.execute(
        select(ClassificationResult)
        .where(ClassificationResult.asset_id == asset_id)
        .order_by(ClassificationResult.id.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
    ).scalars().all()
    return list(rows), int(total or 0)
