'use client';

import * as React from 'react';
import { LoadError } from '~/components/dashboard/states';

/** Render-time failure on one cancellation. Retry in place — the id is still in the URL. */
export default function CancellationDetailError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): React.ReactNode {
  return (
    <div className="mx-auto w-full max-w-[1200px] p-[var(--pad-panel)]">
      <LoadError what="this cancellation" error={error} onRetry={reset} />
    </div>
  );
}
