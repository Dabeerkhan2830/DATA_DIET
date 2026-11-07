/**
 * The retention transport: the exact URL, method and body each wrapper sends.
 *
 * Assertions are written against the contract verified in
 * `backend/app/api/routes/retention.py` and `backend/app/api/schemas/retention.py`:
 * `GET /api/v1/retention/holds` takes only `status` and `institution_id` and
 * answers a bare array; `POST /api/v1/retention/holds` takes `HoldCreate` and
 * answers 201; `PATCH /api/v1/retention/holds/{id}/release` takes an optional
 * `release_reason` and must always send a body, because an absent one is a 422;
 * `GET /api/v1/retention/recommendations` answers the paging envelope and takes
 * only the twelve parameters the route declares — paging, scope, search, the
 * enumerated filters, `sort` and the four range bounds; and the
 * only decision write is
 * `POST /api/v1/retention/assessments/{id}/decisions`, whose `institution_id` is
 * a query parameter while the concurrency tokens travel in the body.
 * There is no endpoint that reads a single hold, lists its history, or returns a
 * released hold to active — so nothing here calls one either.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import {
  createDecision,
  createHold,
  listHolds,
  listRecommendations,
  listSupersessionCandidates,
  releaseHold,
} from "./retention";
import type { Decision, Hold, PaginatedRecommendations } from "./types";

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  } as Response;
}

const HOLD: Hold = {
  id: 1,
  institution_id: 1,
  asset_id: 7,
  asset_scope: null,
  name: "Litigation hold",
  hold_type: "legal",
  legal_basis: "Case 2026-114",
  scope: [],
  status: "active",
  created_by: "system",
  created_at: "2026-10-01T00:00:00",
  released_by: null,
  released_at: null,
  release_reason: null,
};

/** The `RequestInit` the wrapper handed to `fetch`, or a clear failure. */
function init(call: [RequestInfo | URL, RequestInit?]): RequestInit {
  const [, requestInit] = call;
  if (requestInit === undefined) {
    throw new Error("the retention wrapper called fetch without a request init");
  }
  return requestInit;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listHolds", () => {
  it("calls the holds endpoint with no query string for a bare request", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([HOLD]));

    await expect(listHolds()).resolves.toEqual([HOLD]);

    expect(spy.mock.calls[0][0]).toBe("/api/v1/retention/holds");
    expect(init(spy.mock.calls[0]).method).toBe("GET");
  });

  it("sends only the two filters the route declares", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]));

    await listHolds({ status: "released", institution_id: 2 });

    expect(spy.mock.calls[0][0]).toBe(
      "/api/v1/retention/holds?status=released&institution_id=2",
    );
  });

  it("omits an absent filter rather than sending an empty value", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]));

    await listHolds({ status: undefined, institution_id: 3 });

    expect(spy.mock.calls[0][0]).toBe("/api/v1/retention/holds?institution_id=3");
  });

  it("threads the caller's abort signal into the transport", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]));
    const controller = new AbortController();

    await listHolds({ institution_id: 1 }, controller.signal);

    expect(init(spy.mock.calls[0]).signal).toBe(controller.signal);
  });
});

describe("createHold", () => {
  it("posts the operator's fields to the holds collection and returns the stored row", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(HOLD, 201));

    await createHold({
      name: "Litigation hold",
      asset_id: 7,
      hold_type: "legal",
      legal_basis: "Case 2026-114",
      institution_id: 1,
    });

    expect(spy.mock.calls[0][0]).toBe("/api/v1/retention/holds");
    expect(init(spy.mock.calls[0]).method).toBe("POST");
    expect(JSON.parse(String(init(spy.mock.calls[0]).body))).toEqual({
      name: "Litigation hold",
      asset_id: 7,
      hold_type: "legal",
      legal_basis: "Case 2026-114",
      institution_id: 1,
    });
  });

  it("sends no asset, type, basis or institution keys when the operator left them blank", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(HOLD, 201));

    await createHold({ name: "Institution-wide hold" });

    expect(JSON.parse(String(init(spy.mock.calls[0]).body))).toEqual({ name: "Institution-wide hold" });
  });

  it("does not invent a status or a reason: the server ignores both", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(HOLD, 201));

    await createHold({ name: "Litigation hold", institution_id: 1 });

    const body = JSON.parse(String(init(spy.mock.calls[0]).body)) as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain("status");
    expect(Object.keys(body)).not.toContain("reason");
  });
});

describe("releaseHold", () => {
  it("patches the release path with the reason the operator typed", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ...HOLD, status: "released", release_reason: "Case closed" }),
    );

    await releaseHold(7, "Case closed");

    expect(spy.mock.calls[0][0]).toBe("/api/v1/retention/holds/7/release");
    expect(init(spy.mock.calls[0]).method).toBe("PATCH");
    expect(JSON.parse(String(init(spy.mock.calls[0]).body))).toEqual({ release_reason: "Case closed" });
  });

  it("still sends a body when no reason is given, because an absent body is a 422", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(HOLD));

    await releaseHold(7);

    // `undefined` never reaches the wire, so the server always receives `{}`
    // rather than a missing body, which it answers with 422.
    expect(init(spy.mock.calls[0]).body).toBe("{}");
  });

  it("keeps the server status on the thrown error so a conflict can be told apart", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "Hold already released" }, 409),
    );

    await expect(releaseHold(7, "again")).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      message: "Hold already released",
    });
    await expect(releaseHold(7)).rejects.toBeInstanceOf(ApiError);
  });

  it("surfaces the refusal for an unknown hold instead of resolving", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "Hold not found" }, 404),
    );

    await expect(releaseHold(999)).rejects.toMatchObject({ status: 404 });
  });
});

/* --------------------------- queue and decisions --------------------------- */

const ENVELOPE: PaginatedRecommendations = {
  items: [
    {
      id: 71,
      asset_id: 3,
      asset_title: "Payroll export",
      institution_id: 1,
      recommendation: "REVIEW_REQUIRED",
      rationale: "The retention deadline approaches.",
      severity: "medium",
      policy_id: 1,
      policy_version_id: 2,
      policy_version_number: 3,
      holds_active: 0,
      assessed_at: "2026-10-10T09:30:00",
      findings: null,
      review_status: "open",
      latest_decision: null,
      decisions_recorded: 0,
      retention_deadline: "2026-09-01",
      days_overdue: 39,
    },
  ],
  total: 40,
  page: 2,
  per_page: 20,
  pages: 2,
};

const RECORDED_DECISION: Decision = {
  id: 11,
  assessment_id: 71,
  asset_id: 3,
  institution_id: 1,
  policy_id: 1,
  policy_version_id: 2,
  recommendation_reviewed: "REVIEW_REQUIRED",
  decision: "retain",
  reason: "Operational need continues.",
  reviewer: "reviewer@example.org",
  decided_at: "2026-10-15T10:00:00",
  supersedes_decision_id: null,
  is_superseded: false,
  superseded_by_decision_id: null,
};

describe("listRecommendations", () => {
  it("requests the queue with the full parameter set and returns the envelope", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(ENVELOPE));

    await expect(
      listRecommendations({
        page: 2,
        per_page: 20,
        institution_id: 1,
        review_status: "open",
        recommendation: "REVIEW_REQUIRED",
        severity: "medium",
        sort: "urgency",
        search: "payroll",
      }),
    ).resolves.toEqual(ENVELOPE);

    expect(spy.mock.calls[0][0]).toBe(
      "/api/v1/retention/recommendations?page=2&per_page=20&institution_id=1" +
        "&review_status=open&recommendation=REVIEW_REQUIRED&severity=medium&sort=urgency&search=payroll",
    );
    expect(init(spy.mock.calls[0]).method).toBe("GET");
  });

  it("sends no empty filter values, so the route sees no constraint", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(ENVELOPE));

    await listRecommendations({ page: 1, per_page: 20, sort: "age" });

    expect(spy.mock.calls[0][0]).toBe(
      "/api/v1/retention/recommendations?page=1&per_page=20&sort=age",
    );
  });

  it("omits the institution parameter only when the caller passes no scope", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ ...ENVELOPE, items: [], total: 0 }));

    await listRecommendations({ institution_id: 0 });
    expect(spy.mock.calls[0][0]).toBe("/api/v1/retention/recommendations?institution_id=0");

    await listRecommendations({ page: 1 });
    expect(spy.mock.calls[1][0]).toBe("/api/v1/retention/recommendations?page=1");
  });

  it("sends the four date ranges verbatim, percent-encoding the timestamps", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(ENVELOPE));

    await listRecommendations({
      assessed_from: "2026-10-01T00:00:00",
      assessed_to: "2026-10-31T23:59:59",
      deadline_from: "2026-01-01",
      deadline_to: "2026-12-31",
    });

    // `routes/retention.py:449-452` types these as two datetimes and two dates,
    // and `services/retention.py:818-825` compares both bounds inclusively, so
    // the wrapper must pass the caller's strings through with no coercion.
    expect(spy.mock.calls[0][0]).toBe(
      "/api/v1/retention/recommendations?assessed_from=2026-10-01T00%3A00%3A00" +
        "&assessed_to=2026-10-31T23%3A59%3A59&deadline_from=2026-01-01&deadline_to=2026-12-31",
    );
  });

  it("threads the abort signal so a superseded queue read is cancelled", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(ENVELOPE));
    const controller = new AbortController();

    await listRecommendations({ page: 1 }, controller.signal);

    expect(init(spy.mock.calls[0]).signal).toBe(controller.signal);
  });

  it("reports a queue read the server refused, with its status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "per_page must be <= 100" }, 422),
    );

    await expect(listRecommendations({ per_page: 500 })).rejects.toMatchObject({
      name: "ApiError",
      status: 422,
      message: "per_page must be <= 100",
    });
  });
});

describe("listSupersessionCandidates", () => {
  it("reads the server-computed correction targets for one assessment", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse([RECORDED_DECISION]));

    await expect(listSupersessionCandidates(71)).resolves.toEqual([RECORDED_DECISION]);

    expect(spy.mock.calls[0][0]).toBe(
      "/api/v1/retention/decisions/supersession/source?assessment_id=71",
    );
    expect(init(spy.mock.calls[0]).method).toBe("GET");
  });

  it("keeps an out-of-scope assessment as a refusal, not an empty list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "assessment_out_of_scope" }, 404),
    );

    await expect(listSupersessionCandidates(999)).rejects.toBeInstanceOf(ApiError);
  });
});

describe("createDecision", () => {
  it("posts the decision and its concurrency tokens to the assessment's collection", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(RECORDED_DECISION, 201));

    await createDecision(
      71,
      {
        decision: "retain",
        reason: "Operational need continues.",
        supersedes_decision_id: null,
        expected_assessed_at: "2026-10-10T09:30:00",
        expected_policy_version_id: 2,
        expected_holds_active: 0,
      },
      1,
    );

    expect(spy.mock.calls[0][0]).toBe(
      "/api/v1/retention/assessments/71/decisions?institution_id=1",
    );
    expect(init(spy.mock.calls[0]).method).toBe("POST");
    expect(JSON.parse(String(init(spy.mock.calls[0]).body))).toEqual({
      decision: "retain",
      reason: "Operational need continues.",
      supersedes_decision_id: null,
      expected_assessed_at: "2026-10-10T09:30:00",
      expected_policy_version_id: 2,
      expected_holds_active: 0,
    });
  });

  it("leaves the scope off the query when the row carried none", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ ...RECORDED_DECISION, institution_id: null }, 201));

    await createDecision(71, { decision: "reject", reason: "Not applicable to this asset." });

    expect(spy.mock.calls[0][0]).toBe("/api/v1/retention/assessments/71/decisions");
    // The actor is the token's subject: no reviewer field is sent at all.
    expect(JSON.parse(String(init(spy.mock.calls[0]).body))).not.toHaveProperty("reviewer");
  });

  it("keeps a stale-review conflict as a 409 the caller can act on", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          detail:
            "stale_review_conflict: a newer assessment exists for this asset. The review page is " +
            "out of date; reload it and decide on the current assessment and policy version.",
        },
        409,
      ),
    );

    await expect(
      createDecision(71, { decision: "retain", reason: "Operational need continues." }, 1),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("keeps a hold conflict as a 409 as well", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "hold_conflict: an active retention hold blocks approving." }, 409),
    );

    await expect(
      createDecision(71, { decision: "approve_for_later_workflow", reason: "Endorsed." }, 1),
    ).rejects.toMatchObject({ status: 409, message: /hold_conflict/ });
  });

  it("reports the permission refusal with its 403 instead of resolving", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          detail:
            "forbidden: This action requires the 'review:decide' permission, which viewer@example.org does not have.",
        },
        403,
      ),
    );

    await expect(
      createDecision(71, { decision: "retain", reason: "Operational need continues." }, 1),
    ).rejects.toMatchObject({ status: 403 });
  });
});
