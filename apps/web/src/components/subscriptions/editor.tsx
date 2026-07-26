'use client';

/**
 * The create / edit sheet.
 *
 * The one rule this form exists to enforce: **the amount the user types never becomes a float.**
 * It is held as the string they typed, validated by handing it to `parseMoney`, and converted to
 * integer minor units exactly once, on submit. So "12.99", "12,99", "£12.99" and "1,299.00" all
 * work, and none of them can arrive at the server as 1298.9999999999998.
 *
 * The live preview is the second reason this is a sheet and not a modal: cadence, anchor date
 * and amount together decide when money leaves, and a user setting an annual plan should see
 * "Next charge: 14 Aug 2026 · £119.88/yr" while they are still choosing, not after they save.
 */

import * as React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CalendarClock } from 'lucide-react';
import {
  BILLING_CHANNELS,
  BILLING_CHANNEL_LABELS,
  CATEGORIES,
  CATEGORY_LABELS,
  INTERVAL_PRESETS,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_LABELS,
  type IntervalUnit,
  type PlainDate,
  formatPlainDate,
  fromInstant,
  interval,
  money,
  nextOccurrenceAfter,
  parseMoney,
  parsePlainDate,
  toDecimalString,
  toInstant,
} from '@ledger/core';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  cn,
  toast,
} from '@ledger/ui';
import { api } from '~/lib/trpc';
import { annualCostLabel, formatDay, todayIn } from '~/lib/format';

/** Radix Select has no concept of an empty value, so "none" needs a token of its own. */
const NO_PAYMENT_METHOD = '__none__';
const CUSTOM_CADENCE = 'custom';

const INTERVAL_UNITS: readonly IntervalUnit[] = ['day', 'week', 'month', 'year'];

const formSchema = z
  .object({
    displayName: z.string().trim().min(1, 'Give it a name.').max(120),
    /** Kept as the raw string. `parseMoney` is the validator; see the superRefine below. */
    amount: z.string().min(1, 'Enter an amount.'),
    currency: z.string().length(3),
    intervalUnit: z.enum(['day', 'week', 'month', 'year']),
    intervalCount: z.coerce.number().int().min(1, 'At least 1.').max(365, 'At most 365.'),
    anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date.'),
    status: z.enum(SUBSCRIPTION_STATUSES),
    category: z.enum(CATEGORIES),
    billingChannel: z.enum(BILLING_CHANNELS),
    paymentMethodId: z.string(),
    trialEndsAt: z.string(),
    autoRenew: z.boolean(),
    variableAmount: z.boolean(),
    notes: z.string().max(4000),
    url: z.string(),
    tags: z.string(),
  })
  .superRefine((values, ctx) => {
    try {
      parseMoney(values.amount, values.currency);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: 'That is not an amount we can read.',
      });
    }

    try {
      parsePlainDate(values.anchorDate);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['anchorDate'], message: 'That date does not exist.' });
    }

    if (values.url.trim() !== '') {
      try {
        new URL(values.url.trim());
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'Include the https:// part.' });
      }
    }

    if (values.status === 'trialing' && values.trialEndsAt === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['trialEndsAt'],
        message: 'A trial needs an end date — that is the date the alert fires against.',
      });
    }
  });

type FormValues = z.infer<typeof formSchema>;

export interface SubscriptionEditorProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Null creates a new subscription; an id loads that one for editing. */
  readonly subscriptionId: string | null;
}

export function SubscriptionEditor({
  open,
  onOpenChange,
  subscriptionId,
}: SubscriptionEditorProps): React.ReactElement {
  const utils = api.useUtils();
  const me = api.me.current.useQuery();
  const paymentMethods = api.paymentMethods.list.useQuery({ includeArchived: false });
  const existing = api.subscriptions.byId.useQuery(
    { id: subscriptionId ?? '' },
    { enabled: subscriptionId !== null },
  );

  const locale = me.data?.locale ?? 'en-GB';
  const timezone = me.data?.timezone ?? 'UTC';
  const today = React.useMemo(() => todayIn(timezone), [timezone]);
  const todayIso = formatPlainDate(today);
  const displayCurrency = me.data?.displayCurrency ?? 'GBP';

  const defaults = React.useMemo<FormValues>(
    () => ({
      displayName: '',
      amount: '',
      currency: displayCurrency,
      intervalUnit: 'month',
      intervalCount: 1,
      anchorDate: todayIso,
      status: 'active',
      category: 'other',
      billingChannel: 'direct',
      paymentMethodId: NO_PAYMENT_METHOD,
      trialEndsAt: '',
      autoRenew: true,
      variableAmount: false,
      notes: '',
      url: '',
      tags: '',
    }),
    [displayCurrency, todayIso],
  );

  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: defaults });
  const { control, formState, handleSubmit, register, reset, watch } = form;

  // `me.current` usually resolves after this mounts, and the user's display currency is one of
  // the defaults. Re-seeding only while the form is untouched picks the right currency up
  // without ever overwriting something the user has already typed.
  React.useEffect(() => {
    if (subscriptionId !== null || formState.isDirty) return;
    reset(defaults);
  }, [defaults, formState.isDirty, reset, subscriptionId]);

  // Load an existing subscription into the form once its row arrives.
  React.useEffect(() => {
    const row = existing.data?.subscription;
    if (row === undefined) return;
    reset({
      displayName: row.displayName,
      amount: minorToInput(row.amountMinor, row.currency),
      currency: row.currency,
      intervalUnit: row.intervalUnit,
      intervalCount: row.intervalCount,
      anchorDate: row.anchorDate,
      status: row.status,
      category: row.category,
      billingChannel: row.billingChannel,
      paymentMethodId: row.paymentMethodId ?? NO_PAYMENT_METHOD,
      trialEndsAt: row.trialEndsAt === null ? '' : formatPlainDate(instantToPlain(row.trialEndsAt, timezone)),
      autoRenew: row.autoRenew,
      variableAmount: row.variableAmount,
      notes: row.notes ?? '',
      url: row.url ?? '',
      tags: row.tags.join(', '),
    });
  }, [existing.data, reset, timezone]);

  async function refresh(): Promise<void> {
    await utils.subscriptions.list.invalidate();
    await utils.dashboard.totals.invalidate();
    if (subscriptionId !== null) await utils.subscriptions.byId.invalidate({ id: subscriptionId });
  }

  const create = api.subscriptions.create.useMutation({
    onSuccess: async (row) => {
      await refresh();
      toast.success(`${row.displayName} added.`);
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error('Could not save that.', { description: error.message });
    },
  });

  const update = api.subscriptions.update.useMutation({
    onSuccess: async (row) => {
      await refresh();
      toast.success(`${row.displayName} saved.`);
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error('Could not save that.', { description: error.message });
    },
  });

  const onSubmit = handleSubmit((values) => {
    const parsed = parseMoney(values.amount, values.currency);
    const tags = values.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '')
      .slice(0, 20);

    const payload = {
      displayName: values.displayName.trim(),
      amountMinor: parsed.amountMinor,
      currency: values.currency.toUpperCase(),
      intervalUnit: values.intervalUnit,
      intervalCount: values.intervalCount,
      anchorDate: values.anchorDate,
      status: values.status,
      category: values.category,
      billingChannel: values.billingChannel,
      paymentMethodId: values.paymentMethodId === NO_PAYMENT_METHOD ? null : values.paymentMethodId,
      // 09:00 local, the same hour the renewal projector uses — a trial that "ends on the 14th"
      // should not expire at midnight on the 13th for anyone east of UTC.
      trialEndsAt:
        values.trialEndsAt === '' ? null : toInstant(parsePlainDate(values.trialEndsAt), timezone, 9),
      autoRenew: values.autoRenew,
      variableAmount: values.variableAmount,
      notes: values.notes.trim() === '' ? null : values.notes.trim(),
      url: values.url.trim() === '' ? null : values.url.trim(),
      tags,
    };

    if (subscriptionId === null) create.mutate(payload);
    else update.mutate({ id: subscriptionId, patch: payload });
  });

  // ── live preview ─────────────────────────────────────────────────────────────────────
  const watched = watch();
  const preview = buildPreview({
    amount: watched.amount,
    currency: watched.currency,
    unit: watched.intervalUnit,
    count: watched.intervalCount,
    anchorDate: watched.anchorDate,
    today,
    locale,
  });

  const cadenceKey = `${watched.intervalUnit}:${String(watched.intervalCount)}`;
  const isPresetCadence = INTERVAL_PRESETS.some(
    (preset) => `${preset.interval.unit}:${String(preset.interval.count)}` === cadenceKey,
  );
  // While an existing row is still in flight the form is showing blank defaults, and submitting
  // those would overwrite the subscription with them.
  const loadingExisting = subscriptionId !== null && existing.isPending;
  const busy = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        A right-hand sheet rather than a centred modal: the table stays visible behind it, so a
        user editing one row keeps the context of the rows around it.
      */}
      <DialogContent className="left-auto right-0 top-0 h-dvh max-h-dvh w-full max-w-md translate-x-0 translate-y-0 rounded-none border-y-0 border-r-0">
        <DialogHeader>
          <DialogTitle>{subscriptionId === null ? 'Add subscription' : 'Edit subscription'}</DialogTitle>
        </DialogHeader>

        <DialogBody>
          <form
            id="subscription-form"
            // `handleSubmit` returns a promise; the DOM handler must not, so it is discarded
            // here rather than left to float into an unhandled rejection.
            onSubmit={(event) => {
              void onSubmit(event);
            }}
            className="flex flex-col gap-[var(--gap-loose)]"
          >
            <Field label="Name" required error={formState.errors.displayName?.message}>
              <Input
                {...register('displayName')}
                autoFocus
                placeholder="Netflix"
                aria-invalid={formState.errors.displayName !== undefined}
              />
            </Field>

            <div className="grid grid-cols-[1fr_6.5rem] gap-[var(--gap-tight)]">
              <Field label="Amount" required error={formState.errors.amount?.message}>
                <Input
                  {...register('amount')}
                  mono
                  inputMode="decimal"
                  placeholder="12.99"
                  aria-invalid={formState.errors.amount !== undefined}
                />
              </Field>
              <Field label="Currency" required error={formState.errors.currency?.message}>
                <Input {...register('currency')} mono maxLength={3} className="uppercase" placeholder="GBP" />
              </Field>
            </div>

            <Field label="Cadence" required error={formState.errors.intervalCount?.message}>
              <Select
                value={isPresetCadence ? cadenceKey : CUSTOM_CADENCE}
                onValueChange={(value) => {
                  if (value === CUSTOM_CADENCE) {
                    form.setValue('intervalUnit', 'month');
                    form.setValue('intervalCount', 2);
                    return;
                  }
                  const [unit, count] = value.split(':');
                  if (unit === undefined || count === undefined) return;
                  form.setValue('intervalUnit', unit as IntervalUnit);
                  form.setValue('intervalCount', Number(count));
                }}
              >
                <SelectTrigger aria-label="Cadence">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERVAL_PRESETS.map((preset) => (
                    <SelectItem
                      key={`${preset.interval.unit}:${String(preset.interval.count)}`}
                      value={`${preset.interval.unit}:${String(preset.interval.count)}`}
                    >
                      {preset.label}
                    </SelectItem>
                  ))}
                  <SelectItem value={CUSTOM_CADENCE}>Custom…</SelectItem>
                </SelectContent>
              </Select>

              {isPresetCadence ? null : (
                <div className="mt-1.5 grid grid-cols-[5rem_1fr] gap-[var(--gap-tight)]">
                  <Input
                    {...register('intervalCount')}
                    mono
                    type="number"
                    min={1}
                    max={365}
                    aria-label="Every how many"
                  />
                  <Controller
                    control={control}
                    name="intervalUnit"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger aria-label="Interval unit">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {INTERVAL_UNITS.map((unit) => (
                            <SelectItem key={unit} value={unit}>
                              {unit}s
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
              )}
            </Field>

            <Field
              label="Anchor date"
              required
              error={formState.errors.anchorDate?.message}
              hint="The date the cadence is measured from. Every renewal is projected from here, so a subscription anchored on the 31st stays on the 31st."
            >
              <Input {...register('anchorDate')} mono type="date" aria-invalid={formState.errors.anchorDate !== undefined} />
            </Field>

            {/* The preview: what the two fields above actually mean in dates and money. */}
            <div className="flex items-start gap-2 rounded-md border border-line bg-ink-700 px-[var(--pad-card)] py-2">
              <CalendarClock className="mt-0.5 size-3.5 shrink-0 text-outflow" aria-hidden />
              <p className="text-xs text-text-2" aria-live="polite">
                {preview === null ? (
                  'Fill in an amount, a cadence and an anchor date to see the next charge.'
                ) : (
                  <>
                    <span className="text-text">Next charge: {preview.nextCharge}</span>
                    <span className="text-text-3"> · </span>
                    <span className="font-mono text-outflow">{preview.annual}</span>
                  </>
                )}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-[var(--gap-tight)]">
              <Field label="Status">
                <Controller
                  control={control}
                  name="status"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger aria-label="Status">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SUBSCRIPTION_STATUSES.map((status) => (
                          <SelectItem key={status} value={status}>
                            {SUBSCRIPTION_STATUS_LABELS[status]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>

              <Field label="Category">
                <Controller
                  control={control}
                  name="category"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger aria-label="Category">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CATEGORIES.map((category) => (
                          <SelectItem key={category} value={category}>
                            {CATEGORY_LABELS[category]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
            </div>

            <Field
              label="Billing channel"
              hint="Who takes the money. An App Store subscription cannot be cancelled on the provider's website, and this is the field that decides which exit we show you."
            >
              <Controller
                control={control}
                name="billingChannel"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger aria-label="Billing channel">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BILLING_CHANNELS.map((channel) => (
                        <SelectItem key={channel} value={channel}>
                          {BILLING_CHANNEL_LABELS[channel]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>

            <Field label="Payment method">
              <Controller
                control={control}
                name="paymentMethodId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger aria-label="Payment method">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_PAYMENT_METHOD}>Not set</SelectItem>
                      {(paymentMethods.data ?? []).map((method) => (
                        <SelectItem key={method.id} value={method.id}>
                          {method.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>

            <Field label="Trial ends" error={formState.errors.trialEndsAt?.message}>
              <Input {...register('trialEndsAt')} mono type="date" />
            </Field>

            <div className="flex flex-col gap-[var(--gap-tight)]">
              <ToggleRow
                control={control}
                name="autoRenew"
                label="Renews automatically"
                hint="Off means it lapses on its own."
              />
              <ToggleRow
                control={control}
                name="variableAmount"
                label="Amount varies"
                hint="Utilities and usage-based plans. The figure shown is the median, not a promise."
              />
            </div>

            <Field label="Website" error={formState.errors.url?.message}>
              <Input {...register('url')} type="url" placeholder="https://netflix.com/account" />
            </Field>

            <Field label="Tags" hint="Comma separated.">
              <Input {...register('tags')} placeholder="work, shared" />
            </Field>

            <Field label="Notes">
              <Textarea {...register('notes')} rows={3} placeholder="Shared with Sam. Cancel before the trip." />
            </Field>
          </form>
        </DialogBody>

        <DialogFooter>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="subscription-form"
            size="sm"
            variant="primary"
            loading={busy}
            disabled={loadingExisting}
          >
            {subscriptionId === null ? 'Add subscription' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── preview ──────────────────────────────────────────────────────────────────────────────

interface PreviewInput {
  readonly amount: string;
  readonly currency: string;
  readonly unit: IntervalUnit;
  readonly count: number;
  readonly anchorDate: string;
  readonly today: PlainDate;
  readonly locale: string;
}

/**
 * "Next charge: 14 Aug 2026 · £119.88/yr".
 *
 * Both halves come from core: the date from `nextOccurrenceAfter`, projected from the anchor
 * rather than stepped from today, and the money from `annualEquivalent`, which applies the
 * cadence as an exact rational and rounds once.
 */
function buildPreview(
  input: PreviewInput,
): { readonly nextCharge: string; readonly annual: string } | null {
  try {
    const cadence = interval(input.unit, input.count);
    const anchor = parsePlainDate(input.anchorDate);
    const next = nextOccurrenceAfter(anchor, cadence, input.today);
    const parsed = parseMoney(input.amount, input.currency);
    const annual = annualCostLabel(parsed.amountMinor, parsed.currency, cadence, input.locale);
    if (annual === null) return null;
    return { nextCharge: formatDay(next, input.locale), annual };
  } catch {
    // A half-typed amount or an impossible date is the normal state of a form mid-keystroke.
    return null;
  }
}

/**
 * Minor units back into something a person can edit: "1299" → "12.99".
 *
 * `toDecimalString` builds the string by integer division and padding, so the value in the field
 * is exactly the value in the database — no float round-trip on the way to the input.
 */
function minorToInput(amountMinor: number, currencyCode: string): string {
  try {
    return toDecimalString(money(amountMinor, currencyCode));
  } catch {
    return '';
  }
}

/**
 * A timestamptz back into the calendar date the user thinks it is.
 *
 * Deliberately not `toISOString().slice(0, 10)`: that is UTC, and a trial ending at 23:00 local
 * on the 13th is not a trial ending on the 14th.
 */
function instantToPlain(value: Date, timezone: string): PlainDate {
  return fromInstant(value, timezone);
}

// ── small form pieces ────────────────────────────────────────────────────────────────────

interface FieldProps {
  readonly label: string;
  readonly required?: boolean;
  readonly error?: string | undefined;
  readonly hint?: string;
  readonly children: React.ReactNode;
}

function Field({ label, required = false, error, hint, children }: FieldProps): React.ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label required={required}>{label}</Label>
      {children}
      {hint === undefined ? null : <p className="text-[0.6875rem] leading-tight text-text-3">{hint}</p>}
      {error === undefined ? null : (
        <p role="alert" className="text-[0.6875rem] leading-tight text-alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface ToggleRowProps {
  readonly control: ReturnType<typeof useForm<FormValues>>['control'];
  readonly name: 'autoRenew' | 'variableAmount';
  readonly label: string;
  readonly hint: string;
}

function ToggleRow({ control, name, label, hint }: ToggleRowProps): React.ReactElement {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <label className={cn('flex cursor-pointer items-start gap-2 rounded-md border border-line bg-ink-700 p-[var(--pad-card)]')}>
          <Switch checked={field.value} onCheckedChange={field.onChange} />
          <span className="min-w-0">
            <span className="block text-[0.8125rem] text-text">{label}</span>
            <span className="block text-[0.6875rem] leading-tight text-text-3">{hint}</span>
          </span>
        </label>
      )}
    />
  );
}
