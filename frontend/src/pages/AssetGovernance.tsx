/**
 * Unified asset governance view (Phase 6).
 *
 * One screen combining, for a single authorized asset: inventory metadata,
 * source-record mappings and the latest scan, the latest classification
 * proposal, data-quality findings, the applicable retention policy and exact
 * version, the latest retention assessment and its history, active holds, and
 * the append-only human review decisions.
 *
 * The view is explicit about provenance: observed source metadata, system
 * proposals, assessments, and human decisions are labelled separately, and any
 * unavailable value is shown as unknown rather than invented. Recording a
 * decision executes no file operation - no archive, restore, move, or delete.
 */

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ApiError, toErrorMessage } from "../api/client";
import { fetchAssetGovernance } from "../api/governance";
import { assessAsset, createDecision, listSupersessionCandidates } from "../api/retention";
import type {
  Assessment,
  Decision,
  DecisionValue,
  GovernanceDetail,
  GovernanceProvenance,
  GovernanceReviewContext,
} from "../api/types";
import { useApiQuery } from "../hooks/useApiQuery";
import { useAuth } from "../auth/AuthContext";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Spinner } from "../components/ui/Spinner";
import { formatBytes, formatDate, humanize } from "../lib/format";

type Tone = "slate" | "indigo" | "emerald" | "sky" | "amber" | "orange" | "rose";

const SEVERITY_TONES: Record<string, Tone> = {
  informational: "slate",
  info: "slate",
  low: "sky",
  medium: "amber",
  high: "orange",
  blocked: "rose",
};

const RECOMMENDATION_TONES: Record<string, Tone> = {
  RETAIN: "emerald",
  ARCHIVE_RECOMMENDED: "sky",
  REVIEW_REQUIRED: "amber",
  DISPOSAL_REVIEW_REQUIRED: "orange",
  BLOCKED_BY_HOLD: "rose",
  NO_APPLICABLE_POLICY: "slate",
};

const DECISION_OPTIONS: Array<{ value: DecisionValue; label: string }> = [
  { value: "retain", label: "Retain" },
  { value: "request_more_information", label: "Request more information" },
  { value: "approve_for_later_workflow", label: "Approve recommendation for a later workflow" },
  { value: "reject", label: "Reject recommendation" },
];

export default function AssetGovernance() {
  const params = useParams();
  const assetId = Number(params.assetId);

  if (!Number.isInteger(assetId) || assetId <= 0) {
    return (
      <div>
        <PageHeader title="Asset Governance" />
        <ErrorState
          title="Invalid asset id"
          message="The asset id must be a positive integer."
        />
      </div>
    );
  }

  return <GovernanceView assetId={assetId} />;
}

function GovernanceView({ assetId }: { assetId: number }) {
  const { activeInstitutionId } = useAuth();
  const { data, loading, error, refetch } = useApiQuery(() =>
    fetchAssetGovernance(assetId, activeInstitutionId ?? undefined),
  );

  return (
    <div>
      <PageHeader
        title={`Asset Governance — #${assetId}`}
        description="Consolidated governance context for one asset: source and discovery, classification and data quality, applicable policy and version, retention assessment, holds, and the append-only record of human decisions. Nothing here archives, restores, moves, or deletes a file."
      />

      {loading ? <Spinner label="Loading governance view..." /> : null}
      {error ? (
        <ErrorState
          title="Governance view unavailable"
          message={error}
          onRetry={refetch}
        />
      ) : null}

      {data ? (
        <div className="space-y-6">
          <ProvenanceBanner provenance={data.provenance} />
          <AssetCard detail={data} />
          <SourceCard detail={data} />
          <ClassificationCard detail={data} />
          <QualityCard detail={data} />
          <PolicyCard detail={data} />
          <HoldsCard detail={data} />
          <AssessmentCard detail={data} onChanged={refetch} />
          <DecisionHistoryCard
            decisions={data.decisions}
            effectiveDecisionId={data.effective_decision_id}
          />
          <ReviewDecisionCard detail={data} onRecorded={refetch} />
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------- provenance ----------------------------- */

function ProvenanceBanner({ provenance }: { provenance: GovernanceProvenance }) {
  return (
    <Card className="border-indigo-200 bg-indigo-50/40">
      <CardBody>
        <h2 className="text-xs font-semibold tracking-wide text-indigo-900 uppercase">
          Provenance
        </h2>
        <dl className="mt-2 grid gap-2 text-xs text-slate-700 sm:grid-cols-4">
          <div>
            <dt className="font-medium text-slate-500">Observed source metadata</dt>
            <dd>{provenance.observed.join(", ") || "—"}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">System proposals</dt>
            <dd>{provenance.system_proposed.join(", ") || "none recorded"}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">Assessments</dt>
            <dd>{provenance.assessed.join(", ") || "none recorded"}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">Human decisions</dt>
            <dd>{provenance.human_decisions.join(", ") || "none recorded"}</dd>
          </div>
        </dl>
        <p className="mt-3 rounded-lg bg-white px-3 py-2 text-xs text-slate-600 ring-1 ring-indigo-100 ring-inset">
          File operations: {provenance.file_operations}
        </p>
      </CardBody>
    </Card>
  );
}

/* ----------------------------------- asset -------------------------------- */

function AssetCard({ detail }: { detail: GovernanceDetail }) {
  const { asset } = detail;
  return (
    <Card>
      <CardHeader
        title="Inventory metadata (observed)"
        description="Values as recorded from the source. Missing metadata is shown as unknown and never treated as low risk."
      />
      <CardBody>
        <h3 className="text-base font-semibold text-slate-900">{asset.title}</h3>
        {asset.description ? (
          <p className="mt-1 mb-3 text-sm text-slate-600">{asset.description}</p>
        ) : (
          <div className="mb-3" />
        )}
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <Field label="External id" value={asset.external_id} />
          <Field label="Record type" value={asset.record_type} />
          <Field label="Category" value={asset.category ?? "unknown"} />
          <Field label="Sensitivity" value={humanize(asset.sensitivity)} />
          <Field
            label="Contains personal data"
            value={asset.contains_personal_data ? "Yes" : "No"}
          />
          <Field label="Lifecycle status" value={humanize(asset.lifecycle_status)} />
          <Field label="File name" value={asset.file_name ?? "unknown"} />
          <Field label="MIME type" value={asset.mime_type ?? "unknown"} />
          <Field
            label="Size"
            value={asset.size_bytes > 0 ? formatBytes(asset.size_bytes) : "unknown"}
          />
          <Field label="Owner team" value={asset.owner_team ?? "unassigned"} />
          <Field
            label="Checksum"
            value={asset.checksum_sha256 ? `${asset.checksum_sha256.slice(0, 16)}…` : "unknown"}
          />
          <Field
            label="Last reviewed"
            value={asset.last_reviewed ? formatDate(asset.last_reviewed) : "never"}
          />
        </dl>
      </CardBody>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-medium text-slate-500">{label}</dt>
      <dd className="text-slate-900">{value}</dd>
    </div>
  );
}

/* ----------------------------------- source ------------------------------- */

function SourceCard({ detail }: { detail: GovernanceDetail }) {
  const { source } = detail;
  return (
    <Card>
      <CardHeader
        title="Source & discovery"
        description="Where the record came from and when it was last observed. Scan results describe discovery, not a file operation."
      />
      <CardBody className="space-y-3 text-sm">
        <dl className="grid gap-3 sm:grid-cols-3">
          <Field label="Data source" value={source.data_source_name ?? "unavailable"} />
          <Field label="Source type" value={source.source_type ?? "unknown"} />
          <Field label="Connector" value={source.connector_type ?? "unavailable"} />
        </dl>

        {source.notes.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-xs text-amber-800">
            {source.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}

        {source.mappings.length > 0 ? (
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Source-record mappings ({source.mappings.length})
            </h3>
            <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
              {source.mappings.map((mapping) => (
                <li key={mapping.mapping_id} className="px-4 py-2">
                  <div className="font-mono text-xs text-slate-600">{mapping.source_key}</div>
                  <div className="text-xs text-slate-500">
                    observed {mapping.observation_count}× · last seen{" "}
                    {mapping.last_seen_at ? formatDate(mapping.last_seen_at.slice(0, 10)) : "unknown"}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {source.latest_scan ? (
          <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            <span className="font-medium text-slate-900">
              Latest scan #{source.latest_scan.scan_job_id}
            </span>{" "}
            · status {source.latest_scan.status} · discovered {source.latest_scan.total_discovered} ·
            imported {source.latest_scan.total_imported} · skipped {source.latest_scan.total_skipped}
          </div>
        ) : (
          <p className="text-xs text-slate-500">
            No discovery run is recorded for this source; the asset may have been created directly.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

/* ------------------------------- classification --------------------------- */

function ClassificationCard({ detail }: { detail: GovernanceDetail }) {
  const result = detail.classification;
  return (
    <Card>
      <CardHeader
        title="Classification (system proposal)"
        description="A deterministic, explainable proposal computed from inventoried metadata only. It is advisory and is never applied to the source record automatically."
      />
      <CardBody>
        {result === null ? (
          <EmptyState
            title="Not classified"
            message="No classification proposal has been recorded for this asset. An unclassified asset is an explicit unknown, never a low-risk one."
          />
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="indigo">{humanize(result.outcome)}</Badge>
              <Badge tone={result.confidence === "high" ? "emerald" : "slate"}>
                confidence {result.confidence}
              </Badge>
              <span className="text-xs text-slate-500">
                {result.rule_version} · {formatDate(result.classified_at.slice(0, 10))}
              </span>
            </div>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Proposed category" value={result.proposed_category ?? "unclassified"} />
              <Field
                label="Proposed sensitivity"
                value={humanize(result.proposed_sensitivity)}
              />
            </dl>
            <p className="text-slate-700">{result.confidence_meaning}</p>
            {result.warnings.length > 0 ? (
              <p className="text-xs text-amber-800">
                {result.warnings.length} warning{result.warnings.length === 1 ? "" : "s"} recorded.
              </p>
            ) : null}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/* -------------------------------- data quality ---------------------------- */

function QualityCard({ detail }: { detail: GovernanceDetail }) {
  const findings = detail.quality_findings;
  return (
    <Card>
      <CardHeader
        title="Data quality & remediation"
        description="Deterministic metadata checks with suggested remediation. A finding describes metadata, never a file."
      />
      <CardBody>
        {findings.length === 0 ? (
          <EmptyState
            title="No quality findings"
            message="Every documented check passed for this asset. That does not prove the metadata is complete or correct."
          />
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {findings.map((finding, index) => (
              <li key={`${finding.check}-${index}`} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={SEVERITY_TONES[finding.severity] ?? "slate"}>
                    {finding.severity}
                  </Badge>
                  <span className="font-mono text-xs text-slate-600">{finding.check}</span>
                </div>
                <p className="mt-1 text-sm text-slate-800">{finding.message}</p>
                <p className="mt-1 text-xs text-slate-500">Remediation: {finding.remediation}</p>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/* ----------------------------------- policy ------------------------------- */

function PolicyCard({ detail }: { detail: GovernanceDetail }) {
  const policy = detail.applicable_policy;
  return (
    <Card>
      <CardHeader
        title="Applicable policy & version"
        description="The single active policy that matches this asset, and the exact immutable version that applies. A missing policy never implies disposal."
      />
      <CardBody>
        {policy === null ? (
          <EmptyState
            title="No applicable policy"
            message="No active policy matches this asset. Missing policy coverage is an explicit gap: it never authorizes disposal, and retention review is required."
          />
        ) : (
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <Field label="Policy" value={`${policy.name} (${policy.status})`} />
            <Field
              label="Version"
              value={
                policy.version_id !== null
                  ? `#${policy.version_id}${
                      policy.version_number !== null ? ` (v${policy.version_number})` : ""
                    }`
                  : "none"
              }
            />
            <Field
              label="Retention period"
              value={
                policy.retention_period_days !== null
                  ? `${policy.retention_period_days} days`
                  : "unspecified"
              }
            />
            <Field label="Trigger" value={policy.retention_trigger ?? "unspecified"} />
            <Field
              label="Recommended action"
              value={policy.recommended_action ?? "unspecified"}
            />
            <Field
              label="Categories"
              value={
                policy.applicable_categories && policy.applicable_categories.length > 0
                  ? policy.applicable_categories.join(", ")
                  : "any"
              }
            />
          </dl>
        )}
      </CardBody>
    </Card>
  );
}

/* ----------------------------------- holds -------------------------------- */

function HoldsCard({ detail }: { detail: GovernanceDetail }) {
  const holds = detail.active_holds;
  return (
    <Card className={holds.length > 0 ? "border-rose-300" : undefined}>
      <CardHeader
        title="Active holds"
        description="A hold overrides incompatible lifecycle recommendations. Releasing a hold never rewrites history."
      />
      <CardBody>
        {holds.length === 0 ? (
          <p className="text-sm text-slate-600">No active holds block this asset.</p>
        ) : (
          <div className="space-y-3">
            <div
              role="status"
              className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900"
            >
              {holds.length} active hold{holds.length === 1 ? "" : "s"} block approving any
              lifecycle-advancing recommendation. Retain, request more information, or reject
              remain available.
            </div>
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {holds.map((hold) => (
                <li key={hold.id} className="px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="rose">{hold.status}</Badge>
                    <span className="font-medium text-slate-900">{hold.name}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {hold.hold_type ?? "hold"}
                    {hold.legal_basis ? ` · ${hold.legal_basis}` : ""}
                    {hold.asset_id === null ? " · institution-wide" : ""}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/* -------------------------------- assessment ------------------------------ */

function AssessmentCard({
  detail,
  onChanged,
}: {
  detail: GovernanceDetail;
  onChanged: () => void;
}) {
  const { has } = useAuth();
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  async function runAssessment(): Promise<void> {
    setRunning(true);
    setRunError(null);
    try {
      await assessAsset(detail.asset.id);
      onChanged();
    } catch (cause) {
      setRunError(toErrorMessage(cause));
    } finally {
      setRunning(false);
    }
  }

  const latest = detail.latest_assessment;
  return (
    <Card>
      <CardHeader
        title="Retention assessment"
        description="Explainable assessments: each records the policy version, findings, and holds that applied. Re-running stores a new immutable entry."
        action={
          has("retention:assess") ? (
            <button
              type="button"
              onClick={() => void runAssessment()}
              disabled={running}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {running ? "Assessing..." : "Run assessment"}
            </button>
          ) : null
        }
      />
      <CardBody className="space-y-4">
        {runError ? (
          <ErrorState title="Assessment failed" message={runError} onRetry={() => void runAssessment()} />
        ) : null}

        {latest === null ? (
          <EmptyState
            title="No assessment recorded"
            message="Run an assessment to produce the first explainable retention recommendation for this asset."
          />
        ) : (
          <AssessmentDetail assessment={latest} />
        )}

        {detail.assessment_history.length > 1 ? (
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              History ({detail.assessment_history.length})
            </h3>
            <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
              {detail.assessment_history.map((assessment, index) => (
                <li
                  key={`${assessment.assessed_at}-${index}`}
                  className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs text-slate-500"
                >
                  <Badge tone={RECOMMENDATION_TONES[assessment.recommendation] ?? "slate"}>
                    {assessment.recommendation.replaceAll("_", " ")}
                  </Badge>
                  <span>
                    {formatDate(assessment.assessed_at.slice(0, 10))} · rule set{" "}
                    {assessment.rule_set}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function AssessmentDetail({ assessment }: { assessment: Assessment }) {
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={RECOMMENDATION_TONES[assessment.recommendation] ?? "slate"}>
          {assessment.recommendation.replaceAll("_", " ")}
        </Badge>
        <span className="text-xs text-slate-500">
          {assessment.rule_set} · assessed {formatDate(assessment.assessed_at.slice(0, 10))}
        </span>
      </div>
      <p className="text-slate-700">{assessment.rationale}</p>
      <dl className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Policy version"
          value={
            assessment.policy_version_id !== null
              ? `#${assessment.policy_version_id}${
                  assessment.policy_version_number !== null
                    ? ` (v${assessment.policy_version_number})`
                    : ""
                }`
              : "none"
          }
        />
        <Field
          label="Retention deadline"
          value={
            assessment.retention_deadline ? formatDate(assessment.retention_deadline) : "not set"
          }
        />
        <Field
          label="Holds at assessment time"
          value={String(assessment.holds_active)}
        />
      </dl>
      {assessment.findings.length > 0 ? (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {assessment.findings.map((finding) => (
            <li key={finding.code} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={SEVERITY_TONES[finding.severity] ?? "slate"}>
                  {finding.severity}
                </Badge>
                <span className="font-mono text-xs text-slate-600">{finding.code}</span>
              </div>
              <p className="mt-1 text-sm text-slate-800">{finding.message}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ----------------------------- decision history --------------------------- */

function DecisionHistoryCard({
  decisions,
  effectiveDecisionId,
}: {
  decisions: Decision[];
  effectiveDecisionId: number | null;
}) {
  return (
    <Card>
      <CardHeader
        title={`Review decisions (${decisions.length})`}
        description="Append-only history. A decision is never edited or erased: a superseded decision stays visible and points at the correction that replaced it. The effective decision is the newest one that has not been superseded."
      />
      <CardBody>
        {decisions.length === 0 ? (
          <p className="text-sm text-slate-600">No human decision has been recorded yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {decisions.map((decision) => (
              <li key={decision.id} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="indigo">{decision.decision.replaceAll("_", " ")}</Badge>
                  {decision.id === effectiveDecisionId ? (
                    <Badge tone="emerald">Effective</Badge>
                  ) : null}
                  {decision.is_superseded ? <Badge tone="amber">Superseded</Badge> : null}
                  <span className="text-xs text-slate-500">
                    reviewer {decision.reviewer} · {formatDate(decision.decided_at.slice(0, 10))} ·
                    assessment #{decision.assessment_id}
                  </span>
                </div>
                <p className="mt-1 text-slate-700">{decision.reason}</p>
                <p className="mt-1 text-xs text-slate-500">
                  Reviewed recommendation:{" "}
                  {decision.recommendation_reviewed.replaceAll("_", " ")}
                  {decision.policy_version_id !== null
                    ? ` · policy version #${decision.policy_version_id}`
                    : ""}
                </p>
                {decision.supersedes_decision_id !== null ? (
                  <p className="mt-1 text-xs text-indigo-700">
                    Corrects decision #{decision.supersedes_decision_id}; the earlier decision
                    stays in this history.
                  </p>
                ) : null}
                {decision.superseded_by_decision_id !== null ? (
                  <p className="mt-1 text-xs text-amber-800">
                    Superseded by decision #{decision.superseded_by_decision_id}.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/* ------------------------------ review decision --------------------------- */

function ReviewDecisionCard({
  detail,
  onRecorded,
}: {
  detail: GovernanceDetail;
  onRecorded: () => void;
}) {
  const { has, user } = useAuth();
  const context = detail.review_context;

  if (context.latest_assessment_id === null) {
    return (
      <Card>
        <CardHeader
          title="Record a review decision"
          description="A decision always references a specific assessment and policy version."
        />
        <CardBody>
          <EmptyState
            title="No assessment to decide on"
            message="Run an assessment for this asset first. A decision without an assessment would have no version context to audit."
          />
        </CardBody>
      </Card>
    );
  }

  if (!has("review:decide")) {
    return (
      <Card>
        <CardHeader
          title="Record a review decision"
          description="Recording decisions is restricted to the reviewer role."
        />
        <CardBody>
          <EmptyState
            title="Your role cannot record decisions"
            message={`Your account holds the ${
              user?.role ?? "no"
            } role. A platform administrator can grant the reviewer role; until then this view stays read-only. The server enforces this too, so it is not only a UI restriction.`}
          />
        </CardBody>
      </Card>
    );
  }

  // One decision per assessment: the form is available exactly when the
  // *latest* assessment has not been decided yet. Earlier decisions elsewhere
  // in the history are handled as corrections (supersession) inside the form.
  const decidedLatestAssessment = detail.decisions.some(
    (item) => item.assessment_id === context.latest_assessment_id,
  );
  if (decidedLatestAssessment) {
    return (
      <Card>
        <CardHeader title="Record a review decision" />
        <CardBody>
          <EmptyState
            title="A decision is already recorded for this assessment"
            message="Decisions are append-only and each assessment has exactly one. To change the outcome, run a fresh assessment above and record the correction against it — the new decision supersedes the earlier one, which stays visible in the history. Nothing is edited or deleted."
          />
        </CardBody>
      </Card>
    );
  }

  return <DecisionForm detail={detail} context={context} onRecorded={onRecorded} />;
}

function DecisionForm({
  detail,
  context,
  onRecorded,
}: {
  detail: GovernanceDetail;
  context: GovernanceReviewContext;
  onRecorded: () => void;
}) {
  const assessmentId = context.latest_assessment_id as number;
  const holdsActive = detail.active_holds.length;
  const { user } = useAuth();

  const [decision, setDecision] = useState<DecisionValue>("retain");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  // Earlier decisions this new one may replace. The server computes the list,
  // so the form can only offer real, already-authorized correction targets.
  const candidates = useApiQuery(() => listSupersessionCandidates(assessmentId));
  const options = candidates.data ?? [];

  // Untouched until the reviewer chooses, or until the eligible predecessors
  // load and the current effective decision can be pre-selected.
  const [supersedes, setSupersedes] = useState<string | null>(null);
  useEffect(() => {
    if (supersedes !== null || options.length === 0) {
      return;
    }
    // Correcting the effective decision is the expected correction; a reviewer
    // can still choose "independent decision" explicitly.
    const effective = options.find((item) => item.id === detail.effective_decision_id);
    setSupersedes(effective ? String(effective.id) : "");
  }, [supersedes, options, detail.effective_decision_id]);

  const supersedesId = supersedes !== null && supersedes !== "" ? Number(supersedes) : null;
  // A correction is a change of outcome, so it needs a substantive rationale
  // just like a rejection (the backend enforces the same rule).
  const requiresSubstantiveReason =
    decision === "reject" ||
    decision === "request_more_information" ||
    supersedesId !== null;
  const reasonTooShort = requiresSubstantiveReason && reason.trim().length < 10;
  const canSubmit =
    user !== null && reason.trim().length > 0 && !reasonTooShort && !submitting;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setConflict(null);
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    try {
      await createDecision(assessmentId, {
        decision,
        reason: reason.trim(),
        supersedes_decision_id: supersedesId,
        expected_assessed_at: context.expected_assessed_at,
        expected_policy_version_id: context.expected_policy_version_id,
        expected_holds_active: context.expected_holds_active,
      });
      setReason("");
      onRecorded();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setConflict(toErrorMessage(cause));
      } else {
        setError(toErrorMessage(cause));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Record a review decision"
        description="A human decision, recorded against the exact assessment and policy version shown. It executes nothing: approval endorses a recommendation for a later, separately authorized workflow only."
      />
      <CardBody>
        {conflict ? (
          <div
            role="alert"
            className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            <p className="font-semibold">
              {conflict.startsWith("stale_review_conflict")
                ? "This review is out of date"
                : conflict.startsWith("hold_conflict")
                  ? "Blocked by an active hold"
                  : "Conflict"}
            </p>
            <p className="mt-1">{conflict}</p>
            <button
              type="button"
              onClick={onRecorded}
              className="mt-3 rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-amber-800 ring-1 ring-amber-300 ring-inset hover:bg-amber-100"
            >
              Reload governance view
            </button>
          </div>
        ) : null}

        {error ? (
          <div role="alert" className="mb-4">
            <ErrorState title="Decision not recorded" message={error} />
          </div>
        ) : null}

        <div className="mb-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
          <p className="font-medium text-slate-900">
            Deciding against assessment #{assessmentId}
          </p>
          <p className="mt-1">
            Assessed{" "}
            {context.expected_assessed_at
              ? formatDate(context.expected_assessed_at.slice(0, 10))
              : "unknown"}{" "}
            · policy version{" "}
            {context.expected_policy_version_id !== null
              ? `#${context.expected_policy_version_id}`
              : "none"}{" "}
            · active holds at load {context.expected_holds_active ?? 0}. If any of these changed,
            the submission is rejected as stale so no decision is recorded against the wrong
            version.
          </p>
        </div>

        {holdsActive > 0 ? (
          <div
            role="status"
            className="mb-4 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900"
          >
            {holdsActive} active hold{holdsActive === 1 ? "" : "s"} block approving a
            lifecycle-advancing recommendation for this asset.
          </div>
        ) : null}

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label
              htmlFor="decision-value"
              className="block text-xs font-medium text-slate-500"
            >
              Decision
            </label>
            <select
              id="decision-value"
              value={decision}
              onChange={(event) => setDecision(event.target.value as DecisionValue)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none sm:max-w-md"
            >
              {DECISION_OPTIONS.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                  disabled={option.value === "approve_for_later_workflow" && holdsActive > 0}
                >
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {options.length > 0 ? (
            <div>
              <label
                htmlFor="decision-supersedes"
                className="block text-xs font-medium text-slate-500"
              >
                Correction
              </label>
              <select
                id="decision-supersedes"
                value={supersedes ?? ""}
                onChange={(event) => setSupersedes(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none sm:max-w-md"
              >
                <option value="">
                  Independent decision — does not replace any earlier decision
                </option>
                {options.map((option) => (
                  <option key={option.id} value={String(option.id)}>
                    Supersede decision #{option.id} — {option.decision.replaceAll("_", " ")} on{" "}
                    {formatDate(option.decided_at.slice(0, 10))} (assessment #
                    {option.assessment_id})
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500">
                {supersedesId !== null
                  ? `Superseding decision #${supersedesId}: it stays in the history marked as superseded, and your decision becomes the effective one. A substantive rationale is required.`
                  : "Earlier decisions stay in the history; a superseded decision is marked and points at its replacement."}
              </p>
            </div>
          ) : null}

          <div>
            <label htmlFor="decision-reason" className="block text-xs font-medium text-slate-500">
              Rationale{requiresSubstantiveReason ? " (required)" : ""}
            </label>
            <textarea
              id="decision-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              aria-invalid={reasonTooShort}
              aria-describedby="decision-reason-help"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
              placeholder="Explain the reasoning behind this decision."
            />
            <p id="decision-reason-help" className="mt-1 text-xs text-slate-500">
              {reasonTooShort
                ? "A rejection, request for more information, or correction needs a substantive rationale (at least 10 characters)."
                : "Recorded with the decision; it is not copied into the audit log."}
            </p>
          </div>

          <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            <p className="font-medium text-slate-900">Reviewer</p>
            <p className="mt-1">
              Recorded as{" "}
              <span className="font-medium text-slate-900">
                {user !== null ? (user.display_name || user.email) : "unknown"}
              </span>
              {user !== null ? ` (${user.email})` : ""}. This identity was verified by the server
              from your signed-in session — it is not typed in here, and it cannot be edited from
              this form.
            </p>
          </div>

          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? "Recording..." : "Record decision"}
          </button>
        </form>
      </CardBody>
    </Card>
  );
}
