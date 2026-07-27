'use client';

import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, FileUp, Link2, Plus, ShieldCheck } from 'lucide-react';
import { Button, Spinner, cn } from '@ledger/ui';
import { api } from '~/lib/trpc';
import type { ConnectResult } from '~/lib/api-types';
import { isReauthRequired, useSensitiveAction } from '~/components/auth/reauth-dialog';

/**
 * "Connect a bank" — the real flow.
 *
 * Two procedures, run back to back: `createLinkSession` asks the configured aggregator to open a
 * session, and `exchangeToken` turns the resulting public token into a stored connection and pulls
 * its history. Which of those two steps involves a bank sign-in depends on the aggregator, and
 * this component branches on `session.mode` rather than assuming:
 *
 *  - `handoff`   — Plaid. The link token belongs to Plaid's client SDK, the user signs in inside
 *                  that SDK, and the public token comes back from it. Ledger is not in the middle
 *                  of that exchange and never sees a credential.
 *  - `immediate` — the fixture. There is no bank to sign into, so the session already carries the
 *                  public token. No fake bank picker is rendered, because a modal that pretends to
 *                  be a bank would be the one part of this flow that is not true.
 *
 * The connection itself is a `sensitiveProcedure`, so a stale re-auth is expected rather than
 * exceptional: `useSensitiveAction` catches it, asks for the password, and re-runs the whole
 * chain — which is safe to do because `exchangeToken` is idempotent on `(provider, item id)`.
 */

/** What the button is doing, in the user's terms rather than the protocol's. */
type Phase = 'idle' | 'opening' | 'importing' | 'done' | 'handoff' | 'failed';

const PHASE_LABELS: Readonly<Record<'opening' | 'importing', string>> = {
  opening: 'Asking your bank for permission…',
  importing: 'Reading up to two years of history and looking for recurring charges…',
};

export interface LinkCallToActionProps {
  /** Set when this is a re-authorisation of an existing connection rather than a new one. */
  readonly connectionId?: string;
  readonly institutionId?: string;
  readonly label: string;
  readonly variant?: 'primary' | 'secondary';
  readonly size?: 'sm' | 'md';
  /** Rendered under the button when the attempt fails. Off for inline re-auth buttons. */
  readonly explain?: boolean;
  /** Lets the screen show the summary somewhere with room for it. */
  readonly onConnected?: (result: ConnectResult) => void;
}

export function LinkCallToAction({
  connectionId,
  institutionId,
  label,
  variant = 'primary',
  size = 'sm',
  explain = true,
  onConnected,
}: LinkCallToActionProps): React.ReactNode {
  const utils = api.useUtils();
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [message, setMessage] = React.useState('');

  const createSession = api.connections.createLinkSession.useMutation();
  const exchange = api.connections.exchangeToken.useMutation();

  const connect = React.useCallback(async () => {
    setMessage('');
    setPhase('opening');

    try {
      const session = await createSession.mutateAsync({
        ...(connectionId === undefined ? {} : { connectionId }),
        ...(institutionId === undefined ? {} : { institutionId }),
      });

      if (session.mode === 'handoff' || session.publicToken === null) {
        // A real Plaid deployment mounts their SDK here with `session.linkToken`. Saying so beats
        // silently doing nothing, and beats more strongly a stub that fabricates a public token.
        setPhase('handoff');
        return;
      }

      setPhase('importing');
      const result = await exchange.mutateAsync({
        publicToken: session.publicToken,
        ...(institutionId === undefined ? {} : { institutionId }),
      });

      setPhase('done');
      onConnected?.(result);
      // Both queries, because the whole point of connecting is that /review now has something in
      // it. Invalidating only the connection list would leave the review badge stale.
      await Promise.all([utils.connections.list.invalidate(), utils.review.list.invalidate()]);
    } catch (error) {
      // Re-auth is not a failure — it is the gate doing its job. Rethrowing hands it to
      // `useSensitiveAction`, which collects the password and runs this function again.
      if (isReauthRequired(error)) {
        setPhase('idle');
        throw error;
      }
      setPhase('failed');
      setMessage(error instanceof Error ? error.message : 'Something went wrong.');
    }
  }, [connectionId, institutionId, createSession, exchange, onConnected, utils]);

  const { run, dialog } = useSensitiveAction(
    connect,
    'Connecting a bank gives Ledger a read-only feed of your transactions, so it needs a password confirmation first.',
  );

  const busy = phase === 'opening' || phase === 'importing';

  return (
    <div className="flex min-w-0 flex-col gap-[var(--gap-tight)]">
      <Button size={size} variant={variant} loading={busy} onClick={run}>
        <Link2 className="size-3.5" aria-hidden />
        {label}
      </Button>

      {busy ? (
        <p
          role="status"
          className="flex items-center gap-2 text-[0.6875rem] text-text-2"
          aria-live="polite"
        >
          <Spinner className="size-3" />
          {PHASE_LABELS[phase]}
        </p>
      ) : null}

      {phase === 'done' && !explain ? (
        <p role="status" className="flex items-center gap-1.5 text-[0.6875rem] text-text-2">
          <CheckCircle2 className="size-3 text-text-3" aria-hidden />
          Connected.
        </p>
      ) : null}

      {phase === 'handoff' ? (
        <div role="status" className="rounded-md border border-line bg-ink-700 p-[var(--pad-card)] text-xs">
          <p className="text-[0.8125rem] text-text">Your bank&rsquo;s sign-in opens next.</p>
          <p className="mt-1.5 text-text-2">
            This build has an aggregator configured but no hosted sign-in mounted, so the flow stops
            here rather than pretending to be your bank. Ledger never sees what you type on that
            screen — the aggregator holds the connection and hands us a sealed token.
          </p>
        </div>
      ) : null}

      {phase === 'failed' ? (
        <div
          role="alert"
          className="rounded-md border border-alert/35 bg-alert-dim p-[var(--pad-card)] text-xs"
        >
          <p className="text-text">{message}</p>
          {explain ? (
            <>
              <p className="mt-1.5 text-text-2">
                Nothing was saved. These two routes work regardless and feed the same detection
                engine a live connection would.
              </p>
              <div className="mt-[var(--gap-loose)] flex flex-wrap gap-[var(--gap-tight)]">
                <Button size="sm" variant="secondary" asChild>
                  <Link href="/subscriptions">
                    <Plus className="size-3.5" aria-hidden />
                    Add one by hand
                  </Link>
                </Button>
                <Button size="sm" variant="secondary" asChild>
                  <Link href="/subscriptions/import">
                    <FileUp className="size-3.5" aria-hidden />
                    Import a CSV
                  </Link>
                </Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {explain && phase === 'idle' ? (
        <p className={cn('flex items-start gap-1.5 text-[0.6875rem] text-text-3')}>
          <ShieldCheck className="mt-px size-3 shrink-0" aria-hidden />
          <span>
            Ledger never sees or stores your bank password. The token the aggregator returns is
            sealed before it is written down, and no screen in this app can show it to you.
          </span>
        </p>
      ) : null}

      {dialog}
    </div>
  );
}
