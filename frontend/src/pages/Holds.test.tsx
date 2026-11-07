/**
 * Phase 5.6 retention hold workspace tests.
 *
 * `../api/retention` is mocked, so these verify the view against the request and
 * response shapes recorded in `src/api/retention.ts`, which mirror
 * `backend/app/api/routes/retention.py` and `app/api/schemas/retention.py`. The
 * assertions concentrate on what the brief refuses to allow faked: that only the
 * two documented list filters reach the server, that a hold's status, coverage
 * and release metadata come from the row and nowhere else, that both writes need
 * an explicit click, that a 409 conflict is reported as a conflict without
 * claiming success, and that a released hold is never presented as recoverable.
 */

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hold } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { platformAdmin, testUser, withAuth } from "../test/auth";
import { formatDate } from "../lib/format";

const listHolds = vi.fn();
const createHold = vi.fn();
const releaseHold = vi.fn();

vi.mock("../api/retention", () => ({
  listHolds: (...args: unknown[]) => listHolds(...args),
  createHold: (...args: unknown[]) => createHold(...args),
  releaseHold: (...args: unknown[]) => releaseHold(...args),
}));

import Holds from "./Holds";
import { ApiError } from "../api/client";

const ON_ASSET: Hold = {
  id: 1,
  institution_id: 1,
  asset_id: 7,
  asset_scope: null,
  name: "Litigation hold",
  hold_type: "legal",
  legal_basis: "Case 2026-114",
  scope: [],
  status: "active",
  created_by: "system",
  created_at: "2026-10-01T09:30:00",
  released_by: null,
  released_at: null,
  release_reason: null,
};

const OVER_SCOPE: Hold = {
  ...ON_ASSET,
  id: 2,
  asset_id: null,
  hold_type: null,
  legal_basis: null,
  name: "Regulatory sweep hold",
};

const RELEASED: Hold = {
  ...ON_ASSET,
  id: 3,
  name: "Closed audit hold",
  hold_type: "audit",
  status: "released",
  released_by: "system",
  released_at: "2026-10-20T14:00:00",
  release_reason: "Audit findings delivered",
};

const ROWS: Hold[] = [RELEASED, OVER_SCOPE, ON_ASSET];

/** Test-only control: moves the signed-in account to another institution scope. */
function ScopeSwitch({ to }: { to: number }) {
  const { setActiveInstitution } = useAuth();
  return (
    <button type="button" onClick={() => setActiveInstitution(to)}>
      scope {to}
    </button>
  );
}

/** The table row of a named hold, so cell assertions cannot cross rows. */
function holdRow(name: string): HTMLElement {
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

/**
 * The value shown for one labelled field of a `<dl>`. Reading the `<dd>` that
 * belongs to a `<dt>` keeps an assertion about an empty field from matching the
 * placeholder text of a different field.
 */
function detailValue(dialog: HTMLElement, label: string): string {
  const term = within(dialog).getByText(label, { selector: "dt" });
  const value = term.parentElement?.querySelector("dd");
  if (value === null || value === undefined) {
    throw new Error(`No value rendered for ${label}`);
  }
  return value.textContent ?? "";
}

async function openCreator(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getByRole("button", { name: "Create hold" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Create hold" }));
  return screen.findByRole("dialog", { name: "Create hold" });
}

function nameField(): HTMLElement {
  return screen.getByRole("textbox", { name: "Hold name" });
}

async function openReleaser(name: string): Promise<HTMLElement> {
  await userEvent.click(within(holdRow(name)).getByRole("button", { name: "Release" }));
  return screen.findByRole("dialog", { name: new RegExp(name, "i") });
}

beforeEach(() => {
  vi.clearAllMocks();
  listHolds.mockResolvedValue(ROWS);
  createHold.mockResolvedValue({ ...ON_ASSET, id: 41, name: "Board minutes hold" });
  releaseHold.mockResolvedValue({
    ...ON_ASSET,
    status: "released",
    released_by: "system",
    released_at: "2026-10-30T08:00:00",
    release_reason: "Case concluded",
  });
});

describe("what the workspace asks the server for", () => {
  it("sends only the two filters the list route accepts", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
        testUser({ role: "admin" }),
      ),
    );
    await waitFor(() => expect(listHolds).toHaveBeenCalledTimes(1));
    expect(listHolds).toHaveBeenLastCalledWith({ institution_id: 1 }, expect.any(AbortSignal));

    await userEvent.type(screen.getByRole("searchbox", { name: "Hold name contains" }), "audit");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Coverage" }), "asset");

    // Neither browser-side control may widen the request.
    expect(listHolds).toHaveBeenCalledTimes(1);
  });

  it("sends a status filter to the server and drops it again", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
      ),
    );
    await waitFor(() => expect(screen.getByText("Litigation hold")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /^Released/ }));
    await waitFor(() => expect(listHolds).toHaveBeenCalledTimes(2));
    expect(listHolds).toHaveBeenLastCalledWith(
      { status: "released", institution_id: 1 },
      expect.any(AbortSignal),
    );

    await userEvent.click(screen.getByRole("button", { name: /^Released/ }));
    await waitFor(() => expect(listHolds).toHaveBeenCalledTimes(3));
    expect(listHolds).toHaveBeenLastCalledWith({ institution_id: 1 }, expect.any(AbortSignal));
  });

  it("never sends an unscoped request while the account is scoped to one institution", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <>
            <Holds />
            <ScopeSwitch to={2} />
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
    expect(await screen.findByText(/attached to institution #2/)).toBeInTheDocument();
  });

  it("reads every institution for a platform account and says so", async () => {
    listHolds.mockResolvedValue([...ROWS, { ...ON_ASSET, id: 4, institution_id: null }]);
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
        platformAdmin(),
      ),
    );
    await waitFor(() => expect(listHolds).toHaveBeenCalledTimes(1));
    expect(listHolds).toHaveBeenLastCalledWith({}, expect.any(AbortSignal));
    expect(
      await screen.findByText(/in scope for your platform-wide account/),
    ).toBeInTheDocument();
  });

  it("keeps the newest list when an older request answers last", async () => {
    const settled: Array<(value: Hold[]) => void> = [];
    listHolds.mockImplementation(
      () =>
        new Promise<Hold[]>((resolve) => {
          settled.push(resolve);
        }),
    );
    render(
      withAuth(
        <MemoryRouter>
          <>
            <Holds />
            <ScopeSwitch to={2} />
          </>
        </MemoryRouter>,
        testUser({ institutions: [1, 2] }),
      ),
    );
    await waitFor(() => expect(listHolds).toHaveBeenCalledTimes(1));

    // A second scope change supersedes the first request before it is answered.
    await userEvent.click(screen.getByRole("button", { name: /scope 2/i }));
    await waitFor(() => expect(listHolds).toHaveBeenCalledTimes(2));

    await act(async () => {
      settled[1]([{ ...ON_ASSET, name: "Newer asset hold" }]);
    });
    expect(await screen.findByText("Newer asset hold")).toBeInTheDocument();

    await act(async () => {
      settled[0]([{ ...ON_ASSET, name: "Stale scope hold" }]);
    });
    // The superseded response may not paint its rows over the current scope.
    expect(screen.getByText("Newer asset hold")).toBeInTheDocument();
    expect(screen.queryByText("Stale scope hold")).not.toBeInTheDocument();
    expect(screen.getByText(/attached to institution #2/)).toBeInTheDocument();
  });
});

describe("what the workspace renders from the response", () => {
  it("renders each hold's own status, coverage and release metadata", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
        testUser({ role: "admin" }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Litigation hold")).toBeInTheDocument());

    expect(within(holdRow("Litigation hold")).getByText("active")).toBeInTheDocument();
    expect(within(holdRow("Litigation hold")).getByText("#7")).toBeInTheDocument();
    expect(within(holdRow("Litigation hold")).getByText("id 1")).toBeInTheDocument();
    expect(within(holdRow("Litigation hold")).getByText("Case 2026-114")).toBeInTheDocument();
    expect(
      within(holdRow("Litigation hold")).getByText("Blocks this asset only"),
    ).toBeInTheDocument();
    expect(within(holdRow("Litigation hold")).getByText(formatDate("2026-10-01"))).toBeVisible();
    expect(within(holdRow("Litigation hold")).getByText("Not released")).toBeInTheDocument();

    expect(within(holdRow("Regulatory sweep hold")).getByText("Institution-wide")).toBeVisible();
    expect(
      within(holdRow("Regulatory sweep hold")).getByText("Blocks every asset in scope"),
    ).toBeInTheDocument();
    expect(within(holdRow("Regulatory sweep hold")).getByText("No type recorded")).toBeInTheDocument();

    expect(within(holdRow("Closed audit hold")).getByText("released")).toBeInTheDocument();
    expect(
      within(holdRow("Closed audit hold")).getByText("No longer blocks any recommendation"),
    ).toBeInTheDocument();
    expect(
      within(holdRow("Closed audit hold")).getByText("Audit findings delivered"),
    ).toBeInTheDocument();
    expect(within(holdRow("Closed audit hold")).getByText(formatDate("2026-10-20"))).toBeVisible();
  });

  it("counts the rows it loaded and the institution the list was asked for", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
      ),
    );
    const overview = await screen.findByRole("group", { name: "Filter holds by status" });
    expect(within(overview).getByRole("button", { name: /^All/ })).toHaveTextContent("All 3");
    expect(within(overview).getByRole("button", { name: /^Active/ })).toHaveTextContent("Active 2");
    expect(within(overview).getByRole("button", { name: /^Released/ })).toHaveTextContent(
      "Released 1",
    );
    expect(
      screen.getByText(/3 holds are attached to institution #1/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/at most the 100 newest holds in scope/),
    ).toBeInTheDocument();
    // The browser-side controls must not look like server queries.
    expect(
      screen.getByText(/Applied in the browser to the holds this list already loaded/),
    ).toBeInTheDocument();
  });

  it("labels the table and never implies an affected-asset list it does not have", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
      ),
    );
    const caption = await screen.findByText("Retention holds in the current view");
    expect(caption.closest("table")).not.toBeNull();
    expect(screen.queryByText(/assets? affected/)).not.toBeInTheDocument();
    expect(screen.queryByText(/hold history/i)).not.toBeInTheDocument();
  });

  it("narrows the loaded rows by name and coverage without a request", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
        testUser({ role: "admin" }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Litigation hold")).toBeInTheDocument());

    await userEvent.type(screen.getByRole("searchbox", { name: "Hold name contains" }), "audit");
    expect(screen.getByText("Closed audit hold")).toBeInTheDocument();
    expect(screen.queryByText("Litigation hold")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear name filter|clear filters/i })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: /clear filters/i }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Coverage" }), "asset");
    expect(screen.getByText("Litigation hold")).toBeInTheDocument();
    expect(screen.getByText("Closed audit hold")).toBeInTheDocument();
    expect(screen.queryByText("Regulatory sweep hold")).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Coverage" }), "scope");
    expect(screen.getByText("Regulatory sweep hold")).toBeInTheDocument();
    expect(screen.queryByText("Litigation hold")).not.toBeInTheDocument();
    expect(listHolds).toHaveBeenCalledTimes(1);
  });

  it("distinguishes an empty filter from an empty scope", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
      ),
    );
    await waitFor(() => expect(screen.getByText("Litigation hold")).toBeInTheDocument());

    await userEvent.type(screen.getByRole("searchbox", { name: "Hold name contains" }), "zzz");
    expect(await screen.findByText("No hold matches this view")).toBeInTheDocument();
    expect(
      screen.getByText(/says nothing about the holds that do exist/),
    ).toBeInTheDocument();
  });

  it("shows an empty scope without suggesting a hold was expected", async () => {
    listHolds.mockResolvedValue([]);
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
      ),
    );
    expect(await screen.findByText("No retention holds")).toBeInTheDocument();
    expect(
      screen.getByText(/a new hold is active the moment it is created/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Litigation hold")).not.toBeInTheDocument();
  });

  it("shows the loading state before the response and the error state after a failure", async () => {
    let resolve: (value: Hold[]) => void = () => {};
    listHolds.mockImplementation(() => new Promise<Hold[]>((done) => { resolve = done; }));
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent(/loading retention holds/i);

    await act(async () => {
      resolve(ROWS);
    });
    expect(await screen.findByText("Litigation hold")).toBeInTheDocument();

    listHolds.mockRejectedValue(new ApiError("Could not reach the DataDiet API", 0));
    await userEvent.click(screen.getByRole("button", { name: /released/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/holds unavailable/i);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    // A failed read may not leave the previous rows on screen pretending to be current.
    expect(screen.queryByText("Litigation hold")).not.toBeInTheDocument();
  });

  it("recovers when retry answers after a failure", async () => {
    listHolds.mockRejectedValueOnce(new ApiError("Hold list refused", 500));
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
      ),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/holds unavailable/i);
    expect(alert).toHaveTextContent("Hold list refused");

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("Litigation hold")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("creating a hold", () => {
  it("refuses an empty name before asking the server", async () => {
    const dialog = await openCreatorIn();
    await userEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));
    expect(
      within(dialog).getByText("A hold name is required."),
    ).toBeInTheDocument();
    expect(createHold).not.toHaveBeenCalled();
  });

  it("clears a refusal as soon as the field it describes is fixed", async () => {
    const dialog = await openCreatorIn();
    await userEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));
    expect(await within(dialog).findByText("A hold name is required.")).toBeInTheDocument();

    await userEvent.type(nameField(), "Board minutes hold");
    expect(within(dialog).queryByText("A hold name is required.")).not.toBeInTheDocument();
    expect(createHold).not.toHaveBeenCalled();
  });

  it("holds the fields at the limits the schema documents", async () => {
    const dialog = await openCreatorIn();
    expect(nameField()).toHaveAttribute("maxLength", "200");
    expect(within(dialog).getByRole("textbox", { name: "Hold type" })).toHaveAttribute(
      "maxLength",
      "50",
    );
    expect(within(dialog).getByRole("textbox", { name: "Legal basis" })).toHaveAttribute(
      "maxLength",
      "200",
    );
    // The API has no reason field it keeps, so the form must not offer one.
    expect(within(dialog).queryByRole("textbox", { name: /reason/i })).not.toBeInTheDocument();
    expect(
      within(dialog).getByText(/the create endpoint has no reason field it keeps/i),
    ).toBeInTheDocument();
  });

  it("refuses an asset reference that cannot be a number", async () => {
    const dialog = await openCreatorIn();
    await userEvent.type(nameField(), "Board minutes hold");
    const asset = within(dialog).getByRole("spinbutton", { name: "Asset id (optional)" });
    await userEvent.clear(asset);
    await userEvent.type(asset, "0");
    await userEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));
    expect(
      await within(dialog).findByText(/whole number, or empty/),
    ).toBeInTheDocument();
    expect(createHold).not.toHaveBeenCalled();
  });

  it("places a hold only after the operator confirms, and reports what it now blocks", async () => {
    const dialog = await openCreatorIn();
    // Opening the dialog is not a write.
    expect(createHold).not.toHaveBeenCalled();

    await userEvent.type(nameField(), "  Board minutes hold  ");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Hold type" }), "legal");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Legal basis" }), "Case 2026");
    await userEvent.type(
      within(dialog).getByRole("spinbutton", { name: "Asset id (optional)" }),
      "7",
    );
    expect(within(dialog).getByText(/asset #7 only/)).toBeInTheDocument();
    expect(within(dialog).getByText(/institution_id 1/)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));

    await waitFor(() =>
      expect(createHold).toHaveBeenCalledWith({
        name: "Board minutes hold",
        asset_id: 7,
        hold_type: "legal",
        legal_basis: "Case 2026",
        institution_id: 1,
      }),
    );
    const banner = await announced(/is active \(id 41\)/);
    expect(banner).toHaveTextContent('Hold "Board minutes hold"');
    expect(banner).toHaveTextContent("blocks this asset only");
    expect(banner).toHaveTextContent(/recorded the actor as "system"/);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(listHolds).toHaveBeenCalledTimes(2));
  });

  it("describes an institution-wide hold as blocking every asset in scope", async () => {
    const dialog = await openCreatorIn();
    expect(
      within(dialog).getByText(/blocks every asset in its scope/),
    ).toBeInTheDocument();
  });

  it("does not create twice while one create is in flight", async () => {
    let resolve: (value: Hold) => void = () => {};
    createHold.mockImplementation(
      () =>
        new Promise<Hold>((done) => {
          resolve = done;
        }),
    );
    const dialog = await openCreatorIn();
    await userEvent.type(nameField(), "Board minutes hold");

    const submit = within(dialog).getByRole("button", { name: "Place hold" });
    await userEvent.click(submit);
    await userEvent.click(submit);
    expect(createHold).toHaveBeenCalledTimes(1);
    expect(submit).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      resolve({ ...ON_ASSET, id: 42, name: "Board minutes hold" });
    });
    expect(await screen.findByText(/is active \(id 42\)/)).toBeInTheDocument();
  });

  it("shows the server's refusal and keeps the dialog open with the form intact", async () => {
    createHold.mockRejectedValue(
      new ApiError("A hold's institution_id must match the institution of the asset it covers.", 422),
    );
    const dialog = await openCreatorIn();
    await userEvent.type(nameField(), "Board minutes hold");
    await userEvent.type(
      within(dialog).getByRole("spinbutton", { name: "Asset id (optional)" }),
      "9",
    );

    await userEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "A hold's institution_id must match the institution of the asset it covers.",
    );
    expect(screen.getByRole("dialog", { name: "Create hold" })).toBeInTheDocument();
    expect(nameField()).toHaveValue("Board minutes hold");
    expect(screen.queryByText(/is active \(id/)).not.toBeInTheDocument();
    expect(listHolds).toHaveBeenCalledTimes(1);
    // The refusal is where the operator's focus lands: the confirm button was
    // disabled while the write was in flight, so focus must not be stranded.
    expect(within(dialog).getByRole("alert")).toHaveFocus();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("reports a permission refusal from the server verbatim", async () => {
    createHold.mockRejectedValue(
      new ApiError("forbidden: This action requires the 'retention:write' permission.", 403),
    );
    const dialog = await openCreatorIn();
    await userEvent.type(nameField(), "Board minutes hold");
    await userEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("retention:write");
    expect(screen.queryByText(/is active \(id/)).not.toBeInTheDocument();
  });
});

describe("releasing a hold", () => {
  it("names the hold, waits for confirmation, and then releases", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
        testUser({ role: "admin" }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Litigation hold")).toBeInTheDocument());

    const dialog = await openReleaser("Litigation hold");
    expect(within(dialog).getByRole("heading", { level: 2 })).toHaveTextContent(
      'Release "Litigation hold"',
    );
    expect(within(dialog).getByText(/id 1/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Asset/)).toBeInTheDocument();
    // Confirming is a click: opening the dialog sends nothing.
    expect(releaseHold).not.toHaveBeenCalled();

    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Release reason" }),
      "Case concluded",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Release hold" }));

    await waitFor(() => expect(releaseHold).toHaveBeenCalledWith(1, "Case concluded"));
    await announced(/is released/);
    expect(await announced(/no record was/i)).toHaveTextContent(/restored or deleted/);
    await waitFor(() => expect(listHolds).toHaveBeenCalledTimes(2));
  });

  it("sends no reason at all when the operator leaves the field empty", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
        testUser({ role: "admin" }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Litigation hold")).toBeInTheDocument());
    const dialog = await openReleaser("Litigation hold");
    await userEvent.click(within(dialog).getByRole("button", { name: "Release hold" }));

    await waitFor(() => expect(releaseHold).toHaveBeenCalledWith(1, undefined));
  });

  it("keeps the hold when the operator backs out, and sends nothing", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
        testUser({ role: "admin" }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Litigation hold")).toBeInTheDocument());
    const dialog = await openReleaser("Litigation hold");
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep the hold" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(releaseHold).not.toHaveBeenCalled();
    expect(screen.queryByText(/is released/)).not.toBeInTheDocument();
  });

  it("does not release twice while one release is in flight", async () => {
    let resolve: (value: Hold) => void = () => {};
    releaseHold.mockImplementation(
      () =>
        new Promise<Hold>((done) => {
          resolve = done;
        }),
    );
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
        testUser({ role: "admin" }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Litigation hold")).toBeInTheDocument());
    const dialog = await openReleaser("Litigation hold");

    const confirm = within(dialog).getByRole("button", { name: "Release hold" });
    await userEvent.click(confirm);
    await userEvent.click(confirm);
    expect(releaseHold).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve({ ...ON_ASSET, status: "released" });
    });
    expect(await screen.findByText(/is released/)).toBeInTheDocument();
  });

  it("explains a 409 conflict as a conflict, claims no success, and reloads on request", async () => {
    releaseHold.mockRejectedValue(new ApiError("Hold already released", 409));
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
        testUser({ role: "admin" }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Litigation hold")).toBeInTheDocument());
    const dialog = await openReleaser("Litigation hold");
    await userEvent.click(within(dialog).getByRole("button", { name: "Release hold" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("The server rejected this release as a conflict");
    expect(alert).toHaveTextContent("Hold already released");
    expect(alert).toHaveTextContent(/list you are looking at is stale/);
    expect(alert).toHaveFocus();
    expect(within(alert).getByRole("button", { name: /reload the hold list/i })).toBeEnabled();
    expect(screen.queryByText(/is released/)).not.toBeInTheDocument();
    // The row the operator was shown is still on screen and still says active.
    expect(within(holdRow("Litigation hold")).getByText("active")).toBeInTheDocument();
    expect(listHolds).toHaveBeenCalledTimes(1);

    await userEvent.click(within(dialog).getByRole("button", { name: /reload the hold list/i }));
    await waitFor(() => expect(listHolds).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reports a 403 permission refusal without inventing a conflict", async () => {
    releaseHold.mockRejectedValue(
      new ApiError("forbidden: This action requires the 'retention:write' permission.", 403),
    );
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
        testUser({ role: "admin" }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Litigation hold")).toBeInTheDocument());
    const dialog = await openReleaser("Litigation hold");
    await userEvent.click(within(dialog).getByRole("button", { name: "Release hold" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("retention:write");
    expect(alert).not.toHaveTextContent(/conflict/i);
    expect(within(dialog).queryByRole("button", { name: /reload the hold list/i }))
      .not.toBeInTheDocument();
  });

  it("reports the server's 404 for a hold that is not there", async () => {
    releaseHold.mockRejectedValue(new ApiError("Hold not found", 404));
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
        testUser({ role: "admin" }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Litigation hold")).toBeInTheDocument());
    const dialog = await openReleaser("Litigation hold");
    await userEvent.click(within(dialog).getByRole("button", { name: "Release hold" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Hold not found");
    expect(screen.queryByText(/is released/)).not.toBeInTheDocument();
  });

  it("will not offer a second release for a hold the server already released", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
        testUser({ role: "admin" }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Closed audit hold")).toBeInTheDocument());

    const button = within(holdRow("Closed audit hold")).getByRole("button", { name: "Release" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleName("Release");
    expect(button.title).toMatch(/already released/);
  });
});

describe("who is allowed to act", () => {
  it("hides every write control from a role without retention:write", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
        testUser({ role: "viewer" }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Litigation hold")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Create hold" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Release" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Details" })).toHaveLength(3);
  });

  it("still reads the list for a role that can only read", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
        testUser({ role: "viewer" }),
      ),
    );
    await waitFor(() => expect(listHolds).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Regulatory sweep hold")).toBeInTheDocument();
  });

  it("says plainly, when not scoped, that the hold will be stored without an institution", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
        platformAdmin(),
      ),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Create hold" })).toBeEnabled());
    const dialog = await openCreator();
    expect(
      within(dialog).getByText(/the hold is stored without one/),
    ).toBeInTheDocument();
  });
});

describe("keyboard, focus and table semantics", () => {
  it("moves focus into the dialog, closes on Escape, and returns it to the button", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
        testUser({ role: "admin" }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Litigation hold")).toBeInTheDocument());

    const details = within(holdRow("Litigation hold")).getByRole("button", { name: "Details" });
    details.focus();
    await userEvent.keyboard("{Enter}");

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Litigation hold");
    expect(dialog.contains(document.activeElement)).toBe(true);

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(details);
  });

  it("keeps Tab inside the dialog and never sends a request on page load", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
        testUser({ role: "admin" }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Litigation hold")).toBeInTheDocument());
    expect(createHold).not.toHaveBeenCalled();
    expect(releaseHold).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Create hold" }));
    const dialog = await screen.findByRole("dialog");
    // The create dialog opens on the field the operator has to fill in.
    expect(nameField()).toHaveFocus();
    const inside = () => dialog.contains(document.activeElement);
    for (let step = 0; step < 12; step += 1) {
      await userEvent.tab();
      expect(inside()).toBe(true);
    }
  });

  it("associates every form control with a label and marks the required one", async () => {
    const dialog = await openCreatorIn();
    expect(within(dialog).getByRole("textbox", { name: "Hold name" })).toBeVisible();
    expect(nameField()).toBeRequired();
    expect(
      within(dialog).getByText("*", { selector: "[aria-hidden='true']" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Hold type" })).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Legal basis" })).toBeInTheDocument();
    expect(within(dialog).getByRole("spinbutton", { name: "Asset id (optional)" })).toBeInTheDocument();
    // The refusal is announced and names the control it describes.
    await userEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
    const describedBy = nameField().getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(describedBy.length).toBeGreaterThan(0);
    for (const id of describedBy) {
      expect(document.getElementById(id)).not.toBeNull();
    }
  });

  it("reads the status as text, not colour alone, and exposes the chips as toggles", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
      ),
    );
    await waitFor(() => expect(screen.getByText("Litigation hold")).toBeInTheDocument());

    expect(within(holdRow("Litigation hold")).getByText("active")).toBeInTheDocument();
    expect(within(holdRow("Closed audit hold")).getByText("released")).toBeInTheDocument();

    const group = screen.getByRole("group", { name: "Filter holds by status" });
    expect(within(group).getByRole("button", { name: /^All/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(group).getByRole("button", { name: /^Released/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("shows the details the row carries and states what the API cannot tell it", async () => {
    render(
      withAuth(
        <MemoryRouter>
          <Holds />
        </MemoryRouter>,
      ),
    );
    await waitFor(() => expect(screen.getByText("Litigation hold")).toBeInTheDocument());
    await userEvent.click(within(holdRow("Litigation hold")).getByRole("button", { name: "Details" }));

    const dialog = await screen.findByRole("dialog", { name: "Litigation hold" });
    expect(detailValue(dialog, "Covers")).toContain("#7");
    expect(detailValue(dialog, "Legal basis")).toBe("Case 2026-114");
    expect(detailValue(dialog, "Created by")).toBe("system");
    expect(detailValue(dialog, "Released by")).toBe("Not released");
    expect(detailValue(dialog, "Scope entries")).toBe("None recorded");
    expect(detailValue(dialog, "Asset scope")).toBe("None recorded");
    expect(
      within(dialog).getByText(/no endpoint for a single hold, its events/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/writes a constant actor/)).toBeInTheDocument();
  });
});

/** Opens the creator for an admin in a rendered workspace. */
async function openCreatorIn(): Promise<HTMLElement> {
  render(
    withAuth(
      <MemoryRouter>
        <Holds />
      </MemoryRouter>,
      testUser({ role: "admin" }),
    ),
  );
  return openCreator();
}
