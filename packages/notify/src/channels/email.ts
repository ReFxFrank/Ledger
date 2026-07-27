/**
 * Email delivery via Resend.
 *
 * The important behaviour here is the one that happens when `RESEND_API_KEY` is absent: the
 * rendered HTML is written to `./.mail/<timestamp>-<type>.html` and nothing leaves the machine.
 * That is not a developer convenience bolted on the side — it is the guarantee that a dev
 * database seeded with a real address, or a test run that forgot to stub the channel, cannot mail
 * a person. There is no code path in this file that sends without a key.
 *
 * The address is resolved through an injected lookup rather than carried on the request, so the
 * scheduler stays pure and no user's email address ends up frozen into a JSONB payload.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Resend } from 'resend';
import { type Clock, describeError } from '@ledger/core';
import { childLogger } from '@ledger/logger';
import type { Channel, DeliveryResult, NotificationRequest, RenderedNotification } from '../types';

const log = childLogger('notify:email');

/** Resolves a user id to a deliverable address, or null when there is nothing to send to. */
export type AddressResolver = (userId: string) => Promise<string | null>;

export interface EmailChannelOptions {
  /** Null or empty switches the channel into outbox mode. */
  readonly apiKey: string | null;
  readonly from: string;
  readonly resolveAddress: AddressResolver;
  readonly clock: Clock;
  /** Where outbox mode writes. Relative paths resolve against the process working directory. */
  readonly outboxDir?: string;
}

export const DEFAULT_OUTBOX_DIR = './.mail';

export class EmailChannel implements Channel {
  readonly name = 'email' as const;

  private readonly options: EmailChannelOptions;
  private readonly resend: Resend | null;

  constructor(options: EmailChannelOptions) {
    this.options = options;
    const key = options.apiKey ?? '';
    this.resend = key === '' ? null : new Resend(key);
  }

  /** True when this channel will write to disk instead of sending. Surfaced in the boot log. */
  get isOutboxMode(): boolean {
    return this.resend === null;
  }

  async send(
    request: NotificationRequest,
    rendered: RenderedNotification,
  ): Promise<DeliveryResult> {
    const address = await this.options.resolveAddress(request.userId);
    if (address === null || address === '') {
      return { status: 'skipped', reason: 'no email address on file' };
    }

    if (this.resend === null) {
      const file = await this.writeToOutbox(request, rendered);
      // Reported as sent, not skipped: in outbox mode this *is* delivery, and returning `skipped`
      // would leave every notification unsent and re-attempted on every worker tick.
      log.info({ type: request.type, dedupeKey: request.dedupeKey, file }, 'email written to outbox');
      return { status: 'sent', detail: `outbox:${file}` };
    }

    try {
      const result = await this.resend.emails.send({
        from: this.options.from,
        to: address,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });

      if (result.error !== null) {
        // Resend reports 4xx validation problems in the body rather than by throwing. A rejected
        // address will be rejected identically forever, so it is not worth a retry.
        return {
          status: 'failed',
          reason: result.error.message,
          retryable: false,
        };
      }
      return { status: 'sent', detail: result.data?.id ?? undefined };
    } catch (error) {
      // A throw from the SDK is a transport problem — timeout, DNS, 5xx — and those do recover.
      const described = describeError(error);
      log.warn({ type: request.type, dedupeKey: request.dedupeKey }, `email send failed: ${described.message}`);
      return { status: 'failed', reason: described.message, retryable: true };
    }
  }

  private async writeToOutbox(
    request: NotificationRequest,
    rendered: RenderedNotification,
  ): Promise<string> {
    const dir = path.resolve(this.options.outboxDir ?? DEFAULT_OUTBOX_DIR);
    await mkdir(dir, { recursive: true });

    // Colons are illegal in filenames on Windows and dots before the extension confuse editors.
    const stamp = this.options.clock.now().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${stamp}-${request.type}.html`);

    const header = [
      '<!-- Ledger outbox — RESEND_API_KEY is not set, so this was not sent. -->',
      `<!-- subject: ${rendered.subject} -->`,
      `<!-- dedupe:  ${request.dedupeKey} -->`,
      `<!-- link:    ${rendered.url} -->`,
      '',
    ].join('\n');

    await writeFile(file, `${header}${rendered.html}`, 'utf8');
    return file;
  }
}
