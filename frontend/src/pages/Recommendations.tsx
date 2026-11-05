/**
 * Unified review queue (Phase 6).
 *
 * The advisory queue produced by the retention assessment engine, now with
 * server-side filtering (institution, review status, recommendation, severity),
 * permitted-metadata search, deterministic urgency/age sorting, and pagination.
 *
 * Every row explains why it is in the queue: the recommendation, the
 * assessment's most urgent finding severity, active holds, the retention
 * deadline, and whether a human decision has already been recorded. Rows link to
 * the unified governance view where a reviewer records a decision.
 *
 * Nothing here executes an archive, restore, or deletion; those operations are
 * not implemented.
 */

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { listRecommendations } from "../api/retention";
import type { RecommendationItem, RecommendationState } from "../api/types";
import { useApiQuery } from "../hooks/useApiQuery";
import { useAuth } from "../auth/AuthContext";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Card, CardHeader } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Spinner } from "../components/ui/Spinner";
import { formatDate } from "../lib/format";

type Tone = "slate" | "indigo" | "emerald" | "sky" | "amber" | "orange" | "rose";

const RECOMMENDATION_TONES: Record<RecommendationState, Tone> = {
  RETAIN: "emerald",
  ARCHIVE_RECOMMENDED: "sky",
  REVIEW_REQUIRED: "amber",
  DISPOSAL_REVIEW_REQUIRED: "orange",
  BLOCKED_BY_HOLD: "rose",
  NO_APPLICABLE_POLICY: "slate",
};

const SEVERITY_TONES: Record<string, Tone> = {
  informational: "slate",
  low: "sky",
  medium: "amber",
  high: "orange",
  blocked: "rose",
};

const RECOMMENDATION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "All recommendations" },
  { value: "RETAIN", label: "Retain" },
  { value: "ARCHIVE_RECOMMENDED", label: "Archive recommended" },
  { value: "REVIEW_REQUIRED", label: "Review required" },
  { value: "DISPOSAL_REVIEW_REQUIRED", label: "Disposal review required" },
  { value: "BLOCKED_BY_HOLD", label: "Blocked by hold" },
  { value: "NO_APPLICABLE_POLICY", label: "No applicable policy" },
];

const REVIEW_STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "Any review status" },
  { value: "open", label: "Open (no decision)" },
  { value: "decided", label: "Decided" },
];

const SEVERITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "Any severity" },
  { value: "informational", label: "Informational" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "blocked", label: "Blocked" },
];

const SORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "urgency", label: "Urgency (holds, then deadline)" },
  { value: "age", label: "Oldest assessment first" },
];

const PER_PAGE = 20;

interface QueueQuery {
  page: number;
  recommendation: string;
  reviewStatus: string;
  severity: string;
  sort: string;
  search: string;
}

const DEFAULT_QUERY: QueueQuery = {
  page: 1,
  recommendation: "",
  reviewStatus: "",
  severity: "",
  sort: "urgency",
  search: "",
};

export default function Recommendations() {
  const { activeInstitutionId } = useAuth();
  const [query, setQuery] = useState<QueueQuery>(DEFAULT_QUERY);

  const { data, loading, error, refetch } = useApiQuery(() =>
    listRecommendations({
      page: query.page,
      per_page: PER_PAGE,
      institution_id: activeInstitutionId ?? undefined,
      recommendation: query.recommendation || undefined,
      review_status: query.reviewStatus || undefined,
      severity: query.severity || undefined,
      sort: query.sort,
      search: query.search || undefined,
    }),
  );

  // `useApiQuery` fetches on mount; re-fetch only when the query changes after.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    refetch();
  }, [query, refetch]);

  function update(patch: Partial<QueueQuery>): void {
    setQuery((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  return (
    <div>
      <PageHeader
        title="Review Queue"
        description="Advisory review queue produced by the retention assessment engine. Filter by institution, review status, recommendation, severity, or permitted asset metadata; rows are ordered deterministically. Every recommendation is traceable to findings, evidence, and the policy version that applied. Nothing here executes an archive or deletion."
      />

      <FilterBar query={query} onChange={update} />

      {loading ? <Spinner label="Loading review queue..." /> : null}
      {error ? (
        <ErrorState title="Review queue unavailable" message={error} onRetry={refetch} />
      ) : null}

      {data ? (
        <Card>
          <CardHeader
            title={`Queue (${data.total} assessed assets)`}
            description="Severity is the most urgent finding severity on the latest assessment; it is not a lifecycle priority. An empty queue never implies any asset is eligible for disposal."
          />

          {data.items.length === 0 ? (
            <EmptyState
              title="No items in the review queue"
              message="Either no asset matches the current filters, or no asset has been assessed yet. An empty queue never implies that any asset is eligible for disposal."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  <tr>
                    <th scope="col" className="px-5 py-3">Asset</th>
                    <th scope="col" className="px-5 py-3">Recommendation</th>
                    <th scope="col" className="px-5 py-3">Severity</th>
                    <th scope="col" className="px-5 py-3">Review</th>
                    <th scope="col" className="px-5 py-3">Holds</th>
                    <th scope="col" className="px-5 py-3">Deadline</th>
                    <th scope="col" className="px-5 py-3">Assessed</th>
                    <th scope="col" className="px-5 py-3">Governance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {data.items.map((item) => (
                    <QueueRow key={`${item.asset_id}-${item.assessed_at}`} item={item} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-sm text-slate-600">
            <button
              type="button"
              disabled={query.page <= 1}
              onClick={() => setQuery((q) => ({ ...q, page: Math.max(1, q.page - 1) }))}
              className="rounded-lg bg-white px-3 py-1.5 font-medium ring-1 ring-slate-300 ring-inset hover:bg-slate-50 disabled:opacity-50"
            >
              Previous
            </button>
            <span>
              Page {data.page} of {Math.max(1, data.pages)} ({data.total} total)
            </span>
            <button
              type="button"
              disabled={query.page >= data.pages}
              onClick={() => setQuery((q) => ({ ...q, page: q.page + 1 }))}
              className="rounded-lg bg-white px-3 py-1.5 font-medium ring-1 ring-slate-300 ring-inset hover:bg-slate-50 disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function FilterBar({
  query,
  onChange,
}: {
  query: QueueQuery;
  onChange: (patch: Partial<QueueQuery>) => void;
}) {
  const selectClass =
    "mt-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none";

  return (
    <Card className="mb-6">
      <div className="grid gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-5">
        <label className="text-sm">
          <span className="block text-xs font-medium text-slate-500">Search</span>
          <input
            type="search"
            value={query.search}
            onChange={(event) => onChange({ search: event.target.value })}
            placeholder="Title, id, or file name"
            className={selectClass}
          />
        </label>
        <label className="text-sm">
          <span className="block text-xs font-medium text-slate-500">Recommendation</span>
          <select
            value={query.recommendation}
            onChange={(event) => onChange({ recommendation: event.target.value })}
            className={selectClass}
          >
            {RECOMMENDATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs font-medium text-slate-500">Review status</span>
          <select
            value={query.reviewStatus}
            onChange={(event) => onChange({ reviewStatus: event.target.value })}
            className={selectClass}
          >
            {REVIEW_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs font-medium text-slate-500">Severity</span>
          <select
            value={query.severity}
            onChange={(event) => onChange({ severity: event.target.value })}
            className={selectClass}
          >
            {SEVERITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs font-medium text-slate-500">Sort</span>
          <select
            value={query.sort}
            onChange={(event) => onChange({ sort: event.target.value })}
            className={selectClass}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Card>
  );
}

function QueueRow({ item }: { item: RecommendationItem }) {
  const overdue = (item.days_overdue ?? 0) > 0;
  return (
    <tr>
      <td className="px-5 py-3">
        <div className="font-medium text-slate-900">
          {item.asset_title ?? `Asset #${item.asset_id}`}
        </div>
        <div className="text-xs text-slate-500">
          #{item.asset_id}
          {item.institution_id !== null && item.institution_id !== undefined
            ? ` · institution #${item.institution_id}`
            : ""}
        </div>
      </td>
      <td className="px-5 py-3">
        <Badge tone={RECOMMENDATION_TONES[item.recommendation]}>
          {item.recommendation.replaceAll("_", " ")}
        </Badge>
      </td>
      <td className="px-5 py-3">
        {item.severity ? (
          <Badge tone={SEVERITY_TONES[item.severity] ?? "slate"}>{item.severity}</Badge>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      <td className="px-5 py-3">
        {item.review_status === "decided" ? (
          <Badge tone="emerald">
            decided{item.latest_decision ? `: ${item.latest_decision.replaceAll("_", " ")}` : ""}
          </Badge>
        ) : (
          <Badge tone="amber">open</Badge>
        )}
      </td>
      <td className="px-5 py-3">
        {item.holds_active > 0 ? (
          <Badge tone="rose">{item.holds_active} active</Badge>
        ) : (
          <span className="text-slate-400">None</span>
        )}
      </td>
      <td className="px-5 py-3 text-slate-500">
        {item.retention_deadline ? (
          <span className={overdue ? "font-medium text-orange-700" : ""}>
            {formatDate(item.retention_deadline)}
            {overdue ? ` (+${item.days_overdue}d overdue)` : ""}
          </span>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      <td className="px-5 py-3 text-slate-500">
        {formatDate(item.assessed_at.slice(0, 10))}
      </td>
      <td className="px-5 py-3">
        <Link
          to={`/governance/assets/${item.asset_id}`}
          className="font-medium text-indigo-600 hover:text-indigo-800"
        >
          Open governance view
        </Link>
      </td>
    </tr>
  );
}
