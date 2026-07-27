import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AnalyticsDashboard } from '~/components/analytics/dashboard';

export const metadata: Metadata = {
  title: 'Analytics',
  description: 'What it costs, where it goes, and what dropping it would give back.',
};

/**
 * Analytics.
 *
 * Every commitment figure here comes from the same aggregation as the dashboard totals and the
 * subscriptions table, so the numbers reconcile by construction rather than by luck. The one
 * figure that does not is spend over time, which reads posted transactions — money that actually
 * left, rather than money promised, and a deliberately different question.
 */
export default function AnalyticsPage(): ReactNode {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[1400px] flex-col gap-[var(--gap-loose)] p-[var(--pad-panel)]">
      <header className="min-w-0">
        <p className="eyebrow">Analytics</p>
        <h1 className="mt-1 text-lg font-medium leading-tight text-text">What it actually costs</h1>
        <p className="mt-1.5 max-w-prose text-xs text-text-2">
          Every chart carries its own numbers — press “Show numbers” on any of them. Amounts are
          never converted between currencies, because there is no rate table yet and a converted
          total would be a guess wearing a fact&rsquo;s clothes.
        </p>
      </header>

      <AnalyticsDashboard />
    </div>
  );
}
