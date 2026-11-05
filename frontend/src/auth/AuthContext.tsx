/**
 * Authentication context for the DataDiet SPA (Phase 7, ADR-0014).
 *
 * Responsibilities:
 * - Restore a stored bearer token on load and verify it against the *server*
 *   (`GET /auth/me`); the UI never decides identity or permissions locally —
 *   `user.permissions` is what the server verified, used for usability only.
 * - Sign in through the development provider (never available in production
 *   on the server) or with a token pasted from an external identity provider.
 * - Sign out by discarding the token (bearer tokens are stateless).
 * - React to a 401 from any request: the session moved to "expired" so the UI
 *   can tell the user why they are back at the sign-in screen.
 * - Track the active institution scope for accounts with several
 *   memberships, so list requests are explicit instead of ambiguous.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ApiError, toErrorMessage } from "../api/client";
import { devLogin, fetchMe } from "../api/auth";
import {
  getAccessToken,
  onUnauthorized,
  setAccessToken,
} from "../api/tokenStore";
import type { DevLoginRequest, Permission, UserProfile } from "../api/types";

export type AuthStatus = "loading" | "authenticated" | "anonymous";

export interface AuthContextValue {
  status: AuthStatus;
  user: UserProfile | null;
  /** True when a previously working token was rejected mid-session. */
  sessionExpired: boolean;
  /** Institution the UI scopes list requests to; null = unscoped (platform admin). */
  activeInstitutionId: number | null;
  setActiveInstitution: (institutionId: number | null) => void;
  /** Sign in through the local development identity provider. */
  signIn: (request: DevLoginRequest) => Promise<void>;
  /** Sign in with a token issued elsewhere (e.g. pasted from an IdP). */
  signInWithToken: (token: string) => Promise<void>;
  /** Discard the token. The server keeps no session to end. */
  signOut: () => void;
  /** Usability helper; the backend re-checks every permission server-side. */
  has: (permission: Permission) => boolean;
}

const ANONYMOUS: AuthContextValue = {
  status: "anonymous",
  user: null,
  sessionExpired: false,
  activeInstitutionId: null,
  setActiveInstitution: () => undefined,
  signIn: () => Promise.reject(new Error("AuthProvider is not mounted.")),
  signInWithToken: () => Promise.reject(new Error("AuthProvider is not mounted.")),
  signOut: () => undefined,
  has: () => false,
};

const AuthContext = createContext<AuthContextValue>(ANONYMOUS);

/** Default scope: platform admins start unscoped; everyone else their first (only) membership. */
function defaultInstitution(user: UserProfile): number | null {
  if (user.is_platform_admin) {
    return null;
  }
  return user.institutions[0] ?? null;
}

async function startSession(token: string): Promise<UserProfile> {
  setAccessToken(token);
  try {
    return await fetchMe();
  } catch (cause) {
    setAccessToken(null);
    if (cause instanceof ApiError && cause.status === 401) {
      throw new Error(
        "The server rejected this token (invalid, expired, or issued for another service).",
      );
    }
    throw new Error(toErrorMessage(cause));
  }
}

export function AuthProvider({
  children,
  initialUser,
}: {
  children: ReactNode;
  /**
   * Test hook: begin with this identity (null = signed out) and skip the
   * `/auth/me` bootstrap. Leave undefined in the real app.
   */
  initialUser?: UserProfile | null;
}) {
  const [user, setUser] = useState<UserProfile | null>(initialUser ?? null);
  const [status, setStatus] = useState<AuthStatus>(
    initialUser === undefined ? "loading" : initialUser === null ? "anonymous" : "authenticated",
  );
  const [sessionExpired, setSessionExpired] = useState(false);
  const [activeInstitution, setActiveInstitution] = useState<number | null>(
    initialUser ? defaultInstitution(initialUser) : null,
  );

  /* --------------------------- session bootstrap -------------------------- */

  useEffect(() => {
    if (initialUser !== undefined) {
      return;
    }
    let cancelled = false;

    async function run(): Promise<void> {
      if (getAccessToken() === null) {
        if (!cancelled) {
          setStatus("anonymous");
        }
        return;
      }
      try {
        const profile = await fetchMe();
        if (!cancelled) {
          setUser(profile);
          setActiveInstitution(defaultInstitution(profile));
          setStatus("authenticated");
        }
      } catch (cause) {
        if (cancelled) {
          return;
        }
        if (cause instanceof ApiError && cause.status === 401) {
          // The stored token is no longer accepted: discard it. This is a
          // silent sign-out, not a "your session expired" event, because the
          // token was already dead on arrival (e.g. an old browser session).
          setAccessToken(null);
        }
        // Any other failure (backend unreachable, 503 auth not configured)
        // leaves the user signed out with the reason visible on the sign-in
        // screen; the token is kept so a retry can still succeed.
        setUser(null);
        setStatus("anonymous");
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [initialUser]);

  /* --------------------- mid-session rejection handling ------------------- */

  useEffect(() => {
    if (status !== "authenticated") {
      return;
    }
    // Subscribed only after a successful bootstrap/sign-in, so the 401 of an
    // already-dead stored token above does not read as an expired session.
    return onUnauthorized(() => {
      setAccessToken(null);
      setUser(null);
      setActiveInstitution(null);
      setStatus("anonymous");
      setSessionExpired(true);
    });
  }, [status]);

  /* --------------------------- institution scope -------------------------- */

  // Keep the selection valid for the signed-in account (a membership list can
  // change between sessions).
  useEffect(() => {
    if (user === null) {
      setActiveInstitution(null);
      return;
    }
    setActiveInstitution((current) => {
      if (current !== null && user.institutions.includes(current)) {
        return current;
      }
      return defaultInstitution(user);
    });
  }, [user]);

  /* -------------------------------- actions ------------------------------- */

  const signIn = useCallback(async (request: DevLoginRequest): Promise<void> => {
    const token = await devLogin(request);
    const profile = await startSession(token.access_token);
    setUser(profile);
    setActiveInstitution(defaultInstitution(profile));
    setSessionExpired(false);
    setStatus("authenticated");
  }, []);

  const signInWithToken = useCallback(async (token: string): Promise<void> => {
    const trimmed = token.trim();
    if (!trimmed) {
      throw new Error("Paste a bearer token to continue.");
    }
    const profile = await startSession(trimmed);
    setUser(profile);
    setActiveInstitution(defaultInstitution(profile));
    setSessionExpired(false);
    setStatus("authenticated");
  }, []);

  const signOut = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setActiveInstitution(null);
    setSessionExpired(false);
    setStatus("anonymous");
  }, []);

  const has = useCallback(
    (permission: Permission): boolean => user?.permissions.includes(permission) ?? false,
    [user],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      sessionExpired,
      activeInstitutionId: activeInstitution,
      setActiveInstitution,
      signIn,
      signInWithToken,
      signOut,
      has,
    }),
    [status, user, sessionExpired, activeInstitution, signIn, signInWithToken, signOut, has],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * The current auth state.
 *
 * Outside a provider this returns the anonymous defaults rather than
 * throwing, so a page rendered in isolation still renders (as signed-out).
 */
export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
