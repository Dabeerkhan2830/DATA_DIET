import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { fetchDashboard } from "../api/demo";
import type { DashboardSummary, Permission, RetentionAction, RiskBand, Sensitivity } from "../api/types";
import { useApiQuery } from "../hooks/useApiQuery";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui/Badge";
import { BarList, type BarItem } from "../components/ui/BarList";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { DemoNotice } from "../components/ui/DemoNotice";
import { ErrorState } from "../components/ui/ErrorState";
import { Spinner } from "../components/ui/Spinner";
import { TONE_SOLID } from "../components/ui/statusClasses";
import { IconChevronRight } from "../components/icons";
import { formatBytes, formatDate, humanize } from "../lib/format";
import {
  toneForRetentionAction,
  toneForRiskBand,
  toneForSensitivity,
  type Tone,
} from "../lib/semantic";

/** Highest severity first: the point of the band chart is what to look at next. */
const BAND_ORDER: Array<{ band: RiskBand; label: string }> = [
  { band: "critical", label: "Critical (75–100)" },
  { band: "high", label: "High (50–74)" },
  { band: "moderate", label: "Moderate (25–49)" },
  { band: "low", label: "Low (0–24)" },
];

const SENSITIVITY_ORDER: Array<{ level: Sensitivity; label: string }> = [
  { level: "restricted", label: "Restricted" },
  { level: "confidential", label: "Confidential" },
  { level: "internal", label: "Internal" },
  { level: "public", label: "Public" },
];

const ACTION_ORDER: Array<{ action: RetentionAction; label: string }> = [
  { action: "retain", label: "Retain" },
  { action: "archive", label: "Archive" },
  { action: "review", label: "Review" },
  { action: "eligible_for_disposal", label: "Eligible for disposal" },
];

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * A share of one distribution.
 *
 * The denominator is that distribution's own total, never `total_records`: the
 * summary does not promise the breakdowns add up to the record count, and a
 * percentage is only honest against a number the payload actually supplies.
 */
function shareOf(value: number, total: number): string {
  return total > 0 ? `${Math.round((value / total) * 100)}%` : "—";
}

export default function Dashboard() {
  const { data, loading, error, refetch } = useApiQuery(fetchDashboard, []);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="What you hold, what needs attention, and what to do next."
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
  const riskBands = BAND_ORDER.map((entry) => ({
    label: entry.label,
    value: summary.by_risk_band[entry.band],
    tone: toneForRiskBand(entry.band),
  }));
  const riskTotal = sum(riskBands.map((band) => band.value));
  const elevatedRisk = summary.by_risk_band.critical + summary.by_risk_band.high;

  const sensitivityItems: BarItem[] = SENSITIVITY_ORDER.map((entry) => ({
    label: entry.label,
    value: summary.by_sensitivity[entry.level],
    tone: toneForSensitivity(entry.level),
  }));
  const sensitivityTotal = sum(sensitivityItems.map((item) => item.value));

  const actionItems: BarItem[] = ACTION_ORDER.map((entry) => ({
    label: entry.label,
    value: summary.by_retention_action[entry.action],
    tone: toneForRetentionAction(entry.action),
  }));

  return (
    <div className="space-y-gutter">
      <NextStep summary={summary} />

      <Section title="What data do we have?">
        <MetricLedger
          metrics={[
            {
              label: "Data records",
              value: summary.total_records,
              hint: "Found by DataDiet",
              to: "/inventory",
              permission: "inventory:read",
            },
            {
              label: "Total size",
              value: formatBytes(summary.storage_bytes),
              hint: `Across ${summary.total_records} record${summary.total_records === 1 ? "" : "s"}`,
            },
            {
              label: "High-risk records",
              value: elevatedRisk,
              hint: `Of ${riskTotal} scored records`,
              to: "/risk",
              permission: "inventory:read",
            },
            {
              label: "Waiting for approval",
              value: summary.pending_approvals,
              hint: "A person needs to decide",
              to: "/recommendations",
              permission: "retention:read",
            },
          ]}
        />
      </Section>

      <Section title="What needs attention?">
        <div className="grid grid-cols-1 gap-gutter xl:grid-cols-5">
          <AttentionRequired summary={summary} className="xl:col-span-3" />
          <RiskOverview
            bands={riskBands}
            total={riskTotal}
            className="xl:col-span-2 xl:self-start"
          />
        </div>
      </Section>

      <details className="rounded-card border border-line bg-surface">
        <summary className="cursor-pointer px-card-x py-3 text-body font-medium text-ink-secondary transition-colors hover:text-ink">
          Show the numbers behind this summary
        </summary>
        <div className="border-t border-line p-gutter">
          <div className="grid grid-cols-1 gap-gutter md:grid-cols-2">
            <Card>
              <CardHeader
                title="Sensitivity mix"
                description="Records by assigned sensitivity level"
                action={<DistributionTotal total={sensitivityTotal} />}
              />
              <CardBody>
                <BarList items={sensitivityItems} />
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Suggested retention action"
                description="Illustrative sample values — no retention engine runs yet"
              />
              <CardBody>
                <BarList items={actionItems} />
              </CardBody>
            </Card>
          </div>
        </div>
      </details>

      <ActivityCard activity={summary.recent_activity} />
    </div>
  );
}

/** A visible section title that is also the region's accessible name. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = `dashboard-section-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-section font-semibold text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * The one action this page recommends.
 *
 * "Waiting for approval" is only a number until the reader knows where to take
 * it, so the band names the next screen and says what is waiting there. Its
 * links exist only for areas this account can already open — the same rule the
 * sidebar and the outstanding list follow.
 */
function NextStep({ summary }: { summary: DashboardSummary }) {
  const { has } = useAuth();

  const primary =
    summary.pending_approvals > 0 && has("retention:read")
      ? {
          to: "/recommendations",
          label: `Review ${summary.pending_approvals} item${summary.pending_approvals === 1 ? "" : "s"} waiting for approval`,
          hint: "Each one says what it covers and why DataDiet flagged it.",
        }
      : {
          to: "/inventory",
          label: "Browse your data records",
          hint: "See everything DataDiet has found, and narrow it to what matters.",
        };

  const options: Array<{ to: string; label: string; permission: Permission }> = [
    { to: "/risk", label: "See which records look most sensitive", permission: "inventory:read" },
    {
      to: "/classification",
      label: "Check data quality and suggestions",
      permission: "governance:read",
    },
    { to: "/retention", label: "Review how long data is kept", permission: "retention:read" },
  ];
  const shortcuts = options.filter((item) => has(item.permission));

  return (
    <section
      aria-labelledby="dashboard-next-step"
      className="rounded-card border border-accent-line bg-accent-surface px-card-x py-card-y"
    >
      <h2 id="dashboard-next-step" className="text-eyebrow font-semibold uppercase text-accent-ink">
        What should I do next?
      </h2>
      <div className="mt-2 flex flex-wrap items-center gap-4">
        <Link
          to={primary.to}
          className="inline-flex items-center gap-2 rounded-control bg-accent px-control-x py-control-y text-body font-medium text-on-accent transition-colors hover:bg-accent-hover"
        >
          {primary.label}
          <IconChevronRight className="h-4 w-4 shrink-0" />
        </Link>
        <p className="min-w-40 flex-1 text-supporting text-ink-secondary">{primary.hint}</p>
      </div>
      {shortcuts.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-x-gutter gap-y-1">
          {shortcuts.map((item) => (
            <li key={item.to}>
              <Link
                to={item.to}
                className="inline-flex items-center gap-1 rounded-control text-supporting font-medium text-accent-ink transition-colors hover:text-accent hover:underline"
              >
                {item.label}
                <IconChevronRight className="h-3.5 w-3.5" />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function DistributionTotal({ total }: { total: number }) {
  return (
    <p className="text-meta tabular-nums text-ink-muted">
      {total} record{total === 1 ? "" : "s"}
    </p>
  );
}

/**
 * The volume figures in one hairline-divided panel rather than four cards: the
 * numbers are read together, so they are framed together. A `<dl>` keeps each
 * label bound to its value, which four loose `<div>`s would not announce.
 *
 * An entry is a link only when the signed-in account may already open that
 * area, so a number is also a way through — never a dead end.
 */
function MetricLedger({
  metrics,
}: {
  metrics: Array<{
    label: string;
    value: string | number;
    hint: string;
    to?: string;
    permission?: Permission;
  }>;
}) {
  const { has } = useAuth();

  return (
    <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-card border border-line bg-line shadow-card sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map((metric) => {
        // Only a figure this account may already open becomes a link.
        const linkTo =
          metric.to !== undefined && metric.permission !== undefined && has(metric.permission)
            ? metric.to
            : undefined;

        return (
          <div key={metric.label} className="bg-surface px-card-x py-card-y">
            <dt className="text-eyebrow font-semibold uppercase text-ink-muted">{metric.label}</dt>
            {/*
              The number carries the link rather than the whole panel: a `dl`
              entry may only hold `dt` and `dd`, and the figure is what the
              reader wants to follow through to the screen behind it.
            */}
            <dd className="mt-2 text-display font-semibold tabular-nums text-ink">
              {linkTo !== undefined ? (
                <Link
                  to={linkTo}
                  className="rounded-sm transition-colors hover:text-accent hover:underline"
                >
                  {metric.value}
                </Link>
              ) : (
                metric.value
              )}
            </dd>
            <dd className="mt-1 text-meta text-ink-muted">{metric.hint}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function RiskOverview({
  bands,
  total,
  className,
}: {
  bands: Array<{ label: string; value: number; tone: Tone }>;
  total: number;
  className?: string;
}) {
  const present = bands.filter((band) => band.value > 0);

  return (
    <Card className={className}>
      <CardHeader title="Where the risk sits" description="Records by risk score, highest first" />
      <CardBody className="space-y-4">
        {/*
          The bar is decoration for the legend below it, so it is hidden from
          assistive tech rather than announced as a fourth unnamed graphic: the
          list carries every label, count and share as text.
        */}
        {present.length > 0 ? (
          <div
            aria-hidden="true"
            className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-pill bg-surface-sunken"
          >
            {present.map((band) => (
              <div
                key={band.label}
                className={`h-full rounded-pill ${TONE_SOLID[band.tone]}`}
                style={{ flexGrow: band.value }}
              />
            ))}
          </div>
        ) : (
          <p className="text-supporting text-ink-muted">No records have a risk score yet.</p>
        )}

        <ul className="space-y-2">
          {bands.map((band) => (
            <li key={band.label} className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2 text-body text-ink-secondary">
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 shrink-0 rounded-pill ${TONE_SOLID[band.tone]}`}
                />
                <span className="truncate">{band.label}</span>
              </span>
              <span className="text-data whitespace-nowrap tabular-nums text-ink-muted">
                <span className="font-semibold text-ink">{band.value}</span>
                <span className="ml-1.5">{shareOf(band.value, total)}</span>
              </span>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-meta text-ink-subtle">
            Shares are of the {total} scored record{total === 1 ? "" : "s"} in this summary.
          </p>
          <Link
            to="/risk"
            className="inline-flex shrink-0 items-center gap-1 rounded-control text-meta font-medium text-accent-ink transition-colors hover:text-accent hover:underline"
          >
            Open risk analysis
            <IconChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}

interface AttentionRow {
  key: string;
  label: string;
  hint: string;
  value: number;
  to: string;
  permission: Permission;
}

function AttentionRequired({
  summary,
  className,
}: {
  summary: DashboardSummary;
  className?: string;
}) {
  const { has } = useAuth();

  const candidates: AttentionRow[] = [
    {
      key: "duplicates",
      label: "Possible duplicates",
      hint: "Nothing is deleted automatically",
      value: summary.duplicate_candidates,
      to: "/inventory",
      permission: "inventory:read",
    },
    {
      key: "review",
      label: "Suggested for review",
      hint: "Sample values, not engine recommendations",
      value: summary.by_retention_action.review,
      to: "/recommendations",
      permission: "retention:read",
    },
    {
      key: "disposal",
      label: "Marked ready for disposal",
      hint: "Advisory only — disposal is not implemented",
      value: summary.by_retention_action.eligible_for_disposal,
      to: "/recommendations",
      permission: "retention:read",
    },
    {
      key: "retrieval",
      label: "Open retrieval requests",
      hint: "Restoring archived data is not built yet",
      value: summary.open_retrieval_requests,
      to: "/retrieval",
      permission: "sources:read",
    },
  ];
  const rows = candidates.filter((row) => row.value > 0);

  return (
    <Card className={className}>
      <CardHeader title="Outstanding items" description="In the synthetic sample set" />
      <CardBody className="p-0">
        {rows.length === 0 ? (
          <p className="px-card-x py-card-y text-supporting text-ink-muted">
            Nothing is waiting for you in this summary.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((row) => {
              const label = (
                <span className="min-w-0 flex-1">
                  <span className="block text-body font-medium text-ink">{row.label}</span>
                  <span className="block text-meta text-ink-muted">{row.hint}</span>
                </span>
              );
              const count = (
                <span className="shrink-0 text-title font-semibold tabular-nums text-ink">
                  {row.value}
                </span>
              );

              /*
               * Same rule as the shell breadcrumb: a row links only when the
               * signed-in account may already see that navigation item. The
               * count is still shown — hiding the number would hide a fact,
               * while linking to a refused area would offer a dead end. The
               * chevron belongs to the link only, so a plain row never looks
               * like a control that was disabled.
               */
              return (
                <li key={row.key}>
                  {has(row.permission) ? (
                    <Link
                      to={row.to}
                      className="flex items-center gap-3 px-card-x py-3 transition-colors hover:bg-surface-hover"
                    >
                      {label}
                      {count}
                      <IconChevronRight className="h-4 w-4 shrink-0 text-ink-subtle" />
                    </Link>
                  ) : (
                    <div className="flex items-center gap-3 px-card-x py-3">
                      {label}
                      {count}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function ActivityCard({ activity }: { activity: DashboardSummary["recent_activity"] }) {
  return (
    <Card>
      <CardHeader title="Recent activity" description="Latest events in the sample set" />
      <CardBody className="p-0">
        {activity.length === 0 ? (
          <p className="px-card-x py-card-y text-supporting text-ink-muted">
            No events have been recorded in the sample set.
          </p>
        ) : (
          <ol className="divide-y divide-line">
            {activity.map((item) => (
              <li
                key={item.event_id}
                className="grid grid-cols-1 gap-x-3 gap-y-1 px-card-x py-3 sm:grid-cols-[7rem_1fr]"
              >
                <time dateTime={item.occurred_on} className="text-meta tabular-nums text-ink-muted">
                  {formatDate(item.occurred_on)}
                </time>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-baseline gap-2 text-body text-ink-secondary">
                    <Badge tone="neutral">{humanize(item.event_type)}</Badge>
                    <span className="min-w-0 flex-1">{item.description}</span>
                  </p>
                  <p className="mt-1 text-meta text-ink-subtle">{item.actor}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}
