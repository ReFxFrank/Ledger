import { type NextRequest, NextResponse } from 'next/server';

/**
 * Content-Security-Policy with a per-request nonce.
 *
 * Brief §9.9 forbids `unsafe-inline`, which rules out a static CSP header: Next injects inline
 * bootstrap scripts, and the only way to allow exactly those without opening the door to
 * everything is a nonce minted per response and read back in the root layout.
 *
 * `strict-dynamic` lets Next's nonce'd bootstrap load the rest of its chunks without every
 * chunk URL needing to be enumerated.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV !== 'production';

  const csp = [
    `default-src 'self'`,
    // `unsafe-eval` is dev-only: React Refresh needs it, production does not get it.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${isDev ? "'unsafe-eval'" : ''}`,
    // Tailwind v4 emits a style element at runtime; there is no nonce hook for it yet.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data: https:`,
    `font-src 'self' data:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    // Plaid Link is an iframe served from cdn.plaid.com. `strict-dynamic` already covers the
    // script react-plaid-link injects — scripts a trusted script creates are trusted — but frames
    // answer to frame-src, and with no frame-src the `default-src 'self'` fallback blocks the
    // sign-in outright. Nothing else on the product opens a frame, hence exactly these two.
    `frame-src 'self' https://cdn.plaid.com`,
    // The injected Link script talks XHR to the Plaid API origin matching PLAID_ENV — sandbox in
    // local/dev deployments, production in real ones. Both are listed because the CSP is static
    // per build, not per environment, and each origin is Plaid's own.
    `connect-src 'self' https://production.plaid.com https://sandbox.plaid.com ${isDev ? 'ws: http://localhost:*' : ''}`,
    /**
     * These two already cover the PWA, and were checked rather than assumed before adding it:
     * `/sw.js` is same-origin, so `worker-src 'self'` permits `serviceWorker.register`, and
     * `/manifest.webmanifest` is same-origin, so `manifest-src 'self'` permits the `<link
     * rel="manifest">` fetch. Nothing was widened for the service worker.
     *
     * The `blob:` source predates the PWA and is not what permits it: a service worker script
     * must be a same-origin http(s) URL, so `blob:` could not register one even if it were the
     * only source listed.
     *
     * Worth knowing: this same policy lands on the `/sw.js` response, and a service worker
     * inherits the CSP of its own script. That is fine as written. The worker never calls
     * `importScripts` (so the nonce/`strict-dynamic` script-src is moot inside it) and only ever
     * fetches this origin, which `connect-src 'self'` allows.
     */
    `worker-src 'self' blob:`,
    `manifest-src 'self'`,
    `upgrade-insecure-requests`,
  ]
    .filter(Boolean)
    .join('; ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  /**
   * The same policy goes onto the *request*, not just the response. That is the only hook Next
   * has: its renderer reads the request's CSP header to find the nonce and stamps it on the
   * bootstrap and chunk-loading scripts it emits. Without this line the header below is a
   * policy that blocks the app's own scripts.
   */
  headers.set('Content-Security-Policy', csp);
  /**
   * The current path, for server components. A layout cannot read `usePathname`, and the app
   * shell needs to know whether the user is already on the enrolment screen before it decides
   * to redirect them there.
   */
  headers.set('x-pathname', request.nextUrl.pathname);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    // Static assets and image optimisation do not need a CSP and are not worth the middleware hop.
    //
    // `/api/webhooks/*` is deliberately NOT excluded: this middleware does no auth — sessions are
    // enforced in tRPC and the app layouts — so a cookie-less POST from an aggregator passes
    // through untouched and still picks up the security headers. The webhook route does its own
    // authentication by verifying the delivery's signature.
    {
      source: '/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
