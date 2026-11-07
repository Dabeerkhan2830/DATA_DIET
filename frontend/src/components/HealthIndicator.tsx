import { fetchHealth } from "../api/demo";
import { useApiQuery } from "../hooks/useApiQuery";
import { TONE_SOLID } from "./ui/statusClasses";
import type { Tone } from "../lib/semantic";

interface HealthState {
  tone: Tone;
  label: string;
  pending: boolean;
}

/**
 * Live API status indicator. Uses the backend liveness endpoint, so it works
 * even when MySQL is not running.
 *
 * The dot colour comes from the shared status roles rather than a palette class
 * at this call site, so "offline" reads exactly like an offline badge anywhere
 * else in the product.
 */
export function HealthIndicator() {
  const { data, loading, error } = useApiQuery(fetchHealth, []);

  const state: HealthState = loading
    ? { tone: "neutral", label: "Checking API…", pending: true }
    : error || !data
      ? { tone: "critical", label: "API offline", pending: false }
      : {
          tone: "success",
          label: `API ${data.status} · ${data.environment} · v${data.version}`,
          pending: false,
        };

  return (
    <span
      role="status"
      className="inline-flex min-w-0 items-center gap-2 text-meta text-ink-muted"
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 rounded-pill ${TONE_SOLID[state.tone]} ${
          state.pending ? "animate-pulse" : ""
        }`}
      />
      <span className="truncate">{state.label}</span>
    </span>
  );
}
