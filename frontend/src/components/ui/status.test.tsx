import { render, screen } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";
import type { StatusTone } from "../../lib/semantic";
import { StatusIcon } from "../icons";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Progress } from "./Progress";
import { ToastProvider, useToast } from "./Toast";

const ROLES: StatusTone[] = ["neutral", "info", "success", "warning", "caution", "critical"];

function StatusRow() {
  return (
    <>
      {ROLES.map((role) => (
        <Badge key={role} tone={role}>{`badge ${role}`}</Badge>
      ))}
      {ROLES.map((role) => (
        <Progress key={role} value={50} tone={role} label={`progress ${role}`} className={`w-24 progress-${role}`} />
      ))}
      {ROLES.map((role) => (
        <span key={role} data-tone={role}>
          <StatusIcon tone={role} />
        </span>
      ))}
    </>
  );
}

function StatusToasts() {
  const { show } = useToast();
  return (
    <Button
      onClick={() => {
        for (const role of ROLES) {
          show({ title: `toast ${role}`, tone: role });
        }
      }}
    >
      Show all
    </Button>
  );
}

describe("status surfaces agree", () => {
  it("paints each role from its own token quartet in a badge", () => {
    render(<StatusRow />);

    for (const role of ROLES) {
      const badge = screen.getByText(`badge ${role}`);
      expect(badge.classList.contains(`bg-${role}-surface`)).toBe(true);
      expect(badge.classList.contains(`text-${role}-ink`)).toBe(true);
      expect(badge.classList.contains(`ring-${role}-line`)).toBe(true);
    }
  });

  it("fills a progress bar with the matching solid role", () => {
    const { container } = render(<StatusRow />);

    for (const role of ROLES) {
      const fill = container.querySelector(`.progress-${role} div[style]`);
      expect(fill).not.toBeNull();
      expect((fill as Element).classList.contains(`bg-${role}`)).toBe(true);
    }
  });

  it("pairs each role with its own glyph", () => {
    const { container } = render(<StatusRow />);

    const markupOf = (role: StatusTone) =>
      container.querySelector(`[data-tone="${role}"]`)?.innerHTML ?? "";

    for (const role of ROLES) {
      const svg = container.querySelector(`[data-tone="${role}"] svg`);
      expect(svg).toHaveAttribute("aria-hidden", "true");
    }

    // Five distinct meanings need five distinct shapes; only `caution` borrows
    // the warning triangle, because it differs from `warning` in colour, not kind.
    const distinct = new Set(
      (["neutral", "info", "success", "warning", "critical"] as StatusTone[]).map(markupOf),
    );
    expect(distinct.size).toBe(5);
    expect(markupOf("caution")).toBe(markupOf("warning"));
  });

  it("paints the same role in a toast", () => {
    const { container } = render(
      <ToastProvider maxVisible={ROLES.length}>
        <StatusToasts />
      </ToastProvider>,
    );

    act(() => {
      screen.getByRole("button", { name: "Show all" }).click();
    });

    for (const role of ROLES) {
      const item = container.querySelector(`.bg-${role}-surface`);
      expect(item).not.toBeNull();
      expect(item?.textContent).toContain(`toast ${role}`);
      expect((item as Element).classList.contains(`text-${role}-ink`)).toBe(true);
    }
  });
});
