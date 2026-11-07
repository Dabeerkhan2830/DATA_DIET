/**
 * Clerk session integration (Phase 6.0, ADR-0025).
 *
 * `@clerk/clerk-react` is replaced by a controllable stand-in, because what is
 * under test here is *DataDiet's* side of the seam: that a Clerk session token is
 * resolved per request and never copied into DataDiet's own storage, that the
 * profile and permissions come only from `GET /auth/me`, that a refusal by the
 * server is shown as a refusal instead of a session, and that sign-out ends the
 * provider's session too. Clerk's own behaviour — its hosted form, its token
 * minting and refresh — was not exercised against a real Clerk instance by any
 * test in this file.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGet } from "../api/client";
import { getAccessToken, setAccessToken } from "../api/tokenStore";
import type { AuthConfig } from "../api/types";
import { testUser } from "../test/auth";
import App from "../App";
import { AuthProvider, useAuth } from "./AuthContext";
import { ClerkBoundary } from "./ClerkBoundary";
import {
  getExternalSessionSnapshot,
  setExternalSessionSnapshot,
} from "./externalSession";

const clerk = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true as boolean,
  token: "clerk.session.token" as string | null,
  tokenCalls: 0,
  signOutCalls: 0,
  failToken: false,
  listeners: new Set<() => void>(),
  emit() {
    for (const listener of [...this.listeners]) {
      listener();
    }
  },
}));

/**
 * A stand-in for Clerk's React SDK. It is written without JSX on purpose: the
 * mock factory runs while the module graph is still being resolved, before this
 * file's own imports exist.
 *
 * `useAuth` is made reactive through an external store because Clerk's real hook
 * re-renders its consumers when the session changes; a static stand-in would
 * only prove that our code reads the values it was handed at mount.
 */
vi.mock("@clerk/clerk-react", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    ClerkProvider: ({ children }: { children: unknown }) => children,
    useAuth: () => ({
      isLoaded: clerk.isLoaded,
      isSignedIn: useSyncExternalStore(
        (listener: () => void) => {
          clerk.listeners.add(listener);
          return () => {
            clerk.listeners.delete(listener);
          };
        },
        () => clerk.isSignedIn,
        () => clerk.isSignedIn,
      ),
      getToken: async () => {
        clerk.tokenCalls += 1;
        if (clerk.failToken) {
          throw new Error("Clerk network failure");
        }
        return clerk.token;
      },
      signOut: async () => {
        clerk.signOutCalls += 1;
        clerk.isSignedIn = false;
        clerk.token = null;
        clerk.emit();
      },
    }),
    SignIn: () => "clerk-hosted-sign-in",
  };
});

const fetchMe = vi.fn();
const fetchAuthConfig = vi.fn();
const devLogin = vi.fn();

/**
 * The last test mounts the real router and shell, so the page the shell renders
 * must not be able to crash the route guard under test. Its data is not part of
 * this seam, so both demo calls reject — which those pages already render as
 * their documented error state.
 */
vi.mock("../api/demo", () => ({
  fetchDashboard: () => Promise.reject(new Error("dashboard data is not part of this test")),
  fetchHealth: () => Promise.reject(new Error("health is not part of this test")),
}));

vi.mock("../api/auth", () => ({
  fetchMe: () => fetchMe(),
  fetchAuthConfig: () => fetchAuthConfig(),
  devLogin: (...args: unknown[]) => devLogin(...args),
}));

const CLERK_CONFIG: AuthConfig = {
  environment: "staging",
  authentication: "clerk",
  dev_login_enabled: false,
  identity_provider: "clerk",
  issuer: "https://clerk.example.org",
  audience: "datadiet-staging",
  token_ttl_seconds: 900,
  description: "Session tokens are issued by Clerk and verified here with RS256.",
};

function Probe() {
  const {
    status,
    user,
    sessionExpired,
    anonymousReason,
    activeInstitutionId,
    has,
    signOut,
  } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.email ?? "none"}</span>
      <span data-testid="expired">{String(sessionExpired)}</span>
      <span data-testid="reason">{anonymousReason ?? "none"}</span>
      <span data-testid="scope">{activeInstitutionId === null ? "all" : activeInstitutionId}</span>
      <span data-testid="can-read">{String(has("inventory:read"))}</span>
      <span data-testid="can-manage-users">{String(has("users:manage"))}</span>
      <button type="button" onClick={signOut}>
        sign out
      </button>
    </div>
  );
}

/** The real mount order: Clerk's boundary, then DataDiet's auth provider. */
function renderClerkApp() {
  return render(
    <ClerkBoundary>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </ClerkBoundary>,
  );
}

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  clerk.isLoaded = true;
  clerk.isSignedIn = true;
  clerk.token = "clerk.session.token";
  clerk.tokenCalls = 0;
  clerk.signOutCalls = 0;
  clerk.failToken = false;
  clerk.listeners.clear();
  setAccessToken(null);
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_synthetic_key");
});

afterEach(() => {
  // The seam is module-level state; leave nothing for the next test to inherit.
  setExternalSessionSnapshot({ state: "idle" });
  setAccessToken(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Clerk session integration", () => {
  it("bootstraps the signed-in user from the server, not from Clerk", async () => {
    const profile = testUser({ email: "linked@example.org", institutions: [3] });
    fetchMe.mockResolvedValue(profile);

    renderClerkApp();

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });
    expect(screen.getByTestId("user")).toHaveTextContent("linked@example.org");
    expect(screen.getByTestId("scope")).toHaveTextContent("3");
    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(getExternalSessionSnapshot().state).toBe("signed-in");
  });

  it("sends the Clerk session token as the bearer credential and stores no copy", async () => {
    fetchMe.mockResolvedValue(testUser());
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ status: "ready" }));

    renderClerkApp();
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });

    await apiGet("/api/v1/health/ready");
    await apiGet("/api/v1/assets");

    const authorized = spy.mock.calls
      .map((call) => (call[1] as RequestInit).headers as Record<string, string>)
      .filter((headers) => "Authorization" in headers);
    expect(authorized.length).toBe(2);
    for (const headers of authorized) {
      expect(headers.Authorization).toBe("Bearer clerk.session.token");
    }
    // No token is resolved more than once per request, and none is ours to keep.
    expect(clerk.tokenCalls).toBe(2);
    expect(getAccessToken()).toBeNull();
    expect(window.localStorage.getItem("datadiet.access_token")).toBeNull();
  });

  it("discards a development token left in this browser and never uses it", async () => {
    setAccessToken("stale.development.token");
    fetchMe.mockResolvedValue(testUser());
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ status: "ready" }));

    renderClerkApp();
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });
    await apiGet("/api/v1/assets");

    expect(getAccessToken()).toBeNull();
    expect(window.localStorage.getItem("datadiet.access_token")).toBeNull();
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer clerk.session.token");
  });

  it("publishes no session and issues no profile request while Clerk is signed out", async () => {
    clerk.isSignedIn = false;
    clerk.token = null;
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ status: "ready" }));

    renderClerkApp();

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("anonymous");
    });
    expect(fetchMe).not.toHaveBeenCalled();

    await apiGet("/api/v1/health");
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers).not.toHaveProperty("Authorization");
    expect(clerk.tokenCalls).toBe(0);
  });

  it("shows the server's refusal of an unlinked identity instead of a session", async () => {
    fetchMe.mockRejectedValue(
      new ApiError(
        "unknown_account: This identity is not linked to a DataDiet account yet; " +
          "an administrator must link it first.",
        401,
      ),
    );

    renderClerkApp();

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("anonymous");
    });
    expect(screen.getByTestId("user")).toHaveTextContent("none");
    expect(screen.getByTestId("can-read")).toHaveTextContent("false");
    expect(screen.getByTestId("reason")).toHaveTextContent(/not linked to a DataDiet account/);
    // The provider session is not the thing that failed: DataDiet refused it.
    expect(clerk.signOutCalls).toBe(0);
    expect(getExternalSessionSnapshot().state).toBe("signed-in");
  });

  it("keeps the server's own failure visible when the provider cannot be reached", async () => {
    fetchMe.mockRejectedValue(
      new ApiError(
        "identity_provider_unavailable: The identity provider's signing keys " +
          "could not be retrieved.",
        503,
      ),
    );

    renderClerkApp();

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("anonymous");
    });
    expect(screen.getByTestId("reason")).toHaveTextContent(/identity provider/);
    expect(screen.getByTestId("user")).toHaveTextContent("none");
  });

  it("expires the session when a later request is answered with 401", async () => {
    fetchMe.mockResolvedValue(testUser());
    renderClerkApp();
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "token_expired: token has expired" }, 401),
    );
    await expect(apiGet("/api/v1/assets")).rejects.toBeInstanceOf(ApiError);

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("anonymous");
    });
    expect(screen.getByTestId("expired")).toHaveTextContent("true");
    expect(getAccessToken()).toBeNull();
  });

  it("loads an identity with no DataDiet membership as permissionless", async () => {
    fetchMe.mockResolvedValue(
      testUser({ institutions: [], permissions: [], role: null }),
    );

    renderClerkApp();

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });
    // Verified identity, zero authority: the directory granted nothing.
    expect(screen.getByTestId("scope")).toHaveTextContent("all");
    expect(screen.getByTestId("can-read")).toHaveTextContent("false");
    expect(screen.getByTestId("can-manage-users")).toHaveTextContent("false");
  });

  it("signs out of Clerk as well as DataDiet", async () => {
    fetchMe.mockResolvedValue(testUser());
    renderClerkApp();
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });

    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));

    expect(screen.getByTestId("status")).toHaveTextContent("anonymous");
    expect(clerk.signOutCalls).toBe(1);
    expect(getAccessToken()).toBeNull();
    await waitFor(() => {
      expect(getExternalSessionSnapshot().state).toBe("signed-out");
    });
  });

  it("refuses to send an uncredentialed request when Clerk cannot produce a token", async () => {
    fetchMe.mockResolvedValue(testUser());
    renderClerkApp();
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });

    clerk.failToken = true;
    const spy = vi.spyOn(globalThis, "fetch");

    await expect(apiGet("/api/v1/assets")).rejects.toThrow(/identity_provider_unavailable/);
    // The request was never sent, so the server cannot be blamed for the 401.
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps protected routes behind the provider session", async () => {
    fetchAuthConfig.mockResolvedValue(CLERK_CONFIG);
    /** The shell's persistent rail — it exists only under `ProtectedLayout`. */
    const shell = () => screen.queryAllByRole("complementary", { name: /sidebar/i });

    /*
      `/` is served to anonymous visitors by design (the public landing page),
      so the guard has to be exercised from a path that is genuinely protected.
    */
    window.history.pushState({}, "", "/inventory");

    // Signed out at the provider: the route redirects, the only thing shown is
    // Clerk's own form, no DataDiet chrome is mounted, and no profile request is
    // made in a session that does not exist.
    clerk.isSignedIn = false;
    clerk.token = null;

    const signedOut = render(<App />);

    expect(await screen.findByText("clerk-hosted-sign-in")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/signin");
    expect(shell()).toHaveLength(0);
    expect(fetchMe).not.toHaveBeenCalled();
    signedOut.unmount();

    // Signed in at the provider but refused by the server: the refusal is the
    // screen, not the application.
    window.history.pushState({}, "", "/inventory");
    clerk.isSignedIn = true;
    clerk.token = "clerk.session.token";
    fetchMe.mockRejectedValue(
      new ApiError("unknown_account: this identity is not linked to a DataDiet account.", 401),
    );

    const refused = render(<App />);

    expect(
      await screen.findByText(/DataDiet has not granted a session/i),
    ).toBeInTheDocument();
    expect(shell()).toHaveLength(0);
    refused.unmount();

    // Verified by the server: the application mounts and reads its identity from
    // `/auth/me`, never from Clerk's session object.
    window.history.pushState({}, "", "/inventory");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ items: [], total: 0 }));
    fetchMe.mockReset();
    fetchMe.mockResolvedValue(testUser({ email: "linked@example.org" }));

    const granted = render(<App />);

    await waitFor(() => {
      expect(shell().length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("clerk-hosted-sign-in")).not.toBeInTheDocument();
    expect(fetchMe).toHaveBeenCalledTimes(1);
    granted.unmount();

    // Leave the document at the landing page for any later test in this file.
    window.history.pushState({}, "", "/");
  });
});
