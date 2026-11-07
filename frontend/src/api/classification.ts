/**
 * Typed client for the Phase 5 classification and data-quality API.
 *
 * Advisory only: a classification is a deterministic, explainable proposal over
 * inventoried metadata. Nothing here reads file contents, mutates an asset's
 * category/sensitivity, or triggers a retention or lifecycle action.
 *
 * Contracts verified against `backend/app/api/routes/classification.py`:
 * - `GET /rules`, `GET /checks`, `GET /assets/{id}/latest`, `.../history` and
 *   `.../quality` are reads and require the server-verified `governance:read`.
 * - `POST /assets/{id}` requires `classification:write` and answers 201 with the
 *   stored row; the route is idempotent, so an unchanged asset returns the row it
 *   already has rather than a new one.
 * - The four asset endpoints accept the optional `institution_id` query
 *   parameter (`404 asset_out_of_scope` when it does not own the asset). `GET
 *   /rules` and `GET /checks` are global catalogues and take no scope.
 * - `POST` deliberately takes no `AbortSignal`: an accepted run is a server-side
 *   write, and dropping the client's view of it would not reverse it.
 */

import { apiGet, apiPost } from "./client";
import type {
  AssetQualityReport,
  ClassificationResult,
  ClassificationResultList,
  ClassificationRules,
  PaginatedQualityFindings,
  QualityCheckDescriptor,
} from "./types";

export const CLASSIFICATION_PREFIX = "/api/v1/classification";

/**
 * The institution scope the signed-in account is working in. Omitted for a
 * platform administrator browsing all institutions, sent verbatim otherwise.
 */
export interface ClassificationScope {
  institutionId?: number;
}

function scopeParams(scope?: ClassificationScope): URLSearchParams {
  const params = new URLSearchParams();
  if (scope?.institutionId !== undefined) {
    params.set("institution_id", String(scope.institutionId));
  }
  return params;
}

function withQuery(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** The documented rule table and its version, served by the backend. */
export function fetchClassificationRules(
  signal?: AbortSignal,
): Promise<ClassificationRules> {
  return apiGet<ClassificationRules>(`${CLASSIFICATION_PREFIX}/rules`, signal);
}

/** The documented data-quality check catalogue and what each check looks at. */
export function fetchQualityChecks(signal?: AbortSignal): Promise<QualityCheckDescriptor[]> {
  return apiGet<QualityCheckDescriptor[]>(`${CLASSIFICATION_PREFIX}/checks`, signal);
}

/**
 * Runs classification for one asset and returns the stored result.
 *
 * Explicit user action only — no screen calls this on mount, and a re-run with
 * unchanged metadata reuses the stored row instead of adding one.
 */
export function runClassification(
  assetId: number,
  scope?: ClassificationScope,
): Promise<ClassificationResult> {
  return apiPost<ClassificationResult>(
    withQuery(`${CLASSIFICATION_PREFIX}/assets/${assetId}`, scopeParams(scope)),
  );
}

/** The most recent classification result for an asset (404 `no_classification` if never run). */
export function fetchLatestClassification(
  assetId: number,
  signal?: AbortSignal,
  scope?: ClassificationScope,
): Promise<ClassificationResult> {
  return apiGet<ClassificationResult>(
    withQuery(`${CLASSIFICATION_PREFIX}/assets/${assetId}/latest`, scopeParams(scope)),
    signal,
  );
}

/** Paginated, newest-first classification history for an asset. */
export function fetchClassificationHistory(
  assetId: number,
  params?: { page?: number; per_page?: number },
  signal?: AbortSignal,
  scope?: ClassificationScope,
): Promise<ClassificationResultList> {
  const query = scopeParams(scope);
  if (params?.page !== undefined) query.set("page", String(params.page));
  if (params?.per_page !== undefined) query.set("per_page", String(params.per_page));
  return apiGet<ClassificationResultList>(
    withQuery(`${CLASSIFICATION_PREFIX}/assets/${assetId}/history`, query),
    signal,
  );
}

/** Data-quality findings computed for one asset on demand. */
export function fetchAssetQuality(
  assetId: number,
  signal?: AbortSignal,
  scope?: ClassificationScope,
): Promise<AssetQualityReport> {
  return apiGet<AssetQualityReport>(
    withQuery(`${CLASSIFICATION_PREFIX}/assets/${assetId}/quality`, scopeParams(scope)),
    signal,
  );
}

/** Paginated quality findings across an institution scope, with filters. */
export function fetchQualityFindings(params?: {
  page?: number;
  per_page?: number;
  severity?: string;
  check?: string;
  institution_id?: number;
}): Promise<PaginatedQualityFindings> {
  const query = new URLSearchParams();
  if (params?.page !== undefined) query.set("page", String(params.page));
  if (params?.per_page !== undefined) query.set("per_page", String(params.per_page));
  if (params?.severity) query.set("severity", params.severity);
  if (params?.check) query.set("check", params.check);
  if (params?.institution_id !== undefined) {
    query.set("institution_id", String(params.institution_id));
  }
  const qs = query.toString();
  return apiGet<PaginatedQualityFindings>(
    `${CLASSIFICATION_PREFIX}/quality/findings${qs ? `?${qs}` : ""}`,
  );
}
