import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SubscriptionDetail } from '~/components/subscriptions/detail';

export const metadata: Metadata = { title: 'Subscription' };

/**
 * One subscription.
 *
 * The name would make a better tab title than "Subscription", but generating it here means a
 * second server-side read of a row the client is about to fetch anyway, and this screen is
 * reached from a table that already told the user which one they clicked.
 */
export default async function SubscriptionDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;

  return (
    <div className="p-[var(--pad-panel)]">
      <SubscriptionDetail id={id} />
    </div>
  );
}
