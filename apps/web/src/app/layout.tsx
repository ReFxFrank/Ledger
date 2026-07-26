import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { headers } from 'next/headers';
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

export default async function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}): Promise<ReactNode> {
  /**
   * The per-request CSP nonce. Next stamps its own bootstrap and chunk-loading scripts by
   * reading the policy off the forwarded request headers (middleware.ts sets it there for
   * exactly this reason); `x-nonce` is what any script or style *this* tree renders must carry.
   */
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html lang="en" className="dark">
      <head>
        {/*
          Ahead of the stylesheet, so the browser paints scrollbars, native controls and the
          pre-hydration canvas dark instead of flashing white on a slow connection. No colour
          literal — `color-scheme` picks the UA's dark palette, and the page colour is the
          token-driven `body` rule in the stylesheet.
        */}
        <style nonce={nonce}>{'html{color-scheme:dark}'}</style>
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} min-h-dvh antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
