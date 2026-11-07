import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "critical";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  children: ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-active disabled:bg-accent-line disabled:text-accent-ink",
  secondary:
    "bg-surface text-ink ring-1 ring-inset ring-line-strong hover:bg-surface-hover active:bg-surface-sunken disabled:bg-surface-disabled disabled:text-ink-disabled disabled:ring-line",
  ghost:
    "bg-transparent text-ink-secondary hover:bg-surface-sunken hover:text-ink disabled:text-ink-disabled",
  critical:
    "bg-critical text-on-accent hover:bg-critical-ink disabled:bg-critical-line disabled:text-critical-ink",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "min-h-8 gap-1.5 px-3 py-1 text-supporting",
  md: "min-h-9 gap-2 px-control-x py-control-y text-body",
};

/**
 * The only button a feature page should use. `type` defaults to `"button"` so a
 * button inside a form never submits it by accident — a caller that wants the
 * native behaviour passes `type="submit"` explicitly. `loading` disables the
 * control and marks it `aria-busy`, because a pressed-but-refused action reads
 * to a screen-reader user as a hang unless it says so.
 */
export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  fullWidth = false,
  disabled,
  type = "button",
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center rounded-control font-medium transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${SIZES[size]} ${
        fullWidth ? "w-full" : ""
      } ${className ?? ""}`}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden="true"
          className="h-4 w-4 shrink-0 animate-spin rounded-pill border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
}
