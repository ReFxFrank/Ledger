'use client';

import type { ReactNode } from 'react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@ledger/ui';
import { MOD_PLACEHOLDER, SHORTCUT_GROUPS, useModifierLabel, type Binding } from '~/lib/keyboard';

/**
 * The keyboard reference.
 *
 * Every binding in the product, in one place, reachable two ways: `?` for people who already
 * guessed, and the `?` control next to the ⌘K affordance for everyone else. A shortcut whose
 * only documentation is another shortcut is a shortcut for the people who wrote it.
 */

export interface ShortcutsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

function Keycap({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-line-strong bg-ink-700 px-1.5 font-mono text-[0.6875rem] leading-none text-text-2">
      {children}
    </kbd>
  );
}

function BindingRow({ binding, modifier }: { readonly binding: Binding; readonly modifier: string }): ReactNode {
  const keys = binding.keys.map((key) => (key === MOD_PLACEHOLDER ? modifier : key));
  // "then" for a chord, "+" for a combination — the difference is the whole binding, and a row
  // that renders both the same way teaches people to hold G down.
  const joiner = binding.chord === true ? 'then' : '+';

  return (
    <div className="flex items-baseline justify-between gap-[var(--gap)] py-1">
      <span className="min-w-0 text-[0.8125rem] leading-5 text-text-2">{binding.description}</span>
      <span className="flex shrink-0 items-center gap-1">
        {keys.map((key, index) => (
          <span key={key} className="flex items-center gap-1">
            {index === 0 ? null : (
              <span aria-hidden className="text-[0.6875rem] text-text-3">
                {joiner}
              </span>
            )}
            <Keycap>{key}</Keycap>
          </span>
        ))}
        <span className="sr-only">{keys.join(` ${joiner} `)}</span>
      </span>
    </div>
  );
}

export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps): ReactNode {
  const modifier = useModifierLabel();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Most screens can be driven without a pointer. Nothing here fires while you are typing.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-[var(--pad-card)]">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="eyebrow">{group.title}</h3>
              {group.note === undefined ? null : (
                <p className="mt-1 text-xs text-text-3">{group.note}</p>
              )}
              <div className="mt-1.5 divide-y divide-line">
                {group.bindings.map((binding) => (
                  <BindingRow key={binding.description} binding={binding} modifier={modifier} />
                ))}
              </div>
            </section>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
