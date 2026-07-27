'use client';

import * as React from 'react';
import { ExternalLink, Route } from 'lucide-react';
import {
  BILLING_CHANNEL_LABELS,
  CANCELLATION_METHOD_LABELS,
  type BillingChannel,
  type CancellationMethod,
  isIntermediated,
} from '@ledger/core';
import { Badge, Button, cn } from '@ledger/ui';

/**
 * Where this cancellation actually has to happen.
 *
 * This is the single most important thing on the screen. A subscription billed through the App
 * Store cannot be cancelled on the provider's website — the provider genuinely cannot stop it —
 * so pointing someone at a provider cancel page costs them an afternoon *and* the next renewal.
 *
 * The guard is `isIntermediated` from @ledger/core, not a list restated here. When it is true the
 * provider's own link is not rendered at all, and the banner says why. There is deliberately no
 * flag, no "show anyway", and no fallback that reveals it: a link that is wrong is worse than a
 * link that is missing, because the user believes it.
 */

/**
 * The store's own subscription-management page.
 *
 * These are store settings, never a provider's cancel page — the distinction this whole component
 * exists to hold. They are a shortcut, not the instruction: the steps below the banner are
 * snapshotted from the playbook at the moment the cancellation started and are the authority if a
 * store reorganises its account pages.
 */
const STORE_SETTINGS_URL: Partial<Record<BillingChannel, string>> = {
  apple: 'https://apps.apple.com/account/subscriptions',
  google: 'https://play.google.com/store/account/subscriptions',
  amazon: 'https://www.amazon.com/yourmembershipsandsubscriptions',
  microsoft: 'https://account.microsoft.com/services',
  roku: 'https://my.roku.com/account/subscriptions',
  // No entry for `carrier` on purpose: there is no universal carrier page, and guessing one
  // sends the user somewhere that cannot help them.
};

export interface RouteBannerProps {
  readonly method: CancellationMethod;
  readonly channel: BillingChannel;
  readonly subscriptionName: string;
  /** The provider's own website, as stored on the subscription. Suppressed for store billing. */
  readonly providerUrl: string | null;
  /**
   * The playbook's deep link to the actual cancel page, snapshotted when the cancellation
   * started. Only ever rendered for non-intermediated channels — the same refusal as
   * `providerUrl`, and for the same reason.
   */
  readonly cancelUrl?: string | null | undefined;
  /** The `channel` step from the snapshotted checklist, when the playbook wrote one. */
  readonly routingNote?: string | undefined;
  readonly routingWarning?: string | undefined;
}

export function RouteBanner({
  method,
  channel,
  subscriptionName,
  providerUrl,
  cancelUrl,
  routingNote,
  routingWarning,
}: RouteBannerProps): React.ReactNode {
  const intermediated = isIntermediated(channel);
  const storeUrl = STORE_SETTINGS_URL[channel];
  const channelLabel = BILLING_CHANNEL_LABELS[channel];

  return (
    <section
      aria-labelledby="route-heading"
      className={cn(
        'rounded-md border p-[var(--pad-card)]',
        intermediated ? 'border-control/35 bg-control-dim' : 'border-line bg-ink-700',
      )}
    >
      <div className="flex items-start gap-2.5">
        <Route
          aria-hidden
          className={cn('mt-0.5 size-4 shrink-0', intermediated ? 'text-control-2' : 'text-text-3')}
        />
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Where to cancel</p>
          <h2 id="route-heading" className="mt-1 text-sm font-medium leading-snug text-text">
            {intermediated
              ? `${subscriptionName} is billed through ${channelLabel}, so it has to be cancelled there.`
              : `Cancel ${subscriptionName} by ${CANCELLATION_METHOD_LABELS[method].toLowerCase()}.`}
          </h2>

          <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={intermediated ? 'control' : 'neutral'}>
              {CANCELLATION_METHOD_LABELS[method]}
            </Badge>
            <Badge tone="neutral">{channelLabel}</Badge>
          </p>

          {routingNote === undefined ? null : (
            <p className="mt-2 text-[0.8125rem] text-text-2">{routingNote}</p>
          )}

          {intermediated ? (
            <p className="mt-2 text-[0.8125rem] text-text-2">
              {routingWarning ??
                `Cancelling inside your ${subscriptionName} account will not stop this charge — ${channelLabel} takes the payment.`}{' '}
              That is why there is no link to {subscriptionName} on this screen.
            </p>
          ) : null}

          <div className="mt-[var(--gap-loose)] flex flex-wrap items-center gap-[var(--gap-tight)]">
            {intermediated ? (
              storeUrl === undefined ? (
                <p className="text-xs text-text-3">
                  There is no single page for this — follow the steps below in your {channelLabel}{' '}
                  account.
                </p>
              ) : (
                <Button size="sm" variant="primary" asChild>
                  <a href={storeUrl} target="_blank" rel="noreferrer noopener">
                    Open {channelLabel} subscriptions
                    <ExternalLink className="size-3.5" aria-hidden />
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </Button>
              )
            ) : (
              <>
                {/* The playbook's deep link goes straight to the cancel flow, so it is the
                    primary action; the provider's homepage is only worth a button when there is
                    no better door to point at. */}
                {cancelUrl === null || cancelUrl === undefined ? null : (
                  <Button size="sm" variant="primary" asChild>
                    <a href={cancelUrl} target="_blank" rel="noreferrer noopener">
                      Open the cancel page
                      <ExternalLink className="size-3.5" aria-hidden />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </Button>
                )}
                {providerUrl === null || (cancelUrl !== null && cancelUrl !== undefined) ? null : (
                  <Button size="sm" variant="secondary" asChild>
                    <a href={providerUrl} target="_blank" rel="noreferrer noopener">
                      Open {subscriptionName}
                      <ExternalLink className="size-3.5" aria-hidden />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
