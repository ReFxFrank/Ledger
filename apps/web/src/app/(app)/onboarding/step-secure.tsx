'use client';

import { useState, type ReactNode } from 'react';
import { Check, Copy, Download, ShieldCheck, Smartphone } from 'lucide-react';
import { Button, Checkbox, Input, Label, toast } from '@ledger/ui';
import { CodeInput, isCodeComplete } from '~/components/auth/code-input';
import { Field, FormError } from '~/components/auth/field';
import { TotpQr } from '~/components/auth/totp-qr';
import { authClient } from '~/lib/auth-client';
import { authErrorMessage, thrownErrorMessage } from '~/lib/auth-errors';

/**
 * Step one: the second factor.
 *
 * Mandatory (brief §9.2), so there is no skip on this step — and it is first because it is the
 * one thing that has to be true before the account is worth filling with a map of someone's
 * finances.
 *
 * Four states, in order: prove it is you, save what we just generated, prove the app works, done.
 * The middle state exists on its own rather than sharing a screen with the code entry, because
 * the backup codes are shown exactly once and a user racing to type six digits does not read them.
 */
type Stage = 'password' | 'save' | 'verify';

/** Base32 in groups of four — the shape a person can retype without losing their place. */
function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/gu) ?? [secret]).join(' ');
}

/**
 * The shared secret, out of the `otpauth://` URI.
 *
 * Parsed with `URL` and backed by a regex: `otpauth` is a non-special scheme, and while every
 * current browser parses it, an authenticator key is not the thing to lose to a parser quirk.
 */
function secretFromUri(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    const value = parsed.searchParams.get('secret');
    if (value !== null && value !== '') return value;
  } catch {
    // Fall through to the regex below rather than failing the whole step.
  }
  const match = /[?&]secret=([^&]+)/u.exec(uri);
  return match?.[1] ?? null;
}

export function StepSecure({ onDone }: { readonly onDone: () => void }): ReactNode {
  const [stage, setStage] = useState<Stage>('password');
  const [password, setPassword] = useState('');
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<readonly string[]>([]);
  const [saved, setSaved] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const secret = totpUri === null ? null : secretFromUri(totpUri);

  async function enable(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await authClient.twoFactor.enable({ password });
      if (result.error !== null) {
        setError(authErrorMessage(result.error, 'That password was not accepted. Try again.'));
        return;
      }
      setTotpUri(result.data.totpURI);
      setBackupCodes(result.data.backupCodes);
      // Not kept in state a moment longer than the request needs it.
      setPassword('');
      setStage('save');
    } catch (thrown) {
      setError(thrownErrorMessage(thrown, 'We could not reach the server. Try again in a moment.'));
    } finally {
      setBusy(false);
    }
  }

  async function verify(value: string): Promise<void> {
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
        setCode('');
        return;
      }
      toast('Two-factor is on.');
      onDone();
    } catch (thrown) {
      setError(thrownErrorMessage(thrown, 'We could not reach the server. Try again in a moment.'));
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied.`);
    } catch {
      toast.error(`Could not reach the clipboard. Select the ${what.toLowerCase()} and copy it by hand.`);
    }
  }

  function download(): void {
    const body = [
      'Ledger backup codes',
      'Each code works once. Keep them somewhere you can reach without your phone.',
      '',
      ...backupCodes,
      '',
    ].join('\n');

    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'ledger-backup-codes.txt';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-[var(--gap-loose)]">
      <FormError>{error}</FormError>

      {stage === 'password' ? (
        <form
          className="flex flex-col gap-[var(--gap-loose)]"
          onSubmit={(event) => {
            event.preventDefault();
            if (password !== '') void enable();
          }}
        >
          <p className="text-sm leading-relaxed text-text-2">
            Ledger requires an authenticator app on every account. Confirm your password to
            generate a key.
          </p>
          <Field id="current-password" label="Password" required>
            {(control) => (
              <Input
                {...control}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
                autoFocus
              />
            )}
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={password === ''} className="self-start">
            Generate key
          </Button>
        </form>
      ) : null}

      {stage === 'save' && totpUri !== null ? (
        <div className="flex flex-col gap-[var(--pad-card)]">
          <section className="flex flex-col gap-[var(--gap)]">
            <p className="eyebrow">1 — Add the key to your authenticator</p>
            <p className="text-sm leading-relaxed text-text-2">
              Open your authenticator app and scan the code, or add an account by entering a key
              and type the one beside it. On a phone, the button opens the app directly.
            </p>

            <div className="flex flex-col gap-[var(--pad-card)] rounded-md border border-line bg-ink-900 p-[var(--pad-card)] sm:flex-row sm:items-start">
              {/*
                The QR is generated in the browser from the URI the server just returned. It is
                decoration for anyone who cannot point a camera at this screen — the key beside it
                is the real content, and it is what the screen reader is given.
              */}
              <TotpQr uri={totpUri} className="w-full max-w-[11rem] shrink-0 rounded-sm" />

              <div className="flex min-w-0 flex-col gap-[var(--gap-tight)]">
                <p className="eyebrow">Setup key</p>
                <p className="break-all font-mono text-sm leading-relaxed tracking-wide text-text">
                  {secret === null ? 'Key unavailable — use the button below instead.' : groupSecret(secret)}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-[var(--gap-tight)]">
              {secret === null ? null : (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    void copy(secret, 'Setup key');
                  }}
                >
                  <Copy aria-hidden className="size-3.5" strokeWidth={1.75} />
                  Copy key
                </Button>
              )}
              <Button asChild size="sm">
                <a href={totpUri}>
                  <Smartphone aria-hidden className="size-3.5" strokeWidth={1.75} />
                  Open in authenticator app
                </a>
              </Button>
            </div>

            <p className="text-[0.6875rem] leading-snug text-text-3">
              Setting up on a different device? Type the key by hand — it is the same secret the
              QR code carries.
            </p>
          </section>

          <section className="flex flex-col gap-[var(--gap)] border-t border-line pt-[var(--pad-card)]">
            <p className="eyebrow">2 — Save your backup codes</p>
            <p className="text-sm leading-relaxed text-text-2">
              These are shown once. They are how you get in if you lose the phone — which, for
              this account, is also the record of what is charging your card.
            </p>

            <ul className="grid grid-cols-2 gap-1.5 rounded-md border border-line bg-ink-900 p-[var(--pad-card)]">
              {backupCodes.map((backupCode) => (
                <li key={backupCode} className="font-mono text-[0.8125rem] leading-6 tracking-wide text-text">
                  {backupCode}
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap gap-[var(--gap-tight)]">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  void copy(backupCodes.join('\n'), 'Backup codes');
                }}
              >
                <Copy aria-hidden className="size-3.5" strokeWidth={1.75} />
                Copy all
              </Button>
              <Button type="button" size="sm" onClick={download}>
                <Download aria-hidden className="size-3.5" strokeWidth={1.75} />
                Download
              </Button>
            </div>

            <div className="flex items-start gap-2 pt-1">
              <Checkbox
                id="saved-codes"
                checked={saved}
                onCheckedChange={(next) => {
                  setSaved(next === true);
                }}
                className="mt-0.5"
              />
              <Label htmlFor="saved-codes" className="text-xs leading-snug text-text-2">
                I have saved these backup codes somewhere I can reach without my phone.
              </Label>
            </div>

            <Button
              type="button"
              variant="primary"
              disabled={!saved}
              onClick={() => {
                setStage('verify');
                setError(null);
              }}
              className="self-start"
            >
              Continue
            </Button>
          </section>
        </div>
      ) : null}

      {stage === 'verify' ? (
        <form
          className="flex flex-col gap-[var(--gap-loose)]"
          onSubmit={(event) => {
            event.preventDefault();
            if (isCodeComplete(code)) void verify(code);
          }}
        >
          <p className="eyebrow">3 — Prove it works</p>
          <p className="text-sm leading-relaxed text-text-2">
            Enter the six digits your authenticator app is showing now.
          </p>

          <CodeInput
            id="enrol-code"
            label="Six-digit code from your authenticator app"
            value={code}
            onChange={setCode}
            onComplete={(value) => void verify(value)}
            disabled={busy}
            invalid={error !== null}
            autoFocus
          />

          <div className="flex flex-wrap items-center gap-[var(--gap-tight)]">
            <Button type="submit" variant="primary" loading={busy} disabled={!isCodeComplete(code)}>
              Turn on two-factor
            </Button>
            <button
              type="button"
              onClick={() => {
                setStage('save');
                setError(null);
              }}
              className="rounded-sm text-xs text-control-2 underline underline-offset-2 outline-none hover:text-control focus-visible:[box-shadow:var(--focus-ring)]"
            >
              Show the key and codes again
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

/** The already-done state, for anyone revisiting onboarding after enrolling. */
export function StepSecureDone({ onDone }: { readonly onDone: () => void }): ReactNode {
  return (
    <div className="flex flex-col gap-[var(--gap-loose)]">
      <p className="flex items-center gap-2 text-sm text-text">
        <ShieldCheck aria-hidden className="size-4 shrink-0 text-control-2" strokeWidth={1.75} />
        Two-factor is on for this account.
      </p>
      <p className="text-sm leading-relaxed text-text-2">
        You can regenerate backup codes or change authenticator apps in Settings, under Security.
      </p>
      <Button type="button" variant="primary" onClick={onDone} className="self-start">
        <Check aria-hidden className="size-4" strokeWidth={1.75} />
        Continue
      </Button>
    </div>
  );
}
