import type { ReactNode } from 'react';
import type { ConsentExpiringPayload, RenderContext } from '../types';
import { Action, Eyebrow, Facts, Fact, Footnote, Headline, Layout, Lede } from './layout';
import { formatDay, formatDayShort, pluralize } from './format';

export function subject(payload: ConsentExpiringPayload, ctx: RenderContext): string {
  return `${payload.institutionName} access expires ${formatDayShort(payload.expiresOn, ctx.locale)}`;
}

export function ConsentExpiringEmail({
  payload,
  ctx,
  url,
}: {
  payload: ConsentExpiringPayload;
  ctx: RenderContext;
  url: string;
}): ReactNode {
  const days = payload.leadTimeDays;
  return (
    <Layout preview={`Renew before ${formatDay(payload.expiresOn, ctx.locale)} to keep the feed running.`}>
      <Eyebrow accent="outflow">Access expiring</Eyebrow>
      <Headline>{payload.institutionName}</Headline>
      <Lede>
        The access you granted this bank runs out in {days} {pluralize(days, 'day', 'days')}. When
        it does, transactions stop arriving until you renew it.
      </Lede>
      <Facts>
        <Fact label="Expires" value={formatDay(payload.expiresOn, ctx.locale)} accent="outflow" />
      </Facts>
      <Action href={url} label="Renew access" />
      <Footnote>Renewing happens at your bank. Ledger never asks for your bank login.</Footnote>
    </Layout>
  );
}
