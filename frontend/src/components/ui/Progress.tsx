import type { ToneInput } from "../../lib/semantic";
import { resolveStatusTone } from "../../lib/semantic";
import { TONE_SOLID } from "./statusClasses";

export interface ProgressProps {
  /** Completion between `0` and `max`, or `null` for work with no measurable end. */
  value: number | null;
  max?: number;
  /** Accessible name: a progress bar without one announces only a bare number. */
  label: string;
  tone?: ToneInput;
  size?: "sm" | "md";
  showValue?: boolean;
  className?: string;
}

const TRACK_SIZES = { sm: "h-1.5", md: "h-2" } as const;

/**
 * A determinate or indeterminate progress bar.
 *
 * The `role="progressbar"` node carries the accessible name and the value
 * range; the animated fill is `aria-hidden`, so a screen reader hears
 * "Scanning assets: 40%" once instead of the same number from two elements. An
 * indeterminate bar reports no value at all — inventing one would claim a
 * completion the backend never reported.
 */
export function Progress({
  value,
  max = 100,
  label,
  tone = "info",
  size = "md",
  showValue = false,
  className,
}: ProgressProps) {
  const role = resolveStatusTone(tone);
  const usableMax = max > 0 ? max : 1;
  const clamped = value === null ? null : Math.min(Math.max(value, 0), usableMax);
  const percent = clamped === null ? null : Math.round((clamped / usableMax) * 100);

  return (
    <div className={className}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={usableMax}
        aria-valuenow={clamped ?? undefined}
        aria-valuetext={percent === null ? undefined : `${percent}%`}
        aria-busy={clamped === null ? true : undefined}
        className={`w-full overflow-hidden rounded-pill bg-surface-sunken ${TRACK_SIZES[size]}`}
      >
        <div
          aria-hidden="true"
          className={`h-full rounded-pill ${TONE_SOLID[role]} ${
            clamped === null ? "w-1/3 animate-progress-sweep" : ""
          }`}
          style={clamped === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      {showValue && percent !== null ? (
        <p className="mt-1 text-meta text-ink-muted">{percent}%</p>
      ) : null}
    </div>
  );
}
