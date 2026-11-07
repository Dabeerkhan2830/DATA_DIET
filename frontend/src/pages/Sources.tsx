/**
 * Connected data sources (redesign Phase 5.8).
 *
 * Reads the real `data_sources` table through the connector API. No fixture, no
 * demo row, and nothing is invented to fill an empty scope.
 *
 * The contract was read out of `backend/app/api/routes/connectors.py`,
 * `backend/app/api/schemas/connectors.py`, `backend/app/services/scan.py` and
 * `backend/app/core/auth.py`, and it is what limits this screen:
 *
 * - Creating a source writes a configuration record only. `status = "active"`
 *   is hard-coded in `create_source` and no connector is contacted, so an
 *   `active` row means "an operator enabled this record", never "this source is
 *   connected". The only reachability evidence the API has is the trio
 *   `last_validated_at` / `last_validation_ok` / `last_validation_message`, and
 *   those columns are written solely by `POST /sources/{id}/validate`.
 * - `GET /sources` filters by `connector_type` and `status` and paginates
 *   (`page`, `per_page` ≤ 100) ordered by name ascending. It has **no** name or
 *   text search parameter, so the name box is a browser-side narrowing of the
 *   page already loaded and is labelled as such.
 * - Editing is a partial `PATCH` of `name`, `root_key`, `config` and `status`.
 *   `connector_type` is not editable, and **there is no delete endpoint**: a
 *   source is retired by setting it to `inactive`, which is what the edit dialog
 *   says instead of offering a Delete button.
 * - `ConnectorType` accepts exactly `synthetic` and `local_folder`. A
 *   `local_folder` source stores an allow-list *key*, never a path; the key must
 *   already exist in the server's `LOCAL_SOURCE_ROOTS`, so this screen asks for a
 *   key and reports the server's 422 when it is not configured. It cannot list
 *   the allowed keys, because no endpoint returns them.
 * - `config` is a free JSON object, but the schema refuses secret-looking keys
 *   (`password`, `token`, `api_key`, …) and more than 40 keys. The same keys are
 *   refused here before the request, so a credential is never sent and never
 *   displayed back: the response re-renders exactly what the server stored.
 * - A source belonging to another institution answers **404**, not 403 — the
 *   route hides other tenants' existence deliberately. An empty list and a
 *   refused scope are therefore different facts and are never merged.
 * - Scans are not managed here. Discovery runs on the Scans page,
 *   which owns `POST /sources/{id}/scans`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import { ApiError, toErrorMessage } from "../api/client";
import { createSource, listSources, updateSource, validateSource } from "../api/sources";
import type { SourceCreateInput, SourceUpdateInput } from "../api/sources";
import type { ConnectorType, Source, SourceStatus } from "../api/types";
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
import { Textarea } from "../components/ui/Textarea";
import { formatDate, humanize } from "../lib/format";
import { toneForSourceStatus, type Tone } from "../lib/semantic";

/** The server's own default page size for `GET /sources`; its maximum is 100. */
const PER_PAGE = 20;

/** `SourceCreate.name` is `Field(min_length=1, max_length=200)`. */
const NAME_MAX = 200;

/** `SourceCreate.root_key` is `Field(default=None, max_length=100)`. */
const ROOT_KEY_MAX = 100;

/** `_reject_secret_keys` refuses a config with more than this many keys. */
const CONFIG_KEY_MAX = 40;

/**
 * The keys `_FORBIDDEN_CONFIG_KEYS` in `backend/app/api/schemas/connectors.py`
 * refuses. Refusing them here too is not a shortcut around the server — it still
 * refuses — it keeps a credential from being typed into a box that would send it
 * over the wire and store it in plain JSON.
 */
const SECRET_CONFIG_KEYS: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "access_key",
  "private_key",
  "credential",
  "credentials",
];

/**
 * The two values `ConnectorType` accepts, with what the backend actually does
 * with each. Nothing here advertises a connector the server cannot build:
 * `build_connector` raises `ConnectorError` for anything else.
 */
const CONNECTOR_OPTIONS: Array<{
  value: ConnectorType;
  label: string;
  blurb: string;
}> = [
  {
    value: "synthetic",
    label: "Synthetic test data",
    blurb:
      "Generates fictional records inside the backend. It contacts no system and " +
      "uploads nothing, which is what makes it safe to try the pipeline with.",
  },
  {
    value: "local_folder",
    label: "Local folder (allow-listed key)",
    blurb:
      "Reads metadata of files under a folder an operator has already allow-listed " +
      "in LOCAL_SOURCE_ROOTS. The record stores the key, never a path, and symlinks " +
      "are refused.",
  },
];

/** The two values `SourceStatus` accepts. */
const STATUS_OPTIONS: Array<{ value: SourceStatus; label: string }> = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

/** What the last validation — or the absence of one — says about this row. */
type OutcomeTone = "info" | "success" | "critical";

interface Outcome {
  tone: OutcomeTone;
  message: string;
}

type DialogState =
  | { kind: "create" }
  | { kind: "edit"; source: Source }
  | { kind: "details"; source: Source }
  | null;

interface SourceQuery {
  page: number;
  connectorType: ConnectorType | "";
  status: SourceStatus | "";
  name: string;
}

const DEFAULT_QUERY: SourceQuery = { page: 1, connectorType: "", status: "", name: "" };

interface SourceForm {
  name: string;
  connectorType: ConnectorType;
  rootKey: string;
  configText: string;
  status: SourceStatus;
}

type FormErrors = Partial<Record<"name" | "rootKey" | "configText", string>>;

/** A refusal the server made for a reason the operator needs spelled out. */
interface Refusal {
  title: string;
  detail: string;
}

const EMPTY_FORM: SourceForm = {
  name: "",
  connectorType: "synthetic",
  rootKey: "",
  configText: "",
  status: "active",
};

/** `active` and `inactive` are the server's words; anything else stays as stored. */
function sourceStatusTone(status: string): Tone {
  return status === "active" || status === "inactive"
    ? toneForSourceStatus(status)
    : "neutral";
}

/** The row's own date part; the detail dialogs print the full stored value. */
function asDate(iso: string): string {
  return formatDate(iso.slice(0, 10));
}

/**
 * What the last validation attempt proved. `last_validated_at` is null until
 * somebody calls `POST /sources/{id}/validate`, so "never validated" is the
 * honest default for a freshly created record — it is not a failure.
 */
function validationSentence(source: Source): string {
  if (source.last_validated_at === null) {
    return "Never validated";
  }
  if (source.last_validation_ok === true) {
    return `Reachable as at ${asDate(source.last_validated_at)}`;
  }
  if (source.last_validation_ok === false) {
    return `Not reachable as at ${asDate(source.last_validated_at)}`;
  }
  return `Validation attempted ${asDate(source.last_validated_at)}, result not recorded`;
}

/**
 * The only sentence this screen is allowed to say about connectivity. It exists
 * because "active" in the database looks like a connection, and is not one.
 */
function connectionSentence(source: Source): string {
  if (source.last_validation_ok === true) {
    return "Last check could reach it";
  }
  if (source.last_validation_ok === false) {
    return "Last check could not reach it";
  }
  return "Connection never checked";
}

/**
 * Client-side mirror of what the schema enforces, so an obvious mistake is not a
 * wasted round trip. Every rule here is stated in `SourceCreate`/`SourceUpdate`
 * or in `_reject_secret_keys`; nothing is added on top of the server's contract.
 */
function validateForm(form: SourceForm, connector: ConnectorType): FormErrors {
  const errors: FormErrors = {};

  const name = form.name.trim();
  if (name === "") {
    errors.name = "A source name is required.";
  } else if (name.length > NAME_MAX) {
    errors.name = `A source name must be ${NAME_MAX} characters or fewer.`;
  }

  const rootKey = form.rootKey.trim();
  if (connector === "local_folder") {
    if (rootKey === "") {
      errors.rootKey = "A local_folder source requires a root_key.";
    } else if (rootKey.length > ROOT_KEY_MAX) {
      errors.rootKey = `A root key must be ${ROOT_KEY_MAX} characters or fewer.`;
    } else if (rootKey.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rootKey) || rootKey.includes("\\")) {
      errors.rootKey =
        "This field takes the name of an allow-listed key, not a filesystem path. The " +
        "server refuses absolute paths, and an operator must have added the key to " +
        "LOCAL_SOURCE_ROOTS first.";
    }
  } else if (rootKey !== "") {
    errors.rootKey = "A synthetic source must not set a root_key.";
  }

  const config = parseConfig(form.configText);
  if (!config.ok) {
    errors.configText = config.message;
  }

  return errors;
}

type ConfigParse =
  | { ok: true; value: Record<string, unknown> | null }
  | { ok: false; message: string };

/**
 * Reads the config box. Empty means "send nothing", which for a PATCH leaves the
 * stored config untouched.
 */
function parseConfig(text: string): ConfigParse {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: true, value: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, message: "The configuration must be valid JSON." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "The configuration must be a JSON object of key/value pairs." };
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > CONFIG_KEY_MAX) {
    return {
      ok: false,
      message: `The configuration has ${entries.length} keys; the server accepts at most ${CONFIG_KEY_MAX}.`,
    };
  }
  const offending = entries
    .map(([key]) => key.toLowerCase())
    .filter((key) => SECRET_CONFIG_KEYS.includes(key))
    .sort();
  if (offending.length > 0) {
    return {
      ok: false,
      message:
        "Connector configuration must not contain secrets; remove: " +
        `${offending.join(", ")}. Credentials stay on the server that owns them — ` +
        "this API has no field for them and never displays any.",
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function isInvalid(errors: FormErrors): boolean {
  return Object.keys(errors).length > 0;
}

export default function Sources() {
  const { activeInstitutionId, has } = useAuth();
  const canWrite = has("sources:write");

  const [query, setQuery] = useState<SourceQuery>(DEFAULT_QUERY);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  /** Which row's validation is in flight; a second one is refused while it runs. */
  const [validatingId, setValidatingId] = useState<number | null>(null);

  const { data, loading, error, refetch } = useApiQuery(
    (signal) =>
      listSources(
        {
          page: query.page,
          per_page: PER_PAGE,
          connector_type: query.connectorType,
          status: query.status,
          institution_id: activeInstitutionId ?? undefined,
        },
        signal,
      ),
    [query.page, query.connectorType, query.status, activeInstitutionId],
  );

  const nameNeedle = query.name.trim().toLowerCase();
  const rows = useMemo(
    () =>
      data === null
        ? []
        : data.items.filter((source) => nameNeedle === "" || source.name.toLowerCase().includes(nameNeedle)),
    [data, nameNeedle],
  );

  const filtersActive =
    query.connectorType !== "" || query.status !== "" || query.name.trim() !== "";

  function update(patch: Partial<SourceQuery>): void {
    setQuery((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  function closeDialog(): void {
    setDialog(null);
  }

  async function runValidation(source: Source): Promise<void> {
    setValidatingId(source.id);
    setOutcome(null);
    try {
      const result = await validateSource(source.id, activeInstitutionId ?? undefined);
      setOutcome({
        tone: result.ok ? "success" : "critical",
        message: result.ok
          ? `Source "${source.name}" (id ${source.id}): ${result.message} Validation builds the ` +
            "connector and asks it whether it can open the source. It discovers and imports " +
            `nothing, so a pass is not a promise that a scan will succeed.${
              result.validated_at === null ? "" : ` Recorded at ${result.validated_at}.`
            }`
          : `Source "${source.name}" (id ${source.id}) could not be validated: ${result.message} ` +
            "Nothing was discovered or imported, and the record keeps its previous configuration. " +
            "For a local_folder source this usually means the key is not in the server's " +
            `LOCAL_SOURCE_ROOTS allow-list.${
              result.validated_at === null ? "" : ` Recorded at ${result.validated_at}.`
            }`,
      });
      refetch();
    } catch (cause) {
      const message = toErrorMessage(cause);
      setOutcome({
        tone: "critical",
        message:
          cause instanceof ApiError && cause.status === 404
            ? `${message} The source is not visible in the current institution scope, or it was ` +
              "retired in another session. Reload the list rather than repeating the check."
            : `${message} The validation never ran, so nothing about this source is known beyond ` +
              "what was already recorded.",
      });
    } finally {
      setValidatingId(null);
    }
  }

  return (
    <div className="space-y-gutter">
      <PageHeader
        title="Connected Sources"
        description="Source configuration records, read through the connector API. A record here describes how a scan would reach something; creating one contacts nothing, and the status you can set is enablement, not connectivity. Scans discover file and record metadata only — no contents are read, moved or deleted by this screen."
        actions={
          canWrite ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={refetch} disabled={loading}>
                Reload
              </Button>
              <Button onClick={() => setDialog({ kind: "create" })}>Add source</Button>
            </div>
          ) : undefined
        }
      />

      {outcome ? (
        <OutcomeBanner tone={outcome.tone} message={outcome.message} onDismiss={() => setOutcome(null)} />
      ) : null}

      {error ? <ErrorState title="Sources unavailable" message={error} onRetry={refetch} /> : null}

      {loading && data === null ? (
        <Spinner label="Loading connected sources..." />
      ) : null}

      {data !== null ? (
        <>
          <FilterCard
            query={query}
            filtersActive={filtersActive}
            totalOnPage={data.items.length}
            onChange={update}
            onClear={() => setQuery({ ...DEFAULT_QUERY, page: 1 })}
          />

          {canWrite && validatingId !== null ? (
            <p role="status" className="text-meta text-ink-muted">
              Validating source #{validatingId}… the check runs inside the request, so the
              buttons below are disabled until it answers.
            </p>
          ) : null}

          <Card>
            <CardHeader
              title={`Sources (${data.total})`}
              description={`${
                activeInstitutionId === null
                  ? "Every institution this account can read"
                  : `Scoped to Institution #${activeInstitutionId}`
              }. The connector type, status and page filters are applied by the server, so this total is the number of matching records rather than the rows below. Ordered by name, as the server returns it. Records with no connector type are excluded by the route itself.`}
              action={
                loading ? (
                  <span role="status" className="text-meta text-ink-muted">
                    Refreshing…
                  </span>
                ) : undefined
              }
            />

            {rows.length === 0 ? (
              <CardBody>
                <EmptyState
                  title={
                    filtersActive ? "No source matches this view" : "No source records yet"
                  }
                  message={
                    filtersActive
                      ? "Nothing in this page of the list answers the connector type, status or name filter in use. The name box only narrows the rows already loaded, so change it or go back a page; change the institution scope in the sidebar to change the scope. An empty filtered view says nothing about the sources that do exist."
                      : "Nothing is connected in this scope. Nothing is created automatically — an operator adds a configuration record explicitly, and a scan is only ever started by hand."
                  }
                  action={
                    canWrite && !filtersActive && data.total === 0 ? (
                      <Button onClick={() => setDialog({ kind: "create" })}>Add source</Button>
                    ) : undefined
                  }
                />
              </CardBody>
            ) : (
              <SourceTable
                items={rows}
                canWrite={canWrite}
                validatingId={validatingId}
                busy={validatingId !== null}
                onDetails={(source) => setDialog({ kind: "details", source })}
                onEdit={(source) => setDialog({ kind: "edit", source })}
                onValidate={(source) => void runValidation(source)}
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

      {dialog?.kind === "create" ? (
        <CreateSourceDialog
          institutionId={activeInstitutionId}
          onClose={closeDialog}
          onCreated={(source) => {
            setDialog(null);
            setOutcome({
              tone: "info",
              message:
                `Source "${source.name}" (id ${source.id}) is stored with status ` +
                `"${source.status}", which the server sets without contacting anything. ` +
                `${connectionSentence(source)}. Validate it to find out whether the ` +
                "configuration actually reaches the source, then start a scan from the " +
                "Scans page. Created by " +
                `${source.created_by || "the account the server recorded"}.`,
            });
            refetch();
          }}
        />
      ) : null}

      {dialog?.kind === "edit" ? (
        <EditSourceDialog
          source={dialog.source}
          institutionId={activeInstitutionId}
          onClose={closeDialog}
          onSaved={(source) => {
            setDialog(null);
            setOutcome({
              tone: "info",
              message: `Source "${source.name}" (id ${source.id}) is updated: status ` +
                `"${source.status}", ${
                  source.connector_type === "local_folder"
                    ? `root key ${source.root_key ?? "not set"}`
                    : "no root key applies to this connector"
                }. ${connectionSentence(source)}. Changing a record does not run anything: ` +
                "no scan was started and no file was read.",
            });
            refetch();
          }}
        />
      ) : null}

      {dialog?.kind === "details" ? (
        <DetailsDialog source={dialog.source} onClose={closeDialog} />
      ) : null}
    </div>
  );
}

/* --------------------------------- filters -------------------------------- */

function FilterCard({
  query,
  filtersActive,
  totalOnPage,
  onChange,
  onClear,
}: {
  query: SourceQuery;
  filtersActive: boolean;
  totalOnPage: number;
  onChange: (patch: Partial<SourceQuery>) => void;
  onClear: () => void;
}) {
  return (
    <Card>
      <CardHeader
        title="Find source records"
        description="The connector type and status filters are sent to the server and affect the total. The name box is applied in the browser to the page already loaded, because the list route has no search parameter."
      />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Field label="Connector type" hint="Server-side filter.">
            {(control) => (
              <Select
                {...control}
                value={query.connectorType}
                onChange={(event) =>
                  onChange({ connectorType: event.target.value as ConnectorType | "" })
                }
              >
                <option value="">Any connector type</option>
                {CONNECTOR_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} — {option.value}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Record status"
            hint="Server-side filter. active means enabled, not reachable."
          >
            {(control) => (
              <Select
                {...control}
                value={query.status}
                onChange={(event) => onChange({ status: event.target.value as SourceStatus | "" })}
              >
                <option value="">Any status</option>
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Name contains"
            hint={`Browser-side only: the API has no name search, so this narrows the ${totalOnPage} loaded row${
              totalOnPage === 1 ? "" : "s"
            }, not the whole table.`}
          >
            {(control) => (
              <Input
                {...control}
                type="search"
                value={query.name}
                onChange={(event) => onChange({ name: event.target.value })}
                placeholder="Part of a source name"
              />
            )}
          </Field>
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

function SourceTable({
  items,
  canWrite,
  busy,
  validatingId,
  onDetails,
  onEdit,
  onValidate,
}: {
  items: Source[];
  canWrite: boolean;
  busy: boolean;
  validatingId: number | null;
  onDetails: (source: Source) => void;
  onEdit: (source: Source) => void;
  onValidate: (source: Source) => void;
}) {
  return (
    <Table caption="Connected source records in the current view">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Source</TableHeaderCell>
          <TableHeaderCell>Scope</TableHeaderCell>
          <TableHeaderCell>Record status</TableHeaderCell>
          <TableHeaderCell>Connection evidence</TableHeaderCell>
          <TableHeaderCell className="hidden lg:table-cell">Created</TableHeaderCell>
          <TableHeaderCell className="hidden xl:table-cell">Updated</TableHeaderCell>
          <TableHeaderCell align="right">Actions</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {items.map((source) => (
          <SourceRow
            key={source.id}
            source={source}
            canWrite={canWrite}
            busy={busy}
            validating={validatingId === source.id}
            onDetails={() => onDetails(source)}
            onEdit={() => onEdit(source)}
            onValidate={() => onValidate(source)}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function SourceRow({
  source,
  canWrite,
  busy,
  validating,
  onDetails,
  onEdit,
  onValidate,
}: {
  source: Source;
  canWrite: boolean;
  busy: boolean;
  validating: boolean;
  onDetails: () => void;
  onEdit: () => void;
  onValidate: () => void;
}) {
  const label = source.connector_type ?? "No connector type recorded";
  return (
    <TableRow>
      <TableCell className="max-w-sm">
        <p className="break-words font-medium text-ink">{source.name}</p>
        <p className="mt-0.5 font-mono text-meta text-ink-muted">id {source.id}</p>
        <p className="mt-0.5 text-meta text-ink-muted">
          {source.connector_type === null ? label : humanize(source.connector_type)}
        </p>
      </TableCell>
      <TableCell>
        <p>
          {source.institution_id === null
            ? "No institution attached"
            : `Institution #${source.institution_id}`}
        </p>
        {source.connector_type === "local_folder" ? (
          <p className="mt-0.5 font-mono text-meta text-ink-muted" title="Allow-list key, not a path">
            key {source.root_key ?? "not set"}
          </p>
        ) : null}
      </TableCell>
      <TableCell>
        <Badge tone={sourceStatusTone(source.status)}>{source.status}</Badge>
        <p className="mt-1 text-meta text-ink-muted">
          {source.status === "inactive" ? "Scans are not expected to run" : "Enabled by an operator"}
        </p>
      </TableCell>
      <TableCell>
        <p className="text-supporting">{validationSentence(source)}</p>
        {source.last_validation_message ? (
          <p className="mt-0.5 max-w-xs break-words text-meta text-ink-muted" title={source.last_validation_message}>
            {source.last_validation_message}
          </p>
        ) : null}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap lg:table-cell">
        <time dateTime={source.created_at.slice(0, 10)}>{asDate(source.created_at)}</time>
      </TableCell>
      <TableCell className="hidden whitespace-nowrap xl:table-cell">
        <time dateTime={source.updated_at.slice(0, 10)}>{asDate(source.updated_at)}</time>
      </TableCell>
      <TableCell align="right">
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onDetails}>
            Details
          </Button>
          {canWrite ? (
            <>
              <Button variant="secondary" size="sm" onClick={onEdit} disabled={busy}>
                Edit
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={onValidate}
                loading={validating}
                disabled={busy}
                title={
                  busy && !validating
                    ? "Another validation is still in flight; the server runs each one inside its request."
                    : "Ask the server whether this configuration can reach the source now"
                }
              >
                Validate
              </Button>
            </>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
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
      aria-label="Source pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-card-x py-3"
    >
      <Button variant="secondary" size="sm" disabled={disabled || page <= 1} onClick={onPrevious} className="gap-1">
        Previous
      </Button>
      <p className="text-meta text-ink-muted tabular-nums">
        Page {page} of {pages} · {total} source{total === 1 ? "" : "s"} matching
      </p>
      <Button variant="secondary" size="sm" disabled={disabled || page >= pages} onClick={onNext} className="gap-1">
        Next
      </Button>
    </nav>
  );
}

/* ------------------------------- create source ----------------------------- */

function CreateSourceDialog({
  institutionId,
  onClose,
  onCreated,
}: {
  institutionId: number | null;
  onClose: () => void;
  onCreated: (source: Source) => void;
}) {
  const [form, setForm] = useState<SourceForm>(EMPTY_FORM);
  /**
   * Nothing is flagged before the first submit; afterwards the messages are
   * derived from the current form, so a refusal never outlives the field it
   * describes.
   */
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? validateForm(form, form.connectorType) : {};
  const [serverError, setServerError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const conflictRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  /** A refusal has to be where focus lands once the submit button goes away. */
  useEffect(() => {
    if (busy) {
      return;
    }
    if (refusal !== null) {
      conflictRef.current?.focus();
    } else if (serverError !== null) {
      errorRef.current?.focus();
    }
  }, [busy, refusal, serverError]);

  const activeConnector = form.connectorType;

  function update(patch: Partial<SourceForm>): void {
    setForm((current) => {
      const next = { ...current, ...patch };
      // A synthetic record cannot carry a root key, and the server would refuse
      // it: switching the type drops the key instead of hiding an invalid value.
      if (patch.connectorType !== undefined && patch.connectorType !== "local_folder") {
        next.rootKey = "";
      }
      return next;
    });
    setServerError(null);
    setRefusal(null);
  }

  async function submit(): Promise<void> {
    const found = validateForm(form, form.connectorType);
    setAttempted(true);
    setServerError(null);
    setRefusal(null);
    if (isInvalid(found)) {
      return;
    }
    setBusy(true);
    try {
      const config = parseConfig(form.configText);
      const input: SourceCreateInput = {
        name: form.name.trim(),
        connector_type: activeConnector,
        institution_id: institutionId ?? undefined,
        root_key:
          activeConnector === "local_folder" && form.rootKey.trim() !== ""
            ? form.rootKey.trim()
            : undefined,
        config: config.ok && config.value !== null ? config.value : undefined,
      };
      onCreated(await createSource(input));
    } catch (cause) {
      const message = toErrorMessage(cause);
      if (cause instanceof ApiError && cause.status === 409) {
        setRefusal({
          title: "The server already has a source with that name",
          detail:
            `${message} Names are unique per institution, so this is not a retry-the-same-thing ` +
            "error: the record already exists. It may have been created by another operator, or " +
            "by an earlier submit that did reach the server. Reload the list and edit the record " +
            "that is there instead of adding a second one.",
        });
      } else if (cause instanceof ApiError && cause.status === 422) {
        setRefusal({
          title: "The server refused this configuration and stored nothing",
          detail:
            `${message} A local_folder root key has to be an entry an operator already added to ` +
            "LOCAL_SOURCE_ROOTS, the connector type has to be one the backend can build, and the " +
            "configuration has to be a JSON object without secret-looking keys. No record was " +
            "created, so nothing needs to be undone.",
        });
      } else {
        setServerError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title="Add source record"
      description="This writes a configuration record. The backend is not contacted, no folder is opened and no record is discovered — the status is set to active by the server without any check, and nothing is scheduled. Validating and scanning are separate, explicit actions."
      onClose={onClose}
      initialFocusRef={nameRef}
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Source name"
            error={errors.name}
            required
            hint={`Free text, ${NAME_MAX} characters at most. Unique within one institution.`}
            className="sm:col-span-2"
          >
            {(control) => (
              <Input
                {...control}
                ref={nameRef}
                maxLength={NAME_MAX}
                invalid={errors.name !== undefined}
                value={form.name}
                disabled={busy}
                onChange={(event) => update({ name: event.target.value })}
                placeholder="HR test corpus"
              />
            )}
          </Field>

          <Field label="Connector type" required hint="Not editable later: these are the only two the backend can build.">
            {(control) => (
              <Select
                {...control}
                value={form.connectorType}
                disabled={busy}
                onChange={(event) => update({ connectorType: event.target.value as ConnectorType })}
              >
                {CONNECTOR_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} — {option.value}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {activeConnector === "local_folder" ? (
            <Field
              label="Root key"
              error={errors.rootKey}
              required
              hint={`The name of a folder already allow-listed in the server's LOCAL_SOURCE_ROOTS, ${ROOT_KEY_MAX} characters at most. Never a path.`}
            >
              {(control) => (
                <Input
                  {...control}
                  maxLength={ROOT_KEY_MAX}
                  invalid={errors.rootKey !== undefined}
                  value={form.rootKey}
                  disabled={busy}
                  onChange={(event) => update({ rootKey: event.target.value })}
                  placeholder="sample_folder"
                />
              )}
            </Field>
          ) : (
            <Field
              label="Root key"
              error={errors.rootKey}
              hint="Not applicable to a synthetic source, and the server refuses it if set."
            >
              {(control) => (
                <Input
                  {...control}
                  value=""
                  disabled
                  readOnly
                  title="A synthetic source has no root_key."
                  placeholder="Not used by this connector"
                />
              )}
            </Field>
          )}

          <Field
            label="Configuration (JSON object)"
            error={errors.configText}
            hint={`Optional. Sent to the connector verbatim. Secret-looking keys — ${SECRET_CONFIG_KEYS.join(
              ", ",
            )} — and more than ${CONFIG_KEY_MAX} keys are refused, here and by the server.`}
            className="sm:col-span-2"
          >
            {(control) => (
              <Textarea
                {...control}
                rows={5}
                spellCheck={false}
                invalid={errors.configText !== undefined}
                value={form.configText}
                disabled={busy}
                onChange={(event) => update({ configText: event.target.value })}
                placeholder={
                  activeConnector === "synthetic"
                    ? '{\n  "count": 25,\n  "categories": ["hr_records"],\n  "sensitivity_levels": ["internal"]\n}'
                    : "{}"
                }
              />
            )}
          </Field>
        </div>

        <p className="rounded-card border border-line bg-surface-sunken px-card-x py-card-y text-meta text-ink-muted">
          {CONNECTOR_OPTIONS.find((option) => option.value === activeConnector)?.blurb}
        </p>

        <ul className="list-disc space-y-1 text-meta text-ink-muted">
          <li>
            {institutionId === null
              ? "Your account is not scoped to one institution, so the request carries no institution_id and the record is stored without one."
              : `Saved with institution_id ${institutionId}, the scope this list is reading. The server reconciles it with your verified identity; a scope you are not a member of is refused.`}
          </li>
          <li>
            A local_folder key that an operator has not allow-listed is refused with 422 and names
            LOCAL_SOURCE_ROOTS in the message. On ephemeral hosting the folder may not exist at all,
            so a stored key there is not evidence that anything can be read.
          </li>
          <li>
            The synthetic connector generates fictional records; it is a way to exercise the
            pipeline, not a connection to a real system. The API has no other connector type, and
            this screen offers none.
          </li>
        </ul>

        {refusal ? (
          <div
            ref={conflictRef}
            tabIndex={-1}
            role="alert"
            className="rounded-card border border-warning-line bg-warning-surface px-card-x py-card-y text-supporting text-warning-ink focus:outline-none"
          >
            <p className="font-semibold">{refusal.title}</p>
            <p className="mt-1">{refusal.detail}</p>
          </div>
        ) : null}

        <ServerMessage error={serverError} busy={busy} errorRef={errorRef} />

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Save source record
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* --------------------------------- edit ----------------------------------- */

function EditSourceDialog({
  source,
  institutionId,
  onClose,
  onSaved,
}: {
  source: Source;
  institutionId: number | null;
  onClose: () => void;
  onSaved: (source: Source) => void;
}) {
  const connector = source.connector_type;
  const isLocalFolder = connector === "local_folder";
  /**
   * The connector is not editable, and the list route excludes records without
   * one, so the stored value is the rule set used for validation.
   */
  const lockedConnector: ConnectorType = isLocalFolder ? "local_folder" : "synthetic";

  const [form, setForm] = useState<SourceForm>({
    name: source.name,
    connectorType: lockedConnector,
    rootKey: source.root_key ?? "",
    configText: source.config === null ? "" : JSON.stringify(source.config, null, 2),
    status: source.status === "inactive" ? "inactive" : "active",
  });
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? validateForm(form, lockedConnector) : {};
  const [serverError, setServerError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const conflictRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  /** A refusal has to be where focus lands once the submit button goes away. */
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

  function update(patch: Partial<SourceForm>): void {
    setForm((current) => ({ ...current, ...patch }));
    setServerError(null);
    setConflict(null);
  }

  async function submit(): Promise<void> {
    const found = validateForm(form, lockedConnector);
    setAttempted(true);
    setServerError(null);
    setConflict(null);
    if (isInvalid(found)) {
      return;
    }
    setBusy(true);
    try {
      const config = parseConfig(form.configText);
      const input: SourceUpdateInput = {
        name: form.name.trim(),
        status: form.status,
        config: config.ok ? (config.value ?? {}) : undefined,
        root_key: isLocalFolder && form.rootKey.trim() !== "" ? form.rootKey.trim() : undefined,
      };
      onSaved(await updateSource(source.id, input, institutionId ?? undefined));
    } catch (cause) {
      const message = toErrorMessage(cause);
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 422)) {
        setConflict(
          cause.status === 409
            ? `${message} Another record already holds that name in this institution. Nothing was ` +
              "changed on this one — the server refuses before it writes."
            : `${message} The server kept this record exactly as it was. Nothing here was saved.`,
        );
      } else {
        setServerError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={`Edit "${source.name}"`}
      description="Only the four fields the PATCH endpoint accepts are editable: the name, the root key of a local_folder source, the configuration and the record status. The connector type and the institution are fixed, and the API has no delete endpoint for sources."
      onClose={onClose}
      initialFocusRef={nameRef}
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
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Detail label="Source id">
            <span className="font-mono">{source.id}</span>
          </Detail>
          <Detail label="Connector type">
            {connector === null ? "Not recorded" : humanize(connector)} —{" "}
            <span className="font-mono">{connector ?? "—"}</span>
            <p className="mt-1 text-meta text-ink-muted">Not editable.</p>
          </Detail>
        </dl>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Source name"
            error={errors.name}
            required
            hint={`Changing it to a name another record in this institution already has is refused with 409.`}
          >
            {(control) => (
              <Input
                {...control}
                ref={nameRef}
                maxLength={NAME_MAX}
                invalid={errors.name !== undefined}
                value={form.name}
                disabled={busy}
                onChange={(event) => update({ name: event.target.value })}
              />
            )}
          </Field>

          <Field
            label="Record status"
            hint="Enablement only. Setting inactive is how a source is retired, because there is no delete endpoint."
          >
            {(control) => (
              <Select
                {...control}
                value={form.status}
                disabled={busy}
                onChange={(event) => update({ status: event.target.value as SourceStatus })}
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {isLocalFolder ? (
            <Field
              label="Root key"
              error={errors.rootKey}
              required
              hint={`An allow-list name, never a path. A key the operator has not configured in LOCAL_SOURCE_ROOTS is refused with 422.`}
            >
              {(control) => (
                <Input
                  {...control}
                  maxLength={ROOT_KEY_MAX}
                  invalid={errors.rootKey !== undefined}
                  value={form.rootKey}
                  disabled={busy}
                  onChange={(event) => update({ rootKey: event.target.value })}
                />
              )}
            </Field>
          ) : (
            <Detail label="Root key">
              {source.root_key === null ? "None — this connector has no root key." : source.root_key}
              <p className="mt-1 text-meta text-ink-muted">
                Only a local_folder source has a root_key, and this record is not one.
              </p>
            </Detail>
          )}

          <Field
            label="Configuration (JSON object)"
            error={errors.configText}
            hint={`Stored verbatim, replacing the current value on save. ${SECRET_CONFIG_KEYS.join(
              ", ",
            )} are refused.`}
            className="sm:col-span-2"
          >
            {(control) => (
              <Textarea
                {...control}
                rows={5}
                spellCheck={false}
                invalid={errors.configText !== undefined}
                value={form.configText}
                disabled={busy}
                onChange={(event) => update({ configText: event.target.value })}
                placeholder="{}"
              />
            )}
          </Field>
        </div>

        <ul className="list-disc space-y-1 text-meta text-ink-muted">
          <li>
            Validation evidence is not editable and is not reset by saving: the last check on this
            record says {connectionSentence(source).toLowerCase()}
            {source.last_validated_at === null
              ? "."
              : ` as at ${asDate(source.last_validated_at)}.`}{" "}
            Editing the configuration makes that answer about the old configuration, so validate
            again after a material change.
          </li>
          <li>
            Saving changes the record only. It starts nothing, contacts nothing, and archives,
            restores or deletes no record — the API has no endpoint for any of that here.
          </li>
        </ul>

        {conflict ? (
          <div
            ref={conflictRef}
            tabIndex={-1}
            role="alert"
            className="rounded-card border border-warning-line bg-warning-surface px-card-x py-card-y text-supporting text-warning-ink focus:outline-none"
          >
            <p className="font-semibold">The server refused this save</p>
            <p className="mt-1">{conflict}</p>
          </div>
        ) : null}

        <ServerMessage error={serverError} busy={busy} errorRef={errorRef} />

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Save changes
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* -------------------------------- details --------------------------------- */

function DetailsDialog({ source, onClose }: { source: Source; onClose: () => void }) {
  return (
    <Dialog
      open
      title={source.name}
      description="Every value below is a field the connector API returned for this record. Nothing is inferred."
      onClose={onClose}
      width="lg"
    >
      <div className="space-y-4">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Detail label="Status">
            <Badge tone={sourceStatusTone(source.status)}>{source.status}</Badge>
          </Detail>
          <Detail label="What status means">
            {source.status === "inactive"
              ? "Retired by an operator. It is still readable and can still be scanned if set back to active."
              : "Enabled by an operator. Set at creation without any contact with the source."}
          </Detail>
          <Detail label="Connector type">
            {source.connector_type === null ? "Not recorded" : humanize(source.connector_type)}
            <span className="mt-1 block font-mono text-meta text-ink-muted">
              {source.connector_type ?? "null"}
            </span>
          </Detail>
          <Detail label="Institution">
            {source.institution_id === null
              ? "Stored without an institution"
              : `#${source.institution_id}`}
          </Detail>
          <Detail label="Root key">
            {source.root_key === null
              ? "None"
              : `${source.root_key} (an allow-list name, not a path)`}
          </Detail>
          <Detail label="Created by">{source.created_by || "Not recorded"}</Detail>
          <Detail label="Connection evidence">{connectionSentence(source)}</Detail>
          <Detail label="Last validated at">
            {source.last_validated_at ?? "Never — no validation has been run"}
          </Detail>
          <Detail label="Last validation ok">
            {source.last_validation_ok === null
              ? "No result recorded"
              : source.last_validation_ok
                ? "Reachable"
                : "Not reachable"}
          </Detail>
          <Detail label="Last validation message" wide>
            {source.last_validation_message ?? "No message recorded"}
          </Detail>
          <Detail label="Created">{source.created_at}</Detail>
          <Detail label="Updated">{source.updated_at}</Detail>
          <Detail label="Configuration" wide>
            {source.config === null
              ? "No configuration stored"
              : Object.keys(source.config).length === 0
                ? "Empty object"
                : formatConfigEntries(source.config)}
          </Detail>
        </dl>

        <p className="rounded-card border border-line bg-surface-sunken px-card-x py-card-y text-meta text-ink-muted">
          The configuration is shown exactly as stored. The schema refuses secret-looking keys when
          a record is written, so this view can display it without a masking step — and no field of
          a source is a credential. There is no history endpoint: an earlier value of a field, or
          who changed it, is not something the API returns. Scan jobs for this source are listed on
          the Scans page.
        </p>
      </div>
    </Dialog>
  );
}

/** `key=value` per line, with nested values printed as the JSON the server stored. */
function formatConfigEntries(config: Record<string, unknown>): ReactNode {
  const entries = Object.entries(config);
  return (
    <ul className="space-y-0.5 font-mono text-meta">
      {entries.map(([key, value]) => (
        <li key={key} className="break-words">
          {key}={typeof value === "object" ? JSON.stringify(value) : String(value)}
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------- shared --------------------------------- */

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

/** Server refusals are shown verbatim: they name the constraint the record broke. */
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
        <p ref={errorRef} tabIndex={-1} role="alert" className="text-supporting text-critical-ink focus:outline-none">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="text-meta text-ink-muted">
          Sending…
        </p>
      ) : null}
    </>
  );
}
