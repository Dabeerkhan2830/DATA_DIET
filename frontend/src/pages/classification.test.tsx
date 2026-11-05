/**
 * Phase 5 classification screen: rendering, states, and advisory-only behavior.
 *
 * The API module is mocked so these tests verify UI behavior without a backend.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AssetQualityReport,
  ClassificationResult,
  ClassificationResultList,
  ClassificationRules,
} from "../api/types";
import { testUser, withAuth } from "../test/auth";

const fetchClassificationRules = vi.fn();
const runClassification = vi.fn();
const fetchLatestClassification = vi.fn();
const fetchClassificationHistory = vi.fn();
const fetchAssetQuality = vi.fn();

vi.mock("../api/classification", () => ({
  fetchClassificationRules: (...args: unknown[]) => fetchClassificationRules(...args),
  runClassification: (...args: unknown[]) => runClassification(...args),
  fetchLatestClassification: (...args: unknown[]) => fetchLatestClassification(...args),
  fetchClassificationHistory: (...args: unknown[]) => fetchClassificationHistory(...args),
  fetchAssetQuality: (...args: unknown[]) => fetchAssetQuality(...args),
}));

import Classification from "./Classification";

const RULES: ClassificationRules = {
  rule_version: "classification-v1",
  rules: [
    {
      rule_id: "category-record-type",
      field: "record_type",
      effect: "propose_category",
      confidence: "medium",
      description: "Category from a known record type.",
    },
  ],
  confidence_meaning: {
    high: "Multiple independent signals agree.",
    medium: "A single documented rule fired; no stronger signal applied.",
    low: "Weak or conflicting signals.",
    none: "No signal matched; the outcome is unknown.",
  },
  outcomes: ["classified", "partially_classified", "unclassified"],
  sensitivities: ["public", "internal", "confidential", "restricted", "unknown"],
  known_categories: ["hr", "finance"],
  severities: ["info", "low", "medium", "high"],
};

const RESULT: ClassificationResult = {
  id: 11,
  asset_id: 3,
  institution_id: null,
  rule_version: "classification-v1",
  outcome: "classified",
  proposed_category: "hr",
  proposed_sensitivity: "confidential",
  confidence: "medium",
  confidence_meaning: "One documented signal matched.",
  evidence: [
    {
      rule_id: "category-record-type",
      rule_version: "classification-v1",
      field: "record_type",
      observed: "hr",
      proposed_category: "hr",
      proposed_sensitivity: null,
      note: null,
    },
  ],
  warnings: ["Extension metadata is a hint only and never proves contents."],
  conflicts: [],
  input_fingerprint: "abc123def456",
  created_by: "test-suite",
  classified_at: "2026-10-15T00:00:00",
};

const HISTORY: ClassificationResultList = {
  results: [RESULT],
  total: 1,
  page: 1,
  per_page: 10,
  total_pages: 1,
};

const QUALITY: AssetQualityReport = {
  asset_id: 3,
  findings: [
    {
      asset_id: 3,
      check: "possible-duplicate",
      severity: "medium",
      message: "Shares a metadata key with asset 4.",
      fields: ["file_name", "size_bytes"],
      evidence: { peer_asset_id: 4 },
      remediation: "A human must confirm; nothing is merged automatically.",
      duplicate_status: "possible",
      related_asset_id: 4,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchClassificationRules.mockResolvedValue(RULES);
});

/** Load an asset through the id picker; latest/quality/history resolve too. */
async function loadAsset(id = "3"): Promise<void> {
  await userEvent.type(screen.getByLabelText(/asset id/i), id);
  await userEvent.click(screen.getByRole("button", { name: /load asset/i }));
}

describe("Classification screen", () => {
  it("prompts for an asset and shows the versioned rule table", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Classification />
        </MemoryRouter>,
      ),
    );
    await waitFor(() => {
      expect(screen.getByText("classification-v1")).toBeInTheDocument();
    });
    expect(screen.getByText(/select an asset/i)).toBeInTheDocument();
    expect(screen.getByText("category-record-type")).toBeInTheDocument();
    expect(screen.getByText(/no signal matched/i)).toBeInTheDocument();
  });

  it("shows an error state when the rule table fails to load", async () => {
    fetchClassificationRules.mockRejectedValue(new Error("backend down"));
    render(
      withAuth(
        <MemoryRouter>
          <Classification />
        </MemoryRouter>,
      ),
    );
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/rules unavailable/i);
    });
  });

  it("validates the asset id before querying", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Classification />
        </MemoryRouter>,
      ),
    );
    await waitFor(() => {
      expect(screen.getByText(/select an asset/i)).toBeInTheDocument();
    });
    await userEvent.type(screen.getByLabelText(/asset id/i), "abc");
    await userEvent.click(screen.getByRole("button", { name: /load asset/i }));
    expect(await screen.findByText(/positive integer/i)).toBeInTheDocument();
    expect(fetchLatestClassification).not.toHaveBeenCalled();
  });

  it("renders the proposal with evidence, confidence meaning, and warnings", async () => {
    fetchLatestClassification.mockResolvedValue(RESULT);
    fetchClassificationHistory.mockResolvedValue(HISTORY);
    fetchAssetQuality.mockResolvedValue(QUALITY);
    render(
      withAuth(
        <MemoryRouter>
          <Classification />
        </MemoryRouter>,
      ),
    );
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByText("Confidential")).toBeInTheDocument();
    });
    expect(screen.getAllByText("category-record-type").length).toBeGreaterThan(0);
    expect(screen.getByText("hr")).toBeInTheDocument();
    expect(screen.getByText(/one documented signal matched/i)).toBeInTheDocument();
    expect(
      screen.getByText(/never proves contents/i),
    ).toBeInTheDocument();
    // History row keeps the rule version and fingerprint visible.
    expect(screen.getByText(/abc123def456/i)).toBeInTheDocument();
  });

  it("shows an explicit empty state when the asset was never classified", async () => {
    fetchLatestClassification.mockRejectedValue(new Error("no_classification"));
    fetchClassificationHistory.mockResolvedValue({ ...HISTORY, results: [] });
    fetchAssetQuality.mockResolvedValue({ ...QUALITY, findings: [] });
    render(
      withAuth(
        <MemoryRouter>
          <Classification />
        </MemoryRouter>,
      ),
    );
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByText(/no classification yet/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/classification unavailable/i)).not.toBeInTheDocument();
  });

  it("shows an error state when classification cannot be fetched", async () => {
    fetchLatestClassification.mockRejectedValue(new Error("backend down"));
    fetchClassificationHistory.mockResolvedValue(HISTORY);
    fetchAssetQuality.mockResolvedValue(QUALITY);
    render(
      withAuth(
        <MemoryRouter>
          <Classification />
        </MemoryRouter>,
      ),
    );
    await loadAsset();
    await waitFor(() => {
      expect(screen.getAllByRole("alert")[0]).toHaveTextContent(
        /classification unavailable/i,
      );
    });
  });

  it("runs a classification on request without mutating anything", async () => {
    fetchLatestClassification.mockResolvedValue(RESULT);
    fetchClassificationHistory.mockResolvedValue(HISTORY);
    fetchAssetQuality.mockResolvedValue(QUALITY);
    runClassification.mockResolvedValue(RESULT);
    // Running classification is a write; only the admin role may do it.
    render(
      withAuth(
        <MemoryRouter>
          <Classification />
        </MemoryRouter>,
        testUser({ role: "admin" }),
      ),
    );
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run classification/i })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: /run classification/i }));
    await waitFor(() => {
      expect(runClassification).toHaveBeenCalledWith(3);
    });
  });

  it("renders quality findings with severity and duplicate status badges", async () => {
    fetchLatestClassification.mockResolvedValue(RESULT);
    fetchClassificationHistory.mockResolvedValue(HISTORY);
    fetchAssetQuality.mockResolvedValue(QUALITY);
    render(
      withAuth(
        <MemoryRouter>
          <Classification />
        </MemoryRouter>,
      ),
    );
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByText("possible-duplicate")).toBeInTheDocument();
    });
    expect(screen.getByText("possible duplicate")).toBeInTheDocument();
    expect(screen.getByText(/nothing is merged automatically/i)).toBeInTheDocument();
  });

  it("shows an empty state when no quality findings exist", async () => {
    fetchLatestClassification.mockResolvedValue(RESULT);
    fetchClassificationHistory.mockResolvedValue(HISTORY);
    fetchAssetQuality.mockResolvedValue({ asset_id: 3, findings: [] });
    render(
      withAuth(
        <MemoryRouter>
          <Classification />
        </MemoryRouter>,
      ),
    );
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByText(/no findings/i)).toBeInTheDocument();
    });
  });
});
