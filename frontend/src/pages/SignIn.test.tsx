/**
 * Sign-in screen (Phase 7, ADR-0014).
 *
 * Verifies the page reports what the deployment *actually* has from the public
 * /auth/config endpoint — development form, pasted-token form, or an honest
 * "not configured" panel with no form at all — and that a failed sign-in
 * surfaces the server's message instead of pretending to succeed.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { AuthConfig } from "../api/types";
import { testUser } from "../test/auth";
import { AuthProvider } from "../auth/AuthContext";
import SignIn from "./SignIn";

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
  description: "auth_not_configured: production requires AUTH_JWT_SECRET.",
};

function renderSignIn(config: AuthConfig = DEVELOPMENT) {
  fetchAuthConfig.mockResolvedValue(config);
  return render(
    <AuthProvider initialUser={null}>
      <SignIn />
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
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
});
