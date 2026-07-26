import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getAuth } from '~/server/auth';
import { OnboardingFlow } from './onboarding-flow';

export const metadata: Metadata = { title: 'Setup' };

/**
 * Read on the server so the flow opens on the right step on the first paint.
 *
 * Deciding client-side would show step one — the password prompt for a key the user may already
 * have — for as long as the session query takes, which is exactly the moment someone concludes
 * their enrolment did not save.
 */
export default async function OnboardingPage(): Promise<ReactNode> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  // The layout above already redirects, but a page that trusts its layout to have run is a page
  // that breaks the day someone moves it.
  if (session === null) redirect('/sign-in');

  return (
    <OnboardingFlow
      twoFactorEnabled={session.user.twoFactorEnabled === true}
      displayCurrency={session.user.displayCurrency ?? 'USD'}
      timezone={session.user.timezone ?? 'UTC'}
    />
  );
}
