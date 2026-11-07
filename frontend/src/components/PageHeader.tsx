import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-gutter flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-title font-semibold text-ink">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-3xl text-body text-ink-secondary">{description}</p>
        ) : null}
      </div>
      {actions}
    </header>
  );
}
