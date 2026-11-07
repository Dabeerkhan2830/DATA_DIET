/**
 * Phase 5.7 review-queue workspace tests.
 *
 * `../api/retention` is mocked, so these check the view against the request and
 * response shapes read out of `backend/app/api/routes/retention.py`,
 * `backend/app/api/schemas/retention.py` and `backend/app/services/retention.py`
 * and mirrored in `src/api/retention.ts` / `src/api/types.ts`. The assertions
 * concentrate on what the brief refuses to allow faked: that every control is a
 * request parameter rather than a browser-side slice, that a row shows the
 * server's own record and statuses and nothing invented, that a decision needs
 * two deliberate clicks and carries the row's concurrency tokens, that a 409 is
 * reported as the specific conflict the backend named without claiming success,
 * and that a refusal is never silently retried or papered over by a reload.
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type {
  Decision,
  DecisionInput,
  DecisionValue,
  PaginatedRecommendations,
  RecommendationItem,
} from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { formatDate } from "../lib/format";
import { platformAdmin, testUser, withAuth } from "../test/auth";

const listRecommendations = vi.fn();
const createDecision = vi.fn();
const listSupersessionCandidates = vi.fn();

vi.mock("../api/retention", () => ({
  listRecommendations: (...args: unknown[]) => listRecommendations(...args),
  createDecision: (...args: unknown[]) => createDecision(...args),
  listSupersessionCandidates: (...args: unknown[]) => listSupersessionCandidates(...args),
}));

import { ApiError } from "../api/client";
import Recommendations from "./Recommendations";

/** An open, decidable row: no hold, no decision, a deadline already past. */
const OPEN_ITEM: RecommendationItem = {
  id: 71,
  asset_id: 3,
  asset_title: "Payroll export",
  institution_id: 1,
  recommendation: "DISPOSAL_REVIEW_REQUIRED",
  rationale: "The retention deadline has passed; disposal review is required.",
  severity: "high",
  policy_id: 1,
  policy_version_id: 2,
  policy_version_number: 3,
  holds_active: 0,
  assessed_at: "2026-10-10T09:30:00",
  findings: [
    {
      code: "RETENTION_DEADLINE_PASSED",
      severity: "high",
      message: "The retention deadline 2026-09-01 is 39 days in the past.",
      evidence: { retention_days: 365, file_name: "payroll.csv" },
    },
  ],
  review_status: "open",
  latest_decision: null,
  decisions_recorded: 0,
  retention_deadline: "2026-09-01",
  days_overdue: 39,
};

/** The envelope is built from the rows so `total` cannot drift from `items`. */
function queue(
  items: RecommendationItem[],
  overrides: Partial<PaginatedRecommendations> = {},
): PaginatedRecommendations {
  return {
    items,
    total: items.length,
    page: 1,
    per_page: 20,
    pages: 1,
    ...overrides,
  };
}

function item(overrides: Partial<RecommendationItem>): RecommendationItem {
  return { ...OPEN_ITEM, ...overrides };
}

/** What `POST /retention/assessments/{id}/decisions` returns (201). */
const RECORDED: Decision = {
  id: 11,
  assessment_id: 71,
  asset_id: 3,
  institution_id: 1,
  policy_id: 1,
  policy_version_id: 2,
  recommendation_reviewed: "DISPOSAL_REVIEW_REQUIRED",
  decision: "retain",
  reason: "Operational need continues.",
  reviewer: "Synthetic Reviewer",
  decided_at: "2026-10-15T10:00:00",
  supersedes_decision_id: null,
  is_superseded: false,
  superseded_by_decision_id: null,
};

/** An earlier decision on this asset that a correction may replace. */
const EARLIER_DECISION: Decision = {
  ...RECORDED,
  id: 4,
  assessment_id: 68,
  decision: "reject",
  reason: "Superseded prose is kept on the original row.",
  decided_at: "2026-09-01T09:00:00",
};

/** Test-only control: moves the signed-in account to another institution scope. */
function ScopeSwitch({ to }: { to: number }) {
  const { setActiveInstitution } = useAuth();
  return (
    <button type="button" onClick={() => setActiveInstitution(to)}>
      scope {to}
    </button>
  );
}

function renderQueue(ui: ReactNode, user = testUser()) {
  return render(withAuth(<MemoryRouter>{ui}</MemoryRouter>, user));
}

/** The table row of a named asset, so cell assertions cannot cross rows. */
function rowOf(title: string): HTMLElement {
  const row = screen.getByText(title).closest("tr");
  if (row === null) {
    throw new Error(`No table row rendered for ${title}`);
  }
  return row;
}

/** An announced outcome is only honest if it really is a live region. */
async function announced(pattern: RegExp): Promise<HTMLElement> {
  const message = await screen.findByText(pattern);
  expect(message.closest('[role="status"]')).not.toBeNull();
  return message;
}

/** The banner a recorded decision raises. A refusal must never produce it. */
const RECORDED_CLAIM = /recorded on assessment #71/;

/** The `<dd>` that belongs to a `<dt>`, so an empty field cannot match another's. */
function detailValue(scope: HTMLElement, label: string): string {
  const term = within(scope).getByText(label, { selector: "dt" });
  const value = term.parentElement?.querySelector("dd");
  if (value === null || value === undefined) {
    throw new Error(`No value rendered for ${label}`);
  }
  return value.textContent ?? "";
}

function filterSelect(name: string): HTMLElement {
  return screen.getByRole("combobox", { name });
}

/**
 * Sets a queue date input.
 *
 * `fireEvent.change` instead of `userEvent.type`: jsdom gives a `type="date"`
 * control no segment model, so per-keystroke events never assemble a value,
 * whereas the commit a real browser makes is one change event carrying the
 * `YYYY-MM-DD` string this page's handler reads.
 */
function setDate(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function openEvidence(title = "Payroll export"): Promise<HTMLElement> {
  await userEvent.click(within(rowOf(title)).getByRole("button", { name: "Review evidence" }));
  return screen.findByRole("dialog", { name: new RegExp(title, "i") });
}

async function openDecisionForm(title = "Payroll export"): Promise<HTMLElement> {
  await userEvent.click(within(rowOf(title)).getByRole("button", { name: "Record decision" }));
  return screen.findByRole("dialog", { name: "Record a review decision" });
}

function reasonBox(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole("textbox", { name: "Reason" });
}

function decisionSelect(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole("combobox", { name: "Decision" });
}

/** The step-one control; recording a decision needs a second deliberate click. */
function reviewButton(dialog: HTMLElement): HTMLButtonElement {
  return within(dialog).getByRole("button", {
    name: "Review this decision before recording",
  }) as HTMLButtonElement;
}

function confirmButton(dialog: HTMLElement): HTMLButtonElement {
  return within(dialog).getByRole("button", { name: "Confirm and record" }) as HTMLButtonElement;
}

/** Drives the form up to, but not including, the confirming click. */
async function stage(dialog: HTMLElement, input: { decision?: DecisionValue; reason: string }) {
  if (input.decision) {
    await userEvent.selectOptions(decisionSelect(dialog), input.decision);
  }
  await userEvent.type(reasonBox(dialog), input.reason);
  await userEvent.click(reviewButton(dialog));
}

/** The last `createDecision` body, typed so payload assertions stay readable. */
function lastDecisionBody(): DecisionInput {
  const call = createDecision.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error("createDecision was never called");
  }
  return call[1] as DecisionInput;
}

function lastQueueParams(): Record<string, unknown> {
  const call = listRecommendations.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error("listRecommendations was never called");
  }
  return call[0] as Record<string, unknown>;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  listRecommendations.mockResolvedValue(queue([OPEN_ITEM]));
  createDecision.mockResolvedValue(RECORDED);
  // By default there is nothing on this asset to correct; tests override per case.
  listSupersessionCandidates.mockResolvedValue([]);
});

describe("what the queue asks the server for", () => {
  it("sends exactly the documented parameters on the first page", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");

    expect(listRecommendations).toHaveBeenCalledTimes(1);
    expect(listRecommendations).toHaveBeenCalledWith(
      {
        page: 1,
        per_page: 20,
        institution_id: 1,
        recommendation: undefined,
        review_status: undefined,
        severity: undefined,
        sort: "urgency",
        search: undefined,
        assessed_from: undefined,
        assessed_to: undefined,
        deadline_from: undefined,
        deadline_to: undefined,
      },
      expect.any(AbortSignal),
    );
    // No invented filter reaches the route: the key set is the contract's.
    expect(Object.keys(lastQueueParams()).sort()).toEqual([
      "assessed_from",
      "assessed_to",
      "deadline_from",
      "deadline_to",
      "institution_id",
      "page",
      "per_page",
      "recommendation",
      "review_status",
      "search",
      "severity",
      "sort",
    ]);
  });

  it("sends the four date ranges with the bounds the route declares", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");

    // `assessed_*` is a datetime column, so a day picked out of a date input
    // has to be widened to that day's first and last second; `deadline_*` is a
    // plain date parameter and goes through unchanged.
    setDate("Assessed on or after", "2026-10-01");
    setDate("Assessed on or before", "2026-10-31");
    setDate("Retention deadline on or after", "2026-01-01");
    setDate("Retention deadline on or before", "2026-12-31");

    await waitFor(() => {
      expect(lastQueueParams()).toEqual(
        expect.objectContaining({
          assessed_from: "2026-10-01T00:00:00",
          assessed_to: "2026-10-31T23:59:59",
          deadline_from: "2026-01-01",
          deadline_to: "2026-12-31",
        }),
      );
    });
  });

  it("leaves a blank date range out of the request instead of sending an empty bound", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");

    setDate("Assessed on or after", "2026-10-01");
    await waitFor(() => {
      expect(lastQueueParams().assessed_from).toBe("2026-10-01T00:00:00");
    });

    setDate("Assessed on or after", "");
    await waitFor(() => {
      expect(lastQueueParams().assessed_from).toBeUndefined();
      // The untouched bounds stay absent too, so no half-open range is sent.
      expect(lastQueueParams().assessed_to).toBeUndefined();
      expect(lastQueueParams().deadline_from).toBeUndefined();
    });
    // With every range empty again the view holds no active filter, so the
    // reset control goes away rather than sitting there doing nothing.
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();

    setDate("Retention deadline on or before", "2026-12-31");
    await waitFor(() => {
      expect(lastQueueParams().deadline_to).toBe("2026-12-31");
    });
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => {
      expect(lastQueueParams().deadline_to).toBeUndefined();
    });
    expect((screen.getByLabelText("Retention deadline on or before") as HTMLInputElement).value).toBe("");
  });

  it("sends every filter control as a request parameter", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");

    const cases: Array<[string, string, string, string]> = [
      ["Review status", "open", "review_status", "open"],
      ["Recommendation", "RETAIN", "recommendation", "RETAIN"],
      ["Severity", "blocked", "severity", "blocked"],
      ["Sort by", "age", "sort", "age"],
    ];
    for (const [label, option, key, expected] of cases) {
      await userEvent.selectOptions(filterSelect(label), option);
      await waitFor(() => {
        expect(lastQueueParams()[key]).toBe(expected);
      });
    }
  });

  it("does not narrow the returned rows in the browser", async () => {
    // The mock answers every request with the same row, so a row that stays
    // visible under an unmatched filter proves the page is not filtering locally.
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");

    await userEvent.selectOptions(filterSelect("Recommendation"), "RETAIN");
    await screen.findByText("Payroll export");
    expect(screen.getByText("Payroll export")).toBeInTheDocument();
  });

  it("returns to the first page when a filter changes", async () => {
    listRecommendations.mockResolvedValue(queue([OPEN_ITEM], { total: 40, page: 1, pages: 2 }));
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");

    await userEvent.click(screen.getByRole("button", { name: /^Next$/ }));
    await waitFor(() => {
      expect(lastQueueParams().page).toBe(2);
    });

    await userEvent.selectOptions(filterSelect("Severity"), "high");
    await waitFor(() => {
      expect(lastQueueParams()).toEqual(
        expect.objectContaining({ page: 1, severity: "high" }),
      );
    });
  });

  it("queries search once the typing settles, not on every keystroke", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    expect(listRecommendations).toHaveBeenCalledTimes(1);

    await userEvent.type(screen.getByRole("searchbox", { name: "Search the queue" }), "payroll");

    expect(listRecommendations).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(lastQueueParams().search).toBe("payroll");
    });
    expect(listRecommendations).toHaveBeenCalledTimes(2);
  });

  it("never asks for an unscoped queue with a tenant account", async () => {
    listRecommendations.mockResolvedValue(
      queue([item({ asset_title: "Board minutes", institution_id: 2 })]),
    );
    renderQueue(
      <>
        <Recommendations />
        <ScopeSwitch to={2} />
      </>,
      testUser({ institutions: [1, 2] }),
    );
    await screen.findByText("Board minutes");

    await userEvent.click(screen.getByRole("button", { name: "scope 2" }));
    await waitFor(() => {
      expect(lastQueueParams().institution_id).toBe(2);
    });

    // Every request the page made carried a scope, including the failure paths.
    expect(
      listRecommendations.mock.calls.every((call) => (call[0] as { institution_id?: number }).institution_id !== undefined),
    ).toBe(true);
    expect(screen.getByText(/the server filtered to institution #2/)).toBeInTheDocument();
  });

  it("sends no institution filter for a platform-wide account and says so", async () => {
    renderQueue(<Recommendations />, platformAdmin());
    await screen.findByText("Payroll export");

    expect(lastQueueParams().institution_id).toBeUndefined();
    expect(screen.getByText(/platform-wide account sent no institution filter/)).toBeInTheDocument();
  });

  it("writes nothing and asks for no correction targets until a form is opened", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");

    await openEvidence();
    expect(createDecision).not.toHaveBeenCalled();
    expect(listSupersessionCandidates).not.toHaveBeenCalled();
  });
});

describe("the rows are the server's records", () => {
  it("renders each cell from the record it arrived with", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const row = rowOf("Payroll export");

    expect(within(row).getByText("asset 3 · institution 1")).toBeInTheDocument();
    expect(within(row).getByText("assessment 71")).toBeInTheDocument();
    // The backend's enum, spaced for reading — not a re-labelled status.
    expect(within(row).getByText("DISPOSAL REVIEW REQUIRED")).toBeInTheDocument();
    expect(
      within(row).getByText("The retention deadline has passed; disposal review is required."),
    ).toBeInTheDocument();
    expect(within(row).getByText("Most urgent finding: high")).toBeInTheDocument();
    expect(within(row).getByText("open")).toBeInTheDocument();
    expect(within(row).getByText("0 recorded")).toBeInTheDocument();
    expect(within(row).getByText("None")).toBeInTheDocument();
    expect(within(row).getByText(formatDate("2026-09-01"))).toBeInTheDocument();
    expect(within(row).getByText("39 d past")).toBeInTheDocument();
    expect(within(row).getByText(formatDate("2026-10-10"))).toBeInTheDocument();
  });

  it("offers only the columns the queue returns", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");

    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).toEqual([
      "Asset",
      "Recommendation",
      "Severity",
      "Review",
      "Holds",
      "Deadline",
      "Assessed",
      "Actions",
    ]);
    // No priority/score/ranking column exists in the contract, so none appears.
    expect(headers.join(" ").toLowerCase()).not.toMatch(/score|priority|rank|owner/);
    // The table is named for a screen reader, from the caption the primitive adds.
    expect(document.querySelector("caption")?.textContent).toBe(
      "Retention recommendations, one row per assessed asset",
    );
    expect(screen.getAllByRole("columnheader").every((cell) => cell.getAttribute("scope") === "col")).toBe(true);
  });

  it("separates the filtered total from the rows on this page", async () => {
    listRecommendations.mockResolvedValue(
      queue([OPEN_ITEM], { total: 40, page: 2, pages: 2 }),
    );
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");

    expect(screen.getByRole("heading", { name: "Recommendations (40)" })).toBeInTheDocument();
    expect(
      screen.getByText(
        /40 assessed assets match this view; 1 of them are on this page, because the server filtered to institution #1/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2 · 40 assessed assets matching")).toBeInTheDocument();
  });

  it("does not present a deadline that has not arrived as overdue", async () => {
    listRecommendations.mockResolvedValue(
      queue([item({ retention_deadline: "2027-01-01", days_overdue: -12 })]),
    );
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const row = rowOf("Payroll export");

    expect(within(row).queryByText(/d past/)).toBeNull();

    // The value is still shown to an operator who asks, with its meaning.
    await openEvidence();
    const dialog = await screen.findByRole("dialog", { name: /Payroll export/i });
    expect(detailValue(dialog, "Retention deadline")).toContain("days_overdue -12");
  });

  it("keeps the decision closed on a row whose assessment id is missing", async () => {
    listRecommendations.mockResolvedValue(queue([item({ id: null })]));
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const row = rowOf("Payroll export");

    // A decision is recorded against an assessment id; without one there is
    // nothing to POST to, so the control must not exist.
    expect(within(row).getByText("no assessment id returned")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Record decision" })).toBeNull();
  });

  it("shows a decided row as decided and offers no further decision", async () => {
    listRecommendations.mockResolvedValue(
      queue([
        item({
          review_status: "decided",
          latest_decision: "approve_for_later_workflow",
          decisions_recorded: 1,
        }),
      ]),
    );
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const row = rowOf("Payroll export");

    expect(within(row).getByText("decided")).toBeInTheDocument();
    expect(within(row).getByText("approve for later workflow")).toBeInTheDocument();
    expect(within(row).getByText("1 recorded")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Record decision" })).toBeNull();
  });

  it("hides the decision control from an account without review:decide", async () => {
    renderQueue(<Recommendations />, testUser({ role: "viewer" }));
    await screen.findByText("Payroll export");
    const row = rowOf("Payroll export");

    expect(within(row).queryByRole("button", { name: "Record decision" })).toBeNull();
    // Reading is still allowed: the evidence view is not a decision control.
    expect(within(row).getByRole("button", { name: "Review evidence" })).toBeEnabled();
  });

  it("links the row to the governance view that holds the history", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");

    expect(
      within(rowOf("Payroll export")).getByRole("link", { name: "Open governance view" }),
    ).toHaveAttribute("href", "/governance/assets/3");
  });

  it("says an empty queue is an empty view, not an eligible asset", async () => {
    listRecommendations.mockResolvedValue(queue([]));
    renderQueue(<Recommendations />);

    await screen.findByText("No items in the review queue");
    expect(
      screen.getByText(/No asset in this scope has been assessed yet/),
    ).toBeInTheDocument();
    expect(screen.getByText(/never implies that any asset is eligible/i)).toBeInTheDocument();
  });

  it("distinguishes an empty filtered view from an unassessed scope", async () => {
    listRecommendations.mockResolvedValue(queue([]));
    renderQueue(<Recommendations />);
    await screen.findByText("No items in the review queue");

    await userEvent.selectOptions(filterSelect("Review status"), "decided");
    await screen.findByText(/matches these filters/);
    expect(screen.getByText(/No assessed asset in the current scope matches these filters/)).toBeInTheDocument();
  });

  it("reports a failed read and recovers on an explicit retry", async () => {
    listRecommendations.mockRejectedValueOnce(new ApiError("The queue could not be read", 503));
    renderQueue(<Recommendations />);

    await screen.findByRole("heading", { name: "Review queue unavailable" });
    expect(screen.getByRole("alert")).toHaveTextContent("The queue could not be read");
    // No stale table is kept next to an error, and nothing is claimed as empty.
    expect(screen.queryByText("Payroll export")).toBeNull();
    expect(screen.queryByText("No items in the review queue")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Payroll export");
    expect(screen.queryByRole("heading", { name: "Review queue unavailable" })).toBeNull();
  });

  it("keeps the current table and marks the view refreshing while a new page loads", async () => {
    listRecommendations.mockResolvedValue(queue([OPEN_ITEM], { total: 40, pages: 2 }));
    const pending = deferred<PaginatedRecommendations>();
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");

    listRecommendations.mockImplementationOnce(() => pending.promise);
    await userEvent.click(screen.getByRole("button", { name: /^Next$/ }));

    // role=status, and the rows already on screen stay until a replacement
    // arrives — a filter change must not blank the table the operator reads.
    const note = await screen.findByText("Refreshing…");
    expect(note.closest('[role="status"]')).not.toBeNull();
    expect(screen.getByText("Payroll export")).toBeInTheDocument();

    pending.resolve(
      queue([item({ asset_title: "Board minutes", id: 88 })], { page: 2, total: 40, pages: 2 }),
    );
    await waitFor(() => {
      expect(screen.queryByText("Refreshing…")).toBeNull();
    });
    expect(await screen.findByText("Board minutes")).toBeInTheDocument();
    expect(screen.queryByText("Payroll export")).toBeNull();
  });

  it("never says a recommendation was applied, archived or executed", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");

    expect(
      screen.getByText(/nothing here archives, restores or deletes a file/),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/recommendation (was )?applied|file deleted/i);
  });
});

describe("the evidence view shows what the row carried", () => {
  it("lists only the fields the queue serializes", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openEvidence();

    expect(
      Array.from(dialog.querySelectorAll("dt")).map((term) => term.textContent),
    ).toEqual([
      "Recommendation",
      "Why this row exists",
      "Review status",
      "Assessment",
      "Applicable policy",
      "Active holds",
      "Retention deadline",
      "Severity",
      "Asset",
    ]);
    expect(detailValue(dialog, "Why this row exists")).toBe(OPEN_ITEM.rationale);
    expect(detailValue(dialog, "Applicable policy")).toBe(
      "policy #1 · version #2 (number 3)",
    );
    expect(detailValue(dialog, "Review status")).toBe(
      "open — no decision is recorded on this assessment (0 recorded)",
    );
    // The raw timestamp is present, not only the formatted date.
    expect(dialog.textContent).toContain("2026-10-10T09:30:00");
  });

  it("renders findings with their stored evidence", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openEvidence();

    expect(within(dialog).getByRole("heading", { name: "Findings (1)" })).toBeInTheDocument();
    expect(dialog.textContent).toContain("RETENTION_DEADLINE_PASSED");
    expect(dialog.textContent).toContain(
      "The retention deadline 2026-09-01 is 39 days in the past.",
    );
    // Evidence is shown as the JSON arrived: key and value, nothing interpreted.
    expect(dialog.textContent).toContain("retention_days 365 · file_name payroll.csv");
  });

  it("says so plainly when an assessment recorded no findings", async () => {
    listRecommendations.mockResolvedValue(
      queue([
        item({
          findings: null,
          severity: null,
          recommendation: "NO_APPLICABLE_POLICY",
          policy_id: null,
          policy_version_id: null,
          policy_version_number: null,
          retention_deadline: null,
          days_overdue: null,
        }),
      ]),
    );
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openEvidence();

    expect(within(dialog).getByRole("heading", { name: "Findings (0)" })).toBeInTheDocument();
    expect(dialog.textContent).toContain("This assessment returned no findings");
    expect(detailValue(dialog, "Severity")).toBe(
      "None — this assessment recorded no findings",
    );
    expect(detailValue(dialog, "Applicable policy")).toBe(
      "None — the engine recorded no policy for this assessment",
    );
    expect(detailValue(dialog, "Retention deadline")).toContain(
      "the engine only sets a deadline for RETAIN and DISPOSAL_REVIEW_REQUIRED",
    );
  });

  it("labels the hold count as the stored snapshot it is", async () => {
    listRecommendations.mockResolvedValue(queue([item({ holds_active: 2 })]));
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    expect(within(rowOf("Payroll export")).getByText("2 active")).toBeInTheDocument();

    const dialog = await openEvidence();
    expect(detailValue(dialog, "Active holds")).toContain(
      "2 active at assessment time. This is the snapshot the assessment stored, not a live count",
    );
  });

  it("closes on Escape without contacting a write endpoint", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    await openEvidence();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(createDecision).not.toHaveBeenCalled();
    expect(listSupersessionCandidates).not.toHaveBeenCalled();
  });

  it("links out to the history the queue does not return", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openEvidence();

    expect(
      within(dialog).getByRole("link", { name: "Open governance view" }),
    ).toHaveAttribute("href", "/governance/assets/3");
  });
});

describe("recording a review decision", () => {
  it("sends nothing until the operator confirms", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openDecisionForm();

    await stage(dialog, { decision: "reject", reason: "The deadline calculation used a wrong trigger date." });

    expect(createDecision).not.toHaveBeenCalled();
    // The confirmation panel restates what is about to be written.
    expect(within(dialog).getByText("Confirm: record reject")).toBeInTheDocument();
    expect(detailValue(dialog, "Decision")).toBe("reject");
    expect(detailValue(dialog, "Reason")).toBe(
      "The deadline calculation used a wrong trigger date.",
    );
    expect(detailValue(dialog, "Correction")).toBe(
      "Independent decision — replaces no earlier decision",
    );
    expect(
      within(dialog).getByText(/appends one decision row against assessment #71/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/cannot be edited or undone from this page/),
    ).toBeInTheDocument();

    await userEvent.click(confirmButton(dialog));
    await waitFor(() => {
      expect(createDecision).toHaveBeenCalledTimes(1);
    });
  });

  it("posts the chosen decision against the row's assessment with its tokens", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openDecisionForm();

    await stage(dialog, { reason: "Operational need continues." });
    await userEvent.click(confirmButton(dialog));

    await waitFor(() => {
      expect(createDecision).toHaveBeenCalledWith(
        71,
        {
          decision: "retain",
          reason: "Operational need continues.",
          supersedes_decision_id: null,
          expected_assessed_at: "2026-10-10T09:30:00",
          expected_policy_version_id: 2,
          expected_holds_active: 0,
        },
        1,
      );
    });
  });

  it("shows the concurrency tokens the submission will carry", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openDecisionForm();

    expect(dialog.textContent).toContain("assessment #71");
    expect(dialog.textContent).toContain("policy version #2 (number 3)");
    expect(dialog.textContent).toContain("0 active holds at assessment time");
    expect(
      within(dialog).getByText(/refuses the decision as stale/),
    ).toBeInTheDocument();
  });

  it("records each of the four decision values the endpoint accepts", async () => {
    const cases: Array<{ value: DecisionValue; reason: string }> = [
      { value: "retain", reason: "keep" },
      { value: "approve_for_later_workflow", reason: "endorsed" },
      { value: "request_more_information", reason: "The trigger date needs proving." },
      { value: "reject", reason: "The deadline was computed from the wrong trigger." },
    ];
    for (const { value, reason } of cases) {
      createDecision.mockClear();
      const { unmount } = renderQueue(<Recommendations />);
      await screen.findByText("Payroll export");
      const dialog = await openDecisionForm();

      // Only a rejection or an information request carries the 10-character floor,
      // so the short reasons below must be accepted exactly as the server would.
      await stage(dialog, { decision: value, reason });
      await userEvent.click(confirmButton(dialog));

      await waitFor(() => {
        expect(lastDecisionBody()).toEqual(
          expect.objectContaining({ decision: value, reason }),
        );
      });
      await announced(/Nothing was archived, restored or deleted/);
      unmount();
    }
    expect(createDecision).toHaveBeenCalledTimes(1);
  });

  it("reports the recorded decision from the response and re-reads the queue", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const before = listRecommendations.mock.calls.length;
    const dialog = await openDecisionForm();

    await stage(dialog, { reason: "Operational need continues." });
    await userEvent.click(confirmButton(dialog));

    const banner = await announced(/Decision "retain" recorded on assessment #71/);
    expect(banner.textContent).toContain("decision #11 by Synthetic Reviewer");
    expect(banner.textContent).toContain(formatDate("2026-10-15"));
    expect(banner.textContent).toContain("Nothing was archived, restored or deleted");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => {
      expect(listRecommendations.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it("sends one request while a decision is in flight", async () => {
    const pending = deferred<Decision>();
    createDecision.mockImplementationOnce(() => pending.promise);
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openDecisionForm();

    await stage(dialog, { reason: "Operational need continues." });
    await userEvent.click(confirmButton(dialog));

    const busy = confirmButton(dialog);
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(within(dialog).getByRole("button", { name: "Back to the form" })).toBeDisabled();
    await act(async () => {
      await userEvent.click(busy, { pointerEventsCheck: 0 });
    });
    expect(createDecision).toHaveBeenCalledTimes(1);

    pending.resolve(RECORDED);
    await announced(/recorded on assessment #71/);
    expect(createDecision).toHaveBeenCalledTimes(1);
  });

  it("blocks approving a lifecycle change while the assessment holds one", async () => {
    listRecommendations.mockResolvedValue(queue([item({ holds_active: 1, recommendation: "BLOCKED_BY_HOLD" })]));
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openDecisionForm();

    expect(
      within(dialog).getByText(/approving a lifecycle-advancing recommendation/),
    ).toBeInTheDocument();
    const approve = decisionSelect(dialog).querySelector(
      'option[value="approve_for_later_workflow"]',
    ) as HTMLOptionElement | null;
    expect(approve?.disabled).toBe(true);
    // The remaining three stay available, exactly as the copy states.
    for (const value of ["retain", "request_more_information", "reject"]) {
      expect(
        (decisionSelect(dialog).querySelector(`option[value="${value}"]`) as HTMLOptionElement)
          .disabled,
      ).toBe(false);
    }
  });

  it("needs a reason before a decision can be recorded", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openDecisionForm();

    expect(reviewButton(dialog)).toBeDisabled();
    await userEvent.type(reasonBox(dialog), " ");
    expect(reviewButton(dialog)).toBeDisabled();

    await userEvent.type(reasonBox(dialog), "k");
    await waitFor(() => {
      expect(reviewButton(dialog)).toBeEnabled();
    });
  });

  it("mirrors the backend's substantive-reason rule", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openDecisionForm();

    // A rejection under 10 characters is refused before the round trip.
    await userEvent.selectOptions(decisionSelect(dialog), "reject");
    await userEvent.type(reasonBox(dialog), "too short");
    expect(
      within(dialog).getByText(
        "A rejection or request for more information needs a substantive reason (at least 10 characters).",
      ),
    ).toBeInTheDocument();
    expect(reasonBox(dialog)).toHaveAttribute("aria-invalid", "true");
    expect(reviewButton(dialog)).toBeDisabled();

    // A retain has no such floor, matching the same validator.
    await userEvent.selectOptions(decisionSelect(dialog), "retain");
    expect(screen.queryByText(/needs a substantive reason/)).toBeNull();
    expect(reviewButton(dialog)).toBeEnabled();
  });

  it("offers only the correction targets the server names for this assessment", async () => {
    listSupersessionCandidates.mockResolvedValue([EARLIER_DECISION]);
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");

    const dialog = await openDecisionForm();
    await waitFor(() => {
      expect(listSupersessionCandidates).toHaveBeenCalledWith(71, expect.any(AbortSignal));
    });

    const correction = await within(dialog).findByRole("combobox", { name: "Correction" });
    const options = Array.from(correction.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual([
      "Independent decision — does not replace any earlier decision",
      `#4 · reject on assessment #68 · ${formatDate("2026-09-01")}`,
    ]);
  });

  it("sends no correction target unless one is chosen", async () => {
    listSupersessionCandidates.mockResolvedValue([EARLIER_DECISION]);
    // The success copy quotes the response, so the correction case needs the
    // response the server would actually return for it.
    createDecision
      .mockResolvedValueOnce(RECORDED)
      .mockResolvedValueOnce({ ...RECORDED, id: 12, supersedes_decision_id: 4 });
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openDecisionForm();

    await stage(dialog, { reason: "Operational need continues." });
    await userEvent.click(confirmButton(dialog));
    await waitFor(() => {
      expect(lastDecisionBody().supersedes_decision_id).toBeNull();
    });

    await userEvent.click(await screen.findByRole("button", { name: "Record decision" }));
    const again = await screen.findByRole("dialog", { name: "Record a review decision" });
    await userEvent.type(reasonBox(again), "correct");
    await userEvent.selectOptions(
      await within(again).findByRole("combobox", { name: "Correction" }),
      "4",
    );
    // Choosing a target raises the correction rule, as the same validator does.
    expect(
      within(again).getByText(
        "A decision that supersedes an earlier decision needs a substantive reason (at least 10 characters) explaining the correction.",
      ),
    ).toBeInTheDocument();
    expect(reviewButton(again)).toBeDisabled();

    await userEvent.type(reasonBox(again), "ed after the trigger date was verified.");
    await userEvent.click(reviewButton(again));
    expect(detailValue(again, "Correction")).toBe("Supersedes decision #4");
    await userEvent.click(confirmButton(again));

    await waitFor(() => {
      expect(lastDecisionBody()).toEqual(
        expect.objectContaining({
          supersedes_decision_id: 4,
          decision: "retain",
          reason: "corrected after the trigger date was verified.",
        }),
      );
    });
    await announced(/It supersedes decision #4, which stays in the history/);
  });

  it("keeps a row without an institution unscoped on the write", async () => {
    // The backend's own semantics: a scope the row does not carry 404s, so the
    // page echoes the row rather than the sidebar.
    listRecommendations.mockResolvedValue(queue([item({ institution_id: null })]));
    renderQueue(<Recommendations />, platformAdmin());
    await screen.findByText("Payroll export");
    const dialog = await openDecisionForm();

    await stage(dialog, { reason: "Operational need continues." });
    await userEvent.click(confirmButton(dialog));

    await waitFor(() => {
      expect(createDecision).toHaveBeenCalledWith(
        71,
        expect.objectContaining({ decision: "retain" }),
        undefined,
      );
    });
    expect(within(rowOf("Payroll export")).getByText("asset 3")).toBeInTheDocument();
  });

  it("names a stale-review conflict and records nothing", async () => {
    createDecision.mockRejectedValue(
      new ApiError(
        "stale_review_conflict: a newer assessment exists for this asset. The review page is out " +
          "of date; reload it and decide on the current assessment and policy version.",
        409,
      ),
    );
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openDecisionForm();

    await stage(dialog, { reason: "Operational need continues." });
    await userEvent.click(confirmButton(dialog));

    const alert = await within(dialog).findByRole("alert");
    expect(within(alert).getByText("This review is out of date")).toBeInTheDocument();
    expect(alert.textContent).toContain("a newer assessment exists for this asset");
    expect(
      within(alert).getByText(/Nothing was recorded and this form still holds what you typed/),
    ).toBeInTheDocument();
    expect(
      within(alert).getByText(/written to the server's audit trail even though no decision row/),
    ).toBeInTheDocument();
    // The refusal is focused, so a screen reader lands on what changed.
    expect(document.activeElement).toBe(alert);
    // No success is claimed and nothing is retried or reloaded behind the click.
    expect(screen.queryByText(RECORDED_CLAIM)).toBeNull();
    expect(createDecision).toHaveBeenCalledTimes(1);
    expect(within(alert).getByRole("button", { name: "Reload the queue" })).toBeInTheDocument();
  });

  it("lets the operator re-read the queue after a conflict instead of resubmitting", async () => {
    createDecision.mockRejectedValue(new ApiError("stale_review_conflict: unchanged", 409));
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const before = listRecommendations.mock.calls.length;
    const dialog = await openDecisionForm();

    await stage(dialog, { reason: "Operational need continues." });
    await userEvent.click(confirmButton(dialog));

    const alert = await within(dialog).findByRole("alert");
    await userEvent.click(within(alert).getByRole("button", { name: "Reload the queue" }));

    await waitFor(() => {
      expect(listRecommendations.mock.calls.length).toBeGreaterThan(before);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/recorded on assessment/i)).toBeNull();
    expect(createDecision).toHaveBeenCalledTimes(1);
  });

  it("names a hold conflict", async () => {
    createDecision.mockRejectedValue(
      new ApiError("hold_conflict: an active retention hold blocks approving any lifecycle-advancing recommendation.", 409),
    );
    listRecommendations.mockResolvedValue(queue([item({ holds_active: 0 })]));
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openDecisionForm();

    // A hold placed after this row loaded is what the server re-counts.
    await stage(dialog, { decision: "approve_for_later_workflow", reason: "Endorsed for the later workflow." });
    await userEvent.click(confirmButton(dialog));

    const alert = await within(dialog).findByRole("alert");
    expect(within(alert).getByText("Blocked by an active hold")).toBeInTheDocument();
    expect(alert.textContent).toContain("hold_conflict");
    expect(screen.queryByText(/recorded on assessment/i)).toBeNull();
  });

  it("names the append-only refusal when a decision already exists", async () => {
    createDecision.mockRejectedValue(
      new ApiError(
        "This assessment already has a recorded decision. Re-assess the asset and decide on the new " +
          "assessment; past decisions are never overwritten.",
        409,
      ),
    );
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openDecisionForm();

    await stage(dialog, { reason: "Operational need continues." });
    await userEvent.click(confirmButton(dialog));

    const alert = await within(dialog).findByRole("alert");
    expect(
      within(alert).getByText("A decision is already recorded for this assessment"),
    ).toBeInTheDocument();
    expect(alert.textContent).toContain("past decisions are never overwritten");
    expect(screen.queryByText(RECORDED_CLAIM)).toBeNull();
    // The queue still shows the row: a refusal does not restamp the record.
    expect(within(rowOf("Payroll export")).getByText("assessment 71")).toBeInTheDocument();
  });

  it("names a correction the server will not accept", async () => {
    listSupersessionCandidates.mockResolvedValue([EARLIER_DECISION]);
    createDecision.mockRejectedValue(
      new ApiError(
        "That decision has already been superseded by another correction; reload the review history " +
          "and correct the current effective decision.",
        409,
      ),
    );
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openDecisionForm();

    await userEvent.selectOptions(
      await within(dialog).findByRole("combobox", { name: "Correction" }),
      "4",
    );
    await stage(dialog, { reason: "Corrected after the trigger date was verified." });
    await userEvent.click(confirmButton(dialog));

    const alert = await within(dialog).findByRole("alert");
    expect(within(alert).getByText("The correction target was refused")).toBeInTheDocument();
    expect(screen.queryByText(/recorded on assessment/i)).toBeNull();
  });

  it("reports a server-side permission refusal as the server said it", async () => {
    // The wording is `core/auth.py`'s `_forbidden(...)` for a failed
    // `require_permission(PERMISSION_REVIEW_DECIDE)`, prefix and all.
    createDecision.mockRejectedValue(
      new ApiError(
        "forbidden: This action requires the 'review:decide' permission, which reviewer@example.org does not have.",
        403,
      ),
    );
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openDecisionForm();

    await stage(dialog, { reason: "Operational need continues." });
    await userEvent.click(confirmButton(dialog));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("This action requires the 'review:decide' permission");
    expect(within(dialog).getByText("Decision not recorded")).toBeInTheDocument();
    // A control the account could see was still refused by the server: the page
    // reports that rather than pretending the row is decidable again.
    expect(screen.queryByText(RECORDED_CLAIM)).toBeNull();
    expect(document.activeElement).toBe(alert);
  });

  it("reports a 404 correction target as an error, not a conflict", async () => {
    listSupersessionCandidates.mockResolvedValue([EARLIER_DECISION]);
    createDecision.mockRejectedValue(
      new ApiError("The decision being superseded does not exist.", 404),
    );
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openDecisionForm();

    await userEvent.selectOptions(
      await within(dialog).findByRole("combobox", { name: "Correction" }),
      "4",
    );
    await stage(dialog, { reason: "Corrected after the trigger date was verified." });
    await userEvent.click(confirmButton(dialog));

    await within(dialog).findByRole("alert");
    expect(within(dialog).getByText("Decision not recorded")).toBeInTheDocument();
    expect(within(dialog).queryByText("The correction target was refused")).toBeNull();
    expect(screen.queryByText(/recorded on assessment/i)).toBeNull();
  });

  it("keeps the reason typed when the server refuses", async () => {
    createDecision.mockRejectedValue(new ApiError("stale_review_conflict: unchanged", 409));
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openDecisionForm();

    await stage(dialog, { reason: "Operational need continues." });
    await userEvent.click(confirmButton(dialog));

    const alert = await within(dialog).findByRole("alert");
    expect(within(alert).getByText("This review is out of date")).toBeInTheDocument();
    // The confirmation panel still holds what was typed.
    expect(detailValue(dialog, "Reason")).toBe("Operational need continues.");
    // and the operator can go back to it rather than start over.
    await userEvent.click(within(dialog).getByRole("button", { name: "Back to the form" }));
    expect(reasonBox(dialog)).toHaveValue("Operational need continues.");
  });

  it("stays put while a decision is being recorded", async () => {
    const pending = deferred<Decision>();
    createDecision.mockImplementationOnce(() => pending.promise);
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openDecisionForm();

    await stage(dialog, { reason: "Operational need continues." });
    await userEvent.click(confirmButton(dialog));

    // Escape cannot drop a submission the server is still processing.
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Record a review decision" })).toBeInTheDocument();

    pending.resolve(RECORDED);
    await announced(/recorded on assessment #71/);
  });

  it("keeps keyboard focus inside the form and out of the page behind it", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");
    const dialog = await openDecisionForm();

    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      ),
    );
    focusables.at(-1)?.focus();
    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);

    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("labels every control the queue offers", async () => {
    renderQueue(<Recommendations />);
    await screen.findByText("Payroll export");

    expect(screen.getAllByRole("combobox")).toHaveLength(4);
    for (const label of ["Review status", "Recommendation", "Severity", "Sort by"]) {
      expect(screen.getByRole("combobox", { name: label })).toBeEnabled();
    }
    expect(screen.getByRole("searchbox", { name: "Search the queue" })).toBeInTheDocument();
    // Eight controls, eight programmatic labels — including the date ranges,
    // which a screen reader must be able to name as bounds rather than as
    // anonymous text fields.
    for (const label of [
      "Assessed on or after",
      "Assessed on or before",
      "Retention deadline on or after",
      "Retention deadline on or before",
    ]) {
      const control = screen.getByLabelText(label) as HTMLInputElement;
      expect(control.type).toBe("date");
      expect(control).toBeEnabled();
    }

    const dialog = await openDecisionForm();
    expect(within(dialog).getByRole("textbox", { name: "Reason" })).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Decision" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});
