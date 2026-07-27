'use client';

import * as React from 'react';
import { AlertOctagon, Eye, ShieldCheck } from 'lucide-react';
import { type CancellationStatus, fromInstant } from '@ledger/core';
import { Badge, Panel, PanelBody, PanelHeader, cn, focusRing } from '@ledger/ui';
import { formatDay } from '~/lib/format';

/**
 * Did the charge actually stop?
 *
 * Three states, and the distinction between the first two is the whole point of the feature: a
 * provider saying "cancelled" is a claim, and `verified` is the bank feed agreeing. Conflating
 * them is how a tracker tells someone they are safe while a payment is in flight.
 *
 * The third state — charged anyway — is loud, and it is the only place on this screen that takes
 * `--alert`. Everything else here, including a passed deadline on a closed request, is history.
 */

export type VerificationState = 'not_started' | 'waiting' | 'verified' | 'charged';

export function verificationStateOf(
  status: CancellationStatus,
  verifiedAt: Date | null,
  chargedTxId: string | null,
): VerificationState {
  if (status === 'failed' || chargedTxId !== null) return 'charged';
  if (status === 'verified' || verifiedAt !== null) return 'verified';
  if (status === 'awaiting_confirmation' || status === 'confirmed') return 'waiting';
  return 'not_started';
}

export interface VerificationPanelProps {
  readonly state: VerificationState;
  readonly verifiedAt: Date | null;
  readonly chargedTxId: string | null;
  readonly expectedNextChargeAt: Date | null;
  readonly verificationWindowEndsAt: Date | null;
  readonly locale: string;
  readonly timezone: string;
  /** Anchor of the evidence panel, so the loud state can send the user straight to it. */
  readonly evidenceHref: string;
}

export function VerificationPanel({
  state,
  verifiedAt,
  chargedTxId,
  expectedNextChargeAt,
  verificationWindowEndsAt,
  locale,
  timezone,
  evidenceHref,
}: VerificationPanelProps): React.ReactNode {
  if (state === 'charged') {
    return (
      <Panel className="border-alert/40">
        <PanelHeader
          eyebrow="Verification"
          actions={<Badge tone="alert">Charged anyway</Badge>}
        >
          <span className="text-alert">You were charged after cancelling.</span>
        </PanelHeader>
        <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
          <div role="alert" className="flex items-start gap-2.5">
            <AlertOctagon className="mt-0.5 size-4 shrink-0 text-alert" aria-hidden />
            <div className="min-w-0 text-[0.8125rem] leading-relaxed text-text">
              <p>
                A charge landed on this subscription inside the window we were watching. That is
                what the evidence is for: the confirmation, the reference number, and the date you
                cancelled are what your bank will ask for.
              </p>
              {chargedTxId === null ? null : (
                <p className="mt-2 text-xs text-text-2">
                  <span className="eyebrow mr-1.5">Transaction</span>
                  <span className="font-mono break-all">{chargedTxId}</span>
                </p>
              )}
              <p className="mt-2">
                <a
                  href={evidenceHref}
                  className={cn(
                    'rounded-sm font-medium text-alert underline underline-offset-2',
                    'transition-colors duration-[var(--duration-fast)] ease-standard hover:text-text',
                    focusRing,
                  )}
                >
                  Go to your evidence
                </a>
              </p>
            </div>
          </div>
        </PanelBody>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader
        eyebrow="Verification"
        actions={
          <Badge tone={state === 'verified' ? 'control' : 'neutral'}>
            {state === 'verified' ? 'Verified' : state === 'waiting' ? 'Waiting' : 'Not started'}
          </Badge>
        }
      />
      <PanelBody className="flex items-start gap-2.5">
        {state === 'verified' ? (
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-control-2" aria-hidden />
        ) : (
          <Eye className="mt-0.5 size-4 shrink-0 text-text-3" aria-hidden />
        )}

        <div className="min-w-0 text-[0.8125rem] leading-relaxed text-text-2">
          {state === 'verified' ? (
            <p>
              The charge we expected never arrived
              {verifiedAt === null
                ? '.'
                : `, and we confirmed that on ${formatDay(fromInstant(verifiedAt, timezone), locale)}.`}{' '}
              This one is genuinely off your books.
            </p>
          ) : state === 'waiting' ? (
            <p>
              The provider has been told. We are watching your bank feed for the charge that should
              not arrive
              {expectedNextChargeAt === null
                ? ''
                : ` around ${formatDay(fromInstant(expectedNextChargeAt, timezone), locale)}`}
              {verificationWindowEndsAt === null
                ? '.'
                : `, and will keep watching until ${formatDay(
                    fromInstant(verificationWindowEndsAt, timezone),
                    locale,
                  )}.`}{' '}
              Until then this is a claim, not a fact.
            </p>
          ) : (
            <p>
              Verification starts once you have told the provider and marked this as submitted.
              Until then there is nothing to watch for.
            </p>
          )}
        </div>
      </PanelBody>
    </Panel>
  );
}
