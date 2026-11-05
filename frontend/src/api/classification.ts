/**
 * Typed client for the Phase 5 classification and data-quality API.
 *
 * Advisory only: a classification is a deterministic, explainable proposal over
 * inventoried metadata. Nothing here reads file contents, mutates an asset's
 * category/sensitivity, or triggers a retention or lifecycle action.
 */

import { apiGet, apiPost } from "./client";
import type {
  AssetQualityReport,
  ClassificationResult,
  ClassificationResultList,
  ClassificationRules,
  PaginatedQualityFindings,
} from "./types";

export const CLASSIFICATION_PREFIX = "/api/v1/classification";

/** The documented rule table and its version, served by the backend. */
export function fetchClassificationRules(): Promise<ClassificationRules> {
  return apiGet<ClassificationRules>(`${CLASSIFICATION_PREFIX}/rules`);
}

/** Runs classification for one asset and returns the stored result. */
export function runClassification(assetId: number): Promise<ClassificationResult> {
  return apiPost<ClassificationResult>(`${CLASSIFICATION_PREFIX}/assets/${assetId}`);
}

/** The most recent classification result for an asset (404 if never run). */
export function fetchLatestClassification(assetId: number): Promise<ClassificationResult> {
  return apiGet<ClassificationResult>(`${CLASSIFICATION_PREFIX}/assets/${assetId}/latest`);
}

/** Paginated, newest-first classification history for an asset. */
export function fetchClassificationHistory(
  assetId: number,
  params?: { page?: number; per_page?: number },
): Promise<ClassificationResultList> {
  const query = new URLSearchParams();
  if (params?.page !== undefined) query.set("page", String(params.page));
  if (params?.per_page !== undefined) query.set("per_page", String(params.per_page));
  const qs = query.toString();
  return apiGet<ClassificationResultList>(
    `${CLASSIFICATION_PREFIX}/assets/${assetId}/history${qs ? `?${qs}` : ""}`,
  );
}

/** Data-quality findings computed for one asset on demand. */
export function fetchAssetQuality(assetId: number): Promise<AssetQualityReport> {
  return apiGet<AssetQualityReport>(`${CLASSIFICATION_PREFIX}/assets/${assetId}/quality`);
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
