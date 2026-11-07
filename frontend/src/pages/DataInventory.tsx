/**
 * Data inventory (redesign Phase 5.2).
 *
 * Reads the real asset table through `GET /api/v1/assets` — no demo fixture is
 * involved. Search and every filter are applied by the server, so the count in
 * the results header is the server's own `total`, not the length of one page.
 *
 * The page is read-only by design: the asset API's write endpoints need a
 * different permission, and archiving, restoration and disposal are not
 * implemented anywhere in this product.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listAssets } from "../api/assets";
import type { Asset, AssetSensitivity, LifecycleStatus } from "../api/types";
import { useApiQuery } from "../hooks/useApiQuery";
import { useAuth } from "../auth/AuthContext";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Field } from "../components/ui/Field";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../components/ui/Table";
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconClose,
  IconFilter,
} from "../components/icons";
import { formatBytes, formatDate, humanize } from "../lib/format";
import { toneForLifecycleStatus, toneForSensitivity } from "../lib/semantic";

/** The server's own default page size; its maximum is 100. */
const PER_PAGE = 20;

/** How long a text filter must be idle before the server is re-queried. */
const TEXT_DEBOUNCE_MS = 300;

/**
 * The five values `Asset.sensitivity` accepts, taken from the Literal in
 * `backend/app/api/schemas/assets.py`. `unknown` is what an unclassified asset
 * stores, so it is filterable too.
 */
const SENSITIVITY_OPTIONS: Array<{ value: AssetSensitivity; label: string }> = [
  { value: "restricted", label: "Restricted" },
  { value: "confidential", label: "Confidential" },
  { value: "internal", label: "Internal" },
  { value: "public", label: "Public" },
  { value: "unknown", label: "Not classified" },
];

/** The four `Asset.lifecycle_status` values from the same schema. */
const LIFECYCLE_OPTIONS: Array<{ value: LifecycleStatus; label: string }> = [
  { value: "active", label: "Active" },
  { value: "under_review", label: "Under review" },
  { value: "archived", label: "Archived" },
  { value: "pending_disposal", label: "Pending disposal" },
];

interface InventoryQuery {
  page: number;
  search: string;
  sensitivity: AssetSensitivity | "";
  lifecycleStatus: LifecycleStatus | "";
  category: string;
  sourceType: string;
}

const DEFAULT_QUERY: InventoryQuery = {
  page: 1,
  search: "",
  sensitivity: "",
  lifecycleStatus: "",
  category: "",
  sourceType: "",
};

/**
 * Returns `value` once it has stopped changing for `delayMs`.
 *
 * Text filters are typed one character at a time, so the request waits for the
 * settled value; page changes and dropdown choices are never debounced.
 */
function useSettledValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}

/** `updated_at` is a timestamp; only its date part is displayed. */
function formatTimestamp(iso: string): string {
  return formatDate(iso.slice(0, 10));
}

export default function DataInventory() {
  const { activeInstitutionId, has } = useAuth();
  const [query, setQuery] = useState<InventoryQuery>(DEFAULT_QUERY);

  const settledSearch = useSettledValue(query.search, TEXT_DEBOUNCE_MS);
  const settledCategory = useSettledValue(query.category.trim(), TEXT_DEBOUNCE_MS);
  const settledSourceType = useSettledValue(query.sourceType.trim(), TEXT_DEBOUNCE_MS);

  const { data, loading, error, refetch } = useApiQuery(
    (signal) =>
      listAssets(
        {
          page: query.page,
          per_page: PER_PAGE,
          search: settledSearch || undefined,
          sensitivity: query.sensitivity || undefined,
          lifecycle_status: query.lifecycleStatus || undefined,
          category: settledCategory || undefined,
          source_type: settledSourceType || undefined,
          institution_id: activeInstitutionId ?? undefined,
        },
        signal,
      ),
    [
      query.page,
      activeInstitutionId,
      query.sensitivity,
      query.lifecycleStatus,
      settledSearch,
      settledCategory,
      settledSourceType,
    ],
  );

  /** Any change except the page number returns the view to the first page. */
  function update(patch: Partial<InventoryQuery>): void {
    setQuery((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  const filtersActive =
    query.search !== "" ||
    query.sensitivity !== "" ||
    query.lifecycleStatus !== "" ||
    query.category !== "" ||
    query.sourceType !== "";

  const canOpenGovernance = has("governance:read");

  return (
    <div className="space-y-gutter">
      <PageHeader
        title="Data Inventory"
        description="Every data record DataDiet has found. Search for a record, then open it to see what it holds."
      />

      <FilterCard
        query={query}
        filtersActive={filtersActive}
        onChange={update}
        onClear={() => setQuery({ ...DEFAULT_QUERY, page: 1 })}
      />

      {error ? (
        <ErrorState title="Inventory unavailable" message={error} onRetry={refetch} />
      ) : null}

      {loading && data === null ? <LoadingAssets /> : null}

      {data ? (
        <Card>
          <CardHeader
            title={`Data records (${data.total})`}
            description={`${
              activeInstitutionId === null
                ? "Every institution this account can read"
                : `Institution #${activeInstitutionId}`
            } · Newest first`}
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
                title="No data records match this search"
                message={
                  filtersActive
                    ? "Nothing in this scope matches what you asked for. Remove a filter, or change the institution scope in the sidebar, to see more."
                    : "This scope has no data records yet. Sources are scanned from the Scans screen — nothing is scanned on its own."
                }
              />
            </CardBody>
          ) : (
            <AssetTable items={data.items} canOpenGovernance={canOpenGovernance} />
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
    </div>
  );
}

/**
 * The one thing this page asks for: a search, then two familiar filters.
 *
 * The remaining two are exact-match fields against stored values, which only
 * make sense once a reader knows the value they are looking for, so they stay
 * behind a toggle that opens by itself when a link already carries one.
 */
function FilterCard({
  query,
  filtersActive,
  onChange,
  onClear,
}: {
  query: InventoryQuery;
  filtersActive: boolean;
  onChange: (patch: Partial<InventoryQuery>) => void;
  onClear: () => void;
}) {
  const exactMatchActive = query.category !== "" || query.sourceType !== "";
  const [showExactMatch, setShowExactMatch] = useState(exactMatchActive);

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="Search data records"
            hint="Results update a moment after you stop typing."
            className="min-w-40 flex-1"
          >
            {(control) => (
              <Input
                {...control}
                type="search"
                value={query.search}
                onChange={(event) => onChange({ search: event.target.value })}
                placeholder="Title, file name, external id, or owner"
              />
            )}
          </Field>
          <button
            type="button"
            onClick={() => setShowExactMatch((open) => !open)}
            aria-expanded={showExactMatch}
            className="mb-1 inline-flex shrink-0 items-center gap-1.5 rounded-control px-3 py-2 text-supporting font-medium text-ink-secondary ring-1 ring-inset ring-line-strong transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <IconFilter className="h-4 w-4" />
            {showExactMatch ? "Hide" : "More filters"}
            {showExactMatch ? (
              <IconChevronUp className="h-3.5 w-3.5" />
            ) : (
              <IconChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
          {filtersActive ? (
            <Button variant="ghost" size="sm" onClick={onClear} className="mb-1 shrink-0">
              <IconClose className="h-4 w-4" />
              Clear filters
            </Button>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Sensitivity">
            {(control) => (
              <Select
                {...control}
                value={query.sensitivity}
                onChange={(event) =>
                  onChange({ sensitivity: event.target.value as AssetSensitivity | "" })
                }
              >
                <option value="">Any sensitivity</option>
                {SENSITIVITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Lifecycle status">
            {(control) => (
              <Select
                {...control}
                value={query.lifecycleStatus}
                onChange={(event) =>
                  onChange({ lifecycleStatus: event.target.value as LifecycleStatus | "" })
                }
              >
                <option value="">Any status</option>
                {LIFECYCLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {showExactMatch ? (
            <>
              <Field
                label="Category"
                hint="The exact value stored on a record, such as hr_records."
              >
                {(control) => (
                  <Input
                    {...control}
                    value={query.category}
                    onChange={(event) => onChange({ category: event.target.value })}
                    placeholder="hr_records"
                  />
                )}
              </Field>
              <Field label="Source type" hint="The exact value stored, such as hris.">
                {(control) => (
                  <Input
                    {...control}
                    value={query.sourceType}
                    onChange={(event) => onChange({ sourceType: event.target.value })}
                    placeholder="hris"
                  />
                )}
              </Field>
            </>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * The first-load state: the shape of the table with its content withheld.
 *
 * `role="status"` carries the announcement, so the bars themselves are hidden
 * from assistive tech rather than read out as an unnamed grid.
 */
function LoadingAssets() {
  return (
    <Card>
      <CardHeader title="Data records" description="Loading the first page…" />
      <CardBody>
        <span role="status" className="sr-only">
          Loading data records…
        </span>
        <div aria-hidden="true" className="space-y-4 py-2">
          {[0, 1, 2, 3, 4].map((row) => (
            <div key={row} className="flex items-center gap-4">
              <div className="flex-1 space-y-2">
                <div className="h-3 w-2/5 animate-pulse rounded-pill bg-surface-sunken" />
                <div className="h-2.5 w-1/4 animate-pulse rounded-pill bg-surface-sunken" />
              </div>
              <div className="h-5 w-24 animate-pulse rounded-pill bg-surface-sunken" />
              <div className="hidden h-5 w-28 animate-pulse rounded-pill bg-surface-sunken sm:block" />
              <div className="hidden h-3 w-16 animate-pulse rounded-pill bg-surface-sunken lg:block" />
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

function AssetTable({
  items,
  canOpenGovernance,
}: {
  items: Asset[];
  canOpenGovernance: boolean;
}) {
  return (
    <Table caption="Data records in the current view">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Record</TableHeaderCell>
          <TableHeaderCell>Sensitivity</TableHeaderCell>
          <TableHeaderCell>Lifecycle</TableHeaderCell>
          <TableHeaderCell className="hidden lg:table-cell">Source</TableHeaderCell>
          <TableHeaderCell className="hidden md:table-cell" align="right">
            Size
          </TableHeaderCell>
          <TableHeaderCell className="hidden xl:table-cell">Updated</TableHeaderCell>
          <TableHeaderCell align="right">Governance</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {items.map((asset) => (
          <AssetRow key={asset.id} asset={asset} canOpenGovernance={canOpenGovernance} />
        ))}
      </TableBody>
    </Table>
  );
}

function AssetRow({ asset, canOpenGovernance }: { asset: Asset; canOpenGovernance: boolean }) {
  return (
    <TableRow>
      <TableCell className="max-w-sm">
        <p className="font-medium text-ink">{asset.title}</p>
        <p className="mt-0.5 text-meta font-mono text-ink-muted">
          #{asset.id} · {asset.external_id}
        </p>
        {asset.file_name ? (
          <p className="mt-0.5 truncate text-meta text-ink-subtle" title={asset.file_name}>
            {asset.file_name}
          </p>
        ) : null}
        {asset.contains_personal_data || asset.duplicate_of_id !== null ? (
          <p className="mt-1.5 flex flex-wrap gap-1.5">
            {asset.contains_personal_data ? (
              <Badge tone="caution">Contains personal data</Badge>
            ) : null}
            {asset.duplicate_of_id !== null ? (
              <Badge tone="neutral">Duplicate of #{asset.duplicate_of_id}</Badge>
            ) : null}
          </p>
        ) : null}
      </TableCell>
      <TableCell>
        <Badge tone={toneForSensitivity(asset.sensitivity)}>
          {asset.sensitivity === "unknown" ? "Not classified" : humanize(asset.sensitivity)}
        </Badge>
      </TableCell>
      <TableCell>
        <Badge tone={toneForLifecycleStatus(asset.lifecycle_status)}>
          {humanize(asset.lifecycle_status)}
        </Badge>
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <p>{asset.source_type ? humanize(asset.source_type) : "—"}</p>
        <p className="mt-0.5 text-meta text-ink-muted">
          {asset.category ? humanize(asset.category) : "No category"}
          {" · "}
          {humanize(asset.record_type)}
        </p>
      </TableCell>
      <TableCell className="hidden md:table-cell" align="right">
        <span className="tabular-nums">{formatBytes(asset.size_bytes)}</span>
      </TableCell>
      <TableCell className="hidden xl:table-cell">
        <time
          dateTime={asset.updated_at.slice(0, 10)}
          className="whitespace-nowrap tabular-nums"
        >
          {formatTimestamp(asset.updated_at)}
        </time>
      </TableCell>
      <TableCell align="right">
        {canOpenGovernance ? (
          <Link
            to={`/governance/assets/${asset.id}`}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-control text-meta font-medium text-accent-ink transition-colors hover:text-accent hover:underline"
          >
            Open
            <IconChevronRight className="h-3.5 w-3.5" />
            <span className="sr-only">governance view for {asset.title}</span>
          </Link>
        ) : (
          <span className="text-meta text-ink-subtle">—</span>
        )}
      </TableCell>
    </TableRow>
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
      aria-label="Inventory pagination"
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
        Page {page} of {pages} · {total} record{total === 1 ? "" : "s"} found
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
