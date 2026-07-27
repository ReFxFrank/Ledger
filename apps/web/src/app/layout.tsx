import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

/**
 * The typefaces named by the frozen tokens.
 *
 * `variable` is set to the token names themselves and the classes go on `<body>`, not `<html>`.
 * That matters: a custom property redeclared on a descendant always wins for that subtree, so
 * the loaded font beats the `:root` declaration in tokens.css without depending on stylesheet
 * order — and without editing the token file, which is frozen.
 *
 * `fallback` repeats the rest of each token's stack, because next/font replaces the family list
 * wholesale and dropping the system fonts would leave nothing behind its own metric fallback.
 */
const geistSans = Geist({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
  fallback: ['Inter Tight', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
  fallback: ['ui-monospace', 'SF Mono', 'Cascadia Mono', 'Roboto Mono', 'monospace'],
});

export const metadata: Metadata = {
  title: { default: 'Ledger', template: '%s · Ledger' },
  description: 'Every recurring charge against your accounts, what it costs, and how to stop it.',
  applicationName: 'Ledger',
  // A map of someone's finances has no business in a search index. The header in next.config.ts
  // says the same thing; both exist because a crawler that ignores one may honour the other.
  robots: { index: false, follow: false, nocache: true },
  formatDetection: { telephone: false, address: false, email: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The layout is dense and reads down to 375px. Zoom stays available — capping it is an
  // accessibility failure, not a polish decision.
  maximumScale: 5,
  colorScheme: 'dark',
  // The one place a colour literal is unavoidable: a meta tag cannot read a custom property.
  // This is `--ink-900`, and it moves when that token moves.
  themeColor: '#070a0f',
};

/**
 * Note there is no `headers()` read here for the CSP nonce. Next stamps its own bootstrap and
 * chunk scripts by reading the policy off the forwarded request (middleware.ts sets it there for
 * exactly this reason), and nothing this tree renders inline needs one — the one element that
 * did, the dark color-scheme style, now lives in tokens.css. If an inline script ever becomes
 * genuinely necessary, read `x-nonce` from headers() and expect React to warn about the
 * attribute on hydration: browsers blank a nonce after applying it.
 */
export default function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <html lang="en" className="dark">
      {/*
        No inline <style> for the dark color-scheme: it lives in tokens.css, which is
        render-blocking, so there is still no white flash. The inline version carried the CSP
        nonce, and browsers blank a nonce attribute after applying it — so hydration diffed the
        server's nonce against "" and React warned on every single page load.
      */}
      <body className={`${geistSans.variable} ${geistMono.variable} min-h-dvh antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
