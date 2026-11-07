/**
 * The seam between an external identity provider and DataDiet's auth layer
 * (Phase 6.0, ADR-0025).
 *
 * Clerk's SDK owns the browser session: it authenticates the user, holds the
 * session, and mints short-lived RS256 session tokens. DataDiet's API client
 * needs one of those tokens per request and the auth context needs to know when
 * the external session appears or disappears — nothing more. This module is the
 * only place those two facts are exchanged, so no page or component imports the
 * provider SDK and no token is ever copied into DataDiet's own storage.
 *
 * The snapshot deliberately has four states. `idle` means no external provider
 * is mounted at all, so the classic stored-token path (development sign-in or a
 * pasted bearer token) applies. The other three are the provider's own lifecycle
 * and always take precedence: while a provider is mounted, a locally stored
 * token is never consulted, so a stale development credential cannot masquerade
 * as a staging session.
 */

import { useEffect, useState } from "react";
import { setAccessTokenProvider } from "../api/client";

/** What the mounted provider can do for us. */
export interface ExternalSession {
  /** A current session token for one request, or null when there is none. */
  getToken: () => Promise<string | null>;
  /** End the provider's browser session (Clerk sign-out). */
  signOut: () => Promise<void>;
}

export type ExternalSessionSnapshot =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "signed-in"; readonly session: ExternalSession }
  | { readonly state: "signed-out" };

const IDLE: ExternalSessionSnapshot = { state: "idle" };

let snapshot: ExternalSessionSnapshot = IDLE;

const listeners = new Set<() => void>();

/** The current provider lifecycle state. */
export function getExternalSessionSnapshot(): ExternalSessionSnapshot {
  return snapshot;
}

/**
 * Move the provider to a new state and keep the API client's token source in
 * step, so no request can be sent with a token from the wrong provider.
 */
export function setExternalSessionSnapshot(next: ExternalSessionSnapshot): void {
  snapshot = next;
  setAccessTokenProvider(
    next.state === "signed-in" ? () => next.session.getToken() : null,
  );
  for (const listener of [...listeners]) {
    listener();
  }
}

/** Subscribe to provider transitions; returns the unsubscribe function. */
export function onExternalSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The active session, or null. Used by sign-out, which has to end the provider's
 * session as well as DataDiet's local view of it.
 */
export function getExternalSession(): ExternalSession | null {
  return snapshot.state === "signed-in" ? snapshot.session : null;
}

/** Subscribe this component to provider transitions. */
export function useExternalSessionSnapshot(): ExternalSessionSnapshot {
  const [current, setCurrent] = useState<ExternalSessionSnapshot>(getExternalSessionSnapshot);

  useEffect(
    () => onExternalSessionChange(() => setCurrent(getExternalSessionSnapshot())),
    [],
  );

  return current;
}
