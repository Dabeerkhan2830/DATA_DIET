import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardSummary, Permission, UserProfile } from "../api/types";
import { DASHBOARD_SUMMARY, envelope } from "../test/fixtures";
import { testUser, withAuth } from "../test/auth";
import Dashboard from "./Dashboard";

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Server Error",
    json: async () => payload,
  } as Response;
}

function mockSummary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return { ...DASHBOARD_SUMMARY, ...overrides };
}

/** The card whose header carries this title. */
function cardByTitle(name: RegExp): HTMLElement {
  const card = screen.getByRole("heading", { name }).closest("section");
  if (!card) {
    throw new Error("No card section for that heading");
  }
  return card;
}

/** The metrics panel: a named region, so its entries can be read as a set. */
function ledger(): HTMLElement {
  return screen.getByRole("region", { name: "What data do we have?" });
}

/** One ledger entry, so its value and its hint can be read together. */
function metric(label: string): HTMLElement {
  const term = within(ledger()).getByText(label);
  expect(term.tagName).toBe("DT");
  const row = term.parentElement;
  if (!row) {
    throw new Error("Ledger entry is not paired with its value");
  }
  return row;
}

async function renderDashboard(
  summary: DashboardSummary = mockSummary(),
  user: UserProfile = testUser(),
): Promise<void> {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(envelope(summary)));
  render(
    withAuth(
      <MemoryRouter initialEntries={["/"]}>
        <Dashboard />
      </MemoryRouter>,
      user,
    ),
  );
  await waitFor(() => {
    expect(ledger()).toBeInTheDocument();
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Dashboard", () => {
  it("renders summary figures from the API envelope", async () => {
    await renderDashboard();

    expect(within(metric("Data records")).getByText("14")).toBeInTheDocument();
    expect(within(metric("Waiting for approval")).getByText("3")).toBeInTheDocument();
    expect(within(ledger()).queryByText("Duplicate candidates")).toBeNull();
    expect(
      screen.getByText("Retention policy v3 draft created (synthetic)."),
    ).toBeInTheDocument();
  });

  it("answers the three questions in order and names one next step", async () => {
    await renderDashboard();

    const sections = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(sections.slice(0, 3)).toEqual([
      "What should I do next?",
      "What data do we have?",
      "What needs attention?",
    ]);
    expect(
      screen.getByRole("link", { name: /review 3 items waiting for approval/i }),
    ).toHaveAttribute("href", "/recommendations");
  });

  it("offers browsing when nothing waits for a decision", async () => {
    await renderDashboard(mockSummary({ pending_approvals: 0 }));

    expect(screen.getByRole("link", { name: /browse your data records/i })).toHaveAttribute(
      "href",
      "/inventory",
    );
  });

  it("does not offer a next step the account cannot open", async () => {
    await renderDashboard(mockSummary(), testUser({ permissions: ["inventory:read"] }));

    expect(screen.queryByRole("link", { name: /waiting for approval/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /check data quality/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /browse your data records/i })).toBeInTheDocument();
  });

  it("keeps the supporting distributions behind one disclosure", async () => {
    await renderDashboard();

    const disclosure = screen.getByText("Show the numbers behind this summary").closest("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure?.open).toBe(false);
    expect(disclosure).toHaveTextContent("Sensitivity mix");
    expect(disclosure).toHaveTextContent("Suggested retention action");
  });

  it("requests the same dashboard endpoint it did before the redesign", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(envelope(mockSummary())),
    );
    render(
      withAuth(
        <MemoryRouter initialEntries={["/"]}>
          <Dashboard />
        </MemoryRouter>,
      ),
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/api/v1/demo/dashboard");
  });

  it("labels the data as synthetic", async () => {
    await renderDashboard();

    await waitFor(() => {
      expect(screen.getByRole("note")).toHaveTextContent(/SYNTHETIC DEMO DATA/i);
    });
  });

  it("shows an error state with retry when the API is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));

    render(
      withAuth(
        <MemoryRouter initialEntries={["/"]}>
          <Dashboard />
        </MemoryRouter>,
      ),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByText(/could not reach the datadiet api/i)).toBeInTheDocument();
  });

  it("announces the loading state before the summary arrives", () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(() => undefined));

    render(
      withAuth(
        <MemoryRouter initialEntries={["/"]}>
          <Dashboard />
        </MemoryRouter>,
      ),
    );

    expect(screen.getByRole("status")).toHaveTextContent(/loading dashboard summary/i);
  });

  it("keeps the page heading as the only heading level one", async () => {
    await renderDashboard();

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("folds the two elevated risk bands into one headline figure", async () => {
    await renderDashboard();

    expect(within(metric("High-risk records")).getByText("8")).toBeInTheDocument();
    expect(metric("High-risk records")).toHaveTextContent(/of 14 scored records/i);
  });

  it("states risk band counts and shares as text", async () => {
    await renderDashboard();

    const card = cardByTitle(/where the risk sits/i);
    expect(within(card).getByText("Critical (75–100)")).toBeInTheDocument();
    expect(within(card).getByText("21%")).toBeInTheDocument();
    expect(within(card).getAllByText("36%")).toHaveLength(2);
    expect(within(card).getByText("7%")).toBeInTheDocument();
  });

  it("measures each distribution against its own total, not the record count", async () => {
    await renderDashboard(
      mockSummary({
        total_records: 14,
        by_risk_band: { low: 0, moderate: 0, high: 5, critical: 5 },
      }),
    );

    const card = cardByTitle(/where the risk sits/i);
    expect(within(card).getAllByText("50%")).toHaveLength(2);
    expect(card).toHaveTextContent(/shares are of the 10 scored records/i);
  });

  it("hides the decorative risk bar from assistive technology", async () => {
    await renderDashboard(mockSummary({ by_risk_band: { low: 0, moderate: 5, high: 5, critical: 4 } }));

    const card = cardByTitle(/where the risk sits/i);
    const bar = card.querySelector('div[aria-hidden="true"]');
    expect(bar).not.toBeNull();
    expect(bar?.children).toHaveLength(3);
  });

  it("says so when no record has a risk score", async () => {
    await renderDashboard(mockSummary({ by_risk_band: { low: 0, moderate: 0, high: 0, critical: 0 } }));

    const card = cardByTitle(/where the risk sits/i);
    expect(within(card).getByText(/no records have a risk score/i)).toBeInTheDocument();
    expect(within(card).getAllByText("—")).toHaveLength(4);
  });

  it("links attention items to the areas the account may already see", async () => {
    await renderDashboard();

    const card = cardByTitle(/outstanding items/i);
    expect(within(card).getByRole("link", { name: /possible duplicates/i })).toHaveAttribute(
      "href",
      "/inventory",
    );
    expect(within(card).getByRole("link", { name: /suggested for review/i })).toHaveAttribute(
      "href",
      "/recommendations",
    );
    expect(within(card).getByRole("link", { name: /open retrieval requests/i })).toHaveAttribute(
      "href",
      "/retrieval",
    );
  });

  it("still reports an outstanding count it cannot link for this account", async () => {
    const inventoryOnly: Permission[] = ["inventory:read"];
    await renderDashboard(mockSummary(), testUser({ permissions: inventoryOnly }));

    const card = cardByTitle(/outstanding items/i);
    expect(within(card).getByRole("link", { name: /possible duplicates/i })).toBeInTheDocument();
    expect(within(card).queryByRole("link", { name: /suggested for review/i })).toBeNull();
    expect(within(card).getByText("Suggested for review")).toBeInTheDocument();
    expect(within(card).queryByRole("link", { name: /open retrieval requests/i })).toBeNull();
    expect(within(card).getByText("5")).toBeInTheDocument();
  });

  it("omits attention rows that have nothing outstanding", async () => {
    await renderDashboard(
      mockSummary({
        duplicate_candidates: 0,
        open_retrieval_requests: 0,
        by_retention_action: { retain: 8, archive: 4, review: 2, eligible_for_disposal: 0 },
      }),
    );

    const card = cardByTitle(/outstanding items/i);
    expect(within(card).queryByText("Possible duplicates")).toBeNull();
    expect(within(card).queryByText("Marked ready for disposal")).toBeNull();
    expect(within(card).queryByText("Open retrieval requests")).toBeNull();
    expect(within(card).getByText("Suggested for review")).toBeInTheDocument();
  });

  it("says so when nothing at all is outstanding", async () => {
    await renderDashboard(
      mockSummary({
        duplicate_candidates: 0,
        open_retrieval_requests: 0,
        by_retention_action: { retain: 14, archive: 0, review: 0, eligible_for_disposal: 0 },
      }),
    );

    expect(cardByTitle(/outstanding items/i)).toHaveTextContent(/nothing is waiting for you/i);
  });

  it("shows the sensitivity and action mixes with their own labels", async () => {
    await renderDashboard();

    const sensitivity = cardByTitle(/sensitivity mix/i);
    expect(within(sensitivity).getByText("Restricted")).toBeInTheDocument();
    expect(within(sensitivity).getByText("14 records")).toBeInTheDocument();

    const actions = cardByTitle(/suggested retention action/i);
    expect(within(actions).getByText("Eligible for disposal")).toBeInTheDocument();
    expect(actions).toHaveTextContent(/no retention engine runs yet/i);
  });

  it("marks activity dates as machine-readable times", async () => {
    await renderDashboard();

    const time = document.querySelector("time[datetime='2026-10-12']");
    expect(time).not.toBeNull();
    expect(time?.textContent).not.toBe("2026-10-12");
    expect(
      within(cardByTitle(/recent activity/i)).getByText("synthetic.user@example.edu"),
    ).toBeInTheDocument();
  });

  it("says so when the sample set has recorded no activity", async () => {
    await renderDashboard(mockSummary({ recent_activity: [] }));

    expect(cardByTitle(/recent activity/i)).toHaveTextContent(/no events have been recorded/i);
  });
});
