'use client';

import * as React from 'react';
import { Search } from 'lucide-react';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  BILLING_CHANNELS,
  BILLING_CHANNEL_LABELS,
  type BillingChannel,
  type Category,
  type IntervalUnit,
  interval,
  intervalLabel,
  money,
  parseMoney,
  toDecimalString,
} from '@ledger/core';
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  Money,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  cn,
  focusRing,
} from '@ledger/ui';
import { api } from '~/lib/trpc';
import type { ReviewItem } from '~/lib/api-types';
import { MerchantMark } from '../merchant-mark';

/**
 * The two review actions that need more than a click.
 *
 * Both dialogs are seeded from the detection rather than from empty fields: the engine's guess is
 * the starting point and the user is correcting it, not re-entering it. An "edit & confirm" that
 * opens blank is a data-entry form wearing a review queue's clothes.
 */

const INTERVAL_UNITS: readonly IntervalUnit[] = ['day', 'week', 'month', 'year'];

/** The cadences worth a one-click preset. Anything else is typed into the count field. */
const CADENCE_PRESETS: readonly { readonly label: string; readonly unit: IntervalUnit; readonly count: number }[] = [
  { label: 'Weekly', unit: 'week', count: 1 },
  { label: 'Every 4 weeks', unit: 'week', count: 4 },
  { label: 'Monthly', unit: 'month', count: 1 },
  { label: 'Quarterly', unit: 'month', count: 3 },
  { label: 'Annual', unit: 'year', count: 1 },
];

export interface EditConfirmDialogProps {
  readonly item: ReviewItem;
  readonly open: boolean;
  readonly pending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (overrides: EditOverrides) => void;
}

export interface EditOverrides {
  readonly displayName?: string;
  readonly amountMinor?: number;
  readonly intervalUnit?: IntervalUnit;
  readonly intervalCount?: number;
  readonly category?: Category;
  readonly billingChannel?: BillingChannel;
  readonly status?: 'active' | 'trialing';
}

export function EditConfirmDialog({
  item,
  open,
  pending,
  onOpenChange,
  onSubmit,
}: EditConfirmDialogProps): React.ReactNode {
  const detection = item.detection;
  const currency = detection.currency;

  const [name, setName] = React.useState(item.merchantName ?? detection.normalizedKey);
  const [amount, setAmount] = React.useState(() => decimalOf(detection.medianAmountMinor, currency));
  const [unit, setUnit] = React.useState<IntervalUnit>(detection.intervalUnit);
  const [count, setCount] = React.useState(String(detection.intervalCount));
  const [category, setCategory] = React.useState<Category>(item.merchantCategory ?? 'other');
  const [channel, setChannel] = React.useState<BillingChannel>(detection.billingChannel);
  const [isTrial, setIsTrial] = React.useState(false);

  // Re-seeded whenever the dialog opens on a different candidate. Without the key on `detection.id`
  // the second candidate would inherit the first one's edits, which is the kind of bug that only
  // shows up as "why is this called Netflix" three rows later.
  React.useEffect(() => {
    if (!open) return;
    setName(item.merchantName ?? detection.normalizedKey);
    setAmount(decimalOf(detection.medianAmountMinor, currency));
    setUnit(detection.intervalUnit);
    setCount(String(detection.intervalCount));
    setCategory(item.merchantCategory ?? 'other');
    setChannel(detection.billingChannel);
    setIsTrial(false);
  }, [open, item.merchantName, item.merchantCategory, detection, currency]);

  const parsedAmount = React.useMemo(() => tryParseMinor(amount, currency), [amount, currency]);
  const parsedCount = Number.parseInt(count, 10);
  const countValid = Number.isInteger(parsedCount) && parsedCount >= 1 && parsedCount <= 365;
  const nameValid = name.trim().length > 0;
  const valid = parsedAmount !== null && countValid && nameValid;

  function submit(): void {
    if (!valid || parsedAmount === null) return;
    onSubmit({
      displayName: name.trim(),
      amountMinor: parsedAmount,
      intervalUnit: unit,
      intervalCount: parsedCount,
      category,
      billingChannel: channel,
      status: isTrial ? 'trialing' : 'active',
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit and confirm</DialogTitle>
          <DialogDescription>
            Correct anything the engine got wrong. What you save here is the subscription, not the
            suggestion.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-[var(--gap-loose)]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-name" required>
              Name
            </Label>
            <Input
              id="edit-name"
              value={name}
              aria-invalid={!nameValid}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </div>

          <div className="grid gap-[var(--gap-loose)] sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-amount" required>
                Amount ({currency})
              </Label>
              <Input
                id="edit-amount"
                mono
                inputMode="decimal"
                value={amount}
                aria-invalid={parsedAmount === null}
                aria-describedby="edit-amount-help"
                onChange={(event) => {
                  setAmount(event.target.value);
                }}
              />
              <p id="edit-amount-help" className="text-[0.6875rem] text-text-3">
                {parsedAmount === null ? (
                  <span className="text-alert">Enter an amount like 9.99.</span>
                ) : (
                  <>
                    Saved as{' '}
                    <Money amountMinor={parsedAmount} currency={currency} size="sm" tone="outflow" />
                  </>
                )}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-category">Category</Label>
              <Select
                value={category}
                onValueChange={(value) => {
                  setCategory(value as Category);
                }}
              >
                <SelectTrigger id="edit-category" aria-label="Category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {CATEGORY_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="eyebrow mb-1.5">Cadence</legend>
            <div className="flex flex-wrap gap-[var(--gap-tight)]">
              {CADENCE_PRESETS.map((preset) => {
                const active = preset.unit === unit && preset.count === Number.parseInt(count, 10);
                return (
                  <button
                    key={preset.label}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setUnit(preset.unit);
                      setCount(String(preset.count));
                    }}
                    className={cn(
                      'rounded-sm border px-2 py-1 text-xs leading-4',
                      'transition-[background-color,border-color,color] duration-[var(--duration-fast)] ease-standard',
                      focusRing,
                      active
                        ? 'border-control bg-control-dim text-control-2'
                        : 'border-line bg-ink-700 text-text-2 hover:border-line-hot hover:text-text',
                    )}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>

            <div className="mt-1.5 flex items-end gap-[var(--gap-tight)]">
              <div className="flex w-24 flex-col gap-1.5">
                <Label htmlFor="edit-count">Every</Label>
                <Input
                  id="edit-count"
                  mono
                  inputMode="numeric"
                  value={count}
                  aria-invalid={!countValid}
                  onChange={(event) => {
                    setCount(event.target.value);
                  }}
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Label htmlFor="edit-unit">Unit</Label>
                <Select
                  value={unit}
                  onValueChange={(value) => {
                    setUnit(value as IntervalUnit);
                  }}
                >
                  <SelectTrigger id="edit-unit" aria-label="Interval unit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INTERVAL_UNITS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-[0.6875rem] text-text-3">
              {countValid ? intervalLabel(interval(unit, parsedCount)) : 'Between 1 and 365.'}
            </p>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-channel">Billed through</Label>
            <Select
              value={channel}
              onValueChange={(value) => {
                setChannel(value as BillingChannel);
              }}
            >
              <SelectTrigger id="edit-channel" aria-label="Billing channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BILLING_CHANNELS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {BILLING_CHANNEL_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Not cosmetic: the channel picks the cancellation playbook, and an App Store
                subscription filed as `direct` sends the user to a page that cannot cancel it. */}
            <p className="text-[0.6875rem] text-text-3">
              This decides where the cancellation instructions point you.
            </p>
          </div>

          <label className="flex items-start gap-2.5 rounded-md border border-line bg-ink-700 p-[var(--pad-card)]">
            <Checkbox
              checked={isTrial}
              onCheckedChange={(value) => {
                setIsTrial(value === true);
              }}
              aria-label="This is a free trial"
            />
            <span className="min-w-0">
              <span className="block text-[0.8125rem] text-text">This is a free trial</span>
              <span className="block text-xs text-text-2">
                The bank feed cannot see a trial. Tick this and you can set the end date on the
                subscription.
              </span>
            </span>
          </label>
        </DialogBody>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} loading={pending} onClick={submit}>
            Save and confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── merge ────────────────────────────────────────────────────────────────────────────────

export interface MergeDialogProps {
  readonly item: ReviewItem;
  readonly open: boolean;
  readonly pending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (subscriptionId: string) => void;
}

/**
 * "I already track this."
 *
 * Merging does not create anything — it points the detection at a subscription that already
 * exists and hands over the charges behind it, which is what makes the history on the existing
 * row complete rather than starting a second row for the same provider.
 */
export function MergeDialog({
  item,
  open,
  pending,
  onOpenChange,
  onSubmit,
}: MergeDialogProps): React.ReactNode {
  const [search, setSearch] = React.useState('');
  const [chosen, setChosen] = React.useState<string | null>(null);

  const list = api.subscriptions.list.useQuery(
    { limit: 200, sort: 'name', direction: 'asc' },
    { enabled: open },
  );

  const candidates = React.useMemo(() => {
    const items = list.data?.items ?? [];
    const needle = search.trim().toLowerCase();
    if (needle === '') return items;
    return items.filter((entry) => entry.subscription.displayName.toLowerCase().includes(needle));
  }, [list.data, search]);

  React.useEffect(() => {
    if (!open) {
      setSearch('');
      setChosen(null);
    }
  }, [open]);

  const proposedName = item.merchantName ?? item.detection.normalizedKey;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Merge with an existing subscription</DialogTitle>
          <DialogDescription>
            The charges behind “{proposedName}” move to the subscription you pick. Nothing new is
            created.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-[var(--gap-loose)]">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-3"
            />
            <Input
              value={search}
              placeholder="Search your subscriptions"
              aria-label="Search your subscriptions"
              className="pl-8"
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </div>

          {list.isPending ? (
            <div className="flex flex-col gap-1.5">
              {[0, 1, 2, 3].map((row) => (
                <Skeleton key={row} className="h-10 w-full" />
              ))}
            </div>
          ) : list.error !== null ? (
            <p role="alert" className="text-xs text-text-2">
              Could not load your subscriptions. {list.error.message}
            </p>
          ) : candidates.length === 0 ? (
            <EmptyState>
              {search === ''
                ? 'You have no subscriptions to merge into yet. Confirm this suggestion instead.'
                : `Nothing matches “${search}”.`}
            </EmptyState>
          ) : (
            <ul
              role="radiogroup"
              aria-label="Existing subscriptions"
              className="max-h-72 overflow-y-auto rounded-md border border-line"
            >
              {candidates.map((entry) => {
                const subscription = entry.subscription;
                const active = chosen === subscription.id;
                return (
                  <li key={subscription.id}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => {
                        setChosen(subscription.id);
                      }}
                      className={cn(
                        'flex w-full items-center gap-2.5 border-b border-line px-[var(--pad-card)] py-2 text-left last:border-b-0',
                        'transition-colors duration-[var(--duration-fast)] ease-standard hover:bg-ink-700',
                        focusRing,
                        active && 'bg-ink-600',
                      )}
                    >
                      <MerchantMark
                        name={subscription.displayName}
                        logoUrl={entry.merchantLogo}
                        size="sm"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[0.8125rem] text-text">
                          {subscription.displayName}
                        </span>
                        <span className="block text-[0.6875rem] text-text-3">
                          {intervalLabel(
                            interval(subscription.intervalUnit, subscription.intervalCount),
                          )}
                        </span>
                      </span>
                      <Money
                        amountMinor={subscription.amountMinor}
                        currency={subscription.currency}
                        tone="outflow"
                        size="sm"
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogBody>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={chosen === null}
            loading={pending}
            onClick={() => {
              if (chosen !== null) onSubmit(chosen);
            }}
          >
            Merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── money helpers ────────────────────────────────────────────────────────────────────────

/** The exact decimal string for an amount, built by integer division in core — never `/ 100`. */
function decimalOf(amountMinor: number, currency: string): string {
  try {
    return toDecimalString(money(amountMinor, currency));
  } catch {
    return '';
  }
}

/** Minor units, or null when the text is not an amount. `parseMoney` never sees a float. */
function tryParseMinor(raw: string, currency: string): number | null {
  if (raw.trim() === '') return null;
  try {
    return parseMoney(raw, currency).amountMinor;
  } catch {
    return null;
  }
}
