'use client';

import * as React from 'react';
import { LoadError } from '~/components/dashboard/states';

/**
 * The calendar's render-time failure boundary.
 *
 * Distinct from the in-page `LoadError` branch, which handles a query that came back an error.
 * This one catches the case where the data arrived and the component threw on it — a malformed
 * anchor date, say — and it still offers the same single action, because "reload the whole app"
 * is not a recovery step a user should have to invent.
 */
export default function CalendarError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): React.ReactNode {
  return (
    <div className="mx-auto w-full max-w-[1200px] p-[var(--pad-panel)]">
      <LoadError what="the renewal calendar" error={error} onRetry={reset} />
    </div>
  );
}
