'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
} from '@ledger/ui';
import { api } from '~/lib/trpc';
import { NAV_ROUTES, isRouteActive, type NavRoute } from './routes';

/**
 * Primary navigation.
 *
 * A rail on the left at 768px and up, a bar along the bottom below it. Not a hamburger: the
 * whole product is a control panel, and hiding the controls behind a menu on the device people
 * check their trials on is the wrong trade. The bar carries the five routes that are decisions;
 * the three that are reference material live behind "More".
 *
 * Everything is a real `<a>` in a real list, so Tab, Enter, and the browser's own find-link
 * behaviour work without a keyboard handler being written for them.
 */

function useReviewCount(): number {
  // The dashboard and the review screen render this same query, so the badge is free on the
  // screens where it matters most — react-query dedupes it inside the 30s stale window.
  //
  // Nothing is rendered until it resolves: a badge that shows 0 while it loads teaches the user
  // the queue is empty, and they stop looking.
  const attention = api.dashboard.attention.useQuery();
  return attention.data?.pendingDetectionCount ?? 0;
}

function CountBadge({ count, className }: { readonly count: number; readonly className?: string }): ReactNode {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        // `--control` and not `--alert`: a queue with items in it is work, not a problem.
        'ml-auto inline-flex min-w-4 items-center justify-center rounded-sm border border-control/35 bg-control-dim',
        'px-1 font-mono text-[0.625rem] leading-4 tabular-nums text-control-2',
        className,
      )}
    >
      {count > 99 ? '99+' : count}
      <span className="sr-only"> waiting</span>
    </span>
  );
}

function railItemClasses(active: boolean): string {
  return cn(
    'group flex items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-[0.8125rem] leading-5',
    'transition-[background-color,border-color,color] duration-[var(--duration-fast)] ease-standard',
    'outline-none focus-visible:[box-shadow:var(--focus-ring)]',
    active
      ? 'border-line-hot bg-ink-600 font-medium text-text'
      : 'border-transparent text-text-2 hover:border-line hover:bg-ink-700 hover:text-text',
  );
}

function RailLink({
  route,
  active,
  count,
}: {
  readonly route: NavRoute;
  readonly active: boolean;
  readonly count: number;
}): ReactNode {
  const Icon = route.icon;
  return (
    <li>
      <Link href={route.href} className={railItemClasses(active)} aria-current={active ? 'page' : undefined}>
        {/*
          A 2px marker on the left edge, not a colour change on the label — the active row has
          to survive being read in greyscale and by someone who cannot separate blue from grey.
        */}
        <span
          aria-hidden
          className={cn(
            '-ml-1 h-4 w-0.5 shrink-0 rounded-sm',
            active ? 'bg-control' : 'bg-transparent',
          )}
        />
        <Icon aria-hidden className="size-4 shrink-0" strokeWidth={active ? 2 : 1.75} />
        <span className="truncate">{route.label}</span>
        {route.badge === 'review' ? <CountBadge count={count} /> : null}
      </Link>
    </li>
  );
}

export function Sidebar(): ReactNode {
  const pathname = usePathname();
  const reviewCount = useReviewCount();

  const primary = NAV_ROUTES.filter((route) => route.secondary !== true);
  const secondary = NAV_ROUTES.filter((route) => route.secondary === true);
  const secondaryActive = secondary.some((route) => isRouteActive(route.href, pathname));

  return (
    <>
      {/* ── the rail, 768px and up ─────────────────────────────────────────────────────── */}
      <nav
        aria-label="Primary"
        className="hidden w-[13rem] shrink-0 flex-col border-r border-line bg-ink-800 md:flex"
      >
        <div className="flex h-12 items-center gap-2 border-b border-line px-[var(--pad-panel)]">
          <span aria-hidden className="size-2 rounded-sm bg-outflow" />
          <span className="text-sm font-medium tracking-tight text-text">Ledger</span>
        </div>

        <ul className="flex flex-col gap-0.5 p-2">
          {primary.map((route) => (
            <RailLink
              key={route.href}
              route={route}
              active={isRouteActive(route.href, pathname)}
              count={reviewCount}
            />
          ))}
        </ul>

        <div className="mx-2 border-t border-line" />

        <ul className="flex flex-col gap-0.5 p-2">
          {secondary.map((route) => (
            <RailLink
              key={route.href}
              route={route}
              active={isRouteActive(route.href, pathname)}
              count={reviewCount}
            />
          ))}
        </ul>
      </nav>

      {/* ── the bar, below 768px ───────────────────────────────────────────────────────── */}
      <nav
        aria-label="Primary"
        className={cn(
          'fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-ink-800 md:hidden',
          // Clears the home indicator on iOS rather than sitting under it.
          'pb-[env(safe-area-inset-bottom)]',
        )}
      >
        {primary.map((route) => {
          const active = isRouteActive(route.href, pathname);
          const Icon = route.icon;
          return (
            <Link
              key={route.href}
              href={route.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex min-w-0 flex-1 flex-col items-center gap-1 px-1 py-2 text-[0.625rem] leading-3',
                'outline-none focus-visible:[box-shadow:var(--focus-ring)]',
                active ? 'text-text' : 'text-text-3',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'absolute inset-x-3 top-0 h-0.5 rounded-sm',
                  active ? 'bg-control' : 'bg-transparent',
                )}
              />
              <span className="relative">
                <Icon aria-hidden className="size-[1.125rem]" strokeWidth={active ? 2 : 1.75} />
                {route.badge === 'review' && reviewCount > 0 ? (
                  <span
                    aria-hidden
                    className="absolute -right-1.5 -top-1 size-1.5 rounded-sm bg-control"
                  />
                ) : null}
              </span>
              <span className="w-full truncate text-center">{route.label}</span>
              {route.badge === 'review' && reviewCount > 0 ? (
                <span className="sr-only">{reviewCount} waiting</span>
              ) : null}
            </Link>
          );
        })}

        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              'relative flex min-w-0 flex-1 flex-col items-center gap-1 px-1 py-2 text-[0.625rem] leading-3',
              'outline-none focus-visible:[box-shadow:var(--focus-ring)]',
              secondaryActive ? 'text-text' : 'text-text-3',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'absolute inset-x-3 top-0 h-0.5 rounded-sm',
                secondaryActive ? 'bg-control' : 'bg-transparent',
              )}
            />
            <MoreHorizontal aria-hidden className="size-[1.125rem]" strokeWidth={1.75} />
            <span>More</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" sideOffset={8} className="min-w-44">
            {secondary.map((route) => {
              const Icon = route.icon;
              return (
                <DropdownMenuItem key={route.href} asChild>
                  <Link href={route.href} aria-current={isRouteActive(route.href, pathname) ? 'page' : undefined}>
                    <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
                    {route.label}
                  </Link>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
    </>
  );
}
