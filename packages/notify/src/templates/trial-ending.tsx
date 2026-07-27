import type { ReactNode } from 'react';
import type { RenderContext, TrialEndingPayload } from '../types';
import { Action, Eyebrow, Facts, Fact, Headline, Layout, Lede } from './layout';
import { amount, amountWithCadence, formatDay, formatDayShort } from './format';

export function subject(payload: TrialEndingPayload, ctx: RenderContext): string {
  return `${payload.subscription.name} trial ends ${formatDayShort(payload.trialEndsOn, ctx.locale)} — then ${amount(payload.subscription.amount, ctx.locale)}`;
}

export function TrialEndingEmail({
  payload,
  ctx,
  url,
}: {
  payload: TrialEndingPayload;
  ctx: RenderContext;
  url: string;
}): ReactNode {
  const { subscription } = payload;
  return (
    <Layout
      preview={`Ends ${formatDay(payload.trialEndsOn, ctx.locale)}, then ${amountWithCadence(subscription.amount, subscription.interval, ctx.locale)}.`}
    >
      <Eyebrow accent="outflow">Trial ending</Eyebrow>
      <Headline>{subscription.name}</Headline>
      <Lede>
        The trial ends in {payload.leadTimeDays} days. Unless you cancel before then, the first
        charge follows automatically.
      </Lede>
      <Facts>
        <Fact label="Trial ends" value={formatDay(payload.trialEndsOn, ctx.locale)} />
        <Fact
          label="Then"
          value={amountWithCadence(subscription.amount, subscription.interval, ctx.locale)}
          accent="outflow"
        />
      </Facts>
      <Action href={url} label="Open this subscription" />
    </Layout>
  );
}
