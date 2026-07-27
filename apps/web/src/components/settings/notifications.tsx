'use client';

import * as React from 'react';
import { BellOff, Smartphone } from 'lucide-react';
import {
  DEFAULT_LEAD_TIME_DAYS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  type NotificationChannel,
  type NotificationType,
  ignoresQuietHours,
  money,
  parseMoney,
  toDecimalString,
} from '@ledger/core';
import {
  Badge,
  Button,
  Checkbox,
  Input,
  Label,
  Money,
  Panel,
  PanelBody,
  PanelHeader,
  Skeleton,
  Switch,
  cn,
  toast,
} from '@ledger/ui';
import { api } from '~/lib/trpc';
import { formatInstant } from '~/lib/format';
import { LoadError } from '../dashboard/states';

/**
 * Notification preferences.
 *
 * Every type is listed whether or not the user has ever touched it, because a preferences screen
 * that shows only what has been changed is a screen where the defaults are invisible. The
 * defaults come from `DEFAULT_LEAD_TIME_DAYS` in @ledger/core — the same table the scheduler
 * reads — so this screen cannot advertise a default the worker does not honour.
 *
 * Quiet hours are stored as minutes from local midnight rather than as an instant. That is a
 * wall-clock statement: "not before 08:00" stays true through daylight saving and through
 * travel, which is exactly what a person means when they say it.
 */

const TYPE_COPY: Readonly<Record<NotificationType, { title: string; detail: string }>> = {
  trial_ending: {
    title: 'A trial is about to convert',
    detail: 'The moment a free trial turns into a charge is the one worth catching.',
  },
  renewal_upcoming: {
    title: 'A renewal is coming',
    detail: 'Only for amounts over the threshold below, so the small ones stay quiet.',
  },
  price_changed: {
    title: 'A price changed',
    detail: 'Raised without asking you, or dropped. Both are worth knowing.',
  },
  cancel_by_deadline: {
    title: 'A cancel-by date is approaching',
    detail: 'The last day you can act before the next charge goes through.',
  },
  cancellation_unconfirmed: {
    title: 'A cancellation has gone quiet',
    detail: 'You told the provider and nothing came back. Time to chase.',
  },
  charged_after_cancellation: {
    title: 'You were charged after cancelling',
    detail: 'The one alert that ignores quiet hours — dispute windows are short.',
  },
  new_detections: {
    title: 'New subscriptions detected',
    detail: 'Charges the engine thinks are recurring, waiting in the review queue.',
  },
  sync_failed: {
    title: 'A bank sync failed',
    detail: 'Nothing new is arriving until it is fixed.',
  },
  consent_expiring: {
    title: 'Bank consent is expiring',
    detail: 'Reconnect before it lapses and nothing breaks.',
  },
  duplicate_detected: {
    title: 'You appear to be paying twice',
    detail: 'Two subscriptions to the same thing, or the same one on two cards.',
  },
};

const CHANNEL_LABELS: Readonly<Record<NotificationChannel, string>> = {
  email: 'Email',
  push: 'Push',
  in_app: 'In app',
};

const DAY_NAMES: readonly string[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

interface TypeState {
  readonly type: NotificationType;
  readonly channels: readonly NotificationChannel[];
  readonly leadTimeDays: number;
}

interface SettingsState {
  readonly quietHoursEnabled: boolean;
  readonly quietHoursStartMinute: number;
  readonly quietHoursEndMinute: number;
  readonly digestDayOfWeek: number;
  readonly digestMinute: number;
  readonly renewalAlertThresholdMinor: number;
}

export function NotificationSettings({
  locale,
  currency,
}: {
  readonly locale: string;
  readonly currency: string;
}): React.ReactNode {
  const utils = api.useUtils();
  const preferences = api.notifications.preferences.useQuery();

  const [types, setTypes] = React.useState<readonly TypeState[] | null>(null);
  const [settings, setSettings] = React.useState<SettingsState | null>(null);
  const [threshold, setThreshold] = React.useState('');

  const loaded = preferences.data;

  React.useEffect(() => {
    if (loaded === undefined || types !== null) return;
    setTypes(
      loaded.types.map((entry) => ({
        type: entry.type,
        channels: entry.channels,
        leadTimeDays: entry.leadTimeDays,
      })),
    );
    setSettings(loaded.settings);
    setThreshold(minorToDecimal(loaded.settings.renewalAlertThresholdMinor, currency));
  }, [loaded, types, currency]);

  const save = api.notifications.updatePreferences.useMutation({
    onSuccess: async () => {
      toast.success('Saved.');
      await utils.notifications.preferences.invalidate();
    },
    onError: (error) => {
      toast.error('Could not save that.', { description: error.message });
    },
  });

  if (preferences.error !== null) {
    return (
      <LoadError
        what="your notification preferences"
        error={preferences.error}
        retrying={preferences.isFetching}
        onRetry={() => {
          void preferences.refetch();
        }}
      />
    );
  }

  if (preferences.isPending || types === null || settings === null) {
    return (
      <Panel>
        <PanelHeader eyebrow="Notifications" />
        <PanelBody className="flex flex-col gap-1.5">
          {NOTIFICATION_TYPES.map((type) => (
            <Skeleton key={type} className="h-16 w-full" />
          ))}
        </PanelBody>
      </Panel>
    );
  }

  const thresholdMinor = tryParseMinor(threshold, currency);
  const thresholdInvalid = threshold.trim() !== '' && thresholdMinor === null;

  function updateType(type: NotificationType, patch: Partial<TypeState>): void {
    setTypes((current) =>
      current === null
        ? current
        : current.map((entry) => (entry.type === type ? { ...entry, ...patch } : entry)),
    );
  }

  function submit(): void {
    if (types === null || settings === null || thresholdInvalid) return;
    save.mutate({
      types: types.map((entry) => ({
        type: entry.type,
        channels: [...entry.channels],
        leadTimeDays: entry.leadTimeDays,
      })),
      settings: {
        ...settings,
        renewalAlertThresholdMinor: thresholdMinor ?? settings.renewalAlertThresholdMinor,
      },
    });
  }

  return (
    <div className="flex flex-col gap-[var(--gap-loose)]">
      <Panel>
        <PanelHeader
          eyebrow="What we tell you about"
          actions={
            <Button variant="primary" size="sm" loading={save.isPending} onClick={submit}>
              Save
            </Button>
          }
        >
          Pick the channels, and how far ahead. An empty row means we never mention it — a valid
          choice, so nothing here forces one on you.
        </PanelHeader>

        <PanelBody className="flex flex-col gap-[var(--gap-tight)]">
          {types.map((entry) => {
            const copy = TYPE_COPY[entry.type];
            const usesLeadTime = DEFAULT_LEAD_TIME_DAYS[entry.type] > 0;
            const silent = entry.channels.length === 0;

            return (
              <div
                key={entry.type}
                className={cn(
                  'rounded-md border border-line bg-ink-700 p-[var(--pad-card)]',
                  silent && 'opacity-70',
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-[var(--gap)]">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-[0.8125rem] text-text">
                      {copy.title}
                      {ignoresQuietHours(entry.type) ? (
                        <Badge tone="alert">Ignores quiet hours</Badge>
                      ) : null}
                      {silent ? (
                        <Badge tone="neutral">
                          <BellOff className="size-3" aria-hidden />
                          Off
                        </Badge>
                      ) : null}
                    </p>
                    <p className="mt-1 text-xs text-text-2">{copy.detail}</p>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-[var(--gap-loose)]">
                    <fieldset className="flex items-center gap-[var(--gap-tight)]">
                      <legend className="sr-only">Channels for {copy.title}</legend>
                      {NOTIFICATION_CHANNELS.map((channel) => {
                        const id = `${entry.type}-${channel}`;
                        const on = entry.channels.includes(channel);
                        return (
                          <label
                            key={channel}
                            htmlFor={id}
                            className="flex cursor-pointer items-center gap-1.5 text-[0.6875rem] text-text-2"
                          >
                            <Checkbox
                              id={id}
                              checked={on}
                              onCheckedChange={(value) => {
                                updateType(entry.type, {
                                  channels:
                                    value === true
                                      ? [...entry.channels, channel]
                                      : entry.channels.filter((item) => item !== channel),
                                });
                              }}
                            />
                            {CHANNEL_LABELS[channel]}
                          </label>
                        );
                      })}
                    </fieldset>

                    {usesLeadTime ? (
                      <label
                        htmlFor={`${entry.type}-lead`}
                        className="flex items-center gap-1.5 text-[0.6875rem] text-text-2"
                      >
                        <Input
                          id={`${entry.type}-lead`}
                          mono
                          inputMode="numeric"
                          className="h-7 w-14 text-center"
                          value={String(entry.leadTimeDays)}
                          onChange={(event) => {
                            const parsed = Number.parseInt(event.target.value, 10);
                            updateType(entry.type, {
                              leadTimeDays: Number.isInteger(parsed)
                                ? Math.max(0, Math.min(90, parsed))
                                : 0,
                            });
                          }}
                        />
                        days ahead
                      </label>
                    ) : (
                      <span className="text-[0.6875rem] text-text-3">As it happens</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader eyebrow="Quiet hours and digest">
          When we are allowed to reach you, and when the weekly summary lands.
        </PanelHeader>
        <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
          <label className="flex items-center justify-between gap-[var(--gap)]">
            <span className="min-w-0">
              <span className="block text-[0.8125rem] text-text">Hold notifications overnight</span>
              <span className="block text-xs text-text-2">
                Anything scheduled inside the window waits until it closes. Being charged after
                cancelling is the one exception.
              </span>
            </span>
            <Switch
              checked={settings.quietHoursEnabled}
              onCheckedChange={(next) => {
                setSettings({ ...settings, quietHoursEnabled: next });
              }}
              aria-label="Hold notifications overnight"
            />
          </label>

          {settings.quietHoursEnabled ? (
            <div className="grid gap-[var(--gap-loose)] sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="quiet-start">Quiet from</Label>
                <Input
                  id="quiet-start"
                  type="time"
                  mono
                  value={minuteToTime(settings.quietHoursStartMinute)}
                  onChange={(event) => {
                    setSettings({
                      ...settings,
                      quietHoursStartMinute: timeToMinute(
                        event.target.value,
                        settings.quietHoursStartMinute,
                      ),
                    });
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="quiet-end">Quiet until</Label>
                <Input
                  id="quiet-end"
                  type="time"
                  mono
                  value={minuteToTime(settings.quietHoursEndMinute)}
                  onChange={(event) => {
                    setSettings({
                      ...settings,
                      quietHoursEndMinute: timeToMinute(
                        event.target.value,
                        settings.quietHoursEndMinute,
                      ),
                    });
                  }}
                />
              </div>
            </div>
          ) : null}

          <div className="grid gap-[var(--gap-loose)] sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="digest-day">Weekly digest day</Label>
              <select
                id="digest-day"
                value={settings.digestDayOfWeek}
                onChange={(event) => {
                  setSettings({
                    ...settings,
                    digestDayOfWeek: Number.parseInt(event.target.value, 10),
                  });
                }}
                className={cn(
                  'h-9 w-full rounded-md border border-line-strong bg-ink-900 px-2.5 text-sm text-text',
                  'transition-[border-color] duration-[var(--duration-fast)] ease-standard hover:border-line-hot',
                  'focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none',
                )}
              >
                {DAY_NAMES.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="digest-time">Digest time</Label>
              <Input
                id="digest-time"
                type="time"
                mono
                value={minuteToTime(settings.digestMinute)}
                onChange={(event) => {
                  setSettings({
                    ...settings,
                    digestMinute: timeToMinute(event.target.value, settings.digestMinute),
                  });
                }}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="renewal-threshold">Only warn about renewals over</Label>
            <Input
              id="renewal-threshold"
              mono
              inputMode="decimal"
              className="max-w-40"
              value={threshold}
              aria-invalid={thresholdInvalid}
              onChange={(event) => {
                setThreshold(event.target.value);
              }}
            />
            <p className="text-[0.6875rem] text-text-3">
              {thresholdInvalid ? (
                <span className="text-alert">Enter an amount like 20.00.</span>
              ) : thresholdMinor === null ? (
                <>Amounts in {currency}.</>
              ) : (
                <>
                  Renewals under{' '}
                  <Money amountMinor={thresholdMinor} currency={currency} size="sm" locale={locale} />{' '}
                  pass without a word.
                </>
              )}
            </p>
          </div>

          <div>
            <Button variant="primary" size="sm" loading={save.isPending} onClick={submit}>
              Save
            </Button>
          </div>
        </PanelBody>
      </Panel>

      <PushDevices locale={locale} />
    </div>
  );
}

/** Registered push endpoints, so someone can see what they signed up and turn one off. */
function PushDevices({ locale }: { readonly locale: string }): React.ReactNode {
  const utils = api.useUtils();
  const me = api.me.current.useQuery();
  const devices = api.notifications.devices.useQuery();

  const unregister = api.notifications.unregisterPush.useMutation({
    onSuccess: async () => {
      toast.success('That device will not get push notifications any more.');
      await utils.notifications.devices.invalidate();
    },
    onError: (error) => {
      toast.error('Could not remove that device.', { description: error.message });
    },
  });

  const timezone = me.data?.timezone ?? 'UTC';

  return (
    <Panel>
      <PanelHeader eyebrow="Push devices">
        Browsers you have allowed to send you notifications.
      </PanelHeader>

      {devices.error !== null ? (
        <PanelBody>
          <LoadError
            what="your push devices"
            error={devices.error}
            retrying={devices.isFetching}
            onRetry={() => {
              void devices.refetch();
            }}
          />
        </PanelBody>
      ) : devices.isPending ? (
        <PanelBody className="flex flex-col gap-1.5">
          {[0, 1].map((row) => (
            <Skeleton key={row} className="h-12 w-full" />
          ))}
        </PanelBody>
      ) : devices.data.length === 0 ? (
        <PanelBody>
          <p className="text-sm text-text-2">
            No devices registered. Push has to be allowed by the browser itself, from the device
            you want the notifications on.
          </p>
        </PanelBody>
      ) : (
        <PanelBody className="flex flex-col gap-1.5">
          {devices.data.map((device) => (
            <div
              key={device.id}
              className="flex flex-wrap items-center justify-between gap-[var(--gap)] rounded-md border border-line bg-ink-700 px-[var(--pad-card)] py-2.5"
            >
              <div className="flex min-w-0 items-start gap-2.5">
                <Smartphone className="mt-0.5 size-4 shrink-0 text-text-3" aria-hidden />
                <div className="min-w-0">
                  <p className="truncate text-[0.8125rem] text-text">
                    {device.userAgent ?? 'Unknown browser'}
                  </p>
                  <p className="text-[0.6875rem] text-text-3">
                    Registered {formatInstant(device.createdAt, locale, timezone)}
                    {device.lastUsedAt === null
                      ? ''
                      : ` · last used ${formatInstant(device.lastUsedAt, locale, timezone)}`}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                loading={unregister.isPending}
                onClick={() => {
                  unregister.mutate({ endpoint: device.endpoint });
                }}
              >
                Remove
              </Button>
            </div>
          ))}
        </PanelBody>
      )}
    </Panel>
  );
}

// ── minute ↔ wall clock ──────────────────────────────────────────────────────────────────

/** 1320 → "22:00". Minutes from local midnight, which is what the scheduler stores. */
function minuteToTime(minute: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.round(minute)));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** "22:00" → 1320. Falls back to the previous value rather than to zero on a half-typed time. */
function timeToMinute(value: string, fallback: number): number {
  const [hours, minutes] = value.split(':');
  const h = Number.parseInt(hours ?? '', 10);
  const m = Number.parseInt(minutes ?? '', 10);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return fallback;
  return Math.max(0, Math.min(1439, h * 60 + m));
}

function tryParseMinor(raw: string, currency: string): number | null {
  if (raw.trim() === '') return null;
  try {
    return parseMoney(raw, currency).amountMinor;
  } catch {
    return null;
  }
}

/**
 * Minor units to the exact decimal string for the field.
 *
 * `toDecimalString` builds it by integer division and string assembly in core, so a zero-decimal
 * currency like JPY does not get a phantom ".00" and nothing anywhere divides money by 100.
 */
function minorToDecimal(amountMinor: number, currency: string): string {
  try {
    return toDecimalString(money(amountMinor, currency));
  } catch {
    return '';
  }
}
