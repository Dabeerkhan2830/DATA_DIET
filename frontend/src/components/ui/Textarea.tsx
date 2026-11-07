import type { ComponentPropsWithRef } from "react";
import {
  CONTROL_BASE,
  CONTROL_DISABLED,
  CONTROL_INVALID,
  CONTROL_RESTING,
  isInvalidState,
} from "./control";

export interface TextareaProps extends ComponentPropsWithRef<"textarea"> {
  invalid?: boolean;
}

export function Textarea({ invalid, className, rows = 4, ...rest }: TextareaProps) {
  const showInvalid = isInvalidState(invalid, rest["aria-invalid"]);
  return (
    <textarea
      rows={rows}
      className={`${CONTROL_BASE} ${
        showInvalid ? CONTROL_INVALID : CONTROL_RESTING
      } ${CONTROL_DISABLED} min-h-24 resize-y leading-relaxed ${className ?? ""}`}
      {...rest}
    />
  );
}
