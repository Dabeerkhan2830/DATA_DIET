import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PaletteTone, Tone } from "../../lib/semantic";
import { BarList, type BarItem } from "./BarList";

const LEGACY_TONES: Array<[legacy: PaletteTone, role: Tone]> = [
  ["slate", "neutral"],
  ["sky", "info"],
  ["emerald", "success"],
  ["amber", "warning"],
  ["orange", "caution"],
  ["rose", "critical"],
  ["indigo", "accent"],
];

function fillClass(item: BarItem): string {
  const { container } = render(<BarList items={[item]} />);
  return container.querySelector("[role='presentation']")?.className ?? "";
}

describe("BarList tones", () => {
  it("fills the bar with the solid token for a semantic role", () => {
    expect(fillClass({ label: "Restricted", value: 4, tone: "critical" })).toContain(
      "bg-critical",
    );
  });

  it("defaults to the accent role", () => {
    expect(fillClass({ label: "Archive", value: 4 })).toContain("bg-accent");
  });

  it.each(LEGACY_TONES)("maps the legacy tone %s onto the %s token", (legacy, role) => {
    const classes = fillClass({ label: "Legacy", value: 4, tone: legacy }).split(" ");

    expect(classes).toContain(`bg-${role}`);
    expect(classes.filter((name) => name.startsWith("bg-"))).toEqual([`bg-${role}`]);
  });
});
