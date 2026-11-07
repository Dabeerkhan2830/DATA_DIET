import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PaletteTone, Tone } from "../../lib/semantic";
import { Badge } from "./Badge";

/** Every tone name `Badge` accepted before the semantic tokens existed. */
const LEGACY_TONES: Array<[legacy: PaletteTone, role: Tone]> = [
  ["slate", "neutral"],
  ["sky", "info"],
  ["emerald", "success"],
  ["amber", "warning"],
  ["orange", "caution"],
  ["rose", "critical"],
  ["indigo", "accent"],
];

const SEMANTIC_TONES: Tone[] = [
  "neutral",
  "info",
  "success",
  "warning",
  "caution",
  "critical",
  "accent",
];

function classesOf(text: string): string[] {
  return screen.getByText(text).className.split(" ");
}

function tokenClasses(role: Tone): string[] {
  return [`bg-${role}-surface`, `text-${role}-ink`, `ring-${role}-line`];
}

describe("Badge tones", () => {
  it.each(SEMANTIC_TONES)("renders the %s role from its token quartet", (role) => {
    render(<Badge tone={role}>{role}</Badge>);
    expect(classesOf(role)).toEqual(expect.arrayContaining(tokenClasses(role)));
  });

  it("defaults to the neutral role", () => {
    render(<Badge>Draft</Badge>);
    expect(classesOf("Draft")).toEqual(expect.arrayContaining(tokenClasses("neutral")));
  });

  it.each(LEGACY_TONES)("maps the legacy tone %s onto the %s role", (legacy, role) => {
    render(<Badge tone={legacy}>{legacy}</Badge>);

    expect(classesOf(legacy)).toEqual(expect.arrayContaining(tokenClasses(role)));
    // The alias must not reach the markup as a raw palette utility.
    expect(classesOf(legacy).filter((name) => name.startsWith("bg-"))).toEqual([
      `bg-${role}-surface`,
    ]);
  });

  it("renders identical classes for a legacy name and the role it replaced", () => {
    const { unmount } = render(<Badge tone="rose">Legacy</Badge>);
    const legacyClasses = classesOf("Legacy");
    unmount();

    render(<Badge tone="critical">Semantic</Badge>);

    expect(classesOf("Semantic")).toEqual(legacyClasses);
  });
});
