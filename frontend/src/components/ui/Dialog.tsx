import { useId, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { IconClose } from "../icons";
import { IconButton } from "./IconButton";
import { useOverlayBehavior } from "./overlayBehavior";

export interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Where the cursor should land. Defaults to the first control in the panel. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  width?: "sm" | "md" | "lg";
  /** Backdrop click closes by default; a dialog that must not be dismissed passes `false`. */
  dismissOnBackdrop?: boolean;
}

const WIDTHS: Record<NonNullable<DialogProps["width"]>, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-3xl",
};

/**
 * A modal dialog built on the native `role="dialog"` + `aria-modal` contract.
 *
 * Focus-in, focus-restore, scroll lock, Escape and the Tab trap come from
 * `useOverlayBehavior` — the same behaviour the mobile navigation drawer uses,
 * so the two overlays cannot drift apart.
 */
export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  initialFocusRef,
  width = "md",
  dismissOnBackdrop = true,
}: DialogProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const descriptionId = `${uid}-description`;
  const panelRef = useRef<HTMLDivElement>(null);

  useOverlayBehavior({ open, panelRef, onClose, initialFocusRef });

  if (!open) {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {dismissOnBackdrop ? (
        <div className="absolute inset-0 bg-overlay" aria-hidden="true" onClick={onClose} />
      ) : (
        <div className="absolute inset-0 bg-overlay" aria-hidden="true" />
      )}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={`relative w-full rounded-overlay border border-line bg-surface shadow-overlay animate-overlay-in ${
          WIDTHS[width]
        }`}
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-card-x py-card-y">
          <h2 id={titleId} className="text-section font-semibold text-ink">
            {title}
          </h2>
          <IconButton aria-label="Close" size="sm" onClick={onClose}>
            <IconClose className="h-4 w-4" />
          </IconButton>
        </header>
        {description ? (
          <p
            id={descriptionId}
            className="border-b border-line px-card-x py-card-y text-supporting text-ink-muted"
          >
            {description}
          </p>
        ) : null}
        <div className="px-card-x py-card-y text-body text-ink-secondary">{children}</div>
        {footer ? (
          <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-card-x py-card-y">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
