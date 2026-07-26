/**
 * Tests for the four "vocabulary" modules: clock, ids, domain, errors.
 *
 * These are grouped in one file because they are the primitives everything else in the monorepo
 * imports, and because their invariants are cheap to state and expensive to get wrong:
 *  - a clock that moves on its own makes every lead-time test flaky,
 *  - an id that is not time-sortable silently degrades the `transactions` primary key,
 *  - an enum member without a label ships as a blank chip in the UI,
 *  - an error without a stable `code` cannot be switched on by the caller.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  type Clock,
  FixedClock,
  MILLIS_PER_DAY,
  MILLIS_PER_HOUR,
  MILLIS_PER_MINUTE,
  MILLIS_PER_SECOND,
  SystemClock,
  today,
} from './clock';
import { assertUuid, dedupeKey, isUuid, randomToken, uuidv7 } from './ids';
import {
  BILLING_CHANNELS,
  BILLING_CHANNEL_LABELS,
  CANCELLATION_METHODS,
  CANCELLATION_METHOD_LABELS,
  CANCELLATION_STATUSES,
  CANCELLATION_STATUS_LABELS,
  CATEGORIES,
  CATEGORY_LABELS,
  COMMITTED_STATUSES,
  CONNECTION_STATUSES,
  CONNECTION_STATUS_LABELS,
  DEFAULT_LEAD_TIME_DAYS,
  DETECTION_STATUSES,
  DIFFICULTY_LABELS,
  INTERMEDIATED_CHANNELS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  SUBSCRIPTION_SOURCES,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_LABELS,
  URGENT_NOTIFICATION_TYPES,
  type BillingChannel,
  type CancellationDifficulty,
  type NotificationType,
  type SubscriptionStatus,
  ignoresQuietHours,
  isCommitted,
  isIntermediated,
} from './domain';
import {
  CurrencyMismatchError,
  InvalidArgumentError,
  InvalidStateTransitionError,
  LedgerError,
  type LedgerErrorCode,
  UnsupportedCurrencyError,
  describeError,
  isLedgerError,
} from './errors';
import { formatPlainDate } from './plain-date';

// ── shared helpers ──────────────────────────────────────────────────────────────────────

/** Asserts a keyed record covers its const array exactly — no missing keys, no orphans. */
function expectRecordCoversExactly<K extends string, V>(
  members: readonly K[],
  record: Readonly<Record<K, V>>,
): void {
  expect(Object.keys(record).sort()).toEqual([...members].sort());
  expect(new Set(members).size).toBe(members.length);
}

/** As above, plus: every label is a non-blank string and no two members render identically. */
function expectLabelled<K extends string>(members: readonly K[], labels: Readonly<Record<K, string>>): void {
  expectRecordCoversExactly(members, labels);
  const rendered = new Set<string>();
  for (const member of members) {
    const label = labels[member];
    expect(typeof label).toBe('string');
    expect(label.trim()).not.toBe('');
    rendered.add(label);
  }
  expect(rendered.size).toBe(members.length);
}

/** The 48-bit big-endian timestamp encoded in the first two groups of a UUIDv7. */
function timestampOf(uuid: string): number {
  return Number.parseInt(uuid.slice(0, 8) + uuid.slice(9, 13), 16);
}

/** The third group: version nibble + 12-bit monotonic counter, e.g. '7000' for sequence 0. */
function counterGroupOf(uuid: string): string {
  return uuid.slice(14, 18);
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ════════════════════════════════════════════════════════════════════════════════════════
// clock.ts
// ════════════════════════════════════════════════════════════════════════════════════════

describe('clock', () => {
  describe('SystemClock', () => {
    it('reports now() and epochMillis() from the same underlying wall clock', () => {
      const clock = new SystemClock();

      const before = Date.now();
      const asDate = clock.now().getTime();
      const asMillis = clock.epochMillis();
      const after = Date.now();

      expect(asDate).toBeGreaterThanOrEqual(before);
      expect(asMillis).toBeGreaterThanOrEqual(asDate);
      expect(asMillis).toBeLessThanOrEqual(after);
      // Both readings are of the same instant, so they cannot meaningfully disagree.
      expect(Math.abs(asMillis - asDate)).toBeLessThan(1000);
    });

    it('returns a real Date carrying an integer number of milliseconds', () => {
      const clock = new SystemClock();
      const instant = clock.now();

      expect(instant).toBeInstanceOf(Date);
      expect(Number.isNaN(instant.getTime())).toBe(false);
      expect(Number.isInteger(clock.epochMillis())).toBe(true);
    });

    it('never runs backwards across successive reads', () => {
      const clock = new SystemClock();
      let previous = clock.epochMillis();
      for (let i = 0; i < 50; i += 1) {
        const current = clock.epochMillis();
        expect(current).toBeGreaterThanOrEqual(previous);
        previous = current;
      }
    });

    it('is usable through the Clock interface', () => {
      const read = (clock: Clock): number => clock.epochMillis();
      expect(read(new SystemClock())).toBeGreaterThan(1_700_000_000_000);
    });
  });

  describe('FixedClock construction', () => {
    const ISO = '2026-03-14T23:30:00.000Z';
    const MILLIS = Date.parse(ISO);

    it('accepts a Date', () => {
      const clock = new FixedClock(new Date(MILLIS));
      expect(clock.epochMillis()).toBe(MILLIS);
      expect(clock.now().toISOString()).toBe(ISO);
    });

    it('accepts an ISO string', () => {
      const clock = new FixedClock(ISO);
      expect(clock.epochMillis()).toBe(MILLIS);
      expect(clock.now().toISOString()).toBe(ISO);
    });

    it('accepts a number of epoch millis', () => {
      const clock = new FixedClock(MILLIS);
      expect(clock.epochMillis()).toBe(MILLIS);
      expect(clock.now().toISOString()).toBe(ISO);
    });

    it('agrees between now() and epochMillis() for all three input forms', () => {
      for (const input of [new Date(MILLIS), ISO, MILLIS] as const) {
        const clock = new FixedClock(input);
        expect(clock.now().getTime()).toBe(clock.epochMillis());
      }
    });

    it('is usable through the Clock interface', () => {
      const clock: Clock = new FixedClock(MILLIS);
      expect(clock.epochMillis()).toBe(MILLIS);
      expect(clock.now().getTime()).toBe(MILLIS);
    });
  });

  describe('FixedClock immobility', () => {
    it('does not move on its own', () => {
      const clock = new FixedClock('2026-01-01T00:00:00.000Z');
      const first = clock.epochMillis();

      // Burn some real wall-clock time; the fixed clock must not notice.
      let spin = 0;
      for (let i = 0; i < 200_000; i += 1) spin += i;
      expect(spin).toBeGreaterThan(0);

      expect(clock.epochMillis()).toBe(first);
      expect(clock.now().getTime()).toBe(first);
      expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    it('hands out a fresh Date each call, so a caller cannot mutate the clock', () => {
      const clock = new FixedClock('2026-01-01T00:00:00.000Z');
      const first = clock.now();
      const second = clock.now();

      expect(first).not.toBe(second);
      expect(first.getTime()).toBe(second.getTime());

      first.setUTCFullYear(1999);
      expect(clock.now().getUTCFullYear()).toBe(2026);
    });
  });

  describe('FixedClock movement', () => {
    it('setTo accepts a Date, an ISO string and a number', () => {
      const clock = new FixedClock(0);

      clock.setTo(new Date('2026-05-01T12:00:00.000Z'));
      expect(clock.now().toISOString()).toBe('2026-05-01T12:00:00.000Z');

      clock.setTo('2027-01-02T03:04:05.000Z');
      expect(clock.now().toISOString()).toBe('2027-01-02T03:04:05.000Z');

      clock.setTo(1_234_567_890);
      expect(clock.epochMillis()).toBe(1_234_567_890);
    });

    it('setTo can move the clock backwards', () => {
      const clock = new FixedClock('2026-06-01T00:00:00.000Z');
      clock.setTo('2020-06-01T00:00:00.000Z');
      expect(clock.now().toISOString()).toBe('2020-06-01T00:00:00.000Z');
    });

    it('advanceMillis moves forward, backward and not at all', () => {
      const clock = new FixedClock(1_000_000);

      clock.advanceMillis(500);
      expect(clock.epochMillis()).toBe(1_000_500);

      clock.advanceMillis(-1500);
      expect(clock.epochMillis()).toBe(999_000);

      clock.advanceMillis(0);
      expect(clock.epochMillis()).toBe(999_000);
    });

    it('advanceDays adds exactly MILLIS_PER_DAY per day', () => {
      const start = Date.parse('2026-03-01T00:00:00.000Z');
      const clock = new FixedClock(start);

      clock.advanceDays(1);
      expect(clock.epochMillis() - start).toBe(MILLIS_PER_DAY);
      expect(clock.now().toISOString()).toBe('2026-03-02T00:00:00.000Z');

      clock.advanceDays(30);
      expect(clock.epochMillis() - start).toBe(31 * MILLIS_PER_DAY);

      clock.advanceDays(-31);
      expect(clock.epochMillis()).toBe(start);
    });

    it('advanceHours adds exactly MILLIS_PER_HOUR per hour', () => {
      const start = Date.parse('2026-03-01T00:00:00.000Z');
      const clock = new FixedClock(start);

      clock.advanceHours(1);
      expect(clock.epochMillis() - start).toBe(MILLIS_PER_HOUR);

      clock.advanceHours(23);
      expect(clock.epochMillis() - start).toBe(MILLIS_PER_DAY);

      clock.advanceHours(-24);
      expect(clock.epochMillis()).toBe(start);
    });

    it('advances in fixed 24h days, ignoring the DST transition it spans', () => {
      // 2026-03-08 is the US spring-forward. advanceDays is instant arithmetic, not calendar
      // arithmetic, so the wall-clock hour in Los Angeles legitimately shifts.
      const clock = new FixedClock('2026-03-07T20:00:00.000Z');
      clock.advanceDays(1);
      expect(clock.now().toISOString()).toBe('2026-03-08T20:00:00.000Z');
    });

    it('accumulates arbitrary integer millisecond deltas exactly', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -1_000_000_000_000, max: 1_000_000_000_000 }),
          fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), { maxLength: 25 }),
          (start, deltas) => {
            const clock = new FixedClock(start);
            let expected = start;
            for (const delta of deltas) {
              clock.advanceMillis(delta);
              expected += delta;
            }
            expect(clock.epochMillis()).toBe(expected);
            expect(Number.isInteger(clock.epochMillis())).toBe(true);
            expect(clock.now().getTime()).toBe(clock.epochMillis());
          },
        ),
      );
    });

    it('keeps advanceDays and advanceHours consistent with the exported constants', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -5000, max: 5000 }),
          fc.integer({ min: -5000, max: 5000 }),
          (days, hours) => {
            const start = 1_600_000_000_000;

            const byDays = new FixedClock(start);
            byDays.advanceDays(days);
            expect(byDays.epochMillis() - start).toBe(days * MILLIS_PER_DAY);

            const byHours = new FixedClock(start);
            byHours.advanceHours(hours);
            expect(byHours.epochMillis() - start).toBe(hours * MILLIS_PER_HOUR);
          },
        ),
      );
    });
  });

  describe('today()', () => {
    // 23:30Z on 2026-03-14: Auckland is already on the 15th (UTC+13, NZDT),
    // Los Angeles is still on the 14th (UTC-7, PDT).
    const JUST_BEFORE_UTC_MIDNIGHT = '2026-03-14T23:30:00.000Z';
    // 03:30Z on 2026-03-15: UTC has ticked over, Los Angeles has not.
    const JUST_AFTER_UTC_MIDNIGHT = '2026-03-15T03:30:00.000Z';

    it('reads the same instant as three different calendar dates side of UTC midnight', () => {
      const clock = new FixedClock(JUST_BEFORE_UTC_MIDNIGHT);

      expect(formatPlainDate(today(clock, 'Pacific/Auckland'))).toBe('2026-03-15');
      expect(formatPlainDate(today(clock, 'UTC'))).toBe('2026-03-14');
      expect(formatPlainDate(today(clock, 'America/Los_Angeles'))).toBe('2026-03-14');
    });

    it('puts Los Angeles a day behind UTC just after UTC midnight', () => {
      const clock = new FixedClock(JUST_AFTER_UTC_MIDNIGHT);

      expect(formatPlainDate(today(clock, 'Pacific/Auckland'))).toBe('2026-03-15');
      expect(formatPlainDate(today(clock, 'UTC'))).toBe('2026-03-15');
      expect(formatPlainDate(today(clock, 'America/Los_Angeles'))).toBe('2026-03-14');
    });

    it('keeps Auckland ahead of UTC in southern winter too (UTC+12, not +13)', () => {
      const clock = new FixedClock('2026-06-30T23:30:00.000Z');

      expect(formatPlainDate(today(clock, 'Pacific/Auckland'))).toBe('2026-07-01');
      expect(formatPlainDate(today(clock, 'UTC'))).toBe('2026-06-30');
      expect(formatPlainDate(today(clock, 'America/Los_Angeles'))).toBe('2026-06-30');
    });

    it('defaults to UTC when no timezone is given', () => {
      const clock = new FixedClock(JUST_BEFORE_UTC_MIDNIGHT);
      expect(today(clock)).toEqual(today(clock, 'UTC'));
      expect(formatPlainDate(today(clock))).toBe('2026-03-14');
    });

    it('returns a PlainDate of integer components, never a Date', () => {
      const clock = new FixedClock('2026-02-28T12:00:00.000Z');
      const date = today(clock, 'UTC');

      expect(date).toEqual({ year: 2026, month: 2, day: 28 });
      expect(Number.isInteger(date.year)).toBe(true);
      expect(Number.isInteger(date.month)).toBe(true);
      expect(Number.isInteger(date.day)).toBe(true);
      expect(date).not.toBeInstanceOf(Date);
    });

    it('follows the clock as it is advanced across a local midnight', () => {
      const clock = new FixedClock('2026-03-14T10:00:00.000Z');
      expect(formatPlainDate(today(clock, 'Pacific/Auckland'))).toBe('2026-03-14');

      clock.advanceHours(1); // 11:00Z is 00:00 on the 15th in Auckland
      expect(formatPlainDate(today(clock, 'Pacific/Auckland'))).toBe('2026-03-15');
    });

    it('works with a SystemClock', () => {
      const date = today(new SystemClock(), 'UTC');
      expect(date.year).toBeGreaterThanOrEqual(2024);
      expect(date.month).toBeGreaterThanOrEqual(1);
      expect(date.month).toBeLessThanOrEqual(12);
      expect(date.day).toBeGreaterThanOrEqual(1);
      expect(date.day).toBeLessThanOrEqual(31);
    });
  });

  describe('duration constants', () => {
    it('has the exact millisecond values', () => {
      expect(MILLIS_PER_SECOND).toBe(1000);
      expect(MILLIS_PER_MINUTE).toBe(60_000);
      expect(MILLIS_PER_HOUR).toBe(3_600_000);
      expect(MILLIS_PER_DAY).toBe(86_400_000);
    });

    it('composes multiplicatively', () => {
      expect(MILLIS_PER_MINUTE).toBe(60 * MILLIS_PER_SECOND);
      expect(MILLIS_PER_HOUR).toBe(60 * MILLIS_PER_MINUTE);
      expect(MILLIS_PER_DAY).toBe(24 * MILLIS_PER_HOUR);
    });

    it('are integers — durations never become floats', () => {
      for (const value of [MILLIS_PER_SECOND, MILLIS_PER_MINUTE, MILLIS_PER_HOUR, MILLIS_PER_DAY]) {
        expect(Number.isInteger(value)).toBe(true);
        expect(Number.isSafeInteger(value)).toBe(true);
      }
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// ids.ts
// ════════════════════════════════════════════════════════════════════════════════════════

describe('ids', () => {
  describe('uuidv7 shape', () => {
    it('matches the canonical UUID text form', () => {
      const id = uuidv7(1_600_000_000_001);
      expect(id).toMatch(UUID_SHAPE);
      expect(id).toHaveLength(36);
      expect(id).toBe(id.toLowerCase());
    });

    it('sets the version nibble to 7', () => {
      const id = uuidv7(1_600_000_000_002);
      expect(id[14]).toBe('7');
    });

    it('sets the RFC 4122 variant bits (10xx) on the ninth byte', () => {
      for (let i = 0; i < 200; i += 1) {
        const id = uuidv7(1_600_000_100_000 + i);
        expect('89ab').toContain(id[19]);
      }
    });

    it('works with the default Date.now() argument', () => {
      const before = Date.now();
      const id = uuidv7();
      const after = Date.now();

      expect(id).toMatch(UUID_SHAPE);
      expect(id[14]).toBe('7');
      expect(timestampOf(id)).toBeGreaterThanOrEqual(before);
      expect(timestampOf(id)).toBeLessThanOrEqual(after);
    });

    it('round-trips the supplied timestamp into the first 48 bits', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 281_474_976_710_655 }), (millis) => {
          const id = uuidv7(millis);
          expect(id).toMatch(UUID_SHAPE);
          expect(id[14]).toBe('7');
          expect('89ab').toContain(id[19]);
          expect(timestampOf(id)).toBe(millis);
        }),
      );
    });
  });

  describe('uuidv7 sortability', () => {
    it('sorts lexicographically in timestamp order', () => {
      const base = 1_700_000_000_000;
      const millis = [base, base + 1, base + 7, base + 999, base + 86_400_000, base + 31_536_000_000];
      const ids = millis.map((m) => uuidv7(m));

      expect([...ids].sort()).toEqual(ids);
      expect(ids.map(timestampOf)).toEqual(millis);
    });

    it('survives shuffling — sorting the ids restores creation order', () => {
      const base = 1_710_000_000_000;
      const inOrder = Array.from({ length: 200 }, (_, i) => uuidv7(base + i * 37));
      const shuffled = [...inOrder].reverse();

      expect(shuffled.sort()).toEqual(inOrder);
    });

    it('orders any pair of distinct timestamps consistently', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 200_000_000_000_000 }),
          fc.integer({ min: 0, max: 200_000_000_000_000 }),
          (a, b) => {
            fc.pre(a !== b);
            const earlier = uuidv7(Math.min(a, b));
            const later = uuidv7(Math.max(a, b));
            expect(earlier < later).toBe(true);
          },
        ),
      );
    });

    it('is monotonic within a single millisecond across 1000 ids', () => {
      const stamp = 1_720_000_000_000;
      const ids = Array.from({ length: 1000 }, () => uuidv7(stamp));

      expect(new Set(ids).size).toBe(1000);
      expect([...ids].sort()).toEqual(ids);

      for (let i = 1; i < ids.length; i += 1) {
        expect(ids[i - 1]! < ids[i]!).toBe(true);
      }

      // Every one of them still encodes the same instant and the same version.
      for (const id of ids) {
        expect(timestampOf(id)).toBe(stamp);
        expect(id[14]).toBe('7');
      }
    });

    it('starts the intra-millisecond counter at zero for a newly seen timestamp', () => {
      const first = uuidv7(1_730_000_000_000);
      expect(counterGroupOf(first)).toBe('7000');

      const second = uuidv7(1_730_000_000_000);
      expect(counterGroupOf(second)).toBe('7001');

      const third = uuidv7(1_730_000_000_001);
      expect(counterGroupOf(third)).toBe('7000');
    });

    it('resets the counter when the supplied clock jumps backwards', () => {
      // Documents current behaviour: a clock regression re-uses counter values that were
      // already handed out for that millisecond. See the report accompanying this file.
      const forward = uuidv7(1_740_000_000_000);
      uuidv7(1_740_000_000_005);
      const backAgain = uuidv7(1_740_000_000_000);

      expect(counterGroupOf(forward)).toBe('7000');
      expect(counterGroupOf(backAgain)).toBe('7000');
      expect(timestampOf(forward)).toBe(timestampOf(backAgain));
      // Only the 62 random bits keep these two apart.
      expect(forward).not.toBe(backAgain);
    });

    it('keeps the version nibble intact when the 12-bit counter wraps', () => {
      const stamp = 1_750_000_000_000;
      const ids = Array.from({ length: 4097 }, () => uuidv7(stamp));

      for (const id of ids) {
        expect(id[14]).toBe('7');
        expect('89ab').toContain(id[19]);
      }

      // The counter is 12 bits, so id #4097 re-uses the counter of id #1.
      expect(counterGroupOf(ids[0]!)).toBe('7000');
      expect(counterGroupOf(ids[4095]!)).toBe('7fff');
      expect(counterGroupOf(ids[4096]!)).toBe('7000');
    });
  });

  describe('isUuid', () => {
    it('accepts freshly minted ids', () => {
      for (let i = 0; i < 25; i += 1) {
        expect(isUuid(uuidv7(1_760_000_000_000 + i))).toBe(true);
      }
    });

    it('accepts uppercase and mixed case', () => {
      const id = uuidv7(1_761_000_000_000);
      expect(isUuid(id.toUpperCase())).toBe(true);
      expect(isUuid(`${id.slice(0, 18).toUpperCase()}${id.slice(18)}`)).toBe(true);
    });

    it('accepts other UUID versions and the nil UUID (it is a shape check, not a version check)', () => {
      expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
      expect(isUuid('9f8c1a24-3f1e-4b6d-9c2f-7a1e5d3b8c40')).toBe(true);
    });

    it('rejects anything that is not the canonical 8-4-4-4-12 form', () => {
      const rejected = [
        '',
        'not-a-uuid',
        '9f8c1a24-3f1e-4b6d-9c2f-7a1e5d3b8c4', // too short
        '9f8c1a24-3f1e-4b6d-9c2f-7a1e5d3b8c400', // too long
        '9f8c1a243f1e4b6d9c2f7a1e5d3b8c40', // unhyphenated
        '{9f8c1a24-3f1e-4b6d-9c2f-7a1e5d3b8c40}', // braced
        ' 9f8c1a24-3f1e-4b6d-9c2f-7a1e5d3b8c40', // leading space
        '9f8c1a24-3f1e-4b6d-9c2f-7a1e5d3b8c40 ', // trailing space
        '9g8c1a24-3f1e-4b6d-9c2f-7a1e5d3b8c40', // non-hex digit
        '9f8c1a24_3f1e_4b6d_9c2f_7a1e5d3b8c40', // wrong separator
      ];
      for (const value of rejected) {
        expect(isUuid(value)).toBe(false);
      }
    });
  });

  describe('assertUuid', () => {
    it('returns the value lowercased', () => {
      const id = uuidv7(1_762_000_000_000);
      expect(assertUuid(id)).toBe(id);
      expect(assertUuid(id.toUpperCase())).toBe(id);
    });

    it('throws an InvalidArgumentError naming the default label and the offending value', () => {
      let thrown: unknown;
      try {
        assertUuid('nope');
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(InvalidArgumentError);
      expect(isLedgerError(thrown)).toBe(true);
      const code = isLedgerError(thrown) ? thrown.code : null;
      expect(code).toBe('INVALID_ARGUMENT');
      const message = thrown instanceof Error ? thrown.message : '';
      expect(message).toContain('id is not a UUID');
      expect(message).toContain('"nope"');
    });

    it('uses a caller-supplied label in the message', () => {
      expect(() => assertUuid('', 'subscriptionId')).toThrow(InvalidArgumentError);
      expect(() => assertUuid('', 'subscriptionId')).toThrow(/subscriptionId is not a UUID/);
      expect(() => assertUuid('', 'subscriptionId')).toThrow(/""/);
    });

    it('quotes the value with JSON.stringify so whitespace is visible in logs', () => {
      expect(() => assertUuid('  ', 'token')).toThrow(/" {2}"/);
    });
  });

  describe('randomToken', () => {
    it('uses only the URL-safe base64 alphabet', () => {
      for (let i = 0; i < 200; i += 1) {
        const token = randomToken();
        expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(token).not.toContain('+');
        expect(token).not.toContain('/');
        expect(token).not.toContain('=');
      }
    });

    it('is 32 characters by default (24 random bytes, unpadded base64)', () => {
      expect(randomToken()).toHaveLength(32);
    });

    it('has the unpadded base64 length for any byte length', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 96 }), (byteLength) => {
          const token = randomToken(byteLength);
          expect(token).toHaveLength(Math.ceil((byteLength * 4) / 3));
          expect(token).toMatch(/^[A-Za-z0-9_-]*$/);
        }),
      );
    });

    it('returns the empty string for zero bytes', () => {
      expect(randomToken(0)).toBe('');
    });

    it('is unique across many calls', () => {
      const tokens = new Set(Array.from({ length: 2000 }, () => randomToken()));
      expect(tokens.size).toBe(2000);
    });

    it('produces different values for the same byte length', () => {
      expect(randomToken(16)).not.toBe(randomToken(16));
    });

    it('rejects a negative byte length (from the underlying Uint8Array)', () => {
      expect(() => randomToken(-1)).toThrow();
    });
  });

  describe('dedupeKey', () => {
    it('drops null, undefined and empty-string parts', () => {
      expect(dedupeKey('trial', null, 'abc', undefined, '', '2026-01-01')).toBe('trial:abc:2026-01-01');
      expect(dedupeKey(null, undefined, '')).toBe('');
      expect(dedupeKey()).toBe('');
    });

    it('lowercases every part', () => {
      expect(dedupeKey('TRIAL', 'Sub', 'AbC')).toBe('trial:sub:abc');
    });

    it('replaces runs of whitespace with a single hyphen', () => {
      expect(dedupeKey('renewal upcoming', 'Netflix  Standard')).toBe('renewal-upcoming:netflix-standard');
      expect(dedupeKey('a\tb\nc')).toBe('a-b-c');
    });

    it('trims leading and trailing whitespace before joining', () => {
      expect(dedupeKey('  padded  ')).toBe('padded');
      expect(dedupeKey(' a ', ' b ')).toBe('a:b');
    });

    it('joins with a colon', () => {
      expect(dedupeKey('a', 'b', 'c')).toBe('a:b:c');
      expect(dedupeKey('only')).toBe('only');
    });

    it('stringifies numbers, keeping zero', () => {
      expect(dedupeKey('sub', 0, 42)).toBe('sub:0:42');
      expect(dedupeKey(-1, 3.5)).toBe('-1:3.5');
    });

    it('is stable for the same logical inputs in the same order', () => {
      const first = dedupeKey('Trial Ending', null, 'sub_42', undefined, '2026-01-01');
      const second = dedupeKey('Trial Ending', null, 'sub_42', undefined, '2026-01-01');
      const spaced = dedupeKey('trial  ending', null, 'SUB_42', '', ' 2026-01-01 ');

      expect(first).toBe('trial-ending:sub_42:2026-01-01');
      expect(second).toBe(first);
      expect(spaced).toBe(first);
    });

    it('is order-sensitive despite the doc comment calling it order-insensitive', () => {
      // Reported, not fixed: the JSDoc says "order-insensitive"; the implementation preserves
      // argument order. The current behaviour is what callers must rely on.
      expect(dedupeKey('a', 'b')).toBe('a:b');
      expect(dedupeKey('b', 'a')).toBe('b:a');
      expect(dedupeKey('a', 'b')).not.toBe(dedupeKey('b', 'a'));
    });

    it('keeps a whitespace-only part as an empty segment', () => {
      // Also reported: '   ' is not filtered (it is not ''), then trims away to nothing,
      // producing a double colon.
      expect(dedupeKey('a', '   ', 'b')).toBe('a::b');
    });

    it('is deterministic and always lowercase and whitespace-free', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(fc.string(), fc.integer(), fc.constant(null), fc.constant(undefined)),
            { maxLength: 8 },
          ),
          (parts) => {
            const key = dedupeKey(...parts);
            expect(dedupeKey(...parts)).toBe(key);
            expect(/\s/.test(key)).toBe(false);
            expect(/[A-Z]/.test(key)).toBe(false);
          },
        ),
      );
    });

    it('never lets a dropped part change the key', () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (left, right) => {
          expect(dedupeKey(left, null, right)).toBe(dedupeKey(left, undefined, right));
          expect(dedupeKey(left, '', right)).toBe(dedupeKey(left, null, right));
        }),
      );
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// domain.ts
// ════════════════════════════════════════════════════════════════════════════════════════

describe('domain', () => {
  describe('label completeness', () => {
    it('labels every subscription status', () => {
      expectLabelled(SUBSCRIPTION_STATUSES, SUBSCRIPTION_STATUS_LABELS);
    });

    it('labels every billing channel', () => {
      expectLabelled(BILLING_CHANNELS, BILLING_CHANNEL_LABELS);
    });

    it('labels every cancellation method', () => {
      expectLabelled(CANCELLATION_METHODS, CANCELLATION_METHOD_LABELS);
    });

    it('labels every cancellation status', () => {
      expectLabelled(CANCELLATION_STATUSES, CANCELLATION_STATUS_LABELS);
    });

    it('labels every category', () => {
      expectLabelled(CATEGORIES, CATEGORY_LABELS);
    });

    it('labels every connection status', () => {
      expectLabelled(CONNECTION_STATUSES, CONNECTION_STATUS_LABELS);
    });

    it('labels all five cancellation difficulties', () => {
      const difficulties: readonly CancellationDifficulty[] = [1, 2, 3, 4, 5];
      expect(Object.keys(DIFFICULTY_LABELS).sort()).toEqual(['1', '2', '3', '4', '5']);
      for (const level of difficulties) {
        expect(DIFFICULTY_LABELS[level].trim()).not.toBe('');
      }
      expect(new Set(Object.values(DIFFICULTY_LABELS)).size).toBe(5);
    });

    it('gives every notification type a default lead time', () => {
      expectRecordCoversExactly(NOTIFICATION_TYPES, DEFAULT_LEAD_TIME_DAYS);
    });

    it('keeps the unlabelled vocabularies free of duplicates', () => {
      // These four have no label record in core; see the accompanying report.
      for (const members of [SUBSCRIPTION_SOURCES, DETECTION_STATUSES, NOTIFICATION_TYPES, NOTIFICATION_CHANNELS]) {
        expect(new Set(members).size).toBe(members.length);
      }
      expect([...SUBSCRIPTION_SOURCES]).toEqual(['manual', 'detected', 'csv_import', 'email_receipt']);
      expect([...DETECTION_STATUSES]).toEqual(['pending', 'confirmed', 'dismissed', 'merged']);
      expect([...NOTIFICATION_CHANNELS]).toEqual(['email', 'push', 'in_app']);
    });
  });

  describe('isCommitted', () => {
    const expected: Readonly<Record<SubscriptionStatus, boolean>> = {
      trialing: true,
      active: true,
      cancel_scheduled: true,
      canceled: false,
      lapsed: false,
      paused: false,
      unknown: false,
    };

    it('counts trialing, active and cancel_scheduled as committed spend', () => {
      expect(isCommitted('trialing')).toBe(true);
      expect(isCommitted('active')).toBe(true);
      expect(isCommitted('cancel_scheduled')).toBe(true);
    });

    it('excludes canceled, lapsed, paused and unknown', () => {
      expect(isCommitted('canceled')).toBe(false);
      expect(isCommitted('lapsed')).toBe(false);
      expect(isCommitted('paused')).toBe(false);
      expect(isCommitted('unknown')).toBe(false);
    });

    it('is decided for every member of the union', () => {
      for (const status of SUBSCRIPTION_STATUSES) {
        expect(isCommitted(status)).toBe(expected[status]);
      }
    });

    it('agrees with COMMITTED_STATUSES', () => {
      expect([...COMMITTED_STATUSES]).toEqual(['trialing', 'active', 'cancel_scheduled']);
      for (const status of SUBSCRIPTION_STATUSES) {
        expect(COMMITTED_STATUSES.includes(status)).toBe(isCommitted(status));
      }
    });
  });

  describe('isIntermediated', () => {
    const expected: Readonly<Record<BillingChannel, boolean>> = {
      apple: true,
      google: true,
      amazon: true,
      roku: true,
      carrier: true,
      microsoft: true,
      direct: false,
      paypal: false,
      steam: false,
      unknown: false,
    };

    it('flags the store-billed channels', () => {
      for (const channel of ['apple', 'google', 'amazon', 'roku', 'carrier', 'microsoft'] as const) {
        expect(isIntermediated(channel)).toBe(true);
      }
    });

    it('does not flag direct, paypal, steam or unknown', () => {
      for (const channel of ['direct', 'paypal', 'steam', 'unknown'] as const) {
        expect(isIntermediated(channel)).toBe(false);
      }
    });

    it('treats paypal as a payment rail, not a store', () => {
      expect(isIntermediated('paypal')).toBe(false);
      expect(INTERMEDIATED_CHANNELS.includes('paypal')).toBe(false);
    });

    it('is decided for every member of the union', () => {
      for (const channel of BILLING_CHANNELS) {
        expect(isIntermediated(channel)).toBe(expected[channel]);
      }
    });

    it('agrees with INTERMEDIATED_CHANNELS', () => {
      expect([...INTERMEDIATED_CHANNELS]).toEqual(['apple', 'google', 'amazon', 'roku', 'carrier', 'microsoft']);
      for (const channel of BILLING_CHANNELS) {
        expect(INTERMEDIATED_CHANNELS.includes(channel)).toBe(isIntermediated(channel));
      }
    });
  });

  describe('ignoresQuietHours', () => {
    it('is true only for charged_after_cancellation', () => {
      expect(ignoresQuietHours('charged_after_cancellation')).toBe(true);
      for (const type of NOTIFICATION_TYPES) {
        expect(ignoresQuietHours(type)).toBe(type === 'charged_after_cancellation');
      }
    });

    it('leaves the calm notifications inside quiet hours', () => {
      for (const type of ['trial_ending', 'renewal_upcoming', 'price_changed', 'new_detections'] as const) {
        expect(ignoresQuietHours(type)).toBe(false);
      }
    });

    it('agrees with URGENT_NOTIFICATION_TYPES', () => {
      expect([...URGENT_NOTIFICATION_TYPES]).toEqual(['charged_after_cancellation']);
      for (const type of NOTIFICATION_TYPES) {
        expect(URGENT_NOTIFICATION_TYPES.includes(type)).toBe(ignoresQuietHours(type));
      }
    });
  });

  describe('DEFAULT_LEAD_TIME_DAYS', () => {
    it('has an entry for every notification type', () => {
      for (const type of NOTIFICATION_TYPES) {
        expect(DEFAULT_LEAD_TIME_DAYS[type]).toBeTypeOf('number');
      }
      expect(Object.keys(DEFAULT_LEAD_TIME_DAYS)).toHaveLength(NOTIFICATION_TYPES.length);
    });

    it('pins the three lead times the brief specifies', () => {
      expect(DEFAULT_LEAD_TIME_DAYS.trial_ending).toBe(3);
      expect(DEFAULT_LEAD_TIME_DAYS.cancel_by_deadline).toBe(7);
      expect(DEFAULT_LEAD_TIME_DAYS.consent_expiring).toBe(14);
    });

    it('uses whole non-negative days, never fractions', () => {
      for (const type of NOTIFICATION_TYPES) {
        const days = DEFAULT_LEAD_TIME_DAYS[type];
        expect(Number.isInteger(days)).toBe(true);
        expect(days).toBeGreaterThanOrEqual(0);
      }
    });

    it('gives every urgent type a zero lead time — it fires on the event, not before', () => {
      for (const type of URGENT_NOTIFICATION_TYPES) {
        expect(DEFAULT_LEAD_TIME_DAYS[type]).toBe(0);
      }
    });

    it('converts cleanly to a millisecond window with the clock constants', () => {
      const types: readonly NotificationType[] = NOTIFICATION_TYPES;
      for (const type of types) {
        const window = DEFAULT_LEAD_TIME_DAYS[type] * MILLIS_PER_DAY;
        expect(Number.isSafeInteger(window)).toBe(true);
      }
      expect(DEFAULT_LEAD_TIME_DAYS.consent_expiring * MILLIS_PER_DAY).toBe(1_209_600_000);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// errors.ts
// ════════════════════════════════════════════════════════════════════════════════════════

// Exhaustive at compile time: adding a member to LedgerErrorCode breaks this object.
const ALL_ERROR_CODES = {
  INVALID_ARGUMENT: true,
  CURRENCY_MISMATCH: true,
  UNSUPPORTED_CURRENCY: true,
  MONEY_OVERFLOW: true,
  INVALID_DATE: true,
  INVALID_INTERVAL: true,
  INVALID_STATE_TRANSITION: true,
  NOT_FOUND: true,
  FORBIDDEN: true,
  CONFLICT: true,
  RATE_LIMITED: true,
  UPSTREAM_ERROR: true,
  CONFIGURATION_ERROR: true,
  ENCRYPTION_ERROR: true,
} satisfies Record<LedgerErrorCode, true>;

const ERROR_CODES = Object.keys(ALL_ERROR_CODES) as LedgerErrorCode[];

describe('errors', () => {
  describe('LedgerError', () => {
    it('carries the code and the message', () => {
      const error = new LedgerError('NOT_FOUND', 'Subscription 42 does not exist.');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(LedgerError);
      expect(error.name).toBe('LedgerError');
      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toBe('Subscription 42 does not exist.');
      expect(typeof error.stack).toBe('string');
    });

    it('carries structured meta', () => {
      const error = new LedgerError('CONFLICT', 'Already linked.', {
        meta: { subscriptionId: 'sub_42', attempt: 2 },
      });
      expect(error.meta).toEqual({ subscriptionId: 'sub_42', attempt: 2 });
    });

    it('defaults meta to an empty object rather than undefined', () => {
      const error = new LedgerError('FORBIDDEN', 'No.');
      expect(error.meta).toEqual({});
      expect(Object.keys(error.meta)).toHaveLength(0);
    });

    it('defaults options entirely when omitted', () => {
      const error = new LedgerError('RATE_LIMITED', 'Slow down.');
      expect(error.meta).toEqual({});
      expect('cause' in error).toBe(false);
    });

    it('preserves a cause when one is given', () => {
      const root = new TypeError('socket hang up');
      const error = new LedgerError('UPSTREAM_ERROR', 'Provider call failed.', { cause: root });

      expect(error.cause).toBe(root);
      expect('cause' in error).toBe(true);
    });

    it('accepts a non-Error cause', () => {
      const error = new LedgerError('UPSTREAM_ERROR', 'Provider call failed.', { cause: 'HTTP 503' });
      expect(error.cause).toBe('HTTP 503');
    });

    it('omits the cause property entirely when none is given', () => {
      const error = new LedgerError('CONFIGURATION_ERROR', 'Missing key.');
      expect('cause' in error).toBe(false);
    });

    it('carries a cause and meta together', () => {
      const root = new Error('boom');
      const error = new LedgerError('ENCRYPTION_ERROR', 'Could not unwrap the DEK.', {
        cause: root,
        meta: { keyVersion: 3 },
      });

      expect(error.cause).toBe(root);
      expect(error.meta).toEqual({ keyVersion: 3 });
      expect(error.code).toBe('ENCRYPTION_ERROR');
    });

    it('is throwable and catchable as a LedgerError', () => {
      expect(() => {
        throw new LedgerError('MONEY_OVERFLOW', 'Too much money.');
      }).toThrow(LedgerError);
      expect(() => {
        throw new LedgerError('MONEY_OVERFLOW', 'Too much money.');
      }).toThrow('Too much money.');
    });

    it('accepts every code in the union', () => {
      fc.assert(
        fc.property(fc.constantFrom(...ERROR_CODES), (code) => {
          const error = new LedgerError(code, `failure: ${code}`);
          expect(error.code).toBe(code);
          expect(describeError(error)).toEqual({ message: `failure: ${code}`, code });
        }),
      );
    });
  });

  describe('subclasses', () => {
    it('InvalidArgumentError sets name and code', () => {
      const error = new InvalidArgumentError('Month out of range: 13');

      expect(error).toBeInstanceOf(LedgerError);
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect(error.name).toBe('InvalidArgumentError');
      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.message).toBe('Month out of range: 13');
      expect(error.meta).toEqual({});
    });

    it('InvalidArgumentError forwards options through to LedgerError', () => {
      const root = new Error('root');
      const error = new InvalidArgumentError('bad', { cause: root, meta: { field: 'day' } });

      expect(error.cause).toBe(root);
      expect(error.meta).toEqual({ field: 'day' });
      expect(error.name).toBe('InvalidArgumentError');
    });

    it('CurrencyMismatchError names both currencies in message and meta', () => {
      const error = new CurrencyMismatchError('USD', 'EUR');

      expect(error).toBeInstanceOf(LedgerError);
      expect(error.name).toBe('CurrencyMismatchError');
      expect(error.code).toBe('CURRENCY_MISMATCH');
      expect(error.message).toBe('Cannot combine USD and EUR without an explicit FX rate.');
      expect(error.meta).toEqual({ left: 'USD', right: 'EUR' });
      expect('cause' in error).toBe(false);
    });

    it('UnsupportedCurrencyError names the code in message and meta', () => {
      const error = new UnsupportedCurrencyError('XYZ');

      expect(error).toBeInstanceOf(LedgerError);
      expect(error.name).toBe('UnsupportedCurrencyError');
      expect(error.code).toBe('UNSUPPORTED_CURRENCY');
      expect(error.message).toBe('Unknown ISO-4217 currency code: XYZ');
      expect(error.meta).toEqual({ code: 'XYZ' });
    });

    it('InvalidStateTransitionError names entity, from and to', () => {
      const error = new InvalidStateTransitionError('Subscription', 'canceled', 'trialing');

      expect(error).toBeInstanceOf(LedgerError);
      expect(error.name).toBe('InvalidStateTransitionError');
      expect(error.code).toBe('INVALID_STATE_TRANSITION');
      expect(error.message).toBe('Subscription cannot move from canceled to trialing.');
      expect(error.meta).toEqual({ entity: 'Subscription', from: 'canceled', to: 'trialing' });
    });

    it('gives each subclass a distinct name and the right code', () => {
      const cases = [
        { error: new InvalidArgumentError('x'), name: 'InvalidArgumentError', code: 'INVALID_ARGUMENT' },
        { error: new CurrencyMismatchError('USD', 'GBP'), name: 'CurrencyMismatchError', code: 'CURRENCY_MISMATCH' },
        { error: new UnsupportedCurrencyError('AAA'), name: 'UnsupportedCurrencyError', code: 'UNSUPPORTED_CURRENCY' },
        {
          error: new InvalidStateTransitionError('Cancellation', 'draft', 'verified'),
          name: 'InvalidStateTransitionError',
          code: 'INVALID_STATE_TRANSITION',
        },
      ] as const;

      for (const { error, name, code } of cases) {
        expect(error.name).toBe(name);
        expect(error.code).toBe(code);
        expect(error).toBeInstanceOf(LedgerError);
        expect(error).toBeInstanceOf(Error);
        expect(isLedgerError(error)).toBe(true);
      }

      expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
    });

    it('is catchable by its own subclass without catching its siblings', () => {
      expect(() => {
        throw new CurrencyMismatchError('USD', 'EUR');
      }).toThrow(CurrencyMismatchError);

      let caught: unknown;
      try {
        throw new UnsupportedCurrencyError('ZZZ');
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UnsupportedCurrencyError);
      expect(caught).not.toBeInstanceOf(CurrencyMismatchError);
    });
  });

  describe('isLedgerError', () => {
    it('narrows a LedgerError so its code is reachable', () => {
      const value: unknown = new CurrencyMismatchError('USD', 'EUR');
      const code = isLedgerError(value) ? value.code : null;
      const meta = isLedgerError(value) ? value.meta : null;

      expect(code).toBe('CURRENCY_MISMATCH');
      expect(meta).toEqual({ left: 'USD', right: 'EUR' });
    });

    it('rejects a plain Error', () => {
      const value: unknown = new Error('boom');
      expect(isLedgerError(value)).toBe(false);
      expect(isLedgerError(value) ? value.code : 'not-a-ledger-error').toBe('not-a-ledger-error');
    });

    it('rejects a string', () => {
      const value: unknown = 'CURRENCY_MISMATCH';
      expect(isLedgerError(value)).toBe(false);
      expect(isLedgerError(value) ? value.code : 'not-a-ledger-error').toBe('not-a-ledger-error');
    });

    it('rejects lookalikes and empty values', () => {
      const lookalike: unknown = { name: 'LedgerError', code: 'NOT_FOUND', message: 'nope' };
      for (const value of [lookalike, null, undefined, 0, '', new TypeError('t'), [], {}]) {
        expect(isLedgerError(value)).toBe(false);
      }
    });

    it('accepts every subclass', () => {
      for (const error of [
        new LedgerError('NOT_FOUND', 'x'),
        new InvalidArgumentError('x'),
        new CurrencyMismatchError('a', 'b'),
        new UnsupportedCurrencyError('c'),
        new InvalidStateTransitionError('e', 'f', 't'),
      ]) {
        expect(isLedgerError(error)).toBe(true);
      }
    });
  });

  describe('describeError', () => {
    it('returns message and code for a LedgerError', () => {
      const described = describeError(new LedgerError('RATE_LIMITED', 'Too many requests.'));
      expect(described).toEqual({ message: 'Too many requests.', code: 'RATE_LIMITED' });
      expect(described.code).toBe('RATE_LIMITED');
    });

    it('returns the subclass code', () => {
      expect(describeError(new UnsupportedCurrencyError('XYZ'))).toEqual({
        message: 'Unknown ISO-4217 currency code: XYZ',
        code: 'UNSUPPORTED_CURRENCY',
      });
    });

    it('returns only a message for a plain Error, with no code key at all', () => {
      const described = describeError(new Error('socket hang up'));
      expect(described.message).toBe('socket hang up');
      expect('code' in described).toBe(false);
    });

    it('handles other built-in Error subclasses', () => {
      const described = describeError(new TypeError('x is not a function'));
      expect(described.message).toBe('x is not a function');
      expect('code' in described).toBe(false);
    });

    it('stringifies non-Error values', () => {
      expect(describeError('just a string')).toEqual({ message: 'just a string' });
      expect(describeError(42)).toEqual({ message: '42' });
      expect(describeError(null)).toEqual({ message: 'null' });
      expect(describeError(undefined)).toEqual({ message: 'undefined' });
      expect(describeError(true)).toEqual({ message: 'true' });
      expect(describeError({ a: 1 })).toEqual({ message: '[object Object]' });
      expect(describeError(['a', 'b'])).toEqual({ message: 'a,b' });
    });

    it('never leaks meta into the description', () => {
      const described = describeError(
        new LedgerError('ENCRYPTION_ERROR', 'Could not unwrap.', { meta: { keyVersion: 9 } }),
      );
      expect(described).toEqual({ message: 'Could not unwrap.', code: 'ENCRYPTION_ERROR' });
      expect('meta' in described).toBe(false);
    });

    it('always returns a string message for any input', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string(),
            fc.integer(),
            fc.boolean(),
            fc.constant(null),
            fc.constant(undefined),
            fc.string().map((m) => new Error(m)),
            fc.tuple(fc.constantFrom(...ERROR_CODES), fc.string()).map(([code, m]) => new LedgerError(code, m)),
          ),
          (value) => {
            const described = describeError(value);
            expect(typeof described.message).toBe('string');
            expect(('code' in described)).toBe(isLedgerError(value));
          },
        ),
      );
    });
  });
});
