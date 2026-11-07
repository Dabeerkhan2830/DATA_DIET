export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-3 py-8 text-ink-muted">
      <span
        className="h-5 w-5 animate-spin rounded-pill border-2 border-line-strong border-t-accent"
        aria-hidden="true"
      />
      <span className="text-body">{label}</span>
    </div>
  );
}
