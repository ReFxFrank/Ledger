'use client';

import * as React from 'react';
import Link from 'next/link';
import { CreditCard } from 'lucide-react';
import { Badge, Button, EmptyState, Panel, PanelBody, PanelHeader, Skeleton } from '@ledger/ui';
import { api } from '~/lib/trpc';
import type { PaymentMethod } from '~/lib/api-types';
import { LoadError } from '../dashboard/states';

/**
 * Payment methods.
 *
 * These are labels, not instruments. There is no column a card number could live in and the
 * router refuses anything that looks like one — so this panel says that out loud rather than
 * leaving the user to wonder what Ledger is holding.
 *
 * The expiry warning is the only thing here that does any work: a card that expires before the
 * next renewal is a failed payment and, with some providers, a cancelled account.
 */
export function PaymentMethods(): React.ReactNode {
  const methods = api.paymentMethods.list.useQuery({ includeArchived: false });

  return (
    <Panel>
      <PanelHeader eyebrow="Payment methods">
        What pays for what. Ledger stores a label, a brand and four digits — never a card number.
      </PanelHeader>

      {methods.error !== null ? (
        <PanelBody>
          <LoadError
            what="your payment methods"
            error={methods.error}
            retrying={methods.isFetching}
            onRetry={() => {
              void methods.refetch();
            }}
          />
        </PanelBody>
      ) : methods.isPending ? (
        <PanelBody className="flex flex-col gap-1.5">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-12 w-full" />
          ))}
        </PanelBody>
      ) : methods.data.length === 0 ? (
        <EmptyState
          icon={<CreditCard />}
          actions={
            <Button size="sm" variant="secondary" asChild>
              <Link href="/subscriptions">Open your subscriptions</Link>
            </Button>
          }
        >
          No payment methods yet. Add one from any subscription and it will show up here with
          everything it pays for.
        </EmptyState>
      ) : (
        <PanelBody className="flex flex-col gap-1.5">
          {methods.data.map((method) => (
            <MethodRow key={method.id} method={method} />
          ))}
        </PanelBody>
      )}
    </Panel>
  );
}

function MethodRow({ method }: { readonly method: PaymentMethod }): React.ReactNode {
  const expiry = expiryState(method.expMonth, method.expYear);

  return (
    <div className="flex flex-wrap items-center justify-between gap-[var(--gap)] rounded-md border border-line bg-ink-700 px-[var(--pad-card)] py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden
          className="grid size-7 shrink-0 place-items-center rounded-sm border border-line bg-ink-600 text-text-3"
        >
          <CreditCard className="size-3.5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[0.8125rem] text-text">{method.label}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-[0.6875rem] text-text-3">
            <span>{method.brand ?? method.type.replace(/_/g, ' ')}</span>
            {method.last4 === null ? null : (
              <>
                <span aria-hidden>·</span>
                <span className="font-mono">•••• {method.last4}</span>
              </>
            )}
            {method.expMonth === null || method.expYear === null ? null : (
              <>
                <span aria-hidden>·</span>
                <span className="font-mono">
                  {String(method.expMonth).padStart(2, '0')}/{String(method.expYear).slice(-2)}
                </span>
              </>
            )}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-[var(--gap-tight)]">
        {expiry === 'expired' ? (
          <Badge tone="alert">Expired</Badge>
        ) : expiry === 'soon' ? (
          <Badge tone="outflow">Expires soon</Badge>
        ) : null}
        <span className="font-mono text-xs tabular-nums text-text-2">
          {method.subscriptionCount}
        </span>
        <span className="text-[0.6875rem] text-text-3">
          {method.subscriptionCount === 1 ? 'subscription' : 'subscriptions'}
        </span>
      </div>
    </div>
  );
}

/**
 * Expiry, against the wall clock rather than an injected `Clock`.
 *
 * This is a render-time presentation detail with no test that depends on it, and the alternative
 * — threading a clock through to a badge — would make the rule harder to read without making it
 * more correct. Anything that schedules, projects or decides goes through `Clock` on the server.
 */
function expiryState(month: number | null, year: number | null): 'ok' | 'soon' | 'expired' {
  if (month === null || year === null) return 'ok';
  const now = new Date();
  const nowIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const cardIndex = year * 12 + (month - 1);
  if (cardIndex < nowIndex) return 'expired';
  if (cardIndex - nowIndex <= 2) return 'soon';
  return 'ok';
}
