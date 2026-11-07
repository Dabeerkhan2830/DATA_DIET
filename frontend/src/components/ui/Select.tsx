import type { ComponentPropsWithRef } from "react";
import { IconChevronDown } from "../icons";
import {
  CONTROL_BASE,
  CONTROL_DISABLED,
  CONTROL_INVALID,
  CONTROL_RESTING,
  isInvalidState,
} from "./control";

export interface SelectProps extends ComponentPropsWithRef<"select"> {
  invalid?: boolean;
}

/**
 * A native `<select>` with a drawn chevron: the keyboard and screen-reader
 * behaviour of the platform element is kept, and only its appearance is tokened.
 * Options are the caller's children, because which values exist is a domain
 * question, not a design-system one.
 */
export function Select({ invalid, className, children, ...rest }: SelectProps) {
  const showInvalid = isInvalidState(invalid, rest["aria-invalid"]);
  return (
    <span className="relative block">
      <select
        className={`${CONTROL_BASE} ${
          showInvalid ? CONTROL_INVALID : CONTROL_RESTING
        } ${CONTROL_DISABLED} appearance-none pr-9 ${className ?? ""}`}
        {...rest}
      >
        {children}
      </select>
      <IconChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
    </span>
  );
}
