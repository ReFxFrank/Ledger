import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ReviewQueue } from '~/components/review/queue';

export const metadata: Metadata = {
  title: 'Review',
  description: 'Charges the engine thinks are subscriptions, and why.',
};

/**
 * The review queue.
 *
 * A server component around one client island: everything on this screen is a decision the user
 * makes with the keyboard against data that changes as they work, so there is nothing worth
 * rendering on the server except the frame and the sentence that explains what the screen is for.
 */
export default function ReviewPage(): ReactNode {
  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-[var(--gap-loose)] p-[var(--pad-panel)]">
      <header className="min-w-0">
        <p className="eyebrow">Review</p>
        <h1 className="mt-1 text-lg font-medium leading-tight text-text">
          What we think is charging you
        </h1>
        <p className="mt-1.5 max-w-prose text-xs text-text-2">
          Each suggestion shows the bank descriptor it came from, with the matched merchant
          highlighted and the noise the normaliser removed dimmed. Nothing becomes a subscription
          until you say so.
        </p>
      </header>

      <ReviewQueue />
    </div>
  );
}
