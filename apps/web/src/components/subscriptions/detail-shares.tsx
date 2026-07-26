'use client';

/**
 * Cost splitting.
 *
 * Brief decision #3: shares, not accounts. The person you split Netflix with never signs up for
 * anything — they are a label and a number of minor units.
 *
 * The server refuses shares that do not add up to the charge, so this component's job is to make
 * that constraint visible *before* the save: a running total against the charge, and a "split
 * evenly" button that uses `allocate` so the remainder lands on the earliest rows instead of a
 * penny evaporating.
 */

import * as React from 'react';
import { Plus, Trash2, Users } from 'lucide-react';
import { allocate, money, parseMoney, toDecimalString } from '@ledger/core';
import {
  Button,
  Checkbox,
  EmptyState,
  Input,
  Label,
  Money,
  Panel,
  PanelBody,
  PanelHeader,
  cn,
  focusRing,
  toast,
} from '@ledger/ui';
import { api } from '~/lib/trpc';

export interface ShareDraft {
  readonly key: string;
  readonly personLabel: string;
  /** The raw string the user typed. Parsed with `parseMoney`, never with a float. */
  readonly amount: string;
  readonly isSelf: boolean;
}

export interface SharesEditorProps {
  readonly subscriptionId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly locale: string;
  readonly shares: readonly {
    readonly id: string;
    readonly personLabel: string;
    readonly shareMinor: number;
    readonly isSelf: boolean;
  }[];
}

export function SharesEditor({
  subscriptionId,
  amountMinor,
  currency,
  locale,
  shares,
}: SharesEditorProps): React.ReactElement {
  const utils = api.useUtils();
  const [drafts, setDrafts] = React.useState<readonly ShareDraft[]>(() => toDrafts(shares, currency));
  const [error, setError] = React.useState<string | null>(null);

  // Re-seed when the server's copy changes underneath us — after a save, or after the amount was
  // edited elsewhere and the split has to be redone.
  React.useEffect(() => {
    setDrafts(toDrafts(shares, currency));
  }, [shares, currency]);

  const setShares = api.subscriptions.setShares.useMutation({
    onSuccess: async () => {
      setError(null);
      await utils.subscriptions.byId.invalidate({ id: subscriptionId });
      toast.success('Split saved.');
    },
    onError: (mutationError) => {
      // The router owns this rule; surfacing its message verbatim beats paraphrasing it badly.
      setError(mutationError.message);
    },
  });

  const parsed = drafts.map((draft) => parseShare(draft.amount, currency));
  const total = parsed.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const unreadable = parsed.some((value) => value === null);
  const balanced = !unreadable && (drafts.length === 0 || total === amountMinor);

  function update(key: string, patch: Partial<ShareDraft>): void {
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  }

  function addRow(): void {
    setDrafts((current) => [
      ...current,
      { key: `draft-${String(current.length)}-${String(Date.now())}`, personLabel: '', amount: '', isSelf: current.length === 0 },
    ]);
  }

  function splitEvenly(): void {
    if (drafts.length === 0) return;
    // `allocate` hands the leftover minor units to the earliest rows, so three ways of £10.00 is
    // 3.34 / 3.33 / 3.33 and the shares still add up to the charge.
    const parts = allocate(money(amountMinor, currency), drafts.length);
    setDrafts((current) =>
      current.map((draft, index) => {
        const part = parts[index];
        return part === undefined ? draft : { ...draft, amount: toDecimalString(part) };
      }),
    );
  }

  function save(): void {
    const payload = drafts.map((draft, index) => {
      const value = parsed[index];
      return {
        personLabel: draft.personLabel.trim() === '' ? `Person ${String(index + 1)}` : draft.personLabel.trim(),
        shareMinor: value ?? 0,
        isSelf: draft.isSelf,
      };
    });
    setShares.mutate({ id: subscriptionId, shares: payload });
  }

  return (
    <Panel>
      <PanelHeader
        eyebrow="Split"
        actions={
          <Button size="sm" variant="ghost" onClick={addRow}>
            <Plus className="size-3.5" aria-hidden />
            Add person
          </Button>
        }
      />

      {drafts.length === 0 ? (
        <EmptyState
          icon={<Users />}
          actions={
            <Button size="sm" variant="secondary" onClick={addRow}>
              <Plus className="size-3.5" aria-hidden />
              Add person
            </Button>
          }
        >
          Split this with someone and the dashboard counts your share instead of the whole charge.
        </EmptyState>
      ) : (
        <PanelBody className="flex flex-col gap-[var(--gap-tight)]">
          {drafts.map((draft, index) => {
            const value = parsed[index];
            return (
              <div key={draft.key} className="grid grid-cols-[1fr_7rem_auto] items-center gap-[var(--gap-tight)]">
                <Input
                  value={draft.personLabel}
                  placeholder={`Person ${String(index + 1)}`}
                  aria-label={`Name for share ${String(index + 1)}`}
                  onChange={(event) => {
                    update(draft.key, { personLabel: event.target.value });
                  }}
                />
                <Input
                  mono
                  inputMode="decimal"
                  value={draft.amount}
                  placeholder="0.00"
                  aria-label={`Amount for share ${String(index + 1)}`}
                  aria-invalid={value === null && draft.amount !== ''}
                  className="text-right"
                  onChange={(event) => {
                    update(draft.key, { amount: event.target.value });
                  }}
                />
                <div className="flex items-center gap-1.5">
                  <Checkbox
                    id={`self-${draft.key}`}
                    checked={draft.isSelf}
                    onCheckedChange={(checked) => {
                      // Exactly one row can be "mine"; the router refuses more than one, so the
                      // control enforces it rather than letting the save fail.
                      setDrafts((current) =>
                        current.map((item) => ({ ...item, isSelf: item.key === draft.key && checked === true })),
                      );
                    }}
                  />
                  <Label htmlFor={`self-${draft.key}`}>Mine</Label>
                  <button
                    type="button"
                    aria-label={`Remove share ${String(index + 1)}`}
                    onClick={() => {
                      setDrafts((current) => current.filter((item) => item.key !== draft.key));
                    }}
                    className={cn(
                      'grid size-7 place-items-center rounded-sm text-text-3',
                      'transition-colors duration-[var(--duration-fast)] ease-standard hover:bg-alert-dim hover:text-alert',
                      focusRing,
                    )}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </div>
              </div>
            );
          })}

          <div className="flex flex-wrap items-center justify-between gap-[var(--gap-tight)] border-t border-line pt-[var(--gap-tight)]">
            <span className="flex items-baseline gap-1.5">
              <span className="eyebrow">Adds up to</span>
              <Money
                amountMinor={total}
                currency={currency}
                tone={balanced ? 'outflow' : 'plain'}
                locale={locale}
                className={balanced ? undefined : 'text-alert'}
              />
              <span className="text-xs text-text-3">of</span>
              <Money amountMinor={amountMinor} currency={currency} tone="plain" locale={locale} />
            </span>
            <div className="flex items-center gap-[var(--gap-tight)]">
              <Button size="sm" variant="ghost" onClick={splitEvenly}>
                Split evenly
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={save}
                loading={setShares.isPending}
                disabled={!balanced}
              >
                Save split
              </Button>
            </div>
          </div>

          {balanced ? null : (
            <p role="alert" className="text-xs text-alert">
              {unreadable
                ? 'One of those amounts is not readable.'
                : 'The shares have to add up to the charge before this can be saved.'}
            </p>
          )}

          {error === null ? null : (
            <p role="alert" className="text-xs text-alert">
              {error}
            </p>
          )}
        </PanelBody>
      )}
    </Panel>
  );
}

function toDrafts(
  shares: SharesEditorProps['shares'],
  currency: string,
): readonly ShareDraft[] {
  return shares.map((share) => ({
    key: share.id,
    personLabel: share.personLabel,
    amount: safeDecimal(share.shareMinor, currency),
    isSelf: share.isSelf,
  }));
}

function safeDecimal(amountMinor: number, currency: string): string {
  try {
    return toDecimalString(money(amountMinor, currency));
  } catch {
    return '';
  }
}

/** Null means "not a number we can read" — distinct from zero, which is a valid share. */
function parseShare(raw: string, currency: string): number | null {
  if (raw.trim() === '') return null;
  try {
    return parseMoney(raw, currency).amountMinor;
  } catch {
    return null;
  }
}
