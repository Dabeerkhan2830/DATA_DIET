/**
 * Classification workspace (redesign Phase 5.4): rendering, states, permission
 * gate, institution scope, request lifecycle and advisory-only behaviour.
 *
 * The API module is mocked, so these tests prove the screen's wiring and wording;
 * the endpoint URLs, methods and query parameters themselves are asserted against
 * the real contract in `api/classification.test.ts`, and the live round trip is
 * reported separately.
 */

import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AssetQualityReport,
  ClassificationResult,
  ClassificationResultList,
  ClassificationRules,
  QualityCheckDescriptor,
} from "../api/types";
import { platformAdmin, testUser, withAuth } from "../test/auth";
import type { UserProfile } from "../api/types";

const fetchClassificationRules = vi.fn();
const fetchQualityChecks = vi.fn();
const runClassification = vi.fn();
const fetchLatestClassification = vi.fn();
const fetchClassificationHistory = vi.fn();
const fetchAssetQuality = vi.fn();

vi.mock("../api/classification", () => ({
  CLASSIFICATION_PREFIX: "/api/v1/classification",
  fetchClassificationRules: (...args: unknown[]) => fetchClassificationRules(...args),
  fetchQualityChecks: (...args: unknown[]) => fetchQualityChecks(...args),
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
    {
      rule_id: "sensitivity-extension",
      field: "file_name",
      effect: "propose_sensitivity",
      confidence: "high",
      description: "Extension suggests a sensitive document type.",
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

/** The documented check catalogue, `GET /classification/checks`. */
const CHECKS: QualityCheckDescriptor[] = [
  {
    check: "missing-required-metadata",
    severity: "medium",
    description: "A required inventory field is blank.",
    remediation: "Complete the missing metadata from the source system.",
  },
  {
    check: "possible-duplicate",
    severity: "medium",
    description: "Two assets share a safe metadata key but no confirmed checksum.",
    remediation: "A human must confirm whether these are the same data.",
  },
  {
    check: "stale-observation",
    severity: "low",
    description: "The source modification timestamp is older than the threshold.",
    remediation: "Re-scan the source to refresh the observation.",
  },
];

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
  classified_at: "2026-10-15T09:30:00",
};

/** A result produced by a superseded rule version, and one for another asset. */
const STALE_RESULT: ClassificationResult = {
  ...RESULT,
  id: 9,
  rule_version: "classification-v0",
};

const OTHER_RESULT: ClassificationResult = {
  ...RESULT,
  id: 22,
  asset_id: 4,
  input_fingerprint: "eee555000111",
};

/**
 * Two stored results, newest first, each with its own fingerprint — history rows
 * are distinct records, so a fingerprint read on screen identifies exactly one.
 */
const HISTORY: ClassificationResultList = {
  results: [
    RESULT,
    { ...RESULT, id: 10, confidence: "low", proposed_category: null, input_fingerprint: "ffeefd654321" },
  ],
  total: 2,
  page: 1,
  per_page: 10,
  total_pages: 1,
};

/** The same asset with twelve stored results, so the pager has two pages. */
const HISTORY_FIRST_PAGE: ClassificationResultList = {
  ...HISTORY,
  total: 12,
  total_pages: 2,
};

const HISTORY_PAGE_TWO: ClassificationResultList = {
  results: [{ ...RESULT, id: 4, confidence: "none", proposed_sensitivity: "unknown" }],
  total: 12,
  page: 2,
  per_page: 10,
  total_pages: 2,
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
  fetchQualityChecks.mockResolvedValue(CHECKS);
  fetchLatestClassification.mockRejectedValue(new Error("no_classification"));
  fetchClassificationHistory.mockResolvedValue({ results: [], total: 0, page: 1, per_page: 10, total_pages: 1 });
  fetchAssetQuality.mockResolvedValue({ asset_id: 3, findings: [] });
});

/** Render the route with a signed-in identity and an optional starting URL. */
function renderClassification(user: UserProfile | null = testUser(), entry = "/classification"): void {
  render(
    withAuth(
      <MemoryRouter initialEntries={[entry]}>
        <Classification />
      </MemoryRouter>,
      user,
    ),
  );
}

/** Load an asset through the id picker; latest/quality/history resolve too. */
async function loadAsset(id = "3"): Promise<void> {
  const field = screen.getByLabelText(/record id/i);
  await userEvent.clear(field);
  await userEvent.type(field, id);
  await userEvent.click(screen.getByRole("button", { name: /load record/i }));
}

/** Activate one of the workspace sections. */
async function openSection(name: string): Promise<void> {
  await userEvent.click(screen.getByRole("tab", { name }));
}

function mockReadyAsset(overrides: Partial<ClassificationResult> = {}): void {
  fetchLatestClassification.mockResolvedValue({ ...RESULT, ...overrides });
  fetchClassificationHistory.mockResolvedValue(HISTORY);
  fetchAssetQuality.mockResolvedValue(QUALITY);
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
    expect(screen.getByText(/choose a record/i)).toBeInTheDocument();
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
      expect(screen.getByText(/choose a record/i)).toBeInTheDocument();
    });
    await userEvent.type(screen.getByLabelText(/record id/i), "abc");
    await userEvent.click(screen.getByRole("button", { name: /load record/i }));
    expect(await screen.findByText(/positive whole number/i)).toBeInTheDocument();
    expect(fetchLatestClassification).not.toHaveBeenCalled();
  });

  it("renders the proposal with evidence, confidence meaning, and warnings", async () => {
    mockReadyAsset();
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
    expect(screen.getByText(/never proves contents/i)).toBeInTheDocument();
    // History row keeps the rule version and fingerprint visible.
    expect(screen.getByText(/abc123def456/i)).toBeInTheDocument();
  });

  it("shows an explicit empty state when the asset was never classified", async () => {
    fetchLatestClassification.mockRejectedValue(new Error("no_classification"));
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
    render(
      withAuth(
        <MemoryRouter>
          <Classification />
        </MemoryRouter>,
      ),
    );
    await loadAsset();
    await waitFor(() => {
      expect(screen.getAllByRole("alert")[0]).toHaveTextContent(/classification unavailable/i);
    });
  });

  it("runs a classification on request without mutating anything", async () => {
    mockReadyAsset();
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
      expect(runClassification).toHaveBeenCalledWith(3, { institutionId: 1 });
    });
  });

  it("renders quality findings with severity and duplicate status badges", async () => {
    mockReadyAsset();
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
    mockReadyAsset();
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

describe("asset selection and request lifecycle", () => {
  it("reads nothing but the catalogues and runs no classification on mount", async () => {
    renderClassification(testUser({ role: "admin" }));
    await waitFor(() => {
      expect(fetchClassificationRules).toHaveBeenCalled();
    });
    expect(fetchQualityChecks).toHaveBeenCalled();
    expect(fetchLatestClassification).not.toHaveBeenCalled();
    expect(fetchClassificationHistory).not.toHaveBeenCalled();
    expect(fetchAssetQuality).not.toHaveBeenCalled();
    expect(runClassification).not.toHaveBeenCalled();
  });

  it("reads the four asset endpoints for the chosen asset only after a click", async () => {
    mockReadyAsset();
    renderClassification();
    await loadAsset();
    await waitFor(() => {
      expect(fetchLatestClassification).toHaveBeenCalledWith(3, expect.any(AbortSignal), {
        institutionId: 1,
      });
    });
    expect(fetchClassificationHistory).toHaveBeenCalledWith(
      3,
      { page: 1, per_page: 10 },
      expect.any(AbortSignal),
      { institutionId: 1 },
    );
    expect(fetchAssetQuality).toHaveBeenCalledWith(3, expect.any(AbortSignal), { institutionId: 1 });
    // Selecting an asset is a read; it never posts.
    expect(runClassification).not.toHaveBeenCalled();
  });

  it("restores the asset from the address so a selection is shareable", async () => {
    mockReadyAsset();
    renderClassification(testUser(), "/classification?asset=3");
    await waitFor(() => {
      expect(screen.getByText(/result #11, classified .* by test-suite under classification-v1/i)).toBeInTheDocument();
    });
    expect(fetchLatestClassification).toHaveBeenCalledWith(3, expect.any(AbortSignal), {
      institutionId: 1,
    });
  });

  it("drops a stale read when the asset changes before the first answer", async () => {
    const pending = new Map<number, (value: ClassificationResult) => void>();
    fetchLatestClassification.mockImplementation(
      (assetId: number) =>
        new Promise<ClassificationResult>((resolve) => {
          pending.set(assetId, resolve);
        }),
    );
    fetchClassificationHistory.mockResolvedValue(HISTORY);
    fetchAssetQuality.mockResolvedValue(QUALITY);
    renderClassification();

    await loadAsset("3");
    await waitFor(() => expect(pending.has(3)).toBe(true));
    await loadAsset("4");
    await waitFor(() => expect(pending.has(4)).toBe(true));

    // The abandoned answer for asset 3 arrives first and must not be displayed.
    await act(async () => {
      pending.get(3)?.(RESULT);
    });
    await waitFor(() => {
      expect(screen.queryByText(/result #11/i)).not.toBeInTheDocument();
    });
    await act(async () => {
      pending.get(4)?.(OTHER_RESULT);
    });

    await waitFor(() => {
      expect(screen.getByText(/result #22/i)).toBeInTheDocument();
    });
    expect(fetchLatestClassification).toHaveBeenCalledWith(4, expect.any(AbortSignal), {
      institutionId: 1,
    });
  });

  it("explains an asset id the backend does not know", async () => {
    fetchLatestClassification.mockRejectedValue(new Error("asset_not_found"));
    renderClassification();
    await loadAsset("999999");
    await waitFor(() => {
      expect(screen.getByText(/asset_not_found/i)).toBeInTheDocument();
    });
    expect(screen.getByText("Record not found")).toBeInTheDocument();
  });

  it("explains an asset outside the caller's institution scope", async () => {
    fetchLatestClassification.mockRejectedValue(new Error("asset_out_of_scope"));
    renderClassification();
    await loadAsset("42");
    await waitFor(() => {
      expect(screen.getByText(/out_of_scope/i)).toBeInTheDocument();
    });
    expect(screen.getByText("Outside your institution scope")).toBeInTheDocument();
  });

  it("re-reads the result when the refresh control is used after a failure", async () => {
    fetchLatestClassification.mockRejectedValueOnce(new Error("backend down"));
    mockReadyAsset();
    renderClassification(testUser({ role: "admin" }));
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByText(/classification unavailable/i)).toBeInTheDocument();
    });
    const before = fetchLatestClassification.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: /refresh result/i }));
    await waitFor(() => {
      expect(fetchLatestClassification.mock.calls.length).toBeGreaterThan(before);
    });
    await waitFor(() => {
      expect(screen.getByText("Confidential")).toBeInTheDocument();
    });
  });
});

describe("institution scope", () => {
  it("sends no scope for a platform administrator, who reads across institutions", async () => {
    mockReadyAsset();
    renderClassification(platformAdmin());
    await loadAsset();
    await waitFor(() => {
      expect(fetchLatestClassification).toHaveBeenCalledWith(3, expect.any(AbortSignal), undefined);
    });
    expect(screen.getByText(/no institution scope is sent/i)).toBeInTheDocument();
  });

  it("says which scope the reads are sent in for an institutional account", async () => {
    mockReadyAsset();
    renderClassification(testUser({ institutions: [2] }));
    await loadAsset();
    await waitFor(() => {
      expect(fetchLatestClassification).toHaveBeenCalledWith(3, expect.any(AbortSignal), {
        institutionId: 2,
      });
    });
    expect(screen.getByText(/institution_id=2/i)).toBeInTheDocument();
  });
});

describe("permission gate", () => {
  it("offers no run control to a role without classification:write", async () => {
    mockReadyAsset();
    runClassification.mockResolvedValue(RESULT);
    renderClassification(testUser({ role: "viewer" }));
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByText("Confidential")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /run classification/i })).not.toBeInTheDocument();
    expect(
      screen.getByText(/classification:write permission the server verifies/i),
    ).toBeInTheDocument();
    expect(runClassification).not.toHaveBeenCalled();
  });

  it("keeps the catalogues readable for a role that cannot write", async () => {
    mockReadyAsset();
    renderClassification(testUser({ role: "viewer" }));
    await loadAsset();
    await openSection("Rules");
    await waitFor(() => {
      expect(screen.getByText("sensitivity-extension")).toBeInTheDocument();
    });
  });
});

describe("result currency, evidence and rules", () => {
  it("marks a result whose rule version matches the catalogue as current", async () => {
    mockReadyAsset();
    renderClassification();
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByText("Current rule version")).toBeInTheDocument();
    });
    expect(screen.getByText(/matches the catalogue the backend serves now/i)).toBeInTheDocument();
  });

  it("marks a result produced by a superseded rule version as history", async () => {
    mockReadyAsset();
    fetchLatestClassification.mockResolvedValue(STALE_RESULT);
    renderClassification();
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByText("Older rule version")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/a newer rule version is in the catalogue/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Current rule version")).not.toBeInTheDocument();
  });

  it("refuses to judge currency when the rule catalogue is unavailable", async () => {
    fetchClassificationRules.mockRejectedValue(new Error("backend down"));
    mockReadyAsset();
    renderClassification();
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByText("Rule version unknown")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/rule catalogue could not be read, so this result cannot be compared/i),
    ).toBeInTheDocument();
  });

  it("explains evidence with the catalogue entry for the rule that fired", async () => {
    mockReadyAsset();
    renderClassification();
    await loadAsset();
    await waitFor(() => {
      expect(
        screen.getByText(/category from a known record type\. effect: propose category/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/record type observed: hr/i)).toBeInTheDocument();
  });

  it("says so when stored evidence cites a rule the catalogue no longer has", async () => {
    mockReadyAsset({
      evidence: [
        {
          rule_id: "retired-rule",
          rule_version: "classification-v0",
          field: "category",
          observed: "hr",
          proposed_category: "hr",
          proposed_sensitivity: null,
          note: null,
        },
      ],
    });
    renderClassification();
    await loadAsset();
    await waitFor(() => {
      expect(
        screen.getByText(/not in the catalogue the backend serves now/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("retired-rule")).toBeInTheDocument();
  });

  it("shows unresolved conflicts and the protective value chosen for them", async () => {
    mockReadyAsset({
      outcome: "partially_classified",
      confidence: "low",
      conflicts: [
        {
          field: "sensitivity",
          values: ["internal", "restricted"],
          resolved_to: "restricted",
          reason: "protective tie-break",
        },
      ],
    });
    renderClassification();
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByText(/unresolved conflicts \(1\)/i)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/internal vs restricted — resolved to “restricted” \(protective tie-break\)/i),
    ).toBeInTheDocument();
  });

  it("names an explicit unknown rather than a low-risk classification when evidence is empty", async () => {
    mockReadyAsset({
      evidence: [],
      outcome: "unclassified",
      confidence: "none",
      proposed_category: null,
      proposed_sensitivity: "unknown",
    });
    renderClassification();
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByText("No evidence")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/that means unknown, not low risk/i),
    ).toBeInTheDocument();
    // The outcome and the absent category both read "Unclassified": no value is invented.
    expect(screen.getAllByText("Unclassified")).toHaveLength(2);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });
});

describe("history", () => {
  it("lists the stored results newest first with their own fingerprint", async () => {
    mockReadyAsset();
    renderClassification();
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByText(/page 1 of 1 · 2 stored results/i)).toBeInTheDocument();
    });
    await openSection("History");
    // One header row plus the two stored results, in the order the backend sent.
    const rows = within(screen.getByRole("tabpanel")).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Fingerprint");
    expect(rows[1]).toHaveTextContent("abc123def456");
    expect(rows[2]).toHaveTextContent("ffeefd654321");
    expect(rows[1]).toHaveTextContent("classification-v1");
  });

  it("asks the backend for the next page and stops at the bound", async () => {
    mockReadyAsset();
    fetchClassificationHistory.mockImplementation((_id: number, params?: { page: number }) =>
      Promise.resolve(params?.page === 2 ? HISTORY_PAGE_TWO : HISTORY_FIRST_PAGE),
    );
    renderClassification();
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByText(/page 1 of 2 · 12 stored results/i)).toBeInTheDocument();
    });
    await openSection("History");
    await userEvent.click(screen.getByRole("button", { name: /older results/i }));
    await waitFor(() => {
      expect(fetchClassificationHistory).toHaveBeenCalledWith(
        3,
        { page: 2, per_page: 10 },
        expect.any(AbortSignal),
        { institutionId: 1 },
      );
    });
    await waitFor(() => {
      expect(screen.getByText(/page 2 of 2 · 12 stored results/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /older results/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /newer results/i })).toBeEnabled();
  });

  it("reports a history read failure without hiding the other sections", async () => {
    mockReadyAsset();
    fetchClassificationHistory.mockRejectedValue(new Error("backend down"));
    renderClassification();
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByText("Confidential")).toBeInTheDocument();
    });
    await openSection("History");
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/history unavailable/i);
    });
    await openSection("Data quality");
    expect(screen.getByRole("tabpanel")).toHaveTextContent(/data quality findings/i);
  });
});

describe("data quality", () => {
  it("annotates a finding with what its documented check looks at", async () => {
    mockReadyAsset();
    renderClassification();
    await loadAsset();
    await waitFor(() => {
      expect(
        screen.getByText(/what this check looks at: two assets share a safe metadata key/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/fixed set of 3 documented metadata checks/i)).toBeInTheDocument();
  });

  it("counts the findings it shows and repeats that they are advisory", async () => {
    mockReadyAsset();
    renderClassification();
    await loadAsset();
    await waitFor(() => {
      expect(
        screen.getByText(/1 finding for record #3\. advisory only/i),
      ).toBeInTheDocument();
    });
  });

  it("explains that an empty findings list proves nothing about correctness", async () => {
    mockReadyAsset();
    fetchAssetQuality.mockResolvedValue({ asset_id: 3, findings: [] });
    renderClassification();
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByText(/does not prove the metadata is complete or correct/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/3 checks are documented/i)).toBeInTheDocument();
  });

  it("shows the server's own message when the quality analysis fails", async () => {
    mockReadyAsset();
    fetchAssetQuality.mockRejectedValue(new Error("quality unavailable"));
    renderClassification();
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByText(/quality analysis unavailable/i)).toBeInTheDocument();
    });
    expect(screen.getByText("quality unavailable")).toBeInTheDocument();
  });
});

describe("classification run behaviour", () => {
  it("says when a re-run reused the stored result instead of inventing one", async () => {
    mockReadyAsset();
    runClassification.mockResolvedValue(RESULT);
    renderClassification(testUser({ role: "admin" }));
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run classification/i })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: /run classification/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/returned the stored result #11 unchanged/i),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/no new row was added/i),
    ).toBeInTheDocument();
  });

  it("announces the first recorded result for an asset that had none", async () => {
    fetchLatestClassification.mockRejectedValue(new Error("no_classification"));
    fetchClassificationHistory.mockResolvedValue(HISTORY);
    runClassification.mockResolvedValue(RESULT);
    renderClassification(testUser({ role: "admin" }));
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run classification/i })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: /run classification/i }));
    await waitFor(() => {
      expect(screen.getByText(/recorded the first classification result for record #3/i)).toBeInTheDocument();
    });
  });

  it("reports a refused run plainly and re-reads what the server actually has", async () => {
    mockReadyAsset();
    runClassification.mockRejectedValue(new Error("insufficient_permission"));
    renderClassification(testUser({ role: "admin" }));
    await loadAsset();
    const reads = fetchLatestClassification.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: /run classification/i }));
    await waitFor(() => {
      expect(screen.getByText(/the server did not accept the run/i)).toBeInTheDocument();
    });
    expect(screen.getByText("insufficient_permission")).toBeInTheDocument();
    expect(screen.queryByText(/recorded a new result/i)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(fetchLatestClassification.mock.calls.length).toBeGreaterThan(reads);
    });
  });

  it("hides a run answer that arrives for an asset the operator left", async () => {
    mockReadyAsset();
    // Each asset keeps its own stored result, so the answer shown is identifiable.
    fetchLatestClassification.mockImplementation((assetId: number) =>
      Promise.resolve(assetId === 4 ? OTHER_RESULT : RESULT),
    );
    let resolveRun: ((value: ClassificationResult) => void) | undefined;
    runClassification.mockImplementation(
      () => new Promise<ClassificationResult>((resolve) => (resolveRun = resolve)),
    );
    renderClassification(testUser({ role: "admin" }));
    await loadAsset("3");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run classification/i })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: /run classification/i }));
    await loadAsset("4");
    await waitFor(() => {
      expect(screen.getByText(/result #22/i)).toBeInTheDocument();
    });
    // The in-flight answer for asset #3 lands after the operator has moved on.
    await act(async () => {
      resolveRun?.(RESULT);
    });
    expect(screen.queryByText(/result #11, classified/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/unchanged: the metadata produced/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/did not accept the run/i)).not.toBeInTheDocument();
  });
});

describe("workspace sections and accessibility", () => {
  it("gives the sections a tablist whose panel belongs to the selected tab", async () => {
    mockReadyAsset();
    renderClassification();
    await loadAsset();
    const tablist = screen.getByRole("tablist", { name: /classification sections/i });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Latest classification",
      "History",
      "Data quality",
      "Rules",
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", tabs[0].id);
    expect(tabs[0]).toHaveAttribute("aria-controls", panel.id);
  });

  it("moves and activates sections with the arrow keys", async () => {
    mockReadyAsset();
    renderClassification();
    await loadAsset();
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    await waitFor(() => {
      expect(screen.getAllByRole("tab")[1]).toHaveAttribute("aria-selected", "true");
    });
    expect(document.activeElement).toBe(screen.getAllByRole("tab")[1]);
    fireEvent.keyDown(screen.getAllByRole("tab")[1], { key: "Home" });
    await waitFor(() => {
      expect(screen.getAllByRole("tab")[0]).toHaveAttribute("aria-selected", "true");
    });
  });

  it("hides an inactive section without unmounting it", async () => {
    mockReadyAsset();
    renderClassification();
    await loadAsset();
    const latestText = screen.getByText(/the newest suggestion for record #3/i);
    expect(latestText).toBeVisible();
    await openSection("History");
    expect(latestText).not.toBeVisible();
    expect(latestText.closest("[hidden]")).not.toBeNull();
    await openSection("Latest classification");
    expect(latestText).toBeVisible();
  });

  it("opens the stored history from the result summary", async () => {
    mockReadyAsset();
    renderClassification();
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByText("Current rule version")).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: /open full result/i }));
    expect(screen.getByText(/the newest suggestion for record #3/i)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /compare with the stored history/i }));
    await waitFor(() => {
      expect(screen.getByText(/page 1 of 1 · 2 stored results/i)).toBeVisible();
    });
  });

  it("clears the selection and returns to the catalogue view", async () => {
    mockReadyAsset();
    renderClassification();
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByText("Confidential")).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: /clear selection/i }));
    await waitFor(() => {
      expect(screen.getByText(/choose a record/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByText("category-record-type")).toBeInTheDocument();
  });

  it("keeps exactly one page heading and puts section headings under it", async () => {
    mockReadyAsset();
    renderClassification();
    await loadAsset();
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        /classification & data quality/i,
      );
    });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      within(screen.getByRole("tabpanel")).getByRole("heading", { level: 2 }),
    ).toHaveTextContent(/latest classification/i);
  });

  it("links the inventory for an account allowed to read it", async () => {
    renderClassification(testUser());
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /data inventory/i })).toBeInTheDocument();
    });
  });

  it("offers no inventory link to an account that cannot read the inventory", async () => {
    renderClassification(testUser({ role: "viewer", permissions: ["governance:read"] }));
    await waitFor(() => {
      expect(screen.getByText(/choose a record/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole("link", { name: /data inventory/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no institution scope is sent|institution_id=/i)).toBeInTheDocument();
  });
});
