/**
 * Retention policy workspace (redesign Phase 5.5).
 *
 * Policies are governance configuration only. Nothing on this page moves,
 * archives or deletes an asset: assessments consult policies to produce
 * advisory recommendations, and every mutation here changes configuration.
 *
 * What the API does *not* provide shaped this view deliberately. The contract
 * was read out of `backend/app/api/routes/retention.py` and
 * `backend/app/services/retention.py`:
 *
 * - `GET /retention/policies` accepts only `status` and `institution_id`; the
 *   route hard-codes `page=1, per_page=100` ordered by id descending. There is
 *   no search parameter, so the name box is labelled as a browser-side
 *   narrowing of the rows already loaded rather than a server query.
 * - No endpoint lists a policy's versions. Only `POST /policies/{id}/versions`
 *   (whose response names the version it created) and the policy row's own
 *   `version` / `current_version_id` columns are readable, so activation is
 *   offered only for a version this session created and can therefore name.
 * - Creating a version leaves the policy row untouched: the server sets no
 *   current version and no status. Only `POST /policies/{id}/activate` moves a
 *   policy to `active`, and it takes a draft or approved version of that same
 *   policy.
 * - `retention:read` authorises the list, `retention:write` authorises every
 *   mutation, and a supplied `institution_id` is reconciled with the verified
 *   identity server-side.
 */

import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  activatePolicyVersion,
  createPolicy,
  createPolicyVersion,
  listPolicies,
} from "../api/retention";
import type { Phase3PolicyStatus, Policy, PolicyVersion } from "../api/types";
import { toErrorMessage } from "../api/client";
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
import { toneForPolicyStatus } from "../lib/semantic";

/** The five values `Policy.status` accepts (`PolicyStatus` in the schema). */
const STATUSES: Array<{ value: Phase3PolicyStatus; label: string }> = [
  { value: "draft", label: "Draft" },
  { value: "approved", label: "Approved" },
  { value: "active", label: "Active" },
  { value: "retired", label: "Retired" },
  { value: "inactive", label: "Inactive" },
];

/** The `RetentionTrigger` Literal from the same schema, in the order it lists. */
const TRIGGERS: Array<{ value: string; label: string }> = [
  { value: "created_at", label: "Created date" },
  { value: "modified_at", label: "Last modified date" },
  { value: "last_reviewed", label: "Last reviewed date" },
  { value: "source_created_at", label: "Source item created date" },
];

/** `PolicyCreate` limits, mirrored so an over-long value is not a wasted round trip. */
const NAME_MAX = 200;
const ACTION_MAX = 30;

/** The `per_page` the list route passes to the service; it is not a client parameter. */
const SERVER_ROW_LIMIT = 100;

type DialogState =
  | { kind: "create" }
  | { kind: "details"; policy: Policy }
  | { kind: "version"; policy: Policy }
  | { kind: "activate"; policy: Policy; version: PolicyVersion }
  | null;

/** A policy in these two states is closed: the route refuses new versions for it. */
function isClosed(policy: Policy): boolean {
  return policy.status === "retired" || policy.status === "inactive";
}

function labelForTrigger(value: string | null): string {
  if (value === null || value === "") {
    return "Trigger not set";
  }
  return TRIGGERS.find((trigger) => trigger.value === value)?.label ?? value;
}

/** The rule fields a policy row and a new version share, plus the policy name. */
interface PolicyForm {
  name: string;
  categories: string;
  trigger: string;
  periodDays: string;
  action: string;
  description: string;
  scopeDescription: string;
}

type FormErrors = Partial<Record<keyof PolicyForm, string>>;

const EMPTY_FORM: PolicyForm = {
  name: "",
  categories: "",
  trigger: "",
  periodDays: "",
  action: "",
  description: "",
  scopeDescription: "",
};

/** Prefill a revision from the policy row, which carries the same rule fields. */
function formOf(policy: Policy): PolicyForm {
  return {
    name: policy.name,
    categories: (policy.applicable_categories ?? []).join(", "),
    trigger: policy.retention_trigger ?? "",
    periodDays: policy.retention_period_days === null ? "" : String(policy.retention_period_days),
    action: policy.recommended_action ?? "",
    description: policy.description ?? "",
    scopeDescription: policy.scope_description ?? "",
  };
}

function categoriesOf(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Client-side checks for what `PolicyCreate` / `PolicyVersionCreate` enforce
 * with Pydantic. Anything not provable here — a name collision with a policy
 * outside the loaded rows, for instance — is left to the server and shown
 * exactly as it answers.
 */
function validate(form: PolicyForm, existingNames: string[], named: boolean): FormErrors {
  const errors: FormErrors = {};
  if (named) {
    const name = form.name.trim();
    if (name === "") {
      errors.name = "A policy name is required.";
    } else if (name.length > NAME_MAX) {
      errors.name = `A policy name must be ${NAME_MAX} characters or fewer.`;
    } else if (existingNames.includes(name)) {
      errors.name =
        `A policy named "${name}" is already listed. The server keys a policy on name ` +
        "plus version, so a second draft with the same name is refused.";
    }
  }
  const days = form.periodDays.trim();
  if (days !== "" && !/^\d+$/.test(days)) {
    errors.periodDays = "Retention period must be a whole number of days, 0 or more.";
  }
  if (form.action.length > ACTION_MAX) {
    errors.action = `A recommended action must be ${ACTION_MAX} characters or fewer.`;
  }
  return errors;
}

/** How many of `errors` would block a submission. */
function isInvalid(errors: FormErrors): boolean {
  return Object.keys(errors).length > 0;
}

export default function RetentionPolicies() {
  const { activeInstitutionId, has } = useAuth();
  const canWrite = has("retention:write");

  const [statusFilter, setStatusFilter] = useState<Phase3PolicyStatus | "">("");
  const [nameFilter, setNameFilter] = useState("");
  const [outcome, setOutcome] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  /**
   * Versions this session created. They are the only versions whose id and
   * status the client can know, because the API has no versions endpoint.
   */
  const [knownVersions, setKnownVersions] = useState<Record<number, PolicyVersion[]>>({});

  const { data, loading, error, refetch } = useApiQuery(
    (signal) => {
      const params: { status?: string; institution_id?: number } = {};
      if (activeInstitutionId !== null) {
        params.institution_id = activeInstitutionId;
      }
      if (statusFilter !== "") {
        params.status = statusFilter;
      }
      return listPolicies(params, signal);
    },
    [activeInstitutionId, statusFilter],
  );

  const policies = useMemo(() => data ?? [], [data]);

  const rows = useMemo(() => {
    const needle = nameFilter.trim().toLowerCase();
    if (needle === "") {
      return policies;
    }
    return policies.filter((policy) => policy.name.toLowerCase().includes(needle));
  }, [policies, nameFilter]);

  const counts = useMemo(
    () =>
      STATUSES.map((status) => ({
        ...status,
        count: policies.filter((policy) => policy.status === status.value).length,
      })),
    [policies],
  );

  /** A name collision can only be checked against what this view can see. */
  const visibleNames = useMemo(() => policies.map((policy) => policy.name), [policies]);

  /** Either filter can empty the view without the scope itself being empty. */
  const filtersActive = statusFilter !== "" || nameFilter.trim() !== "";

  function remember(version: PolicyVersion): void {
    setKnownVersions((current) => {
      const forPolicy = current[version.policy_id] ?? [];
      return {
        ...current,
        [version.policy_id]: [version, ...forPolicy.filter((item) => item.id !== version.id)],
      };
    });
  }

  /** Once activated, the version is no longer a candidate the view should offer. */
  function forget(version: PolicyVersion): void {
    setKnownVersions((current) => ({
      ...current,
      [version.policy_id]: (current[version.policy_id] ?? []).filter(
        (item) => item.id !== version.id,
      ),
    }));
  }

  function activatableVersionsOf(policy: Policy): PolicyVersion[] {
    if (isClosed(policy)) {
      return [];
    }
    return (knownVersions[policy.id] ?? []).filter(
      (version) =>
        (version.status === "draft" || version.status === "approved") &&
        version.id !== policy.current_version_id,
    );
  }

  function closeDialog(): void {
    setDialog(null);
  }

  return (
    <div className="space-y-gutter">
      <PageHeader
        title="Retention Policies"
        description="Retention rules and the versions they are kept in. A policy only shapes the advice in the review queue: it never moves, archives or deletes a record."
        actions={
          canWrite ? (
            <Button onClick={() => setDialog({ kind: "create" })}>Create draft policy</Button>
          ) : undefined
        }
      />

      {outcome ? <OutcomeBanner message={outcome} onDismiss={() => setOutcome(null)} /> : null}

      {loading && data === null ? <Spinner label="Loading retention policies..." /> : null}

      {error ? <ErrorState title="Policies unavailable" message={error} onRetry={refetch} /> : null}

      {data !== null ? (
        <>
          <Card>
            <CardHeader
              title="Policy overview"
              description={`${policies.length} ${
                policies.length === 1 ? "policy" : "policies"
              } ${scopeSentence(policies.length, activeInstitutionId)}. The list route takes only a status and an institution filter and returns at most the ${
                SERVER_ROW_LIMIT
              } newest policies in scope, newest first.`}
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
                aria-label="Filter policies by status"
                className="flex flex-wrap items-center gap-2"
              >
                <StatusChip
                  label="All"
                  count={policies.length}
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
                  label="Policy name contains"
                  hint="Applied in the browser to the policies this list already loaded; it is not sent to the server."
                  className="min-w-48 max-w-sm flex-1"
                >
                  {(control) => (
                    <Input
                      {...control}
                      type="search"
                      value={nameFilter}
                      onChange={(event) => setNameFilter(event.target.value)}
                      placeholder="Part of a policy name"
                    />
                  )}
                </Field>
                {nameFilter !== "" ? (
                  <Button variant="ghost" size="sm" onClick={() => setNameFilter("")}>
                    Clear name filter
                  </Button>
                ) : null}
              </div>
            </CardBody>
          </Card>

          {rows.length === 0 ? (
            <EmptyState
              title={
                filtersActive ? "No policy matches this view" : "No retention policies yet"
              }
              message={
                filtersActive
                  ? "No policy answers the status or name filter in use. Clear a filter, or change the institution scope in the sidebar, to see the rest: an empty filtered view says nothing about the policies that do exist."
                  : "This scope contains no retention policies. Creating one is a separate, explicit step: nothing is created automatically, and a new policy stays a draft until one of its versions is activated."
              }
            />
          ) : (
            <Table caption="Retention policies in the current view">
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Policy</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Applies to</TableHeaderCell>
                  <TableHeaderCell className="hidden lg:table-cell">Retention</TableHeaderCell>
                  <TableHeaderCell className="hidden xl:table-cell">Created</TableHeaderCell>
                  <TableHeaderCell align="right">Actions</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((policy) => (
                  <PolicyRow
                    key={policy.id}
                    policy={policy}
                    canWrite={canWrite}
                    activatable={activatableVersionsOf(policy)}
                    onDetails={() => setDialog({ kind: "details", policy })}
                    onNewVersion={() => setDialog({ kind: "version", policy })}
                    onActivate={(version) => setDialog({ kind: "activate", policy, version })}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </>
      ) : null}

      {dialog?.kind === "create" ? (
        <CreatePolicyDialog
          existingNames={visibleNames}
          institutionId={activeInstitutionId}
          onClose={closeDialog}
          onCreated={(policy) => {
            setDialog(null);
            setOutcome(
              `Draft policy "${policy.name}" created (id ${policy.id}). It is not active: a ` +
                "policy only reaches assessments once one of its versions is activated.",
            );
            refetch();
          }}
        />
      ) : null}

      {dialog?.kind === "version" ? (
        <NewVersionDialog
          policy={dialog.policy}
          onClose={closeDialog}
          onCreated={(version, policy) => {
            remember(version);
            setDialog(null);
            setOutcome(
              `Draft version ${version.version_number} of "${policy.name}" created (id ${
                version.id
              }). Creating a version does not activate it: the policy still reports status ` +
                `"${policy.status}"${
                  policy.current_version_id === null
                    ? " with no active version"
                    : ` and active version ${policy.version ?? `#${policy.current_version_id}`}`
                }.`,
            );
            refetch();
          }}
        />
      ) : null}

      {dialog?.kind === "activate" ? (
        <ActivateDialog
          policy={dialog.policy}
          version={dialog.version}
          onClose={closeDialog}
          onActivated={(updated, activated) => {
            forget(activated);
            setDialog(null);
            setOutcome(
              `Version ${activated.version_number} of "${updated.name}" is the current version ` +
                `and the policy now reports status "${updated.status}". No asset was moved, ` +
                "archived or deleted.",
            );
            refetch();
          }}
        />
      ) : null}

      {dialog?.kind === "details" ? (
        <DetailsDialog policy={dialog.policy} onClose={closeDialog} />
      ) : null}
    </div>
  );
}

/** Which institution the list was asked for, in the operator's own terms. */
function scopeSentence(count: number, activeInstitutionId: number | null): string {
  const verb = count === 1 ? "is" : "are";
  return activeInstitutionId === null
    ? `${verb} in scope for your platform-wide account, because no institution filter was sent`
    : `${verb} attached to institution #${activeInstitutionId}; a scoped list returns only policies ` +
        "carrying that institution, not policies stored without one";
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
      {label}
      <span className="font-mono tabular-nums">{count}</span>
    </button>
  );
}

/* ---------------------------------- table --------------------------------- */

function PolicyRow({
  policy,
  canWrite,
  activatable,
  onDetails,
  onNewVersion,
  onActivate,
}: {
  policy: Policy;
  canWrite: boolean;
  activatable: PolicyVersion[];
  onDetails: () => void;
  onNewVersion: () => void;
  onActivate: (version: PolicyVersion) => void;
}) {
  const closed = isClosed(policy);
  return (
    <TableRow>
      <TableCell className="max-w-sm">
        <p className="font-medium text-ink">{policy.name}</p>
        <p className="mt-0.5 font-mono text-meta text-ink-muted">#{policy.id}</p>
        {policy.description ? (
          <p className="mt-0.5 text-meta text-ink-subtle" title={policy.description}>
            {policy.description}
          </p>
        ) : null}
      </TableCell>
      <TableCell>
        <Badge tone={toneForPolicyStatus(policy.status)}>{policy.status}</Badge>
        <p className="mt-1 text-meta whitespace-nowrap text-ink-muted">
          {versionSentence(policy)}
        </p>
      </TableCell>
      <TableCell>
        <p>
          {policy.applicable_categories?.length
            ? policy.applicable_categories.join(", ")
            : "All categories"}
        </p>
        <p className="mt-0.5 text-meta text-ink-muted">{labelForTrigger(policy.retention_trigger)}</p>
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <p className="whitespace-nowrap">
          {policy.retention_period_days === null
            ? "No period set"
            : `${policy.retention_period_days} days`}
        </p>
        <p className="mt-0.5 text-meta text-ink-muted">
          {policy.recommended_action ?? "No action recorded"}
        </p>
      </TableCell>
      <TableCell className="hidden whitespace-nowrap xl:table-cell">
        {formatDate(policy.created_at.slice(0, 10))}
      </TableCell>
      <TableCell align="right">
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onDetails}>
            Details
          </Button>
          {canWrite ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={onNewVersion}
                disabled={closed}
                title={
                  closed
                    ? `A policy in status "${policy.status}" accepts no new versions.`
                    : "Add a draft version to this policy"
                }
              >
                New version
              </Button>
              {activatable.map((version) => (
                <Button key={version.id} size="sm" onClick={() => onActivate(version)}>
                  Activate v{version.version_number}
                </Button>
              ))}
            </>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * The version state the server actually reports on this row. `current_version_id`
 * is only ever set by activation, so its absence is reported as such rather than
 * guessed at.
 */
function versionSentence(policy: Policy): string {
  if (policy.current_version_id === null) {
    return "No active version";
  }
  return `Active version ${policy.version ?? `#${policy.current_version_id}`}`;
}

/* ------------------------------ shared fields ----------------------------- */

function RuleFields({
  form,
  errors,
  disabled,
  onChange,
}: {
  form: PolicyForm;
  errors: FormErrors;
  disabled: boolean;
  onChange: (patch: Partial<PolicyForm>) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        label="Applicable categories"
        hint="Comma separated, matched against the stored category value. Empty means every category."
      >
        {(control) => (
          <Input
            {...control}
            value={form.categories}
            disabled={disabled}
            onChange={(event) => onChange({ categories: event.target.value })}
            placeholder="hr_records, finance_reports"
          />
        )}
      </Field>
      <Field label="Retention trigger" hint="The date an asset's retention clock starts from.">
        {(control) => (
          <Select
            {...control}
            value={form.trigger}
            disabled={disabled}
            onChange={(event) => onChange({ trigger: event.target.value })}
          >
            <option value="">No trigger set</option>
            {TRIGGERS.map((trigger) => (
              <option key={trigger.value} value={trigger.value}>
                {trigger.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        label="Retention period (days)"
        error={errors.periodDays}
        hint="Calendar days added to the trigger date. Empty means no period is set."
      >
        {(control) => (
          <Input
            {...control}
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            invalid={errors.periodDays !== undefined}
            value={form.periodDays}
            disabled={disabled}
            onChange={(event) => onChange({ periodDays: event.target.value })}
            placeholder="365"
          />
        )}
      </Field>
      <Field
        label="Recommended action"
        error={errors.action}
        hint={`Stored verbatim, ${ACTION_MAX} characters at most. It is a label, not an instruction.`}
      >
        {(control) => (
          <Input
            {...control}
            maxLength={ACTION_MAX}
            invalid={errors.action !== undefined}
            value={form.action}
            disabled={disabled}
            onChange={(event) => onChange({ action: event.target.value })}
            placeholder="review"
          />
        )}
      </Field>
      <Field label="Description" className="sm:col-span-2">
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            value={form.description}
            disabled={disabled}
            onChange={(event) => onChange({ description: event.target.value })}
            placeholder="What this policy covers and why it exists."
          />
        )}
      </Field>
    </div>
  );
}

/** Server refusals are shown verbatim: they name the constraint the row broke. */
function ServerMessage({ error, busy }: { error: string | null; busy: boolean }) {
  return (
    <>
      {error ? (
        <p role="alert" className="text-supporting text-critical-ink">
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

function payloadRules(form: PolicyForm) {
  return {
    description: form.description.trim() === "" ? undefined : form.description.trim(),
    applicable_categories: categoriesOf(form.categories),
    retention_period_days:
      form.periodDays.trim() === "" ? undefined : Number(form.periodDays),
    retention_trigger: form.trigger === "" ? undefined : form.trigger,
    recommended_action: form.action.trim() === "" ? undefined : form.action.trim(),
  };
}

/* ------------------------------ create policy ----------------------------- */

function CreatePolicyDialog({
  existingNames,
  institutionId,
  onClose,
  onCreated,
}: {
  existingNames: string[];
  institutionId: number | null;
  onClose: () => void;
  onCreated: (policy: Policy) => void;
}) {
  const [form, setForm] = useState<PolicyForm>(EMPTY_FORM);
  /**
   * Nothing is flagged before the first submit; after it the messages are
   * derived from the current form, so a refusal never stays on screen once the
   * field it describes has been fixed.
   */
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? validate(form, existingNames, true) : {};
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  function update(patch: Partial<PolicyForm>): void {
    setForm((current) => ({ ...current, ...patch }));
  }

  async function submit(): Promise<void> {
    const found = validate(form, existingNames, true);
    setAttempted(true);
    setServerError(null);
    if (isInvalid(found)) {
      return;
    }
    setBusy(true);
    try {
      const created = await createPolicy({
        ...payloadRules(form),
        name: form.name.trim(),
        scope_description:
          form.scopeDescription.trim() === "" ? undefined : form.scopeDescription.trim(),
        institution_id: institutionId ?? undefined,
      });
      onCreated(created);
    } catch (cause) {
      setServerError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title="Create draft policy"
      description="The server stores a new policy as a draft with no active version. It changes no asset: a policy reaches assessments only once one of its versions is activated."
      onClose={onClose}
      initialFocusRef={nameRef}
      width="lg"
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
            label="Policy name"
            error={errors.name}
            required
            hint={`Unique per version, ${NAME_MAX} characters at most.`}
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
                placeholder="Employee records retention"
              />
            )}
          </Field>
          <RuleFields form={form} errors={errors} disabled={busy} onChange={update} />
          <Field
            label="Scope description"
            hint="Free text describing which records the policy is meant to cover."
            className="sm:col-span-2"
          >
            {(control) => (
              <Textarea
                {...control}
                rows={2}
                value={form.scopeDescription}
                disabled={busy}
                onChange={(event) => update({ scopeDescription: event.target.value })}
                placeholder="Records held for current and former employees of this institution."
              />
            )}
          </Field>
        </div>

        <p className="text-meta text-ink-muted">
          {institutionId === null
            ? "Your account is not scoped to one institution, so the request carries no institution and the policy is stored without one."
            : `Sent with institution_id ${institutionId}, the scope this list is reading.`}
        </p>

        <ServerMessage error={serverError} busy={busy} />

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Save draft
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------- new version ------------------------------ */

function NewVersionDialog({
  policy,
  onClose,
  onCreated,
}: {
  policy: Policy;
  onClose: () => void;
  onCreated: (version: PolicyVersion, policy: Policy) => void;
}) {
  const [form, setForm] = useState<PolicyForm>(() => formOf(policy));
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? validate(form, [], false) : {};
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const categoriesRef = useRef<HTMLInputElement>(null);

  function update(patch: Partial<PolicyForm>): void {
    setForm((current) => ({ ...current, ...patch }));
  }

  async function submit(): Promise<void> {
    const found = validate(form, [], false);
    setAttempted(true);
    setServerError(null);
    if (isInvalid(found)) {
      return;
    }
    setBusy(true);
    try {
      onCreated(await createPolicyVersion(policy.id, payloadRules(form)), policy);
    } catch (cause) {
      setServerError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={`New version of "${policy.name}"`}
      description="The server appends an immutable version and numbers it itself. It stays a draft: creating a version changes neither the policy's status nor its current version, and activation is a separate step."
      onClose={onClose}
      initialFocusRef={categoriesRef}
      width="lg"
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="text-supporting text-ink-secondary">
          The row reports status <Badge tone={toneForPolicyStatus(policy.status)}>{policy.status}</Badge>{" "}
          and {versionSentence(policy).toLowerCase()}. The fields below start from that row; change
          them to describe the revision.
        </p>

        <RuleFields form={form} errors={errors} disabled={busy} onChange={update} />

        <ServerMessage error={serverError} busy={busy} />

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Save draft version
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------ activation ------------------------------- */

function ActivateDialog({
  policy,
  version,
  onClose,
  onActivated,
}: {
  policy: Policy;
  version: PolicyVersion;
  onClose: () => void;
  onActivated: (updated: Policy, version: PolicyVersion) => void;
}) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setServerError(null);
    setBusy(true);
    try {
      onActivated(await activatePolicyVersion(policy.id, version.id), version);
    } catch (cause) {
      setServerError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={`Activate version ${version.version_number} of "${policy.name}"`}
      description="This is the consequential step: it changes governance configuration. Confirmation is asked first because activation makes a policy live for every future assessment."
      onClose={onClose}
      width="md"
      dismissOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            Activate
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-supporting text-ink-secondary">
          Version {version.version_number} becomes the current version and the policy starts
          reporting status <Badge tone="success">active</Badge>. No asset is archived, moved or
          deleted, and no existing assessment or recommendation is rewritten.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-supporting text-ink-muted">
          <li>
            The server refuses a version that is not a draft or approved version of this policy,
            and refuses any activation on a retired or inactive policy; a refusal is reported here
            instead of being dressed up as success.
          </li>
          <li>
            This version was created in this session, so its status is the one the create response
            returned. The API cannot re-read a version, so a change made elsewhere surfaces only as
            a server refusal.
          </li>
        </ul>
        <ServerMessage error={serverError} busy={busy} />
      </div>
    </Dialog>
  );
}

/* -------------------------------- details -------------------------------- */

function DetailsDialog({ policy, onClose }: { policy: Policy; onClose: () => void }) {
  return (
    <Dialog
      open
      title={policy.name}
      description="Every value below is a field the retention API returned for this policy row."
      onClose={onClose}
      width="lg"
    >
      <div className="space-y-4">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Detail label="Status">
            <Badge tone={toneForPolicyStatus(policy.status)}>{policy.status}</Badge>
          </Detail>
          <Detail label="Current version">
            {policy.current_version_id === null
              ? "None activated"
              : `${versionSentence(policy)} (version id ${policy.current_version_id})`}
          </Detail>
          <Detail label="Institution">
            {policy.institution_id === null
              ? "Stored without an institution"
              : `#${policy.institution_id}`}
          </Detail>
          <Detail label="Version field">{policy.version ?? "Not set"}</Detail>
          <Detail label="Categories">
            {policy.applicable_categories?.length
              ? policy.applicable_categories.join(", ")
              : "All categories"}
          </Detail>
          <Detail label="Retention trigger">{labelForTrigger(policy.retention_trigger)}</Detail>
          <Detail label="Retention period">
            {policy.retention_period_days === null
              ? "No period set"
              : `${policy.retention_period_days} days`}
          </Detail>
          <Detail label="Recommended action">
            {policy.recommended_action ?? "No action recorded"}
          </Detail>
          <Detail label="Created by">{policy.created_by ?? "Not recorded"}</Detail>
          <Detail label="Created">{policy.created_at}</Detail>
          <Detail label="Scope description" wide>
            {policy.scope_description ?? "Not recorded"}
          </Detail>
          <Detail label="Description" wide>
            {policy.description ?? "Not recorded"}
          </Detail>
        </dl>
        <p className="rounded-card border border-line bg-surface-sunken px-card-x py-card-y text-meta text-ink-muted">
          Version history is not shown because the retention API exposes no endpoint that lists a
          policy's versions. Only the current-version pointer above, and any version this session
          created, can be read or activated from here.
        </p>
      </div>
    </Dialog>
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
      <dd className="mt-1 text-supporting break-words text-ink-secondary">{children}</dd>
    </div>
  );
}
