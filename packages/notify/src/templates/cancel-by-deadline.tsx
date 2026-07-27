/**
 * The cancel-by date is the date that actually matters: next renewal minus the provider's notice
 * period. The copy states it and stops. It does not promise an outcome and does not say what
 * anyone is required to do — the app never cancels anything itself, and the email says so.
 */

import type { ReactNode } from 'react';
import type { CancelByDeadlinePayload, RenderContext } from '../types';
import { Action, Eyebrow, Facts, Fact, Footnote, Headline, Layout, Lede } from './layout';
import { amountWithCadence, formatDay, formatDayShort, pluralize } from './format';

export function subject(payload: CancelByDeadlinePayload, ctx: RenderContext): string {
  return `${payload.subscription.name}: cancel-by date is ${formatDayShort(payload.deadlineOn, ctx.locale)}`;
}

export function CancelByDeadlineEmail({
  payload,
  ctx,
  url,
}: {
  payload: CancelByDeadlinePayload;
  ctx: RenderContext;
  url: string;
}): ReactNode {
  const { subscription } = payload;
  const days = payload.leadTimeDays;
  return (
    <Layout preview={`Cancel-by ${formatDay(payload.deadlineOn, ctx.locale)}.`}>
      <Eyebrow accent="alert">Cancel-by date</Eyebrow>
      <Headline>{subscription.name}</Headline>
      <Lede>
        {days} {pluralize(days, 'day', 'days')} left. After this date the next billing period
        normally starts.
      </Lede>
      <Facts>
        <Fact label="Cancel by" value={formatDay(payload.deadlineOn, ctx.locale)} accent="alert" />
        <Fact
          label="Otherwise"
          value={amountWithCadence(subscription.amount, subscription.interval, ctx.locale)}
          accent="outflow"
        />
      </Facts>
      <Action href={url} label="Open the cancellation steps" />
      <Footnote>Ledger does not cancel anything for you. The steps are yours to follow.</Footnote>
    </Layout>
  );
}
