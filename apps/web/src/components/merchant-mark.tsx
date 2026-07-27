'use client';

import * as React from 'react';
import { cn } from '@ledger/ui';

export interface MerchantMarkProps {
  readonly name: string;
  readonly logoUrl?: string | null;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}

/**
 * The merchant logo, or its initial.
 *
 * The fallback is not a nicety: logo hosts are third-party and a broken image in a dense list
 * shifts every row beside it. `onError` swaps to the initial in place, at the same size, so a
 * host having a bad day costs the layout nothing.
 */
export function MerchantMark({
  name,
  logoUrl = null,
  size = 'md',
  className,
}: MerchantMarkProps): React.ReactNode {
  const [failed, setFailed] = React.useState(false);
  const box = size === 'sm' ? 'size-5 text-[0.6875rem]' : 'size-7 text-xs';
  const initial = name.trim().charAt(0).toUpperCase();

  if (logoUrl === null || logoUrl === '' || failed) {
    return (
      <span
        aria-hidden
        className={cn(
          'grid shrink-0 place-items-center rounded-sm border border-line bg-ink-700 font-medium text-text-2',
          box,
          className,
        )}
      >
        {initial === '' ? '?' : initial}
      </span>
    );
  }

  return (
    <img
      src={logoUrl}
      alt=""
      loading="lazy"
      onError={() => {
        setFailed(true);
      }}
      className={cn('shrink-0 rounded-sm border border-line bg-ink-700 object-contain', box, className)}
    />
  );
}
