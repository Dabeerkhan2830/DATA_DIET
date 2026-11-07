/**
 * Authentication context for the DataDiet SPA (Phase 7, ADR-0014; Clerk session
 * bootstrap added by Phase 6.0, ADR-0025).
 *
 * Responsibilities:
 * - Restore a session and verify it against the *server* (`GET /auth/me`); the
 *   UI never decides identity or permissions locally — `user.permissions` is
 *   what the server verified, used for usability only.
 * - Two session sources, chosen by what is actually mounted:
 *   * an external identity provider (Clerk): the provider owns sign-in and the
 *     token, so this context only ever asks the server who that identity is. No
 *     token is copied into DataDiet's storage, and a locally stored development
 *     token is never consulted while a provider is mounted.
 *   * DataDiet's own token store: the development provider or a pasted bearer
 *     token, available outside staging and production only.
 * - Sign out by ending the provider's session when there is one, and always by
 *   discarding the local view of it (bearer tokens are stateless).
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
import { useExternalSessionSnapshot } from "./externalSession";

export type AuthStatus = "loading" | "authenticated" | "anonymous";

export interface AuthContextValue {
  status: AuthStatus;
  user: UserProfile | null;
  /** True when a previously working token was rejected mid-session. */
  sessionExpired: boolean;
  /**
   * Why the server refused an *external* (Clerk) session, verbatim from the
   * response. Null when nobody is signed in at the provider, and in the local
   * token modes, where the sign-in form already explains itself.
   */
  anonymousReason: string | null;
  /** Institution the UI scopes list requests to; null = unscoped (platform admin). */
  activeInstitutionId: number | null;
  setActiveInstitution: (institutionId: number | null) => void;
  /** Sign in through the local development identity provider. */
  signIn: (request: DevLoginRequest) => Promise<void>;
  /** Sign in with a token issued elsewhere (e.g. pasted from an IdP). */
  signInWithToken: (token: string) => Promise<void>;
  /** End the provider session if there is one, and discard the local session. */
  signOut: () => void;
  /** Usability helper; the backend re-checks every permission server-side. */
  has: (permission: Permission) => boolean;
}

const ANONYMOUS: AuthContextValue = {
  status: "anonymous",
  user: null,
  sessionExpired: false,
  anonymousReason: null,
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
  const external = useExternalSessionSnapshot();
  const [user, setUser] = useState<UserProfile | null>(initialUser ?? null);
  const [status, setStatus] = useState<AuthStatus>(
    initialUser === undefined ? "loading" : initialUser === null ? "anonymous" : "authenticated",
  );
  const [sessionExpired, setSessionExpired] = useState(false);
  const [anonymousReason, setAnonymousReason] = useState<string | null>(null);
  const [activeInstitution, setActiveInstitution] = useState<number | null>(
    initialUser ? defaultInstitution(initialUser) : null,
  );

  /* --------------------------- session bootstrap -------------------------- */

  useEffect(() => {
    if (initialUser !== undefined) {
      return;
    }
    if (external.state === "loading") {
      // A mounted provider has not resolved its session yet. Stay on the
      // loading screen instead of probing with a credential nobody issued.
      return;
    }
    let cancelled = false;

    /** Ask the server who we are, and record why if it refuses. */
    async function verify(credential: "external" | "stored"): Promise<void> {
      try {
        const profile = await fetchMe();
        if (cancelled) {
          return;
        }
        setUser(profile);
        setActiveInstitution(defaultInstitution(profile));
        setAnonymousReason(null);
        setStatus("authenticated");
      } catch (cause) {
        if (cancelled) {
          return;
        }
        if (cause instanceof ApiError && cause.status === 401 && credential === "stored") {
          // The stored token is no longer accepted: discard it. This is a
          // silent sign-out, not a "your session expired" event, because the
          // token was already dead on arrival (e.g. an old browser session).
          setAccessToken(null);
        }
        // Any other failure (backend unreachable, 503 auth not configured)
        // leaves the user signed out with the reason visible on the sign-in
        // screen; the token is kept so a retry can still succeed.
        setUser(null);
        setActiveInstitution(null);
        setStatus("anonymous");
        // An external session is the provider's, so the only honest way to
        // explain a refusal is the server's own words. In the local modes the
        // sign-in form already says what is wrong.
        setAnonymousReason(credential === "external" ? toErrorMessage(cause) : null);
      }
    }

    if (external.state === "signed-in") {
      void verify("external");
    } else if (external.state === "signed-out") {
      setUser(null);
      setActiveInstitution(null);
      setAnonymousReason(null);
      setStatus("anonymous");
    } else if (getAccessToken() === null) {
      setStatus("anonymous");
    } else {
      void verify("stored");
    }

    return () => {
      cancelled = true;
    };
  }, [initialUser, external]);

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
      setAnonymousReason(null);
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
    setAnonymousReason(null);
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
    setAnonymousReason(null);
    setStatus("authenticated");
  }, []);

  const signOut = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setActiveInstitution(null);
    setSessionExpired(false);
    setAnonymousReason(null);
    setStatus("anonymous");
    if (external.state === "signed-in") {
      // DataDiet holds no server-side session, but the provider holds a browser
      // one: without ending it, the next request would silently restore the same
      // identity. Its failure cannot undo the local sign-out.
      void external.session.signOut().catch(() => undefined);
    }
  }, [external]);

  const has = useCallback(
    (permission: Permission): boolean => user?.permissions.includes(permission) ?? false,
    [user],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      sessionExpired,
      anonymousReason,
      activeInstitutionId: activeInstitution,
      setActiveInstitution,
      signIn,
      signInWithToken,
      signOut,
      has,
    }),
    [
      status,
      user,
      sessionExpired,
      anonymousReason,
      activeInstitution,
      signIn,
      signInWithToken,
      signOut,
      has,
    ],
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
