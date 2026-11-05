/**
 * Typed client for the Phase 6 unified asset governance view.
 *
 * Read-only aggregation of inventory, source/scan, classification, data
 * quality, retention policy/version, assessment, holds, and review decisions
 * for one authorized asset. No endpoint here executes a file operation.
 */

import { apiGet } from "./client";
import type { GovernanceDetail } from "./types";

export const GOVERNANCE_PREFIX = "/api/v1/governance";

/** The unified governance view for one asset. */
export function fetchAssetGovernance(
  assetId: number,
  institutionId?: number,
): Promise<GovernanceDetail> {
  const query = new URLSearchParams();
  if (institutionId !== undefined) {
    query.set("institution_id", String(institutionId));
  }
  const qs = query.toString();
  return apiGet<GovernanceDetail>(
    `${GOVERNANCE_PREFIX}/assets/${assetId}${qs ? `?${qs}` : ""}`,
  );
}
