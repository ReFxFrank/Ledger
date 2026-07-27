'use client';

import * as React from 'react';
import { ShieldCheck } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@ledger/ui';
import { api } from '~/lib/trpc';

/**
 * The "confirm your password" step for sensitive actions.
 *
 * This exists because the gate did not: `sensitiveProcedure` rejected connecting a bank,
 * exporting data, and deleting an account with "Confirm your password to continue" — and there
 * was nothing anywhere in the app that could confirm a password. The instruction was a dead end.
 *
 * The design goal is that a caller never has to think about it. `useSensitiveAction` wraps a
 * mutation, catches the specific rejection, opens this dialog, and re-runs the original action
 * on success — so from the user's side the click they made simply asks for a password and then
 * does what they asked.
 */

/** better-auth and tRPC both surface this as FORBIDDEN; the cause is what makes it specific. */
export function isReauthRequired(error: unknown): boolean {
  const shaped = error as { data?: { code?: string }; message?: string } | null | undefined;
  return (
    shaped?.data?.code === 'FORBIDDEN' &&
    typeof shaped.message === 'string' &&
    shaped.message.startsWith('Confirm your password')
  );
}

export function ReauthDialog({
  open,
  onOpenChange,
  onConfirmed,
  reason,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirmed: () => void;
  /** What the user was trying to do, so the prompt explains itself. */
  readonly reason?: string | undefined;
}): React.ReactNode {
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const reauth = api.me.reauthenticate.useMutation({
    onSuccess: () => {
      setPassword('');
      setError(null);
      onOpenChange(false);
      onConfirmed();
    },
    onError: (mutationError) => {
      setError(mutationError.message);
    },
  });

  // Clearing on close matters: the dialog is reopened by whatever the user clicks next, and a
  // password left in state would be sitting in memory across unrelated actions.
  React.useEffect(() => {
    if (!open) {
      setPassword('');
      setError(null);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm it&rsquo;s you</DialogTitle>
          <DialogDescription>
            {reason ??
              'This action can expose or destroy data, so it needs a password confirmation first.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-[var(--gap)]"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            reauth.mutate({ password });
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reauth-password">Password</Label>
            <Input
              id="reauth-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              aria-invalid={error !== null}
              aria-describedby={error === null ? undefined : 'reauth-error'}
            />
            {error !== null && (
              <p id="reauth-error" role="alert" className="text-xs text-alert">
                {error}
              </p>
            )}
          </div>

          <p className="flex items-start gap-2 text-[11px] text-text-3">
            <ShieldCheck aria-hidden className="mt-px size-3.5 shrink-0" />
            <span>Confirming lasts 15 minutes. You will not be asked again during that time.</span>
          </p>

          <div className="flex justify-end gap-[var(--gap-tight)]">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={reauth.isPending} disabled={password === ''}>
              Confirm
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Wraps an action that may need a fresh password confirmation.
 *
 * Usage:
 *   const { run, dialog } = useSensitiveAction(() => connect.mutateAsync({ ... }));
 *   <Button onClick={run}>Connect a bank</Button>
 *   {dialog}
 *
 * The pending action is held in a ref rather than state so re-running it after confirmation does
 * not depend on a render having happened first.
 */
export function useSensitiveAction(action: () => Promise<unknown>, reason?: string): {
  run: () => void;
  dialog: React.ReactNode;
} {
  const [open, setOpen] = React.useState(false);
  const pending = React.useRef<(() => Promise<unknown>) | null>(null);

  const attempt = React.useCallback(
    (fn: () => Promise<unknown>) => {
      void fn().catch((error: unknown) => {
        if (isReauthRequired(error)) {
          pending.current = fn;
          setOpen(true);
          return;
        }
        // Anything else is the caller's to handle — its own mutation's onError already ran.
      });
    },
    [],
  );

  const run = React.useCallback(() => {
    attempt(action);
  }, [action, attempt]);

  const dialog = (
    <ReauthDialog
      open={open}
      onOpenChange={setOpen}
      reason={reason}
      onConfirmed={() => {
        const retry = pending.current;
        pending.current = null;
        if (retry !== null) attempt(retry);
      }}
    />
  );

  return { run, dialog };
}
