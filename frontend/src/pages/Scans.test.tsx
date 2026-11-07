/**
 * Phase 5.8 scan-jobs workspace tests.
 *
 * `../api/sources` is mocked, so these check the view against the request and
 * response shapes recorded in `src/api/sources.ts`, which mirror
 * `backend/app/api/routes/connectors.py` and `backend/app/services/scan.py`. The
 * fixtures are field-for-field copies of `ScanJobRead`, `ScanResultRead` and
 * `ScanErrorRead`. The assertions concentrate on the three things this screen
 * must not fake:
 *
 * - the state machine. `VALID_TRANSITIONS` only allows `PENDING → RUNNING |
 *   CANCELLED` and `RUNNING → terminal`, so Run appears on a queued row only,
 *   Cancel on queued/running only, Retry on FAILED / COMPLETED_WITH_ERRORS /
 *   CANCELLED only, and a clean COMPLETED row offers nothing. A 409 is reported
 *   as a rejected transition, never as a success or as something to retry.
 * - the absence of a background run. Every write is answered with the job's
 *   final state, so the screen must not poll, must not show progress and must
 *   say that the response is the outcome.
 * - the boundary of what a scan did. A retry is a new row with
 *   `retried_from_job_id`; the counters are absolute; error rows carry a
 *   root-relative path, never an absolute one.
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type {
  ScanError,
  ScanErrorListResponse,
  ScanJob,
  ScanJobListResponse,
  ScanResult,
  ScanResultListResponse,
  Source,
  SourceListResponse,
  UserProfile,
} from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { platformAdmin, testUser, withAuth } from "../test/auth";

const listScanJobs = vi.fn();
const listSources = vi.fn();
const startScan = vi.fn();
const runScanJob = vi.fn();
const cancelScanJob = vi.fn();
const retryScanJob = vi.fn();
const listScanResults = vi.fn();
const listScanErrors = vi.fn();

vi.mock("../api/sources", () => ({
  listScanJobs: (...args: unknown[]) => listScanJobs(...args),
  listSources: (...args: unknown[]) => listSources(...args),
  startScan: (...args: unknown[]) => startScan(...args),
  runScanJob: (...args: unknown[]) => runScanJob(...args),
  cancelScanJob: (...args: unknown[]) => cancelScanJob(...args),
  retryScanJob: (...args: unknown[]) => retryScanJob(...args),
  listScanResults: (...args: unknown[]) => listScanResults(...args),
  listScanErrors: (...args: unknown[]) => listScanErrors(...args),
}));

import Scans from "./Scans";

/** `ScanJobRead` exactly as the schema returns it. */
const COMPLETED: ScanJob = {
  id: 12,
  data_source_id: 7,
  institution_id: 1,
  status: "COMPLETED",
  batch_size: 500,
  total_discovered: 25,
  total_imported: 20,
  total_skipped: 5,
  total_errors: 0,
  retried_from_job_id: null,
  started_at: "2026-10-02T10:00:00",
  completed_at: "2026-10-02T10:00:04",
  error_message: null,
  created_at: "2026-10-02T09:59:58",
};

const WITH_ERRORS: ScanJob = {
  ...COMPLETED,
  id: 13,
  status: "COMPLETED_WITH_ERRORS",
  total_discovered: 26,
  total_imported: 18,
  total_skipped: 4,
  total_errors: 4,
};

const FAILED: ScanJob = {
  ...COMPLETED,
  id: 14,
  data_source_id: 8,
  status: "FAILED",
  total_discovered: 0,
  total_imported: 0,
  total_skipped: 0,
  total_errors: 0,
  completed_at: "2026-10-03T11:00:00",
  error_message: "Root key 'board' is not configured.",
};

const PENDING: ScanJob = {
  ...COMPLETED,
  id: 15,
  status: "PENDING",
  total_discovered: 0,
  total_imported: 0,
  total_skipped: 0,
  total_errors: 0,
  started_at: null,
  completed_at: null,
  error_message: null,
};

/** A running row: the state the service writes mid-request and nobody else sees. */
const RUNNING: ScanJob = {
  ...COMPLETED,
  id: 16,
  status: "RUNNING",
  completed_at: null,
};

/** The row a retry produced, linked back to the cancelled job it replaced. */
const CANCELLED_RETRY: ScanJob = {
  ...COMPLETED,
  id: 17,
  status: "CANCELLED",
  retried_from_job_id: 12,
  total_errors: 0,
};

const JOBS: ScanJob[] = [CANCELLED_RETRY, RUNNING, PENDING, FAILED, WITH_ERRORS, COMPLETED];

/** A queued job for a source the loaded source page does not contain. */
const ORPHAN: ScanJob = { ...PENDING, id: 18, data_source_id: 99 };

/** `Source` rows, because the start dialog and the source column read them. */
const SYNTH_SOURCE: Source = {
  id: 7,
  institution_id: 1,
  name: "HR test corpus",
  connector_type: "synthetic",
  root_key: null,
  config: { count: 25 },
  status: "active",
  created_by: "reviewer@example.org",
  last_validated_at: "2026-10-01T12:00:00",
  last_validation_ok: true,
  last_validation_message: "Synthetic connector is available.",
  created_at: "2026-10-01T09:00:00",
  updated_at: "2026-10-01T09:00:00",
};

const FOLDER_SOURCE: Source = {
  ...SYNTH_SOURCE,
  id: 8,
  name: "Board archive",
  connector_type: "local_folder",
  root_key: "board",
  config: {},
  status: "inactive",
  last_validated_at: "2026-10-04T12:00:00",
  last_validation_ok: false,
  last_validation_message: "Root key 'board' is not configured.",
};

/** `ScanResultRead` rows. */
const IMPORTED: ScanResult = {
  id: 1,
  scan_job_id: 12,
  source_key: "synthetic:hr-001",
  status: "imported",
  title: "Payroll export March",
  record_type: "document",
  category: "hr_records",
  file_name: null,
  mime_type: "text/csv",
  size_bytes: 20480,
  sensitivity: "internal",
  contains_personal_data: true,
  imported_asset_id: 31,
  note: null,
  error_message: null,
  created_at: "2026-10-02T10:00:01",
};

const SKIPPED: ScanResult = {
  ...IMPORTED,
  id: 2,
  source_key: "synthetic:hr-002",
  status: "skipped",
  title: "Payroll export April",
  sensitivity: "unknown",
  contains_personal_data: false,
  imported_asset_id: null,
  note: "Already recorded in the inventory",
};

const BAD_RECORD: ScanResult = {
  ...IMPORTED,
  id: 3,
  source_key: "board:file-004",
  status: "error",
  title: "board-2024.pdf",
  record_type: "file",
  category: null,
  file_name: "board-2024.pdf",
  mime_type: null,
  size_bytes: 0,
  sensitivity: "unknown",
  imported_asset_id: null,
  note: null,
  error_message: "File could not be opened",
};

/** `ScanErrorRead` rows. */
const HARD_ERROR: ScanError = {
  id: 1,
  scan_job_id: 13,
  source_key: "board:file-004",
  path: "minutes/2024/board-2024.pdf",
  error_message: "File could not be opened",
  severity: "error",
  created_at: "2026-10-02T10:00:02",
};

const TRUNCATION_WARNING: ScanError = {
  id: 2,
  scan_job_id: 13,
  source_key: null,
  path: null,
  error_message: "Filename truncated to 120 characters",
  severity: "warning",
  created_at: "2026-10-02T10:00:03",
};

function jobPage(
  items: ScanJob[],
  overrides: Partial<Omit<ScanJobListResponse, "items">> = {},
): ScanJobListResponse {
  return { items, total: items.length, page: 1, per_page: 20, pages: 1, ...overrides };
}

function sourcePage(
  items: Source[],
  overrides: Partial<Omit<SourceListResponse, "items">> = {},
): SourceListResponse {
  return { items, total: items.length, page: 1, per_page: 100, pages: 1, ...overrides };
}

function resultPage(
  items: ScanResult[],
  overrides: Partial<Omit<ScanResultListResponse, "items">> = {},
): ScanResultListResponse {
  return { items, total: items.length, page: 1, per_page: 50, pages: 1, ...overrides };
}

function errorPage(
  items: ScanError[],
  overrides: Partial<Omit<ScanErrorListResponse, "items">> = {},
): ScanErrorListResponse {
  return { items, total: items.length, page: 1, per_page: 50, pages: 1, ...overrides };
}

/** Test-only control: moves the signed-in account to another institution scope. */
function ScopeSwitch({ to }: { to: number }) {
  const { setActiveInstitution } = useAuth();
  return (
    <button type="button" onClick={() => setActiveInstitution(to)}>
      scope {to}
    </button>
  );
}

function rendered(user: UserProfile = testUser({ role: "admin" })): void {
  render(
    withAuth(
      <MemoryRouter>
        <Scans />
      </MemoryRouter>,
      user,
    ),
  );
}

/** The table row of one job, so cell assertions cannot cross rows. */
function jobRow(id: number): HTMLElement {
  const row = screen.getByText(`#${id}`, { exact: true }).closest("tr");
  if (row === null) {
    throw new Error(`No table row rendered for job ${id}`);
  }
  return row;
}

/**
 * Waits for one job's id cell. `exact` is not a detail: the row of a retry
 * carries "retry of #12" as well, so a substring match would be ambiguous.
 */
async function showsJob(id: number): Promise<void> {
  await screen.findByText(`#${id}`, { exact: true });
}

/** An announced outcome is only honest if it really is a live region. */
async function announced(pattern: RegExp): Promise<HTMLElement> {
  const message = await screen.findByText(pattern);
  expect(message.closest('[role="status"]')).not.toBeNull();
  return message;
}

/** The value shown for one labelled field of a `<dl>`. */
function detailValue(dialog: HTMLElement, label: string): string {
  const term = within(dialog).getByText(label, { selector: "dt" });
  const value = term.parentElement?.querySelector("dd");
  if (value === null || value === undefined) {
    throw new Error(`No value rendered for ${label}`);
  }
  return value.textContent ?? "";
}

async function openStarter(user?: UserProfile): Promise<HTMLElement> {
  // `rendered` defaults the account, and an explicit `undefined` reaches the
  // same default, so one call covers both cases.
  rendered(user);
  await waitFor(() => expect(screen.getByRole("button", { name: "New scan" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "New scan" }));
  return screen.findByRole("dialog", { name: "Start a scan" });
}

/**
 * Opens one row's lifecycle dialog. The titles are the sentence the operator
 * needs ("Start the queued scan #15"), so each action is matched to its own.
 */
async function openAction(
  id: number,
  action: "Run" | "Cancel" | "Retry",
  user?: UserProfile,
): Promise<HTMLElement> {
  rendered(user);
  await showsJob(id);
  await userEvent.click(within(jobRow(id)).getByRole("button", { name: action }));
  const titles = {
    Run: `Start the queued scan #${id}`,
    Cancel: `Cancel this scan job #${id}`,
    Retry: `Retry this scan #${id}`,
  } as const;
  return screen.findByRole("dialog", { name: titles[action] });
}

async function openRows(id: number): Promise<HTMLElement> {
  rendered();
  await showsJob(id);
  await userEvent.click(within(jobRow(id)).getByRole("button", { name: "Records" }));
  return screen.findByRole("dialog", { name: new RegExp(`Job #${id}`, "i") });
}

/** Fills a field with text `userEvent.type` would parse as key descriptors. */
function fill(element: HTMLElement, value: string): void {
  fireEvent.change(element, { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  listScanJobs.mockResolvedValue(jobPage(JOBS));
  listSources.mockResolvedValue(sourcePage([SYNTH_SOURCE, FOLDER_SOURCE]));
  startScan.mockResolvedValue(COMPLETED);
  runScanJob.mockResolvedValue({ ...COMPLETED, id: 15, status: "COMPLETED" });
  cancelScanJob.mockResolvedValue({ ...PENDING, status: "CANCELLED", completed_at: "2026-10-05T09:30:00" });
  retryScanJob.mockResolvedValue({ ...COMPLETED, id: 21, retried_from_job_id: 14 });
  listScanResults.mockResolvedValue(resultPage([IMPORTED, SKIPPED, BAD_RECORD]));
  listScanErrors.mockResolvedValue(errorPage([HARD_ERROR, TRUNCATION_WARNING]));
});

/* --------------------------- what it asks the server ----------------------- */

describe("what the workspace asks the server for", () => {
  it("reads the newest page of jobs and the source page that names them", async () => {
    rendered();
    await showsJob(12);

    expect(listScanJobs).toHaveBeenCalledTimes(1);
    expect(listScanJobs.mock.calls[0][0]).toEqual({
      page: 1,
      per_page: 20,
      status: "",
      data_source_id: undefined,
      institution_id: 1,
    });
    expect(listSources).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 100, institution_id: 1 }),
      expect.anything(),
    );
  });

  it("sends the two filters the list route declares, and no others", async () => {
    rendered();
    await showsJob(12);
    listScanJobs.mockClear();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Status" }), "FAILED");
    await waitFor(() =>
      expect(listScanJobs.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ status: "FAILED" }),
      ),
    );

    listScanJobs.mockClear();
    fill(screen.getByRole("searchbox", { name: "Source id" }), "7");
    await waitFor(() =>
      expect(listScanJobs.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ data_source_id: 7 }),
      ),
    );
  });

  it("waits for the source id to stop changing before asking again", async () => {
    rendered();
    await showsJob(12);
    listScanJobs.mockClear();

    fill(screen.getByRole("searchbox", { name: "Source id" }), "1");
    fill(screen.getByRole("searchbox", { name: "Source id" }), "12");

    await waitFor(() =>
      expect(listScanJobs.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ data_source_id: 12 }),
      ),
    );
    // One settled value, so two keystrokes must not cost two more reads.
    expect(listScanJobs.mock.calls.every((call) => (call[0] as { data_source_id?: number }).data_source_id === 12)).toBe(true);
  });

  it("refuses a source reference that cannot be a number without querying", async () => {
    rendered();
    await showsJob(12);
    listScanJobs.mockClear();

    fill(screen.getByRole("searchbox", { name: "Source id" }), "seven");

    expect(
      await screen.findByText("A source reference is a whole number, or empty."),
    ).toBeInTheDocument();
    await new Promise((done) => setTimeout(done, 400));
    expect(listScanJobs).not.toHaveBeenCalled();
  });

  it("asks the server for the next page", async () => {
    listScanJobs.mockImplementation((query: { page?: number }) =>
      Promise.resolve(jobPage([COMPLETED], { total: 41, page: query.page ?? 1, pages: 3 })),
    );
    rendered();
    await showsJob(12);

    await userEvent.click(screen.getByRole("button", { name: /^Next$/ }));

    await waitFor(() =>
      expect(listScanJobs.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ page: 2 })),
    );
    expect(await screen.findByText("Page 2 of 3 · 41 jobs matching")).toBeInTheDocument();
  });

  it("re-reads the scope when the operator changes institution", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <>
            <ScopeSwitch to={2} />
            <Scans />
          </>
        </MemoryRouter>,
        testUser({ role: "admin", institutions: [1, 2] }),
      ),
    );
    await showsJob(12);
    listScanJobs.mockClear();

    await userEvent.click(screen.getByRole("button", { name: "scope 2" }));

    await waitFor(() =>
      expect(listScanJobs.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ institution_id: 2 }),
      ),
    );
  });

  it("never polls: a settled list stays settled", async () => {
    rendered();
    await showsJob(12);
    await waitFor(() => expect(listScanJobs).toHaveBeenCalledTimes(1));

    // A backend that ran scans in the background would need a timer here. This
    // one finishes inside the request, so any second read would be invented work.
    await new Promise((done) => setTimeout(done, 700));
    expect(listScanJobs).toHaveBeenCalledTimes(1);
  });
});

/* ---------------------------- what it renders ------------------------------ */

describe("what the workspace renders from the response", () => {
  it("shows each job's own identity, batch and counters", async () => {
    rendered();
    await showsJob(12);

    const row = jobRow(12);
    expect(row).toHaveTextContent("batch 500");
    expect(row).toHaveTextContent("HR test corpus");
    expect(row).toHaveTextContent("COMPLETED");
    expect(row).toHaveTextContent("25 discovered, 20 imported, 5 skipped, 0 error rows");
    expect(row).toHaveTextContent("Batch 500");
  });

  it("marks a retry with the job it came from", async () => {
    rendered();
    await showsJob(17);

    expect(jobRow(17)).toHaveTextContent("retry of #12");
  });

  it("names a source it was given, and admits when it was not", async () => {
    listScanJobs.mockResolvedValue(jobPage([ORPHAN]));
    rendered();
    await showsJob(18);

    expect(jobRow(18)).toHaveTextContent("Source #99");
    expect(jobRow(18)).toHaveTextContent("id 99 · inst #1");
  });

  it("says a queued job never started rather than showing an empty timestamp", async () => {
    rendered();
    await showsJob(15);

    expect(jobRow(15)).toHaveTextContent("Never started");
  });

  it("prints the recorded failure with the counters that were written", async () => {
    rendered();
    await showsJob(14);

    expect(jobRow(14)).toHaveTextContent("Root key 'board' is not configured.");
    expect(jobRow(14)).toHaveTextContent("0 discovered, 0 imported, 0 skipped, 0 error rows");
    expect(jobRow(14)).toHaveTextContent("FAILED");
  });

  it("uses the envelope's total for the heading and the pager", async () => {
    listScanJobs.mockResolvedValue(jobPage([COMPLETED], { total: 41, page: 2, pages: 3 }));
    rendered();
    await showsJob(12);

    expect(screen.getByText("Scan jobs (41)")).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 3 · 41 jobs matching")).toBeInTheDocument();
  });

  it("shows a loading state before the response", async () => {
    let resolve: (value: ScanJobListResponse) => void = () => {};
    listScanJobs.mockImplementation(() => new Promise<ScanJobListResponse>((done) => { resolve = done; }));
    rendered();

    expect(screen.getByRole("status")).toHaveTextContent(/loading scan jobs/i);

    await act(async () => {
      resolve(jobPage(JOBS));
    });
    expect(await screen.findByText("#12", { exact: true })).toBeInTheDocument();
  });

  it("shows the server's reason on failure and recovers through Retry", async () => {
    listScanJobs.mockRejectedValueOnce(new ApiError("Scan jobs table unavailable", 500));
    rendered();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/scan jobs unavailable/i);
    expect(alert).toHaveTextContent("Scan jobs table unavailable");

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("#12", { exact: true })).toBeInTheDocument();
  });

  it("treats a 403 as an authorization failure, not as a scope with no jobs", async () => {
    listScanJobs.mockRejectedValue(new ApiError("Missing permission: sources:read", 403));
    rendered();

    expect(await screen.findByRole("alert")).toHaveTextContent("Missing permission: sources:read");
    expect(screen.queryByText(/no scan jobs yet/i)).not.toBeInTheDocument();
  });

  it("says a scope has no runs, and that nothing is waiting to be scheduled", async () => {
    listScanJobs.mockResolvedValue(jobPage([]));
    rendered();

    expect(await screen.findByText("No scan jobs yet")).toBeInTheDocument();
    expect(screen.getByText(/the backend has no scheduler/i)).toHaveTextContent(
      "none is waiting to appear here",
    );
  });

  it("distinguishes a filtered-empty view from an empty scope", async () => {
    listScanJobs.mockResolvedValue(jobPage([]));
    rendered();
    await screen.findByText("No scan jobs yet");

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Status" }), "RUNNING");

    expect(await screen.findByText("No scan job matches this view")).toBeInTheDocument();
    expect(
      screen.getByText(/an empty filtered result says nothing about the runs that do exist/i),
    ).toBeInTheDocument();
  });

  it("names every column and captions the table", async () => {
    rendered();
    await showsJob(12);

    const table = screen.getByRole("table");
    expect(table).toHaveAccessibleName("Scan jobs in the current view");
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Job",
      "Source",
      "Status",
      "Outcome",
      "Started",
      "Completed",
      "Actions",
    ]);
  });

  it("drops the timestamp columns at narrow widths instead of overflowing", async () => {
    rendered();
    await showsJob(12);

    expect(screen.getByRole("columnheader", { name: "Started" })).toHaveClass("lg:table-cell");
    expect(screen.getByRole("columnheader", { name: "Completed" })).toHaveClass("xl:table-cell");
  });
});

/* ------------------------- the transition table rules ---------------------- */

describe("which actions the server's state machine allows", () => {
  it("offers Run and Cancel on a queued job, and no Retry", async () => {
    rendered();
    await showsJob(15);

    const row = jobRow(15);
    expect(within(row).getByRole("button", { name: "Run" })).toBeEnabled();
    expect(within(row).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(within(row).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("offers only Cancel on a running job", async () => {
    rendered();
    await showsJob(16);

    const row = jobRow(16);
    expect(within(row).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(within(row).queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("offers no lifecycle action on a clean completion", async () => {
    rendered();
    await showsJob(12);

    const row = jobRow(12);
    expect(within(row).queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Details" })).toBeEnabled();
  });

  it("offers Retry on each of the three states the service accepts", async () => {
    rendered();
    await showsJob(14);

    for (const id of [13, 14, 17]) {
      expect(within(jobRow(id)).getByRole("button", { name: "Retry" })).toBeEnabled();
    }
  });

  it("spells the transition table out on the button that offers cancellation", async () => {
    rendered();
    await showsJob(15);

    const title = within(jobRow(15))
      .getByRole("button", { name: "Cancel" })
      .getAttribute("title");
    expect(title).toMatch(/only moves a job from PENDING or RUNNING to CANCELLED/i);
    expect(title).toContain('"PENDING"');
    expect(title).toMatch(/terminal states are frozen/i);
  });

  it("hides every write from an account without sources:write but keeps the reads", async () => {
    rendered(testUser({ role: "viewer" }));
    await showsJob(12);

    expect(screen.queryByRole("button", { name: "New scan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Details" })).toHaveLength(JOBS.length);
    expect(screen.getAllByRole("button", { name: "Records" })).toHaveLength(JOBS.length);
  });
});

/* ------------------------------- starting one ------------------------------ */

describe("starting a scan", () => {
  it("says the run happens inside this request and nothing is scheduled", async () => {
    const dialog = await openStarter();

    expect(dialog).toHaveTextContent(/this runs now, in this request/i);
    expect(dialog).toHaveTextContent(/no queue, scheduler or worker/i);
    expect(dialog).toHaveTextContent(/nothing is repeated later on its own/i);
    expect(within(dialog).getByRole("combobox", { name: "Source" })).toHaveFocus();
  });

  it("offers only the source records the list route returned", async () => {
    const dialog = await openStarter();

    const select = within(dialog).getByRole("combobox", { name: "Source" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "HR test corpus — #7 (synthetic) · active",
      "Board archive — #8 (local_folder) · inactive",
    ]);
    expect(within(dialog).getByText(/the 2 source records the list route returned/i)).toBeInTheDocument();
  });

  it("warns when the source page was cut off at the route's limit", async () => {
    listSources.mockResolvedValue(sourcePage([SYNTH_SOURCE, FOLDER_SOURCE], { total: 9 }));
    const dialog = await openStarter();

    expect(
      within(dialog).getByText(/the first 2 source records of 2 or more/i),
    ).toHaveTextContent("find its id and use it in the list filter");
  });

  it("quotes the stored validation evidence for the chosen source", async () => {
    const dialog = await openStarter();

    expect(dialog).toHaveTextContent(/the last check could reach it/i);

    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Source" }), "8");

    expect(
      within(dialog).getByText(/the last check could not reach it/i),
    ).toHaveTextContent("so this scan is likely to fail");
  });

  it("holds the batch size to the range the schema declares", async () => {
    const dialog = await openStarter();
    const batch = within(dialog).getByRole("spinbutton", { name: "Batch size" });

    expect(batch).toHaveAttribute("min", "1");
    expect(batch).toHaveAttribute("max", "5000");

    fill(batch, "5001");
    await userEvent.click(within(dialog).getByRole("button", { name: "Run scan now" }));

    expect(
      within(dialog).getByText(/accepts a batch size between 1 and 5000/i),
    ).toBeInTheDocument();
    expect(startScan).not.toHaveBeenCalled();
  });

  it("refuses a batch size that is not a whole number", async () => {
    const dialog = await openStarter();
    fill(within(dialog).getByRole("spinbutton", { name: "Batch size" }), "12.5");

    await userEvent.click(within(dialog).getByRole("button", { name: "Run scan now" }));

    expect(
      within(dialog).getByText(/a whole number, or empty to use the server default/i),
    ).toBeInTheDocument();
    expect(startScan).not.toHaveBeenCalled();
  });

  it("starts the chosen source with the server's default when the box is empty", async () => {
    const dialog = await openStarter();
    listScanJobs.mockClear();

    await userEvent.click(within(dialog).getByRole("button", { name: "Run scan now" }));

    await waitFor(() => expect(startScan).toHaveBeenCalledWith(7, { batch_size: undefined, run: true }, 1));
  });

  it("reports a finished run as the response's own final state, not as progress", async () => {
    const dialog = await openStarter();
    listScanJobs.mockClear();

    await userEvent.click(within(dialog).getByRole("button", { name: "Run scan now" }));

    const banner = await announced(/finished as "COMPLETED" inside the request/i);
    expect(banner).toHaveTextContent("Scan #12 (source #7)");
    expect(banner).toHaveTextContent("25 discovered, 20 imported, 5 skipped, 0 error rows");
    expect(banner).toHaveTextContent(/there is no background run left to wait for/i);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Start a scan" })).not.toBeInTheDocument();
    await waitFor(() => expect(listScanJobs).toHaveBeenCalledTimes(1));
  });

  it("reports a partial run without dressing it up as success", async () => {
    startScan.mockResolvedValue(WITH_ERRORS);
    const dialog = await openStarter();

    await userEvent.click(within(dialog).getByRole("button", { name: "Run scan now" }));

    const banner = await announced(/finished as "COMPLETED_WITH_ERRORS"/i);
    expect(banner).toHaveTextContent("26 discovered, 18 imported, 4 skipped, 4 error rows");
  });

  it("reports a failed run with the reason the job recorded", async () => {
    startScan.mockResolvedValue(FAILED);
    const dialog = await openStarter();

    await userEvent.click(within(dialog).getByRole("button", { name: "Run scan now" }));

    const banner = await announced(/finished as "FAILED"/i);
    expect(banner).toHaveTextContent('Failure reported: "Root key \'board\' is not configured."');
  });

  it("creates a queued job only when asked to, and says nothing was discovered", async () => {
    startScan.mockResolvedValue(PENDING);
    const dialog = await openStarter();
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: "When to run" }),
      "queued",
    );

    expect(within(dialog).getByText(/only way a pENDING job exists/i)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Create queued job" }));

    await waitFor(() => expect(startScan).toHaveBeenCalledWith(7, { batch_size: undefined, run: false }, 1));
    const banner = await announced(/is queued for source #7/i);
    expect(banner).toHaveTextContent("Nothing has been discovered yet");
    expect(banner).toHaveTextContent(/nothing will begin on its own/i);
  });

  it("refuses to start when the scope has no source records at all", async () => {
    listSources.mockResolvedValue(sourcePage([]));
    const dialog = await openStarter();

    expect(within(dialog).getByRole("combobox", { name: "Source" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: /run scan|create queued/i })).toBeDisabled();
    expect(startScan).not.toHaveBeenCalled();
  });

  it("reports a concurrent-scan 409 as a conflict and offers a reload, not a success", async () => {
    startScan.mockRejectedValue(
      new ApiError("Source 7 already has a queued or running scan", 409),
    );
    const dialog = await openStarter();

    await userEvent.click(within(dialog).getByRole("button", { name: "Run scan now" }));

    const conflict = await within(dialog).findByRole("alert");
    expect(conflict).toHaveTextContent("refused a second concurrent scan");
    expect(conflict).toHaveTextContent("Source 7 already has a queued or running scan");
    expect(conflict).toHaveTextContent(/submitting again is not how this clears/i);
    expect(within(conflict).getByRole("button", { name: "Reload the job list" })).toBeEnabled();
    expect(screen.queryByRole("dialog", { name: "Start a scan" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    listScanJobs.mockClear();
    await userEvent.click(within(conflict).getByRole("button", { name: "Reload the job list" }));
    await waitFor(() => expect(listScanJobs).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "Start a scan" })).not.toBeInTheDocument();
  });

  it("explains a 404 as a scope answer rather than a missing source", async () => {
    startScan.mockRejectedValue(new ApiError("Source not found", 404));
    const dialog = await openStarter();

    await userEvent.click(within(dialog).getByRole("button", { name: "Run scan now" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Source not found");
    expect(alert).toHaveTextContent(/this is not proof that it does not exist/i);
  });

  it("claims no job row exists when the request never arrived", async () => {
    startScan.mockRejectedValue(new ApiError("Could not reach the DataDiet API", 0));
    const dialog = await openStarter();

    await userEvent.click(within(dialog).getByRole("button", { name: "Run scan now" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(/nothing was started or created/i);
    expect(alert).toHaveTextContent("Could not reach the DataDiet API");
  });

  it("says the work is happening inside the request while the submit waits", async () => {
    let resolve: (value: ScanJob) => void = () => {};
    startScan.mockImplementation(() => new Promise<ScanJob>((done) => { resolve = done; }));
    const dialog = await openStarter();

    await userEvent.click(within(dialog).getByRole("button", { name: "Run scan now" }));

    expect(within(dialog).getByRole("status")).toHaveTextContent(
      /the scan runs inside this request, so this can take a while/i,
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Run scan now" }));
    expect(startScan).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve(COMPLETED);
    });
    expect(await announced(/finished as "COMPLETED"/i)).toBeInTheDocument();
  });

  it("sends nothing when the operator cancels the dialog", async () => {
    const dialog = await openStarter();

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog", { name: "Start a scan" })).not.toBeInTheDocument();
    expect(startScan).not.toHaveBeenCalled();
  });

  it("tells an unscoped account the job inherits the source's institution", async () => {
    const dialog = await openStarter(platformAdmin());

    expect(dialog).toHaveTextContent(/the job inherits its institution from the source row/i);
    expect(dialog).not.toHaveTextContent(/Scoped to institution #/);

    await userEvent.click(within(dialog).getByRole("button", { name: "Run scan now" }));

    await waitFor(() =>
      expect(startScan).toHaveBeenCalledWith(7, { batch_size: undefined, run: true }, undefined),
    );
  });
});

/* --------------------------- the lifecycle actions ------------------------- */

describe("running, cancelling and retrying a job", () => {
  it("asks for confirmation before it writes, and writes nothing on the way", async () => {
    const dialog = await openAction(15, "Run");

    expect(dialog).toHaveTextContent(/the job is pending, which is the only state the run endpoint accepts/i);
    expect(dialog).toHaveTextContent(/cannot be paused or rolled back/i);
    expect(within(dialog).getByRole("heading", { name: /#15$/ })).toBeInTheDocument();
    expect(runScanJob).not.toHaveBeenCalled();
  });

  it("shows the row's own state in the confirmation", async () => {
    const dialog = await openAction(14, "Retry");

    expect(detailValue(dialog, "Current status")).toContain("FAILED");
    expect(detailValue(dialog, "Counters so far")).toBe(
      "0 discovered, 0 imported, 0 skipped, 0 error rows",
    );
    expect(detailValue(dialog, "Batch size")).toBe("500");
    expect(detailValue(dialog, "Started / completed")).toBe(
      "2026-10-02T10:00:00 → 2026-10-03T11:00:00",
    );
    expect(detailValue(dialog, "Recorded failure")).toBe("Root key 'board' is not configured.");
  });

  it("says a retry will create a new row instead of moving this one", async () => {
    const dialog = await openAction(14, "Retry");

    expect(dialog).toHaveTextContent(
      /a retry creates a new job for the same source and runs it in this request/i,
    );
    expect(dialog).toHaveTextContent("retried_from_job_id 14");
    expect(dialog).toHaveTextContent(/this row keeps "FAILED" and its counters/i);
  });

  it("runs a queued job only after the confirmation, and reports its final state", async () => {
    const dialog = await openAction(15, "Run");
    listScanJobs.mockClear();

    await userEvent.click(within(dialog).getByRole("button", { name: "Run scan" }));

    await waitFor(() => expect(runScanJob).toHaveBeenCalledWith(15, 1));
    const banner = await announced(/finished as "COMPLETED" inside the request/i);
    expect(banner).toHaveTextContent("Scan #15 (source #7)");
    await waitFor(() => expect(listScanJobs).toHaveBeenCalledTimes(1));
  });

  it("states plainly that cancelling only marks the record", async () => {
    const dialog = await openAction(15, "Cancel");

    expect(dialog).toHaveTextContent(/this marks the job cancelled and stamps its completion time/i);
    expect(dialog).toHaveTextContent(/records already imported stay imported/i);
    expect(within(dialog).getByRole("button", { name: "Cancel job" })).toHaveClass(/bg-critical/);
  });

  it("cancels after the confirmation and says no record was unwritten", async () => {
    const dialog = await openAction(15, "Cancel");

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel job" }));

    await waitFor(() => expect(cancelScanJob).toHaveBeenCalledWith(15, 1));
    const banner = await announced(/is now "CANCELLED"/i);
    expect(banner).toHaveTextContent("Scan #15 (source #7)");
    expect(banner).toHaveTextContent(/cancelling marks the job/i);
    expect(banner).toHaveTextContent(/no record is deleted or unwritten/i);
  });

  it("reports a retry as the new job it created", async () => {
    const dialog = await openAction(14, "Retry");
    listScanJobs.mockClear();

    await userEvent.click(within(dialog).getByRole("button", { name: "Retry as a new job" }));

    await waitFor(() => expect(retryScanJob).toHaveBeenCalledWith(14, 1));
    const banner = await announced(/^Retrying scan #14 created a new job #21/i);
    expect(banner).toHaveTextContent("(retried_from_job_id #14)");
    expect(banner).toHaveTextContent('ran to "COMPLETED"');
    expect(banner).toHaveTextContent("The original row is unchanged");
    expect(banner).toHaveTextContent(/not a continuation/i);
    await waitFor(() => expect(listScanJobs).toHaveBeenCalledTimes(1));
  });

  it("reports a transition the server refused as a refusal, never as a success", async () => {
    // The row still reads PENDING, so the state table offers Cancel; the server
    // has already moved the job on and answers in its own words.
    cancelScanJob.mockRejectedValue(
      new ApiError("A scan in status 'COMPLETED' cannot be cancelled", 409),
    );
    const dialog = await openAction(15, "Cancel");

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel job" }));

    const conflict = await within(dialog).findByRole("alert");
    expect(conflict).toHaveTextContent("A scan in status 'COMPLETED' cannot be cancelled");
    expect(conflict).toHaveTextContent(/the server rejected this as an invalid transition/i);
    expect(conflict).toHaveTextContent(/reload the list and work from the status the server reports/i);
    expect(screen.queryByText(/is now "CANCELLED"/i)).not.toBeInTheDocument();
    expect(cancelScanJob).toHaveBeenCalledTimes(1);

    listScanJobs.mockClear();
    await userEvent.click(within(conflict).getByRole("button", { name: "Reload the job list" }));
    await waitFor(() => expect(listScanJobs).toHaveBeenCalledTimes(1));
  });

  it("surfaces a 409 the server raises against a row that looked actionable", async () => {
    runScanJob.mockRejectedValue(new ApiError("Cannot run a scan in status 'RUNNING'", 409));
    const dialog = await openAction(15, "Run");

    await userEvent.click(within(dialog).getByRole("button", { name: "Run scan" }));

    const conflict = await within(dialog).findByRole("alert");
    expect(conflict).toHaveTextContent("rejected this as an invalid transition");
    expect(conflict).toHaveTextContent("Cannot run a scan in status 'RUNNING'");
    expect(conflict).toHaveTextContent(/the server kept its own state and changed nothing/i);
    expect(conflict).toHaveTextContent(/the transition table will refuse it a second time/i);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    listScanJobs.mockClear();
    await userEvent.click(within(conflict).getByRole("button", { name: "Reload the job list" }));
    await waitFor(() => expect(listScanJobs).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("explains a 404 on a job as a scope answer", async () => {
    retryScanJob.mockRejectedValue(new ApiError("Scan job not found", 404));
    const dialog = await openAction(14, "Retry");

    await userEvent.click(within(dialog).getByRole("button", { name: "Retry as a new job" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Scan job not found");
    expect(alert).toHaveTextContent(/the server answers 404 for another tenant's record/i);
  });

  it("claims nothing changed when the request never succeeded", async () => {
    cancelScanJob.mockRejectedValue(new ApiError("Could not reach the DataDiet API", 0));
    const dialog = await openAction(15, "Cancel");

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel job" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(/nothing was changed by this attempt/i);
    expect(alert).toHaveTextContent("stored status, counters and timestamps are untouched");
  });

  it("sends no institution filter for an unscoped account, and says so", async () => {
    const dialog = await openAction(15, "Run", platformAdmin());

    expect(dialog).toHaveTextContent(
      /no institution filter is sent, so the action is authorised against your platform-wide scope/i,
    );
    expect(dialog).not.toHaveTextContent(/Scoped to institution #/);

    await userEvent.click(within(dialog).getByRole("button", { name: "Run scan" }));

    await waitFor(() => expect(runScanJob).toHaveBeenCalledWith(15, undefined));
  });

  it("refuses a second lifecycle action while one is in flight", async () => {
    let resolve: (value: ScanJob) => void = () => {};
    cancelScanJob.mockImplementation(() => new Promise<ScanJob>((done) => { resolve = done; }));
    rendered();
    await showsJob(15);

    await userEvent.click(within(jobRow(15)).getByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("dialog", { name: /Cancel this scan job #15/i });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel job" }));

    expect(
      within(dialog).getByRole("button", { name: "Cancel job" }),
    ).toHaveAttribute("aria-busy", "true");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel job" }));
    expect(cancelScanJob).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve({ ...PENDING, status: "CANCELLED" });
    });
    expect(await announced(/is now "CANCELLED"/i)).toBeInTheDocument();
  });

  it("writes nothing when the operator goes back", async () => {
    const dialog = await openAction(15, "Cancel");

    await userEvent.click(within(dialog).getByRole("button", { name: "Go back" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(cancelScanJob).not.toHaveBeenCalled();
  });
});

/* ------------------------------ job detail view ---------------------------- */

describe("inspecting one job", () => {
  it("shows every stored field and refuses to invent a percentage", async () => {
    rendered();
    await showsJob(13);
    await userEvent.click(within(jobRow(13)).getByRole("button", { name: "Details" }));

    const dialog = await screen.findByRole("dialog", { name: "Scan job #13" });
    expect(detailValue(dialog, "Source")).toBe('"HR test corpus" (#7)');
    expect(detailValue(dialog, "Status")).toContain("COMPLETED_WITH_ERRORS");
    expect(detailValue(dialog, "What the status means")).toBe(
      "Ran to the end, but at least one record or file produced an error row.",
    );
    expect(detailValue(dialog, "Total discovered")).toBe("26");
    expect(detailValue(dialog, "Total imported")).toBe("18");
    expect(detailValue(dialog, "Total skipped")).toBe("4");
    expect(detailValue(dialog, "Total error rows")).toBe("4");
    expect(detailValue(dialog, "Retried from")).toBe("Not a retry");
    expect(detailValue(dialog, "Error message")).toBe("None recorded");
    // The counters stay absolute: the only "percent" in this dialog is the word
    // inside the sentence that explains why there is no percentage to show.
    expect(dialog).not.toHaveTextContent("%");
    expect(within(dialog).queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("says outright why there is no progress view", async () => {
    rendered();
    await showsJob(16);
    await userEvent.click(within(jobRow(16)).getByRole("button", { name: "Details" }));

    const dialog = await screen.findByRole("dialog", { name: "Scan job #16" });
    expect(
      within(dialog).getByText(/no progress bar and no live view are shown/i),
    ).toHaveTextContent("runs a scan inside the request that starts it");
    expect(dialog).toHaveTextContent("Mid-run inside its own request");
    expect(dialog).toHaveTextContent("not a state another request can normally observe");
  });

  it("quotes the failure a stopped run recorded", async () => {
    rendered();
    await showsJob(14);
    await userEvent.click(within(jobRow(14)).getByRole("button", { name: "Details" }));

    const dialog = await screen.findByRole("dialog", { name: "Scan job #14" });
    expect(detailValue(dialog, "What the status means")).toBe(
      'Stopped before finishing: "Root key \'board\' is not configured.". Counters show what was written up to that point.',
    );
    expect(detailValue(dialog, "Started at")).toBe("2026-10-02T10:00:00");
  });
});

/* --------------------------- results and error rows ------------------------ */

describe("the per-record rows of a job", () => {
  it("reads the outcomes route at the route's own page size", async () => {
    const dialog = await openRows(12);

    await waitFor(() =>
      expect(listScanResults).toHaveBeenCalledWith(
        12,
        { page: 1, per_page: 50, institution_id: 1 },
        expect.anything(),
      ),
    );
    expect(listScanErrors).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent("25 discovered, 20 imported, 5 skipped, 0 error rows");
  });

  it("renders each outcome row from its own fields", async () => {
    const dialog = await openRows(12);
    await within(dialog).findByText("Payroll export March");

    const row = within(dialog).getByText("Payroll export March").closest("tr") as HTMLElement;
    expect(row).toHaveTextContent("synthetic:hr-001");
    expect(row).toHaveTextContent("imported");
    expect(row).toHaveTextContent("Document");
    expect(row).toHaveTextContent("hr_records");
    expect(row).toHaveTextContent("internal");
    expect(row).toHaveTextContent("Flags personal data");
    expect(row).toHaveTextContent("20.0 KB");
    expect(row).toHaveTextContent("text/csv");
    expect(row).toHaveTextContent("#31");
  });

  it("says which rows wrote nothing to the inventory and which failed", async () => {
    const dialog = await openRows(12);
    await within(dialog).findByText("Payroll export April");

    const skipped = within(dialog).getByText("Payroll export April").closest("tr") as HTMLElement;
    expect(skipped).toHaveTextContent("Already recorded in the inventory");
    expect(skipped).toHaveTextContent("No asset written");
    expect(skipped).toHaveTextContent("No personal-data flag");

    const failed = within(dialog)
      .getByText("File could not be opened")
      .closest("tr") as HTMLElement;
    expect(failed).toHaveTextContent("No category");
    expect(failed).toHaveTextContent("No mime type");
    // A file record has no separate title: the row carries the same name in the
    // record column and in the stored file name, and the table keeps both.
    expect(within(failed).getAllByText("board-2024.pdf")).toHaveLength(2);
  });

  it("asks the separate errors route only when the operator switches tabs", async () => {
    const dialog = await openRows(12);
    await within(dialog).findByText("Payroll export March");
    listScanResults.mockClear();

    await userEvent.click(within(dialog).getByRole("tab", { name: "Errors and warnings" }));

    await waitFor(() =>
      expect(listScanErrors).toHaveBeenCalledWith(
        12,
        { page: 1, per_page: 50, institution_id: 1 },
        expect.anything(),
      ),
    );
    expect(listScanResults).not.toHaveBeenCalled();
    expect(
      await within(dialog).findByText("File could not be opened"),
    ).toBeInTheDocument();
  });

  it("labels a recorded path as root-relative, and says when none was recorded", async () => {
    const dialog = await openRows(13);
    await within(dialog).findByText("Record outcomes");
    await userEvent.click(within(dialog).getByRole("tab", { name: "Errors and warnings" }));

    const row = (await within(dialog).findByText("File could not be opened")).closest("tr") as HTMLElement;
    expect(row).toHaveTextContent("minutes/2024/board-2024.pdf (root-relative, never absolute)");
    expect(row).not.toHaveTextContent("C:\\");

    const warning = within(dialog).getByText("Filename truncated to 120 characters").closest("tr") as HTMLElement;
    expect(warning).toHaveTextContent("warning");
    expect(warning).toHaveTextContent("No path recorded");
  });

  it("moves between the two tabs with the keyboard, one panel at a time", async () => {
    const dialog = await openRows(12);
    const results = await within(dialog).findByRole("tab", { name: "Record outcomes" });
    results.focus();

    await userEvent.keyboard("{ArrowRight}");

    expect(within(dialog).getByRole("tab", { name: "Errors and warnings" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(results).toHaveAttribute("tabindex", "-1");
    expect(within(dialog).getAllByRole("tabpanel")).toHaveLength(1);
  });

  it("pages each tab on its own, back to page one after a tab change", async () => {
    listScanResults.mockResolvedValue(resultPage([IMPORTED], { total: 120, pages: 3 }));
    const dialog = await openRows(12);
    await within(dialog).findByText("Payroll export March");

    await userEvent.click(within(dialog).getByRole("button", { name: /^Next$/ }));
    await waitFor(() =>
      expect(listScanResults.mock.calls.at(-1)?.[1]).toEqual(
        expect.objectContaining({ page: 2 }),
      ),
    );

    await userEvent.click(within(dialog).getByRole("tab", { name: "Errors and warnings" }));
    await waitFor(() =>
      expect(listScanErrors.mock.calls.at(-1)?.[1]).toEqual(
        expect.objectContaining({ page: 1 }),
      ),
    );
    expect(screen.getByRole("navigation", { name: "Scan row pagination" })).toBeInTheDocument();
  });

  it("says an outcome page is empty without claiming the source is", async () => {
    listScanResults.mockResolvedValue(resultPage([]));
    const dialog = await openRows(14);

    expect(await within(dialog).findByText("No outcome rows")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/it is not evidence that the source is empty/i),
    ).toBeInTheDocument();
  });

  it("says no error row was recorded without claiming nothing went wrong", async () => {
    listScanErrors.mockResolvedValue(errorPage([]));
    const dialog = await openRows(12);
    await within(dialog).findByText("Payroll export March");

    await userEvent.click(within(dialog).getByRole("tab", { name: "Errors and warnings" }));

    expect(await within(dialog).findByText("No error or warning rows")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/says nothing about records the connector never reached/i),
    ).toBeInTheDocument();
  });

  it("reports a refused row read inside the dialog", async () => {
    listScanResults.mockRejectedValue(new ApiError("Outcome rows are not available", 500));
    const dialog = await openRows(12);

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Outcome rows unavailable");
    expect(alert).toHaveTextContent("Outcome rows are not available");
    expect(within(alert).getByRole("button", { name: /retry/i })).toBeEnabled();
  });

  it("closes without leaving the row request running", async () => {
    const dialog = await openRows(12);
    await within(dialog).findByText("Payroll export March");
    const signal = listScanResults.mock.calls[0][2] as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(signal.aborted).toBe(true);
  });
});
