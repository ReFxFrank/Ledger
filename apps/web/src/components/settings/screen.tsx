'use client';

import * as React from 'react';
import { Skeleton } from '@ledger/ui';
import { api } from '~/lib/trpc';
import { LoadError } from '../dashboard/states';
import { ActivityLog } from './activity';
import { DangerZone, DataExport } from './data';
import { NotificationSettings } from './notifications';
import { ProfileSettings } from './profile';
import { SecuritySettings } from './security';

/**
 * Settings.
 *
 * One column rather than tabs. The sections are short, there are only six of them, and a tab
 * strip would hide the two that matter most — the ones a person came here to find are usually
 * "revoke that session" and "delete my account", and both are worse behind a click.
 *
 * `me.current` is fetched once here and the display currency and locale are passed down, so the
 * notification thresholds render in the user's own currency without every child refetching it.
 */
export function SettingsScreen(): React.ReactNode {
  const me = api.me.current.useQuery();

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[860px] flex-col gap-[var(--gap-loose)] p-[var(--pad-panel)]">
      <header className="min-w-0">
        <p className="eyebrow">Settings</p>
        <h1 className="mt-1 text-lg font-medium leading-tight text-text">Your account</h1>
      </header>

      <ProfileSettings />
      <SecuritySettings />

      {me.error !== null ? (
        <LoadError
          what="your account"
          error={me.error}
          retrying={me.isFetching}
          onRetry={() => {
            void me.refetch();
          }}
        />
      ) : me.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <NotificationSettings locale={me.data.locale} currency={me.data.displayCurrency} />
          <ActivityLog locale={me.data.locale} timezone={me.data.timezone} />
          <DataExport />
          <DangerZone email={me.data.email} />
        </>
      )}
    </div>
  );
}
