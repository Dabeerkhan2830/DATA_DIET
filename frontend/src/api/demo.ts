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

export function fetchHealth(): Promise<HealthResponse> {
  return apiGet<HealthResponse>(`${API_PREFIX}/health`);
}

export function fetchDashboard(): Promise<DemoEnvelope<DashboardSummary>> {
  return apiGet<DemoEnvelope<DashboardSummary>>(`${API_PREFIX}/demo/dashboard`);
}

export function fetchInventory(): Promise<DemoEnvelope<InventoryRecord[]>> {
  return apiGet<DemoEnvelope<InventoryRecord[]>>(`${API_PREFIX}/demo/inventory`);
}

export function fetchRiskAnalysis(): Promise<DemoEnvelope<RiskAnalysisPage>> {
  return apiGet<DemoEnvelope<RiskAnalysisPage>>(`${API_PREFIX}/demo/risk`);
}

export function fetchRetention(): Promise<DemoEnvelope<RetentionPage>> {
  return apiGet<DemoEnvelope<RetentionPage>>(`${API_PREFIX}/demo/retention`);
}

export function fetchConnectedSources(): Promise<DemoEnvelope<SourceView[]>> {
  return apiGet<DemoEnvelope<SourceView[]>>(`${API_PREFIX}/demo/connected-sources`);
}
