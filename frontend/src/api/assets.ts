/**
 * Typed client for the real asset inventory (`GET /api/v1/assets`).
 *
 * Read-only: the route it calls is the list endpoint, and the backend requires
 * the server-verified `inventory:read` permission for it. Creating or updating
 * an asset is a separate, write-permission endpoint that no screen here calls,
 * and no operation archives, restores or deletes anything.
 */

import { apiGet } from "./client";
import type { AssetListQuery, AssetListResponse } from "./types";

export const ASSETS_PREFIX = "/api/v1/assets";

/**
 * One page of assets, filtered and paginated server-side.
 *
 * Empty filter strings are omitted rather than sent as `?category=`, because the
 * backend treats a blank as "no filter" and an explicit query string is what the
 * server logs, tests and caches see.
 */
export function listAssets(
  query: AssetListQuery = {},
  signal?: AbortSignal,
): Promise<AssetListResponse> {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.per_page !== undefined) params.set("per_page", String(query.per_page));
  if (query.search) params.set("search", query.search);
  if (query.category) params.set("category", query.category);
  if (query.sensitivity) params.set("sensitivity", query.sensitivity);
  if (query.source_type) params.set("source_type", query.source_type);
  if (query.lifecycle_status) params.set("lifecycle_status", query.lifecycle_status);
  if (query.institution_id !== undefined) {
    params.set("institution_id", String(query.institution_id));
  }
  const qs = params.toString();
  return apiGet<AssetListResponse>(`${ASSETS_PREFIX}${qs ? `?${qs}` : ""}`, signal);
}
