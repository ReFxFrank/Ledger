'use client';

import { createAuthClient } from 'better-auth/react';
import { passkeyClient, twoFactorClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  plugins: [
    twoFactorClient({
      onTwoFactorRedirect() {
        window.location.href = '/sign-in/two-factor';
      },
    }),
    passkeyClient(),
  ],
});

export const { signIn, signUp, signOut, useSession } = authClient;
