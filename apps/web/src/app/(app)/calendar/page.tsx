'use client';

import * as React from 'react';
import { parsePlainDate } from '@ledger/core';
import { api } from '~/lib/trpc';
import { CalendarSkeleton } from '~/components/calendar/calendar-skeleton';
import { RenewalCalendar } from '~/components/calendar/renewal-calendar';
import { LoadError } from '~/components/dashboard/states';

/**
 * The month view.
 *
 * It reads the subscriptions list rather than a calendar endpoint, because the projection is
 * pure date maths over `anchor + n × interval` and running it here is what lets the user page
 * back through months the forward-only horizon procedure cannot answer. The same
 * `occurrencesBetween` runs on both sides, so the two views cannot drift apart.
 *
 * `horizon` is queried only for its `from` field: the server's notion of today in the user's
 * timezone. Reading the browser clock instead would put "today" on the wrong square for anyone
 * travelling, which is precisely when a renewal date matters most.
 */
export default function CalendarPage(): React.ReactNode {
  const subscriptions = api.subscriptions.list.useQuery({
    // Statuses that still cost money — the same set the horizon projects.
    statuses: ['active', 'trialing', 'cancel_scheduled'],
    limit: 500,
    sort: 'name',
    direction: 'asc',
  });
  // The smallest window the procedure accepts: this call is here for `from`, not for the ticks.
  const horizon = api.dashboard.horizon.useQuery({ days: 7 });
  const me = api.me.current.useQuery();

  const rows = React.useMemo(
    () => (subscriptions.data?.items ?? []).map((item) => item.subscription),
    [subscriptions.data],
  );

  const locale = me.data?.locale;
  const failure = subscriptions.error ?? horizon.error;

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-[var(--gap-loose)] p-[var(--pad-panel)]">
      {/* The page heading is the top bar's `<h1>` — the shell owns the only one on the page. */}
      {failure !== null ? (
        <LoadError
          what="the renewal calendar"
          error={failure}
          onRetry={() => {
            void subscriptions.refetch();
            void horizon.refetch();
          }}
          retrying={subscriptions.isFetching || horizon.isFetching}
        />
      ) : horizon.data === undefined || subscriptions.isPending ? (
        <CalendarSkeleton />
      ) : (
        <RenewalCalendar
          subscriptions={rows}
          today={parsePlainDate(horizon.data.from)}
          {...(locale === undefined ? {} : { locale })}
        />
      )}
    </div>
  );
}
