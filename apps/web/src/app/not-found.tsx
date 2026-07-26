import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Button, Panel, PanelBody, PanelHeader } from '@ledger/ui';

export const metadata: Metadata = { title: 'Not found' };

/**
 * 404.
 *
 * Two exits, because there are two ways to arrive: a stale link to something that has been
 * archived — subscriptions are never deleted, so the list is the right place to look — or a
 * mistyped path, where the dashboard is home. Both are buttons, not a paragraph suggesting the
 * user go and find them.
 */
export default function NotFound(): ReactNode {
  return (
    <div className="min-h-dvh px-4 py-16">
      <div className="mx-auto flex w-full max-w-md flex-col gap-[var(--gap-loose)]">
        <div className="flex items-center gap-2">
          <span aria-hidden className="size-2 rounded-sm bg-outflow" />
          <span className="text-sm font-medium tracking-tight text-text">Ledger</span>
        </div>

        <Panel>
          <PanelHeader eyebrow="404">This page does not exist.</PanelHeader>
          <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
            <p className="text-sm leading-relaxed text-text-2">
              The link may be out of date. Nothing here is ever deleted, so if you are looking for
              a subscription you archived, it is still in the list.
            </p>
            <div className="flex flex-wrap gap-[var(--gap-tight)]">
              <Button asChild variant="primary">
                <Link href="/">Go to the dashboard</Link>
              </Button>
              <Button asChild>
                <Link href="/subscriptions">Open subscriptions</Link>
              </Button>
            </div>
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}
