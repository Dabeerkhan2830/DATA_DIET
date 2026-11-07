/**
 * Review queue workspace (redesign Phase 5.7).
 *
 * The queue is the advisory conclusion of each asset's latest retention
 * assessment. Nothing on this page moves, archives, restores or deletes a
 * record, and recording a review decision does not either.
 *
 * The contract was read out of `backend/app/api/routes/retention.py`,
 * `backend/app/api/schemas/retention.py`, `backend/app/services/retention.py`
 * and `backend/app/core/auth.py`, then re-checked against a running instance:
 *
 * - `GET /retention/recommendations` answers the envelope
 *   `{items, total, page, per_page, pages}`. `per_page` is capped at 100 and
 *   `page` has no upper bound — a page past the end returns `items: []` with a
 *   non-zero `total`. `total` is the count after the server derives
 *   `review_status` and `severity`, so it is the filtered count, not a SQL
 *   `COUNT(*)`.
 * - Server-side filters only, all twelve parameters the route declares:
 *   `search` (asset title, external id, file name), `recommendation`,
 *   `review_status`, `severity`, `sort` (`urgency` or `age`), `page`,
 *   `per_page`, `institution_id`, `assessed_from`, `assessed_to` (both
 *   `datetime`) and `deadline_from`, `deadline_to` (both `date`). The four
 *   range filters are applied inclusively in SQL
 *   (`services/retention.py:818-825`), so the date pickers send the first and
 *   last second of the chosen day for `assessed_*` — otherwise a same-day upper
 *   bound would exclude everything assessed after midnight. There is no
 *   coverage, category or owner filter, so this page offers no browser-side
 *   narrowing either — every control here is a request parameter.
 * - One row per asset: the queue selects the newest assessment by `MAX(id)`
 *   (`services/retention.py:806`). A recommendation value never transitions;
 *   re-assessment appends a row and the queue then shows the new one. An asset
 *   appears only after `POST /retention/assess/{asset_id}` has been called —
 *   reading the queue creates nothing.
 * - `review_status` has exactly two values, `open` and `decided`, and it moves
 *   one way: a decision row exists or it does not. There is no `dismissed`,
 *   `applied` or `completed` state, and no endpoint removes a decision.
 * - The only write is `POST /retention/assessments/{assessment_id}/decisions`
 *   (`review:decide`), whose `institution_id` is a query parameter. The body is
 *   `decision`, `reason` (1..4000), the three concurrency tokens and
 *   `supersedes_decision_id`. The server writes the caller's real email and
 *   display name as the actor and a real `decided_at` — unlike policies and
 *   holds, which are recorded as `"system"`.
 * - `ARCHIVE_RECOMMENDED` is a valid server enum value that the assessment
 *   engine never writes, so filtering by it returns an empty queue. The control
 *   says so rather than hiding a documented state.
 * - There is no `GET /retention/recommendations/{id}`, no affected-asset list,
 *   no rule catalogue and no audit-trail endpoint. The details view therefore
 *   repeats only what the row itself carried; the per-asset governance view is
 *   linked for the history the queue does not return.
 * - Conflicts are 409s whose machine-readable token is a prefix of the `detail`
 *   string: `stale_review_conflict`, `hold_conflict`, and the append-only
 *   "already has a recorded decision" refusal. Supersession rejections
 *   (`supersession_*`) are mapped to prose by the route, so the code itself is
 *   not recoverable from the response, and two of them arrive as 404 rather than
 *   409: an unknown or other-tenant target is "not found". Nothing is written by
 *   an already-decided refusal or by a 404; a stale or hold conflict does commit
 *   an audit row.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import { Link } from "react-router-dom";
import { ApiError, toErrorMessage } from "../api/client";
import {
  createDecision,
  listRecommendations,
  listSupersessionCandidates,
} from "../api/retention";
import type {
  AssessmentFinding,
  DecisionValue,
  RecommendationItem,
  RecommendationState,
  FindingSeverity,
  ReviewStatus,
} from "../api/types";
import { useApiQuery } from "../hooks/useApiQuery";
import { useAuth } from "../auth/AuthContext";
import { IconChevronLeft, IconChevronRight } from "../components/icons";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Dialog } from "../components/ui/Dialog";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Field } from "../components/ui/Field";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../components/ui/Table";
import { Textarea } from "../components/ui/Textarea";
import { formatDate } from "../lib/format";
import {
  toneForDecision,
  toneForRecommendation,
  toneForReviewStatus,
  toneForSeverity,
} from "../lib/semantic";

/** The `per_page` the queue defaults to; the server's own maximum is 100. */
const PER_PAGE = 20;

/** How long the search box must be idle before the queue is re-queried. */
const SEARCH_DEBOUNCE_MS = 300;

/** `DecisionCreate.reason` limits, mirrored so a wasted round trip is avoided. */
const REASON_MAX = 4000;
const SUBSTANTIVE_REASON_MIN = 10;

/** The six `Recommendation` literals the schema declares. */
const RECOMMENDATION_OPTIONS: Array<{ value: RecommendationState; label: string }> = [
  { value: "RETAIN", label: "Retain" },
  { value: "ARCHIVE_RECOMMENDED", label: "Archive recommended" },
  { value: "REVIEW_REQUIRED", label: "Review required" },
  { value: "DISPOSAL_REVIEW_REQUIRED", label: "Disposal review required" },
  { value: "BLOCKED_BY_HOLD", label: "Blocked by hold" },
  { value: "NO_APPLICABLE_POLICY", label: "No applicable policy" },
];

const REVIEW_STATUS_OPTIONS: Array<{ value: ReviewStatus; label: string }> = [
  { value: "open", label: "Open — no decision recorded" },
  { value: "decided", label: "Decided" },
];

const SEVERITY_OPTIONS: Array<{ value: FindingSeverity; label: string }> = [
  { value: "informational", label: "Informational" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "blocked", label: "Blocked" },
];

/** The two `sort` values the route accepts; anything else is a 422. */
const SORT_OPTIONS: Array<{ value: "urgency" | "age"; label: string }> = [
  { value: "urgency", label: "Urgency (holds, then deadline)" },
  { value: "age", label: "Oldest assessment first" },
];

/** The four `DecisionValue` literals, in the order the review form offers them. */
const DECISION_OPTIONS: Array<{ value: DecisionValue; label: string }> = [
  { value: "retain", label: "Retain — keep the asset, no lifecycle change" },
  {
    value: "approve_for_later_workflow",
    label: "Approve for later workflow — endorse, execute nothing",
  },
  { value: "request_more_information", label: "Request more information" },
  { value: "reject", label: "Reject the recommendation" },
];

interface QueueQuery {
  page: number;
  recommendation: string;
  reviewStatus: string;
  severity: string;
  sort: string;
  search: string;
  /** `YYYY-MM-DD` from a date input; empty means the parameter is not sent. */
  assessedFrom: string;
  assessedTo: string;
  deadlineFrom: string;
  deadlineTo: string;
}

const DEFAULT_QUERY: QueueQuery = {
  page: 1,
  recommendation: "",
  reviewStatus: "",
  severity: "",
  sort: "urgency",
  search: "",
  assessedFrom: "",
  assessedTo: "",
  deadlineFrom: "",
  deadlineTo: "",
};

type DialogState =
  | { kind: "details"; item: RecommendationItem }
  | { kind: "decide"; item: RecommendationItem }
  | null;

/**
 * Returns `value` once it has stopped changing for `delayMs`.
 *
 * Search text is typed one character at a time; the queue is queried on the
 * settled value so a keystroke does not equal a server round-trip.
 */
function useSettledValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}

/** `BLOCKED_BY_HOLD` reads as `Blocked by hold`; the backend spells it uppercase. */
function recommendationLabel(value: RecommendationState): string {
  return value.replaceAll("_", " ");
}

function decisionLabel(value: DecisionValue): string {
  return value.replaceAll("_", " ");
}

/**
 * What the server's `total` and `page` mean together, in one sentence.
 *
 * `total` is the count across every page and `items` is one page, so a view of
 * 20 rows out of 40 must not read as "20 assets need review".
 */
function scopeSentence(
  total: number,
  pageCount: number,
  activeInstitutionId: number | null,
): string {
  const head = `${total} assessed asset${total === 1 ? "" : "s"} match this view`;
  const scope =
    activeInstitutionId === null
      ? "your platform-wide account sent no institution filter, so rows from every tenant and rows stored without one are included"
      : `the server filtered to institution #${activeInstitutionId}, which excludes assessments stored without an institution`;
  return `${head}; ${pageCount} of them are on this page, because ${scope}.`;
}

/** Why a row is in the queue, in the words the assessment engine stored. */
function severitySentence(severity: FindingSeverity | null): string {
  return severity === null
    ? "No findings on this assessment"
    : `Most urgent finding: ${severity}`;
}

/**
 * The two `datetime` bounds for a day picked out of a date input.
 *
 * `assessed_at` is stored naive-UTC and SQL compares it with `>=` / `<=`, so a
 * bare `2026-10-10` upper bound would resolve to midnight and drop every
 * assessment made later that same day. Widening to the last second keeps the
 * picker honest about covering the day it names.
 */
function assessedBounds(from: string, to: string): {
  assessed_from?: string;
  assessed_to?: string;
} {
  return {
    assessed_from: from === "" ? undefined : `${from}T00:00:00`,
    assessed_to: to === "" ? undefined : `${to}T23:59:59`,
  };
}

/** `deadline_from`/`deadline_to` are `date` parameters, so the picker value goes as-is. */
function deadlineBounds(from: string, to: string): {
  deadline_from?: string;
  deadline_to?: string;
} {
  return {
    deadline_from: from === "" ? undefined : from,
    deadline_to: to === "" ? undefined : to,
  };
}

export default function Recommendations() {
  const { activeInstitutionId, has } = useAuth();
  const [query, setQuery] = useState<QueueQuery>(DEFAULT_QUERY);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const settledSearch = useSettledValue(query.search, SEARCH_DEBOUNCE_MS);

  const canDecide = has("review:decide");

  const { data, loading, error, refetch } = useApiQuery(
    (signal) =>
      listRecommendations(
        {
          page: query.page,
          per_page: PER_PAGE,
          institution_id: activeInstitutionId ?? undefined,
          recommendation: query.recommendation || undefined,
          review_status: query.reviewStatus || undefined,
          severity: query.severity || undefined,
          sort: query.sort,
          search: settledSearch || undefined,
          ...assessedBounds(query.assessedFrom, query.assessedTo),
          ...deadlineBounds(query.deadlineFrom, query.deadlineTo),
        },
        signal,
      ),
    [
      query.page,
      activeInstitutionId,
      query.recommendation,
      query.reviewStatus,
      query.severity,
      query.sort,
      settledSearch,
      query.assessedFrom,
      query.assessedTo,
      query.deadlineFrom,
      query.deadlineTo,
    ],
  );

  /** Any change except the page number returns the view to the first page. */
  function update(patch: Partial<QueueQuery>): void {
    setQuery((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  const filtersActive =
    query.search !== "" ||
    query.recommendation !== "" ||
    query.reviewStatus !== "" ||
    query.severity !== "" ||
    query.assessedFrom !== "" ||
    query.assessedTo !== "" ||
    query.deadlineFrom !== "" ||
    query.deadlineTo !== "" ||
    query.sort !== DEFAULT_QUERY.sort;

  const items = data?.items ?? [];

  return (
    <div className="space-y-gutter">
      <PageHeader
        title="Review Queue"
        description="One row per data record: the engine's latest retention advice. Recording a decision only endorses a recommendation for a later, separately authorized workflow — nothing here archives, restores or deletes a file."
      />

      {outcome ? (
        <OutcomeBanner message={outcome} onDismiss={() => setOutcome(null)} />
      ) : null}

      <FilterCard
        query={query}
        filtersActive={filtersActive}
        onChange={update}
        onClear={() => setQuery({ ...DEFAULT_QUERY, page: 1 })}
      />

      {error ? (
        <ErrorState title="Review queue unavailable" message={error} onRetry={refetch} />
      ) : null}

      {loading && data === null ? <Spinner label="Loading review queue..." /> : null}

      {data !== null ? (
        <Card>
          <CardHeader
            title={`Recommendations (${data.total})`}
            description={`${scopeSentence(data.total, items.length, activeInstitutionId)} ${
              query.sort === "age"
                ? "Ordered oldest assessment first, as the server sorts it."
                : "Ordered by urgency as the server computes it: hold-blocked assets first, then the earliest retention deadline, then the oldest assessment."
            } One row per asset — the newest assessment of that asset.`}
            action={
              loading ? (
                <span role="status" className="text-meta text-ink-muted">
                  Refreshing…
                </span>
              ) : undefined
            }
          />

          {items.length === 0 ? (
            <CardBody>
              <EmptyState
                title="No items in the review queue"
                message={
                  filtersActive
                    ? "No assessed asset in the current scope matches these filters. Clear a filter, or change the institution scope in the sidebar. An empty queue never implies that any asset is eligible for disposal — it only means this view found no assessment to show."
                    : "No asset in this scope has been assessed yet. An assessment is created by an explicit request against one asset; reading this queue never creates or refreshes one. An empty queue never implies that any asset is eligible for disposal."
                }
              />
            </CardBody>
          ) : (
            <QueueTable
              items={items}
              canDecide={canDecide}
              onDetails={(item) => setDialog({ kind: "details", item })}
              onDecide={(item) => setDialog({ kind: "decide", item })}
            />
          )}

          <Pagination
            page={query.page}
            pages={Math.max(1, data.pages)}
            total={data.total}
            onPrevious={() => update({ page: Math.max(1, query.page - 1) })}
            onNext={() => update({ page: query.page + 1 })}
          />
        </Card>
      ) : null}

      {dialog?.kind === "details" ? (
        <DetailsDialog item={dialog.item} onClose={() => setDialog(null)} />
      ) : null}

      {dialog?.kind === "decide" && dialog.item.id !== null ? (
        <DecideDialog
          item={dialog.item}
          assessmentId={dialog.item.id}
          onClose={() => setDialog(null)}
          onReload={() => {
            // A refused decision means the row on screen is no longer what the
            // server holds. The operator asks for the current queue; the page
            // never reloads over the top of a refusal by itself.
            setDialog(null);
            refetch();
          }}
          onRecorded={(message) => {
            setDialog(null);
            setOutcome(message);
            refetch();
          }}
        />
      ) : null}
    </div>
  );
}

/* --------------------------------- banner --------------------------------- */

function OutcomeBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-start justify-between gap-3 rounded-card border border-info-line bg-info-surface px-card-x py-card-y"
    >
      <p className="text-supporting text-info-ink">{message}</p>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

/* --------------------------------- filters -------------------------------- */

function FilterCard({
  query,
  filtersActive,
  onChange,
  onClear,
}: {
  query: QueueQuery;
  filtersActive: boolean;
  onChange: (patch: Partial<QueueQuery>) => void;
  onClear: () => void;
}) {
  const advancedActive =
    query.sort !== DEFAULT_QUERY.sort ||
    query.assessedFrom !== "" ||
    query.assessedTo !== "" ||
    query.deadlineFrom !== "" ||
    query.deadlineTo !== "";

  const [showAdvanced, setShowAdvanced] = useState(advancedActive);

  return (
    <Card>
      <CardHeader
        title="Find recommendations"
        description="Search by one of the four common filters here; sorting and date ranges are under More filters. Every control is a parameter on the queue request, so the rows that come back are the server's own. A short pause after typing is treated as the end of the search term."
      />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Field
            label="Search the queue"
            hint="The server matches asset title, external id and file name. It does not search rationale text or findings."
            className="sm:col-span-2"
          >
            {(control) => (
              <Input
                {...control}
                type="search"
                value={query.search}
                onChange={(event) => onChange({ search: event.target.value })}
                placeholder="Title, external id, or file name"
              />
            )}
          </Field>
          <Field
            label="Review status"
            hint="open means no decision is recorded on this assessment; decided means one is."
          >
            {(control) => (
              <Select
                {...control}
                value={query.reviewStatus}
                onChange={(event) => onChange({ reviewStatus: event.target.value })}
              >
                <option value="">Any review status</option>
                {REVIEW_STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Recommendation"
            hint="ARCHIVE_RECOMMENDED is a value the API accepts but the assessment engine never writes, so choosing it returns an empty queue."
          >
            {(control) => (
              <Select
                {...control}
                value={query.recommendation}
                onChange={(event) => onChange({ recommendation: event.target.value })}
              >
                <option value="">Any recommendation</option>
                {RECOMMENDATION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Severity"
            hint="The most urgent finding severity on the latest assessment. It is not a lifecycle priority, and an assessment with no findings has none."
          >
            {(control) => (
              <Select
                {...control}
                value={query.severity}
                onChange={(event) => onChange({ severity: event.target.value })}
              >
                <option value="">Any severity</option>
                {SEVERITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="sm:col-span-2 xl:col-span-4">
            <details
              open={showAdvanced}
              onToggle={(event) => setShowAdvanced(event.currentTarget.open)}
              className="rounded-card border border-line bg-surface-sunken px-card-x py-row-y"
            >
              <summary className="cursor-pointer text-supporting font-medium text-ink-secondary">
                More filters
              </summary>
              <p className="mt-1 text-meta text-ink-muted">
                Sort order and date ranges. Everything here is a parameter on the same queue
                request, so the rows that come back are the server's own.
              </p>
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <Field label="Sort by" hint="The two orders the queue route implements.">
                  {(control) => (
                    <Select
                      {...control}
                      value={query.sort}
                      onChange={(event) => onChange({ sort: event.target.value })}
                    >
                      {SORT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field
                  label="Assessed on or after"
                  hint="Inclusive lower bound on the assessment timestamp, sent as 00:00:00 of the chosen day."
                >
                  {(control) => (
                    <Input
                      {...control}
                      type="date"
                      value={query.assessedFrom}
                      onChange={(event) => onChange({ assessedFrom: event.target.value })}
                    />
                  )}
                </Field>
                <Field
                  label="Assessed on or before"
                  hint="Inclusive upper bound, sent as 23:59:59 of the chosen day so the whole day is covered."
                >
                  {(control) => (
                    <Input
                      {...control}
                      type="date"
                      value={query.assessedTo}
                      onChange={(event) => onChange({ assessedTo: event.target.value })}
                    />
                  )}
                </Field>
                <Field
                  label="Retention deadline on or after"
                  hint="Inclusive lower bound on the retention deadline; an assessment that stored no deadline is excluded whenever a deadline bound is set."
                >
                  {(control) => (
                    <Input
                      {...control}
                      type="date"
                      value={query.deadlineFrom}
                      onChange={(event) => onChange({ deadlineFrom: event.target.value })}
                    />
                  )}
                </Field>
                <Field
                  label="Retention deadline on or before"
                  hint="Inclusive upper bound, sent as the bare date because this parameter is a date rather than a timestamp."
                >
                  {(control) => (
                    <Input
                      {...control}
                      type="date"
                      value={query.deadlineTo}
                      onChange={(event) => onChange({ deadlineTo: event.target.value })}
                    />
                  )}
                </Field>
              </div>
            </details>
          </div>
        </div>
        {filtersActive ? (
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear filters
          </Button>
        ) : null}
      </CardBody>
    </Card>
  );
}

/* ---------------------------------- table --------------------------------- */

function QueueTable({
  items,
  canDecide,
  onDetails,
  onDecide,
}: {
  items: RecommendationItem[];
  canDecide: boolean;
  onDetails: (item: RecommendationItem) => void;
  onDecide: (item: RecommendationItem) => void;
}) {
  return (
    <Table caption="Retention recommendations, one row per assessed asset">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Asset</TableHeaderCell>
          <TableHeaderCell>Recommendation</TableHeaderCell>
          <TableHeaderCell>Severity</TableHeaderCell>
          <TableHeaderCell>Review</TableHeaderCell>
          <TableHeaderCell>Holds</TableHeaderCell>
          <TableHeaderCell className="hidden lg:table-cell">Deadline</TableHeaderCell>
          <TableHeaderCell className="hidden xl:table-cell">Assessed</TableHeaderCell>
          <TableHeaderCell align="right">Actions</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {items.map((item) => (
          <QueueRow
            key={item.id ?? `${item.asset_id}-${item.assessed_at}`}
            item={item}
            canDecide={canDecide}
            onDetails={() => onDetails(item)}
            onDecide={() => onDecide(item)}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function QueueRow({
  item,
  canDecide,
  onDetails,
  onDecide,
}: {
  item: RecommendationItem;
  canDecide: boolean;
  onDetails: () => void;
  onDecide: () => void;
}) {
  const overdue = (item.days_overdue ?? 0) > 0;
  const decided = item.review_status === "decided";
  // A decision is recorded against an assessment id, and each assessment takes
  // exactly one. Without the id there is nothing to decide on, and once one is
  // recorded the only path forward is a fresh assessment.
  const decidable = canDecide && !decided && item.id !== null;

  return (
    <TableRow>
      <TableCell className="max-w-sm">
        <p className="break-words font-medium text-ink">
          {item.asset_title ?? `Asset #${item.asset_id}`}
        </p>
        <p className="mt-0.5 font-mono text-meta text-ink-muted">
          asset {item.asset_id}
          {item.institution_id !== null ? ` · institution ${item.institution_id}` : ""}
        </p>
        <p className="mt-0.5 font-mono text-meta text-ink-muted">
          {item.id === null ? "no assessment id returned" : `assessment ${item.id}`}
        </p>
      </TableCell>
      <TableCell className="max-w-xs">
        <Badge tone={toneForRecommendation(item.recommendation)}>
          {recommendationLabel(item.recommendation)}
        </Badge>
        <p className="mt-1 break-words text-meta text-ink-muted" title={item.rationale}>
          {item.rationale}
        </p>
      </TableCell>
      <TableCell>
        {item.severity ? (
          <Badge tone={toneForSeverity(item.severity)}>{item.severity}</Badge>
        ) : (
          <p className="whitespace-nowrap text-meta text-ink-muted">None</p>
        )}
        <p className="mt-1 text-meta text-ink-muted">{severitySentence(item.severity)}</p>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={toneForReviewStatus(item.review_status ?? "open")}>
            {decided ? "decided" : "open"}
          </Badge>
          {item.latest_decision ? (
            <Badge tone={toneForDecision(item.latest_decision)}>
              {decisionLabel(item.latest_decision)}
            </Badge>
          ) : null}
        </div>
        <p className="mt-1 text-meta whitespace-nowrap text-ink-muted">
          {item.decisions_recorded} recorded
        </p>
      </TableCell>
      <TableCell>
        {item.holds_active > 0 ? (
          <Badge tone="critical">{item.holds_active} active</Badge>
        ) : (
          <span className="text-ink-muted">None</span>
        )}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap lg:table-cell">
        {item.retention_deadline ? (
          <>
            <p>{formatDate(item.retention_deadline)}</p>
            {overdue ? (
              <p className="mt-0.5 text-meta text-critical-ink">{item.days_overdue} d past</p>
            ) : null}
          </>
        ) : (
          <p className="text-ink-muted">No deadline</p>
        )}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap xl:table-cell">
        {formatDate(item.assessed_at.slice(0, 10))}
      </TableCell>
      <TableCell align="right">
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onDetails}>
            Review evidence
          </Button>
          {decidable ? (
            <Button variant="primary" size="sm" onClick={onDecide}>
              Record decision
            </Button>
          ) : null}
          <Link
            to={`/governance/assets/${item.asset_id}`}
            className="inline-flex items-center whitespace-nowrap rounded-control text-meta font-medium text-accent-ink transition-colors hover:text-accent hover:underline"
          >
            Open governance view
          </Link>
        </div>
      </TableCell>
    </TableRow>
  );
}

/* -------------------------------- details --------------------------------- */

function DetailRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-line py-2 last:border-b-0 sm:grid-cols-3">
      <dt className="text-meta font-semibold uppercase tracking-wide text-ink-muted">{term}</dt>
      <dd className="break-words text-supporting text-ink-secondary sm:col-span-2">{children}</dd>
    </div>
  );
}

/** Evidence is a free-form JSON object; it is shown as stored, not interpreted. */
function evidenceWords(evidence: Record<string, unknown> | null): string {
  if (evidence === null || Object.keys(evidence).length === 0) {
    return "No evidence recorded";
  }
  return Object.entries(evidence)
    .map(([key, value]) => `${key} ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" · ");
}

function FindingBlock({ finding }: { finding: AssessmentFinding }) {
  return (
    <div className="rounded-card border border-line bg-surface-sunken px-card-x py-card-y">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={toneForSeverity(finding.severity)}>{finding.severity}</Badge>
        <p className="font-mono text-meta text-ink">{finding.code}</p>
      </div>
      <p className="mt-1 break-words text-supporting text-ink-secondary">{finding.message}</p>
      <p className="mt-1 break-words font-mono text-meta text-ink-muted">
        {evidenceWords(finding.evidence)}
      </p>
    </div>
  );
}

function DetailsDialog({ item, onClose }: { item: RecommendationItem; onClose: () => void }) {
  const findings = item.findings ?? [];
  return (
    <Dialog
      open
      width="lg"
      title={`Evidence for ${item.asset_title ?? `asset #${item.asset_id}`}`}
      description="Everything below is what this queue row carried. The queue returns no rule catalogue, no affected-asset list and no audit trail, so this view adds none: the governance view holds the assessment and decision history for the asset."
      onClose={onClose}
      footer={
        <>
          <Link
            to={`/governance/assets/${item.asset_id}`}
            className="inline-flex items-center whitespace-nowrap rounded-control text-meta font-medium text-accent-ink transition-colors hover:text-accent hover:underline"
          >
            Open governance view
          </Link>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <dl className="rounded-card border border-line px-card-x">
          <DetailRow term="Recommendation">
            <Badge tone={toneForRecommendation(item.recommendation)}>
              {recommendationLabel(item.recommendation)}
            </Badge>
          </DetailRow>
          <DetailRow term="Why this row exists">{item.rationale}</DetailRow>
          <DetailRow term="Review status">
            {item.review_status === "decided"
              ? `decided — ${
                  item.latest_decision ? decisionLabel(item.latest_decision) : "no value returned"
                } (${item.decisions_recorded} decision recorded on this assessment)`
              : `open — no decision is recorded on this assessment (${item.decisions_recorded} recorded)`}
          </DetailRow>
          <DetailRow term="Assessment">
            <span className="font-mono">{item.id === null ? "none returned" : `#${item.id}`}</span>{" "}
            · assessed {formatDate(item.assessed_at.slice(0, 10))} (
            <span className="font-mono">{item.assessed_at}</span>)
          </DetailRow>
          <DetailRow term="Applicable policy">
            {item.policy_id === null
              ? "None — the engine recorded no policy for this assessment"
              : `policy #${item.policy_id}`}
            {item.policy_version_id !== null
              ? ` · version #${item.policy_version_id}` +
                (item.policy_version_number !== null
                  ? ` (number ${item.policy_version_number})`
                  : " (no version number returned)")
              : ""}
          </DetailRow>
          <DetailRow term="Active holds">
            {item.holds_active > 0
              ? `${item.holds_active} active at assessment time. This is the snapshot the assessment stored, not a live count: the decision endpoint re-counts, so a hold released or placed since then changes what the server accepts.`
              : "None recorded on this assessment. The decision endpoint re-counts live holds before it accepts an approval."}
          </DetailRow>
          <DetailRow term="Retention deadline">
            {item.retention_deadline ? (
              <>
                {formatDate(item.retention_deadline)}
                {item.days_overdue !== null
                  ? ` · days_overdue ${item.days_overdue} as the server computed it (negative means the deadline has not arrived)`
                  : ""}
              </>
            ) : (
              "None — the engine only sets a deadline for RETAIN and DISPOSAL_REVIEW_REQUIRED"
            )}
          </DetailRow>
          <DetailRow term="Severity">
            {item.severity ? (
              <Badge tone={toneForSeverity(item.severity)}>{item.severity}</Badge>
            ) : (
              "None — this assessment recorded no findings"
            )}
          </DetailRow>
          <DetailRow term="Asset">
            <span className="font-mono">#{item.asset_id}</span>
            {item.institution_id !== null ? ` · institution #${item.institution_id}` : ""}
          </DetailRow>
        </dl>

        <section>
          <h3 className="text-body font-semibold text-ink">
            Findings ({findings.length})
          </h3>
          {findings.length === 0 ? (
            <p className="mt-1 text-supporting text-ink-secondary">
              This assessment returned no findings, which is why severity is empty. The rationale
              above is the engine's whole explanation for this row.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {findings.map((finding, index) => (
                <li key={`${finding.code}-${index}`}>
                  <FindingBlock finding={finding} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Dialog>
  );
}

/* ------------------------------- decision --------------------------------- */

/**
 * The refusal a 409 carries, named.
 *
 * The backend puts its machine-readable token inside the `detail` string and
 * `ApiError` exposes only that string, so the prefixes are matched literally
 * and an unrecognised 409 is reported as a conflict without inventing a cause.
 */
function conflictHeading(detail: string): string {
  if (detail.startsWith("stale_review_conflict")) {
    return "This review is out of date";
  }
  if (detail.startsWith("hold_conflict")) {
    return "Blocked by an active hold";
  }
  if (detail.includes("already has a recorded decision")) {
    return "A decision is already recorded for this assessment";
  }
  // The route rewrites `supersession_*` codes into prose (`routes/retention.py:373`);
  // the cycle refusal says "supersession" and the others say "supersede".
  if (detail.includes("supersede") || detail.includes("supersession")) {
    return "The correction target was refused";
  }
  return "The server rejected this decision";
}

function DecideDialog({
  item,
  assessmentId,
  onClose,
  onReload,
  onRecorded,
}: {
  item: RecommendationItem;
  /** The queue row's own assessment id, narrowed by the caller: a decision is
   *  recorded against an assessment, and a row without one cannot be decided. */
  assessmentId: number;
  onClose: () => void;
  /** Re-read the queue at the operator's request, after a refusal. */
  onReload: () => void;
  onRecorded: (message: string) => void;
}) {
  const [decision, setDecision] = useState<DecisionValue>("retain");
  const [reason, setReason] = useState("");
  const [supersedes, setSupersedes] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // Earlier decisions on this asset's lineage that a correction may replace.
  // The server computes the list, so the form can only offer real targets.
  const candidates = useApiQuery(
    (signal) => listSupersessionCandidates(assessmentId, signal),
    [assessmentId],
  );
  const options = candidates.data ?? [];
  const supersedesId = supersedes === "" ? null : Number(supersedes);

  const blockedByHold = item.holds_active > 0;
  const requiresSubstantiveReason =
    decision === "reject" || decision === "request_more_information" || supersedesId !== null;
  const reasonTooShort =
    requiresSubstantiveReason && reason.trim().length < SUBSTANTIVE_REASON_MIN;

  // A hold blocks approving a lifecycle-advancing recommendation; the server
  // refuses it with `hold_conflict`, so the choice is closed rather than offered.
  useEffect(() => {
    if (blockedByHold && decision === "approve_for_later_workflow") {
      setDecision("retain");
    }
  }, [blockedByHold, decision]);

  // An async refusal moves focus to what changed: the conflict panel, or the
  // reason the server gave. The confirm button is disabled while busy, so
  // without this the pointer and the screen reader are left on nothing.
  useEffect(() => {
    if (busy) {
      return;
    }
    if (conflict !== null) {
      alertRef.current?.focus();
    } else if (error !== null) {
      errorRef.current?.focus();
    }
  }, [busy, conflict, error]);

  function reasonError(): string | null {
    if (reason.trim().length === 0) {
      return "A reason is required: the decision row stores it and the audit trail links to it.";
    }
    if (reasonTooShort && requiresSubstantiveReason) {
      // The same order the backend validator uses (`schemas/retention.py:214`),
      // so the refusal named here is the refusal the server would name.
      if (decision === "reject" || decision === "request_more_information") {
        return "A rejection or request for more information needs a substantive reason (at least 10 characters).";
      }
      return "A decision that supersedes an earlier decision needs a substantive reason (at least 10 characters) explaining the correction.";
    }
    return null;
  }

  const canSubmit = !busy && reasonError() === null;

  // Escape, the close icon and the Cancel button all arrive here. While a
  // decision is in flight the dialog stays: the server is still writing, and a
  // dialog that vanished mid-request would leave the operator without an answer.
  function requestClose(): void {
    if (!busy) {
      onClose();
    }
  }

  async function submit(): Promise<void> {
    if (!canSubmit) {
      return;
    }
    setError(null);
    setConflict(null);
    setBusy(true);
    try {
      const recorded = await createDecision(
        assessmentId,
        {
          decision,
          reason: reason.trim(),
          supersedes_decision_id: supersedesId,
          expected_assessed_at: item.assessed_at,
          expected_policy_version_id: item.policy_version_id,
          expected_holds_active: item.holds_active,
        },
        item.institution_id ?? undefined,
      );
      onRecorded(
        `Decision "${decisionLabel(recorded.decision)}" recorded on assessment #${
          recorded.assessment_id
        } for ${item.asset_title ?? `asset #${item.asset_id}`} (decision #${recorded.id} by ${
          recorded.reviewer
        }, ${formatDate(recorded.decided_at.slice(0, 10))}). ` +
          (recorded.supersedes_decision_id !== null
            ? `It supersedes decision #${recorded.supersedes_decision_id}, which stays in the history. `
            : "") +
          "The assessment is now decided. Nothing was archived, restored or deleted.",
      );
    } catch (cause) {
      const message = toErrorMessage(cause);
      if (cause instanceof ApiError && cause.status === 409) {
        setConflict(message);
      } else {
        setError(message);
      }
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      width="lg"
      title="Record a review decision"
      description="A human decision, recorded against the exact assessment and policy version shown below. It executes nothing: approving a recommendation endorses it for a later, separately authorized workflow, and no file is archived, restored or deleted."
      onClose={requestClose}
      dismissOnBackdrop={!busy}
      footer={
        confirming ? (
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Back to the form
            </Button>
            <Button variant="primary" loading={busy} disabled={!canSubmit} onClick={submit}>
              Confirm and record
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!canSubmit}
              onClick={() => setConfirming(true)}
            >
              Review this decision before recording
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {conflict !== null ? (
          <div
            ref={alertRef}
            tabIndex={-1}
            role="alert"
            className="rounded-card border border-warning-line bg-warning-surface px-card-x py-card-y text-supporting text-warning-ink focus:outline-none"
          >
            <p className="text-body font-semibold">{conflictHeading(conflict)}</p>
            <p className="mt-1 break-words">{conflict}</p>
            <p className="mt-1">
              Nothing was recorded and this form still holds what you typed. The row this form was
              opened from may no longer match the server, so re-read the queue before deciding
              again.
            </p>
            <p className="mt-1 text-meta">
              A stale or hold-conflict refusal is written to the server's audit trail even though no
              decision row is created.
            </p>
            <Button className="mt-2" variant="secondary" size="sm" onClick={onReload}>
              Reload the queue
            </Button>
          </div>
        ) : null}

        {error !== null ? (
          <div className="rounded-card border border-critical-line bg-critical-surface px-card-x py-card-y">
            <p className="text-body font-semibold text-critical-ink">Decision not recorded</p>
            <ServerMessage error={error} busy={busy} errorRef={errorRef} />
            <Button className="mt-2" variant="secondary" size="sm" onClick={onReload}>
              Reload the queue
            </Button>
          </div>
        ) : null}

        <div className="rounded-card border border-line bg-surface-sunken px-card-x py-card-y text-supporting text-ink-secondary">
          <p className="font-medium text-ink">
            {item.asset_title ?? `Asset #${item.asset_id}`} ·{" "}
            <span className="font-mono">assessment #{assessmentId}</span>
          </p>
          <p className="mt-1">
            Recommendation {recommendationLabel(item.recommendation)} · assessed{" "}
            {formatDate(item.assessed_at.slice(0, 10))} · policy version{" "}
            {item.policy_version_id === null
              ? "none"
              : `#${item.policy_version_id}` +
                (item.policy_version_number !== null
                  ? ` (number ${item.policy_version_number})`
                  : "")}{" "}
            · {item.holds_active} active hold{item.holds_active === 1 ? "" : "s"} at assessment time.
          </p>
          <p className="mt-1 text-meta text-ink-muted">
            These three values are sent as the concurrency tokens. If the assessment, the applicable
            policy version or the live hold count has moved since this row loaded, the server
            refuses the decision as stale so it is never recorded against the wrong version.
          </p>
        </div>

        {blockedByHold ? (
          <p role="status" className="text-supporting text-critical-ink">
            This assessment recorded {item.holds_active} active hold
            {item.holds_active === 1 ? "" : "s"}, so approving a lifecycle-advancing recommendation
            is refused by the server. Retain, request more information and reject remain available.
          </p>
        ) : null}

        {confirming ? (
          <div className="rounded-card border border-accent-line bg-accent-surface px-card-x py-card-y">
            <h3 className="text-body font-semibold text-accent-ink">
              Confirm: record {decisionLabel(decision)}
            </h3>
            <p className="mt-1 text-supporting text-accent-ink">
              This appends one decision row against assessment #{assessmentId} and marks that
              assessment decided. It cannot be edited or undone from this page.
            </p>
            <dl className="mt-2 space-y-1 text-supporting">
              <div className="flex flex-wrap gap-2">
                <dt className="font-medium text-ink">Asset</dt>
                <dd className="break-words text-ink-secondary">
                  {item.asset_title ?? "untitled"} (#{item.asset_id})
                </dd>
              </div>
              <div className="flex flex-wrap gap-2">
                <dt className="font-medium text-ink">Recommendation</dt>
                <dd className="text-ink-secondary">
                  {recommendationLabel(item.recommendation)}
                </dd>
              </div>
              <div className="flex flex-wrap gap-2">
                <dt className="font-medium text-ink">Decision</dt>
                <dd className="text-ink-secondary">{decisionLabel(decision)}</dd>
              </div>
              <div className="flex flex-wrap gap-2">
                <dt className="font-medium text-ink">Reason</dt>
                <dd className="break-words text-ink-secondary">{reason.trim()}</dd>
              </div>
              <div className="flex flex-wrap gap-2">
                <dt className="font-medium text-ink">Correction</dt>
                <dd className="text-ink-secondary">
                  {supersedesId === null
                    ? "Independent decision — replaces no earlier decision"
                    : `Supersedes decision #${supersedesId}`}
                </dd>
              </div>
            </dl>
          </div>
        ) : (
          <div className="space-y-4">
            <Field
              label="Decision"
              hint="The four values the decision endpoint accepts. There is no dismiss, apply or complete."
            >
              {(control) => (
                <Select
                  {...control}
                  value={decision}
                  onChange={(event) => setDecision(event.target.value as DecisionValue)}
                >
                  {DECISION_OPTIONS.map((option) => (
                    <option
                      key={option.value}
                      value={option.value}
                      disabled={
                        option.value === "approve_for_later_workflow" && blockedByHold
                      }
                    >
                      {option.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            {options.length > 0 ? (
              <Field
                label="Correction"
                hint="Earlier decisions on this asset's lineage that the server says this decision may replace. Choosing one makes this a correction; the earlier decision stays visible in the history."
              >
                {(control) => (
                  <Select
                    {...control}
                    value={supersedes}
                    onChange={(event) => setSupersedes(event.target.value)}
                  >
                    <option value="">
                      Independent decision — does not replace any earlier decision
                    </option>
                    {options.map((candidate) => (
                      <option key={candidate.id} value={String(candidate.id)}>
                        #{candidate.id} · {decisionLabel(candidate.decision)} on assessment #
                        {candidate.assessment_id} · {formatDate(candidate.decided_at.slice(0, 10))}
                        {candidate.is_superseded ? " · already superseded" : ""}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : (
              <p className="text-meta text-ink-muted">
                {candidates.loading
                  ? "Checking whether this asset has an earlier decision to correct…"
                  : "The server reports no earlier decision on this asset that this one may supersede, so this is an original decision."}
              </p>
            )}

            <Field
              label="Reason"
              required
              error={reason.length > 0 ? reasonError() : null}
              hint={`Stored verbatim on the decision row and linked from the audit trail. At least ${SUBSTANTIVE_REASON_MIN} characters for a rejection, a request for more information, or a correction.`}
            >
              {(control) => (
                <Textarea
                  {...control}
                  value={reason}
                  invalid={reason.length > 0 && reasonError() !== null}
                  maxLength={REASON_MAX}
                  rows={4}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Why this decision, in the operator's own words"
                />
              )}
            </Field>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/* --------------------------------- shared --------------------------------- */

/**
 * The server's own refusal, verbatim, in a region that can be focused.
 *
 * No token, stack trace or internal detail is added: the `detail` string is
 * what the route chose to return.
 */
function ServerMessage({
  error,
  busy,
  errorRef,
}: {
  error: string | null;
  busy: boolean;
  errorRef?: Ref<HTMLParagraphElement>;
}) {
  if (error === null || busy) {
    return null;
  }
  return (
    <p
      ref={errorRef}
      tabIndex={-1}
      role="alert"
      className="mt-1 break-words text-supporting text-critical-ink focus:outline-none"
    >
      {error}
    </p>
  );
}

function Pagination({
  page,
  pages,
  total,
  onPrevious,
  onNext,
}: {
  page: number;
  pages: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <nav
      aria-label="Recommendation pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-card-x py-3"
    >
      <Button
        variant="secondary"
        size="sm"
        disabled={page <= 1}
        onClick={onPrevious}
        className="gap-1"
      >
        <IconChevronLeft className="h-4 w-4" />
        Previous
      </Button>
      <p className="text-meta text-ink-muted tabular-nums">
        Page {page} of {pages} · {total} assessed asset{total === 1 ? "" : "s"} matching
      </p>
      <Button
        variant="secondary"
        size="sm"
        disabled={page >= pages}
        onClick={onNext}
        className="gap-1"
      >
        Next
        <IconChevronRight className="h-4 w-4" />
      </Button>
    </nav>
  );
}
