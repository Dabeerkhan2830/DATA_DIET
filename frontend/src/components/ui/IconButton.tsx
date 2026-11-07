import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { ButtonSize } from "./Button";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: a button with no visible text has nothing else to be read as. */
  "aria-label": string;
  variant?: "secondary" | "ghost" | "critical" | "inverse";
  size?: ButtonSize;
  children: ReactNode;
}

const VARIANTS: Record<NonNullable<IconButtonProps["variant"]>, string> = {
  secondary:
    "bg-surface text-ink-secondary ring-1 ring-inset ring-line-strong hover:bg-surface-hover hover:text-ink disabled:bg-surface-disabled disabled:text-ink-disabled",
  ghost: "bg-transparent text-ink-muted hover:bg-surface-sunken hover:text-ink disabled:text-ink-disabled",
  critical:
    "bg-critical-surface text-critical-ink ring-1 ring-inset ring-critical-line hover:bg-critical-line disabled:bg-neutral-surface disabled:text-ink-disabled disabled:ring-line",
  /* For controls that sit on the dark shell, where the light roles have no
     contrast: the ink and hover pair is the inverse surface's own quartet. */
  inverse:
    "bg-transparent text-ink-inverse-muted hover:bg-inverse-hover hover:text-ink-inverse disabled:text-ink-disabled",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 w-8",
  md: "h-9 w-9",
};

/**
 * A square, icon-only control. The accessible name is a compile-time
 * requirement here rather than a convention, because an unlabelled icon is the
 * most common way this app could become unusable with a screen reader.
 */
export function IconButton({
  variant = "ghost",
  size = "md",
  disabled,
  type = "button",
  className,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={`inline-flex shrink-0 items-center justify-center rounded-control transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${SIZES[size]} ${className ?? ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}
