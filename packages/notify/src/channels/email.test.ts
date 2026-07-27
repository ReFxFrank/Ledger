/**
 * The email channel's one non-negotiable behaviour: without `RESEND_API_KEY`, nothing leaves the
 * machine. This test exists because that guarantee is the difference between a seeded dev
 * database and an email to a real person.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock, MONTHLY, money } from '@ledger/core';
import { EmailChannel } from './email';
import type { NotificationRequest, RenderedNotification } from '../types';

const request: NotificationRequest = {
  type: 'trial_ending',
  userId: 'user-1',
  dedupeKey: 'trial_ending:sub-1:2026-08-10',
  scheduledFor: new Date('2026-08-07T08:00:00Z'),
  deferredFrom: null,
  channels: ['email'],
  priority: 'normal',
  subscriptionId: 'sub-1',
  payload: {
    subscription: {
      subscriptionId: 'sub-1',
      name: 'Netflix',
      amount: money(1299, 'GBP'),
      interval: MONTHLY,
    },
    trialEndsOn: '2026-08-10',
    leadTimeDays: 3,
  },
};

const rendered: RenderedNotification = {
  subject: 'Netflix trial ends 10 Aug',
  html: '<html><body>Netflix trial ends 10 August 2026.</body></html>',
  text: 'Netflix trial ends 10 August 2026.',
  url: 'https://ledger.example/subscriptions/sub-1',
};

let outbox: string;

beforeEach(async () => {
  outbox = await mkdtemp(path.join(tmpdir(), 'ledger-mail-'));
});

afterEach(async () => {
  await rm(outbox, { recursive: true, force: true });
});

describe('EmailChannel without an API key', () => {
  it('writes the rendered HTML to the outbox instead of sending', async () => {
    const channel = new EmailChannel({
      apiKey: null,
      from: 'Ledger <ledger@example.com>',
      resolveAddress: () => Promise.resolve('someone@example.com'),
      clock: new FixedClock('2026-08-07T08:00:00Z'),
      outboxDir: outbox,
    });

    expect(channel.isOutboxMode).toBe(true);

    const result = await channel.send(request, rendered);
    expect(result.status).toBe('sent');

    const files = await readdir(outbox);
    expect(files).toEqual(['2026-08-07T08-00-00-000Z-trial_ending.html']);

    const contents = await readFile(path.join(outbox, files[0]!), 'utf8');
    expect(contents).toContain('was not sent');
    expect(contents).toContain(rendered.subject);
    expect(contents).toContain(rendered.html);
  });

  it('skips entirely when there is no address to send to', async () => {
    const channel = new EmailChannel({
      apiKey: null,
      from: 'Ledger <ledger@example.com>',
      resolveAddress: () => Promise.resolve(null),
      clock: new FixedClock('2026-08-07T08:00:00Z'),
      outboxDir: outbox,
    });

    const result = await channel.send(request, rendered);
    expect(result.status).toBe('skipped');
    expect(await readdir(outbox)).toEqual([]);
  });

  it('treats an empty key string as no key', () => {
    const channel = new EmailChannel({
      apiKey: '',
      from: 'Ledger <ledger@example.com>',
      resolveAddress: () => Promise.resolve('someone@example.com'),
      clock: new FixedClock('2026-08-07T08:00:00Z'),
      outboxDir: outbox,
    });
    expect(channel.isOutboxMode).toBe(true);
  });
});
