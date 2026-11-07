/**
 * Classification workspace (redesign Phase 5.4).
 *
 * An operator uses this screen to name an inventoried asset, read the newest
 * classification proposal stored for it, understand the rules and evidence behind
 * that proposal, look back through the immutable history, and review the on-demand
 * data-quality findings.
 *
 * Verified backend contracts (`backend/app/api/routes/classification.py`):
 * - `GET /rules`, `GET /checks`, `GET /assets/{id}/latest`, `.../history` and
 *   `.../quality` are reads and require the server-verified `governance:read`.
 * - `POST /assets/{id}` requires `classification:write`, answers 201, and is the
 *   only mutation this screen performs. It runs on an explicit click and never on
 *   mount; the route is idempotent, so an unchanged asset returns the row already
 *   stored, and the wording here says so instead of claiming a new result.
 * - The asset endpoints accept the optional `institution_id` query; the rule and
 *   check catalogues do not. An unknown asset answers 404 `asset_not_found`, an
 *   out-of-scope one `asset_out_of_scope`/`out_of_scope`, and an asset never
 *   classified `no_classification` — each is presented as its own state.
 *
 * Nothing here reads file contents, applies a proposal, merges duplicates, or
 * triggers a retention or lifecycle action. `GET /api/v1/classification/*` serves
 * the real inventory tables, not a demo fixture, so no figure on this screen is
 * labelled sample data.
 */

import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  fetchAssetQuality,
  fetchClassificationHistory,
  fetchClassificationRules,
  fetchLatestClassification,
  fetchQualityChecks,
  runClassification,
} from "../api/classification";
import type { ClassificationScope } from "../api/classification";
import { toErrorMessage } from "../api/client";
import type {
  AssetQualityReport,
  ClassificationConfidence,
  ClassificationResult,
  ClassificationResultList,
  ClassificationRuleDescriptor,
  ClassificationRules,
  QualityCheckDescriptor,
  QualityFinding,
} from "../api/types";
import { useApiQuery } from "../hooks/useApiQuery";
import type { ApiQueryState } from "../hooks/useApiQuery";
import { useAuth } from "../auth/AuthContext";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Field } from "../components/ui/Field";
import { Input } from "../components/ui/Input";
import { Spinner } from "../components/ui/Spinner";
import { Tabs } from "../components/ui/Tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../components/ui/Table";
import { formatDate, humanize } from "../lib/format";
import {
  toneForConfidence,
  toneForSeverity,
  toneForSensitivity,
  type StatusTone,
  type Tone,
} from "../lib/semantic";

/** Query parameter carrying the selected asset, so a selection is shareable. */
const ASSET_PARAM = "asset";
const HISTORY_PAGE_SIZE = 10;

/** Stable 404 details the classification routes answer with. */
const DETAIL_NO_CLASSIFICATION = "no_classification";
const DETAIL_ASSET_NOT_FOUND = "asset_not_found";
const DETAIL_OUT_OF_SCOPE = "out_of_scope";

/** The four asset-scoped sections, and the catalogue that needs no asset. */
type SectionId = "latest" | "history" | "quality" | "rules";

type Currency = "current" | "older" | "unverified";

/** What the reads say about this asset's classification. */
type ResultState =
  | { kind: "none_selected" }
  | { kind: "loading" }
  | { kind: "never" }
  | { kind: "not_found" }
  | { kind: "out_of_scope" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; result: ClassificationResult; currency: Currency };

const STATE_BADGE: Record<ResultState["kind"], { label: string; tone: StatusTone }> = {
  none_selected: { label: "No record selected", tone: "neutral" },
  loading: { label: "Reading the stored result", tone: "neutral" },
  never: { label: "Never classified", tone: "neutral" },
  not_found: { label: "Unknown record", tone: "caution" },
  out_of_scope: { label: "Outside your scope", tone: "caution" },
  failed: { label: "Result unreadable", tone: "caution" },
  ready: { label: "Suggestion stored", tone: "neutral" },
};

const CURRENCY_BADGE: Record<Currency, { label: string; tone: StatusTone }> = {
  current: { label: "Current rule version", tone: "success" },
  older: { label: "Older rule version", tone: "caution" },
  unverified: { label: "Rule version unknown", tone: "neutral" },
};

const CURRENCY_MEANING: Record<Currency, string> = {
  current: "Its rule version matches the catalogue the backend serves now.",
  older: "A newer rule version is in the catalogue, so this row is history rather than the latest word.",
  unverified: "The rule catalogue could not be read, so this result cannot be compared with it.",
};

/**
 * The server's own explanation, spelled out once in the section that reads the
 * asset. The workspace header repeats only the short summary, so the machine
 * readable detail appears exactly once on the page.
 */
const READ_ERROR: Partial<
  Record<ResultState["kind"], { title: string; summary: string; message: string; code: string }>
> = {
  not_found: {
    title: "Record not found",
    summary: "No inventory record this account can read has that id.",
    message: "No data record has that id. Check the id in Data Inventory and try again.",
    code: DETAIL_ASSET_NOT_FOUND,
  },
  out_of_scope: {
    title: "Outside your institution scope",
    summary: "The record exists, but not inside the institution scope you are viewing.",
    message:
      "This record exists, but your account cannot read it in the current institution scope. Change the scope in the sidebar if you expected to see it.",
    code: DETAIL_OUT_OF_SCOPE,
  },
};

/**
 * Date first, then the time exactly as the backend stored it. A naive timestamp is
 * never re-based to the browser zone, because that would present a time the server
 * did not record.
 */
function formatStamp(iso: string): string {
  const date = formatDate(iso.slice(0, 10));
  const time = iso.length > 10 ? iso.slice(11, 16) : "";
  return time ? `${date} ${time}` : date;
}

function parseAssetParam(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function stateFor(
  selected: boolean,
  query: ApiQueryState<ClassificationResult | null>,
  ruleVersion: string | null,
): ResultState {
  if (!selected) {
    return { kind: "none_selected" };
  }
  if (query.error !== null) {
    const detail = query.error.toLowerCase();
    if (detail.includes(DETAIL_NO_CLASSIFICATION)) {
      return { kind: "never" };
    }
    if (detail.includes(DETAIL_ASSET_NOT_FOUND)) {
      return { kind: "not_found" };
    }
    if (detail.includes(DETAIL_OUT_OF_SCOPE)) {
      return { kind: "out_of_scope" };
    }
    return { kind: "failed", message: query.error };
  }
  if (query.loading && query.data === null) {
    return { kind: "loading" };
  }
  if (query.data === null) {
    return { kind: "failed", message: "The backend returned no classification result for this record." };
  }
  const currency: Currency =
    ruleVersion === null
      ? "unverified"
      : query.data.rule_version === ruleVersion
        ? "current"
        : "older";
  return { kind: "ready", result: query.data, currency };
}

/**
 * Evidence carries the sensitivity as a plain string, so an unexpected value
 * resolves to a neutral chip rather than being forced into the level vocabulary.
 */
function sensitivityTone(value: string): Tone {
  return value === "public" ||
    value === "internal" ||
    value === "confidential" ||
    value === "restricted" ||
    value === "unknown"
    ? toneForSensitivity(value)
    : "neutral";
}

/**
 * Presentation only, over the three documented outcomes. A completed proposal is
 * informational rather than green: "classified" says every field has metadata
 * support, not that the asset is safe or that anyone has approved it.
 */
function outcomeTone(outcome: string): Tone {
  return outcome === "classified"
    ? "info"
    : outcome === "partially_classified"
      ? "warning"
      : "neutral";
}

/** Index of the rule catalogue by `rule_id`, used to explain stored evidence. */
function indexRules(rules: ClassificationRules | null): Map<string, ClassificationRuleDescriptor> {
  const entries: Array<[string, ClassificationRuleDescriptor]> = (rules?.rules ?? []).map((rule) => [
    rule.rule_id,
    rule,
  ]);
  return new Map(entries);
}

/**
 * What a 201 answer means, stated from the row the server returned: the route
 * reuses the stored result when the input fingerprint has not changed.
 */
function describeRun(assetId: number, previousId: number | null, row: ClassificationResult): string {
  if (previousId === null) {
    return `Recorded the first classification result for record #${assetId} (result #${row.id}, ${row.rule_version}).`;
  }
  if (row.id === previousId) {
    return `Record #${assetId} returned the stored result #${row.id} unchanged: the metadata produced the same input fingerprint, so no new row was added.`;
  }
  return `Recorded a new result #${row.id} for record #${assetId}: ${humanize(row.outcome)}, ${row.confidence} confidence.`;
}

export default function Classification() {
  const { has, activeInstitutionId } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const assetId = parseAssetParam(searchParams.get(ASSET_PARAM));
  const [section, setSection] = useState<SectionId>("latest");
  const canRun = has("classification:write");

  // A platform administrator browsing every institution sends no scope; anyone
  // else sends the institution the shell has selected, so a scope 404 from the
  // server stays a real answer rather than an unscoped read.
  const scope: ClassificationScope | undefined = useMemo(
    () => (activeInstitutionId === null ? undefined : { institutionId: activeInstitutionId }),
    [activeInstitutionId],
  );

  const rules = useApiQuery((signal) => fetchClassificationRules(signal), []);
  const checks = useApiQuery((signal) => fetchQualityChecks(signal), []);
  const latest = useApiQuery(
    (signal) =>
      assetId === null ? Promise.resolve(null) : fetchLatestClassification(assetId, signal, scope),
    [assetId, scope],
  );

  // The page number belongs to the asset it was requested for: a new selection
  // starts at page 1 without an effect, and a superseded page never re-queries.
  const [historyShift, setHistoryShift] = useState<{ assetId: number; page: number } | null>(null);
  const historyPage = historyShift?.assetId === assetId ? historyShift.page : 1;
  const history = useApiQuery(
    (signal) =>
      assetId === null
        ? Promise.resolve(null)
        : fetchClassificationHistory(
            assetId,
            { page: historyPage, per_page: HISTORY_PAGE_SIZE },
            signal,
            scope,
          ),
    [assetId, scope, historyPage],
  );

  const quality = useApiQuery(
    (signal) => (assetId === null ? Promise.resolve(null) : fetchAssetQuality(assetId, signal, scope)),
    [assetId, scope],
  );

  const state = stateFor(assetId !== null, latest, rules.data?.rule_version ?? null);
  const ruleIndex = useMemo(() => indexRules(rules.data), [rules.data]);

  /**
   * Run feedback is stored with the asset it was issued for, so a response that
   * arrives after the operator moved on is not shown. The server row stays either
   * way — nothing here describes an accepted mutation as undone.
   */
  const [feedback, setFeedback] = useState<{
    assetId: number;
    text: string;
    failure?: string;
  } | null>(null);
  const [sendingFor, setSendingFor] = useState<number | null>(null);

  async function handleRun(target: number): Promise<void> {
    const previousId = latest.data?.id ?? null;
    setSendingFor(target);
    setFeedback({ assetId: target, text: `Classifying record #${target}…` });
    try {
      const row = await runClassification(target, scope);
      setFeedback({ assetId: target, text: describeRun(target, previousId, row) });
    } catch (cause) {
      setFeedback({
        assetId: target,
        text: "The server did not accept the run. The stored result was re-read, so what is shown is the actual state.",
        failure: toErrorMessage(cause),
      });
    } finally {
      setSendingFor(null);
      latest.refetch();
      history.refetch();
      quality.refetch();
    }
  }

  function selectAsset(next: number | null): void {
    setFeedback(null);
    setSearchParams(
      next === null ? new URLSearchParams() : new URLSearchParams({ [ASSET_PARAM]: String(next) }),
      { replace: true },
    );
    if (next !== null) {
      setSection("latest");
    }
  }

  const notice = feedback !== null && feedback.assetId === assetId ? feedback : null;

  return (
    <div>
      <PageHeader
        title="Classification & Data Quality"
        description="DataDiet suggests how sensitive a record is from its metadata only — never by reading file contents, and never applied automatically."
      />

      <AssetWorkspace
        state={state}
        assetId={assetId}
        canRun={canRun}
        canBrowseInventory={has("inventory:read")}
        scope={scope}
        sending={assetId !== null && sendingFor === assetId}
        notice={notice}
        busy={latest.loading}
        onSelect={selectAsset}
        onRun={(id) => void handleRun(id)}
        onOpenLatest={() => setSection("latest")}
      />

      {assetId === null ? (
        <>
          <Card className="mt-gutter">
            <CardBody>
              <EmptyState
                title="Nothing selected yet"
                message="Enter a record id above to see its suggested classification, its history and its data-quality findings. The catalogues below are the same for every record."
              />
            </CardBody>
          </Card>
          <RulesSection rules={rules} checks={checks} className="mt-gutter" />
        </>
      ) : (
        <Tabs
          className="mt-gutter"
          ariaLabel="Classification sections"
          activeId={section}
          onChange={(id) => setSection(id as SectionId)}
          items={[
            { id: "latest", label: "Latest classification" },
            { id: "history", label: "History" },
            { id: "quality", label: "Data quality" },
            { id: "rules", label: "Rules" },
          ]}
        >
          {(activeId) => (
            <>
              {/* Every section stays mounted and is hidden when inactive, so a tab
                  switch never re-requests or loses what was already read. */}
              <div hidden={activeId !== "latest"}>
                <LatestPanel
                  assetId={assetId}
                  state={state}
                  query={latest}
                  ruleIndex={ruleIndex}
                  historyLink={() => setSection("history")}
                />
              </div>
              <div hidden={activeId !== "history"}>
                <HistoryPanel
                  query={history}
                  page={historyPage}
                  onShift={(page) => setHistoryShift({ assetId, page })}
                />
              </div>
              <div hidden={activeId !== "quality"}>
                <QualityPanel query={quality} checks={checks.data ?? []} />
              </div>
              <div hidden={activeId !== "rules"}>
                <RulesSection rules={rules} checks={checks} />
              </div>
            </>
          )}
        </Tabs>
      )}
    </div>
  );
}

/* ----------------------------- asset workspace ---------------------------- */

interface AssetWorkspaceProps {
  state: ResultState;
  assetId: number | null;
  canRun: boolean;
  canBrowseInventory: boolean;
  scope: ClassificationScope | undefined;
  sending: boolean;
  busy: boolean;
  notice: { text: string; failure?: string } | null;
  onSelect: (assetId: number | null) => void;
  onRun: (assetId: number) => void;
  onOpenLatest: () => void;
}

function AssetWorkspace({
  state,
  assetId,
  canRun,
  canBrowseInventory,
  scope,
  sending,
  busy,
  notice,
  onSelect,
  onRun,
  onOpenLatest,
}: AssetWorkspaceProps) {
  const [value, setValue] = useState("");
  const [validation, setValidation] = useState<string | null>(null);

  function submit(event: FormEvent): void {
    event.preventDefault();
    const parsed = parseAssetParam(value);
    if (parsed === null) {
      setValidation("Record id must be a positive whole number.");
      onSelect(null);
      return;
    }
    setValidation(null);
    onSelect(parsed);
  }

  const badge = state.kind === "ready" ? CURRENCY_BADGE[state.currency] : STATE_BADGE[state.kind];
  const readError =
    state.kind === "not_found" || state.kind === "out_of_scope"
      ? READ_ERROR[state.kind]
      : undefined;

  return (
    <Card>
      <CardHeader
        title="Choose a record"
        description="Type a record id to see what the rules suggested for it, the evidence behind that, and how it has changed over time."
      />
      <CardBody className="space-y-4">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <Field
            label="Record id"
            hint="The number shown in Data Inventory."
            error={validation}
          >
            {(control) => (
              <Input
                {...control}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="e.g. 3"
                className="w-full max-w-48"
              />
            )}
          </Field>
          <Button type="submit" variant="primary">
            Load record
          </Button>
          {assetId !== null ? (
            <Button
              variant="ghost"
              onClick={() => {
                setValue("");
                setValidation(null);
                onSelect(null);
              }}
            >
              Clear selection
            </Button>
          ) : null}
        </form>

        {canBrowseInventory ? (
          <p className="text-meta text-ink-muted">
            Need an id?{" "}
            <Link to="/inventory" className="font-medium text-accent hover:underline">
              Data Inventory
            </Link>{" "}
            lists the records this account can see.
          </p>
        ) : null}

        <details className="rounded-card border border-line bg-surface-sunken px-card-x py-row-y">
          <summary className="text-supporting font-medium text-ink-secondary">
            Which records this page can read
          </summary>
          <p className="mt-2 text-meta text-ink-muted">
            {scope?.institutionId === undefined
              ? "No institution scope is sent with these reads: the backend answers across every institution this account may read."
              : `Reads are sent with institution_id=${scope.institutionId}, so an asset belonging to another institution answers 404 rather than leaking its contents.`}
          </p>
        </details>

        {assetId !== null ? (
          <div className="space-y-3 rounded-card border border-line bg-surface-sunken px-card-x py-card-y">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">{`Record #${assetId}`}</Badge>
              <Badge tone={badge.tone}>{badge.label}</Badge>
              {state.kind === "ready" ? (
                <Badge tone="neutral">
                  {`${humanize(state.result.outcome)} · ${state.result.confidence} confidence`}
                </Badge>
              ) : null}
            </div>

            {state.kind === "ready" ? (
              <p className="text-supporting text-ink-secondary">
                {`Result #${state.result.id}, classified ${formatStamp(state.result.classified_at)} by ${state.result.created_by} under ${state.result.rule_version}. `}
                {CURRENCY_MEANING[state.currency]}
              </p>
            ) : null}

            {state.kind === "never" ? (
              <p className="text-supporting text-ink-secondary">
                This record is in the inventory but has no suggestion yet. That means it has not been
                looked at, not that it is low risk.
              </p>
            ) : null}

            {readError ? <p className="text-supporting text-ink-secondary">{readError.summary}</p> : null}

            {state.kind === "failed" ? (
              <p className="text-supporting text-caution-ink">{`The stored result could not be read: ${state.message}`}</p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {canRun ? (
                <Button
                  variant="primary"
                  loading={sending}
                  disabled={busy || sending}
                  onClick={() => onRun(assetId)}
                >
                  {sending ? "Classifying…" : "Run classification"}
                </Button>
              ) : (
                <p className="text-supporting text-ink-muted">
                  This account can read suggestions but cannot create one: running a classification
                  needs the classification:write permission the server verifies.
                </p>
              )}
              {state.kind === "ready" ? (
                <Button variant="secondary" onClick={onOpenLatest}>
                  Open full result
                </Button>
              ) : null}
            </div>

            {/* Announced, never asserted: the run response is the only proof of what
                the server stored. */}
            <div role="status" aria-live="polite">
              {notice ? (
                <p className="rounded-card border border-line bg-surface px-control-x py-control-y text-supporting text-ink-secondary">
                  {notice.text}
                  {notice.failure ? (
                    <span className="block text-meta text-critical-ink">{notice.failure}</span>
                  ) : null}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

/* ------------------------------- latest panel ------------------------------ */

interface LatestPanelProps {
  assetId: number;
  state: ResultState;
  query: ApiQueryState<ClassificationResult | null>;
  ruleIndex: Map<string, ClassificationRuleDescriptor>;
  historyLink: () => void;
}

function LatestPanel({ assetId, state, query, ruleIndex, historyLink }: LatestPanelProps) {
  const readError =
    state.kind === "not_found" || state.kind === "out_of_scope"
      ? READ_ERROR[state.kind]!
      : state.kind === "failed"
        ? { title: "Classification unavailable", message: state.message, code: undefined }
        : undefined;

  return (
    <Card>
      <CardHeader
        title="Latest classification"
        description={`The newest suggestion for record #${assetId}. It is advice from metadata only: it does not change the record or choose what happens to it.`}
        action={
          <Button variant="ghost" size="sm" loading={query.loading} onClick={query.refetch}>
            Refresh result
          </Button>
        }
      />
      <CardBody className="space-y-5">
        {state.kind === "loading" ? <Spinner label="Loading classification…" /> : null}

        {state.kind === "never" ? (
          <EmptyState
            title="No classification yet"
            message="This record has no suggestion on file. Run a classification to store the first result."
          />
        ) : null}

        {readError ? (
          <ErrorState
            title={readError.title}
            message={readError.message}
            code={readError.code}
            onRetry={state.kind === "failed" ? query.refetch : undefined}
          />
        ) : null}

        {state.kind === "ready" ? (
          <>
            <div className="grid grid-cols-1 gap-row-y sm:grid-cols-2 xl:grid-cols-4">
              <StatTile label="Outcome" value={humanize(state.result.outcome)} tone={outcomeTone(state.result.outcome)} />
              <StatTile
                label="Suggested category"
                value={state.result.proposed_category ?? "Unclassified"}
                tone="neutral"
              />
              <StatTile
                label="Suggested sensitivity"
                value={humanize(state.result.proposed_sensitivity)}
                tone={sensitivityTone(state.result.proposed_sensitivity)}
              />
              <StatTile
                label="Confidence"
                value={state.result.confidence}
                tone={toneForConfidence(state.result.confidence)}
              />
            </div>

            <div className="rounded-card border border-line bg-surface-sunken px-card-x py-card-y">
              <h3 className="text-supporting font-semibold text-ink">
                {`What ${state.result.confidence} confidence means here`}
              </h3>
              <p className="mt-1 text-body text-ink-secondary">{state.result.confidence_meaning}</p>
              <button
                type="button"
                onClick={historyLink}
                className="mt-2 text-meta font-medium text-accent hover:underline"
              >
                Compare with the stored history
              </button>
            </div>

            {state.result.warnings.length > 0 ? (
              <div>
                <h3 className="text-section font-semibold text-ink">
                  {`Warnings (${state.result.warnings.length})`}
                </h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-body text-caution-ink">
                  {state.result.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {state.result.conflicts.length > 0 ? (
              <div>
                <h3 className="text-section font-semibold text-ink">
                  {`Unresolved conflicts (${state.result.conflicts.length})`}
                </h3>
                <ul className="mt-1 space-y-1 text-body text-critical-ink">
                  {state.result.conflicts.map((conflict) => (
                    <li key={conflict.field}>
                      {`${humanize(conflict.field)}: ${conflict.values.join(" vs ")} — resolved to “${conflict.resolved_to}” (${conflict.reason})`}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <EvidenceList result={state.result} ruleIndex={ruleIndex} />
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

/**
 * A headline value from the stored result. Every tile uses the same chip, so the
 * four figures read as one set and colour always sits beside the word.
 */
function StatTile({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="rounded-card border border-line bg-surface px-card-x py-row-y">
      <p className="text-eyebrow font-semibold uppercase tracking-[0.06em] text-ink-muted">{label}</p>
      <p className="mt-2">
        <Badge tone={tone}>{value}</Badge>
      </p>
    </div>
  );
}

function EvidenceList({
  result,
  ruleIndex,
}: {
  result: ClassificationResult;
  ruleIndex: Map<string, ClassificationRuleDescriptor>;
}) {
  if (result.evidence.length === 0) {
    return (
      <EmptyState
        title="No evidence"
        message="Nothing in the record's metadata supported a suggestion. That means unknown, not low risk."
      />
    );
  }

  return (
    <div>
      <h3 className="text-section font-semibold text-ink">{`Evidence (${result.evidence.length})`}</h3>
      <ul className="mt-2 divide-y divide-line rounded-card border border-line bg-surface">
        {result.evidence.map((item, index) => {
          const rule = ruleIndex.get(item.rule_id);
          return (
            <li key={`${item.rule_id}-${index}`} className="space-y-1 px-card-x py-row-y">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-meta text-ink-muted">{item.rule_id}</span>
                <span className="font-mono text-meta text-ink-subtle">{item.rule_version}</span>
                {item.proposed_category ? (
                  <Badge tone="accent">{`category: ${item.proposed_category}`}</Badge>
                ) : null}
                {item.proposed_sensitivity ? (
                  <Badge tone={sensitivityTone(item.proposed_sensitivity)}>
                    {`sensitivity: ${item.proposed_sensitivity}`}
                  </Badge>
                ) : null}
              </div>
              <p className="text-body text-ink-secondary">
                {`${humanize(item.field)} observed: ${item.observed ?? "—"}`}
              </p>
              <p className="text-supporting text-ink-muted">
                {rule
                  ? `${rule.description} Effect: ${humanize(rule.effect)}; the rule alone earns ${rule.confidence} confidence.`
                  : "This rule id is not in the catalogue the backend serves now, so its description cannot be shown."}
              </p>
              {item.note ? <p className="text-meta text-ink-subtle">{item.note}</p> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ------------------------------ history panel ------------------------------ */

function HistoryPanel({
  query,
  page,
  onShift,
}: {
  query: ApiQueryState<ClassificationResultList | null>;
  page: number;
  onShift: (page: number) => void;
}) {
  const list = query.data;
  return (
    <Card>
      <CardHeader
        title="Classification history"
        description="Every suggestion ever stored for this record, newest first. Rows are never edited: each keeps the rule version that produced it."
      />
      <CardBody className="space-y-4">
        {query.loading && list === null ? <Spinner label="Loading classification history…" /> : null}
        {query.error ? (
          <ErrorState title="History unavailable" message={query.error} onRetry={query.refetch} />
        ) : null}

        {list ? (
          list.results.length === 0 ? (
            <EmptyState title="No history" message="Run a classification to record the first result." />
          ) : (
            <>
              <Table
                caption={`Classification history for record #${list.results[0].asset_id}, page ${list.page} of ${list.total_pages}`}
              >
                <TableHead>
                  <TableRow>
                    <TableHeaderCell scope="col">Classified</TableHeaderCell>
                    <TableHeaderCell scope="col">Outcome</TableHeaderCell>
                    <TableHeaderCell scope="col">Suggestion</TableHeaderCell>
                    <TableHeaderCell scope="col">Created by</TableHeaderCell>
                    <TableHeaderCell scope="col">Rule</TableHeaderCell>
                    <TableHeaderCell scope="col">Fingerprint</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {list.results.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap text-meta">
                        {formatStamp(row.classified_at)}
                      </TableCell>
                      <TableCell className="text-meta">{humanize(row.outcome)}</TableCell>
                      <TableCell className="text-supporting text-ink-secondary">
                        {`${row.proposed_category ?? "unclassified"} / ${humanize(row.proposed_sensitivity)} · ${row.confidence}`}
                      </TableCell>
                      <TableCell className="text-meta">{row.created_by}</TableCell>
                      <TableCell className="font-mono text-meta">{row.rule_version}</TableCell>
                      <TableCell className="font-mono text-meta">
                        {`${row.input_fingerprint.slice(0, 12)}…`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-meta text-ink-muted">
                  {`Page ${list.page} of ${list.total_pages} · ${list.total} stored result${list.total === 1 ? "" : "s"} for this record`}
                </p>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onShift(page - 1)}>
                    Newer results
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={page >= list.total_pages}
                    onClick={() => onShift(page + 1)}
                  >
                    Older results
                  </Button>
                </div>
              </div>
            </>
          )
        ) : null}
      </CardBody>
    </Card>
  );
}

/* ------------------------------ quality panel ------------------------------ */

function QualityPanel({
  query,
  checks,
}: {
  query: ApiQueryState<AssetQualityReport | null>;
  checks: QualityCheckDescriptor[];
}) {
  const report = query.data;
  const byCheck = new Map(checks.map((check) => [check.check, check] as [string, QualityCheckDescriptor]));

  return (
    <Card>
      <CardHeader
        title="Data quality findings"
        description="Automatic checks over the metadata we already hold: missing values, unsupported file types, conflicting values and possible duplicates. Advisory only — nothing here is merged, deleted or reclassified from this screen."
      />
      <CardBody className="space-y-4">
        {query.loading && report === null ? <Spinner label="Loading quality findings…" /> : null}
        {query.error ? (
          <ErrorState
            title="Quality analysis unavailable"
            message={query.error}
            onRetry={query.refetch}
          />
        ) : null}

        {report ? (
          report.findings.length === 0 ? (
            <div className="space-y-3">
              <EmptyState
                title="No findings"
                message="Every documented check passed for this record. This does not prove the metadata is complete or correct."
              />
              {checks.length > 0 ? (
                <p className="text-meta text-ink-muted">
                  {`${checks.length} checks are documented in the catalogue the backend serves.`}
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <p className="text-meta text-ink-muted">
                {`${report.findings.length} finding${report.findings.length === 1 ? "" : "s"} for record #${report.asset_id}. Advisory only: nothing is merged, deleted or reclassified from this list.`}
              </p>
              <ul className="divide-y divide-line rounded-card border border-line bg-surface">
                {report.findings.map((finding, index) => (
                  <FindingRow
                    key={`${finding.check}-${finding.related_asset_id ?? "self"}-${index}`}
                    finding={finding}
                    descriptor={byCheck.get(finding.check) ?? null}
                  />
                ))}
              </ul>
            </>
          )
        ) : null}
      </CardBody>
    </Card>
  );
}

function FindingRow({
  finding,
  descriptor,
}: {
  finding: QualityFinding;
  descriptor: QualityCheckDescriptor | null;
}) {
  return (
    <li className="space-y-1 px-card-x py-row-y">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={toneForSeverity(finding.severity)}>{finding.severity}</Badge>
        <span className="font-mono text-meta text-ink-muted">{finding.check}</span>
        {finding.duplicate_status ? (
          <Badge tone={finding.duplicate_status === "confirmed" ? "critical" : "warning"}>
            {`${finding.duplicate_status} duplicate`}
          </Badge>
        ) : null}
        {finding.related_asset_id !== null && finding.related_asset_id !== undefined ? (
          <span className="text-meta text-ink-subtle">{`record #${finding.related_asset_id}`}</span>
        ) : null}
      </div>
      <p className="text-body text-ink">{finding.message}</p>
      {descriptor ? (
        <p className="text-supporting text-ink-muted">{`What this check looks at: ${descriptor.description}`}</p>
      ) : null}
      <p className="text-meta text-ink-muted">
        {`Fields: ${finding.fields.join(", ") || "—"} · Remediation: ${finding.remediation}`}
      </p>
      {Object.keys(finding.evidence).length > 0 ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-supporting font-medium text-accent">Evidence</summary>
          <pre className="mt-1 overflow-x-auto rounded-card bg-surface-sunken p-3 text-meta text-ink-secondary">
            {JSON.stringify(finding.evidence, null, 2)}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

/* ------------------------------- catalogues ------------------------------- */

function RulesSection({
  rules,
  checks,
  className,
}: {
  rules: ApiQueryState<ClassificationRules | null>;
  checks: ApiQueryState<QualityCheckDescriptor[]>;
  className?: string;
}) {
  // Hoisted so the narrowed catalogue stays non-null inside the map callbacks.
  const catalogue = rules.data;
  const checkCount = checks.data?.length ?? 0;
  return (
    <div className={`${className ?? ""} space-y-gutter`}>
      <Card>
        <CardHeader
          title="Classification rules"
          description="The documented, versioned rule table. Rules change only through code review and a rule-version bump; no endpoint edits them at runtime."
        />
        <CardBody className="space-y-4">
          {rules.loading && catalogue === null ? <Spinner label="Loading classification rules…" /> : null}
          {rules.error ? (
            <ErrorState title="Rules unavailable" message={rules.error} onRetry={rules.refetch} />
          ) : null}

          {catalogue ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-meta text-ink-muted">
                <Badge tone="accent">{catalogue.rule_version}</Badge>
                <span>{`Outcomes: ${catalogue.outcomes.join(", ")}`}</span>
                <span>{`Sensitivities: ${catalogue.sensitivities.join(", ")}`}</span>
              </div>

              <Table caption="The classification rule table the backend applies, with the confidence each rule earns">
                <TableHead>
                  <TableRow>
                    <TableHeaderCell scope="col">Rule</TableHeaderCell>
                    <TableHeaderCell scope="col">Field</TableHeaderCell>
                    <TableHeaderCell scope="col">Effect</TableHeaderCell>
                    <TableHeaderCell scope="col">Confidence</TableHeaderCell>
                    <TableHeaderCell scope="col">Description</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {catalogue.rules.map((rule) => (
                    <TableRow key={rule.rule_id}>
                      <TableCell className="break-words font-mono text-meta">{rule.rule_id}</TableCell>
                      <TableCell className="text-meta">{rule.field}</TableCell>
                      <TableCell className="text-supporting text-ink-secondary">
                        {humanize(rule.effect)}
                      </TableCell>
                      <TableCell>
                        <Badge tone={toneForConfidence(rule.confidence)}>{rule.confidence}</Badge>
                      </TableCell>
                      <TableCell className="text-supporting text-ink-secondary">{rule.description}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div>
                <h3 className="text-section font-semibold text-ink">Confidence meaning</h3>
                <dl className="mt-2 space-y-2">
                  {(Object.keys(catalogue.confidence_meaning) as ClassificationConfidence[]).map(
                    (level) => (
                      <div key={level} className="grid gap-1 sm:grid-cols-[10rem_1fr]">
                        <dt>
                          <Badge tone={toneForConfidence(level)}>{humanize(level)}</Badge>
                        </dt>
                        <dd className="text-supporting text-ink-secondary">
                          {catalogue.confidence_meaning[level]}
                        </dd>
                      </div>
                    ),
                  )}
                </dl>
              </div>

              <p className="text-meta text-ink-muted">
                {`Recommended category vocabulary: ${catalogue.known_categories.join(", ")}`}
              </p>

              <p className="text-meta text-ink-muted">
                {checkCount > 0
                  ? `Data quality evaluates a fixed set of ${checkCount} documented metadata checks for one record; each finding names its check and what that check looks at.`
                  : "Data quality evaluates a fixed set of documented metadata checks for one record; each finding names its check."}
              </p>
            </>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
