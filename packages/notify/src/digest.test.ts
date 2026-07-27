/**
 * The weekly digest.
 *
 * The headline test is the negative one: an empty digest is not sent. A weekly email that says
 * "nothing found" trains the reader to archive on sight, and by the week something does need
 * attention it has already stopped being opened.
 */

import { describe, expect, it } from 'vitest';
import { FixedClock, MONTHLY, money } from '@ledger/core';
import { nextDigestAt, scheduleWeeklyDigest } from './digest';
import { defaultPreferences } from './schedule';
import type { DetectionSummary } from './types';

const LONDON = 'Europe/London';
const prefs = defaultPreferences('user-1', LONDON, 'GBP');
const iso = (date: Date): string => date.toISOString();

const items: DetectionSummary[] = [
  {
    detectionId: 'det-1',
    name: 'Spotify',
    amount: money(1199, 'GBP'),
    interval: MONTHLY,
  },
  {
    detectionId: 'det-2',
    name: 'Adobe Creative Cloud',
    amount: money(5698, 'GBP'),
    interval: MONTHLY,
  },
];

describe('scheduleWeeklyDigest', () => {
  it('is not sent at all when there is nothing to say', () => {
    const clock = new FixedClock('2026-07-22T09:00:00Z');
    expect(scheduleWeeklyDigest({ detections: [] }, prefs, clock)).toBeNull();
  });

  it('lands on Sunday at 18:00 local', () => {
    // Wednesday 2026-07-22.
    const clock = new FixedClock('2026-07-22T09:00:00Z');
    const request = scheduleWeeklyDigest({ detections: items }, prefs, clock);

    expect(request).not.toBeNull();
    // Sunday 2026-07-26, 18:00 BST = 17:00Z.
    expect(iso(request!.scheduledFor)).toBe('2026-07-26T17:00:00.000Z');
    expect(request!.type).toBe('new_detections');
    expect(request!.deferredFrom).toBeNull();
  });

  it('rolls to next Sunday once the slot has passed', () => {
    // Sunday 2026-07-26 at 19:00 BST — this week's digest has already gone.
    const clock = new FixedClock('2026-07-26T18:00:00Z');
    expect(iso(nextDigestAt(prefs, clock))).toBe('2026-08-02T17:00:00.000Z');
  });

  it('still schedules this Sunday when the slot is ahead', () => {
    // Sunday 2026-07-26 at 09:00 BST.
    const clock = new FixedClock('2026-07-26T08:00:00Z');
    expect(iso(nextDigestAt(prefs, clock))).toBe('2026-07-26T17:00:00.000Z');
  });

  it('keys on the digest date, so two runs in one week produce one digest', () => {
    const monday = scheduleWeeklyDigest(
      { detections: items },
      prefs,
      new FixedClock('2026-07-20T06:00:00Z'),
    );
    const friday = scheduleWeeklyDigest(
      { detections: [...items, { ...items[0]!, detectionId: 'det-3', name: 'Strava' }] },
      prefs,
      new FixedClock('2026-07-24T23:30:00Z'),
    );

    expect(friday!.dedupeKey).toBe(monday!.dedupeKey);
    expect(monday!.dedupeKey).toBe('new_detections:user-1:2026-07-26');
  });

  it('carries every detection into the payload', () => {
    const request = scheduleWeeklyDigest(
      { detections: items },
      prefs,
      new FixedClock('2026-07-22T09:00:00Z'),
    );
    if (request?.type !== 'new_detections') throw new Error('unreachable');
    expect(request.payload.items).toHaveLength(2);
    expect(request.payload.weekOf).toBe('2026-07-26');
  });

  it('is not sent when the user has turned the digest off', () => {
    const off = defaultPreferences('user-1', LONDON, 'GBP', {
      byType: { new_detections: { channels: [], leadTimeDays: null } },
    });
    expect(
      scheduleWeeklyDigest({ detections: items }, off, new FixedClock('2026-07-22T09:00:00Z')),
    ).toBeNull();
  });

  it('honours a different digest day and minute', () => {
    const friday9am = defaultPreferences('user-1', LONDON, 'GBP', {
      digestDayOfWeek: 5,
      digestMinute: 9 * 60,
    });
    // Wednesday 2026-07-22 → Friday 2026-07-24 at 09:00 BST.
    expect(iso(nextDigestAt(friday9am, new FixedClock('2026-07-22T09:00:00Z')))).toBe(
      '2026-07-24T08:00:00.000Z',
    );
  });
});
