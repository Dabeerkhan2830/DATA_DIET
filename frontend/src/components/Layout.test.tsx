import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { platformAdmin, testUser, withAuth } from "../test/auth";
import type { UserProfile } from "../api/types";
import { NAV_ITEMS, visibleNavGroups, visibleNavItems } from "./nav";

vi.mock("../api/demo", () => ({
  fetchHealth: vi.fn().mockRejectedValue(new Error("offline in test")),
}));

// Imported after the mock so HealthIndicator uses the mocked fetch.
import Layout from "./Layout";

function renderLayout(user = platformAdmin()) {
  return renderAt("/", user);
}

/** Render the shell at a concrete path, as an authenticated `user`. */
function renderAt(pathname: string, user: UserProfile = platformAdmin()) {
  return render(
    withAuth(
      <MemoryRouter initialEntries={[pathname]}>
        <Layout />
      </MemoryRouter>,
      user,
    ),
  );
}

function sidebar(): HTMLElement {
  // The persistent rail is the only sidebar present while the drawer is closed.
  return screen.getByRole("complementary", { name: /sidebar/i });
}

function drawer(): HTMLElement {
  return screen.getByRole("dialog", { name: /primary navigation/i });
}

function toggle(): HTMLElement {
  return screen.getByRole("button", { name: "Open navigation" });
}

/** Render the shell and open the drawer, returning its panel. */
async function openDrawer(user = platformAdmin()): Promise<HTMLElement> {
  renderLayout(user);
  await userEvent.click(toggle());
  return drawer();
}

describe("Layout navigation", () => {
  it("exposes every capability area to a platform administrator", () => {
    renderLayout();

    const nav = screen.getByRole("navigation", { name: /primary/i });
    for (const item of NAV_ITEMS) {
      expect(nav).toHaveTextContent(item.label);
    }
  });

  it("lists the required sections", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      "Dashboard",
      "Data Inventory",
      "Sources",
      "Scans",
      "Risk Analysis",
      "Classification",
      "Retention Policies",
      "Retention Holds",
      "Review Queue",
      "Reports",
      "User Management",
      "Archive",
      "Retrieval Requests",
    ]);
  });

  it("shows the API status indicator", async () => {
    renderLayout();

    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
  });

  /* ---------------------------- permission gating ------------------------- */

  it("hides user management from a non-admin account", () => {
    // A reviewer holds every read permission but users:manage.
    renderLayout(testUser({ role: "reviewer" }));

    const nav = screen.getByRole("navigation", { name: /primary/i });
    expect(nav).toHaveTextContent("Review Queue");
    expect(nav).not.toHaveTextContent("User Management");
  });

  it("drops navigation entries whose permission the user lacks", () => {
    const canRead = testUser({ permissions: ["inventory:read", "governance:read"] });
    const visible = visibleNavItems((permission) =>
      canRead.permissions.includes(permission),
    );
    expect(visible.map((item) => item.label)).toEqual([
      "Dashboard",
      "Data Inventory",
      "Risk Analysis",
      "Classification",
      "Reports",
    ]);
  });

  it("renders a heading per populated navigation group", () => {
    renderLayout();

    const nav = screen.getByRole("navigation", { name: /primary/i });
    expect(nav).toHaveTextContent("Overview");
    expect(nav).toHaveTextContent("Discover");
    expect(nav).toHaveTextContent("Govern");
    expect(nav).toHaveTextContent("Administration");
    expect(nav).toHaveTextContent("Coming later");
  });

  it("flags pages that describe work which is not built yet", () => {
    renderLayout();

    const nav = screen.getByRole("navigation", { name: /primary/i });
    // Four screens exist as descriptions only; a first-time reader must not
    // mistake them for features they can use.
    expect(nav.querySelectorAll("[data-planned]")).toHaveLength(4);
    expect(within(nav).getByRole("link", { name: /Archive/ })).toHaveTextContent("Not built");
  });

  it("explains an empty sidebar instead of showing a blank panel", () => {
    // An account the server granted no permissions sees no navigation rows.
    renderLayout(testUser({ permissions: [] }));

    const nav = screen.getByRole("navigation", { name: /primary/i });
    expect(nav).toHaveTextContent("No pages for this account yet");
    expect(nav).toHaveTextContent("Ask an administrator");
    expect(within(nav).queryByRole("link")).not.toBeInTheDocument();
  });

  it("omits a group whose entries are all filtered out", () => {
    const inventoryOnly = testUser({ permissions: ["inventory:read"] });
    renderLayout(inventoryOnly);

    expect(
      visibleNavGroups((permission) => inventoryOnly.permissions.includes(permission)).map(
        (group) => group.label,
      ),
    ).toEqual(["Overview", "Discover"]);

    const nav = screen.getByRole("navigation", { name: /primary/i });
    expect(nav).toHaveTextContent("Risk Analysis");
    expect(nav).not.toHaveTextContent("Administration");
    expect(nav).not.toHaveTextContent("User Management");
  });

  /* --------------------------- active route state ------------------------- */

  it("marks the current route as the page", () => {
    renderAt("/holds");

    expect(screen.getByRole("link", { name: "Retention Holds" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current");
  });

  it("keeps the parent area current for a single-asset screen", () => {
    renderAt("/assessments/12");

    // The asset screen is not the retention list, so this is a section marker
    // rather than `page`; the page's own H1 names where the user actually is.
    // The sidebar row and the breadcrumb both name the parent area, so the
    // assertion is scoped to the navigation it belongs to.
    expect(
      within(sidebar()).getByRole("link", { name: "Retention Policies" }),
    ).toHaveAttribute("aria-current", "true");
    expect(
      within(within(screen.getByRole("banner")).getByRole("navigation", { name: /breadcrumb/i }))
        .getByRole("link", { name: "Retention Policies" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("marks nothing current on an unknown route", () => {
    renderAt("/not-a-screen");

    expect(screen.getByRole("link", { name: "Retention Policies" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(sidebar()).toBeInTheDocument();
  });

  /* --------------------------- identity & session ------------------------- */

  it("shows the signed-in identity, role, and institution", () => {
    renderLayout(
      testUser({ email: "d.pooper@example.org", display_name: "Data Pooper", role: "admin" }),
    );

    expect(screen.getByText("Data Pooper")).toBeInTheDocument();
    expect(screen.getByText("d.pooper@example.org")).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.getByText(/Institution #1/)).toBeInTheDocument();
  });

  it("offers sign-out", () => {
    renderLayout();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });

  it("discards the identity when sign-out is used", async () => {
    renderLayout(platformAdmin());
    expect(screen.getByText("Synthetic Platform Admin")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));

    // The token is discarded and the panel has no identity to show. The shell
    // stays mounted: ending access is the router's and the server's business.
    expect(screen.queryByText("Synthetic Platform Admin")).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /primary/i })).toBeInTheDocument();
  });

  it("keeps the honesty notice in the shell", () => {
    renderLayout();

    const notice = within(sidebar()).getByRole("note");
    expect(notice).toHaveTextContent("No destructive actions enabled");
    expect(notice).toHaveTextContent("Archiving and disposal are not implemented");
  });
});

describe("Shell landmarks, skip link and header context", () => {
  it("provides one of each shell landmark", () => {
    renderLayout();

    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getAllByRole("complementary", { name: /sidebar/i })).toHaveLength(1);
    expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
  });

  it("keeps the shell title out of the heading tree", () => {
    renderAt("/holds");

    const header = screen.getByRole("banner");
    // Every page renders its own H1 through PageHeader; a second heading here
    // would announce the same words twice.
    expect(within(header).queryByRole("heading")).not.toBeInTheDocument();
    expect(header).toHaveTextContent("Retention Holds");
  });

  it("puts the skip link first and points it at the main region", () => {
    renderLayout();

    const skip = screen.getByRole("link", { name: /skip to content/i });
    expect(skip).toHaveAttribute("href", "#main-content");

    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main-content");
    // tabIndex -1 is what lets the browser move focus onto the region.
    expect(main).toHaveAttribute("tabindex", "-1");
    expect(document.body.querySelector("a[href]")).toBe(skip);
  });

  it("shows the route's own title and description in the header", () => {
    renderAt("/classification");

    const header = screen.getByRole("banner");
    expect(header).toHaveTextContent("Classification");
    expect(header).toHaveTextContent("Suggested classifications and data quality");
  });

  it("falls back to the product name on an unmatched route", () => {
    renderAt("/nowhere");

    const header = screen.getByRole("banner");
    expect(header).toHaveTextContent("DataDiet");
    expect(header).toHaveTextContent("Data lifecycle and privacy management");
  });
});

describe("Header breadcrumb for asset detail routes", () => {
  function crumbs(): HTMLElement {
    return within(screen.getByRole("banner")).getByRole("navigation", { name: /breadcrumb/i });
  }

  it("shows the assessment screen's context and trails back to its area", () => {
    renderAt("/assessments/12");

    const header = screen.getByRole("banner");
    expect(header).toHaveTextContent("Asset Assessment");
    expect(header).toHaveTextContent("Findings, evidence, applicable policy version");

    const items = within(crumbs()).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(crumbs()).getByRole("link", { name: "Retention Policies" })).toHaveAttribute(
      "href",
      "/retention",
    );
    expect(items[1]).toHaveTextContent("Asset #12");
    expect(items[1]).toHaveAttribute("aria-current", "page");
  });

  it("trails the governance screen back to the review queue", () => {
    renderAt("/governance/assets/3");

    expect(within(crumbs()).getByRole("link", { name: "Review Queue" })).toHaveAttribute(
      "href",
      "/recommendations",
    );
    expect(crumbs()).toHaveTextContent("Asset #3");
  });

  it("does not offer a breadcrumb link the account could not open", () => {
    // Governance read only: the review queue is not in this account's navigation.
    renderAt("/governance/assets/8", testUser({ permissions: ["governance:read"] }));

    expect(within(crumbs()).queryByRole("link")).not.toBeInTheDocument();
    expect(crumbs()).toHaveTextContent("Review Queue");
    expect(crumbs()).toHaveTextContent("Asset #8");
  });

  it("renders no breadcrumb on a list route", () => {
    renderAt("/retention");

    expect(
      within(screen.getByRole("banner")).queryByRole("navigation", { name: /breadcrumb/i }),
    ).not.toBeInTheDocument();
  });
});

describe("Institution scope control", () => {
  it("shows a scope selector to a platform administrator, defaulting to all institutions", () => {
    renderLayout(platformAdmin());

    const scope = screen.getByRole("combobox", { name: "Institution scope" });
    expect(scope).toHaveValue("");
    expect(within(scope).getByRole("option", { name: "All institutions" })).toBeInTheDocument();
    expect(within(scope).getByRole("option", { name: "Institution #1" })).toBeInTheDocument();
  });

  it("states the institution instead of offering a choice to a single-membership account", () => {
    renderLayout(testUser({ role: "viewer" }));

    expect(screen.queryByRole("combobox", { name: /institution scope/i })).not.toBeInTheDocument();
    expect(within(sidebar()).getByText("Institution #1")).toBeInTheDocument();
  });

  it("lets a multi-membership account re-scope itself", async () => {
    renderLayout(testUser({ institutions: [1, 2], role: "viewer" }));

    const scope = screen.getByRole("combobox", { name: "Institution scope" });
    expect(scope).toHaveValue("1");

    await userEvent.selectOptions(scope, "2");
    expect(scope).toHaveValue("2");

    await userEvent.selectOptions(scope, "1");
    expect(scope).toHaveValue("1");
  });

  it("lets a platform administrator drop back to the unscoped view", async () => {
    renderLayout(platformAdmin());
    const scope = screen.getByRole("combobox", { name: "Institution scope" });

    await userEvent.selectOptions(scope, "1");
    expect(scope).toHaveValue("1");

    await userEvent.selectOptions(scope, "");
    expect(scope).toHaveValue("");
  });

  it("keeps the scope selector in the sidebar, not the header", () => {
    renderLayout(platformAdmin());

    expect(within(screen.getByRole("banner")).queryByRole("combobox")).not.toBeInTheDocument();
  });
});

describe("Mobile navigation drawer", () => {
  it("exposes the toggle's expanded state and target", () => {
    renderLayout();

    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).toHaveAttribute("aria-controls", "mobile-navigation");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens as a modal navigation dialog and flips the toggle", async () => {
    const panel = await openDrawer();

    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(panel).toHaveAttribute("aria-modal", "true");
    expect(panel).toHaveAttribute("id", "mobile-navigation");
    expect(within(panel).getByRole("navigation", { name: /primary/i })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Close navigation" })).toBeInTheDocument();
  });

  it("moves focus into the drawer and back to the toggle on close", async () => {
    renderLayout();
    const opener = toggle();

    await userEvent.click(opener);
    expect(drawer().contains(document.activeElement)).toBe(true);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  it("closes on Escape", async () => {
    await openDrawer();
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes from its own close button", async () => {
    const panel = await openDrawer();
    await userEvent.click(within(panel).getByRole("button", { name: "Close navigation" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes when the backdrop is clicked", async () => {
    const panel = await openDrawer();
    // The scrim is the element painted under the panel, not a control.
    const backdrop = panel.previousElementSibling as HTMLElement;
    expect(backdrop).toHaveAttribute("aria-hidden", "true");

    await userEvent.click(backdrop);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes after the user chooses a destination", async () => {
    const panel = await openDrawer();
    await userEvent.click(within(panel).getByRole("link", { name: "Retention Holds" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The choice also took effect: the rail now marks the new page.
    expect(screen.getByRole("link", { name: "Retention Holds" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("traps Tab inside the drawer", async () => {
    const panel = await openDrawer();
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>(
        [
          "button:not([disabled])",
          "a[href]",
          "input:not([disabled])",
          "select:not([disabled])",
          "textarea:not([disabled])",
          "[tabindex]:not([tabindex='-1'])",
        ].join(","),
      ),
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    expect(focusables.length).toBeGreaterThan(3);

    last.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(first);

    first.focus();
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(last);

    first.focus();
    await userEvent.tab();
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it("locks and restores background scroll while the drawer is open", async () => {
    expect(document.body.style.overflow).toBe("");

    await openDrawer();
    expect(document.body.style.overflow).toBe("hidden");

    await userEvent.keyboard("{Escape}");
    expect(document.body.style.overflow).toBe("");
  });

  it("carries the identity panel and honesty notice into the drawer", async () => {
    const panel = await openDrawer(testUser({ display_name: "Synthetic Viewer", role: "viewer" }));

    expect(within(panel).getByText("Synthetic Viewer")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /sign out/i })).toBeInTheDocument();
    expect(within(panel).getByRole("note")).toHaveTextContent(
      "Archiving and disposal are not implemented",
    );
  });
});
