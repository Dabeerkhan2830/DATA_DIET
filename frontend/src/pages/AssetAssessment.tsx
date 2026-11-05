/**
 * Asset assessment detail (Phase 3).
 *
 * Runs a fresh assessment for one asset and shows its full history: every
 * finding, the evidence behind it, the policy version that applied, and any
 * blocking holds. Explanations are transparent; there is no opaque score and no
 * execution of archive or deletion.
 */

import { useParams } from "react-router-dom";
import { assessAsset, getAssessmentHistory } from "../api/retention";
import type { Assessment, AssessmentFinding, FindingSeverity } from "../api/types";
import { useApiQuery } from "../hooks/useApiQuery";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Spinner } from "../components/ui/Spinner";
import { formatDate } from "../lib/format";

type Tone = "slate" | "indigo" | "emerald" | "sky" | "amber" | "orange" | "rose";

const SEVERITY_TONES: Record<FindingSeverity, Tone> = {
  informational: "slate",
  low: "sky",
  medium: "amber",
  high: "orange",
  blocked: "rose",
};

export default function AssetAssessment() {
  const params = useParams();
  const assetId = Number(params.assetId);

  const history = useApiQuery(() => getAssessmentHistory(assetId));

  if (!Number.isInteger(assetId) || assetId <= 0) {
    return (
      <div>
        <PageHeader title="Asset Assessment" />
        <ErrorState title="Invalid asset id" message="The asset id must be a positive integer." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={`Assessment - asset #${assetId}`}
        description="Explainable retention assessment: findings, evidence, applicable policy version, and blocking holds. Recommendations are advisory only."
      />

      <div className="space-y-6">
        <RunAssessmentCard assetId={assetId} />

        {history.loading ? <Spinner label="Loading assessment history..." /> : null}
        {history.error ? (
          <ErrorState
            title="History unavailable"
            message={history.error}
            onRetry={history.refetch}
          />
        ) : null}

        {history.data ? <HistoryList assessments={history.data} /> : null}
      </div>
    </div>
  );
}

function RunAssessmentCard({ assetId }: { assetId: number }) {
  const state = useApiQuery(() => assessAsset(assetId));

  return (
    <Card>
      <CardHeader
        title="Current assessment"
        description="Re-running an assessment stores a new history entry; previous entries are preserved even if policies or holds change."
        action={
          <button
            type="button"
            onClick={state.refetch}
            disabled={state.loading}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {state.loading ? "Assessing..." : "Run assessment"}
          </button>
        }
      />
      <CardBody>
        {state.loading ? <Spinner label="Assessing asset..." /> : null}
        {state.error ? (
          <ErrorState title="Assessment failed" message={state.error} onRetry={state.refetch} />
        ) : null}
        {state.data ? <AssessmentDetail assessment={state.data} /> : null}
      </CardBody>
    </Card>
  );
}

function AssessmentDetail({ assessment }: { assessment: Assessment }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={assessment.holds_active > 0 ? "rose" : "slate"}>
          {assessment.recommendation.replaceAll("_", " ")}
        </Badge>
        {assessment.holds_active > 0 ? (
          <span className="text-sm text-rose-700">
            {assessment.holds_active} active hold
            {assessment.holds_active === 1 ? "" : "s"} block disposal.
          </span>
        ) : null}
        <span className="text-xs text-slate-500">
          Rule set {assessment.rule_set} - assessed {formatDate(assessment.assessed_at.slice(0, 10))}
        </span>
      </div>

      <p className="text-sm text-slate-700">{assessment.rationale}</p>

      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="font-medium text-slate-500">Applicable policy</dt>
          <dd className="text-slate-900">
            {assessment.policy_id !== null ? `#${assessment.policy_id}` : "None"}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-slate-500">Policy version</dt>
          <dd className="text-slate-900">
            {assessment.policy_version_id !== null
              ? `#${assessment.policy_version_id}${
                  assessment.policy_version_number !== null
                    ? ` (v${assessment.policy_version_number})`
                    : ""
                }`
              : "None"}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-slate-500">Unresolved conditions</dt>
          <dd className="text-slate-900">
            {assessment.unresolved_conditions.length > 0
              ? assessment.unresolved_conditions.join(", ")
              : "None"}
          </dd>
        </div>
      </dl>

      <FindingList findings={assessment.findings} />
    </div>
  );
}

function FindingList({ findings }: { findings: AssessmentFinding[] }) {
  if (findings.length === 0) {
    return (
      <EmptyState
        title="No findings"
        message="This assessment produced no findings. That does not make the asset eligible for disposal; eligibility is never assumed."
      />
    );
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-900">Findings ({findings.length})</h3>
      <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
        {findings.map((finding) => (
          <li key={finding.code} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={SEVERITY_TONES[finding.severity]}>{finding.severity}</Badge>
              <span className="font-mono text-xs text-slate-600">{finding.code}</span>
            </div>
            <p className="mt-1 text-sm text-slate-800">{finding.message}</p>
            {finding.evidence ? (
              <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-600">
                {JSON.stringify(finding.evidence, null, 2)}
              </pre>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function HistoryList({ assessments }: { assessments: Assessment[] }) {
  if (assessments.length === 0) {
    return (
      <Card>
        <CardHeader title="Assessment history" />
        <CardBody>
          <EmptyState
            title="No assessments recorded"
            message="Run an assessment above to record the first history entry."
          />
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title={`History (${assessments.length})`}
        description="Historical entries are immutable; they keep the policy version and findings that applied at assessment time."
      />
      <div className="divide-y divide-slate-100">
        {assessments.map((assessment, index) => (
          <div key={`${assessment.assessed_at}-${index}`} className="px-5 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge>{assessment.recommendation.replaceAll("_", " ")}</Badge>
              <span className="text-xs text-slate-500">
                {formatDate(assessment.assessed_at.slice(0, 10))} - rule set {assessment.rule_set}
                {assessment.policy_id !== null ? ` - policy #${assessment.policy_id}` : ""}
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-700">{assessment.rationale}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}
