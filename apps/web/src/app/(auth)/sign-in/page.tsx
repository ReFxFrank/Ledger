import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { safeNextPath } from '~/lib/safe-next-path';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const params = await searchParams;
  const raw = params.next;
  // An array means the parameter was repeated — a shape only a crafted link produces, so it is
  // dropped rather than guessed at.
  const next = safeNextPath(typeof raw === 'string' ? raw : null);

  return <SignInForm next={next} />;
}
