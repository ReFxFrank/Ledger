'use client';

import * as React from 'react';
import { api } from '~/lib/trpc';
import { CostPerUse } from './cost-per-use';
import { CadenceMix, CategoryBreakdown } from './mix';
import { CancelSimulator } from './simulator';
import { SpendPanels } from './spend';

/**
 * The analytics screen.
 *
 * Each panel owns its own query rather than the page fetching everything and passing it down.
 * They fail and retry independently, which matters here more than usual: cost-per-use reads
 * usage logs, spend-over-time reads transactions, and the commitment panels read subscriptions —
 * one of those being slow or broken should cost the user that panel, not the screen.
 *
 * `me` is the exception. Locale and display currency are needed by every figure, and reading them
 * once here means one formatter contract for the whole page.
 */
export function AnalyticsDashboard(): React.ReactNode {
  const me = api.me.current.useQuery();
  const locale = me.data?.locale ?? 'en-GB';
  const displayCurrency = me.data?.displayCurrency ?? 'USD';

  return (
    <div className="flex min-w-0 flex-col gap-[var(--gap-loose)]">
      <SpendPanels locale={locale} displayCurrency={displayCurrency} />

      <div className="grid min-w-0 gap-[var(--gap-loose)] xl:grid-cols-2">
        <CategoryBreakdown locale={locale} />
        <CadenceMix locale={locale} />
      </div>

      <CancelSimulator locale={locale} />

      <CostPerUse locale={locale} />
    </div>
  );
}
