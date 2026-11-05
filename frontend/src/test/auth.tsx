/**
 * Synthetic identities and a provider wrapper for component tests (Phase 7).
 *
 * These mirror the role/permission matrix the backend documents in ADR-0014;
 * they exist so UI tests can render a signed-in user without a backend. The
 * permissions here are only what tests inject — in the real app they come from
 * `GET /auth/me`.
 */

import type { ReactElement, ReactNode } from "react";
import { AuthProvider } from "../auth/AuthContext";
import type { Permission, RoleValue, UserProfile } from "../api/types";

const VIEWER: Permission[] = ["inventory:read", "governance:read", "retention:read", "sources:read"];
const REVIEWER: Permission[] = [...VIEWER, "retention:assess", "review:decide"];
const ADMIN: Permission[] = [
  ...REVIEWER,
  "retention:write",
  "sources:write",
  "assets:write",
  "classification:write",
];
const PLATFORM: Permission[] = [...ADMIN, "users:manage"];

export const ROLE_PERMISSIONS: Record<RoleValue, Permission[]> = {
  viewer: VIEWER,
  reviewer: REVIEWER,
  admin: ADMIN,
};

/** A synthetic signed-in account. Defaults to an institutional reviewer. */
export function testUser(overrides: Partial<UserProfile> = {}): UserProfile {
  const role = overrides.role ?? "reviewer";
  const permissions = overrides.permissions ?? ROLE_PERMISSIONS[role] ?? REVIEWER;
  return {
    id: 7,
    email: "reviewer@example.org",
    display_name: "Synthetic Reviewer",
    role,
    is_platform_admin: false,
    institutions: [1],
    ...overrides,
    permissions,
  };
}

/** A platform administrator: every permission and cross-institution scope. */
export function platformAdmin(overrides: Partial<UserProfile> = {}): UserProfile {
  return testUser({
    email: "platform.admin@example.org",
    display_name: "Synthetic Platform Admin",
    role: "admin",
    is_platform_admin: true,
    permissions: PLATFORM,
    ...overrides,
  });
}

/** Wrap UI in an authenticated provider. Pass `null` to render signed out. */
export function withAuth(ui: ReactNode, user: UserProfile | null = testUser()): ReactElement {
  return <AuthProvider initialUser={user}>{ui}</AuthProvider>;
}
