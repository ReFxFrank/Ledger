'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_LEAD_TIME_DAYS, type NotificationChannel, type NotificationType } from '@ledger/core';
import { Button, Checkbox, Input, Label, Skeleton, Switch, toast } from '@ledger/ui';
import { FormError } from '~/components/auth/field';
import { api } from '~/lib/trpc';

/**
 * Step three: what Ledger is allowed to interrupt you about.
 *
 * Four types, not ten. The rest keep their defaults and live in Settings — a preferences screen
 * shown to someone who has been using the product for ninety seconds is a screen they click
 * through, and a click-through is not a preference.
 *
 * Push is deliberately absent: it needs a service worker and a browser permission prompt, and
 * asking for one in the middle of setup is how people deny it permanently.
 */
const SHOWN: readonly { type: NotificationType; label: string; detail: string; hasLeadTime: boolean }[] = [
  {
    type: 'trial_ending',
    label: 'A trial is about to convert',
    detail: 'The one that costs money if you forget.',
    hasLeadTime: true,
  },
  {
    type: 'renewal_upcoming',
    label: 'A charge is coming',
    detail: 'Ahead of the renewal, while you can still act on it.',
    hasLeadTime: true,
  },
  {
    type: 'price_changed',
    label: 'A price changed',
    detail: 'Sent when a charge differs from the last one by more than 3%.',
    hasLeadTime: false,
  },
  {
    type: 'cancel_by_deadline',
    label: 'A cancel-by date is close',
    detail: 'For anything with a notice period you have to hit.',
    hasLeadTime: true,
  },
];

interface Draft {
  readonly email: boolean;
  readonly inApp: boolean;
  readonly leadTimeDays: number;
}

function toChannels(draft: Draft): NotificationChannel[] {
  const channels: NotificationChannel[] = [];
  if (draft.email) channels.push('email');
  if (draft.inApp) channels.push('in_app');
  return channels;
}

export function StepAlerts({ onFinish }: { readonly onFinish: () => void }): ReactNode {
  const preferences = api.notifications.preferences.useQuery();
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>> | null>(null);
  const [quietHours, setQuietHours] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Seeded once from the server so the switches start on the values the scheduler will actually
  // honour. Re-seeding on every render of the query would throw away edits mid-form.
  useEffect(() => {
    if (preferences.data === undefined || drafts !== null) return;
    const seeded: Record<string, Draft> = {};
    for (const entry of preferences.data.types) {
      seeded[entry.type] = {
        email: entry.channels.includes('email'),
        inApp: entry.channels.includes('in_app'),
        leadTimeDays: entry.leadTimeDays,
      };
    }
    setDrafts(seeded);
    setQuietHours(preferences.data.settings.quietHoursEnabled);
  }, [preferences.data, drafts]);

  const save = api.notifications.updatePreferences.useMutation({
    onSuccess: () => {
      toast('Alert preferences saved.');
      onFinish();
    },
    onError: (mutationError) => {
      setError(mutationError.message);
    },
  });

  if (preferences.isPending || drafts === null) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  function update(type: NotificationType, patch: Partial<Draft>): void {
    setDrafts((current) => {
      if (current === null) return current;
      const existing = current[type] ?? {
        email: true,
        inApp: true,
        leadTimeDays: DEFAULT_LEAD_TIME_DAYS[type],
      };
      return { ...current, [type]: { ...existing, ...patch } };
    });
  }

  function submit(): void {
    setError(null);
    const current = drafts;
    if (current === null) return;

    save.mutate({
      types: SHOWN.map((entry) => {
        const draft = current[entry.type] ?? {
          email: true,
          inApp: true,
          leadTimeDays: DEFAULT_LEAD_TIME_DAYS[entry.type],
        };
        return {
          type: entry.type,
          channels: toChannels(draft),
          leadTimeDays: entry.hasLeadTime ? draft.leadTimeDays : 0,
        };
      }),
      settings: { quietHoursEnabled: quietHours },
    });
  }

  return (
    <div className="flex flex-col gap-[var(--pad-card)]">
      <FormError>{error}</FormError>

      <p className="text-sm leading-relaxed text-text-2">
        Everything else keeps its default and can be changed in Settings.
      </p>

      <ul className="flex flex-col gap-1.5">
        {SHOWN.map((entry) => {
          const draft = drafts[entry.type] ?? {
            email: true,
            inApp: true,
            leadTimeDays: DEFAULT_LEAD_TIME_DAYS[entry.type],
          };
          return (
            <li
              key={entry.type}
              className="flex flex-wrap items-start justify-between gap-[var(--gap)] rounded-md border border-line bg-ink-700 p-[var(--pad-card)]"
            >
              <div className="min-w-40 flex-1">
                <p className="text-[0.8125rem] font-medium leading-tight text-text">{entry.label}</p>
                <p className="mt-0.5 text-xs leading-snug text-text-2">{entry.detail}</p>
              </div>

              <div className="flex flex-wrap items-center gap-[var(--gap-loose)]">
                {entry.hasLeadTime ? (
                  <div className="flex items-center gap-1.5">
                    <Input
                      id={`${entry.type}-lead`}
                      mono
                      type="number"
                      min={0}
                      max={90}
                      value={draft.leadTimeDays}
                      onChange={(event) => {
                        // Clamped here rather than trusted: the server rejects out-of-range and
                        // a form that lets you type 400 only to fail on submit is a waste.
                        const parsed = Number.parseInt(event.target.value, 10);
                        const next = Number.isNaN(parsed) ? 0 : Math.min(90, Math.max(0, parsed));
                        update(entry.type, { leadTimeDays: next });
                      }}
                      className="h-7 w-14 text-center"
                      aria-label={`Days of notice for: ${entry.label}`}
                    />
                    <Label htmlFor={`${entry.type}-lead`}>days ahead</Label>
                  </div>
                ) : null}

                <div className="flex items-center gap-1.5">
                  <Checkbox
                    id={`${entry.type}-email`}
                    checked={draft.email}
                    onCheckedChange={(next) => {
                      update(entry.type, { email: next === true });
                    }}
                  />
                  <Label htmlFor={`${entry.type}-email`}>Email</Label>
                </div>

                <div className="flex items-center gap-1.5">
                  <Checkbox
                    id={`${entry.type}-in-app`}
                    checked={draft.inApp}
                    onCheckedChange={(next) => {
                      update(entry.type, { inApp: next === true });
                    }}
                  />
                  <Label htmlFor={`${entry.type}-in-app`}>In app</Label>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex items-start justify-between gap-[var(--gap)] rounded-md border border-line bg-ink-700 p-[var(--pad-card)]">
        <div className="min-w-40 flex-1">
          <Label htmlFor="quiet-hours" className="text-[0.8125rem] font-medium text-text">
            Hold alerts overnight
          </Label>
          <p className="mt-0.5 text-xs leading-snug text-text-2">
            Anything due between 22:00 and 08:00 waits until morning. A charge that lands after
            you cancelled always comes through — that one is time-sensitive.
          </p>
        </div>
        <Switch id="quiet-hours" checked={quietHours} onCheckedChange={setQuietHours} />
      </div>

      <div className="flex flex-wrap items-center gap-[var(--gap-tight)]">
        <Button type="button" variant="primary" loading={save.isPending} onClick={submit}>
          Finish setup
        </Button>
        <Button type="button" variant="ghost" onClick={onFinish} disabled={save.isPending}>
          Keep the defaults
        </Button>
      </div>
    </div>
  );
}
