import { fetchInventory } from "../api/demo";
import type { InventoryRecord } from "../api/types";
import { useApiQuery } from "../hooks/useApiQuery";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { DemoNotice } from "../components/ui/DemoNotice";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Spinner } from "../components/ui/Spinner";
import { formatBytes, formatDate, humanize } from "../lib/format";
import { toneForRetentionAction, toneForSensitivity } from "../lib/labels";

export default function DataInventory() {
  const { data, loading, error, refetch } = useApiQuery(fetchInventory);

  return (
    <div>
      <PageHeader
        title="Data Inventory"
        description="Records discovered from institutional sources, with classification flags and suggested lifecycle action. Phase 1 shows synthetic fixtures only — no connectors are configured."
      />

      {loading ? <Spinner label="Loading inventory…" /> : null}
      {error ? <ErrorState title="Inventory unavailable" message={error} onRetry={refetch} /> : null}

      {data ? (
        <>
          <DemoNotice notice={data.meta.notice} />
          <Card>
            <CardHeader
              title={`Records (${data.data.length})`}
              description="Sample records — identifiers are prefixed SYNTH-"
            />
            {data.data.length === 0 ? (
              <CardBody>
                <EmptyState
                  title="No records in the inventory yet"
                  message="When a source connector is implemented, discovered records will appear here. Nothing is scanned in Phase 1."
                />
              </CardBody>
            ) : (
              <InventoryTable records={data.data} />
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}

function InventoryTable({ records }: { records: InventoryRecord[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <caption className="sr-only">Synthetic inventory records</caption>
        <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
          <tr>
            <th scope="col" className="px-5 py-3">Record</th>
            <th scope="col" className="px-5 py-3">Source</th>
            <th scope="col" className="px-5 py-3">Sensitivity</th>
            <th scope="col" className="px-5 py-3">Personal data</th>
            <th scope="col" className="px-5 py-3">Duplicate</th>
            <th scope="col" className="px-5 py-3">Size</th>
            <th scope="col" className="px-5 py-3">Suggested action</th>
            <th scope="col" className="px-5 py-3">Last reviewed</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {records.map((record) => (
            <tr key={record.record_id} className="hover:bg-slate-50">
              <td className="px-5 py-3 align-top">
                <p className="font-medium text-slate-900">{record.title}</p>
                <p className="mt-0.5 font-mono text-xs text-slate-500">
                  {record.record_id} · {humanize(record.record_type)}
                </p>
              </td>
              <td className="px-5 py-3 align-top text-slate-600">
                <p>{record.source_name}</p>
                <p className="mt-0.5 text-xs text-slate-400">{record.source_type}</p>
              </td>
              <td className="px-5 py-3 align-top">
                <Badge tone={toneForSensitivity(record.sensitivity)}>
                  {humanize(record.sensitivity)}
                </Badge>
              </td>
              <td className="px-5 py-3 align-top text-slate-600">
                {record.contains_personal_data ? "Yes" : "No"}
              </td>
              <td className="px-5 py-3 align-top text-slate-600">
                {record.duplicate_candidate ? (
                  <Badge tone="amber">Candidate</Badge>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </td>
              <td className="px-5 py-3 align-top text-slate-600 tabular-nums">
                {formatBytes(record.size_bytes)}
              </td>
              <td className="px-5 py-3 align-top">
                <Badge tone={toneForRetentionAction(record.retention_action)}>
                  {humanize(record.retention_action)}
                </Badge>
              </td>
              <td className="px-5 py-3 align-top text-slate-600">
                {formatDate(record.last_reviewed)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
