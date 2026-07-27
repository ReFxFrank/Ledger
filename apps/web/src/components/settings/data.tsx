'use client';

import * as React from 'react';
import { AlertTriangle, Download, Trash2 } from 'lucide-react';
import {
  Button,
  Input,
  Label,
  Panel,
  PanelBody,
  PanelHeader,
  toast,
} from '@ledger/ui';
import { api } from '~/lib/trpc';

/**
 * Data export and account deletion.
 *
 * Both procedures behind these buttons are `sensitiveProcedure`, so a stale session gets a
 * REAUTH_REQUIRED rather than a silent failure. That is surfaced as an instruction, not as
 * "something went wrong".
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

function reauthMessage(error: unknown): string | null {
  const cause = (error as { data?: { ledgerCode?: string } } | undefined)?.data;
  const message = (error as { message?: string } | undefined)?.message ?? '';
  if (cause?.ledgerCode === 'FORBIDDEN' || message.includes('Confirm your password')) {
    return 'Sign in again to confirm it is you, then try once more.';
  }
  return null;
}

export function DataExport(): React.ReactNode {
  const [pending, setPending] = React.useState(false);
  const utils = api.useUtils();

  const run = async (kind: 'json' | 'csv'): Promise<void> => {
    setPending(true);
    try {
      const data = await utils.account.exportData.fetch();
      const stamp = data.exportedAt.slice(0, 10);

      if (kind === 'json') {
        download(`ledger-export-${stamp}.json`, JSON.stringify(data, null, 2), 'application/json');
      } else {
        download(`ledger-subscriptions-${stamp}.csv`, data.csv.subscriptions, 'text/csv');
        if (data.csv.transactions !== '') {
          download(`ledger-transactions-${stamp}.csv`, data.csv.transactions, 'text/csv');
        }
      }
      toast.success('Export downloaded.');
    } catch (error) {
      toast.error(reauthMessage(error) ?? 'Could not build the export. Try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <Panel>
      <PanelHeader eyebrow="Your data" title="Export" />
      <PanelBody className="flex flex-col gap-[var(--gap)]">
        <p className="max-w-prose text-xs text-text-2">
          Everything Ledger holds about you. The JSON is complete and includes your transaction
          history; the CSVs open in a spreadsheet. Bank access tokens are never included — an
          export ends up in a downloads folder, and a sealed token is still a token.
        </p>
        <div className="flex flex-wrap gap-[var(--gap-tight)]">
          <Button
            variant="secondary"
            size="sm"
            loading={pending}
            onClick={() => {
              void run('json');
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
              void run('csv');
            }}
          >
            <Download aria-hidden className="size-3.5" />
            Download CSV
          </Button>
        </div>
      </PanelBody>
    </Panel>
  );
}

export function DangerZone({ email }: { readonly email: string }): React.ReactNode {
  const [confirm, setConfirm] = React.useState('');
  const [blockedBy, setBlockedBy] = React.useState<string | null>(null);

  const remove = api.account.deleteAccount.useMutation({
    onSuccess: () => {
      window.location.href = '/sign-in?deleted=1';
    },
    onError: (error) => {
      // PRECONDITION_FAILED means connected banks would have been orphaned. That is not a
      // generic failure — it names what the user has to do first, so show it verbatim.
      if (error.data?.code === 'PRECONDITION_FAILED') {
        setBlockedBy(error.message);
        return;
      }
      toast.error(reauthMessage(error) ?? error.message);
    },
  });

  const matches = confirm.trim().toLowerCase() === email.toLowerCase();

  return (
    <Panel className="border-alert/25">
      <PanelHeader eyebrow="Danger zone" title="Delete account" />
      <PanelBody className="flex flex-col gap-[var(--gap)]">
        <p className="max-w-prose text-xs text-text-2">
          This removes your subscriptions, transaction history, detections, cancellation records
          and uploaded evidence. It cannot be undone, and there is no backup we can restore from.
          Export first if you want a copy.
        </p>

        {blockedBy !== null && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-[var(--radius)] border border-alert/30 bg-alert-dim p-3 text-xs text-text"
          >
            <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0 text-alert" />
            <span>{blockedBy}</span>
          </p>
        )}

        <div className="flex max-w-sm flex-col gap-1.5">
          <Label htmlFor="confirm-delete">
            Type <span className="font-mono text-text">{email}</span> to confirm
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
          <p id="confirm-delete-hint" className="text-[11px] text-text-3">
            Typing your address is the confirmation — there is no second dialog.
          </p>
        </div>

        <div>
          <Button
            variant="danger"
            size="sm"
            disabled={!matches}
            loading={remove.isPending}
            onClick={() => {
              remove.mutate({ confirmEmail: confirm, force: blockedBy !== null });
            }}
          >
            <Trash2 aria-hidden className="size-3.5" />
            {blockedBy === null ? 'Delete my account' : 'Delete anyway'}
          </Button>
        </div>
      </PanelBody>
    </Panel>
  );
}
