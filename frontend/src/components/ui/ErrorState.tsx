import { IconRefresh } from "../icons";

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ title = "Something went wrong", message, onRetry }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-rose-200 bg-rose-50 px-5 py-6 text-rose-900"
    >
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-rose-800">{message}</p>
      <p className="mt-2 text-xs text-rose-700">
        The DataDiet API may not be running. Start it with
        <code className="mx-1 rounded bg-rose-100 px-1 py-0.5 font-mono">
          uvicorn app.main:app --reload
        </code>
        from the <code className="font-mono">backend/</code> directory.
      </p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-rose-700 ring-1 ring-rose-300 ring-inset hover:bg-rose-100"
        >
          <IconRefresh className="h-4 w-4" />
          Retry
        </button>
      ) : null}
    </div>
  );
}
