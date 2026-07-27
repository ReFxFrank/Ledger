import type { ReactNode } from 'react';
import type { RenderContext, SyncFailedPayload } from '../types';
import { Action, Eyebrow, Facts, Fact, Footnote, Headline, Layout, Lede } from './layout';
import { formatDay, formatDayShort } from './format';

export function subject(payload: SyncFailedPayload, ctx: RenderContext): string {
  return `${payload.institutionName} hasn't synced since ${formatDayShort(payload.failingSince, ctx.locale)}`;
}

export function SyncFailedEmail({
  payload,
  ctx,
  url,
}: {
  payload: SyncFailedPayload;
  ctx: RenderContext;
  url: string;
}): ReactNode {
  return (
    <Layout preview={`No transactions since ${formatDay(payload.failingSince, ctx.locale)}.`}>
      <Eyebrow accent="alert">Connection problem</Eyebrow>
      <Headline>{payload.institutionName}</Headline>
      <Lede>
        This connection has been failing to sync. Until it is fixed, new charges will not appear
        and renewal dates will drift out of date.
      </Lede>
      <Facts>
        <Fact
          label="Last successful sync"
          value={formatDay(payload.failingSince, ctx.locale)}
          accent="alert"
        />
      </Facts>
      <Action href={url} label="Fix this connection" />
      <Footnote>Reconnecting happens at your bank. Ledger never asks for your bank login.</Footnote>
    </Layout>
  );
}
