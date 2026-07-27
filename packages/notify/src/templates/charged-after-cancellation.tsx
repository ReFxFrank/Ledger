/**
 * The most important email in the product.
 *
 * A charge landed after the user cancelled. Everything they need to act has to be readable
 * without opening anything: which merchant charged, how much, on what date, when they cancelled,
 * the reference the provider gave them, and where the stored evidence is. It is the only email
 * that uses the alert colour as its accent and the only one that ignores quiet hours.
 *
 * What it deliberately does not say: anything about rights, entitlements, refund guarantees, or
 * what anyone is required to do. It states what happened and points at the record. See
 * docs/legal-notes.md.
 */

import type { ReactNode } from 'react';
import type { ChargedAfterCancellationPayload, RenderContext } from '../types';
import { Action, Eyebrow, Facts, Fact, Footnote, Headline, Layout, Lede } from './layout';
import { amount, formatDay, pluralize } from './format';

export function subject(payload: ChargedAfterCancellationPayload, ctx: RenderContext): string {
  return `${payload.merchantName} charged ${amount(payload.amount, ctx.locale)} after you cancelled`;
}

export function ChargedAfterCancellationEmail({
  payload,
  ctx,
  url,
}: {
  payload: ChargedAfterCancellationPayload;
  ctx: RenderContext;
  url: string;
}): ReactNode {
  const evidence = payload.evidenceCount;
  return (
    <Layout
      preview={`${amount(payload.amount, ctx.locale)} on ${formatDay(payload.chargedOn, ctx.locale)}, after you cancelled on ${formatDay(payload.cancelledOn, ctx.locale)}.`}
    >
      <Eyebrow accent="alert">Charged after cancelling</Eyebrow>
      <Headline>
        {payload.merchantName} charged {amount(payload.amount, ctx.locale)}
      </Headline>
      <Lede>
        This charge landed after the cancellation you recorded. Ledger has not contacted anyone
        about it — the next move is yours, and your record of the cancellation is below.
      </Lede>
      <Facts>
        <Fact label="Merchant" value={payload.merchantName} />
        <Fact label="Amount" value={amount(payload.amount, ctx.locale)} accent="alert" />
        <Fact label="Charged on" value={formatDay(payload.chargedOn, ctx.locale)} accent="alert" />
        <Fact label="You cancelled on" value={formatDay(payload.cancelledOn, ctx.locale)} />
        <Fact
          label="Provider reference"
          value={payload.confirmationReference ?? 'none recorded'}
        />
        <Fact
          label="Evidence stored"
          value={`${evidence} ${pluralize(evidence, 'file', 'files')}`}
        />
      </Facts>
      <Action href={url} label="Open the cancellation record" />
      <Footnote>
        The record holds the date you cancelled, the steps you completed, and anything you
        uploaded. It is the account of what happened, kept in one place.
      </Footnote>
    </Layout>
  );
}
