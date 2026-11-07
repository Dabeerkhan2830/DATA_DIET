/**
 * Scan jobs (redesign Phase 5.8).
 *
 * Reads the real `scan_jobs` table through the connector API and offers only the
 * operations the backend actually implements.
 *
 * The contract was read out of `backend/app/api/routes/connectors.py`,
 * `backend/app/api/schemas/connectors.py` and `backend/app/services/scan.py`.
 * Three of its facts decide the whole design:
 *
 * - **A scan runs inside the request.** `_create_and_maybe_run` calls
 *   `run_scan` before FastAPI answers, and `retry_scan` and the run endpoint do
 *   the same. There is no queue, no worker, no scheduler and no `BackgroundTasks`
 *   anywhere in the backend, so the job returned by a start is already terminal.
 *   This screen therefore **does not poll** and shows no progress bar: there is
 *   no in-between state to observe, and `ScanJobRead` has no percentage field —
 *   only the absolute `total_discovered` / `total_imported` / `total_skipped` /
 *   `total_errors` counters. `RUNNING` is not externally observable; `PENDING`
 *   only exists for a job created with `run: false`.
 * - **The state machine is closed.** `VALID_TRANSITIONS` allows
 *   `PENDING → RUNNING | CANCELLED` and `RUNNING → terminal`, with every
 *   terminal state frozen. Cancelling a finished job, running a job that has
 *   already run, and retrying a clean `COMPLETED` scan are each refused with 409
 *   whose detail names the status the server found. The buttons follow that
 *   table, and a refusal is reported as a conflict, not as a failure to retry.
 * - **A retry creates a new job.** `POST /scan-jobs/{id}/retry` returns 201 with
 *   a fresh row whose `retried_from_job_id` points back; the original row keeps
 *   its status and counters. Nothing is re-run in place.
 *
 * Also honoured: `GET /scan-jobs` paginates (`per_page` ≤ 100, newest first by
 * id) and filters by `data_source_id` and `status`, while the per-record
 * `results` and `errors` routes paginate at `per_page` 50 (max 200) and accept no
 * filter at all. Job details never claim a record was archived, restored or
 * deleted: a scan discovers metadata and writes inventory rows, and the
 * `local_folder` connector reads no file contents.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import { ApiError, toErrorMessage } from "../api/client";
import {
  cancelScanJob,
  listScanErrors,
  listScanJobs,
  listScanResults,
  listSources,
  retryScanJob,
  runScanJob,
  startScan,
} from "../api/sources";
import type {
  ScanError,
  ScanErrorListResponse,
  ScanJob,
  ScanResult,
  ScanResultListResponse,
  ScanStatus,
  Source,
} from "../api/types";
import { useApiQuery } from "../hooks/useApiQuery";
import { useAuth } from "../auth/AuthContext";
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
import { Tabs } from "../components/ui/Tabs";
import { IconChevronLeft, IconChevronRight } from "../components/icons";
import { formatBytes, humanize } from "../lib/format";
import {
  toneForScanOutcome,
  toneForScanSeverity,
  toneForScanStatus,
  type Tone,
} from "../lib/semantic";

/** `GET /scan-jobs` defaults `per_page` to 20 and caps it at 100. */
const PER_PAGE = 20;

/** The per-record routes default to 50 rows and cap at 200. */
const ROWS_PER_PAGE = 50;

/** `ScanRequest.batch_size` is `Field(default=None, ge=1, le=5000)`. */
const BATCH_MIN = 1;
const BATCH_MAX = 5000;

/** How long the source-id box must be idle before the server is re-queried. */
const TEXT_DEBOUNCE_MS = 300;

/** The six values `ScanStatus` accepts — the server's own vocabulary. */
const SCAN_STATUSES: Array<{ value: ScanStatus; label: string }> = [
  { value: "PENDING", label: "Queued" },
  { value: "RUNNING", label: "Running" },
  { value: "COMPLETED", label: "Completed" },
  { value: "COMPLETED_WITH_ERRORS", label: "Completed with errors" },
  { value: "FAILED", label: "Failed" },
  { value: "CANCELLED", label: "Cancelled" },
];

type JobDialog =
  | { kind: "start" }
  | { kind: "action"; action: JobAction; job: ScanJob }
  | { kind: "details"; job: ScanJob }
  | { kind: "rows"; job: ScanJob }
  | null;

type JobAction = "run" | "cancel" | "retry";

interface Query {
  page: number;
  status: ScanStatus | "";
  sourceId: string;
}

const DEFAULT_QUERY: Query = { page: 1, status: "", sourceId: "" };

/* --------------------------- the state machine ---------------------------- */

/**
 * `VALID_TRANSITIONS` in `app/services/scan.py`: only a queued job can start.
 * The run endpoint answers `Cannot run a scan in status {status!r}` otherwise.
 */
function canRun(status: ScanStatus): boolean {
  return status === "PENDING";
}

/** `cancel_job` allows `PENDING` or `RUNNING` to reach `CANCELLED`. */
function canCancel(status: ScanStatus): boolean {
  return status === "PENDING" || status === "RUNNING";
}

/** The three states `retry_scan` accepts; a clean `COMPLETED` is refused. */
function canRetry(status: ScanStatus): boolean {
  return status === "FAILED" || status === "COMPLETED_WITH_ERRORS" || status === "CANCELLED";
}

/* ------------------------------- row vocabulary ---------------------------- */

/** The status string is the server's; an unexpected value keeps its own colour. */
function scanStatusTone(status: ScanStatus): Tone {
  return SCAN_STATUSES.some((item) => item.value === status)
    ? toneForScanStatus(status)
    : "neutral";
}

function asDate(iso: string): string {
  return iso.slice(0, 10);
}

/** One sentence about what the counters say. Absolute numbers, never a share. */
function counterSentence(job: ScanJob): string {
  return `${job.total_discovered} discovered, ${job.total_imported} imported, ` +
    `${job.total_skipped} skipped, ${job.total_errors} error rows`;
}

/**
 * Returns `value` once it has stopped changing for `delayMs`, so a typed id does
 * not fire a request per keystroke. Page changes are never debounced.
 */
function useSettledValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}

export default function Scans() {
  const { activeInstitutionId, has } = useAuth();
  const canWrite = has("sources:write");

  const [query, setQuery] = useState<Query>(DEFAULT_QUERY);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [dialog, setDialog] = useState<JobDialog>(null);
  /** Which job's write is in flight; a second one is refused while it runs. */
  const [busyJobId, setBusyJobId] = useState<number | null>(null);

  const settledSourceId = useSettledValue(query.sourceId.trim(), TEXT_DEBOUNCE_MS);
  const sourceIdFilter = /^\d+$/.test(settledSourceId) ? Number(settledSourceId) : undefined;
  const invalidSourceId = settledSourceId !== "" && sourceIdFilter === undefined;

  const { data, loading, error, refetch } = useApiQuery(
    (signal) =>
      listScanJobs(
        {
          page: query.page,
          per_page: PER_PAGE,
          status: query.status,
          data_source_id: sourceIdFilter,
          institution_id: activeInstitutionId ?? undefined,
        },
        signal,
      ),
    [query.page, query.status, sourceIdFilter, activeInstitutionId],
  );

  /**
   * The source records, used to name a job's source. The list route caps a page
   * at 100 and orders by name, so a job whose source is outside that page keeps
   * its bare id rather than a guessed label.
   */
  const { data: sourcePage } = useApiQuery(
    (signal) =>
      listSources(
        { per_page: 100, institution_id: activeInstitutionId ?? undefined },
        signal,
      ),
    [activeInstitutionId],
  );

  const sourceNames = useMemo(() => {
    const map = new Map<number, string>();
    for (const source of sourcePage?.items ?? []) {
      map.set(source.id, source.name);
    }
    return map;
  }, [sourcePage]);

  const filtersActive = query.status !== "" || settledSourceId !== "";

  function update(patch: Partial<Query>): void {
    setQuery((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  async function runAction(action: JobAction, job: ScanJob): Promise<ScanJob> {
    setBusyJobId(job.id);
    try {
      const institutionId = activeInstitutionId ?? undefined;
      if (action === "run") {
        return await runScanJob(job.id, institutionId);
      }
      if (action === "cancel") {
        return await cancelScanJob(job.id, institutionId);
      }
      return await retryScanJob(job.id, institutionId);
    } finally {
      setBusyJobId(null);
    }
  }

  function describeOutcome(action: JobAction, before: ScanJob, after: ScanJob): string {
    if (action === "cancel") {
      return `Scan #${after.id} (source #${after.data_source_id}) is now ` +
        `"${after.status}". Its counters stay where the server left them: ` +
        `${counterSentence(after)}. Cancelling marks the job — it does not stop ` +
        "anything already running inside another request, and no record is " +
        "deleted or unwritten.";
    }
    if (action === "retry") {
      return `Retrying scan #${before.id} created a new job #${after.id} ` +
        `(retried_from_job_id #${before.id}) which ran to "${after.status}": ` +
        `${counterSentence(after)}. The original row is unchanged. A retry is a ` +
        "fresh discovery run over the same source, not a continuation.";
    }
    return `Scan #${after.id} (source #${after.data_source_id}) finished as ` +
      `"${after.status}" inside the request that started it: ${counterSentence(after)}. ` +
      "The response is the final state — there is no background run left to wait for." +
      (after.error_message ? ` Failure reported: "${after.error_message}".` : "");
  }

  return (
    <div className="space-y-gutter">
      <PageHeader
        title="Scans"
        description="A scan starts only when someone asks for it and finishes before the server answers, so each row below is a completed run — this is not a live view. Nothing is scheduled or retried automatically."
        actions={
          canWrite ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={refetch} disabled={loading}>
                Reload
              </Button>
              <Button onClick={() => setDialog({ kind: "start" })}>New scan</Button>
            </div>
          ) : undefined
        }
      />

      {outcome ? (
        <OutcomeBanner tone={outcome.tone} message={outcome.message} onDismiss={() => setOutcome(null)} />
      ) : null}

      {error ? <ErrorState title="Scan jobs unavailable" message={error} onRetry={refetch} /> : null}

      {loading && data === null ? <Spinner label="Loading scan jobs..." /> : null}

      {data !== null ? (
        <>
          <FilterCard
            query={query}
            filtersActive={filtersActive}
            invalidSourceId={invalidSourceId}
            onChange={update}
            onClear={() => setQuery({ ...DEFAULT_QUERY, page: 1 })}
          />

          {canWrite && busyJobId !== null ? (
            <p role="status" className="text-meta text-ink-muted">
              Job #{busyJobId} is being worked on inside its own request. The action buttons
              are disabled until it answers, because a second submit would be a second scan.
            </p>
          ) : null}

          <Card>
            <CardHeader
              title={`Scan jobs (${data.total})`}
              description={`${
                activeInstitutionId === null
                  ? "Every institution this account can read"
                  : `Scoped to Institution #${activeInstitutionId}`
              }. Status, source id and page are server-side filters, so this total counts matching jobs rather than the rows below. Ordered newest job first, as the service returns them.`}
              action={
                loading ? (
                  <span role="status" className="text-meta text-ink-muted">
                    Refreshing…
                  </span>
                ) : undefined
              }
            />

            {data.items.length === 0 ? (
              <CardBody>
                <EmptyState
                  title={filtersActive ? "No scan job matches this view" : "No scan jobs yet"}
                  message={
                    filtersActive
                      ? "Nothing in scope answers the status or source filter in use. Change the filter, or change the institution scope in the sidebar: an empty filtered result says nothing about the runs that do exist."
                      : "Nothing has been scanned in this scope. A scan only happens when an operator starts one from a source record, and the backend has no scheduler, so none is waiting to appear here."
                  }
                  action={
                    canWrite && !filtersActive && data.total === 0 ? (
                      <Button onClick={() => setDialog({ kind: "start" })}>New scan</Button>
                    ) : undefined
                  }
                />
              </CardBody>
            ) : (
              <JobTable
                items={data.items}
                sourceNames={sourceNames}
                canWrite={canWrite}
                busy={busyJobId !== null}
                busyJobId={busyJobId}
                onDetails={(job) => setDialog({ kind: "details", job })}
                onRows={(job) => setDialog({ kind: "rows", job })}
                onAction={(action, job) => setDialog({ kind: "action", action, job })}
              />
            )}

            <Pagination
              page={data.page}
              pages={Math.max(1, data.pages)}
              total={data.total}
              disabled={loading}
              onPrevious={() => update({ page: Math.max(1, data.page - 1) })}
              onNext={() => update({ page: data.page + 1 })}
            />
          </Card>
        </>
      ) : null}

      {dialog?.kind === "start" ? (
        <StartScanDialog
          sources={sourcePage?.items ?? []}
          sourcesTruncated={(sourcePage?.total ?? 0) > (sourcePage?.items.length ?? 0)}
          institutionId={activeInstitutionId}
          onClose={() => setDialog(null)}
          onStarted={(job) => {
            setDialog(null);
            setOutcome({
              tone:
                job.status === "COMPLETED"
                  ? "success"
                  : job.status === "FAILED"
                    ? "critical"
                    : "info",
              message:
                job.status === "PENDING"
                  ? `Scan job #${job.id} is queued for source #${job.data_source_id} with batch size ` +
                    `${job.batch_size}. Nothing has been discovered yet: creating with run=false is ` +
                    "the only way a job sits in PENDING, because a run started now finishes inside " +
                    "the request that starts it. Nothing will begin on its own — start it from the " +
                    "row below when you mean to."
                  : describeOutcome("run", job, job),
            });
            refetch();
          }}
          onReload={() => {
            // The refusal says a scan already exists, so the operator has to see
            // that row; reloading behind an open modal would show nothing new.
            setDialog(null);
            refetch();
          }}
        />
      ) : null}

      {dialog?.kind === "action" ? (
        <JobActionDialog
          action={dialog.action}
          job={dialog.job}
          institutionId={activeInstitutionId}
          run={(action, job) => runAction(action, job)}
          onClose={() => setDialog(null)}
          onDone={(action, before, after) => {
            setDialog(null);
            setOutcome({
              tone:
                action === "cancel"
                  ? "info"
                  : after.status === "FAILED"
                    ? "critical"
                    : after.status === "COMPLETED_WITH_ERRORS"
                      ? "info"
                      : "success",
              message: describeOutcome(action, before, after),
            });
            refetch();
          }}
          onReload={() => {
            setDialog(null);
            refetch();
          }}
        />
      ) : null}

      {dialog?.kind === "details" ? (
        <DetailsDialog
          job={dialog.job}
          sourceName={sourceNames.get(dialog.job.data_source_id) ?? null}
          onClose={() => setDialog(null)}
          onRows={(job) => setDialog({ kind: "rows", job })}
        />
      ) : null}

      {dialog?.kind === "rows" ? (
        <RowsDialog job={dialog.job} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

/* --------------------------------- filters -------------------------------- */

function FilterCard({
  query,
  filtersActive,
  invalidSourceId,
  onChange,
  onClear,
}: {
  query: Query;
  filtersActive: boolean;
  invalidSourceId: boolean;
  onChange: (patch: Partial<Query>) => void;
  onClear: () => void;
}) {
  return (
    <Card>
      <CardHeader
        title="Find scan jobs"
        description="Status and source id are sent to the server and change the total. There is no name, date or outcome filter in the API, so nothing else can be narrowed from here."
      />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Field label="Status" hint="Server-side filter. A job that never started is PENDING.">
            {(control) => (
              <Select
                {...control}
                value={query.status}
                onChange={(event) => onChange({ status: event.target.value as ScanStatus | "" })}
              >
                <option value="">Any status</option>
                {SCAN_STATUSES.map((status) => (
                  <option key={status.value} value={status.value}>
                    {status.label} — {status.value}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Source id"
            error={invalidSourceId ? "A source reference is a whole number, or empty." : undefined}
            hint="Server-side filter (data_source_id). It takes the numeric id, not the source name."
          >
            {(control) => (
              <Input
                {...control}
                type="search"
                inputMode="numeric"
                invalid={invalidSourceId}
                value={query.sourceId}
                onChange={(event) => onChange({ sourceId: event.target.value })}
                placeholder="7"
              />
            )}
          </Field>
          {filtersActive ? (
            <div className="flex items-end">
              <Button variant="ghost" size="sm" onClick={onClear}>
                Clear filters
              </Button>
            </div>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

/* ---------------------------------- table --------------------------------- */

function JobTable({
  items,
  sourceNames,
  canWrite,
  busy,
  busyJobId,
  onDetails,
  onRows,
  onAction,
}: {
  items: ScanJob[];
  sourceNames: Map<number, string>;
  canWrite: boolean;
  busy: boolean;
  busyJobId: number | null;
  onDetails: (job: ScanJob) => void;
  onRows: (job: ScanJob) => void;
  onAction: (action: JobAction, job: ScanJob) => void;
}) {
  return (
    <Table caption="Scan jobs in the current view">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Job</TableHeaderCell>
          <TableHeaderCell>Source</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Outcome</TableHeaderCell>
          <TableHeaderCell className="hidden lg:table-cell">Started</TableHeaderCell>
          <TableHeaderCell className="hidden xl:table-cell">Completed</TableHeaderCell>
          <TableHeaderCell align="right">Actions</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {items.map((job) => (
          <JobRow
            key={job.id}
            job={job}
            sourceName={sourceNames.get(job.data_source_id) ?? null}
            canWrite={canWrite}
            busy={busy}
            busyThis={busyJobId === job.id}
            onDetails={() => onDetails(job)}
            onRows={() => onRows(job)}
            onAction={(action) => onAction(action, job)}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function JobRow({
  job,
  sourceName,
  canWrite,
  busy,
  busyThis,
  onDetails,
  onRows,
  onAction,
}: {
  job: ScanJob;
  sourceName: string | null;
  canWrite: boolean;
  busy: boolean;
  busyThis: boolean;
  onDetails: () => void;
  onRows: () => void;
  onAction: (action: JobAction) => void;
}) {
  const refusal = refusalSentence(job);
  return (
    <TableRow>
      <TableCell>
        <p className="font-mono font-medium text-ink">#{job.id}</p>
        <p className="mt-0.5 text-meta text-ink-muted">batch {job.batch_size}</p>
        {job.retried_from_job_id !== null ? (
          <p className="mt-0.5 text-meta text-ink-muted">retry of #{job.retried_from_job_id}</p>
        ) : null}
      </TableCell>
      <TableCell className="max-w-xs">
        <p className="truncate" title={sourceName ?? undefined}>
          {sourceName ?? `Source #${job.data_source_id}`}
        </p>
        <p className="mt-0.5 font-mono text-meta text-ink-muted">
          id {job.data_source_id}
          {job.institution_id === null ? "" : ` · inst #${job.institution_id}`}
        </p>
      </TableCell>
      <TableCell>
        <Badge tone={scanStatusTone(job.status)}>{job.status}</Badge>
        <p className="mt-1 text-meta whitespace-nowrap text-ink-muted">
          {job.started_at === null ? "Never started" : `Batch ${job.batch_size}`}
        </p>
      </TableCell>
      <TableCell className="max-w-sm">
        <p className="text-supporting">{counterSentence(job)}</p>
        {job.error_message ? (
          <p className="mt-0.5 max-w-xs break-words text-meta text-critical-ink" title={job.error_message}>
            {job.error_message}
          </p>
        ) : null}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap lg:table-cell">
        {job.started_at === null ? "—" : <time dateTime={asDate(job.started_at)}>{asDate(job.started_at)}</time>}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap xl:table-cell">
        {job.completed_at === null ? "—" : <time dateTime={asDate(job.completed_at)}>{asDate(job.completed_at)}</time>}
      </TableCell>
      <TableCell align="right">
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onDetails}>
            Details
          </Button>
          <Button variant="secondary" size="sm" onClick={onRows}>
            Records
          </Button>
          {canWrite ? (
            <>
              {canRun(job.status) ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onAction("run")}
                  loading={busyThis}
                  disabled={busy}
                >
                  Run
                </Button>
              ) : null}
              {canCancel(job.status) ? (
                <Button
                  variant="critical"
                  size="sm"
                  onClick={() => onAction("cancel")}
                  loading={busyThis}
                  disabled={busy}
                  title={refusal}
                >
                  Cancel
                </Button>
              ) : null}
              {canRetry(job.status) ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onAction("retry")}
                  loading={busyThis}
                  disabled={busy}
                >
                  Retry
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

/** Why an action is not offered for this row, in the server's own terms. */
function refusalSentence(job: ScanJob): string {
  return `The server's transition table only moves a job from PENDING or RUNNING to CANCELLED; this job is "${job.status}". ` +
    "Terminal states are frozen, so a cancelled or completed run cannot be interrupted again.";
}

/* -------------------------------- pagination ------------------------------- */

function Pagination({
  page,
  pages,
  total,
  disabled,
  onPrevious,
  onNext,
}: {
  page: number;
  pages: number;
  total: number;
  disabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <nav
      aria-label="Scan job pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-card-x py-3"
    >
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled || page <= 1}
        onClick={onPrevious}
        className="gap-1"
      >
        <IconChevronLeft className="h-4 w-4" />
        Previous
      </Button>
      <p className="text-meta text-ink-muted tabular-nums">
        Page {page} of {pages} · {total} job{total === 1 ? "" : "s"} matching
      </p>
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled || page >= pages}
        onClick={onNext}
        className="gap-1"
      >
        Next
        <IconChevronRight className="h-4 w-4" />
      </Button>
    </nav>
  );
}

/* ------------------------------- start a scan ------------------------------ */

function StartScanDialog({
  sources,
  sourcesTruncated,
  institutionId,
  onClose,
  onStarted,
  onReload,
}: {
  sources: Source[];
  sourcesTruncated: boolean;
  institutionId: number | null;
  onClose: () => void;
  onStarted: (job: ScanJob) => void;
  onReload: () => void;
}) {
  const [sourceId, setSourceId] = useState(sources.length > 0 ? String(sources[0].id) : "");
  const [batchText, setBatchText] = useState("");
  const [runNow, setRunNow] = useState(true);
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sourceRef = useRef<HTMLSelectElement>(null);
  const conflictRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const selected = sources.find((source) => String(source.id) === sourceId) ?? null;

  const batchError = (() => {
    const trimmed = batchText.trim();
    if (trimmed === "") {
      return undefined;
    }
    if (!/^\d+$/.test(trimmed)) {
      return "A batch size is a whole number, or empty to use the server default.";
    }
    const value = Number(trimmed);
    if (value < BATCH_MIN || value > BATCH_MAX) {
      return `The server accepts a batch size between ${BATCH_MIN} and ${BATCH_MAX}.`;
    }
    return undefined;
  })();

  const noSources = sources.length === 0;

  useEffect(() => {
    if (busy) {
      return;
    }
    if (conflict !== null) {
      conflictRef.current?.focus();
    } else if (serverError !== null) {
      errorRef.current?.focus();
    }
  }, [busy, conflict, serverError]);

  async function submit(): Promise<void> {
    setAttempted(true);
    setServerError(null);
    setConflict(null);
    if (noSources || batchError !== undefined || sourceId === "") {
      return;
    }
    setBusy(true);
    try {
      const job = await startScan(
        Number(sourceId),
        {
          batch_size: batchText.trim() === "" ? undefined : Number(batchText.trim()),
          run: runNow,
        },
        institutionId ?? undefined,
      );
      onStarted(job);
    } catch (cause) {
      const message = toErrorMessage(cause);
      if (cause instanceof ApiError && cause.status === 409) {
        setConflict(
          `${message} The source has a job the server still counts as queued or running, so it ` +
            "refused to add another. Reload the job list: a PENDING job there can be started or " +
            "cancelled, and a terminal one can be retried. Submitting again is not how this clears.",
        );
      } else if (cause instanceof ApiError && cause.status === 404) {
        setServerError(
          `${message} The source is not visible in the current institution scope. The server ` +
            "answers 404 for another tenant's record on purpose, so this is not proof that it " +
            "does not exist — check the scope in the sidebar.",
        );
      } else {
        setServerError(
          `${message} Nothing was started or created: the request never succeeded, so no job row ` +
            "exists for this attempt and no record was discovered.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title="Start a scan"
      description="This runs now, in this request. The backend has no queue, scheduler or worker: the scan discovers records and writes inventory rows before the response arrives, so a large source can keep this dialog waiting, and the job you get back is already finished. Nothing is repeated later on its own."
      onClose={onClose}
      initialFocusRef={sourceRef}
      width="lg"
      dismissOnBackdrop={false}
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Source"
          required
          error={attempted && noSources ? "There is no source record to scan in this view." : undefined}
          hint={
            sourcesTruncated
              ? `The first ${sources.length} source records of ${sources.length} or more, read from the list route (it caps a page at 100 and orders by name). A source outside that page cannot be picked here — find its id and use it in the list filter.`
              : `The ${sources.length} source record${sources.length === 1 ? "" : "s"} the list route returned for this scope. Nothing else can be scanned, because no other source exists in the API.`
          }
        >
          {(control) => (
            <Select
              {...control}
              ref={sourceRef}
              value={sourceId}
              disabled={busy || noSources}
              onChange={(event) => setSourceId(event.target.value)}
            >
              {sources.length === 0 ? (
                <option value="">No source records in this scope</option>
              ) : (
                sources.map((source) => (
                  <option key={source.id} value={String(source.id)}>
                    {source.name} — #{source.id} ({source.connector_type ?? "no connector"}) ·{" "}
                    {source.status}
                  </option>
                ))
              )}
            </Select>
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Batch size"
            error={attempted ? batchError : undefined}
            hint={`Optional. Records fetched per batch. Empty uses the server's SCAN_BATCH_SIZE; the route accepts ${BATCH_MIN}–${BATCH_MAX} and the service clamps the stored value to the same range.`}
          >
            {(control) => (
              <Input
                {...control}
                type="number"
                min={BATCH_MIN}
                max={BATCH_MAX}
                step={1}
                inputMode="numeric"
                invalid={attempted && batchError !== undefined}
                value={batchText}
                disabled={busy}
                onChange={(event) => setBatchText(event.target.value)}
                placeholder="Server default"
              />
            )}
          </Field>

          <Field
            label="When to run"
            hint="Creating a job without running it is the only way a PENDING job exists, because an immediate start finishes inside the request."
          >
            {(control) => (
              <Select
                {...control}
                value={runNow ? "now" : "queued"}
                disabled={busy}
                onChange={(event) => setRunNow(event.target.value === "now")}
              >
                <option value="now">Run now (default)</option>
                <option value="queued">Create as PENDING; start it later by hand</option>
              </Select>
            )}
          </Field>
        </div>

        <ul className="list-disc space-y-1 rounded-card border border-line bg-surface-sunken px-card-x py-card-y text-meta text-ink-muted">
          {selected ? (
            <li>
              Source #{selected.id} "{selected.name}" is a{" "}
              {selected.connector_type === null
                ? "record with no connector type"
                : humanize(selected.connector_type)}{" "}
              source, {selected.status === "active" ? "enabled" : "marked inactive"}; that says what
              the operator set, not that it can be reached
              {selected.last_validation_ok === null
                ? " — it has never been validated."
                : selected.last_validation_ok
                  ? ` — the last check could reach it (${selected.last_validation_message ?? "no message"}).`
                  : ` — the last check could not reach it (${selected.last_validation_message ?? "no message"}), so this scan is likely to fail.`}
            </li>
          ) : null}
          <li>
            A scan reads and writes metadata only. For a local_folder source the connector lists file
            attributes, refuses symlinks, stores no checksum and classifies nothing as personal data;
            record contents are not read, moved or deleted. Imported rows become inventory assets, and
            re-running the same source is expected to produce skipped rows rather than duplicates.
          </li>
          <li>
            {institutionId === null
              ? "Your account is not scoped to one institution, so the request carries no institution_id; the job inherits its institution from the source row."
              : `Scoped to institution #${institutionId}. A source outside it answers 404, not 403 — the server hides other tenants' records.`}
          </li>
        </ul>

        {conflict ? (
          <div
            ref={conflictRef}
            tabIndex={-1}
            role="alert"
            className="rounded-card border border-warning-line bg-warning-surface px-card-x py-card-y text-supporting text-warning-ink focus:outline-none"
          >
            <p className="font-semibold">The server refused a second concurrent scan</p>
            <p className="mt-1">{conflict}</p>
            <Button className="mt-3" variant="secondary" size="sm" onClick={onReload}>
              Reload the job list
            </Button>
          </div>
        ) : null}

        <ServerMessage error={serverError} busy={busy} errorRef={errorRef} />

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={noSources}>
            {runNow ? "Run scan now" : "Create queued job"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------ job lifecycle ------------------------------ */

const ACTION_COPY: Record<
  JobAction,
  { title: string; description: string; confirm: string; variant: "primary" | "critical" }
> = {
  run: {
    title: "Start the queued scan",
    description:
      "The job is PENDING, which is the only state the run endpoint accepts. Running happens inside this request: it discovers records and writes inventory rows before the answer arrives, and it cannot be paused or rolled back from here.",
    confirm: "Run scan",
    variant: "primary",
  },
  cancel: {
    title: "Cancel this scan job",
    description:
      "This marks the job CANCELLED and stamps its completion time. It is a record change: records already imported stay imported, and nothing is deleted or unwritten. The transition table allows it only from PENDING or RUNNING, and every terminal state is frozen.",
    confirm: "Cancel job",
    variant: "critical",
  },
  retry: {
    title: "Retry this scan",
    description:
      "A retry creates a new job for the same source and runs it in this request; the new row links back through retried_from_job_id and the original job keeps its status and counters. Only a FAILED, COMPLETED_WITH_ERRORS or CANCELLED job can be retried — a clean COMPLETED scan is refused with 409.",
    confirm: "Retry as a new job",
    variant: "primary",
  },
};

function JobActionDialog({
  action,
  job,
  institutionId,
  run,
  onClose,
  onDone,
  onReload,
}: {
  action: JobAction;
  job: ScanJob;
  institutionId: number | null;
  run: (action: JobAction, job: ScanJob) => Promise<ScanJob>;
  onClose: () => void;
  onDone: (action: JobAction, before: ScanJob, after: ScanJob) => void;
  onReload: () => void;
}) {
  const [serverError, setServerError] = useState<string | null>(null);
  /** A 409 is a state conflict, not a typo: it gets its own explanation. */
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const conflictRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const summaryRef = useRef<HTMLDListElement>(null);

  useEffect(() => {
    if (busy) {
      return;
    }
    if (conflict !== null) {
      conflictRef.current?.focus();
    } else if (serverError !== null) {
      errorRef.current?.focus();
    }
  }, [busy, conflict, serverError]);

  async function submit(): Promise<void> {
    setServerError(null);
    setConflict(null);
    setBusy(true);
    try {
      onDone(action, job, await run(action, job));
    } catch (cause) {
      const message = toErrorMessage(cause);
      if (cause instanceof ApiError && cause.status === 409) {
        setConflict(
          `${message} The server kept its own state and changed nothing. The row you acted on is ` +
            "probably stale — another request already moved this job, or a scan for this source is " +
            "still queued. Reload the list and work from the status the server reports instead of " +
            "trying the same action again, because the transition table will refuse it a second time.",
        );
      } else if (cause instanceof ApiError && cause.status === 404) {
        setServerError(
          `${message} The job is not visible in the current institution scope. The server answers ` +
            "404 for another tenant's record deliberately, so reload the list rather than repeating " +
            "the action.",
        );
      } else {
        setServerError(
          `${message} Nothing was changed by this attempt: the request never succeeded, so the ` +
            "job's stored status, counters and timestamps are untouched.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  const copy = ACTION_COPY[action];

  return (
    <Dialog
      open
      title={`${copy.title} #${job.id}`}
      description={copy.description}
      onClose={onClose}
      initialFocusRef={summaryRef}
      width="md"
      dismissOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Go back
          </Button>
          <Button
            variant={copy.variant}
            loading={busy}
            onClick={() => void submit()}
          >
            {copy.confirm}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <dl
          ref={summaryRef}
          tabIndex={-1}
          className="grid focus:outline-none gap-x-6 gap-y-3 sm:grid-cols-2"
        >
          <Detail label="Job">
            #{job.id} · source <span className="font-mono">#{job.data_source_id}</span>
          </Detail>
          <Detail label="Current status">
            <Badge tone={scanStatusTone(job.status)}>{job.status}</Badge>
          </Detail>
          <Detail label="Counters so far">{counterSentence(job)}</Detail>
          <Detail label="Batch size">{job.batch_size}</Detail>
          <Detail label="Institution">
            {job.institution_id === null ? "Stored without an institution" : `#${job.institution_id}`}
          </Detail>
          <Detail label="Started / completed">
            {`${job.started_at ?? "not started"} → ${job.completed_at ?? "not completed"}`}
          </Detail>
          {job.error_message ? (
            <Detail label="Recorded failure" wide>
              {job.error_message}
            </Detail>
          ) : null}
        </dl>

        <ul className="list-disc space-y-1 text-meta text-ink-muted">
          <li>
            {action === "retry"
              ? `The new job copies this job's batch size (${job.batch_size}) and links back with retried_from_job_id ${job.id}. This row keeps "${job.status}" and its counters.`
              : `The request that confirms this action is the same request that does the work, so the answer you get is the job's final state${
                  action === "cancel" ? " — cancellation only marks the row" : ""
                }.`}
          </li>
          <li>
            A scan writes inventory metadata only. It archives nothing, restores nothing and deletes
            nothing, and it does not rewrite any earlier job's record.
          </li>
          <li>
            {institutionId === null
              ? "No institution filter is sent, so the action is authorised against your platform-wide scope."
              : `Sent with institution_id ${institutionId}; the server reconciles it with your verified identity and answers 404 if this job is not yours.`}
          </li>
        </ul>

        {conflict ? (
          <div
            ref={conflictRef}
            tabIndex={-1}
            role="alert"
            className="rounded-card border border-warning-line bg-warning-surface px-card-x py-card-y text-supporting text-warning-ink focus:outline-none"
          >
            <p className="font-semibold">The server rejected this as an invalid transition</p>
            <p className="mt-1">{conflict}</p>
            <Button className="mt-3" variant="secondary" size="sm" onClick={onReload}>
              Reload the job list
            </Button>
          </div>
        ) : null}

        <ServerMessage error={serverError} busy={busy} errorRef={errorRef} />
      </div>
    </Dialog>
  );
}

/* --------------------------------- details -------------------------------- */

function DetailsDialog({
  job,
  sourceName,
  onClose,
  onRows,
}: {
  job: ScanJob;
  sourceName: string | null;
  onClose: () => void;
  onRows: (job: ScanJob) => void;
}) {
  return (
    <Dialog
      open
      title={`Scan job #${job.id}`}
      description="Every value below is a field the scan API returned for this job. Nothing is derived or estimated."
      onClose={onClose}
      width="lg"
    >
      <div className="space-y-4">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Detail label="Status">
            <Badge tone={scanStatusTone(job.status)}>{job.status}</Badge>
          </Detail>
          <Detail label="What the status means">{statusMeaning(job)}</Detail>
          <Detail label="Source">
            {sourceName === null
              ? `#${job.data_source_id} (not in the loaded source page)`
              : `"${sourceName}" (#${job.data_source_id})`}
          </Detail>
          <Detail label="Institution">
            {job.institution_id === null ? "Stored without an institution" : `#${job.institution_id}`}
          </Detail>
          <Detail label="Batch size">{job.batch_size}</Detail>
          <Detail label="Retried from">
            {job.retried_from_job_id === null
              ? "Not a retry"
              : `Job #${job.retried_from_job_id}`}
          </Detail>
          <Detail label="Total discovered">{job.total_discovered}</Detail>
          <Detail label="Total imported">{job.total_imported}</Detail>
          <Detail label="Total skipped">{job.total_skipped}</Detail>
          <Detail label="Total error rows">{job.total_errors}</Detail>
          <Detail label="Started at">{job.started_at ?? "Never started"}</Detail>
          <Detail label="Completed at">{job.completed_at ?? "Not completed"}</Detail>
          <Detail label="Created at">{job.created_at}</Detail>
          <Detail label="Error message" wide>
            {job.error_message ?? "None recorded"}
          </Detail>
        </dl>

        <p className="rounded-card border border-line bg-surface-sunken px-card-x py-card-y text-meta text-ink-muted">
          No progress bar and no live view are shown, because there is nothing to show: the backend
          runs a scan inside the request that starts it, has no worker or scheduler, and stores no
          percentage or record-in-flight field. The counters above are the absolute outcome the
          service wrote. A job in RUNNING state cannot be observed from another request.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="secondary" onClick={() => onRows(job)}>
            Records and errors
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function statusMeaning(job: ScanJob): string {
  switch (job.status) {
    case "PENDING":
      return "Queued by a create that asked for run=false. Nothing has been discovered yet; it starts only when somebody runs it.";
    case "RUNNING":
      return "Mid-run inside its own request, which is not a state another request can normally observe.";
    case "COMPLETED":
      return "Ran to the end with no error rows recorded.";
    case "COMPLETED_WITH_ERRORS":
      return "Ran to the end, but at least one record or file produced an error row.";
    case "FAILED":
      return `Stopped before finishing${job.error_message ? `: "${job.error_message}"` : " and recorded a failure"}. Counters show what was written up to that point.`;
    case "CANCELLED":
      return "Marked cancelled. Records already written by the run stay written.";
    default:
      return "A status the connector API did not document; shown exactly as stored.";
  }
}

/* ---------------------------- results and errors --------------------------- */

const ROW_TABS = [
  { id: "results", label: "Record outcomes" },
  { id: "errors", label: "Errors and warnings" },
];

function RowsDialog({ job, onClose }: { job: ScanJob; onClose: () => void }) {
  const { activeInstitutionId } = useAuth();
  const [tab, setTab] = useState<"results" | "errors">("results");
  const [page, setPage] = useState(1);
  const institutionId = activeInstitutionId ?? undefined;

  const { data, loading, error, refetch } = useApiQuery<
    ScanResultListResponse | ScanErrorListResponse
  >(
    (signal) =>
      tab === "results"
        ? listScanResults(job.id, { page, per_page: ROWS_PER_PAGE, institution_id: institutionId }, signal)
        : listScanErrors(job.id, { page, per_page: ROWS_PER_PAGE, institution_id: institutionId }, signal),
    [job.id, tab, page, institutionId],
  );

  return (
    <Dialog
      open
      title={`Job #${job.id}: per-record rows`}
      description="Two separate routes, each paginated at 50 rows per page (the API caps per_page at 200) and offering no filter of its own. What is listed here is what the scan wrote about individual records — not a copy of the source's contents."
      onClose={onClose}
      width="lg"
    >
      <div className="space-y-4">
        <p className="text-meta text-ink-muted">
          The job reports {counterSentence(job)}. A page of rows is a slice of that, ordered by id
          ascending as the service returns it.
        </p>

        <Tabs
          items={ROW_TABS}
          ariaLabel="Scan job rows"
          activeId={tab}
          onChange={(id) => {
            setTab(id as "results" | "errors");
            setPage(1);
          }}
        >
          {(activeId) => (
            <div className="space-y-3">
              {error ? (
                <ErrorState
                  title={activeId === "results" ? "Outcome rows unavailable" : "Error rows unavailable"}
                  message={error}
                  onRetry={refetch}
                />
              ) : null}

              {loading && data === null ? <Spinner label="Loading rows..." /> : null}

              {data !== null ? (
                <>
                  {data.items.length === 0 ? (
                    <EmptyState
                      title={activeId === "results" ? "No outcome rows" : "No error or warning rows"}
                      message={
                        activeId === "results"
                          ? "This job wrote no per-record rows. A scan that discovered nothing — or one refused before it could build its connector — produces exactly this, and it is not evidence that the source is empty."
                          : "No error or warning row was recorded for this job. That is the job's own record: it says nothing about records the connector never reached."
                      }
                    />
                  ) : activeId === "results" ? (
                    <ResultTable items={(data as ScanResultListResponse).items} />
                  ) : (
                    <ErrorTable items={(data as ScanErrorListResponse).items} />
                  )}

                  <RowsPagination
                    page={data.page}
                    pages={Math.max(1, data.pages)}
                    total={data.total}
                    disabled={loading}
                    onPrevious={() => setPage((current) => Math.max(1, current - 1))}
                    onNext={() => setPage((current) => current + 1)}
                  />
                </>
              ) : null}
            </div>
          )}
        </Tabs>

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function RowsPagination({
  page,
  pages,
  total,
  disabled,
  onPrevious,
  onNext,
}: {
  page: number;
  pages: number;
  total: number;
  disabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <nav
      aria-label="Scan row pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3"
    >
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled || page <= 1}
        onClick={onPrevious}
        className="gap-1"
      >
        <IconChevronLeft className="h-4 w-4" />
        Previous
      </Button>
      <p className="text-meta text-ink-muted tabular-nums">
        Page {page} of {pages} · {total} row{total === 1 ? "" : "s"}
      </p>
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled || page >= pages}
        onClick={onNext}
        className="gap-1"
      >
        Next
        <IconChevronRight className="h-4 w-4" />
      </Button>
    </nav>
  );
}

function ResultTable({ items }: { items: ScanResult[] }) {
  return (
    <Table caption="Per-record outcomes written by this scan job">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Record</TableHeaderCell>
          <TableHeaderCell>Outcome</TableHeaderCell>
          <TableHeaderCell className="hidden sm:table-cell">Type</TableHeaderCell>
          <TableHeaderCell className="hidden lg:table-cell">Sensitivity</TableHeaderCell>
          <TableHeaderCell className="hidden xl:table-cell">Size</TableHeaderCell>
          <TableHeaderCell className="hidden xl:table-cell">Asset</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {items.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="max-w-sm">
              <p className="break-words font-medium text-ink">{row.title}</p>
              <p className="mt-0.5 break-all font-mono text-meta text-ink-muted">{row.source_key}</p>
              {row.file_name ? (
                <p className="mt-0.5 break-words text-meta text-ink-muted" title={row.file_name}>
                  {row.file_name}
                </p>
              ) : null}
            </TableCell>
            <TableCell>
              <Badge tone={toneForScanOutcome(row.status)}>{row.status}</Badge>
              {row.note ? (
                <p className="mt-1 max-w-xs break-words text-meta text-ink-muted" title={row.note}>
                  {row.note}
                </p>
              ) : null}
              {row.error_message ? (
                <p
                  className="mt-1 max-w-xs break-words text-meta text-critical-ink"
                  title={row.error_message}
                >
                  {row.error_message}
                </p>
              ) : null}
            </TableCell>
            <TableCell className="hidden sm:table-cell">
              <p>{humanize(row.record_type)}</p>
              <p className="mt-0.5 text-meta text-ink-muted">{row.category ?? "No category"}</p>
            </TableCell>
            <TableCell className="hidden lg:table-cell">
              <p className="whitespace-nowrap">{row.sensitivity}</p>
              <p className="mt-0.5 text-meta text-ink-muted">
                {row.contains_personal_data ? "Flags personal data" : "No personal-data flag"}
              </p>
            </TableCell>
            <TableCell className="hidden whitespace-nowrap xl:table-cell">
              {formatBytes(row.size_bytes)}
              <p className="mt-0.5 text-meta text-ink-muted">{row.mime_type ?? "No mime type"}</p>
            </TableCell>
            <TableCell className="hidden xl:table-cell">
              {row.imported_asset_id === null
                ? "No asset written"
                : `#${row.imported_asset_id}`}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ErrorTable({ items }: { items: ScanError[] }) {
  return (
    <Table caption="Error and warning rows recorded by this scan job">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Severity</TableHeaderCell>
          <TableHeaderCell>What went wrong</TableHeaderCell>
          <TableHeaderCell className="hidden sm:table-cell">Where</TableHeaderCell>
          <TableHeaderCell className="hidden lg:table-cell">Recorded</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {items.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <Badge tone={toneForScanSeverity(row.severity)}>{row.severity}</Badge>
            </TableCell>
            <TableCell className="max-w-md">
              <p className="break-words text-supporting text-ink">{row.error_message}</p>
              {row.source_key ? (
                <p className="mt-0.5 break-all font-mono text-meta text-ink-muted">
                  {row.source_key}
                </p>
              ) : null}
            </TableCell>
            <TableCell className="hidden max-w-xs break-all sm:table-cell">
              {row.path === null
                ? "No path recorded"
                : `${row.path} (root-relative, never absolute)`}
            </TableCell>
            <TableCell className="hidden whitespace-nowrap lg:table-cell">
              <time dateTime={asDate(row.created_at)}>{asDate(row.created_at)}</time>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/* --------------------------------- shared --------------------------------- */

type OutcomeTone = "info" | "success" | "critical";

interface Outcome {
  tone: OutcomeTone;
  message: string;
}

const BANNER_CLASSES: Record<OutcomeTone, string> = {
  info: "border-info-line bg-info-surface text-info-ink",
  success: "border-success-line bg-success-surface text-success-ink",
  critical: "border-critical-line bg-critical-surface text-critical-ink",
};

function OutcomeBanner({
  tone,
  message,
  onDismiss,
}: {
  tone: OutcomeTone;
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className={`flex flex-wrap items-start justify-between gap-3 rounded-card border px-card-x py-card-y ${BANNER_CLASSES[tone]}`}
    >
      <p className="text-supporting">{message}</p>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

function Detail({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="text-meta font-semibold uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-1 break-words text-supporting text-ink-secondary">{children}</dd>
    </div>
  );
}

/** Server refusals are shown verbatim: they name the status the job was found in. */
function ServerMessage({
  error,
  busy,
  errorRef,
}: {
  error: string | null;
  busy: boolean;
  errorRef?: Ref<HTMLParagraphElement>;
}) {
  return (
    <>
      {error ? (
        <p
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="text-supporting text-critical-ink focus:outline-none"
        >
          {error}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="text-meta text-ink-muted">
          Working… the scan runs inside this request, so this can take a while.
        </p>
      ) : null}
    </>
  );
}