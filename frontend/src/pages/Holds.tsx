/**
 * Retention hold management (Phase 3).
 *
 * Holds are created and released through this screen. An active hold always
 * blocks disposal recommendations at the service layer; releasing a hold only
 * allows future assessments to consider the asset again. No file or record is
 * ever moved or deleted from this screen.
 */

import { useState } from "react";
import { toErrorMessage } from "../api/client";
import { createHold, listHolds, releaseHold } from "../api/retention";
import type { Hold } from "../api/types";
import { useApiQuery } from "../hooks/useApiQuery";
import { useAuth } from "../auth/AuthContext";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Spinner } from "../components/ui/Spinner";
import { formatDate } from "../lib/format";

export default function Holds() {
  const { activeInstitutionId, has } = useAuth();
  const { data, loading, error, refetch } = useApiQuery(() =>
    listHolds(
      activeInstitutionId !== null ? { institution_id: activeInstitutionId } : undefined,
    ),
  );

  return (
    <div>
      <PageHeader
        title="Retention Holds"
        description="Legal, audit, or administrative holds. While a hold is active, disposal recommendations for the targeted assets are blocked. Releasing a hold records who released it and why."
      />

      {loading ? <Spinner label="Loading retention holds..." /> : null}
      {error ? <ErrorState title="Holds unavailable" message={error} onRetry={refetch} /> : null}

      {data ? (
        <div className="space-y-6">
          {has("retention:write") ? <CreateHoldCard onCreated={refetch} /> : null}
          <HoldList holds={data} onReleased={refetch} />
        </div>
      ) : null}
    </div>
  );
}

function CreateHoldCard({ onCreated }: { onCreated: () => void }) {
  const { activeInstitutionId } = useAuth();
  const [name, setName] = useState("");
  const [assetId, setAssetId] = useState("");
  const [holdType, setHoldType] = useState("");
  const [legalBasis, setLegalBasis] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setFormError(null);
    setSuccess(null);
    if (!name.trim()) {
      setFormError("A hold name is required.");
      return;
    }
    setSubmitting(true);
    try {
      const created = await createHold({
        name: name.trim(),
        asset_id: assetId ? Number(assetId) : undefined,
        hold_type: holdType.trim() || undefined,
        legal_basis: legalBasis.trim() || undefined,
        institution_id: activeInstitutionId ?? undefined,
      });
      setSuccess(`Hold "${created.name}" is now active (id ${created.id}).`);
      setName("");
      setAssetId("");
      setHoldType("");
      setLegalBasis("");
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
        title="Create hold"
        description="Target a specific asset by id, or leave the id empty for an institution-wide hold."
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
              placeholder="Litigation hold - case 2026-114"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Asset id (optional)</span>
            <input
              type="number"
              min={1}
              value={assetId}
              onChange={(e) => setAssetId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Hold type</span>
            <input
              type="text"
              value={holdType}
              onChange={(e) => setHoldType(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              placeholder="legal, audit, administrative"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Legal basis</span>
            <input
              type="text"
              value={legalBasis}
              onChange={(e) => setLegalBasis(e.target.value)}
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
              {submitting ? "Creating..." : "Create hold"}
            </button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function HoldList({ holds, onReleased }: { holds: Hold[]; onReleased: () => void }) {
  if (holds.length === 0) {
    return (
      <EmptyState
        title="No retention holds"
        message="When a legal, audit, or administrative hold is needed, create it here. Active holds block disposal recommendations."
      />
    );
  }

  return (
    <Card>
      <CardHeader title={`Holds (${holds.length})`} />
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
            <tr>
              <th scope="col" className="px-5 py-3">Name</th>
              <th scope="col" className="px-5 py-3">Type</th>
              <th scope="col" className="px-5 py-3">Asset</th>
              <th scope="col" className="px-5 py-3">Status</th>
              <th scope="col" className="px-5 py-3">Created</th>
              <th scope="col" className="px-5 py-3">Released</th>
              <th scope="col" className="px-5 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {holds.map((hold) => (
              <HoldRow key={hold.id} hold={hold} onReleased={onReleased} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function HoldRow({ hold, onReleased }: { hold: Hold; onReleased: () => void }) {
  const { has } = useAuth();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleRelease(): Promise<void> {
    const reason = window.prompt(
      "Release reason (recorded with your name in the release metadata):",
    );
    if (reason === null) return;
    setBusy(true);
    setMessage(null);
    try {
      await releaseHold(hold.id, reason || undefined);
      setMessage("Hold released.");
      onReleased();
    } catch (cause) {
      setMessage(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td className="px-5 py-3">
        <div className="font-medium text-slate-900">{hold.name}</div>
        {hold.legal_basis ? (
          <div className="text-xs text-slate-500">{hold.legal_basis}</div>
        ) : null}
        {message ? (
          <div role="status" className="mt-1 text-xs text-slate-600">
            {message}
          </div>
        ) : null}
      </td>
      <td className="px-5 py-3 text-slate-700">{hold.hold_type ?? "-"}</td>
      <td className="px-5 py-3 text-slate-700">
        {hold.asset_id !== null ? `#${hold.asset_id}` : "All assets"}
      </td>
      <td className="px-5 py-3">
        <Badge tone={hold.status === "active" ? "rose" : "slate"}>{hold.status}</Badge>
      </td>
      <td className="px-5 py-3 text-slate-500">{formatDate(hold.created_at.slice(0, 10))}</td>
      <td className="px-5 py-3 text-slate-500">
        {hold.released_at ? (
          <>
            <div>{formatDate(hold.released_at.slice(0, 10))}</div>
            {hold.release_reason ? (
              <div className="text-xs">{hold.release_reason}</div>
            ) : null}
          </>
        ) : (
          "-"
        )}
      </td>
      <td className="px-5 py-3">
        {has("retention:write") ? (
          <button
            type="button"
            disabled={busy || hold.status === "released"}
            onClick={handleRelease}
            className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-slate-300 ring-inset hover:bg-slate-50 disabled:opacity-50"
          >
            Release
          </button>
        ) : null}
      </td>
    </tr>
  );
}
