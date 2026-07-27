import { after } from 'next/server';
import { DrizzleSyncStore } from '@ledger/banking';
import { SystemClock } from '@ledger/core';
import { Scope, getDatabase } from '@ledger/db';
import { applyItemEvent, handleWebhookRequest } from '~/server/banking/webhooks';
import { getAdapter, runConnectionSync } from '~/server/banking/runtime';

/**
 * The aggregator's webhook endpoint (`/api/webhooks/plaid`).
 *
 * Unauthenticated by design — Plaid holds no session — which is why the *only* thing standing
 * between the internet and a sync is the adapter's signature verification, and why that runs
 * before a single field of the body is read. Under `AGGREGATOR=fixture` the same route serves
 * the fixture adapter (its `handleWebhook` verifies `x-fixture-signature` when
 * `PLAID_WEBHOOK_SECRET` is set), so the path is exercisable without Plaid credentials.
 *
 * Only POST is exported: Next answers 405 to everything else on its own.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  // The raw bytes, read once, before any parsing. Every signature scheme worth having commits
  // to the body exactly as sent, and a JSON round-trip does not preserve those bytes.
  const rawBody = await request.text();

  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const { db } = getDatabase();
  const clock = new SystemClock();

  return handleWebhookRequest(
    {
      adapter: getAdapter(),
      store: new DrizzleSyncStore(db),
      clock,
      defer: deferAfterResponse,
      // The same inline sync the tRPC mutations run — see `runtime.ts` for why there is no
      // queue. The Scope is built from the connection the verified item id resolved to, which
      // is the only identity an inbound delivery carries.
      sync: async (userId, connectionId) => {
        await runConnectionSync({ db, scope: new Scope(db, userId), clock }, connectionId);
      },
      applyItemEvent: (userId, connectionId, event) =>
        applyItemEvent(db, clock, userId, connectionId, event),
    },
    rawBody,
    headers,
  );
}

/**
 * Runs `work` after the response has been sent.
 *
 * Plaid times out at 10 seconds and a backfill can take longer, so the sync must not sit inside
 * the request. `after()` is Next's `waitUntil`: the runtime keeps the handler alive past the
 * response. Outside a Next request scope — vitest, a script — `after` throws synchronously, and
 * the fallback detaches the promise instead. Either way the work cannot produce an unhandled
 * rejection, because `handleWebhookRequest` wraps everything it defers in its own catch.
 */
function deferAfterResponse(work: () => Promise<void>): void {
  try {
    after(work);
  } catch (cause) {
    void cause;
    void work();
  }
}
