/**
 * Clerk's supported React integration, mounted around the signed-in
 * application (Phase 6.0, ADR-0025).
 *
 * What this file owns, and what it deliberately does not:
 *
 * * It reads the *publishable* key (`VITE_CLERK_PUBLISHABLE_KEY`). A publishable
 *   key is a browser value by design. The Clerk *secret* key stays on the server
 *   and is not used by this API at all, so nothing here can leak a credential
 *   into the bundle.
 * * It publishes the Clerk session to `externalSession`, which is the only place
 *   DataDiet learns that an external provider exists. Pages and the API client
 *   never import Clerk, so no component can accidentally treat Clerk's UI as an
 *   authorization boundary.
 * * It resolves a Clerk session token *per request* through that seam. Clerk
 *   mints short-lived tokens and refreshes them itself; storing a copy in
 *   DataDiet's own token storage would create a second, staler credential, so we
 *   do not — and a Clerk deployment also discards any development token left
 *   behind in this browser.
 * * It renders Clerk's own sign-in form, which is the supported sign-in flow.
 *   Sign-out goes through `clerk.signOut()`, also supported, and never a
 *   hand-rolled redirect.
 *
 * Nothing here authorizes anything: `GET /auth/me` and the backend's permission
 * checks decide what a session token may do.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ClerkProvider,
  SignIn as ClerkSignIn,
  // `useAuth` is Clerk's hook; DataDiet's own `useAuth` lives in AuthContext,
  // so this one is aliased at the only place the two could be confused.
  useAuth as useClerkAuth,
} from "@clerk/clerk-react";
import { ApiError } from "../api/client";
import { setAccessToken } from "../api/tokenStore";
import { Spinner } from "../components/ui/Spinner";
import { setExternalSessionSnapshot } from "./externalSession";
import type { ExternalSession } from "./externalSession";

/** The Clerk application this frontend build was compiled against. */
export function clerkPublishableKey(): string {
  return (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? "").trim();
}

/** Whether browser-side Clerk sign-in is available in this build at all. */
export function isClerkEnabled(): boolean {
  return clerkPublishableKey().length > 0;
}

/**
 * Keeps `externalSession` in step with Clerk's own session lifecycle, and only
 * lets the application mount once that state is known — so no request can be
 * made with a stale development credential while Clerk is still deciding.
 */
function ClerkSessionSync({ children }: { children: ReactNode }) {
  const auth = useClerkAuth();
  // Clerk's hook returns a fresh object on render, so the effect below is keyed
  // on the two booleans and reads the current callbacks through a ref: a
  // published session never goes stale, and re-renders never republish it.
  const authRef = useRef(auth);
  authRef.current = auth;

  const { isLoaded, isSignedIn } = auth;
  const [published, setPublished] = useState(false);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }
    // A Clerk deployment never signs in through DataDiet's own token store.
    setAccessToken(null);
    if (!isSignedIn) {
      setExternalSessionSnapshot({ state: "signed-out" });
      setPublished(true);
      return;
    }
    const session: ExternalSession = {
      getToken: async () => {
        try {
          return (await authRef.current.getToken()) ?? null;
        } catch (cause) {
          // Clerk could not produce a token, so this request cannot be
          // credentialed. Say so instead of sending an anonymous call that the
          // server would refuse for the wrong reason.
          throw new ApiError(
            `identity_provider_unavailable: Clerk could not provide a session token ` +
              `for this request. Sign in again. (${String(cause)})`,
            0,
          );
        }
      },
      signOut: async () => {
        await authRef.current.signOut();
      },
    };
    setExternalSessionSnapshot({ state: "signed-in", session });
    setPublished(true);
  }, [isLoaded, isSignedIn]);

  useEffect(
    () => () => {
      setExternalSessionSnapshot({ state: "idle" });
      setPublished(false);
    },
    [],
  );

  if (!isLoaded || !published) {
    return (
      <div className="flex min-h-full items-center justify-center bg-canvas">
        <Spinner label="Connecting to the identity provider..." />
      </div>
    );
  }

  return <>{children}</>;
}

/**
 * Mount Clerk over the application. Rendered only when a publishable key was
 * baked into this build, so a development checkout keeps its own sign-in.
 */
export function ClerkBoundary({ children }: { children: ReactNode }) {
  const publishableKey = clerkPublishableKey();
  if (publishableKey.length === 0) {
    // Defensive: the caller decides on `isClerkEnabled()`. Mounting Clerk with
    // no key would fail inside the provider, not here, with a message about a
    // key that the operator was never told to set.
    throw new Error(
      "ClerkBoundary was mounted without VITE_CLERK_PUBLISHABLE_KEY set.",
    );
  }
  return (
    <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/signin">
      <ClerkSessionSync>{children}</ClerkSessionSync>
    </ClerkProvider>
  );
}

/**
 * Clerk's own sign-in form — the supported flow. DataDiet renders no sign-in
 * fields of its own here and stores nothing: credentials are Clerk's business,
 * and what the verified identity may do is DataDiet's.
 *
 * `withSignUp={false}` because access is granted by an operator: a self-service
 * sign-up would create identities this platform then has to refuse anyway.
 */
export function ClerkSignInForm() {
  return (
    <ClerkSignIn
      routing="path"
      path="/signin"
      signUpUrl="/signin"
      withSignUp={false}
      fallbackRedirectUrl="/"
    />
  );
}
