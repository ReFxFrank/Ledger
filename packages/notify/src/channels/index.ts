/**
 * Channels, and the fan-out across them.
 *
 * `deliver` never rejects. One channel failing must not stop the others: an email that bounces
 * should not cost the user the in-app record of the same event, and a push service having a bad
 * minute should not swallow the email. The caller gets one result per channel and decides what to
 * retry from the `retryable` flag.
 */

import { describeError } from '@ledger/core';
import type { NotificationChannel } from '@ledger/core';
import type { Channel, DeliveryResult, NotificationRequest, RenderedNotification } from '../types';

export { EmailChannel, DEFAULT_OUTBOX_DIR, type AddressResolver, type EmailChannelOptions } from './email';
export { PushChannel, type PushChannelOptions, type VapidDetails } from './push';
export { InAppChannel, type InAppChannelOptions } from './in-app';

export interface ChannelOutcome {
  readonly channel: NotificationChannel;
  readonly result: DeliveryResult;
}

export async function deliver(
  request: NotificationRequest,
  rendered: RenderedNotification,
  available: readonly Channel[],
): Promise<ChannelOutcome[]> {
  const outcomes: ChannelOutcome[] = [];

  for (const channel of request.channels) {
    const impl = available.find((candidate) => candidate.name === channel);
    if (impl === undefined) {
      outcomes.push({
        channel,
        result: { status: 'skipped', reason: `no implementation registered for ${channel}` },
      });
      continue;
    }

    try {
      outcomes.push({ channel, result: await impl.send(request, rendered) });
    } catch (error) {
      // A channel that throws instead of returning a result is a bug in that channel, not a
      // reason to abandon the remaining ones.
      outcomes.push({
        channel,
        result: { status: 'failed', reason: describeError(error).message, retryable: true },
      });
    }
  }

  return outcomes;
}
