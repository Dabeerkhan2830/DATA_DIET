/**
 * Endpoints for the clearly-labeled synthetic demo data.
 *
 * The backend marks every payload with `meta.classification =
 * "synthetic_demo_data"`; the UI displays that notice so nobody mistakes the
 * sample content for real institutional records.
 */

import { apiGet } from "./client";
import type {
  DashboardSummary,
  DemoEnvelope,
  HealthResponse,
  InventoryRecord,
  RetentionPage,
  RiskAnalysisPage,
  SourceView,
} from "./types";

export const API_PREFIX = "/api/v1";

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return apiGet<HealthResponse>(`${API_PREFIX}/health`, signal);
}

export function fetchDashboard(signal?: AbortSignal): Promise<DemoEnvelope<DashboardSummary>> {
  return apiGet<DemoEnvelope<DashboardSummary>>(`${API_PREFIX}/demo/dashboard`, signal);
}

export function fetchInventory(signal?: AbortSignal): Promise<DemoEnvelope<InventoryRecord[]>> {
  return apiGet<DemoEnvelope<InventoryRecord[]>>(`${API_PREFIX}/demo/inventory`, signal);
}

export function fetchRiskAnalysis(signal?: AbortSignal): Promise<DemoEnvelope<RiskAnalysisPage>> {
  return apiGet<DemoEnvelope<RiskAnalysisPage>>(`${API_PREFIX}/demo/risk`, signal);
}

export function fetchRetention(): Promise<DemoEnvelope<RetentionPage>> {
  return apiGet<DemoEnvelope<RetentionPage>>(`${API_PREFIX}/demo/retention`);
}

export function fetchConnectedSources(): Promise<DemoEnvelope<SourceView[]>> {
  return apiGet<DemoEnvelope<SourceView[]>>(`${API_PREFIX}/demo/connected-sources`);
}
