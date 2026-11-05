import type { ReactNode } from "react";

export interface BadgeProps {
  tone?: "slate" | "indigo" | "emerald" | "sky" | "amber" | "orange" | "rose";
  children: ReactNode;
}

const TONE_CLASSES: Record<NonNullable<BadgeProps["tone"]>, string> = {
  slate: "bg-slate-100 text-slate-700 ring-slate-200",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  sky: "bg-sky-50 text-sky-700 ring-sky-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  orange: "bg-orange-50 text-orange-800 ring-orange-200",
  rose: "bg-rose-50 text-rose-700 ring-rose-200",
};

export function Badge({ tone = "slate", children }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}
