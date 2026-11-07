import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  message: string;
  action?: ReactNode;
}

export function EmptyState({ title, message, action }: EmptyStateProps) {
  return (
    <div className="rounded-card border border-dashed border-line-strong bg-surface px-card-x py-10 text-center">
      <h2 className="text-section font-semibold text-ink">{title}</h2>
      <p className="mx-auto mt-1 max-w-lg text-supporting text-ink-muted">{message}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
