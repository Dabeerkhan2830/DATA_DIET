import type { ReactNode } from "react";
import { resolveTone, type ToneInput } from "../../lib/semantic";
import { TONE_SURFACE } from "./statusClasses";

export interface BadgeProps {
  tone?: ToneInput;
  children: ReactNode;
}

/**
 * A short status chip. Call sites pass a semantic role from `lib/semantic`,
 * normally via one of the `toneFor*` helpers; the legacy palette names are
 * resolved onto a role by `resolveTone`, and the classes come from
 * `statusClasses` so a chip, a bar and a toast of the same role are the same
 * colour by construction.
 */
export function Badge({ tone = "neutral", children }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-meta font-medium ring-1 ring-inset ${TONE_SURFACE[resolveTone(tone)]}`}
    >
      {children}
    </span>
  );
}
