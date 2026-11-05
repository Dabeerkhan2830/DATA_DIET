"""In-process synthetic fixtures for Phase 1 UI development.

IMPORTANT: every identifier here uses the ``SYNTH-`` prefix and every payload
is wrapped in a ``synthetic_demo_data`` envelope by the API layer. These records
are invented for development; they are never read from or written to the
database, and no external system is contacted.
"""

from __future__ import annotations

from collections import Counter
from datetime import date

from app.api.schemas.demo import (
    ActivityItem,
    ApprovalQueueItem,
    DashboardSummary,
    HoldView,
    InventoryRecord,
    RetentionPage,
    RetentionPolicyView,
    RiskAnalysisPage,
    RiskBreakdown,
    RiskIndicatorView,
    RiskRecordView,
    SensitivityBreakdown,
)
from app.services.risk import RecordRiskFeatures, compute_risk

# --- Synthetic inventory -----------------------------------------------------
# (id, title, source, source_type, record_type, sensitivity, personal_data,
#  duplicate, past_retention_review, source_managed, size_bytes,
#  retention_action, owner_team, last_reviewed)
_RAW_RECORDS: list[tuple[object, ...]] = [
    ("SYNTH-0001", "Student Records Scratch Extract", "Synthetic SIS Export", "SIS",
     "student_records", "restricted", True, False, True, False, 894_112_201,
     "review", "Registrar Ops", date(2025, 2, 14)),
    ("SYNTH-0002", "Applicant Essay Batch A", "Synthetic Admissions Staging", "SIS",
     "applicant_documents", "confidential", True, True, False, True, 122_880_000,
     "archive", "Admissions IT", date(2025, 9, 3)),
    ("SYNTH-0003", "Payroll Sandbox Export", "Synthetic HR Testbed", "HR",
     "payroll", "restricted", True, False, True, True, 44_040_192,
     "review", "HR Systems", date(2024, 11, 30)),
    ("SYNTH-0004", "Public Course Catalog Feed", "Synthetic LMS Connector", "LMS",
     "catalog", "public", False, False, False, True, 9_625_600,
     "retain", "Digital Learning", date(2025, 10, 21)),
    ("SYNTH-0005", "Discussion Forum Archive 2019", "Synthetic LMS Connector", "LMS",
     "forum_threads", "internal", True, True, True, True, 2_147_483_648,
     "eligible_for_disposal", "Digital Learning", date(2024, 6, 12)),
    ("SYNTH-0006", "Research Consent Forms (Scan Set)", "Synthetic Research Drive",
     "FileShare", "consent_forms", "restricted", True, False, False, False,
     331_104_256, "review", "Research Compliance", date(2025, 8, 7)),
    ("SYNTH-0007", "Alumni Newsletter Mailing List", "Synthetic CRM Staging", "CRM",
     "contact_list", "confidential", True, True, False, True, 18_874_368,
     "archive", "Advancement Ops", date(2025, 7, 19)),
    ("SYNTH-0008", "Facilities Badge Log Sample", "Synthetic Facilities Export",
     "IoT", "access_logs", "internal", True, False, True, True, 76_021_760,
     "review", "Campus Security", date(2024, 12, 2)),
    ("SYNTH-0009", "Open Research Dataset Mirror", "Synthetic Research Drive",
     "FileShare", "research_dataset", "public", False, False, False, True,
     5_368_709_120, "retain", "Research Computing", date(2025, 9, 28)),
    ("SYNTH-0010", "Duplicate Advising Notes Copy", "Synthetic File Share Scan",
     "FileShare", "advising_notes", "confidential", True, True, True, False,
     641_677_312, "eligible_for_disposal", "Student Services", date(2024, 5, 9)),
    ("SYNTH-0011", "Grant Finance Scratch Ledger", "Synthetic Finance Testbed",
     "ERP", "finance_ledger", "confidential", False, False, True, True,
     95_420_416, "review", "Finance Systems", date(2024, 10, 15)),
    ("SYNTH-0012", "Library Proxy Auth Logs", "Synthetic Library Logs", "FileShare",
     "auth_logs", "internal", True, False, False, True, 214_000_000,
     "archive", "Library IT", date(2025, 6, 4)),
    ("SYNTH-0013", "Helpdesk Ticket Attachments", "Synthetic ITSM Export", "ITSM",
     "attachments", "internal", True, True, True, True, 1_073_741_824,
     "review", "IT Support", date(2024, 8, 23)),
    ("SYNTH-0014", "Prospective Student Web Leads", "Synthetic CRM Staging", "CRM",
     "lead_records", "confidential", True, False, False, False, 31_457_280,
     "review", "Admissions IT", date(2025, 5, 11)),
]


def _build_inventory() -> list[InventoryRecord]:
    records: list[InventoryRecord] = []
    for row in _RAW_RECORDS:
        (
            record_id,
            title,
            source_name,
            source_type,
            record_type,
            sensitivity,
            personal_data,
            duplicate,
            past_review,
            source_managed,
            size_bytes,
            retention_action,
            owner_team,
            last_reviewed,
        ) = row
        assert isinstance(record_id, str) and isinstance(title, str)
        assert isinstance(sensitivity, str) and isinstance(retention_action, str)
        assert isinstance(last_reviewed, date)
        records.append(
            InventoryRecord(
                record_id=record_id,
                title=title,
                source_name=source_name,  # type: ignore[arg-type]
                source_type=source_type,  # type: ignore[arg-type]
                record_type=record_type,  # type: ignore[arg-type]
                sensitivity=sensitivity,  # type: ignore[arg-type]
                contains_personal_data=personal_data,  # type: ignore[arg-type]
                duplicate_candidate=duplicate,  # type: ignore[arg-type]
                size_bytes=size_bytes,  # type: ignore[arg-type]
                retention_action=retention_action,  # type: ignore[arg-type]
                owner_team=owner_team,  # type: ignore[arg-type]
                last_reviewed=last_reviewed,
            )
        )
    return records


INVENTORY: list[InventoryRecord] = _build_inventory()

# Feature flags used only to derive risk inputs from the synthetic rows above.
_PAST_REVIEW = {row[0]: row[8] for row in _RAW_RECORDS}
_SOURCE_MANAGED = {row[0]: row[9] for row in _RAW_RECORDS}


def _features(record: InventoryRecord) -> RecordRiskFeatures:
    return RecordRiskFeatures(
        record_id=record.record_id,
        sensitivity=record.sensitivity,
        contains_personal_data=record.contains_personal_data,
        duplicate_candidate=record.duplicate_candidate,
        past_retention_review=bool(_PAST_REVIEW[record.record_id]),
        source_managed=bool(_SOURCE_MANAGED[record.record_id]),
    )


ACTIVITY: list[ActivityItem] = [
    ActivityItem(
        event_id="SYNTH-EVT-001",
        event_type="policy_version_created",
        description="Retention policy 'Student Records Retention' v3 (draft) created (synthetic).",
        actor="synthetic.user@example.edu",
        occurred_on=date(2026, 10, 12),
    ),
    ActivityItem(
        event_id="SYNTH-EVT-002",
        event_type="approval_requested",
        description="Disposal eligibility review requested for SYNTH-0005 (synthetic).",
        actor="synthetic.approver@example.edu",
        occurred_on=date(2026, 10, 11),
    ),
    ActivityItem(
        event_id="SYNTH-EVT-003",
        event_type="retrieval_requested",
        description="Retrieval request opened for SYNTH-0009 (synthetic).",
        actor="synthetic.researcher@example.edu",
        occurred_on=date(2026, 10, 10),
    ),
    ActivityItem(
        event_id="SYNTH-EVT-004",
        event_type="inventory_import",
        description="Synthetic inventory fixture loaded (14 records).",
        actor="system (fixture)",
        occurred_on=date(2026, 10, 9),
    ),
]


def get_dashboard_summary() -> DashboardSummary:
    """Aggregate dashboard counters from the synthetic inventory."""
    sensitivity_counts: Counter[str] = Counter()
    action_counts: Counter[str] = Counter()
    band_counts: Counter[str] = Counter()

    for record in INVENTORY:
        sensitivity_counts[record.sensitivity] += 1
        action_counts[record.retention_action] += 1
        band_counts[compute_risk(_features(record)).band] += 1

    return DashboardSummary(
        total_records=len(INVENTORY),
        duplicate_candidates=sum(1 for r in INVENTORY if r.duplicate_candidate),
        pending_approvals=3,
        open_retrieval_requests=2,
        storage_bytes=sum(r.size_bytes for r in INVENTORY),
        by_sensitivity=SensitivityBreakdown(
            public=sensitivity_counts["public"],
            internal=sensitivity_counts["internal"],
            confidential=sensitivity_counts["confidential"],
            restricted=sensitivity_counts["restricted"],
        ),
        by_risk_band=RiskBreakdown(
            low=band_counts["low"],
            moderate=band_counts["moderate"],
            high=band_counts["high"],
            critical=band_counts["critical"],
        ),
        by_retention_action={
            "retain": action_counts["retain"],
            "archive": action_counts["archive"],
            "review": action_counts["review"],
            "eligible_for_disposal": action_counts["eligible_for_disposal"],
        },
        recent_activity=ACTIVITY,
    )


def list_inventory() -> list[InventoryRecord]:
    return list(INVENTORY)


def get_risk_analysis() -> RiskAnalysisPage:
    """Per-record explainable assessments plus the rule catalogue."""
    views: list[RiskRecordView] = []
    for record in INVENTORY:
        assessment = compute_risk(_features(record))
        views.append(
            RiskRecordView(
                record_id=record.record_id,
                title=record.title,
                sensitivity=record.sensitivity,
                score=assessment.score,
                band=assessment.band,
                indicators=[
                    RiskIndicatorView(
                        code=i.code, label=i.label, points=i.points, explanation=i.explanation
                    )
                    for i in assessment.indicators
                ],
            )
        )
    views.sort(key=lambda v: v.score, reverse=True)
    return RiskAnalysisPage(
        rule_set="datadiet-risk-indicators-v1",
        rules=[
            {
                "code": "personal_data",
                "description": "Record contains personal data",
                "points": "+30",
            },
            {
                "code": "sensitivity",
                "description": "Sensitivity: restricted / confidential / internal",
                "points": "+30 / +20 / +10",
            },
            {
                "code": "duplicate",
                "description": "Flagged as duplicate candidate",
                "points": "+10",
            },
            {
                "code": "past_retention_review",
                "description": "Retention review date passed",
                "points": "+20",
            },
            {
                "code": "unmanaged_source",
                "description": "Source system not actively managed",
                "points": "+10",
            },
        ],
        records=views,
    )


def get_retention_page() -> RetentionPage:
    """Synthetic policies, holds, and approval queue entries."""
    applies_to: dict[str, int] = {}
    for record in INVENTORY:
        key = "student_records" if record.record_type == "student_records" else "all"
        applies_to[key] = applies_to.get(key, 0) + 1

    policies = [
        RetentionPolicyView(
            policy_id="SYNTH-POL-001",
            name="Student Records Retention",
            version="v3 (draft)",
            status="draft",
            scope="record_type = student_records",
            retention_period_days=3650,
            effective_from=date(2026, 12, 1),
            applies_to_count=applies_to.get("student_records", 0),
            notes="Synthetic draft — no engine evaluates this policy yet.",
        ),
        RetentionPolicyView(
            policy_id="SYNTH-POL-002",
            name="General Institutional Records",
            version="v2",
            status="active",
            scope="all inventory records",
            retention_period_days=1825,
            effective_from=date(2025, 1, 1),
            applies_to_count=len(INVENTORY),
            notes="Synthetic sample policy for UI layout only.",
        ),
        RetentionPolicyView(
            policy_id="SYNTH-POL-003",
            name="Marketing Consent Lists (Retired)",
            version="v1",
            status="retired",
            scope="record_type = contact_list",
            retention_period_days=730,
            effective_from=date(2023, 1, 1),
            applies_to_count=1,
            notes="Shown to exercise retired-policy display states.",
        ),
    ]
    return RetentionPage(
        policies=policies,
        active_holds=[
            HoldView(
                hold_id="SYNTH-HOLD-001",
                name="Synthetic Litigation Hold — Matter 2026-014",
                scope="records owned by Research Compliance",
                records_in_scope=3,
            ),
            HoldView(
                hold_id="SYNTH-HOLD-002",
                name="Synthetic Audit Hold — FY26 Finance Review",
                scope="record_type = finance_ledger",
                records_in_scope=1,
            ),
        ],
        approval_queue=[
            ApprovalQueueItem(
                request_id="SYNTH-APR-001",
                action="eligible_for_disposal review",
                record_id="SYNTH-0005",
                requested_by="synthetic.approver@example.edu",
            ),
            ApprovalQueueItem(
                request_id="SYNTH-APR-002",
                action="archive",
                record_id="SYNTH-0002",
                requested_by="synthetic.approver@example.edu",
            ),
            ApprovalQueueItem(
                request_id="SYNTH-APR-003",
                action="retain (override)",
                record_id="SYNTH-0011",
                requested_by="synthetic.approver@example.edu",
            ),
        ],
    )
