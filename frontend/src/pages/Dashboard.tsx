import { fetchDashboard } from "../api/demo";
import type { DashboardSummary } from "../api/types";
import { useApiQuery } from "../hooks/useApiQuery";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui/Badge";
import { BarList, type BarItem } from "../components/ui/BarList";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { DemoNotice } from "../components/ui/DemoNotice";
import { ErrorState } from "../components/ui/ErrorState";
import { Spinner } from "../components/ui/Spinner";
import { StatCard } from "../components/ui/StatCard";
import { formatBytes, formatDate, humanize } from "../lib/format";

export default function Dashboard() {
  const { data, loading, error, refetch } = useApiQuery(fetchDashboard);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Inventory volume, sensitivity mix, explainable risk bands, and lifecycle activity across all discovered records."
      />

      {loading ? <Spinner label="Loading dashboard summary…" /> : null}
      {error ? (
        <ErrorState title="Dashboard unavailable" message={error} onRetry={refetch} />
      ) : null}

      {data ? (
        <>
          <DemoNotice notice={data.meta.notice} />
          <DashboardContent summary={data.data} />
        </>
      ) : null}
    </div>
  );
}

function DashboardContent({ summary }: { summary: DashboardSummary }) {
  const sensitivityItems: BarItem[] = [
    { label: "Restricted", value: summary.by_sensitivity.restricted, tone: "rose" },
    { label: "Confidential", value: summary.by_sensitivity.confidential, tone: "amber" },
    { label: "Internal", value: summary.by_sensitivity.internal, tone: "sky" },
    { label: "Public", value: summary.by_sensitivity.public, tone: "emerald" },
  ];

  const riskItems: BarItem[] = [
    { label: "Critical (75–100)", value: summary.by_risk_band.critical, tone: "rose" },
    { label: "High (50–74)", value: summary.by_risk_band.high, tone: "orange" },
    { label: "Moderate (25–49)", value: summary.by_risk_band.moderate, tone: "amber" },
    { label: "Low (0–24)", value: summary.by_risk_band.low, tone: "emerald" },
  ];

  const actionItems: BarItem[] = [
    { label: "Retain", value: summary.by_retention_action.retain, tone: "emerald" },
    { label: "Archive", value: summary.by_retention_action.archive, tone: "indigo" },
    { label: "Review", value: summary.by_retention_action.review, tone: "amber" },
    {
      label: "Eligible for disposal",
      value: summary.by_retention_action.eligible_for_disposal,
      tone: "rose",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Inventory records"
          value={summary.total_records}
          hint="Discovered sample records"
        />
        <StatCard
          label="Duplicate candidates"
          value={summary.duplicate_candidates}
          hint="Flagged for review, never auto-deleted"
        />
        <StatCard
          label="Pending approvals"
          value={summary.pending_approvals}
          hint="Human decisions required"
        />
        <StatCard
          label="Storage tracked"
          value={formatBytes(summary.storage_bytes)}
          hint={`${summary.open_retrieval_requests} open retrieval requests`}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader
            title="Sensitivity distribution"
            description="Records by assigned sensitivity level"
          />
          <CardBody>
            <BarList items={sensitivityItems} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Risk band distribution"
            description="From documented indicator rules (rule set v1)"
          />
          <CardBody>
            <BarList items={riskItems} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Recommended action mix"
            description="Illustrative sample values — no retention engine runs yet"
          />
          <CardBody>
            <BarList items={actionItems} />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Recent activity" description="Latest synthetic lifecycle events" />
        <CardBody className="p-0">
          <ul className="divide-y divide-slate-100">
            {summary.recent_activity.map((activity) => (
              <li
                key={activity.event_id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm"
              >
                <Badge tone="slate">{humanize(activity.event_type)}</Badge>
                <span className="flex-1 text-slate-700">{activity.description}</span>
                <span className="text-xs text-slate-500">
                  {activity.actor} · {formatDate(activity.occurred_on)}
                </span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
