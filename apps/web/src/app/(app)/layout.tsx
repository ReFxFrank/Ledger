import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '~/components/nav/app-shell';
import { getAuth } from '~/server/auth';

/**
 * The authenticated shell.
 *
 * Two gates, in order:
 *
 *  1. **No session → `/sign-in`**, carrying where they were headed so the round trip lands them
 *     back on the screen they asked for rather than on the dashboard.
 *  2. **No second factor → `/onboarding`.** TOTP is mandatory (brief §9.2), and enrolment is
 *     step one of onboarding. Until it is done the shell renders *without* the navigation: every
 *     link would bounce straight back here, and offering eight of them is a maze, not a menu.
 *
 * This is routing, not security. `protectedProcedure` refuses every unverified caller server
 * side, so the worst a missed redirect can do is show an empty frame — which is why the unknown
 * pathname case below falls through to rendering instead of risking a redirect loop.
 */
export default async function AppLayout({
  children,
}: {
  readonly children: ReactNode;
}): Promise<ReactNode> {
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });

  // Set by middleware. Absent on requests that skip middleware (prefetches), which is why it is
  // read defensively rather than assumed.
  const pathname = requestHeaders.get('x-pathname');

  if (session === null) {
    const next = pathname === null || pathname === '/' ? null : `?next=${encodeURIComponent(pathname)}`;
    redirect(`/sign-in${next ?? ''}`);
  }

  if (session.user.twoFactorEnabled !== true) {
    if (pathname !== null && !pathname.startsWith('/onboarding')) redirect('/onboarding');
    return <div className="min-h-dvh">{children}</div>;
  }

  return (
    <AppShell name={session.user.name} email={session.user.email}>
      {children}
    </AppShell>
  );
}
