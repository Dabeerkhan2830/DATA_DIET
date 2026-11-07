/**
 * Small data-fetching hook: loading, error, and empty-state friendly.
 *
 * Deliberately minimal (no caching library) to keep dependencies low.
 *
 * Contract:
 * - `fetcher` receives the run's `AbortSignal`. Fetchers that thread it into the
 *   transport (see `apiGet`) get real request cancellation; fetchers that ignore
 *   it still cannot write stale results, because every superseded or unmounted
 *   run is suppressed by the `active` flag.
 * - `deps` declares the values the request depends on. A change to any of them
 *   starts a new request; an unrelated render does not.
 *
 * Behaviour preserved from Phase 0: `loading` starts true, a new attempt clears
 * the previous error, the previous data stays visible until a replacement
 * arrives, and a failed attempt clears `data` and sets `error`. `refetch()`
 * reloads without touching dependencies.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toErrorMessage } from "../api/client";

/** Runs one request. The signal is aborted when the run is superseded. */
export type QueryFetcher<T> = (signal: AbortSignal) => Promise<T>;

export interface ApiQueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

interface QueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useApiQuery<T>(
  fetcher: QueryFetcher<T>,
  deps: readonly unknown[],
): ApiQueryState<T> {
  const [state, setState] = useState<QueryState<T>>({
    data: null,
    loading: true,
    error: null,
  });
  const [reloadToken, setReloadToken] = useState(0);

  const refetch = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  // Keep the closure of the current render so a re-run never calls a stale
  // fetcher. Assigned before the data effect below, which runs after it.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const dependencyKey = dependencySignature(deps);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    async function run(): Promise<void> {
      try {
        const result = await fetcherRef.current(controller.signal);
        if (!active) {
          return;
        }
        setState({ data: result, loading: false, error: null });
      } catch (cause) {
        if (!active) {
          return;
        }
        setState({ data: null, loading: false, error: toErrorMessage(cause) });
      }
    }

    // Superseded runs and unmounts abort the transport; the `active` flag keeps
    // them from writing to state.
    setState((current) => ({ data: current.data, loading: true, error: null }));
    void run();

    return () => {
      active = false;
      controller.abort();
    };
  }, [dependencyKey, reloadToken]);

  return { data: state.data, loading: state.loading, error: state.error, refetch };
}

/**
 * Serializes a dependency list into a string that changes exactly when a
 * dependency value changes.
 *
 * React needs a fixed-size dependency array, so the array itself is folded into
 * this key instead of being spread into the effect. Object identities are
 * ignored in favour of their contents, which lets call sites pass inline option
 * objects without causing a request on every render.
 */
export function dependencySignature(deps: readonly unknown[]): string {
  return deps.map(signValue).join("|");
}

/** Type-tagged so `undefined`, `null` and `"null"` stay distinguishable. */
function signValue(value: unknown): string {
  if (value === undefined) {
    return "u";
  }
  if (value === null) {
    return "n";
  }
  switch (typeof value) {
    case "string":
      return `s:${value}`;
    case "number":
      return `d:${value}`;
    case "bigint":
      return `i:${value}`;
    case "boolean":
      return `b:${value}`;
    case "function":
    case "symbol":
      // Identity cannot be serialized, so it is a constant: an inline value
      // here degrades to "no refetch" instead of an infinite request loop.
      return "k";
    default:
      return `o:${signStructure(value)}`;
  }
}

function signStructure(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(signValue).join(",")}]`;
  }
  if (value instanceof Date) {
    return `t:${value.getTime()}`;
  }
  if (typeof value !== "object") {
    return signValue(value);
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${key}:${signValue(item)}`);
  return `{${entries.join(",")}}`;
}
