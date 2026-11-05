/**
 * Classification & Data Quality (Phase 5).
 *
 * A minimal, explainable view over deterministic classification proposals:
 * proposed category/sensitivity, the evidence and rules behind them, confidence
 * semantics, unresolved conflicts, immutable history, and on-demand
 * data-quality findings.
 *
 * Nothing on this page mutates an asset, merges duplicates, or enforces a
 * retention decision. Classification is metadata-only and advisory; human
 * approval lives elsewhere (retention assessments and review decisions).
 */

import { useState } from "react";
import {
  fetchAssetQuality,
  fetchClassificationHistory,
  fetchClassificationRules,
  fetchLatestClassification,
  runClassification,
} from "../api/classification";
import { toErrorMessage } from "../api/client";
import type {
  ClassificationResult,
  ClassificationRules,
  QualityFinding,
} from "../api/types";
import { useApiQuery } from "../hooks/useApiQuery";
import { useAuth } from "../auth/AuthContext";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Spinner } from "../components/ui/Spinner";
import { formatDate, humanize } from "../lib/format";

type Tone = "slate" | "indigo" | "emerald" | "sky" | "amber" | "orange" | "rose";

const CONFIDENCE_TONES: Record<string, Tone> = {
  high: "emerald",
  medium: "sky",
  low: "amber",
  none: "slate",
};

const SEVERITY_TONES: Record<string, Tone> = {
  info: "slate",
  low: "sky",
  medium: "amber",
  high: "rose",
};

export default function Classification() {
  const [assetId, setAssetId] = useState<number | null>(null);

  return (
    <div>
      <PageHeader
        title="Classification & Data Quality"
        description="Deterministic, explainable classification proposals computed from inventoried metadata only — never from file contents, and never applied automatically. Quality findings are advisory; nothing is merged, deleted, or reclassified without review."
      />

      <div className="space-y-6">
        <AssetPicker onSelect={setAssetId} selected={assetId} />

        {assetId !== null ? (
          <>
            <LatestClassificationCard assetId={assetId} />
            <QualityFindingsCard assetId={assetId} />
            <HistoryCard assetId={assetId} />
          </>
        ) : (
          <Card>
            <CardBody>
              <EmptyState
                title="Select an asset"
                message="Enter a numeric asset id above to run and inspect a classification proposal."
              />
            </CardBody>
          </Card>
        )}

        <RulesCard />
      </div>
    </div>
  );
}

/* ------------------------------- asset picker ----------------------------- */

function AssetPicker({
  onSelect,
  selected,
}: {
  onSelect: (assetId: number | null) => void;
  selected: number | null;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed) || parsed <= 0) {
      setError("Asset id must be a positive integer.");
      onSelect(null);
      return;
    }
    setError(null);
    onSelect(parsed);
  }

  return (
    <Card>
      <CardHeader
        title="Asset classification"
        description="Enter an inventoried asset id. Running a classification stores an immutable, versioned result; re-running with unchanged metadata reuses it."
      />
      <CardBody>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div>
            <label
              htmlFor="classification-asset-id"
              className="block text-xs font-medium text-slate-500"
            >
              Asset id
            </label>
            <input
              id="classification-asset-id"
              type="text"
              inputMode="numeric"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="e.g. 3"
              className="mt-1 w-36 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Load asset
          </button>
          {selected !== null ? (
            <span className="text-xs text-slate-500">Showing asset #{selected}</span>
          ) : null}
        </form>
        {error ? <p className="mt-2 text-sm text-rose-700">{error}</p> : null}
      </CardBody>
    </Card>
  );
}

/* --------------------------- latest classification ------------------------ */

function LatestClassificationCard({ assetId }: { assetId: number }) {
  const { has } = useAuth();
  const latest = useApiQuery(() => fetchLatestClassification(assetId));
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  async function handleRun(): Promise<void> {
    setRunning(true);
    setRunError(null);
    try {
      await runClassification(assetId);
      latest.refetch();
    } catch (cause) {
      setRunError(toErrorMessage(cause));
    } finally {
      setRunning(false);
    }
  }

  const notRunYet =
    latest.error !== null && latest.error.toLowerCase().includes("no_classification");

  return (
    <Card>
      <CardHeader
        title="Latest classification"
        description="Proposals are explainable: every result names the rules that fired, the evidence they used, and the confidence those rules earned."
        action={
          has("classification:write") ? (
            <button
              type="button"
              onClick={() => void handleRun()}
              disabled={running}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {running ? "Classifying..." : "Run classification"}
            </button>
          ) : null
        }
      />
      <CardBody className="space-y-4">
        {runError ? (
          <ErrorState title="Classification failed" message={runError} onRetry={() => void handleRun()} />
        ) : null}

        {latest.loading ? <Spinner label="Loading classification..." /> : null}

        {notRunYet ? (
          <EmptyState
            title="No classification yet"
            message="This asset has not been classified. Run a classification to record the first immutable result."
          />
        ) : null}

        {latest.error && !notRunYet ? (
          <ErrorState
            title="Classification unavailable"
            message={latest.error}
            onRetry={latest.refetch}
          />
        ) : null}

        {latest.data ? <ResultDetail result={latest.data} onRan={latest.refetch} /> : null}
      </CardBody>
    </Card>
  );
}

function ResultDetail({ result, onRan }: { result: ClassificationResult; onRan: () => void }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={CONFIDENCE_TONES[result.confidence] ?? "slate"}>
          {humanize(result.outcome)}
        </Badge>
        <span className="text-sm text-slate-700">
          Proposed category:{" "}
          <span className="font-medium text-slate-900">
            {result.proposed_category ?? "unclassified"}
          </span>
        </span>
        <span className="text-sm text-slate-700">
          Proposed sensitivity:{" "}
          <span className="font-medium text-slate-900">
            {humanize(result.proposed_sensitivity)}
          </span>
        </span>
        <span className="text-xs text-slate-500">
          {result.rule_version} · {formatDate(result.classified_at.slice(0, 10))}
        </span>
      </div>

      <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
        <span className="font-medium text-slate-900">Confidence: {result.confidence}</span>
        <p className="mt-1">{result.confidence_meaning}</p>
      </div>

      {result.warnings.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            Warnings ({result.warnings.length})
          </h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-amber-800">
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.conflicts.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            Unresolved conflicts ({result.conflicts.length})
          </h3>
          <ul className="mt-1 space-y-1 text-sm text-rose-800">
            {result.conflicts.map((conflict) => (
              <li key={conflict.field}>
                <span className="font-medium">{humanize(conflict.field)}:</span>{" "}
                {conflict.values.join(" vs ")} — resolved to “{conflict.resolved_to}” (
                {conflict.reason})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <EvidenceList result={result} />

      <button
        type="button"
        onClick={onRan}
        className="text-xs font-medium text-indigo-700 hover:text-indigo-900"
      >
        Refresh latest
      </button>
    </div>
  );
}

function EvidenceList({ result }: { result: ClassificationResult }) {
  if (result.evidence.length === 0) {
    return (
      <EmptyState
        title="No evidence"
        message="No metadata supported a proposal. This is an explicit unknown, not a low-risk classification."
      />
    );
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-900">
        Evidence ({result.evidence.length})
      </h3>
      <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
        {result.evidence.map((item, index) => (
          <li
            key={`${item.rule_id}-${index}`}
            className="px-4 py-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-slate-600">{item.rule_id}</span>
              <span className="text-xs text-slate-400">{item.rule_version}</span>
              {item.proposed_category ? (
                <Badge tone="indigo">category: {item.proposed_category}</Badge>
              ) : null}
              {item.proposed_sensitivity ? (
                <Badge tone="sky">sensitivity: {item.proposed_sensitivity}</Badge>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-slate-700">
              <span className="font-medium">{humanize(item.field)}</span>: {item.observed ?? "—"}
            </p>
            {item.note ? <p className="mt-1 text-xs text-slate-500">{item.note}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------ quality findings -------------------------- */

function QualityFindingsCard({ assetId }: { assetId: number }) {
  const quality = useApiQuery(() => fetchAssetQuality(assetId));

  return (
    <Card>
      <CardHeader
        title="Data quality findings"
        description="Deterministic checks over inventoried metadata: missing fields, unsupported extensions, conflicting values, duplicate candidates, stale observations, and source-mapping inconsistencies."
      />
      <CardBody>
        {quality.loading ? <Spinner label="Loading quality findings..." /> : null}
        {quality.error ? (
          <ErrorState
            title="Quality analysis unavailable"
            message={quality.error}
            onRetry={quality.refetch}
          />
        ) : null}

        {quality.data ? (
          quality.data.findings.length === 0 ? (
            <EmptyState
              title="No findings"
              message="Every documented check passed for this asset. This does not prove the metadata is complete or correct."
            />
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {quality.data.findings.map((finding, index) => (
                <FindingRow
                  key={`${finding.check}-${finding.related_asset_id ?? "self"}-${index}`}
                  finding={finding}
                />
              ))}
            </ul>
          )
        ) : null}
      </CardBody>
    </Card>
  );
}

function FindingRow({ finding }: { finding: QualityFinding }) {
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SEVERITY_TONES[finding.severity] ?? "slate"}>{finding.severity}</Badge>
        <span className="font-mono text-xs text-slate-600">{finding.check}</span>
        {finding.duplicate_status ? (
          <Badge tone={finding.duplicate_status === "confirmed" ? "rose" : "amber"}>
            {finding.duplicate_status} duplicate
          </Badge>
        ) : null}
        {finding.related_asset_id !== null && finding.related_asset_id !== undefined ? (
          <span className="text-xs text-slate-400">asset #{finding.related_asset_id}</span>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-slate-800">{finding.message}</p>
      <p className="mt-1 text-xs text-slate-500">
        Fields: {finding.fields.join(", ") || "—"} · Remediation: {finding.remediation}
      </p>
      {Object.keys(finding.evidence).length > 0 ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs font-medium text-indigo-700">
            Evidence
          </summary>
          <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-600">
            {JSON.stringify(finding.evidence, null, 2)}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

/* --------------------------------- history -------------------------------- */

function HistoryCard({ assetId }: { assetId: number }) {
  const history = useApiQuery(() =>
    fetchClassificationHistory(assetId, { page: 1, per_page: 10 }),
  );

  return (
    <Card>
      <CardHeader
        title="Classification history"
        description="Immutable, append-only results. History is preserved across rule changes: each row records the rule version and input fingerprint that produced it."
      />
      <CardBody>
        {history.loading ? <Spinner label="Loading classification history..." /> : null}
        {history.error ? (
          <ErrorState
            title="History unavailable"
            message={history.error}
            onRetry={history.refetch}
          />
        ) : null}

        {history.data ? (
          history.data.results.length === 0 ? (
            <EmptyState
              title="No history"
              message="Run a classification to record the first result."
            />
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {history.data.results.map((row) => (
                <li key={row.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={CONFIDENCE_TONES[row.confidence] ?? "slate"}>
                      {humanize(row.outcome)}
                    </Badge>
                    <span className="text-xs text-slate-500">
                      {row.rule_version} · {formatDate(row.classified_at.slice(0, 10))} ·{" "}
                      {row.input_fingerprint.slice(0, 12)}…
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-slate-700">
                    {row.proposed_category ?? "unclassified"} /{" "}
                    {humanize(row.proposed_sensitivity)} · confidence {row.confidence}
                  </p>
                  {row.warnings.length > 0 ? (
                    <p className="mt-1 text-xs text-amber-700">
                      {row.warnings.length} warning{row.warnings.length === 1 ? "" : "s"}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </CardBody>
    </Card>
  );
}

/* ---------------------------------- rules --------------------------------- */

function RulesCard() {
  const rules = useApiQuery(fetchClassificationRules);

  return (
    <Card>
      <CardHeader
        title="Classification rules"
        description="The documented, versioned rule table. Rules change only through code review and a rule-version bump; no endpoint edits them at runtime."
      />
      <CardBody>
        {rules.loading ? <Spinner label="Loading classification rules..." /> : null}
        {rules.error ? (
          <ErrorState title="Rules unavailable" message={rules.error} onRetry={rules.refetch} />
        ) : null}

        {rules.data ? <RulesTable rules={rules.data} /> : null}
      </CardBody>
    </Card>
  );
}

function RulesTable({ rules }: { rules: ClassificationRules }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
        <Badge tone="indigo">{rules.rule_version}</Badge>
        <span>Outcomes: {rules.outcomes.join(", ")}</span>
        <span>Sensitivities: {rules.sensitivities.join(", ")}</span>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
            <tr>
              <th scope="col" className="px-5 py-3">Rule</th>
              <th scope="col" className="px-5 py-3">Field</th>
              <th scope="col" className="px-5 py-3">Effect</th>
              <th scope="col" className="px-5 py-3">Confidence</th>
              <th scope="col" className="px-5 py-3">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rules.rules.map((rule) => (
              <tr key={rule.rule_id}>
                <td className="px-5 py-3 font-mono text-xs text-slate-600">{rule.rule_id}</td>
                <td className="px-5 py-3 text-slate-600">{rule.field}</td>
                <td className="px-5 py-3 text-slate-700">{humanize(rule.effect)}</td>
                <td className="px-5 py-3">
                  <Badge tone={CONFIDENCE_TONES[rule.confidence] ?? "slate"}>
                    {rule.confidence}
                  </Badge>
                </td>
                <td className="px-5 py-3 text-slate-600">{rule.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-900">Confidence meaning</h3>
        <dl className="mt-1 space-y-1 text-sm text-slate-700">
          {(Object.keys(rules.confidence_meaning) as Array<keyof typeof rules.confidence_meaning>).map(
            (level) => (
              <div key={level} className="flex gap-2">
                <dt className="w-16 shrink-0 font-medium text-slate-900">{humanize(level)}</dt>
                <dd>{rules.confidence_meaning[level]}</dd>
              </div>
            ),
          )}
        </dl>
      </div>
    </div>
  );
}
