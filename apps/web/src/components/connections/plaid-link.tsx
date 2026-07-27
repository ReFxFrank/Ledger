'use client';

import * as React from 'react';
import {
  type PlaidLinkError,
  type PlaidLinkOnExitMetadata,
  type PlaidLinkOnSuccessMetadata,
  usePlaidLink,
} from 'react-plaid-link';
import { Button, Spinner } from '@ledger/ui';
import { api } from '~/lib/trpc';
import type { ConnectResult } from '~/lib/api-types';

/**
 * The Plaid half of the handoff `link-cta.tsx` plans for.
 *
 * By the time this mounts, `createLinkSession` has already run — behind the re-auth dialog, which
 * is why nothing here prompts for a password — and produced a link token. `usePlaidLink` injects
 * Plaid's script (permitted by `strict-dynamic`; the iframe it opens is what needed `frame-src` in
 * the middleware) and this component opens their UI as soon as the SDK reports ready. The user
 * signs in at their bank inside Plaid's iframe; Ledger sees none of it, only the single-use public
 * token that comes back.
 *
 * The exchange that follows is the long part: `exchangeToken` runs the 24-month backfill inline in
 * the request — see `~/server/banking/runtime` — so the waiting copy says what is actually
 * happening rather than showing a progress number nothing is measuring.
 *
 * Exit is two different events wearing one callback: with an error it is a failure worth
 * explaining and retrying, without one it is the user deciding not to connect — which is a
 * decision, not a fault, and renders nothing at all.
 */

type Stage =
  /** Plaid's script is loading or its UI is on screen. Plaid owns the pixels; we show a status. */
  | { readonly kind: 'link' }
  /** `exchangeToken` is running the exchange plus the inline backfill. */
  | { readonly kind: 'importing' }
  /** The parent has been told and will unmount us. */
  | { readonly kind: 'done' }
  /**
   * `at` decides what "try again" means: `link` reopens Plaid's UI, `exchange` re-runs the
   * exchange with the same public token (idempotent on `(provider, item id)`, so a resume, not a
   * duplicate), and `script` has nothing to retry — the SDK never arrived.
   */
  | { readonly kind: 'failed'; readonly at: 'script' | 'link' | 'exchange'; readonly message: string };

export interface PlaidLinkProps {
  readonly linkToken: string;
  /** Set when the user came from "reconnect" and the institution is already known. */
  readonly institutionId?: string;
  /** The exchange and backfill finished. The parent shows the summary and unmounts this. */
  readonly onConnected: (result: ConnectResult) => void;
  /** The user closed Link without connecting, or gave up on a failure. Not an error. */
  readonly onCancel: () => void;
}

export function PlaidLink({
  linkToken,
  institutionId,
  onConnected,
  onCancel,
}: PlaidLinkProps): React.ReactNode {
  const utils = api.useUtils();
  const exchange = api.connections.exchangeToken.useMutation();

  const [stage, setStage] = React.useState<Stage>({ kind: 'link' });

  // Held for retry. A public token is single-use only once *successfully* exchanged, so after a
  // failed mutation the same token is the right thing to send again.
  const pendingExchange = React.useRef<{
    readonly publicToken: string;
    readonly institutionId: string | undefined;
  } | null>(null);

  const runExchange = React.useCallback(
    async (publicToken: string, institution: string | undefined) => {
      pendingExchange.current = { publicToken, institutionId: institution };
      setStage({ kind: 'importing' });
      try {
        const result = await exchange.mutateAsync({
          publicToken,
          // Spread rather than `?? undefined`: `exactOptionalPropertyTypes` distinguishes an
          // absent key from an undefined one, and the input schema wants absence.
          ...(institution === undefined ? {} : { institutionId: institution }),
        });
        // Both queries, because the point of connecting is that /review now has something in it.
        // Invalidating only the connection list would leave the review badge stale until a reload.
        await Promise.all([utils.connections.list.invalidate(), utils.review.list.invalidate()]);
        setStage({ kind: 'done' });
        onConnected(result);
      } catch (error) {
        setStage({
          kind: 'failed',
          at: 'exchange',
          message: error instanceof Error ? error.message : 'The import failed.',
        });
      }
    },
    [exchange, onConnected, utils],
  );

  const onSuccess = React.useCallback(
    (publicToken: string | null, metadata: PlaidLinkOnSuccessMetadata) => {
      if (publicToken === null || publicToken === '') {
        // The v5 types allow a null token, and without one there is nothing to exchange.
        setStage({
          kind: 'failed',
          at: 'link',
          message: 'Plaid finished without returning a token. Try connecting again.',
        });
        return;
      }
      // The prop wins when set: a reconnect already knows its institution, and the metadata is
      // the fallback that names the bank the user just picked.
      void runExchange(publicToken, institutionId ?? metadata.institution?.institution_id);
    },
    [institutionId, runExchange],
  );

  const onExit = React.useCallback(
    (error: PlaidLinkError | null, metadata: PlaidLinkOnExitMetadata) => {
      void metadata;
      if (error === null) {
        // Closing the picker is a decision, not a failure. Nothing to show, nothing to retry.
        onCancel();
        return;
      }
      setStage({
        kind: 'failed',
        at: 'link',
        // `display_message` is Plaid's user-facing wording when they have one; `error_message`
        // is developer-facing but still safe, and beats a blank box.
        message: error.display_message ?? error.error_message,
      });
    },
    [onCancel],
  );

  const { open, ready, error: scriptError } = usePlaidLink({ token: linkToken, onSuccess, onExit });

  // Open Plaid's UI the moment the SDK is ready, exactly once — the user already clicked
  // "connect"; making them click a second button to open the thing they asked for is a speed bump.
  // Later opens (retry after a Link error) go through the button below instead.
  const openedOnce = React.useRef(false);
  React.useEffect(() => {
    if (ready && !openedOnce.current) {
      openedOnce.current = true;
      open();
    }
  }, [ready, open]);

  React.useEffect(() => {
    if (scriptError !== null) {
      setStage({
        kind: 'failed',
        at: 'script',
        message:
          'Plaid’s sign-in script could not be loaded. Check your connection, then start the connection again.',
      });
    }
  }, [scriptError]);

  const retry = React.useCallback(() => {
    if (stage.kind !== 'failed') return;
    if (stage.at === 'exchange' && pendingExchange.current !== null) {
      const held = pendingExchange.current;
      void runExchange(held.publicToken, held.institutionId);
      return;
    }
    setStage({ kind: 'link' });
    open();
  }, [stage, runExchange, open]);

  if (stage.kind === 'done') return null;

  if (stage.kind === 'failed') {
    return (
      <div
        role="alert"
        className="rounded-md border border-alert/35 bg-alert-dim p-[var(--pad-card)] text-xs"
      >
        <p className="text-text">{stage.message}</p>
        {stage.at === 'exchange' ? (
          <p className="mt-1.5 text-text-2">
            Your bank link was made; the import stopped partway. Trying again resumes it rather
            than starting over.
          </p>
        ) : null}
        <div className="mt-[var(--gap-loose)] flex flex-wrap gap-[var(--gap-tight)]">
          {stage.at !== 'script' ? (
            <Button size="sm" variant="secondary" onClick={retry}>
              Try again
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <p
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 text-[0.6875rem] text-text-2"
    >
      <Spinner className="size-3" />
      {stage.kind === 'importing'
        ? // Honest copy, no percentage: the backfill is one long mutation and nothing in it
          // reports progress — a bar here would be decoration pretending to be measurement.
          'Importing your history — this runs once and can take a minute.'
        : 'Opening your bank’s sign-in…'}
    </p>
  );
}
