/**
 * Typed client for the authentication endpoints (ADR-0014; Clerk added by
 * Phase 6.0, ADR-0025).
 *
 * Three surfaces, mirroring backend/app/api/routes/auth.py:
 * - `fetchAuthConfig` is public and honest about what this deployment has.
 * - `devLogin` is a development/test convenience. The server refuses it once an
 *   identity provider is configured, and in a protected environment the route is
 *   not registered at all, so this call cannot become production authentication.
 * - `fetchMe` returns the *server-verified* identity for whichever bearer
 *   credential the client is presenting: a DataDiet token from `devLogin` or a
 *   pasted issuer, or a Clerk session token supplied by the mounted provider.
 *   The profile and permissions always come from DataDiet's own directory.
 *
 * There is no logout call: DataDiet keeps no server-side session, so signing out
 * means discarding the local credential — and, with a provider mounted, ending
 * that provider's browser session too (see `auth/externalSession.ts`).
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
