/**
 * The classification transport: the endpoints, methods and query parameters the
 * screen really calls.
 *
 * Asserted against the contract verified in
 * `backend/app/api/routes/classification.py`:
 * `GET /api/v1/classification/rules`, `GET /checks`, `GET /assets/{id}/latest`,
 * `.../history`, `.../quality`, `GET /quality/findings` and
 * `POST /api/v1/classification/assets/{id}` (201, no body, no signal). The four
 * asset endpoints accept `institution_id`; the two catalogues take no scope.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import {
  CLASSIFICATION_PREFIX,
  fetchAssetQuality,
  fetchClassificationHistory,
  fetchClassificationRules,
  fetchLatestClassification,
  fetchQualityChecks,
  fetchQualityFindings,
  runClassification,
} from "./classification";
import type { ClassificationResult } from "./types";

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: async () => payload,
  } as Response;
}

const RESULT = { id: 11, asset_id: 3, rule_version: "classification-v1" } as ClassificationResult;

afterEach(() => {
  vi.restoreAllMocks();
});

type FetchSpy = MockInstance<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;

function firstUrl(spy: FetchSpy): string {
  return String(spy.mock.calls[0][0]);
}

describe("classification endpoints", () => {
  it("prefixes every call with the versioned classification route", () => {
    expect(CLASSIFICATION_PREFIX).toBe("/api/v1/classification");
  });

  it("reads the rule catalogue and the check catalogue with no scope parameter", async () => {
    const rulesSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}));
    await fetchClassificationRules();
    expect(firstUrl(rulesSpy)).toBe("/api/v1/classification/rules");

    const checksSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]));
    await fetchQualityChecks();
    expect(firstUrl(checksSpy)).toBe("/api/v1/classification/checks");
    expect(checksSpy.mock.calls[0][1]).toMatchObject({ method: "GET" });
  });

  it("threads the abort signal through each read", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(RESULT));
    const controller = new AbortController();

    await fetchLatestClassification(3, controller.signal);

    expect(spy.mock.calls[0][1]).toMatchObject({ method: "GET", signal: controller.signal });
    expect(firstUrl(spy)).toBe("/api/v1/classification/assets/3/latest");
  });

  it("sends the institution scope the caller is working in", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(RESULT));

    await fetchLatestClassification(3, undefined, { institutionId: 2 });

    expect(firstUrl(spy)).toBe("/api/v1/classification/assets/3/latest?institution_id=2");
  });

  it("sends no institution_id for an unscoped platform administrator", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(RESULT));

    await fetchAssetQuality(7, undefined, undefined);

    expect(firstUrl(spy)).toBe("/api/v1/classification/assets/7/quality");
  });

  it("combines history pagination with the institution scope", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ results: [] }));

    await fetchClassificationHistory(3, { page: 2, per_page: 10 }, undefined, { institutionId: 1 });

    expect(firstUrl(spy)).toBe(
      "/api/v1/classification/assets/3/history?institution_id=1&page=2&per_page=10",
    );
  });

  it("posts the run to the asset endpoint with no body and no signal", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(RESULT, 201));

    await runClassification(3, { institutionId: 1 });

    expect(firstUrl(spy)).toBe("/api/v1/classification/assets/3?institution_id=1");
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.signal).toBeUndefined();
    expect(init.body).toBe("{}");
  });

  it("returns the row the server answered with", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(RESULT, 201));

    await expect(runClassification(3)).resolves.toEqual(RESULT);
  });

  it("filters the institution-wide findings query", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ findings: [] }));

    await fetchQualityFindings({ page: 1, per_page: 20, severity: "high", institution_id: 4 });

    expect(firstUrl(spy)).toBe(
      "/api/v1/classification/quality/findings?page=1&per_page=20&severity=high&institution_id=4",
    );
  });
});
