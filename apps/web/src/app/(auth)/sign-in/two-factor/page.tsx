import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { safeNextPath } from '~/lib/safe-next-path';
import { TwoFactorForm } from './two-factor-form';

export const metadata: Metadata = { title: 'Two-factor' };

export default async function TwoFactorPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const params = await searchParams;
  const raw = params.next;
  const next = safeNextPath(typeof raw === 'string' ? raw : null);

  return <TwoFactorForm next={next} />;
}
