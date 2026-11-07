/**
 * Sign-in screen (Phase 7, ADR-0014; Clerk mode added by Phase 6.0, ADR-0025).
 *
 * Verifies the page reports what the deployment *actually* has from the public
 * /auth/config endpoint — development form, pasted-token form, Clerk's own
 * sign-in, or an honest "not configured" panel with no form at all — and that a
 * failed sign-in surfaces the server's message instead of pretending to succeed.
 *
 * In Clerk mode the page delegates sign-in to Clerk's component, so the SDK is
 * replaced by a marker here: what is under test is which panel DataDiet shows
 * for each deployment and provider state, not Clerk's hosted form.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { AuthConfig } from "../api/types";
import { testUser } from "../test/auth";
import { AuthProvider } from "../auth/AuthContext";
import { setExternalSessionSnapshot } from "../auth/externalSession";
import type { ExternalSessionSnapshot } from "../auth/externalSession";
import SignIn from "./SignIn";

/**
 * Declared with `vi.hoisted` because the mock factory below runs while the
 * module graph is still being resolved, before this file's own statements.
 */
const { CLERK_FORM_MARKER } = vi.hoisted(() => ({ CLERK_FORM_MARKER: "clerk-hosted-sign-in" }));

vi.mock("@clerk/clerk-react", () => ({
  ClerkProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: true,
    getToken: async () => null,
    signOut: async () => undefined,
  }),
  SignIn: () => CLERK_FORM_MARKER,
}));

const fetchAuthConfig = vi.fn();
const devLogin = vi.fn();
const fetchMe = vi.fn();

vi.mock("../api/auth", () => ({
  fetchAuthConfig: (...args: unknown[]) => fetchAuthConfig(...args),
  devLogin: (...args: unknown[]) => devLogin(...args),
  fetchMe: (...args: unknown[]) => fetchMe(...args),
}));

const DEVELOPMENT: AuthConfig = {
  environment: "development",
  authentication: "development",
  dev_login_enabled: true,
  identity_provider: "local",
  issuer: "datadiet",
  audience: "datadiet-api",
  token_ttl_seconds: 900,
  description: "Local development sign-in is available.",
};

const BEARER: AuthConfig = {
  ...DEVELOPMENT,
  authentication: "bearer_boundary",
  dev_login_enabled: false,
  description: "Bearer tokens are verified; no identity provider is configured.",
};

const UNCONFIGURED: AuthConfig = {
  ...DEVELOPMENT,
  authentication: "unconfigured",
  dev_login_enabled: false,
  identity_provider: "none",
  issuer: "",
  audience: "",
  description: "auth_not_configured: production requires AUTH_JWT_SECRET.",
};

const CLERK: AuthConfig = {
  ...DEVELOPMENT,
  environment: "staging",
  authentication: "clerk",
  dev_login_enabled: false,
  identity_provider: "clerk",
  issuer: "https://clerk.example.org",
  audience: "staging",
  description: "Session tokens are issued by Clerk and verified here with RS256.",
};

function renderSignIn(config: AuthConfig = DEVELOPMENT) {
  fetchAuthConfig.mockResolvedValue(config);
  return render(
    <AuthProvider initialUser={null}>
      <SignIn />
    </AuthProvider>,
  );
}

/** Clerk mode with the provider in `state`. A refusal needs the real bootstrap. */
function renderClerkSignIn(
  state: ExternalSessionSnapshot["state"],
  options: { refuse?: string } = {},
) {
  fetchAuthConfig.mockResolvedValue(CLERK);
  setExternalSessionSnapshot(
    state === "signed-in"
      ? {
          state: "signed-in",
          session: { getToken: async () => "clerk.session.token", signOut: async () => undefined },
        }
      : { state },
  );
  if (options.refuse !== undefined) {
    // No initialUser: the provider's session is verified by the server, and this
    // is the server's refusal coming back as `anonymousReason`.
    fetchMe.mockRejectedValue(new ApiError(options.refuse, 401));
    return render(
      <AuthProvider>
        <SignIn />
      </AuthProvider>,
    );
  }
  return render(
    <AuthProvider initialUser={null}>
      <SignIn />
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchAuthConfig.mockResolvedValue(DEVELOPMENT);
});

afterEach(() => {
  setExternalSessionSnapshot({ state: "idle" });
});

describe("SignIn", () => {
  it("shows the development sign-in form when the provider is available", async () => {
    renderSignIn();

    expect(await screen.findByText(/development sign-in/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^role/i)).toBeInTheDocument();
    // It must not pretend to be production authentication.
    expect(screen.getByText(/not production authentication/i)).toBeInTheDocument();
  });

  it("signs in with the form values", async () => {
    devLogin.mockResolvedValue({ access_token: "t", token_type: "bearer", expires_in: 900 });
    fetchMe.mockResolvedValue(testUser({ email: "new@example.org" }));
    renderSignIn();

    await userEvent.type(await screen.findByLabelText(/^email/i), "new@example.org");
    await userEvent.selectOptions(screen.getByLabelText(/^role/i), "admin");
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => {
      expect(devLogin).toHaveBeenCalledWith({ email: "new@example.org", role: "admin" });
    });
  });

  it("surfaces the server's refusal instead of faking success", async () => {
    devLogin.mockRejectedValue(
      new ApiError("sign_in_unavailable: development sign-in is disabled in production", 503),
    );
    renderSignIn();

    await userEvent.type(await screen.findByLabelText(/^email/i), "someone@example.org");
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/sign_in_unavailable/);
  });

  it("offers only a pasted token form in the bearer boundary mode", async () => {
    renderSignIn(BEARER);

    expect(
      await screen.findByText(/sign in with your organization's token/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/bearer token/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^email/i)).not.toBeInTheDocument();
  });

  it("explains the gap and shows no form when authentication is unconfigured", async () => {
    renderSignIn(UNCONFIGURED);

    expect(await screen.findByRole("heading", { name: /not configured/i })).toBeInTheDocument();
    expect(screen.getAllByText(/AUTH_JWT_SECRET/).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/bearer token/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^email/i)).not.toBeInTheDocument();
  });

  it("offers a retry when the configuration cannot be loaded at all", async () => {
    fetchAuthConfig.mockRejectedValue(new ApiError("Could not reach the API", 0));
    render(
      <AuthProvider initialUser={null}>
        <SignIn />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/sign-in configuration unavailable/i);
    });
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("hands sign-in to Clerk's own form and offers no DataDiet credential path", async () => {
    renderClerkSignIn("signed-out");

    expect(await screen.findByText(CLERK_FORM_MARKER)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /sign in with clerk/i }),
    ).toBeInTheDocument();
    // No local form of any kind: a token minted elsewhere is not what this
    // server verifies, and a synthetic account would bypass the provider.
    expect(screen.queryByLabelText(/^email/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/bearer token/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^sign in$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no self-service account creation/i)).toBeInTheDocument();
  });

  it("says so when the server uses Clerk but this build has no publishable key", async () => {
    renderClerkSignIn("idle");

    expect(
      await screen.findByRole("heading", {
        name: /clerk sign-in is not configured in this build/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/VITE_CLERK_PUBLISHABLE_KEY/).length).toBeGreaterThan(0);
    expect(screen.queryByText(CLERK_FORM_MARKER)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^email/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/bearer token/i)).not.toBeInTheDocument();
  });

  it("waits for the provider instead of showing a form it cannot use", async () => {
    renderClerkSignIn("loading");

    expect(await screen.findByText(/connecting to the identity provider/i)).toBeInTheDocument();
    expect(screen.queryByText(CLERK_FORM_MARKER)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^email/i)).not.toBeInTheDocument();
  });

  it("shows the server's refusal of a Clerk session instead of a session", async () => {
    renderClerkSignIn("signed-in", {
      refuse: "unknown_account: this identity is not linked to a DataDiet account yet.",
    });

    expect(
      await screen.findByRole("heading", {
        name: /DataDiet has not granted a session/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/not linked to a DataDiet account/);
    // The provider session is not re-offered as if signing in again could help.
    expect(screen.queryByText(CLERK_FORM_MARKER)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /end this session/i })).toBeInTheDocument();
  });

  it("ends the provider session when the user gives up on a refused sign-in", async () => {
    let signOutCalls = 0;
    fetchAuthConfig.mockResolvedValue(CLERK);
    fetchMe.mockRejectedValue(
      new ApiError("unknown_account: this identity is not linked to a DataDiet account yet.", 401),
    );
    setExternalSessionSnapshot({
      state: "signed-in",
      session: {
        getToken: async () => "clerk.session.token",
        signOut: async () => {
          signOutCalls += 1;
          setExternalSessionSnapshot({ state: "signed-out" });
        },
      },
    });

    render(
      <AuthProvider>
        <SignIn />
      </AuthProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: /end this session/i }));

    await waitFor(() => {
      expect(signOutCalls).toBe(1);
    });
    expect(await screen.findByText(CLERK_FORM_MARKER)).toBeInTheDocument();
  });
});
