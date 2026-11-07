import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * Every element a keyboard user can land on, in DOM order.
 *
 * `aria-hidden` backdrops are excluded by the callers (they are not focusable
 * anyway); the list deliberately includes links and native controls so a trap
 * built from it matches what the browser's own Tab order would do.
 */
const FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface OverlayBehaviorOptions {
  open: boolean;
  panelRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Where the cursor should land. Defaults to the first control in the panel. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * The behaviour every blocking overlay shares: focus in and back out again,
 * background scroll lock, Escape to dismiss, and a Tab trap.
 *
 * Extracted from `Dialog` so a second overlay — the mobile navigation drawer —
 * cannot drift away from it. Escape and Tab are handled on a document listener
 * rather than on the panel: if focus ever escapes the panel the trap still
 * works and Escape still closes. Focus returns to whatever held it before the
 * overlay opened, because a keyboard user who tabs into an overlay and closes
 * it must not be dropped at the top of the page.
 */
export function useOverlayBehavior({
  open,
  panelRef,
  onClose,
  initialFocusRef,
}: OverlayBehaviorOptions): void {
  useEffect(() => {
    if (!open) {
      return;
    }
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const target =
      initialFocusRef?.current ?? panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
    target?.focus();
    return () => {
      if (previous && document.contains(previous)) {
        previous.focus();
      }
    };
  }, [open, panelRef, initialFocusRef]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const atStart = active === null || active === panel || active === first;
      if (event.shiftKey && atStart) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose, panelRef]);
}
