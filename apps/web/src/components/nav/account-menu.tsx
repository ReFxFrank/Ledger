'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Settings, ShieldCheck } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
  toast,
} from '@ledger/ui';
import { authClient } from '~/lib/auth-client';
import { thrownErrorMessage } from '~/lib/auth-errors';

export interface AccountMenuProps {
  readonly name: string;
  readonly email: string;
}

/** Up to two letters from the name, falling back to the email when the name is a single word. */
function initials(name: string, email: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const first = parts[0]?.[0];
  const second = parts[1]?.[0];
  if (first !== undefined && second !== undefined) return (first + second).toUpperCase();
  if (first !== undefined) return first.toUpperCase();
  return (email[0] ?? '?').toUpperCase();
}

export function AccountMenu({ name, email }: AccountMenuProps): ReactNode {
  const [signingOut, setSigningOut] = useState(false);
  const queryClient = useQueryClient();

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await authClient.signOut();
      // The cache holds this person's subscriptions and bank descriptors. Clearing it before the
      // navigation means a shared machine cannot show the next user a flash of the last one's data.
      queryClient.clear();
      // A hard navigation, not a router push: every provider above should be rebuilt from zero.
      window.location.href = '/sign-in';
    } catch (error) {
      setSigningOut(false);
      toast.error(thrownErrorMessage(error, 'Could not sign out. Check your connection and try again.'));
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-md border border-line-strong bg-ink-700',
          'font-mono text-[0.6875rem] leading-none text-text-2 outline-none',
          'transition-[border-color,color] duration-[var(--duration-fast)] ease-standard',
          'hover:border-line-hot hover:text-text focus-visible:[box-shadow:var(--focus-ring)]',
        )}
        aria-label={`Account: ${name}`}
      >
        <span aria-hidden>{initials(name, email)}</span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={8} className="min-w-56">
        <div className="px-2 py-1.5">
          <p className="truncate text-[0.8125rem] leading-tight text-text">{name}</p>
          <p className="truncate font-mono text-[0.6875rem] leading-tight text-text-3">{email}</p>
        </div>
        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings/security">
            <ShieldCheck aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
            Security
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onSelect={(event) => {
            // Radix closes the menu on select and would unmount the handler mid-request.
            event.preventDefault();
            void signOut();
          }}
        >
          <LogOut aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
