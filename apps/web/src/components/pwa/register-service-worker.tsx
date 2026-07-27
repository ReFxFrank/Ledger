'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';

/**
 * Registers apps/web/public/sw.js. Renders nothing.
 *
 * Three gates before anything is registered, in order:
 *
 *  1. **Never in development.** `next dev` serves modules the worker would be delighted to cache
 *     and the dev server would then never be asked for again. Debugging that costs an hour and
 *     teaches nothing.
 *  2. **`NEXT_PUBLIC_DISABLE_SW=1` turns it off for a whole deployment.** Read through the dot
 *     form on purpose: Next replaces `process.env.NEXT_PUBLIC_*` at build time by matching the
 *     member expression, and the bracket form this repo prefers for server env reads is not
 *     rewritten — it would silently evaluate to undefined in the browser.
 *  3. **`?sw=off` turns it off for one person, permanently, on that device.** The preference is
 *     kept in localStorage and re-read on every load; `?sw=on` puts it back. This is the opt-out
 *     that matters on a shared or borrowed machine, and it needs to work for someone who has no
 *     access to the deployment — hence a URL, not a setting behind a sign-in.
 *
 * Opting out is not passive: an already-installed worker is told to drop its caches and
 * unregister. A switch that only stops *new* installs would leave the thing it was flipped to
 * remove still running.
 */

const OPT_OUT_KEY = 'ledger.sw';

/** Reads the switch, applying `?sw=on|off` first so a link can change it. */
function optedOut(): boolean {
  let stored: string | null = null;
  try {
    const wanted = new URL(window.location.href).searchParams.get('sw');
    if (wanted === 'off' || wanted === 'on') {
      window.localStorage.setItem(OPT_OUT_KEY, wanted === 'off' ? 'off' : 'on');
    }
    stored = window.localStorage.getItem(OPT_OUT_KEY);
  } catch {
    // Storage can be unavailable (private mode, a blocked third-party context). Treat that as
    // "no preference expressed" rather than as an opt-out, and carry on.
  }
  return stored === 'off';
}

async function uninstall(): Promise<void> {
  const registrations = await navigator.serviceWorker.getRegistrations();
  for (const registration of registrations) {
    // The worker clears Cache Storage before it unregisters; `unregister()` alone leaves the
    // caches behind, and stale bytes on disk are the thing being opted out of.
    registration.active?.postMessage('ledger:uninstall');
    await registration.unregister();
  }
}

export function RegisterServiceWorker(): ReactNode {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (process.env.NEXT_PUBLIC_DISABLE_SW === '1') return;
    if (!('serviceWorker' in navigator)) return;

    if (optedOut()) {
      void uninstall();
      return;
    }

    /**
     * After `load` rather than on mount: registration competes for the same connection as the
     * chunks and data the first screen is still waiting for, and the shell cache is worth nothing
     * on the visit that fills it.
     */
    const register = (): void => {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // A failed registration is not a failed page load. The app works without the worker —
        // that is the design — so this is deliberately silent rather than a toast about
        // plumbing the user did not ask for.
      });
    };

    if (document.readyState === 'complete') {
      register();
      return;
    }
    window.addEventListener('load', register, { once: true });
    return () => {
      window.removeEventListener('load', register);
    };
  }, []);

  return null;
}
