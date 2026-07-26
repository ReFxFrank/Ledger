'use client';

/**
 * Saved views for the subscriptions table.
 *
 * This store holds **ephemeral UI state only** — which filters are on, what the table is sorted
 * and grouped by. Not one subscription lives here. Server state stays in TanStack Query, where
 * it can be invalidated, refetched and rolled back; duplicating it into a persisted store is how
 * a user ends up looking at a price from three weeks ago because localStorage won a race.
 *
 * Everything persisted is a plain JSON shape rather than a TanStack type, because a saved view
 * outlives the library version that wrote it.
 */

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { type StateStorage, createJSONStorage, persist } from 'zustand/middleware';

/** A per-column filter. `string` for the text filter on name, `string[]` for the faceted ones. */
export type ViewFilterValue = string | readonly string[];

export interface ViewFilter {
  readonly id: string;
  readonly value: ViewFilterValue;
}

export interface ViewSort {
  readonly id: string;
  readonly desc: boolean;
}

/** The complete shape of "what the table is showing right now". */
export interface ViewSnapshot {
  readonly search: string;
  readonly filters: readonly ViewFilter[];
  readonly sorting: readonly ViewSort[];
  readonly grouping: readonly string[];
  readonly includeArchived: boolean;
}

export interface SavedView extends ViewSnapshot {
  readonly id: string;
  readonly name: string;
}

export const EMPTY_SNAPSHOT: ViewSnapshot = {
  search: '',
  filters: [],
  sorting: [{ id: 'nextCharge', desc: false }],
  grouping: [],
  includeArchived: false,
};

interface ViewStore {
  readonly views: readonly SavedView[];
  /** Which saved view the table last applied. Cleared as soon as the user changes anything. */
  readonly activeViewId: string | null;
  readonly saveView: (name: string, snapshot: ViewSnapshot) => void;
  readonly replaceView: (id: string, snapshot: ViewSnapshot) => void;
  readonly removeView: (id: string) => void;
  readonly setActiveViewId: (id: string | null) => void;
}

/** Reads as an empty store and discards writes. Used only during server rendering. */
const SERVER_STORAGE: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

/**
 * `crypto.randomUUID` is available in every browser this app supports and in the Node runtime
 * used for SSR, but this only ever runs from a click handler, so the fallback is defensive
 * rather than load-bearing.
 */
function newViewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `view-${String(Date.now())}`;
}

export const useSubscriptionViews = create<ViewStore>()(
  persist(
    (set) => ({
      views: [],
      activeViewId: null,

      saveView: (name, snapshot) => {
        const view: SavedView = { ...snapshot, id: newViewId(), name };
        set((state) => ({ views: [...state.views, view], activeViewId: view.id }));
      },

      replaceView: (id, snapshot) => {
        set((state) => ({
          views: state.views.map((view) => (view.id === id ? { ...view, ...snapshot } : view)),
          activeViewId: id,
        }));
      },

      removeView: (id) => {
        set((state) => ({
          views: state.views.filter((view) => view.id !== id),
          activeViewId: state.activeViewId === id ? null : state.activeViewId,
        }));
      },

      setActiveViewId: (id) => {
        set({ activeViewId: id });
      },
    }),
    {
      name: 'ledger.subscriptions.views',
      version: 1,
      // On the server there is no `localStorage`, and reaching for it during SSR throws. The
      // no-op storage keeps the middleware's contract without inventing a persistence layer
      // that the server has no business having.
      storage: createJSONStorage(() => (typeof window === 'undefined' ? SERVER_STORAGE : localStorage)),
    },
  ),
);

/**
 * Whether the persisted state has been read back yet.
 *
 * The server renders zero saved views and the browser may have six. Starting at `false` on both
 * sides makes the first client render match the server's; the effect then flips it a frame
 * later. That is the difference between a hydration error and a list that appears immediately
 * after paint.
 */
export function useViewsHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // Covers both orders: hydration that has already finished, and hydration still in flight.
    const unsubscribe = useSubscriptionViews.persist.onFinishHydration(() => {
      setHydrated(true);
    });
    if (useSubscriptionViews.persist.hasHydrated()) setHydrated(true);
    return unsubscribe;
  }, []);

  return hydrated;
}
