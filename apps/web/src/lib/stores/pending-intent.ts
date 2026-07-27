'use client';

/**
 * Intents raised on one screen and consumed on another.
 *
 * The command palette can say "add a subscription" from the analytics page, and the form that
 * satisfies that request lives inside the subscriptions table's own state. A query parameter
 * would be the obvious carrier, but `useSearchParams` opts the whole route out of static
 * rendering and has to be wrapped in its own Suspense boundary; an event on `window` loses the
 * message entirely, because the listener mounts a navigation *after* it was dispatched.
 *
 * So: a one-shot flag, set before the navigation and consumed by whoever can act on it. Nothing
 * is persisted — an intent that survives a page reload is an intent the user has forgotten
 * raising, and a form that opens by itself the next morning is a bug with a plausible story.
 */

import { create } from 'zustand';

interface PendingIntentStore {
  /** Set when something asked for the "add a subscription" form it cannot open itself. */
  readonly newSubscription: boolean;
  readonly requestNewSubscription: () => void;
  /** Read-and-clear. Returns whether the caller should act. */
  readonly takeNewSubscription: () => boolean;
}

export const usePendingIntent = create<PendingIntentStore>()((set, get) => ({
  newSubscription: false,

  requestNewSubscription: () => {
    set({ newSubscription: true });
  },

  takeNewSubscription: () => {
    if (!get().newSubscription) return false;
    set({ newSubscription: false });
    return true;
  },
}));
