import { fetchHealth } from "../api/demo";
import { useApiQuery } from "../hooks/useApiQuery";

/**
 * Live API status indicator. Uses the backend liveness endpoint, so it works
 * even when MySQL is not running.
 */
export function HealthIndicator() {
  const { data, loading, error } = useApiQuery(fetchHealth);

  if (loading) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-slate-500" role="status">
        <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400" aria-hidden="true" />
        Checking API…
      </span>
    );
  }

  if (error || !data) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-rose-700" role="status">
        <span className="h-2 w-2 rounded-full bg-rose-500" aria-hidden="true" />
        API offline
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2 text-xs text-emerald-700" role="status">
      <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
      API {data.status} · {data.environment} · v{data.version}
    </span>
  );
}
