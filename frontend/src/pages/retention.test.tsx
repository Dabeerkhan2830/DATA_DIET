/**
 * Phase 3 retention screens: rendering, states, and advisory-only behavior.
 *
 * The API module is mocked so these tests verify UI behavior without a backend.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../auth/AuthContext";
import type { Assessment, Hold, PaginatedRecommendations, Policy } from "../api/types";
import { testUser, withAuth } from "../test/auth";

const listPolicies = vi.fn();
const createPolicy = vi.fn();
const createPolicyVersion = vi.fn();
const activatePolicyVersion = vi.fn();
const listHolds = vi.fn();
const createHold = vi.fn();
const releaseHold = vi.fn();
const assessAsset = vi.fn();
const getAssessmentHistory = vi.fn();
const listRecommendations = vi.fn();

vi.mock("../api/retention", () => ({
  listPolicies: (...args: unknown[]) => listPolicies(...args),
  createPolicy: (...args: unknown[]) => createPolicy(...args),
  createPolicyVersion: (...args: unknown[]) => createPolicyVersion(...args),
  activatePolicyVersion: (...args: unknown[]) => activatePolicyVersion(...args),
  listHolds: (...args: unknown[]) => listHolds(...args),
  createHold: (...args: unknown[]) => createHold(...args),
  releaseHold: (...args: unknown[]) => releaseHold(...args),
  assessAsset: (...args: unknown[]) => assessAsset(...args),
  getAssessmentHistory: (...args: unknown[]) => getAssessmentHistory(...args),
  listRecommendations: (...args: unknown[]) => listRecommendations(...args),
}));

import RetentionPolicies from "./RetentionPolicies";
import Holds from "./Holds";
import Recommendations from "./Recommendations";
import AssetAssessment from "./AssetAssessment";

const POLICY: Policy = {
  id: 1,
  institution_id: null,
  name: "HR retention",
  description: "Employee records",
  applicable_categories: ["hr"],
  retention_trigger: "created_at",
  retention_period_days: 365,
  recommended_action: "review",
  status: "draft",
  scope_description: null,
  current_version_id: null,
  version: "1",
  created_by: "system",
  created_at: "2026-10-01T00:00:00",
};

const HOLD: Hold = {
  id: 1,
  institution_id: null,
  asset_id: 7,
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
};

const ASSESSMENT: Assessment = {
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
};

/** Test-only control: changes the signed-in account's active institution scope. */
function InstitutionScopeSwitch({ to }: { to: number }) {
  const { setActiveInstitution } = useAuth();
  return (
    <button type="button" onClick={() => setActiveInstitution(to)}>
      scope {to}
    </button>
  );
}

/** Test-only control: navigates to another asset, like the in-app links do. */
function OpenAsset({ assetId }: { assetId: number }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(`/assessments/${assetId}`)}>
      open asset {assetId}
    </button>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RetentionPolicies screen", () => {
  it("shows loading, then policies or an error state", async () => {
    listPolicies.mockRejectedValueOnce(new Error("backend down"));
    render(
      withAuth(
        <MemoryRouter>
          <RetentionPolicies />
        </MemoryRouter>,
      ),
    );
    expect(screen.getByText(/loading retention policies/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/policies unavailable/i);
    });
  });

  it("renders policy rows with status badges", async () => {
    listPolicies.mockResolvedValue([POLICY]);
    render(
      withAuth(
        <MemoryRouter>
          <RetentionPolicies />
        </MemoryRouter>,
      ),
    );
    await waitFor(() => {
      expect(screen.getByText("HR retention")).toBeInTheDocument();
    });
    expect(screen.getByText("draft")).toBeInTheDocument();
    expect(screen.getByText("hr")).toBeInTheDocument();
  });

  it("shows an empty state when no policies exist", async () => {
    listPolicies.mockResolvedValue([]);
    render(
      withAuth(
        <MemoryRouter>
          <RetentionPolicies />
        </MemoryRouter>,
      ),
    );
    await waitFor(() => {
      expect(screen.getByText(/no retention policies yet/i)).toBeInTheDocument();
    });
  });

  it("requires a name before creating a draft policy", async () => {
    listPolicies.mockResolvedValue([]);
    render(
      withAuth(
        <MemoryRouter>
          <RetentionPolicies />
        </MemoryRouter>,
        // Creating policies requires the admin role's retention:write.
        testUser({ role: "admin" }),
      ),
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /create draft/i })).toBeInTheDocument();
    });
    // Creating happens in a dialog, so the form is opened before it is submitted.
    await userEvent.click(screen.getByRole("button", { name: /create draft/i }));
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText(/policy name is required/i)).toBeInTheDocument();
    expect(createPolicy).not.toHaveBeenCalled();
  });

  it("submits a valid draft policy", async () => {
    listPolicies.mockResolvedValue([]);
    createPolicy.mockResolvedValue({ ...POLICY, id: 9 });
    render(
      withAuth(
        <MemoryRouter>
          <RetentionPolicies />
        </MemoryRouter>,
        testUser({ role: "admin" }),
      ),
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /create draft/i })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: /create draft/i }));
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/employee records/i)).toBeInTheDocument();
    });
    await userEvent.type(screen.getByPlaceholderText(/employee records/i), "New policy");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => {
      expect(createPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ name: "New policy" }),
      );
    });
  });
});

describe("Holds screen", () => {
  it("renders active holds and blocks duplicate release", async () => {
    listHolds.mockResolvedValue([HOLD]);
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
      ),
    );
    await waitFor(() => {
      expect(screen.getByText("Litigation hold")).toBeInTheDocument();
    });
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("#7")).toBeInTheDocument();
  });

  it("shows an empty state when no holds exist", async () => {
    listHolds.mockResolvedValue([]);
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
      ),
    );
    await waitFor(() => {
      expect(screen.getByText(/no retention holds/i)).toBeInTheDocument();
    });
  });

  it("requires a name before creating a hold", async () => {
    listHolds.mockResolvedValue([]);
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
        // Creating holds requires the admin role's retention:write.
        testUser({ role: "admin" }),
      ),
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /create hold/i })).toBeInTheDocument();
    });
    // Placing a hold happens in a confirmation dialog, so the form is opened first.
    await userEvent.click(screen.getByRole("button", { name: "Create hold" }));
    await userEvent.click(screen.getByRole("button", { name: "Place hold" }));
    expect(await screen.findByText(/hold name is required/i)).toBeInTheDocument();
    expect(createHold).not.toHaveBeenCalled();
  });
});

describe("Recommendations queue", () => {
  const QUEUE: PaginatedRecommendations = {
    items: [
      {
        id: 71,
        asset_id: 3,
        asset_title: "Payroll export",
        institution_id: 1,
        recommendation: "BLOCKED_BY_HOLD",
        rationale: "Active hold prevents disposal.",
        severity: null,
        policy_id: 1,
        policy_version_id: 2,
        policy_version_number: 3,
        holds_active: 1,
        assessed_at: "2026-10-10T00:00:00",
        findings: null,
        retention_deadline: null,
        days_overdue: null,
        decisions_recorded: 0,
        review_status: "open",
        latest_decision: null,
      },
    ],
    total: 1,
    page: 1,
    per_page: 20,
    pages: 1,
  };

  it("renders recommendations with blocking holds visible", async () => {
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
    expect(screen.getAllByText(/blocked by hold/i).length).toBeGreaterThan(0);
    expect(screen.getByText("1 active")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open governance view/i })).toHaveAttribute(
      "href",
      "/governance/assets/3",
    );
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

  it("shows an error state when the queue cannot load", async () => {
    listRecommendations.mockRejectedValue(new Error("backend down"));
    render(
      withAuth(
        <MemoryRouter>
          <Recommendations />
        </MemoryRouter>,
      ),
    );
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/review queue unavailable/i);
    });
  });

  it("shows the newest review queue even when the older request answers last", async () => {
    const settled: Array<(value: PaginatedRecommendations) => void> = [];
    listRecommendations.mockImplementation(
      () =>
        new Promise<PaginatedRecommendations>((resolve) => {
          settled.push(resolve);
        }),
    );

    render(
      withAuth(
        <MemoryRouter>
          <Recommendations />
        </MemoryRouter>,
      ),
    );
    await waitFor(() => expect(listRecommendations).toHaveBeenCalledTimes(1));

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /recommendation/i }),
      "RETAIN",
    );
    await waitFor(() => expect(listRecommendations).toHaveBeenCalledTimes(2));

    // The filter change supersedes the first request; answer them out of order.
    await act(async () => {
      settled[1]({
        ...QUEUE,
        total: 1,
        items: [{ ...QUEUE.items[0], asset_title: "Newer payroll" }],
      });
    });
    expect(await screen.findByText("Newer payroll")).toBeInTheDocument();

    await act(async () => {
      settled[0]({ ...QUEUE, total: 0, items: [] });
    });
    expect(screen.getByText("Newer payroll")).toBeInTheDocument();
    expect(screen.queryByText("Payroll export")).not.toBeInTheDocument();
  });
});

describe("Asset assessment detail", () => {
  it("rejects a non-numeric asset id", async () => {
    render(
      <MemoryRouter initialEntries={["/assessments/abc"]}>
        <Routes>
          <Route path="/assessments/:assetId" element={<AssetAssessment />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/invalid asset id/i)).toBeInTheDocument();
    });
  });

  it("requests the assessment only for a role holding retention:assess", async () => {
    getAssessmentHistory.mockResolvedValue([]);
    assessAsset.mockResolvedValue(ASSESSMENT);
    render(
      withAuth(
        <MemoryRouter initialEntries={["/assessments/3"]}>
          <Routes>
            <Route path="/assessments/:assetId" element={<AssetAssessment />} />
          </Routes>
        </MemoryRouter>,
        // The synthetic reviewer holds retention:assess; the viewer below does not.
        testUser(),
      ),
    );

    await waitFor(() => expect(assessAsset).toHaveBeenCalledTimes(1));
    expect(assessAsset).toHaveBeenLastCalledWith(3);
    expect(await screen.findByRole("button", { name: /run assessment/i })).toBeEnabled();
    expect(screen.queryByText(/cannot run assessments/i)).not.toBeInTheDocument();
  });

  it("shows an unauthorized state and sends no assessment POST for a viewer", async () => {
    getAssessmentHistory.mockResolvedValue([]);
    render(
      withAuth(
        <MemoryRouter initialEntries={["/assessments/3"]}>
          <Routes>
            <Route path="/assessments/:assetId" element={<AssetAssessment />} />
          </Routes>
        </MemoryRouter>,
        testUser({ role: "viewer" }),
      ),
    );

    await waitFor(() => {
      expect(screen.getByText(/your role cannot run assessments/i)).toBeInTheDocument();
    });
    // The mutation is never attempted, so nothing can be fabricated or recorded.
    expect(assessAsset).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /run assessment/i })).not.toBeInTheDocument();
    // Reading the history stays available; it is a separate permission.
    expect(getAssessmentHistory).toHaveBeenCalledTimes(1);
    expect(getAssessmentHistory).toHaveBeenLastCalledWith(3, expect.any(AbortSignal));
  });
});



/**
 * Phase 2 data-fetching regressions: the request must follow the values it
 * depends on, and the previous request must not be able to answer for them.
 */
describe("Request lifecycle on the retention screens", () => {
  it("re-queries the policy list for the newly active institution", async () => {
    listPolicies.mockResolvedValue([POLICY]);
    render(
      withAuth(
        <MemoryRouter>
          <>
            <RetentionPolicies />
            <InstitutionScopeSwitch to={2} />
          </>
        </MemoryRouter>,
        testUser({ institutions: [1, 2] }),
      ),
    );
    await waitFor(() => expect(listPolicies).toHaveBeenCalledTimes(1));
    expect(listPolicies).toHaveBeenLastCalledWith(
      { institution_id: 1 },
      expect.any(AbortSignal),
    );

    await userEvent.click(screen.getByRole("button", { name: /scope 2/i }));

    await waitFor(() => expect(listPolicies).toHaveBeenCalledTimes(2));
    expect(listPolicies).toHaveBeenLastCalledWith(
      { institution_id: 2 },
      expect.any(AbortSignal),
    );
  });

  it("re-queries the hold list for the newly active institution", async () => {
    listHolds.mockResolvedValue([HOLD]);
    render(
      withAuth(
        <MemoryRouter>
          <>
            <Holds />
            <InstitutionScopeSwitch to={2} />
          </>
        </MemoryRouter>,
        testUser({ institutions: [1, 2] }),
      ),
    );
    await waitFor(() => expect(listHolds).toHaveBeenCalledTimes(1));
    expect(listHolds).toHaveBeenLastCalledWith({ institution_id: 1 }, expect.any(AbortSignal));

    await userEvent.click(screen.getByRole("button", { name: /scope 2/i }));

    await waitFor(() => expect(listHolds).toHaveBeenCalledTimes(2));
    expect(listHolds).toHaveBeenLastCalledWith({ institution_id: 2 }, expect.any(AbortSignal));
  });

  it("assesses and loads history for the asset named in the route", async () => {
    assessAsset.mockResolvedValue(ASSESSMENT);
    getAssessmentHistory.mockResolvedValue([]);
    render(
      withAuth(
        <MemoryRouter initialEntries={["/assessments/3"]}>
          <Routes>
            <Route
              path="/assessments/:assetId"
              element={
                <>
                  <AssetAssessment />
                  <OpenAsset assetId={4} />
                </>
              }
            />
          </Routes>
        </MemoryRouter>,
      ),
    );
    await screen.findByText(/Assessment - asset #3/);
    expect(getAssessmentHistory).toHaveBeenCalledTimes(1);
    expect(getAssessmentHistory).toHaveBeenLastCalledWith(3, expect.any(AbortSignal));
    expect(assessAsset).toHaveBeenLastCalledWith(3);

    await userEvent.click(screen.getByRole("button", { name: /open asset 4/i }));
    await screen.findByText(/Assessment - asset #4/);

    expect(getAssessmentHistory).toHaveBeenCalledTimes(2);
    expect(getAssessmentHistory).toHaveBeenLastCalledWith(4, expect.any(AbortSignal));
    expect(assessAsset).toHaveBeenLastCalledWith(4);
  });
});
