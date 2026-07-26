import {
  BarChart3,
  CalendarDays,
  CreditCard,
  Inbox,
  LayoutDashboard,
  Link2,
  Settings,
  Slash,
  type LucideIcon,
} from 'lucide-react';

/**
 * The navigation, in one table.
 *
 * Both the sidebar and the mobile bar read it, and so does the top bar when it needs a title for
 * the current route — three places deriving the same fact from three lists is how a rename ships
 * half-applied.
 *
 * Order is the order of the work: what is happening, what you own, what needs a decision, when
 * it lands, what you are getting out of, what it costs, where it comes from, and settings last.
 */
export interface NavRoute {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Which badge count applies, if any. The sidebar resolves the number. */
  readonly badge?: 'review';
  /** Kept out of the phone bar, which fits five targets before they stop being tappable. */
  readonly secondary?: boolean;
}

export const NAV_ROUTES: readonly NavRoute[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/subscriptions', label: 'Subscriptions', icon: CreditCard },
  { href: '/review', label: 'Review', icon: Inbox, badge: 'review' },
  { href: '/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/cancellations', label: 'Cancellations', icon: Slash },
  { href: '/analytics', label: 'Analytics', icon: BarChart3, secondary: true },
  { href: '/connections', label: 'Connections', icon: Link2, secondary: true },
  { href: '/settings', label: 'Settings', icon: Settings, secondary: true },
];

/**
 * Whether a route owns the current path.
 *
 * `/` is matched exactly — a prefix test would light the dashboard up on every screen in the
 * app. Everything else matches its own subtree so `/subscriptions/<id>` keeps the parent lit.
 */
export function isRouteActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The title for a path, or null when nothing in the table claims it. */
export function routeTitle(pathname: string): string | null {
  const match = NAV_ROUTES.find((route) => isRouteActive(route.href, pathname));
  return match?.label ?? null;
}
