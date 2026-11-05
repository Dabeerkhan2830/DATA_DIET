import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  message: string;
  action?: ReactNode;
}

export function EmptyState({ title, message, action }: EmptyStateProps) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-5 py-10 text-center">
      <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
      <p className="mx-auto mt-1 max-w-lg text-sm text-slate-500">{message}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
