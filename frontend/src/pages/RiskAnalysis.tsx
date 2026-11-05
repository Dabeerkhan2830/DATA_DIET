import { fetchRiskAnalysis } from "../api/demo";
import type { RiskRecordView } from "../api/types";
import { useApiQuery } from "../hooks/useApiQuery";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { DemoNotice } from "../components/ui/DemoNotice";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Spinner } from "../components/ui/Spinner";
import { humanize } from "../lib/format";
import { toneForRiskBand, toneForSensitivity } from "../lib/labels";

export default function RiskAnalysis() {
  const { data, loading, error, refetch } = useApiQuery(fetchRiskAnalysis);

  return (
    <div>
      <PageHeader
        title="Risk Analysis"
        description="Privacy and retention exposure indicators computed from documented rules. Every point can be traced to an explanation; these indicators are not a security rating and drive no automated decision."
      />

      {loading ? <Spinner label="Loading risk assessments…" /> : null}
      {error ? <ErrorState title="Risk data unavailable" message={error} onRetry={refetch} /> : null}

      {data ? (
        <>
          <DemoNotice notice={data.meta.notice} />

          <div className="space-y-6">
            <Card>
              <CardHeader
                title="Indicator rules"
                description={`Rule set: ${data.data.rule_set}`}
              />
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
                    <tr>
                      <th scope="col" className="px-5 py-3">Rule</th>
                      <th scope="col" className="px-5 py-3">Condition</th>
                      <th scope="col" className="px-5 py-3">Points</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {data.data.rules.map((rule) => (
                      <tr key={rule.code}>
                        <td className="px-5 py-3 font-mono text-xs text-slate-600">{rule.code}</td>
                        <td className="px-5 py-3 text-slate-700">{rule.description}</td>
                        <td className="px-5 py-3 font-medium text-slate-900">{rule.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <CardBody className="border-t border-slate-200 text-xs text-slate-500">
                Bands: 0–24 low · 25–49 moderate · 50–74 high · 75–100 critical. Totals are capped at
                100. See docs/decisions.md for the rule decision record.
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Records by exposure score"
                description="Expand a record to see exactly which indicators applied"
              />
              {data.data.records.length === 0 ? (
                <CardBody>
                  <EmptyState
                    title="No assessments available"
                    message="Assessments appear after records are inventoried. Scanning is not implemented in Phase 1."
                  />
                </CardBody>
              ) : (
                <CardBody className="p-0">
                  <ul className="divide-y divide-slate-100">
                    {data.data.records.map((record) => (
                      <RiskRow key={record.record_id} record={record} />
                    ))}
                  </ul>
                </CardBody>
              )}
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}

function RiskRow({ record }: { record: RiskRecordView }) {
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-slate-900">{record.title}</p>
          <p className="mt-0.5 font-mono text-xs text-slate-500">{record.record_id}</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone={toneForSensitivity(record.sensitivity)}>
            {humanize(record.sensitivity)}
          </Badge>
          <span className="text-sm font-semibold text-slate-900 tabular-nums">
            {record.score}/100
          </span>
          <Badge tone={toneForRiskBand(record.band)}>{humanize(record.band)}</Badge>
        </div>
      </div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full ${
            record.band === "critical"
              ? "bg-rose-500"
              : record.band === "high"
                ? "bg-orange-500"
                : record.band === "moderate"
                  ? "bg-amber-500"
                  : "bg-emerald-500"
          }`}
          style={{ width: `${record.score}%` }}
          role="presentation"
        />
      </div>

      {record.indicators.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-indigo-700 hover:text-indigo-900">
            Show {record.indicators.length} contributing indicator
            {record.indicators.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 space-y-1">
            {record.indicators.map((indicator) => (
              <li key={indicator.code} className="flex flex-wrap gap-x-2 text-xs text-slate-600">
                <span className="font-semibold text-slate-800">+{indicator.points}</span>
                <span className="font-mono text-slate-500">{indicator.code}</span>
                <span>{indicator.explanation}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <p className="mt-3 text-xs text-slate-500">
          No risk indicators applied to this record.
        </p>
      )}
    </li>
  );
}
