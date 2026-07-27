/**
 * Email palette.
 *
 * These values mirror `packages/ui/src/tokens.css`, which is frozen and cannot be imported here:
 * email clients do not support custom properties, external stylesheets, or `@media
 * (prefers-color-scheme)` reliably enough to build on. So every colour is a literal, inlined on
 * the element, and this file is the single place a literal is allowed to appear.
 *
 * The palette's one idea carries over unchanged: amber is money leaving on schedule, red is
 * reserved for problems. A subscription charging the amount it agreed to charge is not a problem,
 * and painting it red is how an alert colour stops meaning anything. Exactly one email in this
 * package uses the alert colour as its accent, and it is the one about a charge that should not
 * have happened.
 */

export const theme = {
  page: '#070a0f',
  panel: '#0c1119',
  raised: '#121a25',

  line: '#1c2430',
  lineStrong: '#28323f',

  text: '#e8f0fa',
  text2: '#9fb2c9',
  text3: '#6d8199',

  control: '#2e7cf6',
  outflow: '#e4a340',
  reclaim: '#35c79a',
  alert: '#f0555f',

  fontSans:
    "'Geist Sans', 'Inter Tight', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  fontMono: "'Geist Mono', ui-monospace, 'SF Mono', 'Cascadia Mono', 'Roboto Mono', monospace",
} as const;

export type Accent = 'outflow' | 'alert' | 'control' | 'reclaim';

export function accentColor(accent: Accent): string {
  return theme[accent];
}
