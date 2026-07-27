import { expect, test } from './support/fixtures';
import { requireBaseURL } from './support/user';

/**
 * The installable shell: manifest, offline fallback, and the service worker.
 *
 * The last test is the one worth having. Everything else here checks that files exist; that one
 * checks the promise the worker makes — that nothing under /api or /trpc, and no authenticated
 * HTML, ever lands in Cache Storage. A regression there is a data leak on a shared device rather
 * than a broken icon, and it is invisible unless something asserts on it.
 *
 * These run against `next start` (see playwright.config.ts), which is the only mode where the
 * worker registers at all — registration is skipped in development on purpose.
 */

interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose?: string;
}

interface Manifest {
  readonly name: string;
  readonly short_name: string;
  readonly description: string;
  readonly start_url: string;
  readonly display: string;
  readonly background_color: string;
  readonly theme_color: string;
  readonly icons: readonly ManifestIcon[];
}

/** The value of `--ink-900` in packages/ui/src/tokens.css. Both colours must be this. */
const INK_900 = '#070a0f';

test('the manifest is served, parses, and declares the fields an install prompt needs', async ({
  request,
}, testInfo) => {
  const baseURL = requireBaseURL(testInfo);
  const response = await request.get(`${baseURL}/manifest.webmanifest`);
  expect(response.ok()).toBe(true);

  // Parsed from text rather than `response.json()` so a malformed body fails as "not valid JSON"
  // rather than as an opaque Playwright error.
  const manifest = JSON.parse(await response.text()) as Manifest;

  expect(manifest.name).toBe('Ledger');
  expect(manifest.short_name).toBe('Ledger');
  expect(manifest.description.length).toBeGreaterThan(0);
  expect(manifest.start_url).toBe('/');
  expect(manifest.display).toBe('standalone');
  expect(manifest.background_color).toBe(INK_900);
  expect(manifest.theme_color).toBe(INK_900);

  const sizes = manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose ?? 'any'}`);
  expect(sizes).toContain('192x192:any');
  expect(sizes).toContain('512x512:any');
  // A maskable variant, or Android crops the mark out of a plain icon and shows a white plate.
  expect(sizes.some((entry) => entry.endsWith(':maskable'))).toBe(true);

  // Every icon it points at is really there and really a PNG — an install prompt that 404s on
  // its own icon is worse than no manifest.
  for (const icon of manifest.icons) {
    const iconResponse = await request.get(`${baseURL}${icon.src}`);
    expect(iconResponse.ok(), `${icon.src} is missing`).toBe(true);
    expect(iconResponse.headers()['content-type']).toContain('image/png');
    expect((await iconResponse.body()).length).toBeGreaterThan(0);
  }
});

test('the root document links the manifest and a theme colour', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', INK_900);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
});

test('/offline renders without a session and promises nothing it cannot keep', async ({ page }) => {
  await page.goto('/offline');

  // Not redirected to sign-in: the fallback has to render when there is no network to
  // authenticate against.
  await expect(page).toHaveURL(/\/offline$/);
  await expect(page.getByText('You are offline.')).toBeVisible();
  await expect(
    page.getByText(/Ledger needs a connection to show your subscriptions/u),
  ).toBeVisible();
  await expect(page.getByText(/everything you have entered is safe/u)).toBeVisible();
});

test('the service worker registers, and caches build assets but never an API response', async ({
  page,
}) => {
  await page.goto('/offline');

  const scope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.scope;
  });
  expect(scope).toMatch(/\/$/);

  // A second load so the page is controlled and its static requests actually pass through the
  // worker; the visit that installs a worker is not served by it.
  await page.reload();
  await expect
    .poll(async () => page.evaluate(() => navigator.serviceWorker.controller !== null), {
      timeout: 15_000,
    })
    .toBe(true);

  const readCaches = async (): Promise<{ names: string[]; urls: string[] }> =>
    page.evaluate(async () => {
      const names = await caches.keys();
      const urls: string[] = [];
      for (const name of names) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) urls.push(request.url);
      }
      return { names, urls };
    });

  // The worker writes each asset after it has answered with it, so the cache fills a beat behind
  // the load. Polled rather than slept on.
  await expect
    .poll(async () => (await readCaches()).urls.some((url) => url.includes('/_next/static/')), {
      timeout: 15_000,
    })
    .toBe(true);

  const cached = await readCaches();

  // Exactly one cache, and its name carries the version the activate handler prunes against.
  expect(cached.names).toHaveLength(1);
  expect(cached.names.join()).toMatch(/^ledger-shell-v\d+$/u);

  expect(cached.urls.some((url) => url.endsWith('/offline'))).toBe(true);

  // The whole point. Nothing that answers with someone's money, and nothing behind a session.
  const forbidden = cached.urls.filter((url) => /\/(?:api|trpc)\//u.test(new URL(url).pathname));
  expect(forbidden, `these must never be cached: ${forbidden.join(', ')}`).toEqual([]);
});

test('a navigation with no network falls back to /offline rather than to a cached screen', async ({
  page,
  context,
}) => {
  await page.goto('/offline');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect
    .poll(async () => page.evaluate(() => navigator.serviceWorker.controller !== null), {
      timeout: 15_000,
    })
    .toBe(true);

  await context.setOffline(true);
  try {
    // /subscriptions is behind a session and was never cached, so the only honest thing the
    // worker can serve is the fallback.
    await page.goto('/subscriptions');
    await expect(page.getByText('You are offline.')).toBeVisible({ timeout: 15_000 });
  } finally {
    await context.setOffline(false);
  }
});
