import { useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

export interface TabItem {
  id: string;
  label: string;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  /** Accessible name for the tab list, e.g. "Asset detail sections". */
  ariaLabel: string;
  /** Controlled selection; omit it and `Tabs` keeps the active id itself. */
  activeId?: string;
  defaultId?: string;
  onChange?: (id: string) => void;
  children: (activeId: string) => ReactNode;
  className?: string;
}

/**
 * Tabs with the platform keyboard contract: one tab in the sequence at a time
 * (`tabIndex=0` on the selected one), arrow keys move and activate, Home/End jump
 * to the ends, and the panel names the tab that controls it. Disabled tabs are
 * skipped rather than landed on, because a focus stop that does nothing is a
 * trap for a keyboard user.
 */
export function Tabs({
  items,
  ariaLabel,
  activeId,
  defaultId,
  onChange,
  children,
  className,
}: TabsProps) {
  const uid = useId();
  const enabled = items.filter((item) => !item.disabled);
  const fallbackId = defaultId ?? enabled[0]?.id ?? "";
  const [internalId, setInternalId] = useState(fallbackId);
  const current = activeId ?? internalId;
  const listRef = useRef<HTMLDivElement>(null);

  function select(id: string) {
    if (activeId === undefined) {
      setInternalId(id);
    }
    onChange?.(id);
  }

  function moveTo(index: number) {
    const target = enabled[index];
    if (!target) {
      return;
    }
    select(target.id);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${target.id}"]`)
      ?.focus();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const index = enabled.findIndex((item) => item.id === current);
    if (index < 0) {
      return;
    }
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        moveTo((index + 1) % enabled.length);
        break;
      case "ArrowLeft":
        event.preventDefault();
        moveTo((index - 1 + enabled.length) % enabled.length);
        break;
      case "Home":
        event.preventDefault();
        moveTo(0);
        break;
      case "End":
        event.preventDefault();
        moveTo(enabled.length - 1);
        break;
    }
  }

  return (
    <div className={className}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={handleKeyDown}
        className="flex gap-1 border-b border-line"
      >
        {items.map((item) => {
          const selected = item.id === current;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              data-tab-id={item.id}
              id={`${uid}-tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`${uid}-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => select(item.id)}
              className={`-mb-px border-b-2 px-control-x py-control-y text-body font-medium transition-colors ${
                selected
                  ? "border-accent text-ink"
                  : "border-transparent text-ink-muted hover:text-ink"
              } disabled:cursor-not-allowed disabled:text-ink-disabled`}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {enabled.length > 0 ? (
        <div
          role="tabpanel"
          id={`${uid}-panel-${current}`}
          aria-labelledby={`${uid}-tab-${current}`}
          tabIndex={0}
          className="pt-stack"
        >
          {children(current)}
        </div>
      ) : null}
    </div>
  );
}
