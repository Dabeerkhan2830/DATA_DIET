/**
 * Phase 5.8 connected-sources workspace tests.
 *
 * `../api/sources` is mocked, so these check the view against the request and
 * response shapes recorded in `src/api/sources.ts`, which mirror
 * `backend/app/api/routes/connectors.py` and `app/api/schemas/connectors.py`. The
 * fixtures are field-for-field copies of the `Source` response model — including
 * the three `last_validation_*` columns that stay `null` until somebody validates.
 * The assertions concentrate on the claims this screen is not allowed to make:
 * that `status: "active"` is a connection, that a filter the API does not have
 * (name search) is server-side, that a record can be deleted, that a validation
 * proves a scan will work, or that a 403 is an empty scope.
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { Source, SourceListResponse, UserProfile } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { formatDate } from "../lib/format";
import { platformAdmin, testUser, withAuth } from "../test/auth";

const listSources = vi.fn();
const createSource = vi.fn();
const updateSource = vi.fn();
const validateSource = vi.fn();

vi.mock("../api/sources", () => ({
  listSources: (...args: unknown[]) => listSources(...args),
  createSource: (...args: unknown[]) => createSource(...args),
  updateSource: (...args: unknown[]) => updateSource(...args),
  validateSource: (...args: unknown[]) => validateSource(...args),
}));

import Sources from "./Sources";

/** `Source` exactly as `app/api/schemas/connectors.py::Source` returns it. */
const SYNTHETIC: Source = {
  id: 7,
  institution_id: 1,
  name: "HR test corpus",
  connector_type: "synthetic",
  root_key: null,
  config: { count: 25, categories: ["hr_records"] },
  status: "active",
  created_by: "reviewer@example.org",
  last_validated_at: null,
  last_validation_ok: null,
  last_validation_message: null,
  created_at: "2026-10-01T09:00:00",
  updated_at: "2026-10-01T09:00:00",
};

/** A local_folder row whose operator allow-listed it and whose check passed. */
const FOLDER: Source = {
  ...SYNTHETIC,
  id: 8,
  name: "Board archive",
  connector_type: "local_folder",
  root_key: "board",
  config: {},
  created_at: "2026-10-01T09:00:00",
  updated_at: "2026-10-12T08:05:00",
  last_validated_at: "2026-10-12T08:00:00",
  last_validation_ok: true,
  last_validation_message: "Root resolves to an existing directory.",
};

/** Retired, and the last check could not reach it. */
const UNREACHABLE: Source = {
  ...SYNTHETIC,
  id: 9,
  name: "Old export share",
  status: "inactive",
  last_validated_at: "2026-10-14T08:00:00",
  last_validation_ok: false,
  last_validation_message: "Connector refused the configuration.",
};

const ROWS: Source[] = [SYNTHETIC, FOLDER, UNREACHABLE];

/** The same date rendering the row uses, derived from the fixture's timestamp. */
function day(iso: string | null): string {
  return formatDate((iso ?? "").slice(0, 10));
}

function envelope(
  items: Source[],
  overrides: Partial<Omit<SourceListResponse, "items">> = {},
): SourceListResponse {
  return {
    items,
    total: items.length,
    page: 1,
    per_page: 20,
    pages: 1,
    ...overrides,
  };
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

/** The table row of a named source, so cell assertions cannot cross rows. */
function sourceRow(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (row === null) {
    throw new Error(`No table row rendered for ${name}`);
  }
  return row;
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

function rendered(user: UserProfile = testUser({ role: "admin" })): void {
  render(
    withAuth(
      <MemoryRouter>
        <Sources />
      </MemoryRouter>,
      user,
    ),
  );
}

async function openCreator(user: UserProfile = testUser({ role: "admin" })): Promise<HTMLElement> {
  rendered(user);
  await waitFor(() => expect(screen.getByRole("button", { name: "Add source" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Add source" }));
  return screen.findByRole("dialog", { name: "Add source record" });
}

async function openEditor(name: string): Promise<HTMLElement> {
  rendered();
  await screen.findByText(name);
  await userEvent.click(within(sourceRow(name)).getByRole("button", { name: "Edit" }));
  return screen.findByRole("dialog", { name: new RegExp(`Edit "${name}"`, "i") });
}

function nameField(): HTMLElement {
  return screen.getByRole("textbox", { name: "Source name" });
}

function configBox(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole("textbox", { name: /Configuration/ });
}

/**
 * Fills a controlled field with text that is not safe to type.
 *
 * `userEvent.type` parses `{`, `}` and `[` in the string as key descriptors, and
 * every configuration value here is JSON, so the text would be mangled before the
 * component ever saw it. A `change` event is what the controlled input listens to
 * either way.
 */
function fill(element: HTMLElement, value: string): void {
  fireEvent.change(element, { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  listSources.mockResolvedValue(envelope(ROWS));
  createSource.mockResolvedValue({ ...SYNTHETIC, id: 41, name: "Payroll drop" });
  updateSource.mockResolvedValue({ ...SYNTHETIC, status: "inactive" });
  validateSource.mockResolvedValue({
    id: 7,
    ok: true,
    message: "Synthetic connector is available.",
    validated_at: "2026-10-20T10:00:00",
  });
});

/* --------------------------- what it asks the server ----------------------- */

describe("what the workspace asks the server for", () => {
  it("reads the first page at the server's own page size, scoped to the active institution", async () => {
    rendered();

    await screen.findByText("HR test corpus");

    expect(listSources).toHaveBeenCalledTimes(1);
    expect(listSources.mock.calls[0][0]).toEqual({
      page: 1,
      per_page: 20,
      connector_type: "",
      status: "",
      institution_id: 1,
    });
  });

  it("sends the two server-side filters and nothing else", async () => {
    rendered();
    await screen.findByText("HR test corpus");
    listSources.mockClear();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Connector type" }), "local_folder");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Record status" }), "inactive");

    await waitFor(() =>
      expect(listSources.mock.calls.at(-1)?.[0]).toEqual({
        page: 1,
        per_page: 20,
        connector_type: "local_folder",
        status: "inactive",
        institution_id: 1,
      }),
    );
  });

  it("asks the server for the next page rather than slicing the rows on hand", async () => {
    listSources.mockImplementation(
      (query: { page?: number }) =>
        Promise.resolve(
          envelope([FOLDER], { total: 41, page: query.page ?? 1, pages: 3 }),
        ),
    );
    rendered();
    await screen.findByText("Board archive");
    expect(screen.getByRole("button", { name: /^Previous$/ })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: /^Next$/ }));

    await waitFor(() =>
      expect(listSources.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ page: 2 }),
      ),
    );
    expect(await screen.findByText("Page 2 of 3 · 41 sources matching")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Previous$/ })).toBeEnabled();
  });

  it("narrows a name in the browser without asking the server for a search it cannot do", async () => {
    rendered();
    await screen.findByText("HR test corpus");
    listSources.mockClear();

    await userEvent.type(screen.getByRole("searchbox", { name: "Name contains" }), "board");

    expect(await screen.findByText("Board archive")).toBeInTheDocument();
    expect(screen.queryByText("HR test corpus")).not.toBeInTheDocument();
    expect(listSources).not.toHaveBeenCalled();
  });

  it("says the name box only covers the loaded page, because that is all it can cover", async () => {
    rendered();
    await screen.findByText("HR test corpus");

    expect(screen.getByText(/browser-side only: the api has no name search/i)).toHaveTextContent(
      "3 loaded rows",
    );
  });

  it("re-reads the list for a new institution scope", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <>
            <ScopeSwitch to={2} />
            <Sources />
          </>
        </MemoryRouter>,
        testUser({ role: "admin", institutions: [1, 2] }),
      ),
    );
    await screen.findByText("HR test corpus");
    listSources.mockClear();

    await userEvent.click(screen.getByRole("button", { name: "scope 2" }));

    await waitFor(() =>
      expect(listSources.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ institution_id: 2 }),
      ),
    );
    expect(screen.getByText(/Scoped to Institution #2/)).toBeInTheDocument();
  });

  it("offers no delete control, because the connector API has no delete endpoint", async () => {
    rendered();
    await screen.findByText("HR test corpus");

    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
    expect(within(sourceRow("HR test corpus")).getByRole("button", { name: "Edit" })).toBeEnabled();
  });
});

/* ---------------------------- what it renders ------------------------------ */

describe("what the workspace renders from the response", () => {
  it("shows each record's own identity, scope and connector type", async () => {
    rendered();
    const row = await waitFor(() => sourceRow("HR test corpus"));

    expect(row).toHaveTextContent("id 7");
    expect(row).toHaveTextContent("Synthetic");
    expect(row).toHaveTextContent("Institution #1");
    expect(row).toHaveTextContent("active");
    expect(row).toHaveTextContent("Enabled by an operator");
  });

  it("labels an active record as enabled, never as connected", async () => {
    rendered();
    await screen.findByText("HR test corpus");

    expect(within(sourceRow("HR test corpus")).getByText("Enabled by an operator")).toBeInTheDocument();
    expect(within(sourceRow("Old export share")).getByText("Scans are not expected to run")).toBeInTheDocument();
    // The evidence column answers "can it be reached", and for a record nobody
    // has validated the honest answer is that nothing is known.
    expect(within(sourceRow("HR test corpus")).getByText("Never validated")).toBeInTheDocument();
    expect(
      within(sourceRow("Board archive")).getByText(/^Reachable as at/),
    ).toHaveTextContent(day(FOLDER.last_validated_at));
    expect(
      within(sourceRow("Old export share")).getByText(/^Not reachable as at/),
    ).toHaveTextContent(day(UNREACHABLE.last_validated_at));
    expect(within(sourceRow("Old export share")).getByText("Connector refused the configuration.")).toBeInTheDocument();
  });

  it("prints the folder source's allow-list key, not a path", async () => {
    rendered();
    await screen.findByText("Board archive");

    expect(sourceRow("Board archive")).toHaveTextContent("key board");
    expect(screen.getAllByText(/root resolves to an existing directory/i).length).toBeGreaterThan(0);
  });

  it("marks a retired record as one whose scans are not expected", async () => {
    rendered();
    await screen.findByText("Old export share");

    expect(sourceRow("Old export share")).toHaveTextContent("Scans are not expected to run");
  });

  it("renders the server's dates, not the row count, in the header and pagination", async () => {
    listSources.mockResolvedValue(envelope([FOLDER], { total: 41, page: 2, pages: 3 }));
    rendered();
    await screen.findByText("Board archive");

    expect(screen.getByText("Sources (41)")).toBeInTheDocument();
    expect(screen.getByText(`Page 2 of 3 · 41 sources matching`)).toBeInTheDocument();
    expect(
      within(sourceRow("Board archive")).getByText(day(FOLDER.created_at)),
    ).toBeInTheDocument();
    expect(
      within(sourceRow("Board archive")).getByText(day(FOLDER.updated_at)),
    ).toBeInTheDocument();
  });

  it("shows a loading state before the response arrives", async () => {
    let resolve: (value: SourceListResponse) => void = () => {};
    listSources.mockImplementation(() => new Promise<SourceListResponse>((done) => { resolve = done; }));
    rendered();

    expect(screen.getByRole("status")).toHaveTextContent(/loading connected sources/i);

    await act(async () => {
      resolve(envelope(ROWS));
    });
    expect(await screen.findByText("HR test corpus")).toBeInTheDocument();
  });

  it("shows the error state with the server's reason and recovers on retry", async () => {
    listSources.mockRejectedValueOnce(new ApiError("Sources table unavailable", 500));
    rendered();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/sources unavailable/i);
    expect(alert).toHaveTextContent("Sources table unavailable");
    expect(screen.queryByText("HR test corpus")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("HR test corpus")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("treats a 403 as an authorization failure, never as an empty scope", async () => {
    listSources.mockRejectedValue(new ApiError("Missing permission: sources:read", 403));
    rendered();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Missing permission: sources:read");
    expect(screen.queryByText(/no source records yet/i)).not.toBeInTheDocument();
  });

  it("says an empty scope is empty without implying the table is empty everywhere", async () => {
    listSources.mockResolvedValue(envelope([]));
    rendered();

    expect(await screen.findByText("No source records yet")).toBeInTheDocument();
    expect(
      screen.getByText(/nothing is connected in this scope/i),
    ).toHaveTextContent("an operator adds a configuration record explicitly");
  });

  it("distinguishes a filtered-empty view from a genuinely empty scope", async () => {
    listSources.mockResolvedValue(envelope([]));
    rendered();
    await screen.findByText("No source records yet");

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Record status" }), "inactive");

    expect(await screen.findByText("No source matches this view")).toBeInTheDocument();
    expect(screen.queryByText(/nothing is connected in this scope/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/an empty filtered view says nothing about the sources that do exist/i),
    ).toBeInTheDocument();
  });

  it("says which of its filters can only ever narrow the loaded page", async () => {
    rendered();
    await screen.findByText("HR test corpus");

    await userEvent.type(screen.getByRole("searchbox", { name: "Name contains" }), "zzz");

    expect(await screen.findByText("No source matches this view")).toBeInTheDocument();
    expect(
      screen.getByText(/the name box only narrows the rows already loaded/i),
    ).toBeInTheDocument();
  });

  it("names every column and gives the table an accessible caption", async () => {
    rendered();
    await screen.findByText("HR test corpus");

    const table = screen.getByRole("table");
    expect(table).toHaveAccessibleName("Connected source records in the current view");
    expect(
      within(table).getAllByRole("columnheader").map((cell) => cell.textContent),
    ).toEqual([
      "Source",
      "Scope",
      "Record status",
      "Connection evidence",
      "Created",
      "Updated",
      "Actions",
    ]);
  });

  it("hides the two date columns below the large breakpoint instead of overflowing the table", async () => {
    rendered();
    await screen.findByText("HR test corpus");

    expect(screen.getByRole("columnheader", { name: "Created" })).toHaveClass("lg:table-cell");
    expect(screen.getByRole("columnheader", { name: "Updated" })).toHaveClass("xl:table-cell");
  });

  it("disables pagination while a read is in flight", async () => {
    listSources.mockResolvedValue(envelope([FOLDER], { total: 41, page: 1, pages: 3 }));
    rendered();
    await screen.findByText("Board archive");

    let resolve: (value: SourceListResponse) => void = () => {};
    listSources.mockImplementation(() => new Promise<SourceListResponse>((done) => { resolve = done; }));
    await userEvent.click(screen.getByRole("button", { name: /^Next$/ }));

    expect(screen.getByRole("button", { name: /^Previous$/ })).toBeDisabled();
    await act(async () => {
      resolve(envelope([FOLDER], { total: 41, page: 2, pages: 3 }));
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Previous$/ })).toBeEnabled(),
    );
    expect(screen.getByRole("navigation", { name: "Source pagination" })).toBeInTheDocument();
  });
});

/* ------------------------------- validation -------------------------------- */

describe("validating a source", () => {
  it("asks the server about the record whose button was pressed, in scope", async () => {
    rendered();
    await screen.findByText("HR test corpus");

    await userEvent.click(within(sourceRow("HR test corpus")).getByRole("button", { name: "Validate" }));

    await waitFor(() => expect(validateSource).toHaveBeenCalledWith(7, 1));
  });

  it("reports a pass as reachability only, and re-reads the row", async () => {
    rendered();
    await screen.findByText("HR test corpus");
    listSources.mockClear();

    await userEvent.click(within(sourceRow("HR test corpus")).getByRole("button", { name: "Validate" }));

    const banner = await announced(/synthetic connector is available/i);
    expect(banner).toHaveTextContent('Source "HR test corpus" (id 7)');
    expect(banner).toHaveTextContent(/discovers and imports nothing/i);
    expect(banner).toHaveTextContent("Recorded at 2026-10-20T10:00:00.");
    await waitFor(() => expect(listSources).toHaveBeenCalledTimes(1));
  });

  it("reports a failed check as a failure, with the server's own reason", async () => {
    validateSource.mockResolvedValue({
      id: 8,
      ok: false,
      message: "Root key 'board' is not configured.",
      validated_at: "2026-10-20T10:00:00",
    });
    rendered();
    await screen.findByText("Board archive");

    await userEvent.click(within(sourceRow("Board archive")).getByRole("button", { name: "Validate" }));

    const banner = await announced(/could not be validated/i);
    expect(banner).toHaveTextContent("Root key 'board' is not configured.");
    expect(banner).toHaveTextContent(/LOCAL_SOURCE_ROOTS allow-list/);
    expect(banner).toHaveTextContent(/Nothing was discovered or imported/);
  });

  it("explains a 404 as a scope problem rather than a missing record", async () => {
    validateSource.mockRejectedValue(new ApiError("Source not found", 404));
    rendered();
    await screen.findByText("HR test corpus");

    await userEvent.click(within(sourceRow("HR test corpus")).getByRole("button", { name: "Validate" }));

    const banner = await announced(/not visible in the current institution scope/i);
    expect(banner).toHaveTextContent("Source not found");
  });

  it("does not claim anything was learned when the request itself failed", async () => {
    validateSource.mockRejectedValue(new ApiError("Could not reach the DataDiet API", 0));
    rendered();
    await screen.findByText("HR test corpus");

    await userEvent.click(within(sourceRow("HR test corpus")).getByRole("button", { name: "Validate" }));

    const banner = await announced(/the validation never ran/i);
    expect(banner).toHaveTextContent("Could not reach the DataDiet API");
  });

  it("refuses a second validation while one is in flight", async () => {
    let resolve: (value: unknown) => void = () => {};
    validateSource.mockImplementation(() => new Promise((done) => { resolve = done; }));
    rendered();
    await screen.findByText("HR test corpus");

    await userEvent.click(within(sourceRow("HR test corpus")).getByRole("button", { name: "Validate" }));

    expect(
      within(sourceRow("Board archive")).getByRole("button", { name: "Validate" }),
    ).toBeDisabled();
    expect(within(sourceRow("Board archive")).getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/buttons below are disabled until it answers/i);

    await act(async () => {
      resolve({ id: 7, ok: true, message: "Synthetic connector is available.", validated_at: null });
    });
    await waitFor(() =>
      expect(within(sourceRow("Board archive")).getByRole("button", { name: "Validate" })).toBeEnabled(),
    );
  });
});

/* -------------------------------- creating --------------------------------- */

describe("creating a source record", () => {
  it("says plainly that saving the form contacts nothing", async () => {
    const dialog = await openCreator();

    expect(dialog).toHaveTextContent(/writes a configuration record/i);
    expect(dialog).toHaveTextContent(/status is set to active by the server without any check/i);
    expect(nameField()).toHaveFocus();
  });

  it("offers only the two connector types the backend can build", async () => {
    const dialog = await openCreator();

    const connector = within(dialog).getByRole("combobox", { name: "Connector type" });
    expect(
      within(connector)
        .getAllByRole("option")
        .map((option) => option.getAttribute("value")),
    ).toEqual(["synthetic", "local_folder"]);
  });

  it("holds the fields at the limits the schema documents", async () => {
    const dialog = await openCreator();

    expect(nameField()).toHaveAttribute("maxLength", "200");
    expect(
      within(dialog).getByText(/unique within one institution/i),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/password, passwd, secret, token, api_key/i),
    ).toBeInTheDocument();
  });

  it("refuses an empty name before asking the server", async () => {
    const dialog = await openCreator();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save source record" }));

    expect(await within(dialog).findByText("A source name is required.")).toBeInTheDocument();
    expect(createSource).not.toHaveBeenCalled();
  });

  it("clears a refusal as soon as the field it describes is fixed", async () => {
    const dialog = await openCreator();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save source record" }));
    expect(await within(dialog).findByText("A source name is required.")).toBeInTheDocument();

    await userEvent.type(nameField(), "Payroll drop");

    expect(within(dialog).queryByText("A source name is required.")).not.toBeInTheDocument();
    expect(createSource).not.toHaveBeenCalled();
  });

  it("asks a local_folder source for a root key and refuses a path", async () => {
    const dialog = await openCreator();
    await userEvent.type(nameField(), "Board archive");
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: "Connector type" }),
      "local_folder",
    );

    await userEvent.click(within(dialog).getByRole("button", { name: "Save source record" }));
    expect(await within(dialog).findByText(/requires a root_key/i)).toBeInTheDocument();
    expect(createSource).not.toHaveBeenCalled();

    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Root key" }),
      "C:\\shared\\board",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Save source record" }));

    expect(
      within(dialog).getByText(/the name of an allow-listed key, not a filesystem path/i),
    ).toBeInTheDocument();
    expect(createSource).not.toHaveBeenCalled();
  });

  it("drops the root key when the connector switches back to synthetic", async () => {
    const dialog = await openCreator();
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: "Connector type" }),
      "local_folder",
    );
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Root key" }), "board");
    expect(within(dialog).getByRole("textbox", { name: "Root key" })).toHaveValue("board");

    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: "Connector type" }),
      "synthetic",
    );

    const key = within(dialog).getByRole("textbox", { name: "Root key" });
    expect(key).toHaveValue("");
    expect(key).toBeDisabled();
  });

  it("refuses configuration that is not a JSON object", async () => {
    const dialog = await openCreator();
    await userEvent.type(nameField(), "Payroll drop");
    fill(configBox(dialog), "count: 25");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save source record" }));

    expect(await within(dialog).findByText(/must be valid JSON/i)).toBeInTheDocument();
    expect(createSource).not.toHaveBeenCalled();

    fill(configBox(dialog), "[25]");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save source record" }));

    expect(
      within(dialog).getByText(/must be a JSON object of key\/value pairs/i),
    ).toBeInTheDocument();
    expect(createSource).not.toHaveBeenCalled();
  });

  it("refuses a configuration with more keys than the schema allows", async () => {
    const wide = Object.fromEntries(
      Array.from({ length: 41 }, (_, index) => [`key_${index}`, index]),
    );
    const dialog = await openCreator();
    await userEvent.type(nameField(), "Payroll drop");
    fill(configBox(dialog), JSON.stringify(wide));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save source record" }));

    expect(
      await within(dialog).findByText(/has 41 keys; the server accepts at most 40/i),
    ).toBeInTheDocument();
    expect(createSource).not.toHaveBeenCalled();
  });

  it("refuses a secret-looking key and never puts its value on the wire", async () => {
    const dialog = await openCreator();
    await userEvent.type(nameField(), "Payroll drop");
    fill(configBox(dialog), '{"password": "hunter2", "token": "abc"}');
    await userEvent.click(within(dialog).getByRole("button", { name: "Save source record" }));

    const refusal = await within(dialog).findByText(/must not contain secrets/i);
    expect(refusal).toHaveTextContent("password, token");
    expect(refusal).toHaveTextContent(/this api has no field for them and never displays any/i);
    expect(createSource).not.toHaveBeenCalled();
  });

  it("creates only after the operator submits, and with the fields the schema accepts", async () => {
    const dialog = await openCreator();
    expect(createSource).not.toHaveBeenCalled();

    await userEvent.type(nameField(), "  Payroll drop  ");
    fill(configBox(dialog), '{"count": 25}');
    await userEvent.click(within(dialog).getByRole("button", { name: "Save source record" }));

    await waitFor(() => expect(createSource).toHaveBeenCalledTimes(1));
    const input = createSource.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toEqual({
      name: "Payroll drop",
      connector_type: "synthetic",
      institution_id: 1,
      config: { count: 25 },
    });
    expect(input.root_key).toBeUndefined();
  });

  it("reports a created record as enabled rather than connected, and re-reads the list", async () => {
    const dialog = await openCreator();
    await userEvent.type(nameField(), "Payroll drop");
    listSources.mockClear();

    await userEvent.click(within(dialog).getByRole("button", { name: "Save source record" }));

    const banner = await announced(/is stored with status "active"/i);
    expect(banner).toHaveTextContent('Source "Payroll drop" (id 41)');
    expect(banner).toHaveTextContent("without contacting anything");
    expect(banner).toHaveTextContent("Connection never checked");
    expect(banner).toHaveTextContent(/start a scan from the Scans page/i);
    expect(screen.queryByRole("dialog", { name: "Add source record" })).not.toBeInTheDocument();
    await waitFor(() => expect(listSources).toHaveBeenCalledTimes(1));
  });

  it("reports a duplicate name as a conflict and claims no success", async () => {
    createSource.mockRejectedValue(
      new ApiError('Source name "Payroll drop" already exists in this institution', 409),
    );
    const dialog = await openCreator();
    await userEvent.type(nameField(), "Payroll drop");

    await userEvent.click(within(dialog).getByRole("button", { name: "Save source record" }));

    const conflict = await within(dialog).findByRole("alert");
    expect(conflict).toHaveTextContent("already has a source with that name");
    expect(conflict).toHaveTextContent("the record already exists");
    expect(conflict).toHaveTextContent('Source name "Payroll drop" already exists in this institution');
    expect(conflict).toHaveFocus();
    expect(screen.queryByRole("dialog", { name: "Add source record" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the server's own 422 reason for an unconfigured root key", async () => {
    createSource.mockRejectedValue(
      new ApiError(
        "Root key 'board' is not configured. An operator must add it to LOCAL_SOURCE_ROOTS first.",
        422,
      ),
    );
    const dialog = await openCreator();
    await userEvent.type(nameField(), "Board archive");
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: "Connector type" }),
      "local_folder",
    );
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Root key" }), "board");

    await userEvent.click(within(dialog).getByRole("button", { name: "Save source record" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Root key 'board' is not configured.");
    expect(alert).toHaveTextContent(/refused this configuration and stored nothing/i);
    expect(alert).toHaveTextContent(/no record was created, so nothing needs to be undone/i);
  });

  it("does not create twice while one create is in flight", async () => {
    let resolve: (value: Source) => void = () => {};
    createSource.mockImplementation(() => new Promise<Source>((done) => { resolve = done; }));
    const dialog = await openCreator();
    await userEvent.type(nameField(), "Payroll drop");

    await userEvent.click(within(dialog).getByRole("button", { name: "Save source record" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save source record" }));

    expect(createSource).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(/sending…/i);

    await act(async () => {
      resolve({ ...SYNTHETIC, id: 41, name: "Payroll drop" });
    });
    expect(await announced(/is stored with status/i)).toBeInTheDocument();
  });

  it("sends nothing when the operator cancels", async () => {
    const dialog = await openCreator();
    await userEvent.type(nameField(), "Payroll drop");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog", { name: "Add source record" })).not.toBeInTheDocument();
    expect(createSource).not.toHaveBeenCalled();
  });
});

/* --------------------------------- editing --------------------------------- */

describe("editing a source record", () => {
  it("states which four fields the PATCH accepts and which two are fixed", async () => {
    const dialog = await openEditor("Board archive");

    expect(dialog).toHaveTextContent(
      /only the four fields the patch endpoint accepts are editable/i,
    );
    expect(within(dialog).getByRole("combobox", { name: "Record status" })).toBeInTheDocument();
    expect(within(dialog).getByText("Connector type", { selector: "dt" })).toBeInTheDocument();
    expect(detailValue(dialog, "Connector type")).toContain("Not editable");
    expect(within(dialog).queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
  });

  it("starts from the stored values, rendered from the response", async () => {
    const dialog = await openEditor("Board archive");

    expect(nameField()).toHaveValue("Board archive");
    expect(within(dialog).getByRole("textbox", { name: "Root key" })).toHaveValue("board");
    expect(configBox(dialog)).toHaveValue('{}');
  });

  it("saves a retirement through status, the only mechanism the API has", async () => {
    const dialog = await openEditor("HR test corpus");
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: "Record status" }),
      "inactive",
    );

    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateSource).toHaveBeenCalledWith(
        7,
        { name: "HR test corpus", status: "inactive", config: { count: 25, categories: ["hr_records"] } },
        1,
      ),
    );
    const banner = await announced(/is updated: status "inactive"/i);
    expect(banner).toHaveTextContent(/changing a record does not run anything/i);
    expect(banner).toHaveTextContent("no scan was started and no file was read");
  });

  it("says plainly that setting inactive is a retirement, not a deletion", async () => {
    const dialog = await openEditor("HR test corpus");

    expect(
      within(dialog).getByText(/setting inactive is how a source is retired, because there is no delete endpoint/i),
    ).toBeInTheDocument();
  });

  it("keeps the connector's rule: a synthetic record shows no root key field", async () => {
    const dialog = await openEditor("HR test corpus");

    expect(within(dialog).queryByRole("textbox", { name: "Root key" })).not.toBeInTheDocument();
    expect(detailValue(dialog, "Root key")).toMatch(/None — this connector has no root key/i);
  });

  it("warns that an edit makes the last validation answer about the old configuration", async () => {
    const dialog = await openEditor("Board archive");

    expect(
      within(dialog).getByText(/validation evidence is not editable/i),
    ).toHaveTextContent("validate again after a material change");
  });

  it("refuses an empty name locally, so the server never sees a schema violation", async () => {
    const dialog = await openEditor("HR test corpus");
    await userEvent.clear(nameField());

    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(await within(dialog).findByText("A source name is required.")).toBeInTheDocument();
    expect(updateSource).not.toHaveBeenCalled();
  });

  it("reports a 422 as the record being unchanged", async () => {
    updateSource.mockRejectedValue(new ApiError("Only a local_folder source has a root_key", 422));
    const dialog = await openEditor("HR test corpus");
    await userEvent.type(nameField(), " renamed");

    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Only a local_folder source has a root_key");
    expect(alert).toHaveTextContent("The server kept this record exactly as it was");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reports a name clash with another record as a conflict", async () => {
    updateSource.mockRejectedValue(new ApiError("Source name already exists", 409));
    const dialog = await openEditor("HR test corpus");
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "Board archive");

    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Another record already holds that name in this institution");
    expect(alert).toHaveTextContent("Nothing was changed on this one");
  });

  it("does not save twice while one save is in flight", async () => {
    let resolve: (value: Source) => void = () => {};
    updateSource.mockImplementation(() => new Promise<Source>((done) => { resolve = done; }));
    const dialog = await openEditor("HR test corpus");

    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(updateSource).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ ...SYNTHETIC, status: "inactive" });
    });
    expect(await announced(/is updated/i)).toBeInTheDocument();
  });
});

/* -------------------------------- details ---------------------------------- */

describe("inspecting one source", () => {
  it("shows every stored field, including the validation evidence trail", async () => {
    rendered();
    await screen.findByText("HR test corpus");
    await userEvent.click(within(sourceRow("HR test corpus")).getByRole("button", { name: "Details" }));

    const dialog = await screen.findByRole("dialog", { name: "HR test corpus" });
    expect(detailValue(dialog, "Status")).toContain("active");
    expect(detailValue(dialog, "What status means")).toMatch(/enabled by an operator/i);
    expect(detailValue(dialog, "Root key")).toBe("None");
    expect(detailValue(dialog, "Last validated at")).toMatch(/never — no validation has been run/i);
    expect(detailValue(dialog, "Last validation ok")).toMatch(/no result recorded/i);
    expect(detailValue(dialog, "Configuration")).toContain("count=25");
    expect(detailValue(dialog, "Created by")).toBe("reviewer@example.org");
  });

  it("says there is no history endpoint instead of inventing one", async () => {
    rendered();
    await screen.findByText("HR test corpus");
    await userEvent.click(within(sourceRow("HR test corpus")).getByRole("button", { name: "Details" }));

    const dialog = await screen.findByRole("dialog", { name: "HR test corpus" });
    expect(
      within(dialog).getByText(/there is no history endpoint/i),
    ).toHaveTextContent("who changed it, is not something the API returns");
  });

  it("shows the folder source's key as an allow-list name, never a path", async () => {
    rendered();
    await screen.findByText("Board archive");
    await userEvent.click(within(sourceRow("Board archive")).getByRole("button", { name: "Details" }));

    const dialog = await screen.findByRole("dialog", { name: "Board archive" });
    expect(detailValue(dialog, "Root key")).toBe("board (an allow-list name, not a path)");
    expect(detailValue(dialog, "Connection evidence")).toBe("Last check could reach it");
    expect(detailValue(dialog, "Last validation message")).toBe(
      "Root resolves to an existing directory.",
    );
  });
});

/* ------------------------------- permissions ------------------------------- */

describe("who is allowed to act", () => {
  it("hides every write control from an account without sources:write", async () => {
    render(withAuth(<Sources />, testUser({ role: "viewer" })));

    await screen.findByText("HR test corpus");

    expect(screen.queryByRole("button", { name: "Add source" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Validate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Details" })).toHaveLength(3);
  });

  it("still reads the list for a viewer, because reading is a separate permission", async () => {
    render(withAuth(<Sources />, testUser({ role: "viewer" })));

    expect(await screen.findByText("HR test corpus")).toBeInTheDocument();
    expect(listSources).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Sources (3)")).toBeInTheDocument();
  });

  it("offers no way to write for an account that cannot write, even through the empty state", async () => {
    listSources.mockResolvedValue(envelope([]));
    render(withAuth(<Sources />, testUser({ role: "viewer" })));

    expect(await screen.findByText("No source records yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add source/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

/* --------------------------- keyboard and focus ---------------------------- */

describe("keyboard, focus and honest dialogs", () => {
  it("closes the create dialog on Escape without writing", async () => {
    await openCreator();
    await userEvent.type(nameField(), "Payroll drop");

    await userEvent.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add source record" })).not.toBeInTheDocument(),
    );
    expect(createSource).not.toHaveBeenCalled();
  });

  it("does not dismiss a form with typed answers by clicking behind it", async () => {
    const dialog = await openCreator();
    await userEvent.type(nameField(), "Payroll drop");

    await userEvent.click(document.querySelector(".bg-overlay") as HTMLElement);

    expect(
      screen.getByRole("dialog", { name: "Add source record" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Source name" })).toHaveValue(
      "Payroll drop",
    );
  });

  it("moves focus to the refusal that replaced the submit button", async () => {
    validateSource.mockRejectedValue(new ApiError("Validation endpoint closed", 503));
    rendered();
    await screen.findByText("HR test corpus");

    await userEvent.click(within(sourceRow("HR test corpus")).getByRole("button", { name: "Validate" }));

    expect(await announced(/the validation never ran/i)).toBeInTheDocument();
  });

  it("keeps the row actions reachable from the keyboard", async () => {
    rendered();
    await screen.findByText("HR test corpus");

    within(sourceRow("HR test corpus")).getByRole("button", { name: "Details" });
    const validate = within(sourceRow("HR test corpus")).getByRole("button", { name: "Validate" });
    validate.focus();
    expect(validate).toHaveFocus();
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(validateSource).toHaveBeenCalledWith(7, 1));
  });

  it("describes the connector's own caveat where the type is chosen", async () => {
    const dialog = await openCreator();

    expect(
      within(dialog).getByText(/generates fictional records inside the backend/i),
    ).toBeInTheDocument();

    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: "Connector type" }),
      "local_folder",
    );

    expect(
      within(dialog).getByText(/reads metadata of files under a folder an operator has already allow-listed/i),
    ).toHaveTextContent("symlinks are refused");
  });

  it("tells an unscoped account that its record will carry no institution", async () => {
    const dialog = await openCreator(platformAdmin());

    expect(
      within(dialog).getByText(/not scoped to one institution, so the request carries no institution_id/i),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/stored without one/i);
    expect(createSource).not.toHaveBeenCalled();
  });
});
