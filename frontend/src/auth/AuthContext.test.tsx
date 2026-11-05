/**
 * Auth context behaviour (Phase 7, ADR-0014).
 *
 * The API modules are mocked so these tests verify session restoration,
 * sign-in/out, permission helpers, institution scoping, and the mid-session
 * rejection (401) path without a backend. The token itself is exercised
 * through the real tokenStore.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { getAccessToken, notifyUnauthorized, setAccessToken } from "../api/tokenStore";
import type { UserProfile } from "../api/types";
import { testUser } from "../test/auth";
import { AuthProvider, useAuth } from "./AuthContext";

const devLogin = vi.fn();
const fetchMe = vi.fn();

vi.mock("../api/auth", () => ({
  devLogin: (...args: unknown[]) => devLogin(...args),
  fetchMe: (...args: unknown[]) => fetchMe(...args),
  fetchAuthConfig: vi.fn(),
}));

/** Renders the context state for assertions, with buttons for the actions. */
function Probe() {
  const { status, user, sessionExpired, activeInstitutionId, has, signIn, signOut } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.email ?? "none"}</span>
      <span data-testid="expired">{String(sessionExpired)}</span>
      <span data-testid="scope">{activeInstitutionId === null ? "all" : activeInstitutionId}</span>
      <span data-testid="can-decide">{String(has("review:decide"))}</span>
      <button
        type="button"
        onClick={() => {
          void signIn({ email: "dev@example.org" }).catch(() => undefined);
        }}
      >
        dev sign in
      </button>
      <button type="button" onClick={signOut}>
        sign out
      </button>
    </div>
  );
}

/** Bootstraps a session like the real app (undefined = run /auth/me restore). */
function renderProbe(initialUser?: UserProfile | null) {
  return render(
    <AuthProvider {...(initialUser === undefined ? {} : { initialUser })}>
      <Probe />
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setAccessToken(null);
});

describe("AuthContext", () => {
  it("starts anonymous when no token is stored", async () => {
    renderProbe();
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("anonymous");
    });
    expect(fetchMe).not.toHaveBeenCalled();
  });

  it("restores a stored token by verifying it with the server", async () => {
    const profile = testUser({ email: "restored@example.org" });
    setAccessToken("stored.jwt.token");
    fetchMe.mockResolvedValue(profile);
    renderProbe();

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });
    expect(screen.getByTestId("user")).toHaveTextContent("restored@example.org");
    expect(getAccessToken()).toBe("stored.jwt.token");
  });

  it("discards a dead stored token silently at bootstrap", async () => {
    setAccessToken("stale.token");
    fetchMe.mockRejectedValue(new ApiError("token_expired: token expired", 401));
    renderProbe();

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("anonymous");
    });
    // A token that never worked is not an "expired session" event.
    expect(screen.getByTestId("expired")).toHaveTextContent("false");
    expect(getAccessToken()).toBeNull();
  });

  it("keeps the reason visible when /auth/me fails for a non-auth reason", async () => {
    setAccessToken("valid-but-backend-down");
    fetchMe.mockRejectedValue(new ApiError("auth_not_configured: production requires...", 503));
    renderProbe();

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("anonymous");
    });
    // The token is kept so a retry can still succeed once the server is back.
    expect(getAccessToken()).toBe("valid-but-backend-down");
  });

  it("signs in through the development provider and keeps the issued token", async () => {
    const profile = testUser({ email: "dev@example.org" });
    devLogin.mockResolvedValue({ access_token: "issued.token", token_type: "bearer", expires_in: 900 });
    fetchMe.mockResolvedValue(profile);
    renderProbe(null);

    await userEvent.click(screen.getByRole("button", { name: /dev sign in/i }));

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });
    expect(devLogin).toHaveBeenCalledWith({ email: "dev@example.org" });
    // The token came back from dev-login; /auth/me then verified it.
    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBe("issued.token");
  });

  it("surfaces a rejected sign-in and stays anonymous", async () => {
    devLogin.mockRejectedValue(
      new ApiError("sign_in_unavailable: development sign-in is disabled in production", 503),
    );
    renderProbe(null);

    await userEvent.click(screen.getByRole("button", { name: /dev sign in/i }));

    await waitFor(() => {
      expect(devLogin).toHaveBeenCalled();
    });
    expect(screen.getByTestId("status")).toHaveTextContent("anonymous");
    expect(getAccessToken()).toBeNull();
  });

  it("exposes permissions and auto-selects the only institution", () => {
    renderProbe(testUser({ institutions: [7] }));
    expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    expect(screen.getByTestId("scope")).toHaveTextContent("7");
    expect(screen.getByTestId("can-decide")).toHaveTextContent("true");
  });

  it("leaves platform admins unscoped and hides decide from viewers", () => {
    renderProbe(
      testUser({ is_platform_admin: true, role: "viewer", permissions: ["inventory:read"] }),
    );
    expect(screen.getByTestId("scope")).toHaveTextContent("all");
    expect(screen.getByTestId("can-decide")).toHaveTextContent("false");
  });

  it("moves to an expired state when the server rejects the session mid-flight", async () => {
    renderProbe(testUser());
    expect(screen.getByTestId("status")).toHaveTextContent("authenticated");

    // A request somewhere in the app received a 401.
    notifyUnauthorized();

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("anonymous");
    });
    expect(screen.getByTestId("expired")).toHaveTextContent("true");
    expect(getAccessToken()).toBeNull();
  });

  it("signs out by discarding the token (no server call)", async () => {
    renderProbe(testUser());
    setAccessToken("tok");

    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));

    expect(screen.getByTestId("status")).toHaveTextContent("anonymous");
    expect(screen.getByTestId("expired")).toHaveTextContent("false");
    expect(getAccessToken()).toBeNull();
    expect(fetchMe).not.toHaveBeenCalled();
  });
});
