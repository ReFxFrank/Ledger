'use client';

import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus } from 'lucide-react';
import { z } from 'zod';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  INTERVAL_PRESETS,
  allCurrencies,
  formatPlainDate,
  fromInstant,
  parseMoney,
} from '@ledger/core';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@ledger/ui';
import { Field, FormError } from '~/components/auth/field';
import { api } from '~/lib/trpc';

/**
 * Add one subscription by hand.
 *
 * The whole product has to work for someone who will never connect a bank, and this form is
 * where that promise is either kept or broken. Six fields, all of them things a person can read
 * off a receipt, and nothing optional pretending to be required.
 */

/** `unit:count`, because a `<select>` value is a string and an interval is two facts. */
const INTERVAL_OPTIONS = INTERVAL_PRESETS.map((preset) => ({
  value: `${preset.interval.unit}:${String(preset.interval.count)}`,
  label: preset.label,
}));

const CURRENCIES = allCurrencies();

const schema = z.object({
  displayName: z.string().trim().min(1, 'Give it a name — whatever you call it is fine.').max(120),
  amount: z.string().min(1, 'Enter the amount you are charged.'),
  currency: z.string().length(3),
  interval: z.string().min(1),
  anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Pick a date.'),
  category: z.enum(CATEGORIES),
});

type Values = z.infer<typeof schema>;

export interface ManualSubscriptionFormProps {
  readonly defaultCurrency: string;
  readonly timezone: string;
  readonly onAdded: (name: string) => void;
}

export function ManualSubscriptionForm({
  defaultCurrency,
  timezone,
  onAdded,
}: ManualSubscriptionFormProps): ReactNode {
  const [formError, setFormError] = useState<string | null>(null);
  const utils = api.useUtils();

  // The user's own today, not the server's. Someone in Auckland adding a subscription at 09:00
  // should not see yesterday's date pre-filled.
  const today = formatPlainDate(fromInstant(new Date(), timezone));

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      displayName: '',
      amount: '',
      currency: defaultCurrency,
      interval: 'month:1',
      anchorDate: today,
      category: 'other',
    },
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });

  const create = api.subscriptions.create.useMutation({
    onSuccess: async (created) => {
      await utils.subscriptions.list.invalidate();
      await utils.dashboard.totals.invalidate();
      onAdded(created.displayName);
      toast(`${created.displayName} added.`);
      form.reset({
        displayName: '',
        amount: '',
        currency: form.getValues('currency'),
        interval: form.getValues('interval'),
        anchorDate: form.getValues('anchorDate'),
        category: 'other',
      });
      form.setFocus('displayName');
    },
    onError: (error) => {
      setFormError(error.message);
    },
  });

  function onSubmit(values: Values): void {
    setFormError(null);

    // Money never touches a float: `parseMoney` splits the decimal string and works in integers.
    // It throws on an unreadable amount, which is a field error rather than a form error.
    let amountMinor: number;
    try {
      amountMinor = parseMoney(values.amount, values.currency).amountMinor;
    } catch {
      form.setError('amount', {
        message: 'That is not an amount. Write it like 12.99, without a currency symbol.',
      });
      return;
    }

    if (amountMinor <= 0) {
      form.setError('amount', { message: 'Enter what you are charged — a number above zero.' });
      return;
    }

    const [unit, count] = values.interval.split(':');
    if (unit === undefined || count === undefined) {
      setFormError('That billing period is not one we know. Pick another.');
      return;
    }

    create.mutate({
      displayName: values.displayName.trim(),
      amountMinor,
      currency: values.currency,
      intervalUnit: unit as 'day' | 'week' | 'month' | 'year',
      intervalCount: Number(count),
      anchorDate: values.anchorDate,
      category: values.category,
      status: 'active',
      billingChannel: 'unknown',
      autoRenew: true,
      variableAmount: false,
      tags: [],
    });
  }

  return (
    <form
      className="flex flex-col gap-[var(--gap-loose)]"
      // `handleSubmit` hands back an async handler; the void keeps the DOM's void-returning
      // contract honest rather than leaving a floating promise on every submit.
      onSubmit={(event) => void form.handleSubmit(onSubmit)(event)}
      noValidate
    >
      <FormError>{formError}</FormError>

      <Field id="sub-name" label="Name" error={form.formState.errors.displayName?.message} required>
        {(control) => (
          <Input {...control} {...form.register('displayName')} placeholder="Netflix" autoComplete="off" />
        )}
      </Field>

      <div className="grid grid-cols-[1fr_7rem] gap-[var(--gap-tight)]">
        <Field id="sub-amount" label="Amount" error={form.formState.errors.amount?.message} required>
          {(control) => (
            <Input
              {...control}
              {...form.register('amount')}
              mono
              inputMode="decimal"
              placeholder="12.99"
              autoComplete="off"
            />
          )}
        </Field>

        <Field id="sub-currency" label="Currency">
          {(control) => (
            <Select
              value={form.watch('currency')}
              onValueChange={(value) => {
                form.setValue('currency', value, { shouldValidate: true });
              }}
            >
              <SelectTrigger id={control.id} aria-label="Currency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((definition) => (
                  <SelectItem key={definition.code} value={definition.code}>
                    <span className="font-mono">{definition.code}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      </div>

      <div className="grid gap-[var(--gap-tight)] sm:grid-cols-2">
        <Field id="sub-interval" label="Billing period">
          {(control) => (
            <Select
              value={form.watch('interval')}
              onValueChange={(value) => {
                form.setValue('interval', value, { shouldValidate: true });
              }}
            >
              <SelectTrigger id={control.id} aria-label="Billing period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERVAL_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>

        <Field
          id="sub-anchor"
          label="A date it charged"
          hint="Any past or upcoming charge date. Every renewal is projected from it."
          error={form.formState.errors.anchorDate?.message}
        >
          {(control) => <Input {...control} {...form.register('anchorDate')} type="date" mono />}
        </Field>
      </div>

      <Field id="sub-category" label="Category">
        {(control) => (
          <Select
            value={form.watch('category')}
            onValueChange={(value) => {
              form.setValue('category', value as Values['category'], { shouldValidate: true });
            }}
          >
            <SelectTrigger id={control.id} aria-label="Category">
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
      </Field>

      <Button type="submit" variant="primary" loading={create.isPending} className="self-start">
        <Plus aria-hidden className="size-4" strokeWidth={2} />
        Add subscription
      </Button>
    </form>
  );
}
