'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Check } from 'lucide-react';
import { z } from 'zod';
import { Button, Input, Panel, PanelBody, PanelHeader, cn } from '@ledger/ui';
import { Field, FormError } from '~/components/auth/field';
import { authClient } from '~/lib/auth-client';
import { authErrorMessage, thrownErrorMessage } from '~/lib/auth-errors';

/**
 * 12 characters, matching `emailAndPassword.minPasswordLength` in server/auth.ts.
 *
 * Stated in the form before anything is typed and checked live as it is — a rule a user only
 * learns by failing is a rule the form kept to itself.
 */
const MIN_PASSWORD_LENGTH = 12;

const schema = z.object({
  name: z.string().trim().min(1, 'Enter a name. It is what the app calls you; it is not published.').max(120),
  email: z
    .string()
    .min(1, 'Enter an email address. Alerts about renewals and price changes go there.')
    .email('That is not an email address. Check for a missing @ or a typo in the domain.'),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters. Add a few more.`)
    .max(256, 'That is longer than 256 characters. Shorten it and try again.'),
});

type Values = z.infer<typeof schema>;

export function SignUpForm(): ReactNode {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', email: '', password: '' },
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });

  const password = form.watch('password');
  const longEnough = password.length >= MIN_PASSWORD_LENGTH;

  async function onSubmit(values: Values): Promise<void> {
    setFormError(null);
    try {
      const created = await authClient.signUp.email({
        name: values.name.trim(),
        email: values.email.trim(),
        password: values.password,
      });

      if (created.error !== null) {
        setFormError(
          authErrorMessage(created.error, 'The account could not be created. Check your details and try again.'),
        );
        return;
      }

      /**
       * `autoSignIn` is off on the server, so the account exists but the browser has no session.
       * Signing in here rather than bouncing to /sign-in keeps the one flow that matters
       * unbroken: create the account, then set up the second factor it is required to have.
       */
      const signedIn = await authClient.signIn.email({
        email: values.email.trim(),
        password: values.password,
      });

      if (signedIn.error !== null) {
        setFormError('Your account was created, but signing in failed. Go to sign in and use your new password.');
        return;
      }

      router.replace('/onboarding');
      router.refresh();
    } catch (error) {
      setFormError(thrownErrorMessage(error, 'We could not reach the server. Try again in a moment.'));
    }
  }

  return (
    <Panel>
      <PanelHeader eyebrow="Create account">Start with what is already charging you.</PanelHeader>
      <PanelBody>
        <form
          className="flex flex-col gap-[var(--gap-loose)]"
          onSubmit={(event) => void form.handleSubmit(onSubmit)(event)}
          noValidate
          // Same pre-hydration GET fallback as sign-in-form.tsx: without a method, a submit
          // before hydration navigates with the password in the query string.
          method="post"
        >
          <FormError>{formError}</FormError>

          <Field id="name" label="Name" error={form.formState.errors.name?.message} required>
            {(control) => <Input {...control} {...form.register('name')} autoComplete="name" autoFocus />}
          </Field>

          <Field
            id="email"
            label="Email"
            hint="Where renewal and price-change alerts are sent."
            error={form.formState.errors.email?.message}
            required
          >
            {(control) => (
              <Input
                {...control}
                {...form.register('email')}
                type="email"
                autoComplete="email"
                inputMode="email"
                placeholder="you@example.com"
              />
            )}
          </Field>

          <Field id="password" label="Password" error={form.formState.errors.password?.message} required>
            {(control) => (
              <Input {...control} {...form.register('password')} type="password" autoComplete="new-password" />
            )}
          </Field>

          {/*
            The requirement, live, sitting under the field from the moment the form loads. It
            turns to `--control` when it is met — not `--reclaim`, which belongs to the savings
            counter, and not `--alert` while it is unmet, because a password being half-typed is
            not a problem.
          */}
          <p
            className={cn(
              '-mt-1 flex items-center gap-1.5 text-[0.6875rem] leading-snug',
              longEnough ? 'text-control-2' : 'text-text-3',
            )}
          >
            <Check
              aria-hidden
              className={cn('size-3 shrink-0', longEnough ? 'opacity-100' : 'opacity-30')}
              strokeWidth={2.5}
            />
            <span>
              At least {MIN_PASSWORD_LENGTH} characters
              <span className="font-mono"> ({password.length}/{MIN_PASSWORD_LENGTH})</span>
            </span>
          </p>

          <p className="text-[0.6875rem] leading-snug text-text-2">
            You will set up an authenticator app next. Ledger requires a second factor on every
            account.
          </p>

          <Button type="submit" variant="primary" loading={form.formState.isSubmitting}>
            Create account
          </Button>
        </form>

        <p className="mt-[var(--pad-card)] text-xs text-text-2">
          Already have an account?{' '}
          <Link
            href="/sign-in"
            className="rounded-sm text-control-2 underline underline-offset-2 outline-none hover:text-control focus-visible:[box-shadow:var(--focus-ring)]"
          >
            Sign in
          </Link>
          .
        </p>
      </PanelBody>
    </Panel>
  );
}
