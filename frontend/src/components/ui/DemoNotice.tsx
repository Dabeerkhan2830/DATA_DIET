/**
 * Persistent honesty banner: every number shown in the Phase 1 UI comes from
 * synthetic fixtures served by the backend's /api/v1/demo endpoints.
 */
export function DemoNotice({ notice }: { notice?: string }) {
  return (
    <div
      className="mb-6 flex flex-wrap items-start gap-x-2 gap-y-1 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      role="note"
    >
      <span className="font-semibold">Synthetic data.</span>
      <span>
        {notice ??
          "All figures on this page are generated development samples — no real institutional or personal records are included."}
      </span>
    </div>
  );
}
