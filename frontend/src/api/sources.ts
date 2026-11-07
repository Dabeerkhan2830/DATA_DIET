/**
 * Typed client for connected data sources and scan jobs.
 *
 * Every function here mirrors one route in
 * `backend/app/api/routes/connectors.py` and one schema in
 * `backend/app/api/schemas/connectors.py`. The contract shaped these decisions,
 * and none of them is a UI invention:
 *
 * - Reads need `sources:read`; every write — create, edit, validate, start,
 *   run, cancel, retry — needs `sources:write`.
 * - Editing is a **partial** `PATCH`. `connector_type` and `institution_id` are
 *   not editable, and **there is no delete endpoint for sources at all**: a
 *   source is retired by setting `status` to `inactive`.
 * - `POST /sources/{id}/validate` is the only operation that asks whether the
 *   source is actually reachable. It writes the three `last_validation_*`
 *   columns and returns `{ok, message, validated_at}`; a never-validated source
 *   has all three as `null`.
 * - Starting a scan **runs it inside the request**: `_create_and_maybe_run`
 *   calls `run_scan` before responding, so the 201 it returns already carries a
 *   terminal status. That is why nothing in this module polls, and why a
 *   `PENDING` job only exists when a scan was created with `run: false`.
 * - `POST /scan-jobs` also creates a job, but it takes the institution from the
 *   source row and cannot be scoped, so this client uses
 *   `POST /sources/{id}/scans` exclusively: one creation path, no duplicated
 *   logic, and the scope parameter the screens actually pass.
 * - A supplied `institution_id` is never proof of access. The server reconciles
 *   it with the verified identity, and a source or job belonging to another
 *   institution answers **404, not 403**, so that its existence stays private.
 * - No request or response can contain a credential or an absolute path: the
 *   schema refuses secret-looking `config` keys, and `local_folder` sources
 *   carry only an allow-list *key* that an operator must have configured in
 *   `LOCAL_SOURCE_ROOTS`.
 */

import { apiGet, apiPatch, apiPost } from "./client";
import type {
  ConnectorType,
  ScanErrorListResponse,
  ScanJob,
  ScanJobListResponse,
  ScanResultListResponse,
  Source,
  SourceListResponse,
  SourceStatus,
  SourceValidationResult,
} from "./types";

export const SOURCES_PREFIX = "/api/v1/sources";
export const SCAN_JOBS_PREFIX = "/api/v1/scan-jobs";

/** `SourceCreate`: only the fields the schema accepts, and no more. */
export interface SourceCreateInput {
  name: string;
  connector_type: ConnectorType;
  institution_id?: number;
  /** Required for `local_folder`, forbidden for `synthetic`. */
  root_key?: string;
  config?: Record<string, unknown>;
}

/** `SourceUpdate`: what `PATCH /sources/{id}` will actually change. */
export interface SourceUpdateInput {
  name?: string;
  root_key?: string;
  config?: Record<string, unknown>;
  status?: SourceStatus;
}

/** `ScanRequest`: the optional body of `POST /sources/{id}/scans`. */
export interface ScanStartInput {
  /** Server clamps to 1..5000; omit to use `SCAN_BATCH_SIZE`. */
  batch_size?: number;
  /** Defaults to true on the server, which means run to completion now. */
  run?: boolean;
}

export interface SourceListQuery {
  page?: number;
  per_page?: number;
  connector_type?: ConnectorType | "";
  status?: SourceStatus | "";
  institution_id?: number;
}

export interface ScanJobListQuery {
  page?: number;
  per_page?: number;
  data_source_id?: number;
  status?: string;
  institution_id?: number;
}

export interface ScanRowsQuery {
  page?: number;
  /** Both row routes cap `per_page` at 200 and default it to 50. */
  per_page?: number;
  institution_id?: number;
}

/* --------------------------------- sources -------------------------------- */

/**
 * One page of sources, filtered and paginated server-side
 * (`GET /sources`, `sources:read`).
 *
 * Blank filters are omitted rather than sent empty, because the route treats an
 * absent parameter as "no filter" and an unknown status value is not validated
 * server-side — it silently returns nothing, which a screen must never confuse
 * with an empty scope.
 */
export function listSources(
  query: SourceListQuery = {},
  signal?: AbortSignal,
): Promise<SourceListResponse> {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.per_page !== undefined) params.set("per_page", String(query.per_page));
  if (query.connector_type) params.set("connector_type", query.connector_type);
  if (query.status) params.set("status", query.status);
  if (query.institution_id !== undefined) {
    params.set("institution_id", String(query.institution_id));
  }
  const qs = params.toString();
  return apiGet<SourceListResponse>(`${SOURCES_PREFIX}${qs ? `?${qs}` : ""}`, signal);
}

/** One source by id (`GET /sources/{id}`, `sources:read`). */
export function getSource(
  sourceId: number,
  institutionId?: number,
  signal?: AbortSignal,
): Promise<Source> {
  const qs = institutionId === undefined ? "" : `?institution_id=${institutionId}`;
  return apiGet<Source>(`${SOURCES_PREFIX}/${sourceId}${qs}`, signal);
}

/** Create a source (`POST /sources`, `sources:write`); the server returns 201. */
export function createSource(input: SourceCreateInput): Promise<Source> {
  return apiPost<Source>(SOURCES_PREFIX, input);
}

/** Partially update a source (`PATCH /sources/{id}`, `sources:write`). */
export function updateSource(
  sourceId: number,
  input: SourceUpdateInput,
  institutionId?: number,
): Promise<Source> {
  const qs = institutionId === undefined ? "" : `?institution_id=${institutionId}`;
  return apiPatch<Source>(`${SOURCES_PREFIX}/${sourceId}${qs}`, input);
}

/**
 * Ask the server whether this source is reachable right now
 * (`POST /sources/{id}/validate`, `sources:write`).
 *
 * The verdict is `{ok, message}` and nothing else: `ok: true` means the
 * configuration resolves to something the connector can open, which is not a
 * promise that a later scan will import anything.
 */
export function validateSource(
  sourceId: number,
  institutionId?: number,
): Promise<SourceValidationResult> {
  const qs = institutionId === undefined ? "" : `?institution_id=${institutionId}`;
  return apiPost<SourceValidationResult>(`${SOURCES_PREFIX}/${sourceId}/validate${qs}`);
}

/* ---------------------------------- scans --------------------------------- */

/**
 * Create a scan job for a source and, unless `run` is false, run it to a
 * terminal state before the response arrives (`POST /sources/{id}/scans`,
 * `sources:write`, 201).
 *
 * Because the work happens inside the request, the returned job is normally
 * already `COMPLETED`, `COMPLETED_WITH_ERRORS` or `FAILED`. A second call while
 * a `PENDING` or `RUNNING` job exists answers 409.
 */
export function startScan(
  sourceId: number,
  input: ScanStartInput = {},
  institutionId?: number,
): Promise<ScanJob> {
  const qs = institutionId === undefined ? "" : `?institution_id=${institutionId}`;
  return apiPost<ScanJob>(`${SOURCES_PREFIX}/${sourceId}/scans${qs}`, input);
}

/** One page of scan jobs, newest first (`GET /scan-jobs`, `sources:read`). */
export function listScanJobs(
  query: ScanJobListQuery = {},
  signal?: AbortSignal,
): Promise<ScanJobListResponse> {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.per_page !== undefined) params.set("per_page", String(query.per_page));
  if (query.data_source_id !== undefined) {
    params.set("data_source_id", String(query.data_source_id));
  }
  if (query.status) params.set("status", query.status);
  if (query.institution_id !== undefined) {
    params.set("institution_id", String(query.institution_id));
  }
  const qs = params.toString();
  return apiGet<ScanJobListResponse>(`${SCAN_JOBS_PREFIX}${qs ? `?${qs}` : ""}`, signal);
}

/** One scan job by id (`GET /scan-jobs/{id}`, `sources:read`). */
export function getScanJob(
  jobId: number,
  institutionId?: number,
  signal?: AbortSignal,
): Promise<ScanJob> {
  const qs = institutionId === undefined ? "" : `?institution_id=${institutionId}`;
  return apiGet<ScanJob>(`${SCAN_JOBS_PREFIX}/${jobId}${qs}`, signal);
}

/**
 * Run a job that is still `PENDING` (`POST /scan-jobs/{id}/run`,
 * `sources:write`). Any other starting state is a 409 whose detail names the
 * status the server refused to move from.
 */
export function runScanJob(jobId: number, institutionId?: number): Promise<ScanJob> {
  const qs = institutionId === undefined ? "" : `?institution_id=${institutionId}`;
  return apiPost<ScanJob>(`${SCAN_JOBS_PREFIX}/${jobId}/run${qs}`);
}

/**
 * Cancel a job (`POST /scan-jobs/{id}/cancel`, `sources:write`).
 *
 * Only `PENDING` and `RUNNING` may move to `CANCELLED`, and because a scan runs
 * inside one request `RUNNING` is never observable from another one — so in
 * practice this cancels a job that has not been started yet. The service accepts
 * no cancellation callback over HTTP, and this client does not claim otherwise.
 */
export function cancelScanJob(jobId: number, institutionId?: number): Promise<ScanJob> {
  const qs = institutionId === undefined ? "" : `?institution_id=${institutionId}`;
  return apiPost<ScanJob>(`${SCAN_JOBS_PREFIX}/${jobId}/cancel${qs}`);
}

/**
 * Retry a job by creating a **new** one (`POST /scan-jobs/{id}/retry`,
 * `sources:write`, 201).
 *
 * Only `FAILED`, `COMPLETED_WITH_ERRORS` and `CANCELLED` can be retried — a
 * clean `COMPLETED` scan is refused with 409 — and the new row links back
 * through `retried_from_job_id`.
 */
export function retryScanJob(jobId: number, institutionId?: number): Promise<ScanJob> {
  const qs = institutionId === undefined ? "" : `?institution_id=${institutionId}`;
  return apiPost<ScanJob>(`${SCAN_JOBS_PREFIX}/${jobId}/retry${qs}`);
}

/** Per-record outcomes of a job (`GET /scan-jobs/{id}/results`, `sources:read`). */
export function listScanResults(
  jobId: number,
  query: ScanRowsQuery = {},
  signal?: AbortSignal,
): Promise<ScanResultListResponse> {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.per_page !== undefined) params.set("per_page", String(query.per_page));
  if (query.institution_id !== undefined) {
    params.set("institution_id", String(query.institution_id));
  }
  const qs = params.toString();
  return apiGet<ScanResultListResponse>(
    `${SCAN_JOBS_PREFIX}/${jobId}/results${qs ? `?${qs}` : ""}`,
    signal,
  );
}

/** Errors and warnings of a job (`GET /scan-jobs/{id}/errors`, `sources:read`). */
export function listScanErrors(
  jobId: number,
  query: ScanRowsQuery = {},
  signal?: AbortSignal,
): Promise<ScanErrorListResponse> {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.per_page !== undefined) params.set("per_page", String(query.per_page));
  if (query.institution_id !== undefined) {
    params.set("institution_id", String(query.institution_id));
  }
  const qs = params.toString();
  return apiGet<ScanErrorListResponse>(
    `${SCAN_JOBS_PREFIX}/${jobId}/errors${qs ? `?${qs}` : ""}`,
    signal,
  );
}
