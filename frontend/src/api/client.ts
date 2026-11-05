/**
 * Minimal typed fetch client.
 *
 * The backend base URL comes from VITE_API_BASE_URL (see .env.example). When it
 * is unset the client uses relative URLs, which the Vite dev server proxies to
 * http://localhost:8000 — so no CORS configuration is needed in development.
 *
 * When a bearer token is present (see tokenStore), every request carries it as
 * an Authorization header. A 401 answer notifies the auth layer so the UI can
 * move the user to sign-in instead of silently showing empty screens. Server
 * secrets are never placed in the frontend; the token stored here is the
 * user's own credential.
 */

import { getAccessToken, notifyUnauthorized } from "./tokenStore";

const BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** JSON headers plus the Authorization header when a token is stored. */
function requestHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json", ...extra };
  const token = getAccessToken();
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

interface PydanticFieldError {
  loc?: unknown;
  msg?: unknown;
}

/**
 * Reads a human-readable message out of an error response.
 *
 * FastAPI returns `detail` as a string for deliberate HTTPException details
 * (including this app's stable machine-readable prefixes) and as a list of
 * Pydantic field errors for 422 validation failures — both are rendered here.
 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "detail" in body) {
      const detail = (body as { detail: unknown }).detail;
      if (typeof detail === "string") {
        return detail;
      }
      if (Array.isArray(detail)) {
        const parts = detail
          .filter((item): item is PydanticFieldError => Boolean(item) && typeof item === "object")
          .map((item) => {
            const where = Array.isArray(item.loc)
              ? item.loc
                  .map((segment) => String(segment))
                  .join(".")
                  .replace(/^(body|query|path)\./, "")
              : "";
            const message = typeof item.msg === "string" ? item.msg : "invalid value";
            return where ? `${where}: ${message}` : message;
          });
        if (parts.length > 0) {
          return parts.join("; ");
        }
      }
    }
  } catch {
    // Non-JSON error body — fall through to the status text.
  }
  return response.statusText || `Request failed with status ${response.status}`;
}

/** Turns a failed response into an ApiError, notifying auth on 401. */
async function throwResponseError(response: Response): Promise<never> {
  if (response.status === 401) {
    notifyUnauthorized();
  }
  throw new ApiError(await readErrorMessage(response), response.status);
}

export async function apiGet<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: "GET",
      headers: requestHeaders(),
    });
  } catch (cause) {
    throw new ApiError(
      `Could not reach the DataDiet API at ${
        BASE_URL || "(dev proxy: /api)"
      }. Is the backend running? (${String(cause)})`,
      0,
    );
  }

  if (!response.ok) {
    await throwResponseError(response);
  }

  return (await response.json()) as T;
}

async function requestJson<T>(method: "POST" | "PATCH", path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: requestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new ApiError(
      `Could not reach the DataDiet API at ${
        BASE_URL || "(dev proxy: /api)"
      }. Is the backend running? (${String(cause)})`,
      0,
    );
  }

  if (!response.ok) {
    await throwResponseError(response);
  }

  return (await response.json()) as T;
}

/** Sends a JSON POST request and returns the parsed response. */
export async function apiPost<T>(path: string, body: unknown = {}): Promise<T> {
  return requestJson<T>("POST", path, body);
}

/** Sends a JSON PATCH request and returns the parsed response. */
export async function apiPatch<T>(path: string, body: unknown = {}): Promise<T> {
  return requestJson<T>("PATCH", path, body);
}

/** Turns any thrown value into a display-ready message. */
export function toErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "An unexpected error occurred.";
}
