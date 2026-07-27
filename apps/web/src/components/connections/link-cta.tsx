'use client';

import * as React from 'react';
import Link from 'next/link';
import { FileUp, Link2, Plus } from 'lucide-react';
import { Button, cn } from '@ledger/ui';
import { api } from '~/lib/trpc';

/**
 * "Connect a bank" — and what happens when it cannot.
 *
 * `createLinkSession` throws `NOT_IMPLEMENTED` in this build: the aggregator adapter lands with
 * workstream D and the procedure refuses rather than returning a plausible link token. This
 * component takes that at face value.
 *
 * There is deliberately no fake Link flow, no modal that pretends to be a bank picker, and no
 * "coming soon" that leaves the user waiting. What there is instead is the truth and the two
 * routes that genuinely work today — typing a subscription in, and importing a CSV — because a
 * user who came here to start tracking their subscriptions can still do exactly that.
 */

type Failure = 'none' | 'not_implemented' | 'reauth' | 'other';

function classify(code: string | undefined): Failure {
  if (code === 'NOT_IMPLEMENTED') return 'not_implemented';
  if (code === 'FORBIDDEN' || code === 'UNAUTHORIZED') return 'reauth';
  return 'other';
}

export interface LinkCallToActionProps {
  /** Set when this is a re-authorisation of an existing connection rather than a new one. */
  readonly connectionId?: string;
  readonly institutionId?: string;
  readonly label: string;
  readonly variant?: 'primary' | 'secondary';
  readonly size?: 'sm' | 'md';
  /** Rendered under the button when the attempt fails. Off for inline re-auth buttons. */
  readonly explain?: boolean;
}

export function LinkCallToAction({
  connectionId,
  institutionId,
  label,
  variant = 'primary',
  size = 'sm',
  explain = true,
}: LinkCallToActionProps): React.ReactNode {
  const [failure, setFailure] = React.useState<Failure>('none');
  const [message, setMessage] = React.useState('');

  const createSession = api.connections.createLinkSession.useMutation({
    onError: (error) => {
      setFailure(classify(error.data?.code));
      setMessage(error.message);
    },
    onSuccess: () => {
      // Unreachable in this build. When workstream D lands, the aggregator's own SDK takes over
      // from here — which is why this component holds no token and renders no bank picker.
      setFailure('none');
    },
  });

  return (
    <div className="flex min-w-0 flex-col gap-[var(--gap-tight)]">
      <Button
        size={size}
        variant={variant}
        loading={createSession.isPending}
        disabled={failure === 'not_implemented'}
        onClick={() => {
          createSession.mutate({
            ...(connectionId === undefined ? {} : { connectionId }),
            ...(institutionId === undefined ? {} : { institutionId }),
          });
        }}
      >
        <Link2 className="size-3.5" aria-hidden />
        {label}
      </Button>

      {failure === 'none' ? null : (
        <div
          role="status"
          className={cn(
            'rounded-md border p-[var(--pad-card)] text-xs',
            failure === 'not_implemented' ? 'border-line bg-ink-700' : 'border-alert/35 bg-alert-dim',
          )}
        >
          {failure === 'not_implemented' ? (
            <>
              <p className="text-[0.8125rem] text-text">
                Bank connections are not switched on in this build.
              </p>
              {explain ? (
                <>
                  <p className="mt-1.5 text-text-2">
                    There is no aggregator wired up yet, so there is nothing for this button to
                    open. Rather than show you a bank picker that goes nowhere, here are the two
                    routes that work today and put real subscriptions on your list.
                  </p>
                  <div className="mt-[var(--gap-loose)] flex flex-wrap gap-[var(--gap-tight)]">
                    <Button size="sm" variant="primary" asChild>
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
                  <p className="mt-[var(--gap-loose)] text-text-3">
                    A CSV export from your bank goes through the same detection engine a live
                    connection would, so the review queue works either way.
                  </p>
                </>
              ) : (
                <p className="mt-1.5 text-text-2">
                  Re-authorising needs the aggregator, which is not wired up yet.
                </p>
              )}
            </>
          ) : failure === 'reauth' ? (
            <p className="text-text">
              {message} Connecting a bank is treated as a sensitive action, so it needs a fresh
              sign-in first.
            </p>
          ) : (
            <p className="text-text">{message}</p>
          )}
        </div>
      )}
    </div>
  );
}
