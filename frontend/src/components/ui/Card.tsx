import type { ReactNode } from "react";

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-card border border-line bg-surface shadow-card ${className ?? ""}`}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-card-x py-card-y">
      <div>
        <h2 className="text-section font-semibold text-ink">{title}</h2>
        {description ? (
          <p className="mt-1 text-supporting text-ink-muted">{description}</p>
        ) : null}
      </div>
      {action}
    </header>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`px-card-x py-card-y ${className ?? ""}`}>{children}</div>;
}
