import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGet, apiPost, toErrorMessage } from "./client";
import {
  getAccessToken,
  notifyUnauthorized,
  onUnauthorized,
  setAccessToken,
} from "./tokenStore";

function jsonResponse(payload: unknown, status = 200, statusText = "OK"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => payload,
  } as Response;
}

beforeEach(() => {
  setAccessToken(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("apiGet", () => {
  it("returns parsed JSON on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ status: "ok" }));
    await expect(apiGet<{ status: string }>("/api/v1/health")).resolves.toEqual({ status: "ok" });
  });

  it("surfaces the backend detail message on HTTP errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "Synthetic demo endpoints are disabled." }, 404, "Not Found"),
    );

    await expect(apiGet("/api/v1/demo/inventory")).rejects.toBeInstanceOf(ApiError);
    await expect(apiGet("/api/v1/demo/inventory")).rejects.toThrow(
      "Synthetic demo endpoints are disabled.",
    );
  });

  it("wraps network failures in an actionable message", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(apiGet("/api/v1/health")).rejects.toThrow(/Is the backend running\?/);
  });

  /* ------------------------- bearer-token behaviour ----------------------- */

  it("sends no Authorization header when signed out", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ status: "ok" }));

    await apiGet("/api/v1/health");
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("attaches the stored bearer token to every request", async () => {
    setAccessToken("jwt-token");
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ status: "ok" }));

    await apiGet("/api/v1/retention/policies");
    await apiPost("/api/v1/retention/policies", { name: "x" });

    for (const call of spy.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.headers).toMatchObject({ Authorization: "Bearer jwt-token" });
    }
  });

  it("notifies auth subscribers when a credentialed request gets 401", async () => {
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "token_expired: token expired" }, 401, "Unauthorized"),
    );

    await expect(apiGet("/api/v1/auth/me")).rejects.toThrow(/token_expired/);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("propagates a 401 while signed out without breaking the request", async () => {
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "not_authenticated: credentials missing" }, 401, "Unauthorized"),
    );

    await expect(apiGet("/api/v1/auth/me")).rejects.toBeInstanceOf(ApiError);
    // The client always notifies; the auth layer is subscribed only while a
    // session is active, so an anonymous 401 is a no-op for the UI.
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("renders Pydantic 422 validation errors field by field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          detail: [
            { loc: ["body", "reason"], msg: "String should have at least 10 characters" },
            { loc: ["query", "institution_id"], msg: "Input should be a valid integer" },
          ],
        },
        422,
        "Unprocessable Entity",
      ),
    );

    await expect(apiPost("/x", {})).rejects.toThrow(
      "reason: String should have at least 10 characters; " +
        "institution_id: Input should be a valid integer",
    );
  });
});

describe("tokenStore", () => {
  it("round-trips a token through memory", () => {
    setAccessToken("abc.def.ghi");
    expect(getAccessToken()).toBe("abc.def.ghi");
    setAccessToken(null);
    expect(getAccessToken()).toBeNull();
  });

  it("persists the token so a reload keeps the session", () => {
    setAccessToken("persisted");
    expect(window.localStorage.getItem("datadiet.access_token")).toBe("persisted");
    setAccessToken(null);
    expect(window.localStorage.getItem("datadiet.access_token")).toBeNull();
  });

  it("notifies every subscriber and stops after unsubscribe", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = onUnauthorized(first);
    onUnauthorized(second);

    notifyUnauthorized();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    notifyUnauthorized();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });
});

describe("toErrorMessage", () => {
  it("handles ApiError, Error, and unknown values", () => {
    expect(toErrorMessage(new ApiError("boom", 500))).toBe("boom");
    expect(toErrorMessage(new Error("plain"))).toBe("plain");
    expect(toErrorMessage("nope")).toBe("An unexpected error occurred.");
  });
});
