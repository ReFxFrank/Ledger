'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { KeyRound } from 'lucide-react';
import { z } from 'zod';
import { Button, Input, Panel, PanelBody, PanelHeader, Separator } from '@ledger/ui';
import { Field, FormError } from '~/components/auth/field';
import { authClient } from '~/lib/auth-client';
import { authErrorMessage, thrownErrorMessage } from '~/lib/auth-errors';
import { resolvePasskeySignIn } from '~/lib/passkey';

const schema = z.object({
  email: z
    .string()
    .min(1, 'Enter the email address you signed up with.')
    .email('That is not an email address. Check for a missing @ or a typo in the domain.'),
  // No length rule here. The password either matches what is stored or it does not, and telling
  // someone their existing password is too short is a fact they can do nothing with.
  password: z.string().min(1, 'Enter your password.'),
});

type Values = z.infer<typeof schema>;

export function SignInForm({ next }: { readonly next: string }): ReactNode {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);

  // Probed after mount: it depends on the browser, and rendering it on the server would flash a
  // button that then disappears on machines that cannot use it.
  useEffect(() => {
    setPasskeyAvailable(resolvePasskeySignIn() !== null);
  }, []);

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
    // Validate on blur, re-validate as they fix it: shouting at a half-typed email address is
    // the fastest way to make a form feel hostile.
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });

  async function onSubmit(values: Values): Promise<void> {
    setFormError(null);
    try {
      const result = await authClient.signIn.email({
        email: values.email.trim(),
        password: values.password,
      });

      if (result.error !== null) {
        setFormError(
          authErrorMessage(result.error, 'That sign-in did not go through. Check your details and try again.'),
        );
        return;
      }

      /**
       * With a second factor owed, the client plugin navigates to `/sign-in/two-factor` itself.
       * Nothing is reset here on purpose — the button stays busy until the browser leaves, so
       * the form never flickers back to an idle state the user could type into again.
       */
      const data = result.data as unknown as { twoFactorRedirect?: boolean } | null;
      if (data?.twoFactorRedirect === true) return;

      router.replace(next);
      // The shell is a server component reading the session; without this it renders the
      // signed-out branch it already had cached.
      router.refresh();
    } catch (error) {
      setFormError(thrownErrorMessage(error, 'We could not reach the server. Try again in a moment.'));
    }
  }

  async function onPasskey(): Promise<void> {
    const signInWithPasskey = resolvePasskeySignIn();
    if (signInWithPasskey === null) return;

    setFormError(null);
    setPasskeyBusy(true);
    try {
      const result = await signInWithPasskey();
      if (result.error !== null) {
        setFormError(
          authErrorMessage(result.error, 'That passkey was not accepted. Use your email and password instead.'),
        );
        return;
      }
      router.replace(next);
      router.refresh();
    } catch (error) {
      setFormError(thrownErrorMessage(error, 'The passkey prompt did not complete. Try again.'));
    } finally {
      setPasskeyBusy(false);
    }
  }

  return (
    <Panel>
      <PanelHeader eyebrow="Sign in">Pick up where you left off.</PanelHeader>
      <PanelBody>
        <form
          className="flex flex-col gap-[var(--gap-loose)]"
          onSubmit={(event) => void form.handleSubmit(onSubmit)(event)}
          noValidate
        >
          <FormError>{formError}</FormError>

          <Field id="email" label="Email" error={form.formState.errors.email?.message} required>
            {(control) => (
              <Input
                {...control}
                {...form.register('email')}
                type="email"
                autoComplete="username"
                inputMode="email"
                autoFocus
                placeholder="you@example.com"
              />
            )}
          </Field>

          <Field id="password" label="Password" error={form.formState.errors.password?.message} required>
            {(control) => (
              <Input {...control} {...form.register('password')} type="password" autoComplete="current-password" />
            )}
          </Field>

          <Button type="submit" variant="primary" loading={form.formState.isSubmitting}>
            Sign in
          </Button>

          {passkeyAvailable ? (
            <>
              <div className="flex items-center gap-2">
                <Separator className="flex-1" />
                <span className="eyebrow">or</span>
                <Separator className="flex-1" />
              </div>
              <Button type="button" onClick={() => void onPasskey()} loading={passkeyBusy}>
                <KeyRound aria-hidden className="size-4" strokeWidth={1.75} />
                Use a passkey
              </Button>
            </>
          ) : null}
        </form>

        <p className="mt-[var(--pad-card)] text-xs text-text-2">
          No account yet?{' '}
          <Link
            href="/sign-up"
            className="rounded-sm text-control-2 underline underline-offset-2 outline-none hover:text-control focus-visible:[box-shadow:var(--focus-ring)]"
          >
            Create one
          </Link>
          .
        </p>
      </PanelBody>
    </Panel>
  );
}
