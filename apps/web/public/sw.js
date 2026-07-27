/// <reference lib="webworker" />
/**
 * Ledger's service worker. App shell only.
 *
 * ── The one decision that matters ────────────────────────────────────────────────────────
 *
 * NOTHING under /api or /trpc is ever cached, and no HTML that a signed-in user sees is ever
 * cached. Not with a short TTL, not "just the dashboard", not stale-while-revalidate. Two
 * separate reasons, and each is sufficient on its own:
 *
 *  1. **A cached page is a data leak on a shared device.** The Cache Storage for an origin is not
 *     partitioned by session. Sign out, hand the laptop to a flatmate, and a cached
 *     /subscriptions is served to them from disk — no cookie, no server round trip, no way for
 *     the server to refuse. Every authorisation decision this product makes happens in tRPC
 *     against `ctx.scope`; a cache hit skips all of it. The one screen this worker is allowed to
 *     store is /offline, which is signed-out, static, and contains nothing about anybody.
 *
 *  2. **A cached API response is stale money.** These endpoints report what is charging someone
 *     right now, and what a cancellation did. Showing yesterday's answer with today's confidence
 *     is worse than showing an error: the user acts on it. If the network is down, the honest
 *     output is "we could not reach the server", which the app already renders.
 *
 * What is left is the part that carries no user data and is safe to serve from disk: Next's
 * content-hashed build output under /_next/static, the icons, and the manifest. Those are
 * immutable — the URL changes when the bytes change — so a cache hit cannot be stale, and the
 * shell paints instantly on a bad connection instead of hanging on a spinner.
 *
 * Navigations are network-only with /offline as the failure path. A navigation is never served
 * from the cache even when a copy happens to exist, because the copy that exists is /offline.
 */

// Bump on any change to this file or to what it precaches. `activate` deletes everything else,
// so an old shell cannot outlive the deploy that replaced it.
const CACHE = 'ledger-shell-v1';

const OFFLINE_URL = '/offline';

/**
 * Fetched at install so the fallback is on disk before the first network failure. Kept to the
 * fallback page and the marks it may show — anything larger is a slower install for a page most
 * users never see.
 */
const PRECACHE = [OFFLINE_URL, '/manifest.webmanifest', '/icons/icon-192.png'];

/** Path prefixes safe to serve from disk: immutable build output and static brand assets. */
const CACHEABLE_PREFIXES = ['/_next/static/', '/icons/'];

/** Everything the worker must never touch, whatever else matches. */
const NEVER_CACHE_PREFIXES = ['/api/', '/trpc/'];

function isNeverCached(pathname) {
  return NEVER_CACHE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isCacheableAsset(pathname) {
  if (pathname === '/manifest.webmanifest') return true;
  return CACHEABLE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await self.caches.open(CACHE);
      // Individually rather than `addAll`, which rejects the whole install if any single entry
      // 404s. A shell that installed without one icon still serves the offline page.
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            const response = await fetch(url, { cache: 'reload', credentials: 'omit' });
            if (response.ok) await cache.put(url, response);
          } catch {
            // Installing during a network blip is not a reason to refuse to install; the fetch
            // handler falls back to the network and the next activation tries again.
          }
        }),
      );
      // The new worker replaces the old one on next load rather than waiting for every tab to
      // close. Safe here because the worker holds no state a page depends on — only immutable
      // assets, keyed by a cache name that changes with the code.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await self.caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => self.caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET, and only this origin. A POST is an action, and another origin's response is not
  // ours to keep. Returning without `respondWith` hands the request straight back to the browser.
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (isNeverCached(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          // The network is gone. Serve the signed-out fallback — never a cached copy of wherever
          // they were going, which is the whole point of the note at the top of this file.
          //
          // `ignoreVary` because Next varies its HTML on the router's RSC headers, and the
          // precache stored this page under a bare URL with none of them set.
          const cache = await self.caches.open(CACHE);
          const cached = await cache.match(OFFLINE_URL, { ignoreVary: true });
          if (cached !== undefined) return cached;
          return new Response('You are offline.', {
            status: 503,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        }
      })(),
    );
    return;
  }

  if (!isCacheableAsset(url.pathname)) return;

  event.respondWith(
    (async () => {
      const cache = await self.caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached !== undefined) return cached;

      const response = await fetch(request);
      // Only a clean, complete, same-origin response goes in. An opaque or partial one would be
      // replayed later as though it had succeeded.
      if (response.ok && response.type === 'basic') {
        await cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});

/**
 * The escape hatch the page uses when a user opts out: drop every cache, then unregister. The
 * client half is in apps/web/src/components/pwa/register-service-worker.tsx.
 */
self.addEventListener('message', (event) => {
  if (event.data !== 'ledger:uninstall') return;
  event.waitUntil(
    (async () => {
      const names = await self.caches.keys();
      await Promise.all(names.map((name) => self.caches.delete(name)));
      await self.registration.unregister();
    })(),
  );
});
