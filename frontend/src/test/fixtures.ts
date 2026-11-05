/** Shared test fixtures for synthetic demo payloads. */

import type { DashboardSummary, DemoEnvelope } from "../api/types";

export const DASHBOARD_SUMMARY: DashboardSummary = {
  total_records: 14,
  duplicate_candidates: 5,
  pending_approvals: 3,
  open_retrieval_requests: 2,
  storage_bytes: 10_737_418_240,
  by_sensitivity: { public: 2, internal: 4, confidential: 5, restricted: 3 },
  by_risk_band: { low: 1, moderate: 5, high: 5, critical: 3 },
  by_retention_action: { retain: 2, archive: 3, review: 7, eligible_for_disposal: 2 },
  recent_activity: [
    {
      event_id: "SYNTH-EVT-001",
      event_type: "policy_version_created",
      description: "Retention policy v3 draft created (synthetic).",
      actor: "synthetic.user@example.edu",
      occurred_on: "2026-10-12",
    },
  ],
};

export function envelope<T>(data: T): DemoEnvelope<T> {
  return {
    meta: {
      classification: "synthetic_demo_data",
      notice: "SYNTHETIC DEMO DATA. Generated locally for UI development.",
      source: "in_process_fixture",
    },
    data,
  };
}
