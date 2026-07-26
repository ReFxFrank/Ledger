'use client';

import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { Label } from '@ledger/ui';

export interface FieldControlProps {
  readonly id: string;
  readonly 'aria-describedby': string | undefined;
  readonly 'aria-invalid': true | undefined;
}

export interface FieldProps {
  readonly id: string;
  readonly label: string;
  /** The rule, stated before the user breaks it. Stays visible while the field is in error. */
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly required?: boolean;
  readonly children: (props: FieldControlProps) => ReactNode;
}

/**
 * A labelled control with its hint and its error.
 *
 * The control is a render prop so the `id`, `aria-describedby` and `aria-invalid` wiring is
 * produced here rather than retyped at every call site — which is exactly the wiring that goes
 * missing on the fourth form somebody adds, and the wiring a screen reader depends on to read
 * "Password, 12 characters minimum, invalid entry" instead of "edit text".
 */
export function Field({ id, label, hint, error, required = false, children }: FieldProps): ReactNode {
  const hintId = hint === undefined ? null : `${id}-hint`;
  const errorId = error === undefined ? null : `${id}-error`;
  const describedBy = [hintId, errorId].filter((value) => value !== null).join(' ');

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} required={required}>
        {label}
      </Label>

      {children({
        id,
        'aria-describedby': describedBy === '' ? undefined : describedBy,
        'aria-invalid': error === undefined ? undefined : true,
      })}

      {hint === undefined ? null : (
        <p id={hintId ?? undefined} className="text-[0.6875rem] leading-snug text-text-3">
          {hint}
        </p>
      )}

      {error === undefined ? null : (
        <p id={errorId ?? undefined} className="flex items-start gap-1.5 text-[0.6875rem] leading-snug text-alert">
          <AlertCircle aria-hidden className="mt-px size-3 shrink-0" strokeWidth={2} />
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The form-level error: the request failed, not a field.
 *
 * `role="alert"` so it is announced the moment it appears — a message under a button the user
 * has already looked away from is a message they will not read.
 */
export function FormError({ children }: { readonly children: ReactNode }): ReactNode {
  if (children === null || children === undefined || children === false) return null;
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-alert/35 bg-alert-dim px-2.5 py-2 text-xs leading-snug text-alert"
    >
      <AlertCircle aria-hidden className="mt-px size-3.5 shrink-0" strokeWidth={2} />
      {children}
    </p>
  );
}
