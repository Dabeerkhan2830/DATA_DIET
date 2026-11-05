/**
 * Phase 3 retention screens: rendering, states, and advisory-only behavior.
 *
 * The API module is mocked so these tests verify UI behavior without a backend.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hold, PaginatedRecommendations, Policy } from "../api/types";
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
    await userEvent.click(screen.getByRole("button", { name: /create draft/i }));
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
      expect(screen.getByPlaceholderText(/employee records/i)).toBeInTheDocument();
    });
    await userEvent.type(screen.getByPlaceholderText(/employee records/i), "New policy");
    await userEvent.click(screen.getByRole("button", { name: /create draft/i }));
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
    await userEvent.click(screen.getByRole("button", { name: /^create hold$/i }));
    expect(await screen.findByText(/hold name is required/i)).toBeInTheDocument();
    expect(createHold).not.toHaveBeenCalled();
  });
});

describe("Recommendations queue", () => {
  const QUEUE: PaginatedRecommendations = {
    items: [
      {
        asset_id: 3,
        asset_title: "Payroll export",
        recommendation: "BLOCKED_BY_HOLD",
        rationale: "Active hold prevents disposal.",
        severity: null,
        policy_id: 1,
        policy_version_id: 2,
        holds_active: 1,
        assessed_at: "2026-10-10T00:00:00",
        findings: null,
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
});


