import { useId } from "react";
import type { ReactNode } from "react";

export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  required?: true;
}

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}

/**
 * A labelled control with hint and error text, wired by generated ids.
 *
 * `children` is a render function rather than an element so the ids appear
 * explicitly in the markup instead of being cloned into an unknown component —
 * the control stays a plain `Input`, `Select` or `Textarea`, and the caller can
 * see exactly what associates the label with it:
 *
 * ```tsx
 * <Field label="Hold reason" error={error} required>
 *   {(control) => <Textarea {...control} value={reason} onChange={onChange} />}
 * </Field>
 * ```
 *
 * The error is announced (`role="alert"`) and simultaneously drives the
 * control's `aria-invalid`, so what a sighted user sees and what the screen
 * reader reads are the same fact.
 */
export function Field({ label, hint, error, required = false, className, children }: FieldProps) {
  const uid = useId();
  const id = `${uid}-control`;
  const hintId = hint ? `${uid}-hint` : undefined;
  const errorId = error ? `${uid}-error` : undefined;
  const describedBy = [hintId, errorId].filter((part): part is string => part !== undefined).join(
    " ",
  );

  const control: FieldControlProps = {
    id,
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    ...(error ? { "aria-invalid": true as const } : {}),
    ...(required ? { required: true as const } : {}),
  };

  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <label htmlFor={id} className="block text-supporting font-medium text-ink-secondary">
        {label}
        {required ? (
          <span className="ml-1 text-critical-ink" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children(control)}
      {hint ? (
        <p id={hintId} className="text-meta text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-meta text-critical-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}
