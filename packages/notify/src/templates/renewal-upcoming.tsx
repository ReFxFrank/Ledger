import type { ReactNode } from 'react';
import type { RenderContext, RenewalUpcomingPayload } from '../types';
import { Action, Eyebrow, Facts, Fact, Headline, Layout, Lede } from './layout';
import { amount, amountWithCadence, formatDay, formatDayShort } from './format';

export function subject(payload: RenewalUpcomingPayload, ctx: RenderContext): string {
  return `${payload.subscription.name} renews ${formatDayShort(payload.renewsOn, ctx.locale)} — ${amount(payload.subscription.amount, ctx.locale)}`;
}

export function RenewalUpcomingEmail({
  payload,
  ctx,
  url,
}: {
  payload: RenewalUpcomingPayload;
  ctx: RenderContext;
  url: string;
}): ReactNode {
  const { subscription } = payload;
  return (
    <Layout
      preview={`${amount(subscription.amount, ctx.locale)} on ${formatDay(payload.renewsOn, ctx.locale)}.`}
    >
      <Eyebrow accent="outflow">Renewing soon</Eyebrow>
      <Headline>{subscription.name}</Headline>
      <Lede>Due in {payload.leadTimeDays} days.</Lede>
      <Facts>
        <Fact label="Renews" value={formatDay(payload.renewsOn, ctx.locale)} />
        <Fact
          label="Amount"
          value={amountWithCadence(subscription.amount, subscription.interval, ctx.locale)}
          accent="outflow"
        />
      </Facts>
      <Action href={url} label="Open this subscription" />
    </Layout>
  );
}
