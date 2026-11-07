/**
 * Retention hold workspace (redesign Phase 5.6).
 *
 * A hold is a legal, audit or administrative block: while it is active the
 * assessment rules refuse any disposal-advancing recommendation for the assets it
 * covers. Nothing on this page moves, archives, restores or deletes a record.
 *
 * What the API does *not* provide shaped this view deliberately. The contract was
 * read out of `backend/app/api/routes/retention.py`,
 * `backend/app/api/schemas/retention.py` and `backend/app/services/retention.py`,
 * then re-checked against a running instance:
 *
 * - `GET /retention/holds` accepts only `status` and `institution_id`; the route
 *   hard-codes `page=1, per_page=100` ordered by id descending and answers a bare
 *   array. There is no search parameter, so the name and coverage controls are
 *   labelled as browser-side narrowing of the rows already loaded.
 * - Only two lifecycle states exist (`HoldStatus`): `active` and `released`. A
 *   hold is created active — there is no draft — and no endpoint returns a hold to
 *   active, so release is the one irreversible write on this page.
 * - `POST /holds` takes `name`, optional `asset_id`, `hold_type`, `legal_basis`,
 *   `institution_id`, `asset_scope` and `scope`. Its `reason` field is accepted by
 *   the schema and then discarded: the stored row and the response carry no
 *   reason. So the form offers hold type and legal basis, and says why there is
 *   no reason box.
 * - `PATCH /holds/{id}/release` takes an optional `release_reason`. The server
 *   writes `released_by = "system"`, not the caller's identity, and the same
 *   constant for `created_by` — the view never claims operator attribution.
 * - There is no `GET /holds/{id}`, no version, no history, no events and no
 *   affected-asset list. Details therefore repeat only the fields the row already
 *   returned, and the block an asset is under is reported by the assessment
 *   surfaces (`holds_active`), not invented here.
 * - `retention:read` authorises the list; `retention:write` authorises both
 *   writes, and a supplied `institution_id` is reconciled with the verified
 *   identity server-side.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import { ApiError, toErrorMessage } from "../api/client";
import { createHold, listHolds, releaseHold } from "../api/retention";
import type { Hold, HoldStatus } from "../api/types";
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
import { formatDate } from "../lib/format";
import { toneForHoldStatus } from "../lib/semantic";

/** The two values `Hold.status` accepts (`HoldStatus` in the schema). */
const STATUSES: Array<{ value: HoldStatus; label: string }> = [
  { value: "active", label: "Active" },
  { value: "released", label: "Released" },
];

/** `HoldCreate` limits, mirrored so an over-long value is not a wasted round trip. */
const NAME_MAX = 200;
const TYPE_MAX = 50;
const BASIS_MAX = 200;

/** The `per_page` the list route passes to the service; it is not a client parameter. */
const SERVER_ROW_LIMIT = 100;

/** Browser-side narrowing of the loaded rows by what the hold covers. */
type CoverageFilter = "any" | "asset" | "scope";

type DialogState =
  | { kind: "create" }
  | { kind: "details"; hold: Hold }
  | { kind: "release"; hold: Hold }
  | null;

/** Whether a row targets one asset or every asset in its scope. */
function coversAsset(hold: Hold): boolean {
  return hold.asset_id !== null;
}

/**
 * How the server reads the row's coverage. An active hold with no asset id is
 * counted against every asset by `count_active_holds_for_asset`, which matches
 * `asset_id = <asset> OR asset_id IS NULL` — so an unscoped hold blocks more than
 * it appears to, and the view has to say so.
 */
function blockingSentence(hold: Hold): string {
  if (hold.status === "released") {
    return "No longer blocks any recommendation";
  }
  return hold.asset_id === null
    ? "Blocks every asset in scope"
    : "Blocks this asset only";
}

interface HoldForm {
  name: string;
  assetId: string;
  holdType: string;
  legalBasis: string;
}

type FormErrors = Partial<Record<keyof HoldForm, string>>;

const EMPTY_FORM: HoldForm = { name: "", assetId: "", holdType: "", legalBasis: "" };

/**
 * Client-side checks for what `HoldCreate` enforces with Pydantic. Duplicate
 * names are deliberately not refused: the holds table has no unique constraint,
 * so two holds may share a name and the server accepts both.
 */
function validate(form: HoldForm): FormErrors {
  const errors: FormErrors = {};
  const name = form.name.trim();
  if (name === "") {
    errors.name = "A hold name is required.";
  } else if (name.length > NAME_MAX) {
    errors.name = `A hold name must be ${NAME_MAX} characters or fewer.`;
  }
  if (form.holdType.length > TYPE_MAX) {
    errors.holdType = `A hold type must be ${TYPE_MAX} characters or fewer.`;
  }
  if (form.legalBasis.length > BASIS_MAX) {
    errors.legalBasis = `A legal basis must be ${BASIS_MAX} characters or fewer.`;
  }
  const asset = form.assetId.trim();
  if (asset !== "" && !/^[1-9]\d*$/.test(asset)) {
    errors.assetId =
      "An asset reference is a whole number, or empty for a hold that covers the whole scope.";
  }
  return errors;
}

function isInvalid(errors: FormErrors): boolean {
  return Object.keys(errors).length > 0;
}

export default function Holds() {
  const { activeInstitutionId, has } = useAuth();
  const canWrite = has("retention:write");

  const [statusFilter, setStatusFilter] = useState<HoldStatus | "">("");
  const [nameFilter, setNameFilter] = useState("");
  const [coverageFilter, setCoverageFilter] = useState<CoverageFilter>("any");
  const [outcome, setOutcome] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);

  const { data, loading, error, refetch } = useApiQuery(
    (signal) => {
      const params: { status?: string; institution_id?: number } = {};
      if (activeInstitutionId !== null) {
        params.institution_id = activeInstitutionId;
      }
      if (statusFilter !== "") {
        params.status = statusFilter;
      }
      return listHolds(params, signal);
    },
    [activeInstitutionId, statusFilter],
  );

  const holds = useMemo(() => data ?? [], [data]);

  const rows = useMemo(() => {
    const needle = nameFilter.trim().toLowerCase();
    return holds.filter((hold) => {
      if (coverageFilter === "asset" && !coversAsset(hold)) {
        return false;
      }
      if (coverageFilter === "scope" && coversAsset(hold)) {
        return false;
      }
      return needle === "" || hold.name.toLowerCase().includes(needle);
    });
  }, [holds, nameFilter, coverageFilter]);

  const counts = useMemo(
    () =>
      STATUSES.map((status) => ({
        ...status,
        count: holds.filter((hold) => hold.status === status.value).length,
      })),
    [holds],
  );

  /** Either filter can empty the view without the scope itself being empty. */
  const filtersActive = statusFilter !== "" || nameFilter.trim() !== "" || coverageFilter !== "any";

  function closeDialog(): void {
    setDialog(null);
  }

  return (
    <div className="space-y-gutter">
      <PageHeader
        title="Retention Holds"
        description="Legal, audit and administrative holds. While a hold is active, the assessment rules refuse any recommendation that would advance the lifecycle of the records it covers. Releasing a hold changes only that: nothing is archived, restored or deleted here, and a released hold cannot be returned to active."
        actions={
          canWrite ? (
            <Button onClick={() => setDialog({ kind: "create" })}>Create hold</Button>
          ) : undefined
        }
      />

      {outcome ? <OutcomeBanner message={outcome} onDismiss={() => setOutcome(null)} /> : null}

      {loading && data === null ? <Spinner label="Loading retention holds..." /> : null}

      {error ? <ErrorState title="Holds unavailable" message={error} onRetry={refetch} /> : null}

      {data !== null ? (
        <>
          <Card>
            <CardHeader
              title="Hold overview"
              description={`${scopeSentence(
                holds.length,
                activeInstitutionId,
              )}. The list route takes only a status and an institution filter and returns at most the ${
                SERVER_ROW_LIMIT
              } newest holds in scope, newest first.`}
              action={
                loading ? (
                  <span role="status" className="text-meta text-ink-muted">
                    Refreshing…
                  </span>
                ) : undefined
              }
            />
            <CardBody className="space-y-4">
              <div
                role="group"
                aria-label="Filter holds by status"
                className="flex flex-wrap items-center gap-2"
              >
                <StatusChip
                  label="All"
                  count={holds.length}
                  active={statusFilter === ""}
                  onSelect={() => setStatusFilter("")}
                />
                {counts.map((status) => (
                  <StatusChip
                    key={status.value}
                    label={status.label}
                    count={status.count}
                    active={statusFilter === status.value}
                    onSelect={() =>
                      setStatusFilter(statusFilter === status.value ? "" : status.value)
                    }
                  />
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-4">
                <Field
                  label="Hold name contains"
                  hint="Applied in the browser to the holds this list already loaded; it is not sent to the server."
                  className="min-w-48 max-w-sm flex-1"
                >
                  {(control) => (
                    <Input
                      {...control}
                      type="search"
                      value={nameFilter}
                      onChange={(event) => setNameFilter(event.target.value)}
                      placeholder="Part of a hold name"
                    />
                  )}
                </Field>
                <Field
                  label="Coverage"
                  hint="Also applied in the browser: the API has no coverage filter."
                  className="min-w-40"
                >
                  {(control) => (
                    <Select
                      {...control}
                      value={coverageFilter}
                      onChange={(event) => setCoverageFilter(event.target.value as CoverageFilter)}
                    >
                      <option value="any">Any coverage</option>
                      <option value="asset">One asset only</option>
                      <option value="scope">Every asset in scope</option>
                    </Select>
                  )}
                </Field>
                {filtersActive ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setStatusFilter("");
                      setNameFilter("");
                      setCoverageFilter("any");
                    }}
                  >
                    Clear filters
                  </Button>
                ) : null}
              </div>
              <p className="text-meta text-ink-muted">
                The counts above and the coverage control describe only the rows this response
                returned. A status chip is the one filter that is sent to the server.
              </p>
            </CardBody>
          </Card>

          {rows.length === 0 ? (
            <EmptyState
              title={filtersActive ? "No hold matches this view" : "No retention holds"}
              message={
                filtersActive
                  ? "Nothing in the loaded list answers the status, name or coverage filter in use. Clear a filter, or change the institution scope in the sidebar, to see the rest: an empty filtered view says nothing about the holds that do exist."
                  : "Nothing in this scope is under a hold. Creating one is a separate, explicit step: a new hold is active the moment it is created and immediately blocks recommendations, so none is created automatically."
              }
            />
          ) : (
            <Table caption="Retention holds in the current view">
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Hold</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Covers</TableHeaderCell>
                  <TableHeaderCell className="hidden lg:table-cell">Created</TableHeaderCell>
                  <TableHeaderCell className="hidden xl:table-cell">Released</TableHeaderCell>
                  <TableHeaderCell align="right">Actions</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((hold) => (
                  <HoldRow
                    key={hold.id}
                    hold={hold}
                    canWrite={canWrite}
                    onDetails={() => setDialog({ kind: "details", hold })}
                    onRelease={() => setDialog({ kind: "release", hold })}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </>
      ) : null}

      {dialog?.kind === "create" ? (
        <CreateHoldDialog
          institutionId={activeInstitutionId}
          onClose={closeDialog}
          onCreated={(hold) => {
            setDialog(null);
            setOutcome(
              `Hold "${hold.name}" is active (id ${hold.id}) and ${blockingSentence(
                hold,
              ).toLowerCase()}. The server recorded the actor as "${
                hold.created_by ?? "system"
            }", not your account. No record was moved, archived or deleted.`,
            );
            refetch();
          }}
        />
      ) : null}

      {dialog?.kind === "release" ? (
        <ReleaseDialog
          hold={dialog.hold}
          onClose={closeDialog}
          onReleased={(released) => {
            setDialog(null);
            setOutcome(
              `Hold "${released.name}" (id ${released.id}) is released. It no longer blocks ` +
                "recommendations for the assets it covered; assessments and any earlier " +
                "recommendations still report what they decided at the time. No record was " +
                `restored or deleted, and the server recorded the actor as "${
                  released.released_by ?? "system"
                }".`,
            );
            refetch();
          }}
          onReload={() => {
            setDialog(null);
            refetch();
          }}
        />
      ) : null}

      {dialog?.kind === "details" ? (
        <DetailsDialog hold={dialog.hold} onClose={closeDialog} />
      ) : null}
    </div>
  );
}

/** How many holds the response carried, and which institution it was asked for. */
function scopeSentence(count: number, activeInstitutionId: number | null): string {
  const head = `${count} ${count === 1 ? "hold" : "holds"}`;
  const verb = count === 1 ? "is" : "are";
  return activeInstitutionId === null
    ? `${head} ${verb} in scope for your platform-wide account, because no institution filter was sent`
    : `${head} ${verb} attached to institution #${activeInstitutionId}; a scoped list returns only ` +
      "holds carrying that institution, not holds stored without one";
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

/* ------------------------------- status chip ------------------------------ */

function StatusChip({
  label,
  count,
  active,
  onSelect,
}: {
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={`inline-flex items-center gap-2 rounded-pill px-3 py-1 text-supporting ring-1 ring-inset transition-colors ${
        active
          ? "bg-accent text-on-accent ring-accent"
          : "bg-surface text-ink-secondary ring-line-strong hover:bg-surface-hover"
      }`}
    >
      {label}{" "}
      <span className="font-mono tabular-nums">{count}</span>
    </button>
  );
}

/* ---------------------------------- table --------------------------------- */

function HoldRow({
  hold,
  canWrite,
  onDetails,
  onRelease,
}: {
  hold: Hold;
  canWrite: boolean;
  onDetails: () => void;
  onRelease: () => void;
}) {
  const released = hold.status === "released";
  return (
    <TableRow>
      <TableCell className="max-w-sm">
        <p className="break-words font-medium text-ink">{hold.name}</p>
        <p className="mt-0.5 font-mono text-meta text-ink-muted">id {hold.id}</p>
        {hold.legal_basis ? (
          <p className="mt-0.5 break-words text-meta text-ink-muted" title={hold.legal_basis}>
            {hold.legal_basis}
          </p>
        ) : null}
      </TableCell>
      <TableCell>
        <Badge tone={toneForHoldStatus(hold.status)}>{hold.status}</Badge>
        <p className="mt-1 text-meta whitespace-nowrap text-ink-muted">{blockingSentence(hold)}</p>
      </TableCell>
      <TableCell>
        {hold.asset_id === null ? (
          <p>Institution-wide</p>
        ) : (
          <p className="font-mono">#{hold.asset_id}</p>
        )}
        <p className="mt-0.5 text-meta text-ink-muted">
          {hold.hold_type ?? "No type recorded"}
        </p>
      </TableCell>
      <TableCell className="hidden whitespace-nowrap lg:table-cell">
        {formatDate(hold.created_at.slice(0, 10))}
      </TableCell>
      <TableCell className="hidden max-w-xs xl:table-cell">
        {hold.released_at === null ? (
          <p className="whitespace-nowrap text-ink-muted">Not released</p>
        ) : (
          <>
            <p className="whitespace-nowrap">{formatDate(hold.released_at.slice(0, 10))}</p>
            {hold.release_reason ? (
              <p className="mt-0.5 truncate text-meta text-ink-muted" title={hold.release_reason}>
                {hold.release_reason}
              </p>
            ) : (
              <p className="mt-0.5 text-meta text-ink-muted">No reason recorded</p>
            )}
          </>
        )}
      </TableCell>
      <TableCell align="right">
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onDetails}>
            Details
          </Button>
          {canWrite ? (
            <Button
              variant="critical"
              size="sm"
              onClick={onRelease}
              disabled={released}
              title={
                released
                  ? "This hold is already released, and the server refuses a second release."
                  : "Release this hold after confirming"
              }
            >
              Release
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

/* ------------------------------- create hold ------------------------------ */

function CreateHoldDialog({
  institutionId,
  onClose,
  onCreated,
}: {
  institutionId: number | null;
  onClose: () => void;
  onCreated: (hold: Hold) => void;
}) {
  const [form, setForm] = useState<HoldForm>(EMPTY_FORM);
  /**
   * Nothing is flagged before the first submit; after it the messages are derived
   * from the current form, so a refusal never stays on screen once the field it
   * describes has been fixed.
   */
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? validate(form) : {};
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  /**
   * The confirm button is disabled while the write is in flight, which drops
   * focus back to the page body. A refusal is announced, so it also has to be
   * where the operator's focus lands — otherwise a keyboard user is left inside
   * an open dialog with no idea where they are.
   */
  useEffect(() => {
    if (!busy && serverError !== null) {
      errorRef.current?.focus();
    }
  }, [busy, serverError]);

  function update(patch: Partial<HoldForm>): void {
    setForm((current) => ({ ...current, ...patch }));
  }

  async function submit(): Promise<void> {
    const found = validate(form);
    setAttempted(true);
    setServerError(null);
    if (isInvalid(found)) {
      return;
    }
    setBusy(true);
    try {
      const asset = form.assetId.trim();
      onCreated(
        await createHold({
          name: form.name.trim(),
          asset_id: asset === "" ? undefined : Number(asset),
          hold_type: form.holdType.trim() === "" ? undefined : form.holdType.trim(),
          legal_basis: form.legalBasis.trim() === "" ? undefined : form.legalBasis.trim(),
          institution_id: institutionId ?? undefined,
        }),
      );
    } catch (cause) {
      setServerError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title="Create hold"
      description="Creating a hold takes effect immediately: the server stores it as active, with no draft state, and every assessment from now on refuses lifecycle-advancing recommendations for the assets it covers. Read the summary below before placing it."
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
            label="Hold name"
            error={errors.name}
            required
            hint={`Free text, ${NAME_MAX} characters at most. Unlike policies, holds are not unique by name.`}
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
                placeholder="Litigation hold - case 2026-114"
              />
            )}
          </Field>
          <Field
            label="Hold type"
            error={errors.holdType}
            hint={`Stored verbatim, ${TYPE_MAX} characters at most. "legal", "audit" and "administrative" are the conventions in use.`}
          >
            {(control) => (
              <Input
                {...control}
                maxLength={TYPE_MAX}
                invalid={errors.holdType !== undefined}
                value={form.holdType}
                disabled={busy}
                onChange={(event) => update({ holdType: event.target.value })}
                placeholder="legal"
              />
            )}
          </Field>
          <Field
            label="Asset id (optional)"
            error={errors.assetId}
            hint="Leave empty for a hold that covers every asset in scope. An unknown id is refused with 404 Asset not found."
          >
            {(control) => (
              <Input
                {...control}
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                invalid={errors.assetId !== undefined}
                value={form.assetId}
                disabled={busy}
                onChange={(event) => update({ assetId: event.target.value })}
                placeholder="7"
              />
            )}
          </Field>
          <Field
            label="Legal basis"
            error={errors.legalBasis}
            hint={`Reference or authority, ${BASIS_MAX} characters at most. This is how a hold explains itself: the create endpoint has no reason field it keeps.`}
            className="sm:col-span-2"
          >
            {(control) => (
              <Input
                {...control}
                maxLength={BASIS_MAX}
                invalid={errors.legalBasis !== undefined}
                value={form.legalBasis}
                disabled={busy}
                onChange={(event) => update({ legalBasis: event.target.value })}
                placeholder="Litigation hold under case 2026-114"
              />
            )}
          </Field>
        </div>

        <ul className="list-disc space-y-1 rounded-card border border-line bg-surface-sunken px-card-x py-card-y text-meta text-ink-muted">
          <li>
            {institutionId === null
              ? "Your account is not scoped to one institution, so the request carries no institution and the hold is stored without one — it then covers assets in every institution."
              : `Sent with institution_id ${institutionId}, the scope this list is reading. An asset id from a different institution is refused with 422.`}
          </li>
          <li>
            {form.assetId.trim() === ""
              ? "With no asset id the hold blocks every asset in its scope, because the assessment rule counts an unscoped active hold against any asset."
              : `The hold will name asset #${form.assetId.trim()} only, so other assets stay unaffected by it.`}
          </li>
          <li>
            The server writes the actor as a constant, so this hold will read created by "system"
            rather than your account. Nothing here moves, archives or deletes a record.
          </li>
        </ul>

        <ServerMessage error={serverError} busy={busy} errorRef={errorRef} />

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Place hold
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* --------------------------------- release -------------------------------- */

function ReleaseDialog({
  hold,
  onClose,
  onReleased,
  onReload,
}: {
  hold: Hold;
  onClose: () => void;
  onReleased: (hold: Hold) => void;
  onReload: () => void;
}) {
  const [reason, setReason] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  /** A 409 is a state conflict, not a typo: it gets its own explanation. */
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const conflictRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

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
      onReleased(await releaseHold(hold.id, reason.trim() === "" ? undefined : reason.trim()));
    } catch (cause) {
      const message = toErrorMessage(cause);
      if (cause instanceof ApiError && cause.status === 409) {
        setConflict(
          `${message} The server kept its own state: this hold was already released, most likely ` +
            "by another operation, and nothing on this page changed it. The list you are looking at " +
            "is stale — reload it instead of trying again, because a released hold cannot be " +
            "released a second time.",
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
      title={`Release "${hold.name}"`}
      description="This is the consequential step, and it needs your explicit confirmation. Releasing removes a legal or administrative protection, and the retention API has no endpoint that returns a hold to active."
      onClose={onClose}
      initialFocusRef={reasonRef}
      width="md"
      dismissOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Keep the hold
          </Button>
          <Button variant="critical" loading={busy} onClick={() => void submit()}>
            Release hold
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Detail label="Hold">
            {hold.name} (id {hold.id})
          </Detail>
          <Detail label="Current status">
            <Badge tone={toneForHoldStatus(hold.status)}>{hold.status}</Badge>
          </Detail>
          <Detail label="Covers">
            {hold.asset_id === null ? (
              "Every asset in scope"
            ) : (
              <>
                Asset <span className="font-mono">#{hold.asset_id}</span> only
              </>
            )}
          </Detail>
          <Detail label="Effect of releasing">{blockingSentence(hold)}</Detail>
        </dl>

        <Field
          label="Release reason"
          hint="Optional. Stored on the row exactly as written and shown in the Released column. The server, not your account, is recorded as the actor."
        >
          {(control) => (
            <Textarea
              {...control}
              ref={reasonRef}
              rows={3}
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Litigation concluded; records return to normal retention handling."
            />
          )}
        </Field>

        <ul className="list-disc space-y-1 text-meta text-ink-muted">
          <li>
            Releasing changes only the hold. It archives nothing, restores nothing and deletes
            nothing, and it does not rewrite any assessment or recommendation already recorded.
          </li>
          <li>
            {hold.created_by === null
              ? "This row records no creator."
              : `The row records its creator as "${hold.created_by}".`}{" "}
            A refusal — another institution, or a state the server no longer accepts — is reported
            here and the list is left as it was.
          </li>
        </ul>

        {conflict ? (
          <div
            ref={conflictRef}
            tabIndex={-1}
            role="alert"
            className="rounded-card border border-warning-line bg-warning-surface px-card-x py-card-y text-supporting text-warning-ink focus:outline-none"
          >
            <p className="font-semibold">The server rejected this release as a conflict</p>
            <p className="mt-1">{conflict}</p>
            <Button className="mt-3" variant="secondary" size="sm" onClick={onReload}>
              Reload the hold list
            </Button>
          </div>
        ) : null}

        <ServerMessage error={serverError} busy={busy} errorRef={errorRef} />
      </div>
    </Dialog>
  );
}

/* -------------------------------- details -------------------------------- */

function DetailsDialog({ hold, onClose }: { hold: Hold; onClose: () => void }) {
  return (
    <Dialog
      open
      title={hold.name}
      description="Every value below is a field the retention API returned for this hold row."
      onClose={onClose}
      width="lg"
    >
      <div className="space-y-4">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Detail label="Status">
            <Badge tone={toneForHoldStatus(hold.status)}>{hold.status}</Badge>
          </Detail>
          <Detail label="Blocking effect">{blockingSentence(hold)}</Detail>
          <Detail label="Covers">
            {hold.asset_id === null ? (
              "No asset recorded: every asset in scope"
            ) : (
              <>
                Asset <span className="font-mono">#{hold.asset_id}</span>
              </>
            )}
          </Detail>
          <Detail label="Institution">
            {hold.institution_id === null
              ? "Stored without an institution"
              : `#${hold.institution_id}`}
          </Detail>
          <Detail label="Hold type">{hold.hold_type ?? "No type recorded"}</Detail>
          <Detail label="Legal basis">{hold.legal_basis ?? "No legal basis recorded"}</Detail>
          <Detail label="Created by">{hold.created_by ?? "Not recorded"}</Detail>
          <Detail label="Created">{hold.created_at}</Detail>
          <Detail label="Released by">{hold.released_by ?? "Not released"}</Detail>
          <Detail label="Released at">{hold.released_at ?? "Not released"}</Detail>
          <Detail label="Release reason" wide>
            {hold.release_reason ?? "No reason recorded"}
          </Detail>
          <Detail label="Scope entries" wide>
            {hold.scope === null || hold.scope.length === 0
              ? "None recorded"
              : hold.scope.map((entry, index) => describeScopeEntry(entry, index)).join("; ")}
          </Detail>
          <Detail label="Asset scope" wide>
            {hold.asset_scope === null
              ? "None recorded"
              : describeScopeEntry(hold.asset_scope, 0)}
          </Detail>
        </dl>
        <p className="rounded-card border border-line bg-surface-sunken px-card-x py-card-y text-meta text-ink-muted">
          No history is shown because the retention API exposes no endpoint for a single hold, its
          events, or the assets behind its scope. The server also writes a constant actor, so
          "created by" and "released by" name that value rather than an operator.
        </p>
      </div>
    </Dialog>
  );
}

/**
 * A scope entry is arbitrary JSON the server stores verbatim. It is rendered as
 * the keys and values it actually carries — never reinterpreted as an asset
 * reference, a legal status or a date.
 */
function describeScopeEntry(entry: Record<string, unknown>, index: number): string {
  const parts = Object.entries(entry).map(
    ([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
  );
  return `Entry ${index + 1}: ${parts.length === 0 ? "empty object" : parts.join(", ")}`;
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
      <dd className="mt-1 text-supporting break-words text-ink-secondary">{children}</dd>
    </div>
  );
}

/** Server refusals are shown verbatim: they name the constraint the row broke. */
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
          Sending…
        </p>
      ) : null}
    </>
  );
}
