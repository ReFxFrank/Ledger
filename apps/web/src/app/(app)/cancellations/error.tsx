'use client';

import * as React from 'react';
import { LoadError } from '~/components/dashboard/states';

/** Render-time failure on the board. One action, inline, rather than "reload the app". */
export default function CancellationsError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): React.ReactNode {
  return (
    <div className="mx-auto w-full max-w-[1400px] p-[var(--pad-panel)]">
      <LoadError what="your cancellations" error={error} onRetry={reset} />
    </div>
  );
}
