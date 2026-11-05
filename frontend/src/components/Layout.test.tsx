import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { platformAdmin, testUser, withAuth } from "../test/auth";
import { NAV_ITEMS, visibleNavItems } from "./nav";

vi.mock("../api/demo", () => ({
  fetchHealth: vi.fn().mockRejectedValue(new Error("offline in test")),
}));

// Imported after the mock so HealthIndicator uses the mocked fetch.
import Layout from "./Layout";

function renderLayout(user = platformAdmin()) {
  return render(
    withAuth(
      <MemoryRouter initialEntries={["/"]}>
        <Layout />
      </MemoryRouter>,
      user,
    ),
  );
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
      "Risk Analysis",
      "Classification",
      "Retention Policies",
      "Retention Holds",
      "Review Queue",
      "Archive",
      "Retrieval Requests",
      "Reports",
      "User Management",
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

  /* --------------------------- identity & session ------------------------- */

  it("shows the signed-in identity, role, and institution", () => {
    renderLayout(
      testUser({ email: "d.pooper@example.org", display_name: "Data Pooper", role: "admin" }),
    );

    expect(screen.getByText("Data Pooper")).toBeInTheDocument();
    expect(screen.getByText("d.pooper@example.org")).toBeInTheDocument();
    expect(screen.getByText(/Admin/)).toBeInTheDocument();
    expect(screen.getByText(/Institution #1/)).toBeInTheDocument();
  });

  it("offers sign-out", () => {
    renderLayout();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });
});
