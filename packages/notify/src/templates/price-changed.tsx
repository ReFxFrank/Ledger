/**
 * The price-change email leads with the annualized difference.
 *
 * "£9.99 → £12.99" is a shrug; "£36.00 more a year" is a decision. Both figures were computed by
 * the scheduler with `annualEquivalent`, so a 4-weekly subscription is thirteen charges here and
 * not twelve, and nothing in this component does arithmetic on money.
 */

import type { ReactNode } from 'react';
import type { PriceChangedPayload, RenderContext } from '../types';
import { Action, Eyebrow, Facts, Fact, Headline, Layout, Lede } from './layout';
import { amount, amountWithCadence, formatDay, percentFromBps, signedAmount } from './format';

export function subject(payload: PriceChangedPayload, ctx: RenderContext): string {
  const direction = payload.annualDelta.amountMinor >= 0 ? 'up' : 'down';
  return `${payload.subscription.name} price ${direction} — ${signedAmount(payload.annualDelta, ctx.locale)} a year`;
}

export function PriceChangedEmail({
  payload,
  ctx,
  url,
}: {
  payload: PriceChangedPayload;
  ctx: RenderContext;
  url: string;
}): ReactNode {
  const { subscription } = payload;
  const increased = payload.annualDelta.amountMinor >= 0;
  const accent = increased ? 'outflow' : 'reclaim';

  return (
    <Layout
      preview={`${amount(payload.previousAmount, ctx.locale)} → ${amount(payload.newAmount, ctx.locale)}. That is ${signedAmount(payload.annualDelta, ctx.locale)} a year.`}
    >
      <Eyebrow accent={accent}>Price changed</Eyebrow>
      <Headline>
        {subscription.name}: {signedAmount(payload.annualDelta, ctx.locale)} a year
      </Headline>
      <Lede>
        The charge {increased ? 'went up' : 'went down'} from{' '}
        {amount(payload.previousAmount, ctx.locale)} to {amount(payload.newAmount, ctx.locale)}{' '}
        {payload.deltaBps === null ? '' : `(${percentFromBps(payload.deltaBps)})`}, effective{' '}
        {formatDay(payload.effectiveFrom, ctx.locale)}.
      </Lede>
      <Facts>
        <Fact
          label="Was"
          value={amountWithCadence(payload.previousAmount, subscription.interval, ctx.locale)}
        />
        <Fact
          label="Now"
          value={amountWithCadence(payload.newAmount, subscription.interval, ctx.locale)}
          accent={accent}
        />
        <Fact label="Per year, was" value={amount(payload.previousAnnual, ctx.locale)} />
        <Fact label="Per year, now" value={amount(payload.newAnnual, ctx.locale)} accent={accent} />
        <Fact
          label="Difference"
          value={`${signedAmount(payload.annualDelta, ctx.locale)} a year`}
          accent={accent}
        />
      </Facts>
      <Action href={url} label="Open this subscription" />
    </Layout>
  );
}
