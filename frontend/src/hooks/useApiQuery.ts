/**
 * Small data-fetching hook: loading, error, and empty-state friendly.
 *
 * Deliberately minimal (no caching library) to keep Phase 1 dependencies low.
 */

import { useCallback, useEffect, useState } from "react";
import { toErrorMessage } from "../api/client";

export interface ApiQueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useApiQuery<T>(fetcher: () => Promise<T>): ApiQueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refetch = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        const result = await fetcher();
        if (!cancelled) {
          setData(result);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(toErrorMessage(cause));
          setData(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void run();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);

  return { data, loading, error, refetch };
}
