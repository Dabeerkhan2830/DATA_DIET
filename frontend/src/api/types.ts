/**
 * Shared API types.
 *
 * These mirror the backend Pydantic schemas (backend/app/api/schemas). Keep them
 * in sync manually for now; code generation is a Phase 2 candidate.
 */

export type Sensitivity = "public" | "internal" | "confidential" | "restricted";
export type RiskBand = "low" | "moderate" | "high" | "critical";
export type RetentionAction = "retain" | "archive" | "review" | "eligible_for_disposal";
export type PolicyStatus = "active" | "draft" | "retired";

/** Marker attached to every synthetic payload served by the backend. */
export interface DemoMeta {
  classification: "synthetic_demo_data";
  notice: string;
  source: "in_process_fixture";
}

export interface DemoEnvelope<T> {
  meta: DemoMeta;
  data: T;
}

export interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
  environment: string;
}

export interface SensitivityBreakdown {
  public: number;
  internal: number;
  confidential: number;
  restricted: number;
}

export interface RiskBreakdown {
  low: number;
  moderate: number;
  high: number;
  critical: number;
}

export interface ActivityItem {
  event_id: string;
  event_type: string;
  description: string;
  actor: string;
  occurred_on: string;
}

export interface DashboardSummary {
  total_records: number;
  duplicate_candidates: number;
  pending_approvals: number;
  open_retrieval_requests: number;
  storage_bytes: number;
  by_sensitivity: SensitivityBreakdown;
  by_risk_band: RiskBreakdown;
  by_retention_action: Record<RetentionAction, number>;
  recent_activity: ActivityItem[];
}

export interface InventoryRecord {
  record_id: string;
  title: string;
  source_name: string;
  source_type: string;
  record_type: string;
  sensitivity: Sensitivity;
  contains_personal_data: boolean;
  duplicate_candidate: boolean;
  size_bytes: number;
  retention_action: RetentionAction;
  owner_team: string;
  last_reviewed: string | null;
}

/* ------------------------------------------------------------------------
 * Inventory: the real asset table (GET /api/v1/assets).
 * Mirrors backend/app/api/schemas/assets.py — `Asset` and `AssetListResponse`.
 * The synthetic `/demo/inventory` fixture above is a different, older shape.
 * ------------------------------------------------------------------------ */

/**
 * `Asset.sensitivity` widens the four-level scale with `unknown`, which is what
 * the backend stores for an unclassified asset (`Sensitivity` in
 * schemas/assets.py is a five-value Literal).
 */
export type AssetSensitivity = Sensitivity | "unknown";

/** `LifecycleStatus` Literal in backend/app/api/schemas/assets.py. */
export type LifecycleStatus = "active" | "under_review" | "archived" | "pending_disposal";

export interface Asset {
  id: number;
  institution_id: number | null;
  data_source_id: number;
  external_id: string;
  title: string;
  description: string | null;
  record_type: string;
  category: string | null;
  source_type: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number;
  checksum_sha256: string | null;
  sensitivity: AssetSensitivity;
  contains_personal_data: boolean;
  duplicate_of_id: number | null;
  owner_team: string | null;
  owner_email: string | null;
  lifecycle_status: LifecycleStatus;
  last_reviewed: string | null;
  source_created_at: string | null;
  source_modified_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The page of assets the server returned, with its own pagination metadata. */
export interface AssetListResponse {
  items: Asset[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

/**
 * Query parameters accepted by `GET /api/v1/assets`.
 *
 * There is deliberately no sort field: the route orders by `updated_at`
 * descending and exposes no ordering parameter.
 */
export interface AssetListQuery {
  page?: number;
  per_page?: number;
  search?: string;
  category?: string;
  sensitivity?: AssetSensitivity;
  source_type?: string;
  lifecycle_status?: LifecycleStatus;
  institution_id?: number;
}

export interface RiskIndicatorView {
  code: string;
  label: string;
  points: number;
  explanation: string;
}

export interface RiskRecordView {
  record_id: string;
  title: string;
  sensitivity: Sensitivity;
  score: number;
  band: RiskBand;
  indicators: RiskIndicatorView[];
}

export interface RiskRuleInfo {
  code: string;
  description: string;
  points: string;
}

export interface RiskAnalysisPage {
  rule_set: string;
  rules: RiskRuleInfo[];
  records: RiskRecordView[];
}

export interface RetentionPolicyView {
  policy_id: string;
  name: string;
  version: string;
  status: PolicyStatus;
  scope: string;
  retention_period_days: number;
  effective_from: string;
  applies_to_count: number;
  notes: string;
}

export interface HoldView {
  hold_id: string;
  name: string;
  scope: string;
  records_in_scope: number;
}

export interface ApprovalQueueItem {
  request_id: string;
  action: string;
  record_id: string;
  requested_by: string;
}

export interface RetentionPage {
  policies: RetentionPolicyView[];
  active_holds: HoldView[];
  approval_queue: ApprovalQueueItem[];
}

export interface SourceView {
  name: string;
  source_type: string;
  status: string;
}

/* ---------------------------------------------------------------------------
 * Phase 3: retention policies, holds, assessments, recommendations.
 * These mirror backend/app/api/schemas/retention.py.
 * ------------------------------------------------------------------------ */

export type Phase3PolicyStatus = "draft" | "approved" | "active" | "retired" | "inactive";
export type PolicyVersionStatus = "draft" | "approved" | "active" | "retired";
export type HoldStatus = "active" | "released";

export type RecommendationState =
  | "RETAIN"
  | "ARCHIVE_RECOMMENDED"
  | "REVIEW_REQUIRED"
  | "DISPOSAL_REVIEW_REQUIRED"
  | "BLOCKED_BY_HOLD"
  | "NO_APPLICABLE_POLICY";

export type FindingSeverity = "informational" | "low" | "medium" | "high" | "blocked";

export interface Policy {
  id: number;
  institution_id: number | null;
  name: string;
  description: string | null;
  applicable_categories: string[] | null;
  retention_trigger: string | null;
  retention_period_days: number | null;
  recommended_action: string | null;
  status: Phase3PolicyStatus;
  scope_description: string | null;
  current_version_id: number | null;
  version: string | null;
  created_by: string | null;
  created_at: string;
}

export interface PolicyVersion {
  id: number;
  policy_id: number;
  version_number: number;
  status: PolicyVersionStatus;
  description: string | null;
  applicable_categories: string[] | null;
  retention_period_days: number | null;
  retention_trigger: string | null;
  conditions: Record<string, unknown> | null;
  recommended_action: string | null;
  effective_from: string | null;
  effective_to: string | null;
  created_by: string | null;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
}

export interface Hold {
  id: number;
  institution_id: number | null;
  asset_id: number | null;
  asset_scope: Record<string, unknown> | null;
  name: string;
  hold_type: string | null;
  legal_basis: string | null;
  scope: Record<string, unknown>[] | null;
  status: HoldStatus;
  created_by: string | null;
  created_at: string;
  released_by: string | null;
  released_at: string | null;
  release_reason: string | null;
}

export interface AssessmentFinding {
  code: string;
  severity: FindingSeverity;
  message: string;
  evidence: Record<string, unknown> | null;
}

export interface Assessment {
  id?: number | null;
  asset_id: number;
  institution_id?: number | null;
  policy_id: number | null;
  policy_version_id: number | null;
  policy_version_number: number | null;
  rule_set: string;
  assessed_at: string;
  recommendation: RecommendationState;
  rationale: string;
  findings: AssessmentFinding[];
  holds_active: number;
  unresolved_conditions: string[];
  trigger_date?: string | null;
  retention_period_days?: number | null;
  retention_deadline?: string | null;
}

/**
 * Mirrors `RecommendationItem` (`backend/app/api/schemas/retention.py:256`).
 *
 * Every field is always serialized: an optional Pydantic field arrives as
 * `null`, never as `undefined`, so the fields the queue can genuinely leave
 * empty are `| null` rather than `?`. `id` is the assessment this row is the
 * latest of — `services/retention.py` returns `ra.id` — and is what a review
 * decision is recorded against.
 */
export interface RecommendationItem {
  id: number | null;
  asset_id: number;
  asset_title: string | null;
  institution_id: number | null;
  recommendation: RecommendationState;
  rationale: string;
  severity: FindingSeverity | null;
  policy_id: number | null;
  policy_version_id: number | null;
  policy_version_number: number | null;
  holds_active: number;
  assessed_at: string;
  findings: AssessmentFinding[] | null;
  retention_deadline: string | null;
  /** Days past `retention_deadline`; negative while the deadline is ahead. */
  days_overdue: number | null;
  decisions_recorded: number;
  review_status: ReviewStatus | null;
  latest_decision: DecisionValue | null;
}

export interface PaginatedRecommendations {
  items: RecommendationItem[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

/* ------------------------------------------------------------------------
 * Phase 5: classification and data quality (deterministic, metadata-only)
 * ------------------------------------------------------------------------ */

export type ClassificationOutcome =
  | "classified"
  | "partially_classified"
  | "unclassified";
export type ClassificationConfidence = "high" | "medium" | "low" | "none";
export type ProposedSensitivity =
  | "public"
  | "internal"
  | "confidential"
  | "restricted"
  | "unknown";
export type QualitySeverity = "info" | "low" | "medium" | "high";

export interface ClassificationEvidenceItem {
  rule_id: string;
  rule_version: string;
  field: string;
  observed?: string | null;
  proposed_category?: string | null;
  proposed_sensitivity?: string | null;
  note?: string | null;
}

export interface ClassificationConflictItem {
  field: string;
  values: string[];
  resolved_to: string;
  reason: string;
}

export interface ClassificationResult {
  id: number;
  asset_id: number;
  institution_id: number | null;
  rule_version: string;
  outcome: ClassificationOutcome;
  proposed_category: string | null;
  proposed_sensitivity: ProposedSensitivity;
  confidence: ClassificationConfidence;
  confidence_meaning: string;
  evidence: ClassificationEvidenceItem[];
  warnings: string[];
  conflicts: ClassificationConflictItem[];
  input_fingerprint: string;
  created_by: string;
  classified_at: string;
}

export interface ClassificationResultList {
  results: ClassificationResult[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface ClassificationRuleDescriptor {
  rule_id: string;
  field: string;
  effect: string;
  confidence: ClassificationConfidence;
  description: string;
}

export interface ClassificationRules {
  rule_version: string;
  rules: ClassificationRuleDescriptor[];
  confidence_meaning: Record<ClassificationConfidence, string>;
  outcomes: ClassificationOutcome[];
  sensitivities: ProposedSensitivity[];
  known_categories: string[];
  severities: QualitySeverity[];
}

export interface QualityFinding {
  asset_id: number;
  check: string;
  severity: QualitySeverity;
  message: string;
  fields: string[];
  evidence: Record<string, unknown>;
  remediation: string;
  duplicate_status?: string | null;
  related_asset_id?: number | null;
}

/** One entry of `GET /classification/checks`: a documented check and its intent. */
export interface QualityCheckDescriptor {
  check: string;
  severity: QualitySeverity;
  description: string;
  remediation: string;
}

export interface AssetQualityReport {
  asset_id: number;
  findings: QualityFinding[];
}

export interface PaginatedQualityFindings {
  findings: QualityFinding[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

/* ------------------------------------------------------------------------
 * Phase 6: unified review workflow and asset governance view.
 * Mirror backend/app/api/schemas/governance.py and the Phase 6 additions to
 * backend/app/api/schemas/retention.py.
 * ------------------------------------------------------------------------ */

/** A human review decision. Advisory only: it executes no file operation. */
export type DecisionValue =
  | "retain"
  | "request_more_information"
  | "approve_for_later_workflow"
  | "reject";

export type ReviewStatus = "open" | "decided";

export interface Decision {
  id: number;
  assessment_id: number;
  asset_id: number;
  institution_id: number | null;
  policy_id: number | null;
  policy_version_id: number | null;
  recommendation_reviewed: RecommendationState;
  decision: DecisionValue;
  reason: string;
  reviewer: string;
  decided_at: string;
  /** The earlier decision this one corrects. Null for an original decision. */
  supersedes_decision_id: number | null;
  /** True once a later decision superseded this one. Superseded rows stay. */
  is_superseded: boolean;
  /** The replacement decision, derived server-side from the supersede link. */
  superseded_by_decision_id: number | null;
}

export interface DecisionInput {
  decision: DecisionValue;
  reason: string;
  /** Optional correction: the earlier decision this one replaces. */
  supersedes_decision_id?: number | null;
  expected_assessed_at?: string | null;
  expected_policy_version_id?: number | null;
  expected_holds_active?: number | null;
}

export interface GovernanceSourceMapping {
  mapping_id: number;
  source_key: string;
  data_source_id: number;
  checksum_sha256: string | null;
  observation_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  source_modified_at: string | null;
}

export interface GovernanceScanSummary {
  scan_job_id: number;
  status: string;
  total_discovered: number;
  total_imported: number;
  total_skipped: number;
  total_errors: number;
  requested_by: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string | null;
  error_message: string | null;
}

export interface GovernanceSourceInfo {
  data_source_id: number;
  data_source_name: string | null;
  source_type: string | null;
  connector_type: string | null;
  institution_id: number | null;
  mapping_present: boolean;
  mappings: GovernanceSourceMapping[];
  latest_scan: GovernanceScanSummary | null;
  notes: string[];
}

export interface GovernancePolicyContext {
  policy_id: number;
  name: string;
  status: string;
  version_id: number | null;
  version_number: number | null;
  retention_period_days: number | null;
  retention_trigger: string | null;
  recommended_action: string | null;
  applicable_categories: string[] | null;
}

export interface GovernanceReviewContext {
  latest_assessment_id: number | null;
  expected_assessed_at: string | null;
  expected_policy_version_id: number | null;
  expected_holds_active: number | null;
  decisions_recorded: number;
}

export interface GovernanceProvenance {
  observed: string[];
  system_proposed: string[];
  assessed: string[];
  human_decisions: string[];
  file_operations: string;
}

/** Asset metadata as returned by the governance view (backend Asset schema). */
export interface GovernanceAsset {
  id: number;
  institution_id: number | null;
  data_source_id: number;
  external_id: string;
  title: string;
  description: string | null;
  record_type: string;
  category: string | null;
  source_type: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number;
  checksum_sha256: string | null;
  sensitivity: string;
  contains_personal_data: boolean;
  duplicate_of_id: number | null;
  owner_team: string | null;
  owner_email: string | null;
  lifecycle_status: string;
  last_reviewed: string | null;
  source_created_at: string | null;
  source_modified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GovernanceDetail {
  asset: GovernanceAsset;
  source: GovernanceSourceInfo;
  classification: ClassificationResult | null;
  quality_findings: QualityFinding[];
  applicable_policy: GovernancePolicyContext | null;
  latest_assessment: Assessment | null;
  assessment_history: Assessment[];
  active_holds: Hold[];
  decisions: Decision[];
  /** The decision currently governing this asset: the head of the supersession chain. */
  effective_decision_id: number | null;
  review_context: GovernanceReviewContext;
  provenance: GovernanceProvenance;
}

/* --------------------- sources & scan jobs (Phase 5.8) --------------------- */
// Mirrors backend/app/api/schemas/connectors.py. Every literal below is the
// server's own vocabulary: `ConnectorType` accepts exactly two values,
// `SourceStatus` two, `ScanStatus` six. No field carries a credential — the
// schema rejects secret-looking `config` keys at write time, and neither a
// request nor a response ever contains an absolute filesystem path.

/** `ConnectorType`: the only two source kinds the server can build. */
export type ConnectorType = "synthetic" | "local_folder";

/**
 * `SourceStatus`: whether the operator has enabled the record, nothing more.
 * The server sets `active` at creation without touching the source, so this is
 * not evidence of a live connection — see `Source.last_validation_ok`.
 */
export type SourceStatus = "active" | "inactive";

/** `ScanStatus`: the six values the scan service can store. */
export type ScanStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "COMPLETED_WITH_ERRORS"
  | "FAILED"
  | "CANCELLED";

/** `ScanResultRead.status`: how one discovered record fared in a scan. */
export type ScanResultStatus = "imported" | "skipped" | "error";

/** `ScanErrorRead.severity`: the server only ever writes these two. */
export type ScanErrorSeverity = "error" | "warning";

/** `Source`: one connected data source configuration record. */
export interface Source {
  id: number;
  institution_id: number | null;
  name: string;
  /** Nullable in the response; the list route excludes rows without one. */
  connector_type: string | null;
  /** An allow-list key configured by an operator, never a path. */
  root_key: string | null;
  config: Record<string, unknown> | null;
  status: string;
  created_by: string;
  /** Written only by `POST /sources/{id}/validate`; null means never validated. */
  last_validated_at: string | null;
  last_validation_ok: boolean | null;
  last_validation_message: string | null;
  created_at: string;
  updated_at: string;
}

/** `PaginatedSources` for `GET /sources`. */
export interface SourceListResponse {
  items: Source[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

/** `SourceValidationResult` for `POST /sources/{id}/validate`. */
export interface SourceValidationResult {
  id: number;
  ok: boolean;
  message: string;
  validated_at: string | null;
}

/** `ScanJobRead`: counters are absolute, and there is no percentage field. */
export interface ScanJob {
  id: number;
  data_source_id: number;
  institution_id: number | null;
  status: ScanStatus;
  batch_size: number;
  total_discovered: number;
  total_imported: number;
  total_skipped: number;
  total_errors: number;
  /** Set only on a job created by `POST /scan-jobs/{id}/retry`. */
  retried_from_job_id: number | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  created_at: string;
}

/** `PaginatedScanJobs` for `GET /scan-jobs`. */
export interface ScanJobListResponse {
  items: ScanJob[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

/** `ScanResultRead`: one per-record outcome row written by a scan. */
export interface ScanResult {
  id: number;
  scan_job_id: number;
  source_key: string;
  status: string;
  title: string;
  record_type: string;
  category: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number;
  sensitivity: string;
  contains_personal_data: boolean;
  imported_asset_id: number | null;
  note: string | null;
  error_message: string | null;
  created_at: string;
}

/** `PaginatedScanResults` for `GET /scan-jobs/{id}/results`. */
export interface ScanResultListResponse {
  items: ScanResult[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

/** `ScanErrorRead`: one error or truncation warning recorded by a scan. */
export interface ScanError {
  id: number;
  scan_job_id: number;
  source_key: string | null;
  /** Root-relative POSIX path when the connector could name one; never absolute. */
  path: string | null;
  error_message: string;
  severity: string;
  created_at: string;
}

/** `PaginatedScanErrors` for `GET /scan-jobs/{id}/errors`. */
export interface ScanErrorListResponse {
  items: ScanError[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

/* ------------------------- authentication (Phase 7) ------------------------ */
// Mirrors backend/app/api/schemas/auth.py (ADR-0014). Authorization is always
// derived server-side from the local user directory; the permissions below are
// the verified result of GET /auth/me, never a client-side claim.

export type RoleValue = "viewer" | "reviewer" | "admin";

/** Verified permission strings returned by the server for the signed-in user. */
export type Permission =
  | "inventory:read"
  | "governance:read"
  | "retention:read"
  | "sources:read"
  | "retention:assess"
  | "review:decide"
  | "retention:write"
  | "sources:write"
  | "assets:write"
  | "classification:write"
  | "users:manage";

/** Public: what kind of authentication this deployment actually has. */
export interface AuthConfig {
  environment: string;
  /**
   * - `development` — local dev sign-in is available (never in production).
   * - `clerk` — session tokens come from Clerk and are verified here with
   *   RS256; sign-in happens at Clerk, so this API exposes no sign-in form.
   * - `bearer_boundary` — tokens are verified, but no identity provider or
   *   browser sign-in is configured.
   * - `unconfigured` — protected endpoints return 503 until an operator
   *   configures the signing secret.
   */
  authentication: "development" | "clerk" | "bearer_boundary" | "unconfigured";
  dev_login_enabled: boolean;
  /** Which identity provider the server trusts: `clerk`, `local`, or none. */
  identity_provider: "clerk" | "local" | "none";
  issuer: string;
  audience: string;
  token_ttl_seconds: number;
  description: string;
}

/** GET /auth/me: the verified identity behind the current bearer token. */
export interface UserProfile {
  id: number;
  email: string;
  display_name: string;
  role: RoleValue | null;
  is_platform_admin: boolean;
  /** Institution memberships; the backend resolves scope from this directory. */
  institutions: number[];
  permissions: Permission[];
}

export interface TokenResponse {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
}

/** Development/test sign-in body. Refused by the server in production. */
export interface DevLoginRequest {
  email: string;
  display_name?: string;
  institution_id?: number;
  role?: RoleValue;
  platform_admin?: boolean;
}
