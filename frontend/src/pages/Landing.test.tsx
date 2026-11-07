/**
 * The public landing page.
 *
 * Two properties matter here and both are contractual, not cosmetic: the page
 * must be reachable with no session and must ask the server for nothing to
 * render (it is the only screen a stranger can load), and it must not claim
 * that a capability exists when the code says otherwise. The assertions below
 * are on the words and the destinations, because those are what a reader — or
 * a prospective customer — is actually being told.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../api/types";
import { setExternalSessionSnapshot } from "../auth/externalSession";
import App from "../App";

const fetchAuthConfig = vi.fn();
const devLogin = vi.fn();
const fetchMe = vi.fn();

vi.mock("../api/auth", () => ({
  fetchAuthConfig: (...args: unknown[]) => fetchAuthConfig(...args),
  devLogin: (...args: unknown[]) => devLogin(...args),
  fetchMe: (...args: unknown[]) => fetchMe(...args),
}));

const DEVELOPMENT: AuthConfig = {
  environment: "development",
  authentication: "development",
  dev_login_enabled: true,
  identity_provider: "local",
  issuer: "datadiet",
  audience: "datadiet-api",
  token_ttl_seconds: 900,
  description: "Local development sign-in is available.",
};

/** The four areas the navigation offers, and the section each one resolves to. */
const NAV_LINKS: Array<[label: string, href: string]> = [
  ["Product", "#platform"],
  ["Solutions", "#solutions"],
  ["Resources", "#resources"],
  ["Company", "#company"],
];

/** Sections a reader can be sent to, each with the heading it must contain. */
const SECTIONS: Array<[id: string, heading: string]> = [
  ["platform", "A complete lifecycle for institutional data"],
  ["solutions", "Built around the pressures institutions actually carry"],
  ["governance", "Controls that hold up when someone asks"],
  ["customers", "One institution, one scope, four kinds of account"],
  ["resources", "What you can read, and where it lives"],
  ["company", "A prototype, described as one"],
  ["contact", "Bring clarity and control to your institutional data."],
];

function section(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`No element has id "${id}".`);
  }
  return node;
}

function renderAtRoot() {
  window.history.pushState({}, "", "/");
  return render(<App />);
}

beforeEach(() => {
  localStorage.clear();
  setExternalSessionSnapshot({ state: "idle" });
  fetchAuthConfig.mockReset();
  fetchMe.mockReset();
  devLogin.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Landing page", () => {
  it("renders for a visitor with no session and without contacting the server", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    renderAtRoot();

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Know your data. Stay in control.",
      }),
    ).toBeInTheDocument();
    // The page is a static argument plus a fixture illustration: nothing on it
    // may reach the API, because nobody has been authenticated.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchMe).not.toHaveBeenCalled();
  });

  it("keeps exactly one h1 and gives every section its own h2", async () => {
    renderAtRoot();

    await screen.findByRole("heading", { level: 1 });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    for (const [id, heading] of SECTIONS) {
      expect(section(id)).toBeInTheDocument();
      expect(
        within(section(id)).getByRole("heading", { level: 2, name: heading }),
      ).toBeInTheDocument();
    }
  });

  it("resolves every in-page anchor to a section that exists", async () => {
    renderAtRoot();
    await screen.findByRole("heading", { level: 1 });

    const anchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('header a[href^="#"], main a[href^="#"], footer a[href^="#"]'),
    );
    expect(anchors.length).toBeGreaterThan(0);

    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") as string;
      expect(
        document.getElementById(href.slice(1)),
        `${href} has no target`,
      ).not.toBeNull();
    }
  });

  it("links nothing that does not exist: no dead hash, no mail, no invented page", async () => {
    renderAtRoot();
    await screen.findByRole("heading", { level: 1 });

    const hrefs = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).map(
      (link) => link.getAttribute("href") as string,
    );

    expect(hrefs).not.toContain("#");
    expect(hrefs.filter((href) => href.startsWith("mailto:"))).toHaveLength(0);
    expect(hrefs.filter((href) => /^https?:\/\//.test(href))).toHaveLength(0);
    /*
      The only routes this page can honestly offer are the application itself
      (`/signin`) and its own root. `/docs`, `/privacy` and `/terms` are not
      routes of this build, so they must not appear as links.
    */
    expect(new Set(hrefs.filter((href) => href.startsWith("/")))).toEqual(
      new Set(["/", "/signin"]),
    );
  });

  it("states which lifecycle capabilities are planned rather than implemented", async () => {
    renderAtRoot();

    expect(await screen.findAllByText("Planned, not implemented")).toHaveLength(3);
    expect(screen.getByText("Partly implemented")).toBeInTheDocument();

    expect(
      within(section("platform")).getByText(/nothing is moved, copied, or written to cold storage/i),
    ).toBeInTheDocument();
    expect(
      within(section("platform")).getByText(/no request can be raised or filled yet/i),
    ).toBeInTheDocument();
    expect(
      within(section("governance")).getByText(/no object is stored today/i),
    ).toBeInTheDocument();
  });

  it("claims no certifications, no customers, and no metrics", async () => {
    renderAtRoot();
    await screen.findByRole("heading", { level: 1 });

    expect(
      within(section("governance")).getByText(
        /no ISO 27001, SOC 2, GDPR adequacy, HIPAA or Cyber Essentials statement/i,
      ),
    ).toBeInTheDocument();
    expect(
      within(section("solutions")).getByText(/they are not customer references/i),
    ).toBeInTheDocument();
    expect(
      within(section("customers")).getByText(/we publish no customer names/i),
    ).toBeInTheDocument();

    expect(screen.queryByText(/trusted by/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/% of customers/i)).not.toBeInTheDocument();
  });

  it("labels the product illustration as fixture data and keeps it out of the accessibility tree", async () => {
    renderAtRoot();

    const caption = await screen.findByText(/every figure and path above is a fixture/i);
    const figure = caption.closest("figure");
    expect(figure).not.toBeNull();

    // The invented numbers are decoration; only the caption is announced, so a
    // screen reader never hears a fixture as a metric of anything.
    const panel = figure?.querySelector("[aria-hidden='true']") as HTMLElement;
    expect(within(panel).getByText("12,486")).toBeInTheDocument();
    expect(within(panel).getByText("Data records")).toBeInTheDocument();
    expect(screen.queryByText("12,486", { exact: true })).toBeInTheDocument();
    // The only table in the accessibility tree is the documented role matrix;
    // the mockup's fake inventory table is hidden along with its numbers.
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(within(section("customers")).getByRole("table")).toBeInTheDocument();
  });

  it("hands the visitor to the real sign-in route", async () => {
    fetchAuthConfig.mockResolvedValue(DEVELOPMENT);

    renderAtRoot();
    await screen.findByRole("heading", { level: 1 });

    // Every "Sign in" label on the page is the real route, not an anchor.
    const signInLinks = screen.getAllByRole("link", { name: /^sign in$/i });
    expect(signInLinks.length).toBeGreaterThan(1);
    for (const link of signInLinks) {
      expect(link).toHaveAttribute("href", "/signin");
    }
    await userEvent.click(signInLinks[0]);

    expect(window.location.pathname).toBe("/signin");
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
  });

  it("operates the small-screen menu as a dismissable dialog", async () => {
    renderAtRoot();
    await screen.findByRole("heading", { level: 1 });

    const user = userEvent.setup();
    const toggle = screen.getByRole("button", { name: "Open navigation" });
    await user.click(toggle);

    const dialog = await screen.findByRole("dialog", { name: "Primary navigation" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", dialog.id);
    expect(dialog).toHaveAttribute("aria-modal", "true");

    // The panel carries the same five areas as the desktop row, as anchors.
    for (const [label, href] of NAV_LINKS) {
      expect(within(dialog).getByRole("link", { name: label })).toHaveAttribute("href", href);
    }
    expect(within(dialog).getByRole("link", { name: /request a demo/i })).toHaveAttribute(
      "href",
      "#contact",
    );

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});
