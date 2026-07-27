'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Checkbox, cn } from '@ledger/ui';
import type { CancellationDetail } from '~/lib/api-types';

type ChecklistStep = CancellationDetail['request']['checklist'][number];

export interface CancellationChecklistProps {
  readonly steps: readonly ChecklistStep[];
  readonly disabled: boolean;
  readonly pendingStepId: string | null;
  readonly onToggle: (stepId: string, done: boolean) => void;
}

/**
 * The steps, snapshotted at the moment the cancellation started.
 *
 * Snapshotted, not looked up live: a playbook update halfway through would renumber the list
 * under someone who has already ticked four of them. The rows come from the request row and are
 * rendered exactly as stored.
 *
 * Gotchas are `--outflow`, not `--alert`. "Accepting a discount usually restarts the billing
 * period" is a caution about money, not a fault — and if every caution were red the one genuinely
 * red thing on this screen, a charge that arrived after cancelling, would not stand out at all.
 */
export function CancellationChecklist({
  steps,
  disabled,
  pendingStepId,
  onToggle,
}: CancellationChecklistProps): React.ReactNode {
  if (steps.length === 0) {
    return (
      <p className="text-sm text-text-2">
        This cancellation has no steps recorded. Work through the provider&rsquo;s own cancellation
        flow and record the outcome below.
      </p>
    );
  }

  const done = steps.filter((step) => step.doneAt !== undefined).length;

  return (
    <div className="flex flex-col gap-[var(--gap-tight)]">
      <p className="text-xs text-text-2">
        <span className="font-mono tabular-nums text-text">
          {done}/{steps.length}
        </span>{' '}
        done. Ticking a step only records what you did — nothing here is sent anywhere.
      </p>

      <ol className="flex flex-col gap-[var(--gap-tight)]">
        {steps.map((step, index) => {
          const complete = step.doneAt !== undefined;
          const busy = pendingStepId === step.id;
          const inputId = `step-${step.id}`;

          return (
            <li
              key={step.id}
              className={cn(
                'rounded-md border bg-ink-700 p-[var(--pad-card)]',
                'transition-[border-color,opacity] duration-[var(--duration-fast)] ease-standard',
                complete ? 'border-line opacity-70' : 'border-line-strong',
                busy && 'opacity-50',
              )}
            >
              <div className="flex items-start gap-2.5">
                <Checkbox
                  id={inputId}
                  checked={complete}
                  disabled={disabled || busy}
                  onCheckedChange={(value) => {
                    onToggle(step.id, value === true);
                  }}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor={inputId}
                    className={cn(
                      'block cursor-pointer text-[0.8125rem] leading-snug',
                      complete ? 'text-text-2 line-through' : 'text-text',
                    )}
                  >
                    <span aria-hidden className="mr-1.5 font-mono text-xs text-text-3">
                      {index + 1}.
                    </span>
                    {step.text}
                  </label>

                  {step.detail === undefined ? null : (
                    <p className="mt-1 text-xs text-text-2">{step.detail}</p>
                  )}

                  {step.warning === undefined ? null : (
                    <p className="mt-2 flex items-start gap-1.5 rounded-sm border border-outflow/30 bg-outflow-dim p-2 text-xs text-outflow">
                      <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                      <span>{step.warning}</span>
                    </p>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
