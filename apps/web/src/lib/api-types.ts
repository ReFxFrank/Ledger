/**
 * Router output types, inferred rather than restated.
 *
 * Every screen below `(app)/` renders shapes the routers return. Hand-writing those shapes into
 * component props is how a UI ends up quietly reading a field the server stopped sending — so
 * they are inferred from `AppRouter` instead, and a procedure that changes its return shape
 * fails typecheck at the component that consumed it.
 *
 * The import is type-only, so the `server-only` guard at the top of the router barrel is erased
 * before it can reach a client bundle.
 */

import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '~/server/trpc/routers/_app';

export type RouterOutputs = inferRouterOutputs<AppRouter>;

export type ReviewItem = RouterOutputs['review']['list']['items'][number];
export type SupportingTransaction = RouterOutputs['review']['supportingTransactions'][number];

export type CancellationBoard = RouterOutputs['cancellations']['board'];
export type CancellationBoardItem = CancellationBoard['columns'][number]['items'][number];
export type CancellationDetail = RouterOutputs['cancellations']['byId'];

export type ConnectionListItem = RouterOutputs['connections']['list'][number];
export type ConnectionAccount = ConnectionListItem['accounts'][number];
export type PaymentMethod = RouterOutputs['paymentMethods']['list'][number];

export type CostPerUseRow = RouterOutputs['analytics']['costPerUse'][number];
export type CategorySpend = RouterOutputs['analytics']['spendByCategory'][number];
export type CadenceMixRow = RouterOutputs['analytics']['cadenceMix'][number];
export type SpendOverTimeRow = RouterOutputs['analytics']['spendOverTime'][number];
export type SimulationResult = RouterOutputs['analytics']['simulate'];

export type NotificationPreferences = RouterOutputs['notifications']['preferences'];
export type AuditEntry = RouterOutputs['me']['activity']['items'][number];
