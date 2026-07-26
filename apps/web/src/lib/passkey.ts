'use client';

import { PASSKEY_ENABLED, authClient } from './auth-client';

/**
 * Passkey sign-in, behind a capability check.
 *
 * The button is not rendered unless passkeys are actually wired up. A sign-in affordance that
 * throws is worse than one that is absent, because the user tries it first and concludes their
 * account is the problem.
 *
 * The check cannot be structural: better-auth's client is a dynamic path proxy, so
 * `authClient.signIn.passkey` is a function whether or not the plugin is registered, and calling
 * it would just POST at a route that does not exist. `PASSKEY_ENABLED` in auth-client.ts is the
 * declared answer and lives beside the plugin list so the two move together.
 */

export interface PasskeySignInResult {
  readonly error: { readonly message?: string | undefined } | null;
}

type PasskeySignIn = (options?: { autoFill?: boolean }) => Promise<PasskeySignInResult>;

/** Whether the browser can do WebAuthn at all. Safari in a cross-origin iframe cannot. */
function browserSupportsWebAuthn(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function';
}

/** The passkey sign-in call, or `null` when passkeys are off in this build or this browser. */
export function resolvePasskeySignIn(): PasskeySignIn | null {
  if (!PASSKEY_ENABLED || !browserSupportsWebAuthn()) return null;
  const candidate = (authClient.signIn as unknown as Record<string, unknown>).passkey;
  return typeof candidate === 'function' ? (candidate as PasskeySignIn) : null;
}
