import type { Tone } from "../../lib/semantic";

/**
 * The class half of the status vocabulary. `lib/semantic.ts` decides which role
 * a domain value has; this module decides what that role looks like, and every
 * component that colours by status reads from here.
 *
 * Keeping it in one file is what prevents the drift the token migration
 * removed: before, `Badge`, `BarList`, `Toast` and `Progress` each carried their
 * own copy of the same table, and only the first two were tested.
 *
 * Two shapes only: `TONE_SURFACE` is a quiet chip or panel (fill + ink + ring),
 * `TONE_SOLID` is a bar, dot or progress fill.
 */

export const TONE_SURFACE: Record<Tone, string> = {
  neutral: "bg-neutral-surface text-neutral-ink ring-neutral-line",
  info: "bg-info-surface text-info-ink ring-info-line",
  success: "bg-success-surface text-success-ink ring-success-line",
  warning: "bg-warning-surface text-warning-ink ring-warning-line",
  caution: "bg-caution-surface text-caution-ink ring-caution-line",
  critical: "bg-critical-surface text-critical-ink ring-critical-line",
  accent: "bg-accent-surface text-accent-ink ring-accent-line",
};

export const TONE_SOLID: Record<Tone, string> = {
  neutral: "bg-neutral",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  caution: "bg-caution",
  critical: "bg-critical",
  accent: "bg-accent",
};
