/**
 * useApiQuery request-lifecycle tests (Phase 2).
 *
 * These cover the behaviours the old hook got wrong or never had: dependency
 * reactivity, stale closures, transport cancellation, superseded responses, and
 * unmount safety, plus the loading/error/data/refetch behaviour it already
 * documented and must keep.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { dependencySignature, useApiQuery } from "./useApiQuery";
import type { QueryFetcher } from "./useApiQuery";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets queued promise continuations (and their state updates) settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useApiQuery request lifecycle", () => {
  it("fetches once on mount and exposes the result", async () => {
    const fetcher = vi.fn(async () => "first");

    const { result } = renderHook(() => useApiQuery(fetcher, []));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toBe("first");
    expect(result.current.error).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("passes the run's abort signal to the fetcher", async () => {
    const signals: AbortSignal[] = [];
    const fetcher: QueryFetcher<string> = vi.fn((signal) => {
      signals.push(signal);
      return Promise.resolve("ok");
    });

    renderHook(() => useApiQuery(fetcher, []));
    await flush();

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0].aborted).toBe(false);
  });

  it("re-fetches when a declared dependency changes", async () => {
    let payload = "a";
    const fetcher = vi.fn(async () => payload);

    const { result, rerender } = renderHook(
      ({ assetId }: { assetId: number }) => useApiQuery(fetcher, [assetId]),
      { initialProps: { assetId: 1 } },
    );
    await waitFor(() => expect(result.current.data).toBe("a"));

    payload = "b";
    rerender({ assetId: 2 });
    await waitFor(() => expect(result.current.data).toBe("b"));

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not re-fetch on renders whose dependencies are unchanged", async () => {
    const fetcher = vi.fn(async () => "only");

    const { result, rerender } = renderHook(
      ({ assetId }: { assetId: number }) => useApiQuery(() => fetcher(), [assetId]),
      { initialProps: { assetId: 7 } },
    );
    await waitFor(() => expect(result.current.data).toBe("only"));

    // A new fetcher closure on every render, but identical dependency values.
    rerender({ assetId: 7 });
    rerender({ assetId: 7 });
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
  });

  it("calls the current fetcher, not the one captured on mount", async () => {
    // The stale-closure regression: the closure must follow the latest render.
    let latest = "from first render";
    const seen: string[] = [];

    const { result, rerender } = renderHook(
      ({ tick }: { tick: number }) =>
        useApiQuery(async () => {
          seen.push(latest);
          return latest;
        }, [tick]),
      { initialProps: { tick: 1 } },
    );
    await waitFor(() => expect(result.current.data).toBe("from first render"));

    latest = "from a later render";
    rerender({ tick: 2 });
    await waitFor(() => expect(result.current.data).toBe("from a later render"));

    expect(seen).toEqual(["from first render", "from a later render"]);
  });

  it("re-fetches when refetch is called without any dependency change", async () => {
    const fetcher = vi.fn(async () => "x");

    const { result } = renderHook(() => useApiQuery(fetcher, []));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await act(async () => {
      result.current.refetch();
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    expect(result.current.data).toBe("x");
    expect(result.current.error).toBeNull();
  });

  it("aborts the previous request when a dependency changes", async () => {
    const signals: AbortSignal[] = [];
    const fetcher: QueryFetcher<string> = vi.fn((signal) => {
      signals.push(signal);
      // Never settles: the point is that the superseded run is cancelled.
      return new Promise<string>(() => undefined);
    });

    const { rerender } = renderHook(
      ({ institutionId }: { institutionId: number }) => useApiQuery(fetcher, [institutionId]),
      { initialProps: { institutionId: 1 } },
    );

    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);

    rerender({ institutionId: 2 });

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it("keeps a stale response from overwriting a newer one", async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    const pending = [older, newer];
    let calls = 0;
    const fetcher: QueryFetcher<string> = vi.fn(() => pending[calls++].promise);

    const { result, rerender } = renderHook(
      ({ assetId }: { assetId: number }) => useApiQuery(fetcher, [assetId]),
      { initialProps: { assetId: 1 } },
    );

    rerender({ assetId: 2 });
    expect(calls).toBe(2);

    // The newest request answers first.
    await act(async () => {
      newer.resolve("newer");
    });
    expect(result.current.data).toBe("newer");
    expect(result.current.loading).toBe(false);

    // The superseded request answers late and must be dropped.
    await act(async () => {
      older.resolve("stale");
    });
    await flush();

    expect(result.current.data).toBe("newer");
    expect(result.current.error).toBeNull();
  });

  it("aborts the in-flight request on unmount and updates no state", async () => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const signals: AbortSignal[] = [];
    const pending = deferred<string>();
    const fetcher: QueryFetcher<string> = vi.fn((signal) => {
      signals.push(signal);
      return pending.promise;
    });

    const { unmount } = renderHook(() => useApiQuery(fetcher, []));
    unmount();

    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);

    await act(async () => {
      pending.resolve("too late");
    });
    expect(warning).not.toHaveBeenCalled();

    warning.mockRestore();
  });

  it("clears data and sets the message when a request fails", async () => {
    let failing = false;
    const fetcher = vi.fn(async () => {
      if (failing) {
        throw new ApiError("Synthetic demo endpoints are disabled.", 404);
      }
      return "payload";
    });

    const { result } = renderHook(() => useApiQuery(fetcher, []));
    await waitFor(() => expect(result.current.data).toBe("payload"));

    failing = true;
    await act(async () => {
      result.current.refetch();
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());

    // Documented behaviour: a failed attempt clears data rather than showing
    // the previous payload next to an error.
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe("Synthetic demo endpoints are disabled.");
    expect(result.current.loading).toBe(false);
  });

  it("keeps the previous data visible while a dependency reload is in flight", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const pending = [first, second];
    let calls = 0;
    const fetcher: QueryFetcher<string> = vi.fn(() => pending[calls++].promise);

    const { result, rerender } = renderHook(
      ({ assetId }: { assetId: number }) => useApiQuery(fetcher, [assetId]),
      { initialProps: { assetId: 1 } },
    );

    await act(async () => {
      first.resolve("asset 1");
    });
    expect(result.current.data).toBe("asset 1");

    rerender({ assetId: 2 });

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBe("asset 1");
    expect(result.current.error).toBeNull();

    await act(async () => {
      second.resolve("asset 2");
    });
    expect(result.current.data).toBe("asset 2");
    expect(result.current.loading).toBe(false);
  });

  it("clears a previous error when a new attempt starts", async () => {
    let failing = true;
    const fetcher = vi.fn(async () => {
      if (failing) {
        throw new ApiError("backend down", 0);
      }
      return "recovered";
    });

    const { result } = renderHook(() => useApiQuery(fetcher, []));
    await waitFor(() => expect(result.current.error).toBe("backend down"));

    failing = false;
    await act(async () => {
      result.current.refetch();
    });
    await waitFor(() => expect(result.current.data).toBe("recovered"));

    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("re-fetches when the active institution scope changes", async () => {
    const requests: Array<number | null> = [];

    function listInstitution(
      institutionId: number | null,
      signal: AbortSignal,
    ): Promise<string[]> {
      requests.push(institutionId);
      if (signal.aborted) {
        return Promise.reject(new Error("cancelled"));
      }
      return Promise.resolve([`institution:${String(institutionId)}`]);
    }

    const { result, rerender } = renderHook(
      ({ institutionId }: { institutionId: number | null }) =>
        useApiQuery((signal) => listInstitution(institutionId, signal), [institutionId]),
      { initialProps: { institutionId: 1 as number | null } },
    );
    await waitFor(() => expect(result.current.data).toEqual(["institution:1"]));

    rerender({ institutionId: 2 });
    await waitFor(() => expect(result.current.data).toEqual(["institution:2"]));

    rerender({ institutionId: null });
    await waitFor(() => expect(result.current.data).toEqual(["institution:null"]));

    expect(requests).toEqual([1, 2, null]);
  });

  it("re-fetches with the new asset id when the route asset changes", async () => {
    const requested: number[] = [];
    const loadAsset = vi.fn(async (assetId: number, signal: AbortSignal) => {
      requested.push(assetId);
      return { asset_id: assetId, aborted: signal.aborted };
    });

    const { result, rerender } = renderHook(
      ({ assetId }: { assetId: number }) =>
        useApiQuery((signal) => loadAsset(assetId, signal), [assetId]),
      { initialProps: { assetId: 3 } },
    );
    await waitFor(() => expect(result.current.data?.asset_id).toBe(3));

    rerender({ assetId: 4 });
    await waitFor(() => expect(result.current.data?.asset_id).toBe(4));

    rerender({ assetId: 5 });
    await waitFor(() => expect(result.current.data?.asset_id).toBe(5));

    expect(requested).toEqual([3, 4, 5]);
  });
});

describe("dependencySignature", () => {
  it("is stable for equal values and changes when one differs", () => {
    expect(dependencySignature([1, "a", true])).toBe(dependencySignature([1, "a", true]));
    expect(dependencySignature([1, "a", true])).not.toBe(dependencySignature([2, "a", true]));
    expect(dependencySignature([])).toBe(dependencySignature([]));
  });

  it("keeps undefined, null and their string spellings apart", () => {
    const keys = [
      dependencySignature([undefined]),
      dependencySignature([null]),
      dependencySignature(["null"]),
      dependencySignature(["undefined"]),
      dependencySignature([0]),
      dependencySignature(["0"]),
      dependencySignature([false]),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("compares objects and arrays by content, not identity", () => {
    expect(dependencySignature([{ b: 2, a: 1 }])).toBe(dependencySignature([{ a: 1, b: 2 }]));
    expect(dependencySignature([{ a: 1 }])).not.toBe(dependencySignature([{ a: 2 }]));
    expect(dependencySignature([[1, 2]])).toBe(dependencySignature([[1, 2]]));
    expect(dependencySignature([[1, 2]])).not.toBe(dependencySignature([[2, 1]]));
  });

  it("treats an inline function or symbol as a constant", () => {
    expect(dependencySignature([() => undefined])).toBe(dependencySignature([() => "other"]));
  });
});
