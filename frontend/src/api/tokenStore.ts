/**
 * Access-token storage shared by the API client and the auth context (Phase 7).
 *
 * The token is the client's copy of a *stateless* bearer credential
 * (ADR-0014): there is no session cookie, so sign-out is simply discarding it
 * here — the server holds no session to invalidate. It is kept in
 * localStorage so a page reload keeps the user signed in; the token is the
 * user's own credential in their own browser, not a server secret, and every
 * protected endpoint still verifies it server-side.
 *
 * No token is ever written to the console, embedded in the bundle, or sent
 * anywhere except the Authorization header of the DataDiet API itself.
 */

const STORAGE_KEY = "datadiet.access_token";

type UnauthorizedListener = () => void;

const unauthorizedListeners = new Set<UnauthorizedListener>();

function readStoredToken(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, blocked storage): the token then
    // survives only for this page load, which is still safe — just less
    // convenient.
    return null;
  }
}

let token: string | null = readStoredToken();

/** The current bearer token, or null when signed out. */
export function getAccessToken(): string | null {
  return token;
}

/** Store (or clear) the token and persist it when storage is available. */
export function setAccessToken(next: string | null): void {
  token = next;
  try {
    if (next === null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, next);
    }
  } catch {
    // Persistence is best-effort; the in-memory token still works for this
    // page load.
  }
}

/**
 * Subscribe to "the server no longer accepts our token" notifications.
 * Returns an unsubscribe function.
 */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

/** Notify subscribers that a request was answered with 401. */
export function notifyUnauthorized(): void {
  for (const listener of [...unauthorizedListeners]) {
    listener();
  }
}
