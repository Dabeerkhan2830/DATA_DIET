import type { ComponentPropsWithRef } from "react";
import {
  CONTROL_BASE,
  CONTROL_DISABLED,
  CONTROL_INVALID,
  CONTROL_RESTING,
  isInvalidState,
} from "./control";

export interface InputProps extends ComponentPropsWithRef<"input"> {
  /** Force the invalid treatment; `aria-invalid` alone has the same effect. */
  invalid?: boolean;
}

/**
 * A tokened native input. It accepts a `ref` — the props type is taken from the
 * element, not from `InputHTMLAttributes` — because `Dialog` focuses a named
 * control and a form may need the same handle.
 */
export function Input({ invalid, className, ...rest }: InputProps) {
  const showInvalid = isInvalidState(invalid, rest["aria-invalid"]);
  return (
    <input
      className={`${CONTROL_BASE} ${showInvalid ? CONTROL_INVALID : CONTROL_RESTING} ${CONTROL_DISABLED} ${
        className ?? ""
      }`}
      {...rest}
    />
  );
}
