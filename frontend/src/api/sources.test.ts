/**
 * The sources/scan transport: the exact URL, method and body each wrapper sends.
 *
 * Assertions are written against the contract verified in
 * `backend/app/api/routes/connectors.py`, `backend/app/api/schemas/connectors.py`
 * and `backend/app/services/scan.py`, and they exist to keep the UI from
 * inventing capabilities:
 *
 * - `GET /sources` takes `page`, `per_page`, `connector_type`, `status` and
 *   `institution_id` and answers a `PaginatedSources` envelope; `GET /scan-jobs`
 *   takes `page`, `per_page`, `data_source_id`, `status` and `institution_id`;
 *   the two per-record routes take only paging plus `institution_id`, because
 *   neither declares a filter. Nothing here sends a search term or a sort key
 *   that a route does not declare.
 * - Writes are `POST /sources`, `PATCH /sources/{id}`, `POST /sources/{id}/validate`,
 *   `POST /sources/{id}/scans`, `POST /scan-jobs/{id}/run|cancel|retry`, and the
 *   reads are the `GET`s above. **There is no `DELETE` route for a source and no
 *   `PUT` anywhere**, so this module exports no wrapper for one either — the last
 *   test pins the export list so a future "deleteSource" cannot appear quietly.
 * - Scan creation goes through `POST /sources/{id}/scans` only. `POST /scan-jobs`
 *   exists too, but it takes the institution from the source row and cannot be
 *   scoped, so calling both would be two paths for one action.
 * - `institution_id` travels as a **query parameter** on the single-resource
 *   routes and inside the JSON body on create, because that is what each route
 *   declares; the body of `ScanRequest` carries only `batch_size` and `run`.
 * - A cross-institution record answers **404**, not 403, and an illegal
 *   transition answers 409 whose `detail` is the service's own sentence. Both
 *   statuses survive on the thrown `ApiError` — the screens branch on them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as sourcesModule from "./sources";
import { ApiError } from "./client";
import {
  cancelScanJob,
  createSource,
  getScanJob,
  getSource,
  listScanErrors,
  listScanJobs,
  listScanResults,
  listSources,
  retryScanJob,
  runScanJob,
  startScan,
  updateSource,
  validateSource,
} from "./sources";
import type { ScanJob, Source, SourceListResponse } from "./types";

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  } as Response;
}

/** The `RequestInit` the wrapper handed to `fetch`, or a clear failure. */
function init(call: [RequestInfo | URL, RequestInit?]): RequestInit {
  const [, requestInit] = call;
  if (requestInit === undefined) {
    throw new Error("the sources wrapper called fetch without a request init");
  }
  return requestInit;
}

function body(call: [RequestInfo | URL, RequestInit?]): unknown {
  return JSON.parse(String(init(call).body));
}

/** A `Source` shaped exactly like `app/api/schemas/connectors.py::Source`. */
const SOURCE: Source = {
  id: 7,
  institution_id: 1,
  name: "HR test corpus",
  connector_type: "synthetic",
  root_key: null,
  config: { count: 25 },
  status: "active",
  created_by: "reviewer@example.org",
  last_validated_at: null,
  last_validation_ok: null,
  last_validation_message: null,
  created_at: "2026-10-01T09:00:00",
  updated_at: "2026-10-01T09:00:00",
};

/** A `ScanJobRead` shaped exactly like the schema of the same name. */
const JOB: ScanJob = {
  id: 12,
  data_source_id: 7,
  institution_id: 1,
  status: "COMPLETED",
  batch_size: 500,
  total_discovered: 25,
  total_imported: 20,
  total_skipped: 5,
  total_errors: 0,
  retried_from_job_id: null,
  started_at: "2026-10-02T10:00:00",
  completed_at: "2026-10-02T10:00:04",
  error_message: null,
  created_at: "2026-10-02T10:00:00",
};

const PAGE: SourceListResponse = {
  items: [SOURCE],
  total: 1,
  page: 1,
  per_page: 20,
  pages: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
});

/* --------------------------------- sources -------------------------------- */

describe("listSources", () => {
  it("calls the collection endpoint with no query string for a bare request", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(PAGE));

    await expect(listSources()).resolves.toEqual(PAGE);

    expect(spy.mock.calls[0][0]).toBe("/api/v1/sources");
    expect(init(spy.mock.calls[0]).method).toBe("GET");
  });

  it("sends only the five parameters the route declares", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(PAGE));

    await listSources({
      page: 2,
      per_page: 20,
      connector_type: "local_folder",
      status: "inactive",
      institution_id: 3,
    });

    expect(spy.mock.calls[0][0]).toBe(
      "/api/v1/sources?page=2&per_page=20&connector_type=local_folder&status=inactive&institution_id=3",
    );
  });

  it("omits a blank filter instead of sending an empty value", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(PAGE));

    // An empty string means "Any" in the UI. Sent as `status=`, FastAPI would
    // apply it as a real filter and the screen would read that as an empty scope.
    await listSources({ page: 1, per_page: 20, connector_type: "", status: "" });

    expect(spy.mock.calls[0][0]).toBe("/api/v1/sources?page=1&per_page=20");
  });

  it("keeps institution_id=0 distinguishable from an absent scope", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(PAGE));

    await listSources({ institution_id: 0 });

    expect(spy.mock.calls[0][0]).toBe("/api/v1/sources?institution_id=0");
  });

  it("threads the caller's abort signal into the transport", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(PAGE));
    const controller = new AbortController();

    await listSources({ page: 1 }, controller.signal);

    expect(init(spy.mock.calls[0]).signal).toBe(controller.signal);
  });
});

describe("getSource", () => {
  it("reads one record by id, with the scope as a query parameter", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SOURCE));

    await expect(getSource(7, 1)).resolves.toEqual(SOURCE);

    expect(spy.mock.calls[0][0]).toBe("/api/v1/sources/7?institution_id=1");
    expect(init(spy.mock.calls[0]).method).toBe("GET");
  });

  it("sends no query string when the caller passes no scope", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SOURCE));

    await getSource(7);

    expect(spy.mock.calls[0][0]).toBe("/api/v1/sources/7");
  });
});

describe("createSource", () => {
  it("posts exactly the fields SourceCreate accepts", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SOURCE, 201));

    await createSource({
      name: "HR test corpus",
      connector_type: "synthetic",
      institution_id: 1,
      config: { count: 25 },
    });

    expect(spy.mock.calls[0][0]).toBe("/api/v1/sources");
    expect(init(spy.mock.calls[0]).method).toBe("POST");
    expect(init(spy.mock.calls[0]).headers).toMatchObject({
      "Content-Type": "application/json",
    });
    expect(body(spy.mock.calls[0])).toEqual({
      name: "HR test corpus",
      connector_type: "synthetic",
      institution_id: 1,
      config: { count: 25 },
    });
  });

  it("sends no root_key for a synthetic source, because the route refuses one", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SOURCE, 201));

    await createSource({ name: "HR test corpus", connector_type: "synthetic" });

    expect(body(spy.mock.calls[0])).toEqual({
      name: "HR test corpus",
      connector_type: "synthetic",
    });
  });

  it("never sends a status, since create_source hard-codes active", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SOURCE, 201));

    await createSource({
      name: "Board archive",
      connector_type: "local_folder",
      root_key: "board",
    });

    const sent = body(spy.mock.calls[0]) as Record<string, unknown>;
    expect(Object.keys(sent)).not.toContain("status");
    expect(Object.keys(sent)).not.toContain("created_by");
    expect(sent).toMatchObject({ connector_type: "local_folder", root_key: "board" });
  });
});

describe("updateSource", () => {
  it("patches the record with only the four editable fields", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ...SOURCE, status: "inactive" }),
    );

    await updateSource(7, { name: "Renamed", status: "inactive", config: {} }, 1);

    expect(spy.mock.calls[0][0]).toBe("/api/v1/sources/7?institution_id=1");
    expect(init(spy.mock.calls[0]).method).toBe("PATCH");
    expect(body(spy.mock.calls[0])).toEqual({
      name: "Renamed",
      status: "inactive",
      config: {},
    });
  });

  it("does not send connector_type or institution_id in the body: neither is editable", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(SOURCE));

    await updateSource(7, { status: "inactive" });

    const sent = body(spy.mock.calls[0]) as Record<string, unknown>;
    expect(Object.keys(sent)).not.toContain("connector_type");
    expect(Object.keys(sent)).not.toContain("institution_id");
    expect(spy.mock.calls[0][0]).toBe("/api/v1/sources/7");
  });
});

describe("validateSource", () => {
  it("posts to the validate path and returns the verdict the server stored", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        id: 7,
        ok: true,
        message: "Synthetic connector is available.",
        validated_at: "2026-10-05T08:00:00",
      }),
    );

    await expect(validateSource(7, 1)).resolves.toEqual({
      id: 7,
      ok: true,
      message: "Synthetic connector is available.",
      validated_at: "2026-10-05T08:00:00",
    });

    expect(spy.mock.calls[0][0]).toBe("/api/v1/sources/7/validate?institution_id=1");
    expect(init(spy.mock.calls[0]).method).toBe("POST");
    // The route declares no body model; the always-present `{}` is inert, and a
    // missing one would be a different kind of request.
    expect(init(spy.mock.calls[0]).body).toBe("{}");
  });

  it("reports an unsuccessful validation as a result, not as an error", async () => {
    // 200 with ok:false is how the route says "the connector refused": the HTTP
    // call succeeded and the verdict is inside it.
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ id: 7, ok: false, message: "Root key missing.", validated_at: null }),
    );

    await expect(validateSource(7)).resolves.toMatchObject({ ok: false });
    expect(spy.mock.calls.length).toBe(1);
  });
});

/* ---------------------------------- scans --------------------------------- */

describe("startScan", () => {
  it("posts the scan request to the source's scans collection", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(JOB, 201));

    await expect(startScan(7, { batch_size: 500, run: true }, 1)).resolves.toEqual(JOB);

    expect(spy.mock.calls[0][0]).toBe("/api/v1/sources/7/scans?institution_id=1");
    expect(init(spy.mock.calls[0]).method).toBe("POST");
    expect(body(spy.mock.calls[0])).toEqual({ batch_size: 500, run: true });
  });

  it("sends an empty body rather than inventing defaults when asked for nothing", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(JOB, 201));

    await startScan(7);

    expect(spy.mock.calls[0][0]).toBe("/api/v1/sources/7/scans");
    // `run` is absent, so the server's own default (true) decides — the client
    // does not hard-code a policy the route already owns.
    expect(body(spy.mock.calls[0])).toEqual({});
  });

  it("sends run:false as the only way to obtain a PENDING job", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ...JOB, status: "PENDING", started_at: null, completed_at: null }, 201),
    );

    await expect(startScan(7, { run: false }, 1)).resolves.toMatchObject({ status: "PENDING" });

    expect(body(spy.mock.calls[0])).toEqual({ run: false });
  });
});

describe("listScanJobs", () => {
  it("sends only the five parameters the route declares", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ items: [JOB], total: 1, page: 1, per_page: 20, pages: 1 }),
    );

    await listScanJobs({
      page: 3,
      per_page: 20,
      data_source_id: 7,
      status: "FAILED",
      institution_id: 2,
    });

    expect(spy.mock.calls[0][0]).toBe(
      "/api/v1/scan-jobs?page=3&per_page=20&data_source_id=7&status=FAILED&institution_id=2",
    );
    expect(init(spy.mock.calls[0]).method).toBe("GET");
  });

  it("sends data_source_id=0 instead of dropping it", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ items: [], total: 0, page: 1, per_page: 20, pages: 1 }),
    );

    await listScanJobs({ data_source_id: 0 });

    expect(spy.mock.calls[0][0]).toBe("/api/v1/scan-jobs?data_source_id=0");
  });

  it("asks for the bare collection when no filter is in use", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ items: [], total: 0, page: 1, per_page: 20, pages: 1 }),
    );

    await listScanJobs({ status: "" });

    expect(spy.mock.calls[0][0]).toBe("/api/v1/scan-jobs");
  });
});

describe("getScanJob", () => {
  it("reads one job with the scope as a query parameter", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(JOB));

    await expect(getScanJob(12, 1)).resolves.toEqual(JOB);

    expect(spy.mock.calls[0][0]).toBe("/api/v1/scan-jobs/12?institution_id=1");
  });
});

describe("runScanJob, cancelScanJob and retryScanJob", () => {
  it("posts to the run path with no invented payload", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ...JOB, status: "COMPLETED" }),
    );

    await runScanJob(12, 1);

    expect(spy.mock.calls[0][0]).toBe("/api/v1/scan-jobs/12/run?institution_id=1");
    expect(init(spy.mock.calls[0]).method).toBe("POST");
    expect(init(spy.mock.calls[0]).body).toBe("{}");
  });

  it("posts to the cancel path", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ...JOB, status: "CANCELLED" }),
    );

    await cancelScanJob(12);

    expect(spy.mock.calls[0][0]).toBe("/api/v1/scan-jobs/12/cancel");
    expect(init(spy.mock.calls[0]).body).toBe("{}");
  });

  it("posts to the retry path and keeps the new job the 201 returns", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ...JOB, id: 13, retried_from_job_id: 12 }, 201),
    );

    await expect(retryScanJob(12, 1)).resolves.toMatchObject({
      id: 13,
      retried_from_job_id: 12,
    });

    expect(spy.mock.calls[0][0]).toBe("/api/v1/scan-jobs/12/retry?institution_id=1");
  });

  it("carries the 409 sentence the service raised, so the screen can show it verbatim", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "Cannot run a scan in status 'COMPLETED'" }, 409),
    );

    await expect(runScanJob(12)).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      message: "Cannot run a scan in status 'COMPLETED'",
    });
  });

  it("carries the other-tenant 404 without turning it into a 403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "Scan job not found" }, 404),
    );

    await expect(cancelScanJob(999, 4)).rejects.toMatchObject({ status: 404 });
  });
});

describe("listScanResults and listScanErrors", () => {
  it("pages the per-record outcomes with no filter, because the route has none", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ items: [], total: 0, page: 2, per_page: 50, pages: 1 }),
    );

    await listScanResults(12, { page: 2, per_page: 50, institution_id: 1 });

    expect(spy.mock.calls[0][0]).toBe(
      "/api/v1/scan-jobs/12/results?page=2&per_page=50&institution_id=1",
    );
    expect(init(spy.mock.calls[0]).method).toBe("GET");
  });

  it("pages the error rows from the separate errors route", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ items: [], total: 0, page: 1, per_page: 50, pages: 1 }),
    );

    await listScanErrors(12, { page: 1, per_page: 50 });

    expect(spy.mock.calls[0][0]).toBe("/api/v1/scan-jobs/12/errors?page=1&per_page=50");
  });

  it("threads the abort signal so a closed dialog stops the read", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ items: [], total: 0, page: 1, per_page: 50, pages: 1 }),
    );
    const controller = new AbortController();

    await listScanResults(12, { page: 1 }, controller.signal);

    expect(init(spy.mock.calls[0]).signal).toBe(controller.signal);
  });
});

/* --------------------------- what does not exist --------------------------- */

describe("the shape of this module", () => {
  it("exports one wrapper per documented route and no more", () => {
    // `connectors.py` has no DELETE for a source and no PUT anywhere, and scan
    // creation goes through the source-scoped route only. An extra export would
    // mean either a fabricated endpoint or a second path for one action.
    expect(Object.keys(sourcesModule).sort()).toEqual([
      "SCAN_JOBS_PREFIX",
      "SOURCES_PREFIX",
      "cancelScanJob",
      "createSource",
      "getScanJob",
      "getSource",
      "listScanErrors",
      "listScanJobs",
      "listScanResults",
      "listSources",
      "retryScanJob",
      "runScanJob",
      "startScan",
      "updateSource",
      "validateSource",
    ]);
  });

  it("uses the /api/v1 prefixes the app mounts the connectors router under", () => {
    expect(sourcesModule.SOURCES_PREFIX).toBe("/api/v1/sources");
    expect(sourcesModule.SCAN_JOBS_PREFIX).toBe("/api/v1/scan-jobs");
  });

  it("keeps a 403 an authorization failure with its status intact", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "Missing permission: sources:read" }, 403),
    );

    await expect(listSources()).rejects.toMatchObject({
      status: 403,
      message: "Missing permission: sources:read",
    });
  });

  it("renders a Pydantic 422 array as one readable message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          detail: [
            { loc: ["body", "name"], msg: "String should have at least 1 character", type: "string_too_short" },
            { loc: ["body", "config"], msg: "Value must be a valid dictionary", type: "dict_type" },
          ],
        },
        422,
      ),
    );

    await expect(
      createSource({ name: "", connector_type: "synthetic" }),
    ).rejects.toMatchObject({
      status: 422,
      message:
        "name: String should have at least 1 character; config: Value must be a valid dictionary",
    });
  });

  it("keeps the ApiError instance a screen needs to branch on status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "A scan in status 'COMPLETED' cannot be cancelled" }, 409),
    );

    await expect(cancelScanJob(12)).rejects.toBeInstanceOf(ApiError);
  });
});
