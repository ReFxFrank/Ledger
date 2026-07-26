'use client';

import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  plugins: [
    twoFactorClient({
      /**
       * Fired when a password checks out but the second factor is still owed.
       *
       * A full navigation rather than a router push: there is no session yet, so nothing in
       * memory is worth preserving. `next` is carried across by hand — it is the screen the
       * user originally asked for, and losing it here would drop them on the dashboard after
       * they finish the one step that stood between them and where they were going.
       */
      onTwoFactorRedirect() {
        const next = new URLSearchParams(window.location.search).get('next');
        const suffix = next === null ? '' : `?next=${encodeURIComponent(next)}`;
        window.location.href = `/sign-in/two-factor${suffix}`;
      },
    }),
  ],
});

export const { signIn, signUp, signOut, useSession, twoFactor } = authClient;

/**
 * Whether passkeys are wired up.
 *
 * It has to be declared rather than detected. The client is a dynamic path proxy — reading
 * `authClient.signIn.passkey` returns a function whether or not the plugin exists, and calling
 * it would POST to an endpoint that is not there. So this constant lives next to the plugin
 * array and moves with it.
 *
 * Currently false: better-auth split the passkey plugin into `@better-auth/passkey` at 1.6 and
 * that package is not in the lockfile. Add it, register `passkeyClient()` above and `passkey()`
 * in server/auth.ts, then flip this — the sign-in button appears on its own.
 */
export const PASSKEY_ENABLED = false;
