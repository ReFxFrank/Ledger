/**
 * Web Push.
 *
 * The behaviour worth the file: a push endpoint that answers **404 or 410 is dead**, and the row
 * is deleted rather than retried. Those two codes mean the browser threw the subscription away —
 * the user cleared site data, uninstalled the PWA, or the service worker was replaced — and no
 * amount of retrying revives it. A sender queue that keeps retrying dead endpoints backs up
 * behind work that can never succeed, and the users still reachable stop being reached.
 *
 * Every other failure is left alone and reported as retryable, because a 500 from a push service
 * is a push service having a bad minute, not a user who is gone.
 */

import webpush from 'web-push';
import { eq, inArray } from 'drizzle-orm';
import { type Clock, describeError } from '@ledger/core';
import { type Database, Scope, pushSubscriptions } from '@ledger/db';
import { childLogger } from '@ledger/logger';
import type { Channel, DeliveryResult, NotificationRequest, RenderedNotification } from '../types';

const log = childLogger('notify:push');

export interface VapidDetails {
  /** An `https:` URL or a `mailto:` address. Push services require a way to contact the sender. */
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

export interface PushChannelOptions {
  readonly db: Database;
  /** Null disables the channel outright rather than failing every send. */
  readonly vapid: VapidDetails | null;
  readonly clock: Clock;
  /** Seconds a push service should hold an undelivered message. A day is plenty for this product. */
  readonly ttlSeconds?: number;
}

/** The JSON a service worker receives. Kept small — some push services cap the payload. */
interface PushPayload {
  readonly title: string;
  readonly body: string;
  readonly url: string;
  /** Collapses repeat notifications about the same thing in the OS tray. */
  readonly tag: string;
  readonly type: string;
  readonly urgent: boolean;
}

const DEAD_ENDPOINT_STATUS = new Set([404, 410]);

export class PushChannel implements Channel {
  readonly name = 'push' as const;

  private readonly options: PushChannelOptions;

  constructor(options: PushChannelOptions) {
    this.options = options;
  }

  async send(
    request: NotificationRequest,
    rendered: RenderedNotification,
  ): Promise<DeliveryResult> {
    const { vapid, db } = this.options;
    if (vapid === null) return { status: 'skipped', reason: 'VAPID keys are not configured' };

    const scope = new Scope(db, request.userId);
    const rows = await db
      .select({
        id: pushSubscriptions.id,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .where(scope.where(pushSubscriptions));

    if (rows.length === 0) return { status: 'skipped', reason: 'no push endpoints registered' };

    const payload: PushPayload = {
      title: rendered.subject,
      body: firstLine(rendered.text),
      url: rendered.url,
      tag: request.dedupeKey,
      type: request.type,
      urgent: request.priority === 'high',
    };
    const body = JSON.stringify(payload);

    const delivered: string[] = [];
    const dead: string[] = [];
    const failures: string[] = [];

    for (const row of rows) {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          body,
          {
            vapidDetails: vapid,
            TTL: this.options.ttlSeconds ?? 86_400,
            urgency: request.priority === 'high' ? 'high' : 'normal',
          },
        );
        delivered.push(row.id);
      } catch (error) {
        if (error instanceof webpush.WebPushError && DEAD_ENDPOINT_STATUS.has(error.statusCode)) {
          dead.push(row.id);
          continue;
        }
        failures.push(describeError(error).message);
      }
    }

    await this.prune(scope, dead);
    await this.touch(scope, delivered);

    if (delivered.length > 0) {
      return { status: 'sent', detail: `${String(delivered.length)} endpoint(s)` };
    }
    if (failures.length > 0) {
      return { status: 'failed', reason: failures.join('; '), retryable: true };
    }
    return { status: 'skipped', reason: 'every registered endpoint was gone' };
  }

  /** Deletes endpoints the push service has told us no longer exist. Scoped, never by id alone. */
  private async prune(scope: Scope, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.options.db
      .delete(pushSubscriptions)
      .where(scope.where(pushSubscriptions, inArray(pushSubscriptions.id, [...ids])));
    log.info({ count: ids.length }, 'removed dead push endpoints');
  }

  private async touch(scope: Scope, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.options.db
      .update(pushSubscriptions)
      .set({ lastUsedAt: this.options.clock.now() })
      .where(
        scope.where(
          pushSubscriptions,
          ids.length === 1 && ids[0] !== undefined
            ? eq(pushSubscriptions.id, ids[0])
            : inArray(pushSubscriptions.id, [...ids]),
        ),
      );
  }
}

/**
 * A push body is one line on a lock screen. Taking the first non-empty line of the plain-text
 * render keeps it in step with the email rather than inventing a second piece of copy that can
 * drift away from it.
 */
function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? '';
}
