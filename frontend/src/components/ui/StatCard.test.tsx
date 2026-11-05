import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatCard } from "./StatCard";

describe("StatCard", () => {
  it("renders the label, value, and hint", () => {
    render(<StatCard label="Inventory records" value={14} hint="Sample records" />);

    expect(screen.getByText("Inventory records")).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
    expect(screen.getByText("Sample records")).toBeInTheDocument();
  });

  it("renders string values such as formatted storage sizes", () => {
    render(<StatCard label="Storage tracked" value="10.0 GB" />);

    expect(screen.getByText("10.0 GB")).toBeInTheDocument();
  });
});
