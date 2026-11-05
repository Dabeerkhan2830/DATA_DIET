/**
 * Typed client for the Phase 3 retention API (policies, holds, assessments,
 * recommendations). Advisory only: nothing here executes archive or deletion.
 */

import { apiGet, apiPatch, apiPost } from "./client";
import type {
  Assessment,
  Decision,
  DecisionInput,
  Hold,
  PaginatedRecommendations,
  Policy,
  PolicyVersion,
} from "./types";

export const RETENTION_PREFIX = "/api/v1/retention";

/* ------------------------------- policies -------------------------------- */

export function listPolicies(params?: {
  status?: string;
  institution_id?: number;
}): Promise<Policy[]> {
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  if (params?.institution_id !== undefined) {
    query.set("institution_id", String(params.institution_id));
  }
  const qs = query.toString();
  return apiGet<Policy[]>(`${RETENTION_PREFIX}/policies${qs ? `?${qs}` : ""}`);
}

export function getPolicy(policyId: number): Promise<Policy> {
  return apiGet<Policy>(`${RETENTION_PREFIX}/policies/${policyId}`);
}

export interface PolicyCreateInput {
  name: string;
  description?: string;
  applicable_categories?: string[];
  retention_period_days?: number;
  retention_trigger?: string;
  recommended_action?: string;
  scope_description?: string;
  institution_id?: number;
}

export function createPolicy(input: PolicyCreateInput): Promise<Policy> {
  return apiPost<Policy>(`${RETENTION_PREFIX}/policies`, input);
}

export interface PolicyUpdateInput {
  description?: string;
  applicable_categories?: string[];
  retention_period_days?: number;
  retention_trigger?: string;
  recommended_action?: string;
  scope_description?: string;
}

export function updatePolicy(policyId: number, input: PolicyUpdateInput): Promise<Policy> {
  return apiPatch<Policy>(`${RETENTION_PREFIX}/policies/${policyId}`, input);
}

export interface PolicyVersionInput {
  description?: string;
  applicable_categories?: string[];
  retention_period_days?: number;
  retention_trigger?: string;
  recommended_action?: string;
}

export function createPolicyVersion(
  policyId: number,
  input: PolicyVersionInput = {},
): Promise<PolicyVersion> {
  return apiPost<PolicyVersion>(`${RETENTION_PREFIX}/policies/${policyId}/versions`, input);
}

export function activatePolicyVersion(
  policyId: number,
  versionId: number,
): Promise<Policy> {
  return apiPost<Policy>(`${RETENTION_PREFIX}/policies/${policyId}/activate`, {
    version_id: versionId,
  });
}

/* --------------------------------- holds --------------------------------- */

export function listHolds(params?: {
  status?: string;
  institution_id?: number;
}): Promise<Hold[]> {
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  if (params?.institution_id !== undefined) {
    query.set("institution_id", String(params.institution_id));
  }
  const qs = query.toString();
  return apiGet<Hold[]>(`${RETENTION_PREFIX}/holds${qs ? `?${qs}` : ""}`);
}

export interface HoldCreateInput {
  name: string;
  asset_id?: number;
  hold_type?: string;
  legal_basis?: string;
  institution_id?: number;
}

export function createHold(input: HoldCreateInput): Promise<Hold> {
  return apiPost<Hold>(`${RETENTION_PREFIX}/holds`, input);
}

export function releaseHold(holdId: number, reason?: string): Promise<Hold> {
  return apiPatch<Hold>(`${RETENTION_PREFIX}/holds/${holdId}/release`, {
    release_reason: reason,
  });
}

/* ------------------------- assessments and queue -------------------------- */

export function assessAsset(assetId: number): Promise<Assessment> {
  return apiPost<Assessment>(`${RETENTION_PREFIX}/assess/${assetId}`);
}

export function getAssessmentHistory(assetId: number): Promise<Assessment[]> {
  return apiGet<Assessment[]>(`${RETENTION_PREFIX}/assessments/${assetId}/history`);
}

export function listRecommendations(params?: {
  page?: number;
  per_page?: number;
  institution_id?: number;
  review_status?: string;
  recommendation?: string;
  severity?: string;
  sort?: string;
  search?: string;
}): Promise<PaginatedRecommendations> {
  const query = new URLSearchParams();
  if (params?.page !== undefined) query.set("page", String(params.page));
  if (params?.per_page !== undefined) query.set("per_page", String(params.per_page));
  if (params?.institution_id !== undefined) {
    query.set("institution_id", String(params.institution_id));
  }
  if (params?.review_status) query.set("review_status", params.review_status);
  if (params?.recommendation) query.set("recommendation", params.recommendation);
  if (params?.severity) query.set("severity", params.severity);
  if (params?.sort) query.set("sort", params.sort);
  if (params?.search) query.set("search", params.search);
  const qs = query.toString();
  return apiGet<PaginatedRecommendations>(
    `${RETENTION_PREFIX}/recommendations${qs ? `?${qs}` : ""}`,
  );
}

/* ------------------------- review decisions ------------------------------- */

export function listAssetDecisions(
  assetId: number,
  institutionId?: number,
): Promise<Decision[]> {
  const query = new URLSearchParams();
  if (institutionId !== undefined) query.set("institution_id", String(institutionId));
  const qs = query.toString();
  return apiGet<Decision[]>(
    `${RETENTION_PREFIX}/assets/${assetId}/decisions${qs ? `?${qs}` : ""}`,
  );
}

export function listAssessmentDecisions(assessmentId: number): Promise<Decision[]> {
  return apiGet<Decision[]>(`${RETENTION_PREFIX}/assessments/${assessmentId}/decisions`);
}

/**
 * The earlier decisions a new decision on this assessment may supersede.
 *
 * Server-computed so the review form offers only real, already-authorized
 * choices instead of letting the client invent a correction target.
 */
export function listSupersessionCandidates(assessmentId: number): Promise<Decision[]> {
  return apiGet<Decision[]>(
    `${RETENTION_PREFIX}/decisions/supersession/source?assessment_id=${assessmentId}`,
  );
}

export function createDecision(
  assessmentId: number,
  input: DecisionInput,
  institutionId?: number,
): Promise<Decision> {
  const query = new URLSearchParams();
  if (institutionId !== undefined) query.set("institution_id", String(institutionId));
  const qs = query.toString();
  return apiPost<Decision>(
    `${RETENTION_PREFIX}/assessments/${assessmentId}/decisions${qs ? `?${qs}` : ""}`,
    input,
  );
}
