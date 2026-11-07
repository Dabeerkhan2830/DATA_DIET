import type { ReactNode } from "react";

export interface StatCardProps {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: ReactNode;
}

export function StatCard({ label, value, hint, icon }: StatCardProps) {
  return (
    <div className="rounded-card border border-line bg-surface p-card-x shadow-card">
      <div className="flex items-start justify-between gap-3">
        <p className="text-eyebrow font-semibold text-ink-muted uppercase tracking-[0.06em]">
          {label}
        </p>
        {icon ? <span className="text-ink-subtle">{icon}</span> : null}
      </div>
      <p className="mt-3 text-display font-semibold text-ink tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-meta text-ink-muted">{hint}</p> : null}
    </div>
  );
}
