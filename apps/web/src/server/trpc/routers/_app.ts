import 'server-only';

import { router } from '../init';
import { accountRouter } from './account';
import { analyticsRouter } from './analytics';
import { cancellationsRouter } from './cancellations';
import { connectionsRouter } from './connections';
import { dashboardRouter } from './dashboard';
import { importRouter } from './import';
import { meRouter } from './me';
import { notificationsRouter } from './notifications';
import { paymentMethodsRouter } from './payment-methods';
import { reviewRouter } from './review';
import { subscriptionsRouter } from './subscriptions';

/**
 * The API surface.
 *
 * One file per domain, and this file never changes shape once a domain exists — that is what
 * lets the interface workstream build against stable signatures while the implementations are
 * still being written.
 */
export const appRouter = router({
  me: meRouter,
  account: accountRouter,
  dashboard: dashboardRouter,
  subscriptions: subscriptionsRouter,
  import: importRouter,
  paymentMethods: paymentMethodsRouter,
  review: reviewRouter,
  connections: connectionsRouter,
  cancellations: cancellationsRouter,
  analytics: analyticsRouter,
  notifications: notificationsRouter,
});

export type AppRouter = typeof appRouter;
