import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { Spinner } from "./Spinner";

describe("state components", () => {
  it("Spinner announces a loading status", () => {
    render(<Spinner label="Loading inventory…" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading inventory…");
  });

  it("ErrorState shows the message and a retry action", () => {
    const onRetry = vi.fn();
    render(<ErrorState title="Inventory unavailable" message="Request failed" onRetry={onRetry} />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Request failed")).toBeInTheDocument();

    screen.getByRole("button", { name: /retry/i }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("EmptyState explains what is missing", () => {
    render(<EmptyState title="No records yet" message="Nothing has been inventoried." />);
    expect(screen.getByText("No records yet")).toBeInTheDocument();
    expect(screen.getByText("Nothing has been inventoried.")).toBeInTheDocument();
  });
});
