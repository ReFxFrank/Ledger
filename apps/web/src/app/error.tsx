'use client';

import Link from 'next/link';
import { useEffect, type ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import { Button, Panel, PanelBody, PanelHeader } from '@ledger/ui';

/**
 * The error boundary for every route.
 *
 * It says what is and is not true — nothing was changed — offers the retry first, and prints the
 * digest. The digest is the one thing that makes a support message useful: it is the key that
 * ties this screen to the server log entry, and asking a user to "describe what happened" is
 * asking them to do the work the digest already did.
 *
 * `error.message` is deliberately not rendered. In production Next replaces it with a generic
 * string anyway, and in development it is a stack-shaped sentence written for whoever wrote the
 * bug, not for whoever hit it.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}): ReactNode {
  useEffect(() => {
    // Reported through the browser's own error channel rather than `console.log`, which is
    // banned, and which would be stripped from the production bundle regardless.
    reportError(error);
  }, [error]);

  return (
    <div className="min-h-dvh px-4 py-16">
      <div className="mx-auto flex w-full max-w-md flex-col gap-[var(--gap-loose)]">
        <div className="flex items-center gap-2">
          <span aria-hidden className="size-2 rounded-sm bg-outflow" />
          <span className="text-sm font-medium tracking-tight text-text">Ledger</span>
        </div>

        <Panel>
          <PanelHeader eyebrow="Something broke">This screen failed to load.</PanelHeader>
          <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
            <p className="text-sm leading-relaxed text-text-2">
              Nothing was changed. Retrying usually works — if it does not, the reference below
              points at the exact failure in our logs.
            </p>

            <div className="flex flex-wrap gap-[var(--gap-tight)]">
              <Button variant="primary" onClick={reset}>
                <RotateCw aria-hidden className="size-4" strokeWidth={1.75} />
                Try again
              </Button>
              <Button asChild>
                <Link href="/">Go to the dashboard</Link>
              </Button>
            </div>

            {error.digest === undefined ? null : (
              <p className="border-t border-line pt-[var(--gap-loose)] text-xs text-text-3">
                Reference <span className="font-mono text-text-2">{error.digest}</span>
              </p>
            )}
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}
