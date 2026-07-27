'use client';

import * as React from 'react';
import { LoadError } from '~/components/dashboard/states';

/**
 * Render-time failure on analytics.
 *
 * Each panel already handles its own query errors inline, so reaching this boundary means a chart
 * threw while drawing — a series with a value the scale could not place, most likely. The retry
 * remounts the panels rather than reloading the app.
 */
export default function AnalyticsError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): React.ReactNode {
  return (
    <div className="mx-auto w-full max-w-[1400px] p-[var(--pad-panel)]">
      <LoadError what="your analytics" error={error} onRetry={reset} />
    </div>
  );
}
