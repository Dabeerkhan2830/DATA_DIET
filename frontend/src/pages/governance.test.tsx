/**
 * Phase 6 review workflow UI: unified queue and asset governance view.
 *
 * The API modules are mocked so these tests verify UI behaviour - filtering,
 * pagination, validation, duplicate-submission prevention, stale/conflict
 * handling, hold warnings, and error states - without a backend.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { Decision, GovernanceDetail, PaginatedRecommendations } from "../api/types";
import { testUser, withAuth } from "../test/auth";

const listRecommendations = vi.fn();
const assessAsset = vi.fn();
const createDecision = vi.fn();
const listSupersessionCandidates = vi.fn();
const fetchAssetGovernance = vi.fn();

vi.mock("../api/retention", () => ({
  listRecommendations: (...args: unknown[]) => listRecommendations(...args),
  assessAsset: (...args: unknown[]) => assessAsset(...args),
  createDecision: (...args: unknown[]) => createDecision(...args),
  listSupersessionCandidates: (...args: unknown[]) => listSupersessionCandidates(...args),
}));

vi.mock("../api/governance", () => ({
  fetchAssetGovernance: (...args: unknown[]) => fetchAssetGovernance(...args),
}));

import Recommendations from "./Recommendations";
import AssetGovernance from "./AssetGovernance";

const QUEUE: PaginatedRecommendations = {
  items: [
    {
      asset_id: 3,
      asset_title: "Payroll export",
      recommendation: "BLOCKED_BY_HOLD",
      rationale: "An active hold prevents disposal.",
      severity: "blocked",
      policy_id: 1,
      policy_version_id: 2,
      holds_active: 1,
      assessed_at: "2026-10-10T00:00:00",
      findings: null,
      review_status: "open",
      latest_decision: null,
      decisions_recorded: 0,
      retention_deadline: "2026-09-01",
      days_overdue: 40,
    },
  ],
  total: 1,
  page: 1,
  per_page: 20,
  pages: 1,
};

const DECISION: Decision = {
  id: 11,
  assessment_id: 5,
  asset_id: 3,
  institution_id: 1,
  policy_id: 1,
  policy_version_id: 2,
  recommendation_reviewed: "REVIEW_REQUIRED",
  decision: "retain",
  reason: "Operational need continues.",
  reviewer: "Synthetic Reviewer",
  decided_at: "2026-10-15T10:00:00",
  supersedes_decision_id: null,
  is_superseded: false,
  superseded_by_decision_id: null,
};

/** An earlier decision that a correction on assessment #9 replaced. */
const SUPERSEDED_DECISION: Decision = {
  ...DECISION,
  id: 4,
  assessment_id: 3,
  decision: "reject",
  reason: "Superseded by a later correction.",
  decided_at: "2026-09-01T09:00:00",
  is_superseded: true,
  superseded_by_decision_id: 12,
};

const DETAIL: GovernanceDetail = {
  asset: {
    id: 3,
    institution_id: 1,
    data_source_id: 1,
    external_id: "SYNTH-3",
    title: "Payroll export",
    description: null,
    record_type: "document",
    category: "hr",
    source_type: "local_folder",
    file_name: "payroll.csv",
    mime_type: "text/csv",
    size_bytes: 2048,
    checksum_sha256: "abcdef0123456789",
    sensitivity: "confidential",
    contains_personal_data: true,
    duplicate_of_id: null,
    owner_team: "HR",
    owner_email: null,
    lifecycle_status: "active",
    last_reviewed: null,
    source_created_at: null,
    source_modified_at: null,
    created_at: "2026-01-01T00:00:00",
    updated_at: "2026-01-01T00:00:00",
  },
  source: {
    data_source_id: 1,
    data_source_name: "HR share",
    source_type: "local_folder",
    connector_type: "local_folder",
    institution_id: 1,
    mapping_present: false,
    mappings: [],
    latest_scan: null,
    notes: ["No source-record mapping exists, so this asset was not produced by a connector scan."],
  },
  classification: null,
  quality_findings: [],
  applicable_policy: {
    policy_id: 1,
    name: "HR retention",
    status: "active",
    version_id: 2,
    version_number: 1,
    retention_period_days: 365,
    retention_trigger: "created_at",
    recommended_action: "review",
    applicable_categories: ["hr"],
  },
  latest_assessment: {
    id: 5,
    asset_id: 3,
    institution_id: 1,
    policy_id: 1,
    policy_version_id: 2,
    policy_version_number: 1,
    rule_set: "retention-assessment-v2",
    assessed_at: "2026-10-01T00:00:00",
    recommendation: "REVIEW_REQUIRED",
    rationale: "The retention deadline approaches; a human review is required.",
    findings: [],
    holds_active: 0,
    unresolved_conditions: [],
    trigger_date: "2026-01-01",
    retention_period_days: 365,
    retention_deadline: "2027-01-01",
  },
  assessment_history: [],
  active_holds: [],
  decisions: [],
  effective_decision_id: null,
  review_context: {
    latest_assessment_id: 5,
    expected_assessed_at: "2026-10-01T00:00:00",
    expected_policy_version_id: 2,
    expected_holds_active: 0,
    decisions_recorded: 0,
  },
  provenance: {
    observed: ["inventory metadata"],
    system_proposed: [],
    assessed: ["retention assessment"],
    human_decisions: [],
    file_operations: "Not implemented. This view never archives, restores, moves, or deletes a file.",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  // By default there is nothing to supersede; tests override this per case.
  listSupersessionCandidates.mockResolvedValue([]);
});

describe("Review queue", () => {
  it("sends the selected filters to the server", async () => {
    listRecommendations.mockResolvedValue(QUEUE);
    render(
      withAuth(
        <MemoryRouter>
          <Recommendations />
        </MemoryRouter>,
      ),
    );
    await waitFor(() => {
      expect(screen.getByText("Payroll export")).toBeInTheDocument();
    });

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /recommendation/i }),
      "RETAIN",
    );
    await waitFor(() => {
      expect(listRecommendations).toHaveBeenLastCalledWith(
        expect.objectContaining({ recommendation: "RETAIN" }),
      );
    });

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /review status/i }),
      "open",
    );
    await waitFor(() => {
      expect(listRecommendations).toHaveBeenLastCalledWith(
        expect.objectContaining({ review_status: "open" }),
      );
    });

    await userEvent.selectOptions(screen.getByRole("combobox", { name: /sort/i }), "age");
    await waitFor(() => {
      expect(listRecommendations).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: "age" }),
      );
    });
  });

  it("paginates and links rows to the governance view", async () => {
    listRecommendations.mockResolvedValue({ ...QUEUE, total: 40, pages: 2 });
    render(
      withAuth(
        <MemoryRouter>
          <Recommendations />
        </MemoryRouter>,
      ),
    );
    await waitFor(() => {
      expect(screen.getByText("Payroll export")).toBeInTheDocument();
    });

    expect(screen.getByRole("link", { name: /open governance view/i })).toHaveAttribute(
      "href",
      "/governance/assets/3",
    );

    await userEvent.click(screen.getByRole("button", { name: /^next$/i }));
    await waitFor(() => {
      expect(listRecommendations).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2 }),
      );
    });
  });

  it("shows an empty state that never implies disposal", async () => {
    listRecommendations.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      per_page: 20,
      pages: 0,
    });
    render(
      withAuth(
        <MemoryRouter>
          <Recommendations />
        </MemoryRouter>,
      ),
    );
    await waitFor(() => {
      expect(screen.getByText(/no items in the review queue/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/never implies that any asset is eligible/i)).toBeInTheDocument();
  });
});

function renderGovernance(user = testUser()) {
  return render(
    withAuth(
      <MemoryRouter initialEntries={["/governance/assets/3"]}>
        <Routes>
          <Route path="/governance/assets/:assetId" element={<AssetGovernance />} />
        </Routes>
      </MemoryRouter>,
      user,
    ),
  );
}

describe("Asset governance view", () => {
  it("renders aggregated sections and the file-operations statement", async () => {
    fetchAssetGovernance.mockResolvedValue(DETAIL);
    renderGovernance();

    await waitFor(() => {
      expect(screen.getByText("Payroll export")).toBeInTheDocument();
    });
    // Applicable policy + exact version are shown.
    expect(screen.getByText(/HR retention/)).toBeInTheDocument();
    // No file operation is ever claimed.
    expect(screen.getByText(/Not implemented/i)).toBeInTheDocument();
    // Decision form is available when no decision exists.
    expect(screen.getByRole("button", { name: /record decision/i })).toBeInTheDocument();
  });

  it("renders an error state when the view cannot load", async () => {
    fetchAssetGovernance.mockRejectedValue(new ApiError("asset_out_of_scope", 404));
    renderGovernance();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/governance view unavailable/i);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/asset_out_of_scope/);
  });

  it("requires a substantive rationale for a rejection", async () => {
    fetchAssetGovernance.mockResolvedValue(DETAIL);
    renderGovernance();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /record decision/i })).toBeInTheDocument();
    });

    await userEvent.selectOptions(screen.getByLabelText(/decision/i), "reject");
    await userEvent.type(screen.getByLabelText(/^rationale/i), "no");

    expect(screen.getByRole("button", { name: /record decision/i })).toBeDisabled();
    expect(screen.getByText(/needs a substantive rationale/i)).toBeInTheDocument();
    expect(createDecision).not.toHaveBeenCalled();
  });

  it("records a decision with the displayed version tokens", async () => {
    fetchAssetGovernance.mockResolvedValue(DETAIL);
    createDecision.mockResolvedValue(DECISION);
    renderGovernance();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /record decision/i })).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText(/^rationale/i), "Operational need continues.");
    await userEvent.click(screen.getByRole("button", { name: /record decision/i }));

    await waitFor(() => {
      expect(createDecision).toHaveBeenCalledWith(
        5,
        expect.objectContaining({
          decision: "retain",
          reason: "Operational need continues.",
          supersedes_decision_id: null,
          expected_assessed_at: "2026-10-01T00:00:00",
          expected_policy_version_id: 2,
          expected_holds_active: 0,
        }),
      );
    });
  });

  it("prevents duplicate submissions while a decision is in flight", async () => {
    fetchAssetGovernance.mockResolvedValue(DETAIL);
    let release: (value: Decision) => void = () => {};
    createDecision.mockImplementation(
      () =>
        new Promise<Decision>((resolve) => {
          release = resolve;
        }),
    );
    renderGovernance();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /record decision/i })).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText(/^rationale/i), "Operational need continues.");
    await userEvent.click(screen.getByRole("button", { name: /record decision/i }));

    const inFlight = screen.getByRole("button", { name: /recording/i });
    expect(inFlight).toBeDisabled();
    await userEvent.click(inFlight);
    expect(createDecision).toHaveBeenCalledTimes(1);

    release(DECISION);
    await waitFor(() => {
      expect(fetchAssetGovernance).toHaveBeenCalledTimes(2);
    });
  });

  it("surfaces a stale-review conflict instead of recording it", async () => {
    fetchAssetGovernance.mockResolvedValue(DETAIL);
    createDecision.mockRejectedValue(
      new ApiError("stale_review_conflict: a newer assessment exists for this asset.", 409),
    );
    renderGovernance();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /record decision/i })).toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText(/^rationale/i), "Operational need continues.");
    await userEvent.click(screen.getByRole("button", { name: /record decision/i }));

    await waitFor(() => {
      expect(screen.getByText(/this review is out of date/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/stale_review_conflict/);
  });

  it("warns about active holds and blocks approving a workflow", async () => {
    fetchAssetGovernance.mockResolvedValue({
      ...DETAIL,
      active_holds: [
        {
          id: 9,
          institution_id: 1,
          asset_id: 3,
          asset_scope: null,
          name: "Litigation hold",
          hold_type: "legal",
          legal_basis: "case 2026-114",
          scope: [],
          status: "active",
          created_by: "system",
          created_at: "2026-10-01T00:00:00",
          released_by: null,
          released_at: null,
          release_reason: null,
        },
      ],
      review_context: { ...DETAIL.review_context, expected_holds_active: 1 },
    });
    renderGovernance();
    await waitFor(() => {
      expect(screen.getAllByText(/1 active hold/i).length).toBeGreaterThan(0);
    });

    const approve = screen.getByRole("option", {
      name: /approve recommendation for a later workflow/i,
    });
    expect(approve).toBeDisabled();
  });

  it("disables the form when a decision already exists", async () => {
    fetchAssetGovernance.mockResolvedValue({
      ...DETAIL,
      decisions: [DECISION],
      review_context: { ...DETAIL.review_context, decisions_recorded: 1 },
    });
    renderGovernance();
    await waitFor(() => {
      expect(screen.getByText(/a decision is already recorded/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /record decision/i })).not.toBeInTheDocument();
  });

  /* --------------------------- decision supersession ---------------------- */

  const EARLIER_DECISION: Decision = {
    ...DECISION,
    id: 4,
    assessment_id: 3,
    decided_at: "2026-09-01T09:00:00",
  };

  it("offers supersession of the effective decision on a fresh assessment", async () => {
    fetchAssetGovernance.mockResolvedValue({
      ...DETAIL,
      decisions: [EARLIER_DECISION],
      effective_decision_id: EARLIER_DECISION.id,
      review_context: { ...DETAIL.review_context, decisions_recorded: 1 },
    });
    listSupersessionCandidates.mockResolvedValue([EARLIER_DECISION]);
    createDecision.mockResolvedValue({ ...DECISION, supersedes_decision_id: 4 });
    renderGovernance();
    // The correction select appears once the server-computed candidates load.
    // Its value is set from the candidates fetch, so wait for the selection
    // instead of racing the follow-up render.
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: /correction/i })).toHaveValue("4");
    });
    expect(screen.getByText(/superseding decision #4/i)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/^rationale/i), "Corrected after re-check.");
    await userEvent.click(screen.getByRole("button", { name: /record decision/i }));

    await waitFor(() => {
      expect(createDecision).toHaveBeenCalledWith(
        5,
        expect.objectContaining({ supersedes_decision_id: 4 }),
      );
    });
  });

  it("can record an independent decision that supersedes nothing", async () => {
    fetchAssetGovernance.mockResolvedValue({
      ...DETAIL,
      decisions: [EARLIER_DECISION],
      effective_decision_id: EARLIER_DECISION.id,
      review_context: { ...DETAIL.review_context, decisions_recorded: 1 },
    });
    listSupersessionCandidates.mockResolvedValue([EARLIER_DECISION]);
    createDecision.mockResolvedValue(DECISION);
    renderGovernance();
    await screen.findByRole("combobox", { name: /correction/i });

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /correction/i }),
      "",
    );
    await userEvent.type(screen.getByLabelText(/^rationale/i), "Operational need continues.");
    await userEvent.click(screen.getByRole("button", { name: /record decision/i }));

    await waitFor(() => {
      expect(createDecision).toHaveBeenCalledWith(
        5,
        expect.objectContaining({ supersedes_decision_id: null }),
      );
    });
  });

  it("shows superseded decisions in history with their replacement", async () => {
    fetchAssetGovernance.mockResolvedValue({
      ...DETAIL,
      decisions: [
        { ...DECISION, supersedes_decision_id: 4 },
        SUPERSEDED_DECISION,
      ],
      effective_decision_id: DECISION.id,
      review_context: { ...DETAIL.review_context, decisions_recorded: 2 },
    });
    renderGovernance();
    await waitFor(() => {
      expect(screen.getByText(/superseded by decision #12/i)).toBeInTheDocument();
    });

    expect(screen.getByText("Effective")).toBeInTheDocument();
    expect(screen.getByText("Superseded")).toBeInTheDocument();
    expect(screen.getByText(/corrects decision #4/i)).toBeInTheDocument();
  });

  /* ---------------------------- permission gating ------------------------- */

  it("hides the decision form from users without the reviewer role", async () => {
    fetchAssetGovernance.mockResolvedValue(DETAIL);
    renderGovernance(testUser({ role: "viewer" }));
    await waitFor(() => {
      expect(screen.getByText(/your role cannot record decisions/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /record decision/i })).not.toBeInTheDocument();
  });

  it("hides the assessment action from users without retention:assess", async () => {
    fetchAssetGovernance.mockResolvedValue(DETAIL);
    renderGovernance(testUser({ role: "viewer" }));
    await waitFor(() => {
      expect(screen.getByText(/payroll export/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /run assessment/i })).not.toBeInTheDocument();
  });
});
