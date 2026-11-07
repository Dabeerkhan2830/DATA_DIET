import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { StatusTone, ToneInput } from "../../lib/semantic";
import { resolveStatusTone } from "../../lib/semantic";
import { IconClose, StatusIcon } from "../icons";
import { IconButton } from "./IconButton";
import { TONE_SURFACE } from "./statusClasses";

export interface ToastInput {
  title: string;
  message?: string;
  /** Any semantic role; `accent` and legacy palette names resolve to a status. */
  tone?: ToneInput;
  /** Auto-dismiss delay. Pass `null` for a toast the user must dismiss. */
  durationMs?: number | null;
}

export interface ToastMessage {
  id: number;
  title: string;
  message?: string;
  tone: StatusTone;
  durationMs: number | null;
}

export interface ToastApi {
  show: (input: ToastInput) => number;
  dismiss: (id: number) => void;
}

const DEFAULT_DURATION_MS = 5000;

const ToastContext = createContext<ToastApi | null>(null);

/**
 * The announced surface for a one-off result ("Hold created", "Decision
 * recorded"). It never replaces a permission gate or a server response: the
 * toast reports what the backend already confirmed.
 *
 * The live region is mounted for the whole session, empty at first. A
 * `aria-live` node that appears together with its message is not reliably
 * announced — the region has to exist before the text arrives.
 */
export function ToastProvider({
  children,
  maxVisible = 4,
}: {
  children: ReactNode;
  maxVisible?: number;
}) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (input: ToastInput) => {
      nextId.current += 1;
      const id = nextId.current;
      const toast: ToastMessage = {
        id,
        title: input.title,
        message: input.message,
        tone: resolveStatusTone(input.tone ?? "info"),
        durationMs: input.durationMs === undefined ? DEFAULT_DURATION_MS : input.durationMs,
      };
      setToasts((current) => [...current, toast].slice(-maxVisible));
      if (toast.durationMs !== null) {
        timers.current.set(id, setTimeout(() => dismiss(id), toast.durationMs));
      }
      return id;
    },
    [dismiss, maxVisible],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="region"
        aria-label="Notifications"
        aria-live="polite"
        className="fixed bottom-gutter right-gutter z-[60] flex w-full max-w-sm flex-col gap-stack"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`flex animate-overlay-in items-start gap-2 rounded-overlay px-card-x py-card-y shadow-toast ring-1 ring-inset ${TONE_SURFACE[toast.tone]}`}
          >
            <StatusIcon tone={toast.tone} className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-supporting font-semibold">{toast.title}</p>
              {toast.message ? <p className="mt-0.5 text-meta">{toast.message}</p> : null}
            </div>
            <IconButton
              aria-label="Dismiss notification"
              size="sm"
              variant="ghost"
              className="text-current hover:bg-transparent"
              onClick={() => dismiss(toast.id)}
            >
              <IconClose className="h-4 w-4" />
            </IconButton>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) {
    throw new Error("useToast requires a <ToastProvider> above the calling component");
  }
  return api;
}
