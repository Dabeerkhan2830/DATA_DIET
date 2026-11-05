/**
 * Typed client for the Phase 7 authentication endpoints (ADR-0014).
 *
 * Three surfaces, mirroring backend/app/api/routes/auth.py:
 * - `fetchAuthConfig` is public and honest about what this deployment has.
 * - `devLogin` is a development/test convenience the server refuses in
 *   production; it is not single sign-on and never claims to be.
 * - `fetchMe` returns the *server-verified* identity for the stored token.
 *
 * There is no logout call: bearer tokens are stateless, so signing out is
 * discarding the token client-side.
 */

import { apiGet, apiPost } from "./client";
import type { AuthConfig, DevLoginRequest, TokenResponse, UserProfile } from "./types";

export const AUTH_PREFIX = "/api/v1/auth";

/** Public. What kind of authentication this deployment actually has. */
export function fetchAuthConfig(): Promise<AuthConfig> {
  return apiGet<AuthConfig>(`${AUTH_PREFIX}/config`);
}

/**
 * Development/test sign-in for a synthetic local account.
 *
 * The server issues a real, signed bearer token through the same verification
 * path as any other token — but hard-disables this endpoint in production, so
 * development identity can never become production authentication.
 */
export function devLogin(request: DevLoginRequest): Promise<TokenResponse> {
  return apiPost<TokenResponse>(`${AUTH_PREFIX}/dev-login`, request);
}

/** The verified identity, institution scope, and permissions for our token. */
export function fetchMe(): Promise<UserProfile> {
  return apiGet<UserProfile>(`${AUTH_PREFIX}/me`);
}
