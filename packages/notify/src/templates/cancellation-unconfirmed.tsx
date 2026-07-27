import type { ReactNode } from 'react';
import type { CancellationUnconfirmedPayload, RenderContext } from '../types';
import { Action, Eyebrow, Facts, Fact, Footnote, Headline, Layout, Lede } from './layout';
import { formatDay, pluralize } from './format';

export function subject(payload: CancellationUnconfirmedPayload, _ctx: RenderContext): string {
  return `${payload.subscription.name}: no cancellation confirmation recorded`;
}

export function CancellationUnconfirmedEmail({
  payload,
  ctx,
  url,
}: {
  payload: CancellationUnconfirmedPayload;
  ctx: RenderContext;
  url: string;
}): ReactNode {
  const days = payload.daysSinceDeadline;
  return (
    <Layout
      preview={`Nothing recorded since the ${formatDay(payload.deadlineOn, ctx.locale)} deadline.`}
    >
      <Eyebrow accent="alert">Unconfirmed</Eyebrow>
      <Headline>{payload.subscription.name}</Headline>
      <Lede>
        You started cancelling this. The cancel-by date passed {days}{' '}
        {pluralize(days, 'day', 'days')} ago and no confirmation has been recorded against it.
      </Lede>
      <Facts>
        <Fact label="Cancel-by was" value={formatDay(payload.deadlineOn, ctx.locale)} />
        <Fact label="Confirmation" value="none recorded" accent="alert" />
      </Facts>
      <Action href={url} label="Update this cancellation" />
      <Footnote>
        If the provider confirmed it, add the reference or the email — that record is what verifies
        the cancellation later.
      </Footnote>
    </Layout>
  );
}
