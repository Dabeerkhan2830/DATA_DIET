/**
 * Inventory (redesign Phase 5.2): the real asset list experience.
 *
 * The asset API module is mocked, so these tests fix the *contract usage* —
 * which query the page sends, what it renders from the response, and how it
 * behaves while a request is in flight — without a backend. The URL itself is
 * asserted in `src/api/assets.test.ts`.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { Asset, AssetListResponse } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { platformAdmin, testUser, withAuth } from "../test/auth";

const listAssets = vi.fn();

vi.mock("../api/assets", () => ({
  listAssets: (...args: unknown[]) => listAssets(...args),
}));

import DataInventory from "./DataInventory";

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 1,
    institution_id: 1,
    data_source_id: 2,
    external_id: "SYNTH-0001",
    title: "Payroll export",
    description: null,
    record_type: "file",
    category: "finance",
    source_type: "hris",
    file_name: "payroll-2026-10.csv",
    mime_type: "text/csv",
    size_bytes: 1048576,
    checksum_sha256: null,
    sensitivity: "confidential",
    contains_personal_data: true,
    duplicate_of_id: null,
    owner_team: "Finance",
    owner_email: "finance@example.org",
    lifecycle_status: "active",
    last_reviewed: "2026-09-30",
    source_created_at: null,
    source_modified_at: null,
    created_at: "2026-10-01T08:00:00",
    updated_at: "2026-10-12T09:30:00",
    ...overrides,
  };
}

function makePage(items: Asset[], overrides: Partial<AssetListResponse> = {}): AssetListResponse {
  return {
    items,
    total: items.length,
    page: 1,
    per_page: 20,
    pages: 1,
    ...overrides,
  };
}

/** Test-only control: changes the signed-in account's active institution scope. */
function InstitutionScopeSwitch({ to }: { to: number | null }) {
  const { setActiveInstitution } = useAuth();
  return (
    <button type="button" onClick={() => setActiveInstitution(to)}>
      scope {to === null ? "all" : to}
    </button>
  );
}

async function renderInventory(user = testUser()): Promise<void> {
  render(
    withAuth(
      <MemoryRouter>
        <DataInventory />
      </MemoryRouter>,
      user,
    ),
  );
  await screen.findByRole("heading", { name: /^Data records \(/ });
}

function searchBox(): HTMLElement {
  return screen.getByRole("searchbox", { name: "Search data records" });
}

beforeEach(() => {
  listAssets.mockReset();
});

describe("asset request", () => {
  it("asks the asset endpoint for the first page in the active institution scope", async () => {
    listAssets.mockResolvedValue(makePage([makeAsset()]));
    await renderInventory();

    expect(listAssets).toHaveBeenCalledWith(
      {
        page: 1,
        per_page: 20,
        search: undefined,
        sensitivity: undefined,
        lifecycle_status: undefined,
        category: undefined,
        source_type: undefined,
        institution_id: 1,
      },
      expect.any(AbortSignal),
    );
  });

  it("leaves the institution filter unset for an unscoped platform administrator", async () => {
    listAssets.mockResolvedValue(makePage([makeAsset()]));
    await renderInventory(platformAdmin());

    expect(listAssets).toHaveBeenLastCalledWith(
      expect.objectContaining({ institution_id: undefined }),
      expect.any(AbortSignal),
    );
  });

  it("re-queries for the newly active institution", async () => {
    listAssets.mockResolvedValue(makePage([makeAsset()]));
    render(
      withAuth(
        <MemoryRouter>
          <>
            <DataInventory />
            <InstitutionScopeSwitch to={2} />
          </>
        </MemoryRouter>,
      ),
    );
    await screen.findByRole("heading", { name: /^Data records \(/ });

    await userEvent.click(screen.getByRole("button", { name: "scope 2" }));

    await waitFor(() => {
      expect(listAssets).toHaveBeenLastCalledWith(
        expect.objectContaining({ institution_id: 2 }),
        expect.any(AbortSignal),
      );
    });
  });

  it("sends a search only once the typing settles", async () => {
    listAssets.mockResolvedValue(makePage([makeAsset()]));
    await renderInventory();
    expect(listAssets).toHaveBeenCalledTimes(1);

    await userEvent.type(searchBox(), "payroll");

    // Seven keystrokes, and the server is not queried one of them at a time.
    expect(listAssets).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(listAssets).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: "payroll" }),
        expect.any(AbortSignal),
      );
    });
    expect(listAssets).toHaveBeenCalledTimes(2);
  });

  it("sends a dropdown filter immediately and returns to the first page", async () => {
    listAssets.mockResolvedValue(makePage([makeAsset()], { page: 2, pages: 3, total: 41 }));
    await renderInventory();

    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => {
      expect(listAssets).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2 }),
        expect.any(AbortSignal),
      );
    });

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Sensitivity" }),
      "restricted",
    );

    await waitFor(() => {
      expect(listAssets).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, sensitivity: "restricted" }),
        expect.any(AbortSignal),
      );
    });
  });

  it("keeps the exact-match filters behind one control", async () => {
    listAssets.mockResolvedValue(makePage([makeAsset()]));
    await renderInventory();

    // Two familiar filters are always in view; the two that need a stored
    // value are not, until the reader asks for them.
    expect(screen.queryByRole("textbox", { name: /Category/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /Source type/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /More filters/i }));

    expect(screen.getByRole("textbox", { name: /Category/i })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Source type/i })).toBeInTheDocument();
  });

  it("sends the exact-match category and lifecycle filters", async () => {
    listAssets.mockResolvedValue(makePage([makeAsset()]));
    await renderInventory();

    await userEvent.click(screen.getByRole("button", { name: /More filters/i }));
    await userEvent.type(
      screen.getByRole("textbox", { name: /Category/i }),
      "hr_records",
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Lifecycle status" }),
      "under_review",
    );

    await waitFor(() => {
      expect(listAssets).toHaveBeenLastCalledWith(
        expect.objectContaining({
          category: "hr_records",
          lifecycle_status: "under_review",
        }),
        expect.any(AbortSignal),
      );
    });
  });

  it("clears every filter from the filter card", async () => {
    listAssets.mockResolvedValue(makePage([makeAsset()]));
    await renderInventory();

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Sensitivity" }),
      "restricted",
    );
    await userEvent.click(screen.getByRole("button", { name: /Clear filters/ }));

    await waitFor(() => {
      expect(listAssets).toHaveBeenLastCalledWith(
        expect.objectContaining({
          page: 1,
          search: undefined,
          sensitivity: undefined,
          category: undefined,
          source_type: undefined,
          lifecycle_status: undefined,
        }),
        expect.any(AbortSignal),
      );
    });
    expect(screen.queryByRole("button", { name: /Clear filters/ })).not.toBeInTheDocument();
  });
});

describe("asset results", () => {
  it("renders the fields of the real response", async () => {
    listAssets.mockResolvedValue(makePage([makeAsset()]));
    await renderInventory();

    const table = screen.getByRole("table", { name: "Data records in the current view" });
    const row = within(table).getByRole("row", { name: /Payroll export/ });

    expect(within(row).getByText("Payroll export")).toBeInTheDocument();
    expect(within(row).getByText("#1 · SYNTH-0001")).toBeInTheDocument();
    expect(within(row).getByText("payroll-2026-10.csv")).toBeInTheDocument();
    expect(within(row).getByText("Confidential")).toBeInTheDocument();
    expect(within(row).getByText("Active")).toBeInTheDocument();
    expect(within(row).getByText("Contains personal data")).toBeInTheDocument();
    expect(within(row).getByText("1.0 MB")).toBeInTheDocument();
    expect(within(row).getByText("Hris")).toBeInTheDocument();
    expect(within(row).getByText("Finance · File")).toBeInTheDocument();
    // The date is machine-readable as well as formatted, so the assertion does
    // not depend on the test runner's locale.
    expect(row.querySelector("time[datetime='2026-10-12']")).not.toBeNull();
  });

  it("reports the server's total, not the number of rows on the page", async () => {
    listAssets.mockResolvedValue(
      makePage([makeAsset(), makeAsset({ id: 2, title: "Research grant ledger" })], {
        total: 41,
        pages: 3,
      }),
    );
    await renderInventory();

    expect(screen.getByRole("heading", { name: "Data records (41)" })).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 3 · 41 records found")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + two rows
  });

  it("disables the controls that would leave the page range", async () => {
    listAssets.mockResolvedValue(makePage([makeAsset()], { total: 41, pages: 3 }));
    await renderInventory();

    expect(screen.getByRole("button", { name: /Previous/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Next/ })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Previous/ })).toBeEnabled();
    });
    expect(screen.getByRole("button", { name: /Next/ })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();
    });
    expect(listAssets).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 3 }),
      expect.any(AbortSignal),
    );
  });

  it("links a permitted reviewer to the governance view of an asset", async () => {
    listAssets.mockResolvedValue(makePage([makeAsset()]));
    await renderInventory();

    const link = screen.getByRole("link", { name: /Open governance view for Payroll export/ });
    expect(link).toHaveAttribute("href", "/governance/assets/1");
  });

  it("offers no governance link to an inventory-only account", async () => {
    listAssets.mockResolvedValue(makePage([makeAsset()]));
    await renderInventory(testUser({ permissions: ["inventory:read"] }));

    expect(
      screen.queryByRole("link", { name: /governance view/ }),
    ).not.toBeInTheDocument();
    // The row itself is still rendered: hiding it would hide a fact the account
    // is allowed to see.
    expect(screen.getByText("Payroll export")).toBeInTheDocument();
  });

  it("marks a duplicate with the asset it duplicates", async () => {
    listAssets.mockResolvedValue(makePage([makeAsset({ duplicate_of_id: 7 })]));
    await renderInventory();

    expect(screen.getByText("Duplicate of #7")).toBeInTheDocument();
  });

  it("names an unclassified asset as not classified", async () => {
    listAssets.mockResolvedValue(makePage([makeAsset({ sensitivity: "unknown" })]));
    await renderInventory();

    const row = screen.getByRole("row", { name: /Payroll export/ });
    expect(within(row).getByText("Not classified")).toBeInTheDocument();
  });

  it("says so when the inventory database holds nothing", async () => {
    listAssets.mockResolvedValue(makePage([]));
    await renderInventory();

    expect(screen.getByText("No data records match this search")).toBeInTheDocument();
    expect(screen.getByText(/This scope has no data records yet/)).toBeInTheDocument();
  });

  it("distinguishes an empty result from an empty database once a filter is set", async () => {
    listAssets.mockResolvedValue(makePage([]));
    await renderInventory();

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Sensitivity" }),
      "restricted",
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Remove a filter, or change the institution scope/),
      ).toBeInTheDocument();
    });
  });

  it("shows no synthetic-data notice, because this page is not a demo view", async () => {
    listAssets.mockResolvedValue(makePage([makeAsset()]));
    await renderInventory();

    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});

describe("request states", () => {
  it("shows a loading state before the first page arrives", async () => {
    let resolvePage: (value: AssetListResponse) => void = () => undefined;
    listAssets.mockImplementation(
      () => new Promise<AssetListResponse>((resolve) => (resolvePage = resolve)),
    );

    render(
      withAuth(
        <MemoryRouter>
          <DataInventory />
        </MemoryRouter>,
      ),
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading data records…");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    resolvePage(makePage([makeAsset()]));
    await screen.findByRole("table");
  });

  it("marks the table busy text while a later request is in flight", async () => {
    let resolveSecond: (value: AssetListResponse) => void = () => undefined;
    listAssets
      .mockResolvedValueOnce(makePage([makeAsset()]))
      .mockImplementation(
        () => new Promise<AssetListResponse>((resolve) => (resolveSecond = resolve)),
      );

    await renderInventory();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Sensitivity" }),
      "restricted",
    );

    expect(screen.getByRole("status")).toHaveTextContent("Refreshing…");
    // The previous page stays on screen until the replacement arrives.
    expect(screen.getByText("Payroll export")).toBeInTheDocument();

    resolveSecond(makePage([makeAsset({ id: 9, title: "Estate inventory" })]));
    await screen.findByText("Estate inventory");
    expect(screen.queryByText("Payroll export")).not.toBeInTheDocument();
  });

  it("shows the server's refusal and retries the same request", async () => {
    listAssets.mockRejectedValueOnce(new ApiError("institution_out_of_scope", 404));

    render(
      withAuth(
        <MemoryRouter>
          <DataInventory />
        </MemoryRouter>,
      ),
    );

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Inventory unavailable")).toBeInTheDocument();
    expect(alert).toHaveTextContent("institution_out_of_scope");

    listAssets.mockResolvedValue(makePage([makeAsset()]));
    await userEvent.click(within(alert).getByRole("button", { name: /Retry/ }));

    await screen.findByRole("table");
    expect(listAssets).toHaveBeenCalledTimes(2);
  });

  it("keeps a superseded response from replacing the current results", async () => {
    let resolveStale: (value: AssetListResponse) => void = () => undefined;
    listAssets
      .mockImplementationOnce(
        () => new Promise<AssetListResponse>((resolve) => (resolveStale = resolve)),
      )
      .mockResolvedValue(makePage([makeAsset({ id: 5, title: "Research grant ledger" })]));

    render(
      withAuth(
        <MemoryRouter>
          <DataInventory />
        </MemoryRouter>,
      ),
    );

    // A filter change supersedes the request still in flight, which only
    // resolves afterwards, with a different answer.
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Sensitivity" }),
      "restricted",
    );
    resolveStale(makePage([makeAsset({ id: 1, title: "Payroll export" })]));

    await screen.findByText("Research grant ledger");
    expect(screen.queryByText("Payroll export")).not.toBeInTheDocument();
  });
});

describe("responsive presentation", () => {
  it("keeps a real table whose secondary columns collapse on narrow screens", async () => {
    listAssets.mockResolvedValue(makePage([makeAsset()]));
    await renderInventory();

    const header = screen.getByRole("row", { name: /Record Sensitivity Lifecycle/ });
    const cells = within(header).getAllByRole("columnheader");
    const className = (name: string) =>
      cells.find((cell) => cell.textContent === name)?.className ?? "";

    // Always present: an asset is identifiable on a phone.
    expect(className("Record")).not.toContain("hidden");
    expect(className("Sensitivity")).not.toContain("hidden");
    expect(className("Lifecycle")).not.toContain("hidden");

    // Progressive detail: hidden below their breakpoint, so a phone shows only
    // the four columns that identify and classify an asset (measured at 441px).
    expect(className("Source")).toContain("hidden lg:table-cell");
    expect(className("Size")).toContain("hidden md:table-cell");
    expect(className("Updated")).toContain("hidden xl:table-cell");

    // Still one table with a caption, never a grid of divs.
    expect(screen.getByRole("table", { name: "Data records in the current view" })).toBeInTheDocument();
  });
});
