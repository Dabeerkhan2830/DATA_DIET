import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Progress } from "./Progress";

describe("Progress", () => {
  it("reports the value, the range and a name", () => {
    render(<Progress value={40} label="Scan progress" />);

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-label", "Scan progress");
    expect(bar).toHaveAttribute("aria-valuenow", "40");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuetext", "40%");
  });

  it("scales to a custom maximum", () => {
    render(<Progress value={3} max={6} label="Findings reviewed" />);

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveAttribute("aria-valuemax", "6");
    expect(bar).toHaveAttribute("aria-valuetext", "50%");
  });

  it("clamps a value that escapes the range", () => {
    const { rerender } = render(<Progress value={150} label="Scan progress" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");

    rerender(<Progress value={-8} label="Scan progress" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });

  it("claims no value when the work has no measurable end", () => {
    render(<Progress value={null} label="Contacting the catalogue" />);

    const bar = screen.getByRole("progressbar");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).not.toHaveAttribute("aria-valuetext");
    expect(bar).toHaveAttribute("aria-busy", "true");
  });

  it("hides the animated fill from the accessibility tree", () => {
    const { container } = render(<Progress value={25} label="Scan progress" />);

    const fill = container.querySelector("div[style]");
    expect(fill).toHaveAttribute("aria-hidden", "true");
    expect(fill).toHaveStyle({ width: "25%" });
  });

  it("paints the fill from the resolved status role", () => {
    const { container } = render(<Progress value={60} tone="success" label="Retention sweep" />);
    expect(container.querySelector("div[style]")?.className).toContain("bg-success");
  });

  it("folds a brand accent and a legacy palette name onto a status", () => {
    const { container, rerender } = render(
      <Progress value={10} tone="accent" label="Migration" />,
    );
    expect(container.querySelector("div[style]")?.className).toContain("bg-neutral");

    rerender(<Progress value={10} tone="emerald" label="Migration" />);
    expect(container.querySelector("div[style]")?.className).toContain("bg-success");
  });

  it("can print the percentage in text", () => {
    render(<Progress value={80} label="Scan progress" showValue />);
    expect(screen.getByText("80%")).toBeInTheDocument();
  });
});
