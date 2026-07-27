'use client';

import * as React from 'react';
import { LoadError } from '~/components/dashboard/states';

/**
 * The review queue's render-time failure boundary.
 *
 * Separate from the in-page error branch, which handles a query that came back an error. This
 * one catches the case where the data arrived and a card threw on it — a descriptor the decoder
 * could not span, say — and it offers the same single action, because "reload the whole app" is
 * not a recovery step a user should have to invent.
 */
export default function ReviewError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): React.ReactNode {
  return (
    <div className="mx-auto w-full max-w-[1200px] p-[var(--pad-panel)]">
      <LoadError what="the review queue" error={error} onRetry={reset} />
    </div>
  );
}
