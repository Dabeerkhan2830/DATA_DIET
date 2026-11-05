import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DASHBOARD_SUMMARY, envelope } from "../test/fixtures";
import Dashboard from "./Dashboard";

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Server Error",
    json: async () => payload,
  } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Dashboard", () => {
  it("renders summary figures from the API envelope", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(envelope(DASHBOARD_SUMMARY)));

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("Inventory records")).toBeInTheDocument();
    });

    expect(screen.getByText("14")).toBeInTheDocument();
    expect(screen.getByText("Duplicate candidates")).toBeInTheDocument();
    expect(screen.getByText("Pending approvals")).toBeInTheDocument();
    expect(screen.getByText("Retention policy v3 draft created (synthetic).")).toBeInTheDocument();
  });

  it("labels the data as synthetic", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(envelope(DASHBOARD_SUMMARY)));

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("note")).toHaveTextContent(/SYNTHETIC DEMO DATA/i);
    });
  });

  it("shows an error state with retry when the API is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByText(/could not reach the datadiet api/i)).toBeInTheDocument();
  });
});
