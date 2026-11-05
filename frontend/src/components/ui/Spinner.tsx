export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-3 py-8 text-slate-500">
      <span
        className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600"
        aria-hidden="true"
      />
      <span className="text-sm">{label}</span>
    </div>
  );
}
