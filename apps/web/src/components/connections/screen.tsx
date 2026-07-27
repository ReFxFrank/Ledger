'use client';

import * as React from 'react';
import { AlertTriangle, Ban, Link2, RefreshCw, Trash2 } from 'lucide-react';
import { CONNECTION_STATUS_LABELS, type ConnectionStatus } from '@ledger/core';
import {
  Badge,
  type BadgeTone,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Panel,
  PanelBody,
  PanelHeader,
  Switch,
  cn,
  toast,
} from '@ledger/ui';
import { api } from '~/lib/trpc';
import { formatInstant } from '~/lib/format';
import type { ConnectionAccount, ConnectionListItem } from '~/lib/api-types';
import { LoadError } from '../dashboard/states';
import { MerchantMark } from '../merchant-mark';
import { LinkCallToAction } from './link-cta';
import { PaymentMethods } from './payment-methods';
import { ConnectionsSkeleton } from './skeleton';

/**
 * Bank connections.
 *
 * The screen is built around one fact the server derives on every read rather than storing:
 * consent expiry. Open-banking consent lapses on a fixed clock, and a connection that only says
 * something is wrong *after* the first failed sync has already cost the user a gap in their
 * transaction history. So a connection fourteen days from lapsing says so at the top of the
 * screen, in words, with the number of days in it.
 *
 * `--alert` is reserved for the connections that are actually broken — needs sign-in, consent
 * expired, sync failed. A consent expiring next week is amber: it is a clock running down, not a
 * fault, and if both looked the same neither would mean anything.
 */

const STATUS_TONES: Readonly<Record<ConnectionStatus, BadgeTone>> = {
  active: 'neutral',
  consent_expiring: 'outflow',
  reauth_required: 'alert',
  consent_expired: 'alert',
  error: 'alert',
  disconnected: 'neutral',
};

export function ConnectionsScreen(): React.ReactNode {
  const connections = api.connections.list.useQuery();
  const me = api.me.current.useQuery();
  const timezone = me.data?.timezone ?? 'UTC';
  const locale = me.data?.locale ?? 'en-GB';

  if (connections.error !== null) {
    return (
      <LoadError
        what="your bank connections"
        error={connections.error}
        retrying={connections.isFetching}
        onRetry={() => {
          void connections.refetch();
        }}
      />
    );
  }

  if (connections.isPending) return <ConnectionsSkeleton />;

  const expiring = connections.data.filter(
    (connection) =>
      connection.health.daysUntilConsentExpiry !== null &&
      connection.health.daysUntilConsentExpiry >= 0 &&
      connection.health.status === 'consent_expiring',
  );
  const broken = connections.data.filter(
    (connection) =>
      connection.health.needsAttention && connection.health.status !== 'consent_expiring',
  );

  return (
    <div className="flex flex-col gap-[var(--gap-loose)]">
      {/*
        The whole point of this banner is that it appears before anything stops working. It names
        the bank and the number of days, because "action required" is not information.
      */}
      {expiring.map((connection) => (
        <div
          key={connection.id}
          role="status"
          className="flex flex-wrap items-center justify-between gap-[var(--gap)] rounded-md border border-outflow/35 bg-outflow-dim p-[var(--pad-card)]"
        >
          <p className="flex min-w-0 items-start gap-2.5 text-[0.8125rem] text-text">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-outflow" aria-hidden />
            <span>
              <span className="font-medium text-outflow">
                {connection.institutionName} stops sharing data in{' '}
                {connection.health.daysUntilConsentExpiry}{' '}
                {connection.health.daysUntilConsentExpiry === 1 ? 'day' : 'days'}.
              </span>{' '}
              Banks time-limit open-banking consent. Reconnect before then and nothing breaks;
              afterwards, transactions simply stop arriving and detection goes quiet.
            </span>
          </p>
          <LinkCallToAction
            connectionId={connection.id}
            {...(connection.institutionId === null
              ? {}
              : { institutionId: connection.institutionId })}
            label="Reconnect now"
            explain={false}
          />
        </div>
      ))}

      {broken.map((connection) => (
        <div
          key={connection.id}
          role="alert"
          className="flex flex-wrap items-center justify-between gap-[var(--gap)] rounded-md border border-alert/35 bg-alert-dim p-[var(--pad-card)]"
        >
          <p className="flex min-w-0 items-start gap-2.5 text-[0.8125rem] text-text">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-alert" aria-hidden />
            <span>
              <span className="font-medium text-alert">
                {connection.institutionName}: {CONNECTION_STATUS_LABELS[connection.health.status]}.
              </span>{' '}
              {/* The stored error is a structured record; only its message is for a person. */}
              {connection.error?.message ??
                'Nothing new is arriving from this bank until it is fixed.'}
            </span>
          </p>
          <LinkCallToAction
            connectionId={connection.id}
            {...(connection.institutionId === null
              ? {}
              : { institutionId: connection.institutionId })}
            label="Fix it"
            explain={false}
          />
        </div>
      ))}

      <Panel>
        <PanelHeader
          eyebrow="Bank connections"
          actions={<LinkCallToAction label="Connect a bank" explain={false} />}
        >
          Where transactions come from. Ledger never sees or stores your bank password — an
          aggregator holds the connection, and the token it gives us is sealed before it is
          written down.
        </PanelHeader>

        {connections.data.length === 0 ? (
          <EmptyState icon={<Link2 />} actions={<LinkCallToAction label="Connect a bank" />}>
            No banks connected. Connecting one is the fast route; adding subscriptions by hand or
            importing a CSV works today and feeds the same detection engine.
          </EmptyState>
        ) : (
          <PanelBody className="flex flex-col gap-[var(--gap)]">
            {connections.data.map((connection) => (
              <ConnectionCard
                key={connection.id}
                connection={connection}
                locale={locale}
                timezone={timezone}
              />
            ))}
          </PanelBody>
        )}
      </Panel>

      <PaymentMethods />
    </div>
  );
}

function ConnectionCard({
  connection,
  locale,
  timezone,
}: {
  readonly connection: ConnectionListItem;
  readonly locale: string;
  readonly timezone: string;
}): React.ReactNode {
  const utils = api.useUtils();
  const [confirmingRemove, setConfirmingRemove] = React.useState(false);
  const health = connection.health;

  const sync = api.connections.sync.useMutation({
    onSuccess: async (result) => {
      toast.success(`Synced. ${result.added} new, ${result.updated} updated.`);
      await utils.connections.list.invalidate();
    },
    onError: (error) => {
      toast.error(
        error.data?.code === 'NOT_IMPLEMENTED'
          ? 'Syncing is not switched on in this build.'
          : 'Could not sync.',
        { description: error.message },
      );
    },
  });

  const remove = api.connections.remove.useMutation({
    onSuccess: async () => {
      toast.success('Disconnected. The subscriptions we detected from it are still yours.');
      setConfirmingRemove(false);
      await utils.connections.list.invalidate();
    },
    onError: (error) => {
      toast.error(
        error.data?.code === 'FORBIDDEN'
          ? 'Confirm your password first — disconnecting a bank is a sensitive action.'
          : 'Could not disconnect that.',
        { description: error.message },
      );
    },
  });

  return (
    <article className="rounded-md border border-line bg-ink-700 p-[var(--pad-card)]">
      <div className="flex flex-wrap items-start justify-between gap-[var(--gap)]">
        <div className="flex min-w-0 items-center gap-2.5">
          <MerchantMark name={connection.institutionName} logoUrl={connection.institutionLogo} />
          <div className="min-w-0">
            <p className="truncate text-[0.8125rem] font-medium text-text">
              {connection.institutionName}
            </p>
            <p className="flex flex-wrap items-center gap-x-2 text-[0.6875rem] text-text-3">
              <span className="font-mono uppercase">{connection.provider}</span>
              <span aria-hidden>·</span>
              <span>
                {connection.lastSyncedAt === null
                  ? 'Never synced'
                  : `Synced ${formatInstant(connection.lastSyncedAt, locale, timezone)}`}
              </span>
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-[var(--gap-tight)]">
          <Badge tone={STATUS_TONES[health.status]}>
            {CONNECTION_STATUS_LABELS[health.status]}
          </Badge>
          <Button
            size="sm"
            variant="ghost"
            loading={sync.isPending}
            onClick={() => {
              sync.mutate({ connectionId: connection.id, full: false });
            }}
          >
            <RefreshCw className="size-3.5" aria-hidden />
            Sync
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setConfirmingRemove(true);
            }}
          >
            <Trash2 className="size-3.5" aria-hidden />
            <span className="sr-only">Disconnect {connection.institutionName}</span>
          </Button>
        </div>
      </div>

      <p className="mt-2 text-xs text-text-2">
        {health.daysUntilConsentExpiry === null ? (
          'This provider has not told us when consent lapses.'
        ) : health.daysUntilConsentExpiry < 0 ? (
          <span className="text-alert">
            Consent lapsed{' '}
            {connection.consentExpiresAt === null
              ? 'already'
              : formatInstant(connection.consentExpiresAt, locale, timezone)}
            . Nothing new is arriving.
          </span>
        ) : (
          <>
            Consent runs for another{' '}
            <span className="font-mono tabular-nums text-text">
              {health.daysUntilConsentExpiry}
            </span>{' '}
            {health.daysUntilConsentExpiry === 1 ? 'day' : 'days'}
            {connection.consentExpiresAt === null
              ? '.'
              : `, until ${formatInstant(connection.consentExpiresAt, locale, timezone)}.`}
          </>
        )}
      </p>

      {connection.accounts.length === 0 ? (
        <p className="mt-[var(--gap-loose)] text-xs text-text-3">
          No accounts on this connection yet.
        </p>
      ) : (
        <div className="mt-[var(--gap-loose)]">
          <p className="eyebrow">Accounts</p>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {connection.accounts.map((account) => (
              <AccountRow key={account.id} account={account} />
            ))}
          </ul>
        </div>
      )}

      <Dialog open={confirmingRemove} onOpenChange={setConfirmingRemove}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Disconnect {connection.institutionName}?</DialogTitle>
            <DialogDescription>
              The accounts and every transaction that came from them are deleted. The
              subscriptions detected from those transactions stay — they are your records now, not
              the bank&rsquo;s.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="text-[0.8125rem] text-text-2">
              This cannot be undone, and reconnecting will re-import only as far back as the bank
              is willing to share.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmingRemove(false);
              }}
            >
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => {
                remove.mutate({ id: connection.id });
              }}
            >
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
}

/**
 * One account, with its exclude toggle.
 *
 * Excluding stops detection reading the account; it keeps syncing. That distinction is in the
 * label, because "exclude" on its own reads like "disconnect" and the two have very different
 * consequences for a joint account.
 */
function AccountRow({ account }: { readonly account: ConnectionAccount }): React.ReactNode {
  const utils = api.useUtils();
  const excluded = account.excludedFromDetection !== null;
  const switchId = `exclude-${account.id}`;

  const setExcluded = api.connections.setAccountExcluded.useMutation({
    onSuccess: async (updated) => {
      toast.success(
        updated.excludedFromDetection === null
          ? `${updated.name} is back in detection.`
          : `${updated.name} is excluded from detection.`,
      );
      await utils.connections.list.invalidate();
    },
    onError: (error) => {
      toast.error('Could not change that.', { description: error.message });
    },
  });

  return (
    <li
      className={cn(
        'flex flex-wrap items-center justify-between gap-[var(--gap)] rounded-sm border border-line bg-ink-800 px-[var(--pad-card)] py-2',
        excluded && 'opacity-70',
      )}
    >
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-1.5 text-[0.8125rem] text-text">
          <span className="truncate">{account.name}</span>
          {account.mask === null ? null : (
            <span className="shrink-0 font-mono text-[0.6875rem] text-text-3">
              •••• {account.mask}
            </span>
          )}
        </p>
        <p className="text-[0.6875rem] text-text-3">
          {[account.type, account.subtype].filter((part) => part !== null).join(' · ')}
          {account.currency === '' ? '' : ` · ${account.currency}`}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {excluded ? (
          <Badge tone="neutral">
            <Ban className="size-3" aria-hidden />
            Not scanned
          </Badge>
        ) : null}
        <label htmlFor={switchId} className="text-[0.6875rem] text-text-2">
          Exclude from detection
        </label>
        <Switch
          id={switchId}
          checked={excluded}
          disabled={setExcluded.isPending}
          onCheckedChange={(next) => {
            setExcluded.mutate({ accountId: account.id, excluded: next });
          }}
        />
      </div>
    </li>
  );
}
