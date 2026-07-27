import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Panel, PanelBody, PanelHeader } from '@ledger/ui';

export const metadata: Metadata = { title: 'Offline' };

/**
 * The service worker's navigation fallback (apps/web/public/sw.js).
 *
 * Deliberately signed-out and static: it is the one page in the app the worker is allowed to keep
 * on disk, so it must be a page that says nothing about anybody. No totals, no counts, no "last
 * seen" — a number cached from a previous session and shown without a server round trip is
 * exactly the leak the worker exists to avoid.
 *
 * No retry button either. A button that reloads is a button that fails again until the connection
 * comes back, and the browser's own reload is the control the user already knows.
 */
export default function OfflinePage(): ReactNode {
  return (
    <div className="min-h-dvh px-4 py-16">
      <div className="mx-auto flex w-full max-w-md flex-col gap-[var(--gap-loose)]">
        <div className="flex items-center gap-2">
          <span aria-hidden className="size-2 rounded-sm bg-outflow" />
          <span className="text-sm font-medium tracking-tight text-text">Ledger</span>
        </div>

        <Panel>
          <PanelHeader eyebrow="No connection">You are offline.</PanelHeader>
          <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
            <p className="text-sm leading-relaxed text-text-2">
              Ledger needs a connection to show your subscriptions; everything you have entered is
              safe.
            </p>
            <p className="text-sm leading-relaxed text-text-2">
              Nothing about your accounts is stored on this device, so there is nothing to show
              until the connection is back. Reload the page once it is.
            </p>
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}
