'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { routeTitle } from './routes';

/**
 * The title shown in the top bar.
 *
 * Most screens are a nav route and the table in `routes.ts` already knows their name. The ones
 * that are not — a subscription detail page, a single cancellation — call `usePageTitle` and
 * the bar says "Netflix" instead of "Subscriptions". Keeping it in context rather than in a
 * layout prop is what lets a leaf component own the answer without every layer above it
 * threading a string it does not care about.
 */
interface PageTitleValue {
  readonly title: string | null;
  readonly setTitle: (title: string | null) => void;
}

const PageTitleContext = createContext<PageTitleValue | null>(null);

export function PageTitleProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [title, setTitle] = useState<string | null>(null);
  const value = useMemo<PageTitleValue>(() => ({ title, setTitle }), [title]);
  return <PageTitleContext.Provider value={value}>{children}</PageTitleContext.Provider>;
}

/** Sets the top-bar title for as long as the calling component is mounted. */
export function usePageTitle(title: string | null): void {
  const context = useContext(PageTitleContext);
  const setTitle = context?.setTitle;

  useEffect(() => {
    if (setTitle === undefined) return;
    setTitle(title);
    // Cleared on unmount so a navigation away from a detail page does not leave its name in the
    // bar while the next screen loads.
    return () => {
      setTitle(null);
    };
  }, [setTitle, title]);
}

/** What the bar should render: an explicit override, else the route's own name. */
export function useResolvedPageTitle(): string {
  const context = useContext(PageTitleContext);
  const pathname = usePathname();
  return context?.title ?? routeTitle(pathname) ?? 'Ledger';
}
