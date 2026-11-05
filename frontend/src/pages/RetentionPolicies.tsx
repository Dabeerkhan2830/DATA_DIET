/**
 * Retention policy management (Phase 3).
 *
 * Policies are governance configuration only. Creating or activating a policy
 * never moves, archives, or deletes any asset; the assessment engine only
 * produces advisory recommendations.
 */

import { useCallback, useState } from "react";
import {
  activatePolicyVersion,
  createPolicy,
  createPolicyVersion,
  listPolicies,
} from "../api/retention";
import type { Policy } from "../api/types";
import { toErrorMessage } from "../api/client";
import { useApiQuery } from "../hooks/useApiQuery";
import { useAuth } from "../auth/AuthContext";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Spinner } from "../components/ui/Spinner";
import { formatDate } from "../lib/format";

type Tone = "slate" | "indigo" | "emerald" | "sky" | "amber" | "orange" | "rose";

const POLICY_STATUS_TONES: Record<string, Tone> = {
  draft: "slate",
  approved: "sky",
  active: "emerald",
  retired: "amber",
  inactive: "slate",
};

export default function RetentionPolicies() {
  const { activeInstitutionId, has } = useAuth();
  const { data, loading, error, refetch } = useApiQuery(() =>
    listPolicies(
      activeInstitutionId !== null ? { institution_id: activeInstitutionId } : undefined,
    ),
  );

  return (
    <div>
      <PageHeader
        title="Retention Policies"
        description="Versioned retention rules and legal or administrative holds. Policies are governance configuration: they produce advisory recommendations only and never move, archive, or delete an asset."
      />

      {loading ? <Spinner label="Loading retention policies..." /> : null}
      {error ? (
        <ErrorState title="Policies unavailable" message={error} onRetry={refetch} />
      ) : null}

      {data ? (
        <div className="space-y-6">
          {has("retention:write") ? <CreatePolicyCard onCreated={refetch} /> : null}
          <PolicyList policies={data} onChanged={refetch} />
        </div>
      ) : null}
    </div>
  );
}

function CreatePolicyCard({ onCreated }: { onCreated: () => void }) {
  const { activeInstitutionId } = useAuth();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [categories, setCategories] = useState("");
  const [periodDays, setPeriodDays] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setFormError(null);
    setSuccess(null);
    if (!name.trim()) {
      setFormError("A policy name is required.");
      return;
    }
    setSubmitting(true);
    try {
      const created = await createPolicy({
        name: name.trim(),
        description: description.trim() || undefined,
        applicable_categories: categories
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean),
        retention_period_days: periodDays ? Number(periodDays) : undefined,
        institution_id: activeInstitutionId ?? undefined,
      });
      setSuccess(`Policy "${created.name}" created as draft (id ${created.id}).`);
      setName("");
      setDescription("");
      setCategories("");
      setPeriodDays("");
      onCreated();
    } catch (cause) {
      setFormError(toErrorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Create draft policy"
        description="New policies start as drafts and only apply to assessments after a version is activated."
      />
      <CardBody>
        <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              placeholder="Employee records retention"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Applicable categories</span>
            <input
              type="text"
              value={categories}
              onChange={(e) => setCategories(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              placeholder="hr, finance (comma separated)"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Retention period (days)</span>
            <input
              type="number"
              min={0}
              value={periodDays}
              onChange={(e) => setPeriodDays(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="font-medium text-slate-700">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          {formError ? (
            <p role="alert" className="text-sm text-rose-700 sm:col-span-2">
              {formError}
            </p>
          ) : null}
          {success ? (
            <p role="status" className="text-sm text-emerald-700 sm:col-span-2">
              {success}
            </p>
          ) : null}
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {submitting ? "Creating..." : "Create draft"}
            </button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function PolicyList({
  policies,
  onChanged,
}: {
  policies: Policy[];
  onChanged: () => void;
}) {
  if (policies.length === 0) {
    return (
      <EmptyState
        title="No retention policies yet"
        message="Create a draft policy above. Drafts never affect assessments until a version is activated."
      />
    );
  }

  return (
    <Card>
      <CardHeader title={`Policies (${policies.length})`} description="Advisory configuration only." />
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
            <tr>
              <th scope="col" className="px-5 py-3">Name</th>
              <th scope="col" className="px-5 py-3">Status</th>
              <th scope="col" className="px-5 py-3">Categories</th>
              <th scope="col" className="px-5 py-3">Retention (days)</th>
              <th scope="col" className="px-5 py-3">Created</th>
              <th scope="col" className="px-5 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {policies.map((policy) => (
              <PolicyRow key={policy.id} policy={policy} onChanged={onChanged} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function PolicyRow({ policy, onChanged }: { policy: Policy; onChanged: () => void }) {
  const { has } = useAuth();
  const canManage = has("retention:write");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleNewVersion = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const version = await createPolicyVersion(policy.id, {
        description: policy.description ?? undefined,
        applicable_categories: policy.applicable_categories ?? undefined,
        retention_period_days: policy.retention_period_days ?? undefined,
        retention_trigger: policy.retention_trigger ?? undefined,
      });
      setMessage(`Draft version ${version.version_number} created (id ${version.id}).`);
      onChanged();
    } catch (cause) {
      setMessage(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [policy, onChanged]);

  const handleActivate = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const updated = await activatePolicyVersion(policy.id, policy.current_version_id ?? 0);
      setMessage(`Policy is now ${updated.status}.`);
      onChanged();
    } catch (cause) {
      setMessage(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [policy, onChanged]);

  return (
    <tr>
      <td className="px-5 py-3">
        <div className="font-medium text-slate-900">{policy.name}</div>
        {policy.description ? (
          <div className="text-xs text-slate-500">{policy.description}</div>
        ) : null}
        {message ? (
          <div role="status" className="mt-1 text-xs text-slate-600">
            {message}
          </div>
        ) : null}
      </td>
      <td className="px-5 py-3">
        <Badge tone={POLICY_STATUS_TONES[policy.status] ?? "slate"}>{policy.status}</Badge>
      </td>
      <td className="px-5 py-3 text-slate-700">
        {policy.applicable_categories?.length
          ? policy.applicable_categories.join(", ")
          : "All categories"}
      </td>
      <td className="px-5 py-3 text-slate-700">
        {policy.retention_period_days ?? "Not set"}
      </td>
      <td className="px-5 py-3 text-slate-500">{formatDate(policy.created_at.slice(0, 10))}</td>
      <td className="px-5 py-3">
        <div className="flex flex-wrap gap-2">
          {canManage ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={handleNewVersion}
                className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-slate-300 ring-inset hover:bg-slate-50 disabled:opacity-50"
              >
                New version
              </button>
              <button
                type="button"
                disabled={busy || policy.status === "active" || policy.current_version_id === null}
                onClick={handleActivate}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Activate current version
              </button>
            </>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
