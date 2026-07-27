import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CancellationDetailView } from '~/components/cancellations/detail';

export const metadata: Metadata = { title: 'Cancellation' };

/**
 * One cancellation, the guided workflow.
 *
 * The title stays generic rather than naming the provider: putting the name here would mean a
 * second server-side read of the row the client is about to fetch anyway, and the user arrived
 * from a board card that already told them which one they opened.
 */
export default async function CancellationDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;

  return (
    <div className="mx-auto w-full max-w-[1200px] p-[var(--pad-panel)]">
      <CancellationDetailView requestId={id} />
    </div>
  );
}
