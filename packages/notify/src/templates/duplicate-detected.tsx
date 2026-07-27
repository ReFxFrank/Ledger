import type { ReactNode } from 'react';
import type { DuplicateDetectedPayload, RenderContext } from '../types';
import { Action, Eyebrow, Facts, Fact, Headline, Layout, Lede } from './layout';
import { amountWithCadence } from './format';

export function subject(payload: DuplicateDetectedPayload, _ctx: RenderContext): string {
  const names = payload.subscriptions.map((s) => s.name);
  const [first, second] = names;
  return first === undefined || second === undefined
    ? 'Two subscriptions look like the same service'
    : `${first} and ${second} look like the same service`;
}

export function DuplicateDetectedEmail({
  payload,
  ctx,
  url,
}: {
  payload: DuplicateDetectedPayload;
  ctx: RenderContext;
  url: string;
}): ReactNode {
  return (
    <Layout preview="Two charges that may be the same service.">
      <Eyebrow accent="outflow">Possible overlap</Eyebrow>
      <Headline>You may be paying twice</Headline>
      <Lede>
        These are charging separately and look like the same service. If that is deliberate,
        dismiss this and it will not come back.
      </Lede>
      <Facts>
        {payload.subscriptions.map((item) => (
          <Fact
            key={item.subscriptionId}
            label={item.name}
            value={amountWithCadence(item.amount, item.interval, ctx.locale)}
            accent="outflow"
          />
        ))}
      </Facts>
      <Action href={url} label="Compare them" />
    </Layout>
  );
}
