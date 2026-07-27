/**
 * The weekly digest. It only ever exists when there is something in it — see digest.ts.
 */

import type { ReactNode } from 'react';
import type { NewDetectionsPayload, RenderContext } from '../types';
import { Action, Eyebrow, Facts, Fact, Headline, Layout, Lede } from './layout';
import { amountWithCadence, pluralize } from './format';

/** Beyond this the email becomes a list to scroll rather than a thing to act on. */
const MAX_LISTED = 10;

export function subject(payload: NewDetectionsPayload, _ctx: RenderContext): string {
  const count = payload.items.length;
  return `${count} new ${pluralize(count, 'subscription', 'subscriptions')} found`;
}

export function NewDetectionsEmail({
  payload,
  ctx,
  url,
}: {
  payload: NewDetectionsPayload;
  ctx: RenderContext;
  url: string;
}): ReactNode {
  const count = payload.items.length;
  const listed = payload.items.slice(0, MAX_LISTED);
  const remaining = count - listed.length;

  return (
    <Layout preview={`${count} to confirm or dismiss.`}>
      <Eyebrow accent="control">Weekly digest</Eyebrow>
      <Headline>
        {count} new {pluralize(count, 'subscription', 'subscriptions')} found
      </Headline>
      <Lede>Confirm the ones that are real; dismiss the rest. Nothing is added until you say so.</Lede>
      <Facts>
        {listed.map((item) => (
          <Fact
            key={item.detectionId}
            label={item.name}
            value={amountWithCadence(item.amount, item.interval, ctx.locale)}
            accent="outflow"
          />
        ))}
        {remaining > 0 ? <Fact label="and" value={`${remaining} more`} /> : null}
      </Facts>
      <Action href={url} label="Review them" />
    </Layout>
  );
}
