import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button, type ButtonVariant } from "./Button";
import { IconButton } from "./IconButton";

const VARIANT_SURFACE: Array<{ variant: ButtonVariant; surface: string }> = [
  { variant: "primary", surface: "bg-accent" },
  { variant: "secondary", surface: "bg-surface" },
  { variant: "ghost", surface: "bg-transparent" },
  { variant: "critical", surface: "bg-critical" },
];

describe("Button", () => {
  it("paints each variant from its semantic role, not a palette step", () => {
    render(
      <>
        {VARIANT_SURFACE.map(({ variant }) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
      </>,
    );

    for (const { variant, surface } of VARIANT_SURFACE) {
      expect(screen.getByRole("button", { name: variant }).className).toContain(surface);
    }
  });

  it("never becomes a form submit by accident", () => {
    render(
      <>
        <Button>Defaults</Button>
        <Button type="submit">Submits</Button>
      </>,
    );

    expect(screen.getByRole("button", { name: "Defaults" })).toHaveAttribute("type", "button");
    expect(screen.getByRole("button", { name: "Submits" })).toHaveAttribute("type", "submit");
  });

  it("does not run the handler while disabled", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Blocked
      </Button>,
    );

    screen.getByRole("button", { name: "Blocked" }).click();
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Blocked" })).toBeDisabled();
  });

  it("says it is busy while loading and refuses a second press", () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Saving
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Saving" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();

    button.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps the loading glyph out of the accessibility tree", () => {
    const { container } = render(
      <Button loading>
        Working
      </Button>,
    );

    const glyph = container.querySelector("span[aria-hidden='true']");
    expect(glyph).not.toBeNull();
    expect(glyph?.className).toContain("animate-spin");
  });

  it("sizes the control and can stretch it across the row", () => {
    render(
      <>
        <Button size="sm">Small</Button>
        <Button fullWidth>Wide</Button>
      </>,
    );

    expect(screen.getByRole("button", { name: "Small" }).className).toContain("min-h-8");
    expect(screen.getByRole("button", { name: "Wide" }).className).toContain("w-full");
  });

  it("lets the caller override the class list without losing the variant", () => {
    render(
      <Button className="mt-4" variant="ghost">
        Custom
      </Button>,
    );

    const className = screen.getByRole("button", { name: "Custom" }).className;
    expect(className).toContain("mt-4");
    expect(className).toContain("bg-transparent");
  });
});

describe("IconButton", () => {
  it("takes its accessible name from the label, not the glyph", () => {
    render(
      <IconButton aria-label="Refresh inventory">
        <svg data-testid="glyph" />
      </IconButton>,
    );

    expect(screen.getByRole("button", { name: "Refresh inventory" })).toBeInTheDocument();
  });

  it("stays square per size so the hit area does not shrink with the icon", () => {
    render(
      <>
        <IconButton aria-label="small" size="sm">
          <svg />
        </IconButton>
        <IconButton aria-label="medium">
          <svg />
        </IconButton>
      </>,
    );

    expect(screen.getByRole("button", { name: "small" }).className).toContain("h-8 w-8");
    expect(screen.getByRole("button", { name: "medium" }).className).toContain("h-9 w-9");
  });

  it("does not fire while disabled", () => {
    const onClick = vi.fn();
    render(
      <IconButton aria-label="Close page" disabled onClick={onClick}>
        <svg />
      </IconButton>,
    );

    screen.getByRole("button", { name: "Close page" }).click();
    expect(onClick).not.toHaveBeenCalled();
  });
});
