/**
 * The flat row the subscriptions table renders.
 *
 * `subscriptions.list` returns the row joined to its merchant, plus the payment method as a bare
 * id. Flattening once, here, means the column definitions never reach through two levels of
 * nesting and the grouping keys can be plain accessor strings.
 */

import type {
  BillingChannel,
  Category,
  IntervalUnit,
  SubscriptionStatus,
} from '@ledger/core';

export interface SubscriptionRow {
  readonly id: string;
  readonly displayName: string;
  readonly merchantName: string | null;
  readonly merchantLogo: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly intervalUnit: IntervalUnit;
  readonly intervalCount: number;
  readonly anchorDate: string;
  readonly nextRenewalAt: Date | null;
  readonly trialEndsAt: Date | null;
  readonly cancelByAt: Date | null;
  readonly category: Category;
  readonly billingChannel: BillingChannel;
  readonly status: SubscriptionStatus;
  readonly paymentMethodId: string | null;
  /** Resolved label, or "No payment method" — grouping needs a value for every row. */
  readonly paymentMethodLabel: string;
  readonly variableAmount: boolean;
  readonly archived: boolean;
  readonly tags: readonly string[];
}

/** Column ids, in render order. The grid template in `table.tsx` is keyed off these. */
export const COLUMN_IDS = [
  'select',
  'name',
  'amount',
  'cadence',
  'nextCharge',
  'category',
  'channel',
  'status',
  'paymentMethod',
] as const;

export type ColumnId = (typeof COLUMN_IDS)[number];

/** The columns the user can group by, and what the group-by control calls them. */
export const GROUPABLE_COLUMNS: readonly { readonly id: ColumnId; readonly label: string }[] = [
  { id: 'category', label: 'Category' },
  { id: 'channel', label: 'Billing channel' },
  { id: 'paymentMethod', label: 'Payment method' },
];
