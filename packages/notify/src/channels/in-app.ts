/**
 * The in-app inbox.
 *
 * There is nothing to transmit: the row already exists, written by the scheduler against the
 * UNIQUE `dedupe_key`. Delivery is stamping `sent_at` on it, which is what makes it appear in the
 * user's inbox.
 *
 * The update is filtered on `sent_at IS NULL` as well as the dedupe key, so a second pass over
 * the same notification cannot silently move the delivery timestamp forward — the inbox would
 * then reorder itself under a reader who had already seen the item.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { Clock } from '@ledger/core';
import { type Database, Scope, notifications } from '@ledger/db';
import type { Channel, DeliveryResult, NotificationRequest } from '../types';

export interface InAppChannelOptions {
  readonly db: Database;
  readonly clock: Clock;
}

export class InAppChannel implements Channel {
  readonly name = 'in_app' as const;

  private readonly options: InAppChannelOptions;

  constructor(options: InAppChannelOptions) {
    this.options = options;
  }

  async send(request: NotificationRequest): Promise<DeliveryResult> {
    const scope = new Scope(this.options.db, request.userId);

    const updated = await this.options.db
      .update(notifications)
      .set({ sentAt: this.options.clock.now() })
      .where(
        scope.where(
          notifications,
          and(eq(notifications.dedupeKey, request.dedupeKey), isNull(notifications.sentAt)),
        ),
      )
      .returning({ id: notifications.id });

    if (updated.length === 0) {
      return { status: 'skipped', reason: 'already delivered, or no row for this dedupe key' };
    }
    return { status: 'sent', detail: updated[0]?.id ?? undefined };
  }
}
