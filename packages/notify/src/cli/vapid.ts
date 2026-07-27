/**
 * `pnpm --filter @ledger/notify vapid:generate`
 *
 * Prints a fresh VAPID keypair in .env form. Generated once and kept: rotating the public key
 * invalidates every push subscription in `push_subscriptions`, because a browser's subscription
 * is bound to the key it was created with. Every device then has to re-subscribe, and until it
 * does, its endpoint answers 410 — which the push channel treats as dead and deletes.
 *
 * The private key is printed to stdout and nowhere else. It is not written to a file, not logged
 * through the application logger, and not stored.
 */

import process from 'node:process';
import webpush from 'web-push';
import { describeError } from '@ledger/core';

function main(): void {
  const keys = webpush.generateVAPIDKeys();

  console.log('VAPID keypair generated. Add these to .env and keep the private key out of git.\n');
  console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
  console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
  console.log('VAPID_SUBJECT=mailto:you@example.com');
  console.log(`\nNEXT_PUBLIC_VAPID_PUBLIC_KEY=${keys.publicKey}`);
  console.log(
    '\nThe public key is needed in both places: the server signs with the private key, the\n' +
      'browser subscribes with the public one. They must match or every push is rejected.\n' +
      'Replacing an existing keypair invalidates every device already subscribed.',
  );
}

try {
  main();
  process.exitCode = 0;
} catch (error) {
  console.error(`vapid:generate failed: ${describeError(error).message}`);
  process.exitCode = 1;
}
