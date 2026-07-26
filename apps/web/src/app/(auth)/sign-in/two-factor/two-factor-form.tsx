'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Button, Input, Panel, PanelBody, PanelHeader } from '@ledger/ui';
import { CodeInput, isCodeComplete } from '~/components/auth/code-input';
import { Field, FormError } from '~/components/auth/field';
import { authClient } from '~/lib/auth-client';
import { authErrorMessage, thrownErrorMessage } from '~/lib/auth-errors';

type Mode = 'totp' | 'backup';

/**
 * The second factor.
 *
 * The password is already accepted at this point; better-auth is holding a short-lived cookie
 * and no session exists yet. Two ways through: the six digits from the authenticator app, or one
 * of the ten backup codes handed out at enrolment. Both are on this screen because the moment
 * someone needs the second one is the moment they have lost the phone with the first.
 */
export function TwoFactorForm({ next }: { readonly next: string }): ReactNode {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('totp');
  const [code, setCode] = useState('');
  const [backupCode, setBackupCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function succeed(): void {
    router.replace(next);
    router.refresh();
  }

  async function verifyTotp(value: string): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await authClient.twoFactor.verifyTotp({ code: value });
      if (result.error !== null) {
        setError(
          authErrorMessage(
            result.error,
            'That code did not match. Codes change every 30 seconds — wait for the next one and retype it.',
          ),
        );
        // Cleared so the next attempt starts on an empty row rather than needing six backspaces.
        setCode('');
        return;
      }
      succeed();
    } catch (thrown) {
      setError(thrownErrorMessage(thrown, 'We could not reach the server. Try again in a moment.'));
    } finally {
      setBusy(false);
    }
  }

  async function verifyBackup(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await authClient.twoFactor.verifyBackupCode({ code: backupCode.trim() });
      if (result.error !== null) {
        setError(
          authErrorMessage(result.error, 'That backup code did not match. Each one works once; try the next unused code.'),
        );
        return;
      }
      succeed();
    } catch (thrown) {
      setError(thrownErrorMessage(thrown, 'We could not reach the server. Try again in a moment.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel>
      <PanelHeader eyebrow="Two-factor">
        {mode === 'totp' ? 'Enter the code from your authenticator app.' : 'Enter one of your backup codes.'}
      </PanelHeader>
      <PanelBody>
        <div className="flex flex-col gap-[var(--gap-loose)]">
          <FormError>{error}</FormError>

          {mode === 'totp' ? (
            <form
              className="flex flex-col gap-[var(--gap-loose)]"
              onSubmit={(event) => {
                event.preventDefault();
                if (isCodeComplete(code)) void verifyTotp(code);
              }}
            >
              <CodeInput
                id="totp-code"
                label="Six-digit code from your authenticator app"
                value={code}
                onChange={setCode}
                // Submitted on the sixth digit: the button below is for anyone who lands on a
                // filled row after an error, and for people who prefer to confirm.
                onComplete={(value) => void verifyTotp(value)}
                disabled={busy}
                invalid={error !== null}
                autoFocus
              />

              <Button type="submit" variant="primary" loading={busy} disabled={!isCodeComplete(code)}>
                Verify
              </Button>

              <button
                type="button"
                onClick={() => {
                  setMode('backup');
                  setError(null);
                }}
                className="self-start rounded-sm text-xs text-control-2 underline underline-offset-2 outline-none hover:text-control focus-visible:[box-shadow:var(--focus-ring)]"
              >
                Use a backup code instead
              </button>
            </form>
          ) : (
            <form
              className="flex flex-col gap-[var(--gap-loose)]"
              onSubmit={(event) => {
                event.preventDefault();
                if (backupCode.trim() !== '') void verifyBackup();
              }}
            >
              <Field
                id="backup-code"
                label="Backup code"
                hint="One of the ten codes you saved when you set up two-factor. Each works once."
              >
                {(control) => (
                  <Input
                    {...control}
                    mono
                    value={backupCode}
                    onChange={(event) => {
                      setBackupCode(event.target.value);
                    }}
                    autoComplete="one-time-code"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={busy}
                    autoFocus
                  />
                )}
              </Field>

              <Button type="submit" variant="primary" loading={busy} disabled={backupCode.trim() === ''}>
                Verify
              </Button>

              <button
                type="button"
                onClick={() => {
                  setMode('totp');
                  setError(null);
                }}
                className="self-start rounded-sm text-xs text-control-2 underline underline-offset-2 outline-none hover:text-control focus-visible:[box-shadow:var(--focus-ring)]"
              >
                Use my authenticator app instead
              </button>
            </form>
          )}
        </div>

        <p className="mt-[var(--pad-card)] text-xs text-text-2">
          Lost both?{' '}
          <Link
            href="/sign-in"
            className="rounded-sm text-control-2 underline underline-offset-2 outline-none hover:text-control focus-visible:[box-shadow:var(--focus-ring)]"
          >
            Start again
          </Link>{' '}
          and contact support from the address on your account.
        </p>
      </PanelBody>
    </Panel>
  );
}
