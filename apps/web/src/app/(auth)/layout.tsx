import type { ReactNode } from 'react';

/**
 * The frame around every auth screen.
 *
 * Same surfaces, same density, same type as the app behind it — a sign-in page that looks like a
 * different product is the last thing someone sees before typing a password into it.
 *
 * `max-w-sm` and vertical padding rather than centring: at 375px with the keyboard open there is
 * no vertical centre to speak of, and a card that starts near the top stays reachable.
 */
export default function AuthLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div className="min-h-dvh px-4 py-10 sm:py-16">
      <div className="mx-auto flex w-full max-w-sm flex-col gap-[var(--gap-loose)]">
        <div className="flex items-center gap-2">
          <span aria-hidden className="size-2 rounded-sm bg-outflow" />
          <span className="text-sm font-medium tracking-tight text-text">Ledger</span>
        </div>
        {children}
      </div>
    </div>
  );
}
