'use client';

import * as React from 'react';
import { AlertTriangle, Download, Trash2 } from 'lucide-react';
import { Button, Input, Label, Panel, PanelBody, PanelHeader, toast } from '@ledger/ui';
import { api } from '~/lib/trpc';
import { authClient } from '~/lib/auth-client';
import { isReauthRequired, useSensitiveAction } from '~/components/auth/reauth-dialog';

/**
 * Data export and account deletion.
 *
 * Both procedures are `sensitiveProcedure`, which demands a password confirmation inside the
 * last fifteen minutes — and a session that has only signed in has never confirmed one. These
 * buttons used to surface that rejection as a toast saying "sign in again", which was a dead
 * end: nothing on this screen could confirm a password, so export and deletion were unreachable
 * for every fresh session. `useSensitiveAction` is the same fix the bank-connection buttons got —
 * catch the rejection, collect the password, re-run the click.
 */

function download(filename: string, contents: string, mime: string): void {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoked on the next tick rather than immediately: Safari has not finished reading the blob
  // when the click handler returns, and revoking synchronously produces an empty file.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

export function DataExport(): React.ReactNode {
  const [pending, setPending] = React.useState(false);
  const utils = api.useUtils();
  // Held in a ref rather than closed over: `useSensitiveAction` re-runs the same function after
  // the password dialog, and it must export the format the user originally clicked.
  const kindRef = React.useRef<'json' | 'csv'>('json');

  const runExport = React.useCallback(async (): Promise<void> => {
    setPending(true);
    try {
      const data = await utils.account.exportData.fetch();
      const stamp = data.exportedAt.slice(0, 10);

      if (kindRef.current === 'json') {
        download(`ledger-export-${stamp}.json`, JSON.stringify(data, null, 2), 'application/json');
      } else {
        download(`ledger-subscriptions-${stamp}.csv`, data.csv.subscriptions, 'text/csv');
        if (data.csv.transactions !== '') {
          download(`ledger-transactions-${stamp}.csv`, data.csv.transactions, 'text/csv');
        }
      }
      toast.success('Export downloaded.');
    } catch (error) {
      // A stale re-auth is not a failure — rethrowing hands it to the dialog, which collects
      // the password and runs this again.
      if (isReauthRequired(error)) throw error;
      toast.error('Could not build the export. Try again.');
    } finally {
      setPending(false);
    }
  }, [utils]);

  const { run, dialog } = useSensitiveAction(
    runExport,
    'Exporting hands over everything Ledger holds about you, so it needs a password confirmation first.',
  );

  return (
    <Panel>
      <PanelHeader eyebrow="Your data" title="Export" />
      <PanelBody className="flex flex-col gap-[var(--gap)]">
        <p className="text-text-2 max-w-prose text-xs">
          Everything Ledger holds about you. The JSON is complete and includes your transaction
          history; the CSVs open in a spreadsheet. Bank access tokens are never included — an export
          ends up in a downloads folder, and a sealed token is still a token.
        </p>
        <div className="flex flex-wrap gap-[var(--gap-tight)]">
          <Button
            variant="secondary"
            size="sm"
            loading={pending}
            onClick={() => {
              kindRef.current = 'json';
              run();
            }}
          >
            <Download aria-hidden className="size-3.5" />
            Download JSON
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={pending}
            onClick={() => {
              kindRef.current = 'csv';
              run();
            }}
          >
            <Download aria-hidden className="size-3.5" />
            Download CSV
          </Button>
        </div>
      </PanelBody>
      {dialog}
    </Panel>
  );
}

export function DangerZone({ email }: { readonly email: string }): React.ReactNode {
  const [confirm, setConfirm] = React.useState('');
  const [blockedBy, setBlockedBy] = React.useState<string | null>(null);

  const remove = api.account.deleteAccount.useMutation();

  const runDelete = React.useCallback(async (): Promise<void> => {
    try {
      await remove.mutateAsync({ confirmEmail: confirm, force: blockedBy !== null });
      /**
       * The user row's cascade already took the session row, but the *signed cookie cache*
       * keeps asserting a session for up to five minutes — long enough for the app shell to
       * keep rendering as if the account still existed. Signing out clears the cookies; the
       * server-side half of it may fail (the session it would revoke is already gone), and
       * that is fine.
       */
      try {
        await authClient.signOut();
      } catch {
        // The account is gone; so is the session it would have revoked.
      }
      window.location.href = '/sign-in?deleted=1';
    } catch (error) {
      // Same contract as the export above: the re-auth rejection belongs to the dialog.
      if (isReauthRequired(error)) throw error;

      const shaped = error as { data?: { code?: string }; message?: string };
      // PRECONDITION_FAILED means an upstream disconnect failed and the account was left
      // intact. That is not a generic failure — the message names which banks could not be
      // disconnected, so show it verbatim.
      if (shaped.data?.code === 'PRECONDITION_FAILED' && typeof shaped.message === 'string') {
        setBlockedBy(shaped.message);
        return;
      }
      toast.error(shaped.message ?? 'Could not delete the account. Try again.');
    }
  }, [blockedBy, confirm, remove]);

  const { run, dialog } = useSensitiveAction(
    runDelete,
    'Deleting your account is irreversible, so it needs a password confirmation first.',
  );

  const matches = confirm.trim().toLowerCase() === email.toLowerCase();

  return (
    <Panel className="border-alert/25">
      <PanelHeader eyebrow="Danger zone" title="Delete account" />
      <PanelBody className="flex flex-col gap-[var(--gap)]">
        <p className="text-text-2 max-w-prose text-xs">
          This removes your subscriptions, transaction history, detections, cancellation records and
          uploaded evidence. It cannot be undone, and there is no backup we can restore from. Export
          first if you want a copy.
        </p>

        {blockedBy !== null && (
          <p
            role="alert"
            className="border-alert/30 bg-alert-dim text-text flex items-start gap-2 rounded-[var(--radius)] border p-3 text-xs"
          >
            <AlertTriangle aria-hidden className="text-alert mt-px size-3.5 shrink-0" />
            <span>{blockedBy}</span>
          </p>
        )}

        <div className="flex max-w-sm flex-col gap-1.5">
          <Label htmlFor="confirm-delete">
            Type <span className="text-text font-mono">{email}</span> to confirm
          </Label>
          <Input
            id="confirm-delete"
            value={confirm}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setConfirm(event.target.value);
            }}
            aria-describedby="confirm-delete-hint"
          />
          <p id="confirm-delete-hint" className="text-text-3 text-[11px]">
            Typing your address is the confirmation — there is no second dialog.
          </p>
        </div>

        <div>
          <Button
            variant="danger"
            size="sm"
            disabled={!matches}
            loading={remove.isPending}
            onClick={run}
          >
            <Trash2 aria-hidden className="size-3.5" />
            {blockedBy === null ? 'Delete my account' : 'Delete anyway'}
          </Button>
        </div>
      </PanelBody>
      {dialog}
    </Panel>
  );
}
