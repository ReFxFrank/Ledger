'use client';

import * as React from 'react';
import { LoadError } from '~/components/dashboard/states';

/** Render-time failure on connections. Retry in place rather than reloading the app. */
export default function ConnectionsError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): React.ReactNode {
  return (
    <div className="mx-auto w-full max-w-[1000px] p-[var(--pad-panel)]">
      <LoadError what="your connections" error={error} onRetry={reset} />
    </div>
  );
}
