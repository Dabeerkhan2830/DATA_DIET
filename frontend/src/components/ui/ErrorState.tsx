import { IconRefresh } from "../icons";

export interface ErrorStateProps {
  title?: string;
  message: string;
  /** The server's own machine-readable code, kept beside the plain-language message. */
  code?: string;
  onRetry?: () => void;
}

export function ErrorState({ title = "Something went wrong", message, code, onRetry }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className="rounded-card border border-critical-line bg-critical-surface px-card-x py-6 text-critical-ink"
    >
      <h2 className="text-section font-semibold">{title}</h2>
      <p className="mt-1 text-supporting">{message}</p>
      <p className="mt-2 text-meta text-critical-ink/80">
        Check your connection, then retry. If this keeps happening, ask an
        administrator to confirm the DataDiet service is running.
      </p>
      {/*
        The developer's next step is real information, but it is not what a
        first-time reader needs in front of them, so it stays behind a
        disclosure instead of in the sentence they are asked to act on.
      */}
      <details className="mt-2">
        <summary className="cursor-pointer text-meta text-critical-ink/80">
          Technical details
        </summary>
        {code ? <p className="mt-1 font-mono text-meta">{`Server response: ${code}`}</p> : null}
        <p className="mt-1 text-meta">
          The DataDiet API may not be running. Start it with
          <code className="mx-1 rounded-control bg-critical-surface px-1 py-0.5 font-mono">
            uvicorn app.main:app --reload
          </code>
          from the <code className="font-mono">backend/</code> directory.
        </p>
      </details>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-2 rounded-control bg-surface px-3 py-1.5 text-body font-medium text-critical-ink ring-1 ring-critical-line ring-inset hover:bg-critical-surface"
        >
          <IconRefresh className="h-4 w-4" />
          Retry
        </button>
      ) : null}
    </div>
  );
}
