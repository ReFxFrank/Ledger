'use client';

import * as React from 'react';
import { Panel, PanelBody, PanelHeader, Skeleton, Button } from '@ledger/ui';
import { api } from '~/lib/trpc';
import { formatInstant } from '~/lib/format';
import { LoadError } from '../dashboard/states';

/**
 * The audit log, shown to the user (brief §9.5).
 *
 * This is not a debug stream. It exists so a person can answer "what happened to my Spotify
 * subscription and who changed it", which is why the action verbs are rendered as sentences
 * rather than as the raw `entity.action` keys stored in the column.
 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  'subscription.created': 'Added a subscription',
  'subscription.updated': 'Edited a subscription',
  'subscription.archived': 'Archived subscriptions',
  'subscription.restored': 'Restored subscriptions',
  'subscription.bulk_updated': 'Updated several subscriptions',
  'subscription.shares_updated': 'Changed cost splitting',
  'detection.confirmed': 'Confirmed a detected subscription',
  'detection.dismissed': 'Dismissed a detection',
  'connection.created': 'Connected a bank',
  'connection.removed': 'Disconnected a bank',
  'cancellation.started': 'Started a cancellation',
  'cancellation.confirmed': 'Recorded a cancellation confirmation',
  'cancellation.verified': 'Cancellation verified — no further charge',
  'account.preferences_updated': 'Changed account preferences',
  'data.exported': 'Exported your data',
};

function describe(action: string): string {
  // Unknown actions render as the raw key rather than as "Unknown". A log that hides what it
  // does not recognise is worse than one that shows a slightly ugly string.
  return ACTION_LABELS[action] ?? action;
}

export function ActivityLog({
  locale,
  timezone,
}: {
  readonly locale: string;
  readonly timezone: string;
}): React.ReactNode {
  const [limit, setLimit] = React.useState(25);
  const activity = api.me.activity.useQuery({ limit, cursor: 0 });

  if (activity.error !== null) {
    return (
      <Panel>
        <PanelHeader eyebrow="Security" title="Recent activity" />
        <PanelBody>
          <LoadError
            what="your activity"
            error={activity.error}
            retrying={activity.isFetching}
            onRetry={() => {
              void activity.refetch();
            }}
          />
        </PanelBody>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader eyebrow="Security" title="Recent activity" />
      <PanelBody className="flex flex-col gap-[var(--gap)]">
        <p className="max-w-prose text-xs text-text-2">
          Every change to a subscription, connection, or cancellation. If something here was not
          you, change your password and revoke your other sessions.
        </p>

        {activity.isPending ? (
          <div className="flex flex-col gap-1.5" aria-busy>
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </div>
        ) : activity.data.items.length === 0 ? (
          <p className="text-xs text-text-3">Nothing recorded yet.</p>
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-line">
              {activity.data.items.map((entry) => (
                <li key={entry.id} className="flex items-baseline justify-between gap-3 py-2">
                  <span className="min-w-0 text-xs text-text">
                    {describe(entry.action)}
                    {entry.actor === 'system' && (
                      <span className="ml-1.5 text-[11px] text-text-3">by Ledger</span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-text-3">
                    {formatInstant(entry.at, locale, timezone)}
                  </span>
                </li>
              ))}
            </ul>

            {activity.data.nextCursor !== null && (
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setLimit((current) => current + 25);
                  }}
                >
                  Show more
                </Button>
              </div>
            )}
          </>
        )}
      </PanelBody>
    </Panel>
  );
}
