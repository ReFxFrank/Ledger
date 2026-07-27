/**
 * `pnpm seed:loadtest` — the corpus the Phase 10 acceptance criterion is measured against.
 *
 * One user, 200 subscriptions, 50,000 transactions across four accounts on two connections.
 * Those three numbers are the brief's, and everything else here exists to keep the *shape* of the
 * data honest rather than merely its size:
 *
 *  - **Money is integer minor units and cadence is a `RecurrenceInterval`**, produced by the same
 *    `@ledger/core` helpers the demo seed uses. A load corpus built from `Math.round(price * 100)`
 *    and "every 30 days" would measure a query plan against rows the app cannot actually produce.
 *  - **The cadence mix is not uniform.** A real portfolio is mostly monthly with a long tail of
 *    weekly, four-weekly, quarterly and annual, and those tails are exactly what makes the horizon
 *    projection expensive — a weekly subscription contributes 104 rows to a 24-month feed and 8
 *    ticks to a 60-day horizon, a monthly one contributes 24 and 2.
 *  - **Recurring charges are ~10% of the feed.** Subscriptions are a minority of anyone's bank
 *    statement, and a 50k-row table where every row clusters into 200 keys would make detection
 *    reconciliation look far cheaper than it is.
 *  - **Merchants come from the registry**, not from invented strings, so `subscriptions.list`'s
 *    left join to `merchants` resolves for most rows instead of being a no-op.
 *
 * Determinism is a hard requirement, same as the demo seed: a seeded mulberry32 rather than
 * `Math.random`, an injected reference date rather than the wall clock, and every id derived from
 * a stable name so a second run is a pile of no-ops instead of a second 50,000 rows.
 *
 * The load user is a **separate** user from the demo one and lives under its own id namespace.
 * Measuring against the demo user would mean measuring against 20 subscriptions.
 */

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import {
  ANNUAL,
  type BillingChannel,
  type Category,
  CATEGORIES,
  type DetectionStatus,
  FOUR_WEEKLY,
  MONTHLY,
  type PlainDate,
  QUARTERLY,
  type RecurrenceInterval,
  SEMIANNUAL,
  type SubscriptionStatus,
  WEEKLY,
  addDays,
  addMonths,
  formatPlainDate,
  isCommitted,
  lastOccurrenceOnOrBefore,
  money,
  nextOccurrenceAfter,
  occurrencesBetween,
  parsePlainDate,
  relativeChangeBps,
  scale,
  toInstant,
} from '@ledger/core';
import { aadFor, getKeyring, seal } from '@ledger/crypto';
import { loadRootEnv } from '@ledger/env';
import { type Database, createDatabase } from '../client';
import {
  accounts,
  bankAccounts,
  bankConnections,
  detections,
  merchants,
  paymentMethods,
  subscriptionPriceHistory,
  subscriptions,
  transactions,
  twoFactors,
  users,
} from '../schema/index';
import { buildDemoCredentials } from '../seed/credentials';
import { derivedUuid } from '../seed/ids';
import { sealTotpSecret } from '../seed/demo';
import { transition } from '../state/subscription';

// ── the numbers the acceptance criterion names ─────────────────────────────────────────

const SUBSCRIPTION_COUNT = 200;
const TRANSACTION_COUNT = 50_000;
const ACCOUNT_COUNT = 4;
const CONNECTION_COUNT = 2;

/** Matches the real backfill window, and `TRANSACTION_RETENTION_MONTHS`' default. */
const HISTORY_MONTHS = 24;

/** Same pinned "today" as the demo seed, so both fixtures describe the same week. */
const DEFAULT_REFERENCE_DATE = '2026-07-20';

const NAMESPACE = 'ledger.seed.loadtest.v1';
const LOAD_USER_ID = 'loadtest-user-ledger';
export const LOAD_EMAIL = 'loadtest@ledger.local';
/** Twelve characters is better-auth's floor; this is printed, so it is not a secret. */
export const LOAD_PASSWORD = 'loadtest-ledger-2026';
const TIMEZONE = 'Europe/London';

/**
 * Rows per INSERT.
 *
 * `transactions` has 13 bound columns, so 1,000 rows is ~13,000 parameters — comfortably under
 * Postgres' 65,535 limit with room for the column count to grow. Chunking at all is the
 * difference between "a couple of minutes" and "an hour": 50,000 single-row inserts is 50,000
 * round trips.
 */
const BATCH_ROWS = 1_000;

function loadUuid(name: string): string {
  return derivedUuid(NAMESPACE, name);
}

// ── deterministic randomness ───────────────────────────────────────────────────────────

/**
 * mulberry32, seeded.
 *
 * Same rule as the fixture adapter: no `Math.random`. A corpus that differs between runs makes a
 * before/after performance comparison meaningless, because the second measurement is against
 * different data.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Picks from a weighted table. Weights are integers so the mix is readable at the call site. */
function weighted<T>(random: () => number, table: readonly (readonly [T, number])[]): T {
  const total = table.reduce((sum, [, weight]) => sum + weight, 0);
  let ticket = random() * total;
  for (const [value, weight] of table) {
    ticket -= weight;
    if (ticket <= 0) return value;
  }
  // Unreachable while `total > 0`; the fallback exists because the compiler cannot know that.
  const last = table[table.length - 1];
  if (last === undefined) throw new Error('weighted() needs at least one entry.');
  return last[0];
}

function pick<T>(random: () => number, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error('pick() from an empty array.');
  return value;
}

function integerBetween(random: () => number, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1));
}

// ── the shape of a realistic portfolio ─────────────────────────────────────────────────

const CADENCES: readonly (readonly [RecurrenceInterval, number])[] = [
  [MONTHLY, 60],
  [ANNUAL, 12],
  [WEEKLY, 8],
  [FOUR_WEEKLY, 8],
  [QUARTERLY, 7],
  [SEMIANNUAL, 5],
];

const CURRENCIES: readonly (readonly [string, number])[] = [
  ['USD', 70],
  ['GBP', 18],
  ['EUR', 12],
];

/**
 * The price ladder, in minor units.
 *
 * Real subscription prices cluster on .99 and .00 endings rather than spreading uniformly, and
 * the clustering matters: `aggregateCommitments` allocates remainders, and a corpus of round
 * numbers never exercises that path.
 */
const MONTHLY_PRICES: readonly number[] = [
  299, 499, 599, 699, 799, 899, 999, 1099, 1199, 1299, 1499, 1599, 1799, 1999, 2299, 2499, 2999,
  3499, 3999, 4999,
];

const ANNUAL_PRICES: readonly number[] = [
  2999, 3999, 4999, 5988, 6999, 8988, 9588, 11_988, 14_999, 19_999, 23_988, 29_988, 65_988,
];

const BILLING_CHANNEL_MIX: readonly (readonly [BillingChannel, number])[] = [
  ['direct', 66],
  ['apple', 10],
  ['google', 8],
  ['paypal', 6],
  ['amazon', 4],
  ['microsoft', 2],
  ['carrier', 2],
  ['steam', 2],
];

/**
 * Every status is reached through the state machine rather than written straight in.
 *
 * Same reason as the demo seed: a fixture in a state the transition table forbids makes a
 * genuinely broken machine look fine, and here it would also skew the totals — `isCommitted`
 * decides which rows count toward the monthly figure, so an impossible status is an impossible
 * total.
 */
const STATUS_MIX: readonly (readonly [SubscriptionStatus, number])[] = [
  ['active', 74],
  ['canceled', 8],
  ['paused', 6],
  ['cancel_scheduled', 5],
  ['trialing', 4],
  ['lapsed', 3],
];

function arriveAt(status: SubscriptionStatus): SubscriptionStatus {
  const created = transition('unknown', 'user_created', 'active').to;
  switch (status) {
    case 'active':
      return created;
    case 'trialing':
      return transition('unknown', 'user_created', 'trialing').to;
    case 'paused':
      return transition(created, 'user_paused', 'paused').to;
    case 'cancel_scheduled':
      return transition(created, 'cancellation_started', 'cancel_scheduled').to;
    case 'canceled':
      return transition(
        transition(created, 'cancellation_started', 'cancel_scheduled').to,
        'cancellation_verified',
        'canceled',
      ).to;
    case 'lapsed':
      // The only route to `lapsed`: charges stop, the row is paused, and two periods pass with
      // nothing arriving. There is no direct active → lapsed edge, and there should not be.
      return transition(
        transition(created, 'charges_stopped', 'paused').to,
        'charges_long_stopped',
        'lapsed',
      ).to;
    case 'unknown':
      return 'unknown';
  }
}

/** Descriptor noise a bank actually emits, so `normalized_key` has something to strip. */
const DESCRIPTOR_SUFFIXES: readonly string[] = [
  '',
  ' 800-555-0100',
  ' CA',
  ' LONDON GB',
  ' *RECURRING',
  ' #4471',
  ' AMSTERDAM NL',
];

const CHANNEL_PREFIXES: Readonly<Record<BillingChannel, string>> = {
  direct: '',
  apple: 'APPLE.COM/BILL ',
  google: 'GOOGLE *',
  amazon: 'AMZN Mktp ',
  paypal: 'PAYPAL *',
  roku: 'ROKU FOR ',
  carrier: 'CARRIER BILL ',
  microsoft: 'MSFT * ',
  steam: 'STEAMGAMES.COM ',
  unknown: '',
};

/** The one-off spend a subscription feed has to be found inside. */
const NOISE_MERCHANTS: readonly string[] = [
  'TESCO STORES 3421',
  'SAINSBURYS SMKT',
  'PRET A MANGER',
  'SHELL OIL 574212',
  'UBER *TRIP',
  'LYFT *RIDE',
  'AMZN Mktp US*2K4LD',
  'TARGET 00012345',
  'WALGREENS #4471',
  'CVS/PHARMACY #0288',
  'STARBUCKS STORE 118',
  'MCDONALDS F1029',
  'DELTA AIR 0062314',
  'BOOKING.COM HOTEL',
  'AIRBNB * HMXQR2',
  'TFL TRAVEL CHARGE',
  'NATIONAL RAIL',
  'HOME DEPOT 6112',
  'IKEA LONDON',
  'ARGOS RETAIL',
  'BOOTS 1234',
  'GREGGS PLC',
  'WAITROSE 621',
  'ALDI STORES 88',
  'LIDL GB LONDON',
  'PAYPAL *ETSYSELLER',
  'SQ *COFFEE CART',
  'SUMUP *BARBER',
  'ZETTLE_*BAKERY',
  'EXXONMOBIL 9812',
  'COSTCO WHSE #0431',
  'BEST BUY 00019',
  'APPLE STORE R412',
  'JOHN LEWIS OXFORD',
  'M&S SIMPLY FOOD',
  'DOORDASH*ORDER',
  'DELIVEROO LONDON',
  'JUST EAT ORDER',
  'GRUBHUB*FOOD',
  'CINEWORLD 4412',
  'ODEON CINEMAS',
  'AMC ONLINE 8811',
  'PARKING METER 2213',
  'RINGGO PARKING',
  'ATM WITHDRAWAL',
  'TRANSFER TO SAVINGS',
  'COUNCIL TAX DD',
  'HMRC PAYMENT',
  'CAR INSURANCE DD',
  'DENTIST PRACTICE',
  'VETS4PETS 221',
  'PETSMART #4412',
  'B&Q 1189',
  'SCREWFIX DIRECT',
  'HALFORDS 0442',
  'DECATHLON UK',
  'SPORTS DIRECT',
  'ZARA UK 4471',
  'UNIQLO LONDON',
  'H&M HENNES 8812',
];

/**
 * The clustering key.
 *
 * `normalizeDescriptor` lives in `@ledger/detection`, which @ledger/db does not and should not
 * depend on — detection is a pure package that this one is downstream of, and inverting that for
 * a fixture would be the wrong trade. What the load test needs from this column is its
 * *distribution*: ~260 distinct keys over 50,000 rows, with descriptor noise collapsing onto the
 * same key. This produces that. It is not the detector's normalizer and the corpus is not used
 * to measure detection quality — `packages/detection/test` does that, against the real one.
 */
function loadNormalizedKey(descriptor: string): string {
  return descriptor
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
}

/**
 * `sha256(accountId | postedDate | amountMinor | normalizedKey)`.
 *
 * The same formula as `dedupeHashFor` in @ledger/banking, restated for the same dependency reason
 * as above (banking depends on db, not the other way round). If the two ever disagree the only
 * consequence is that a load-seeded row and a synced row would not collide with each other, which
 * no test depends on — but they agree today, and this comment is where to look if that changes.
 */
function dedupeHash(
  accountId: string,
  postedOn: PlainDate,
  amountMinor: number,
  normalizedKey: string,
): string {
  return createHash('sha256')
    .update(`${accountId}|${formatPlainDate(postedOn)}|${String(amountMinor)}|${normalizedKey}`, 'utf8')
    .digest('hex');
}

// ── generated rows ─────────────────────────────────────────────────────────────────────

interface GeneratedSubscription {
  readonly id: string;
  readonly index: number;
  readonly merchantId: string | null;
  readonly displayName: string;
  readonly descriptor: string;
  readonly normalizedKey: string;
  readonly status: SubscriptionStatus;
  readonly amountMinor: number;
  readonly currency: string;
  readonly interval: RecurrenceInterval;
  readonly anchor: PlainDate;
  readonly nextRenewalAt: Date | null;
  readonly lastChargedAt: Date | null;
  readonly trialEndsAt: Date | null;
  readonly billingChannel: BillingChannel;
  readonly paymentMethodId: string;
  readonly category: Category;
  readonly accountIndex: number;
  readonly variableAmount: boolean;
  readonly priceHistory: readonly {
    readonly id: string;
    readonly amountMinor: number;
    readonly effectiveFrom: string;
    readonly deltaBps: number | null;
  }[];
}

interface MerchantRef {
  readonly id: string;
  readonly name: string;
}

const PRIMARY_CARD_ID = loadUuid('payment-method:primary');
const SECOND_CARD_ID = loadUuid('payment-method:second');

function buildSubscriptions(
  random: () => number,
  reference: PlainDate,
  merchantRefs: readonly MerchantRef[],
): GeneratedSubscription[] {
  const at = (date: PlainDate, hour = 9): Date => toInstant(date, TIMEZONE, hour);
  const cards = [PRIMARY_CARD_ID, SECOND_CARD_ID];

  return Array.from({ length: SUBSCRIPTION_COUNT }, (_unused, index): GeneratedSubscription => {
    const cadence = weighted(random, CADENCES);
    const currency = weighted(random, CURRENCIES);
    const isAnnualish = cadence.unit === 'year' || (cadence.unit === 'month' && cadence.count >= 6);
    const amountMinor = pick(random, isAnnualish ? ANNUAL_PRICES : MONTHLY_PRICES);
    const channel = weighted(random, BILLING_CHANNEL_MIX);
    const status = arriveAt(weighted(random, STATUS_MIX));

    const merchant = merchantRefs[index % Math.max(merchantRefs.length, 1)];
    const displayName =
      merchant === undefined
        ? `Load subscription ${String(index + 1)}`
        : `${merchant.name} — plan ${String(Math.floor(index / merchantRefs.length) + 1)}`;

    const descriptor =
      `${CHANNEL_PREFIXES[channel]}${(merchant?.name ?? `LOADSUB${String(index)}`).toUpperCase()}` +
      pick(random, DESCRIPTOR_SUFFIXES);

    // Spread across the whole window so the feed is not front-loaded, and never newer than the
    // cadence: a subscription anchored last week cannot have a two-year history.
    const anchorMonthsAgo = integerBetween(random, 1, HISTORY_MONTHS);
    const anchor = addDays(addMonths(reference, -anchorMonthsAgo), integerBetween(random, 0, 27));

    const isTrial = status === 'trialing';
    const trialEnd = isTrial ? addDays(reference, integerBetween(random, 1, 12)) : null;
    const effectiveAnchor = trialEnd ?? anchor;

    const lastCharged = isTrial
      ? null
      : lastOccurrenceOnOrBefore(effectiveAnchor, cadence, reference);
    const nextRenewal = isCommitted(status)
      ? (trialEnd ?? nextOccurrenceAfter(effectiveAnchor, cadence, reference))
      : null;

    return {
      id: loadUuid(`subscription:${String(index)}`),
      index,
      merchantId: merchant?.id ?? null,
      displayName,
      descriptor,
      normalizedKey: loadNormalizedKey(descriptor),
      status,
      amountMinor,
      currency,
      interval: cadence,
      anchor: effectiveAnchor,
      nextRenewalAt: nextRenewal === null ? null : at(nextRenewal),
      lastChargedAt: lastCharged === null ? null : at(lastCharged),
      trialEndsAt: trialEnd === null ? null : at(trialEnd, 12),
      billingChannel: channel,
      paymentMethodId: cards[index % cards.length] ?? PRIMARY_CARD_ID,
      category: pick(random, CATEGORIES),
      accountIndex: index % ACCOUNT_COUNT,
      // Utilities and telecom bill differently every month; the flag is what tells the UI the
      // amount is a median rather than a promise.
      variableAmount: random() < 0.08,
      priceHistory: buildPriceHistory(random, index, amountMinor, currency, reference),
    };
  });
}

/**
 * A price ladder for about a third of the portfolio.
 *
 * `relativeChangeBps` rather than a hand-written percentage, for the same reason the demo seed
 * uses it: the attention queue filters on `delta_bps >= 300`, and a fixture whose deltas were
 * typed rather than computed would be measuring that index against numbers the app never writes.
 */
function buildPriceHistory(
  random: () => number,
  index: number,
  amountMinor: number,
  currency: string,
  reference: PlainDate,
): GeneratedSubscription['priceHistory'] {
  if (random() >= 0.33) return [];

  const steps = integerBetween(random, 2, 3);
  const rows: { id: string; amountMinor: number; effectiveFrom: string; deltaBps: number | null }[] =
    [];

  // Walk backwards from today's price so the newest row is the amount actually on the row.
  let current = amountMinor;
  const amounts: number[] = [current];
  for (let step = 1; step < steps; step += 1) {
    current = Math.max(99, Math.round(current * (1 - (integerBetween(random, 4, 18) / 100))));
    amounts.unshift(current);
  }

  amounts.forEach((value, position) => {
    const previous = amounts[position - 1];
    const monthsAgo = (amounts.length - position) * integerBetween(random, 5, 11);
    rows.push({
      id: loadUuid(`price-history:${String(index)}:${String(position)}`),
      amountMinor: value,
      effectiveFrom: formatPlainDate(addMonths(reference, -monthsAgo)),
      deltaBps:
        previous === undefined
          ? null
          : relativeChangeBps(money(previous, currency), money(value, currency)),
    });
  });

  return rows;
}

interface GeneratedTransaction {
  readonly id: string;
  readonly accountId: string;
  readonly externalId: string;
  readonly postedAt: Date;
  readonly amountMinor: number;
  readonly currency: string;
  readonly rawDescriptor: string;
  readonly normalizedKey: string;
  readonly billingChannel: BillingChannel;
  readonly pending: boolean;
  readonly subscriptionId: string | null;
  readonly dedupeHash: string;
}

/**
 * The feed: every subscription's charges over the window, then one-off spend up to 50,000.
 *
 * The `(account_id, dedupe_hash)` unique index is enforced here rather than left to
 * `ON CONFLICT DO NOTHING`, because "insert 50,000 rows" and "insert as many of 50,000 rows as
 * happen not to collide" are different tests. Nudging the amount by a penny on a collision keeps
 * the row count exact and the distribution intact.
 */
function buildTransactions(
  random: () => number,
  reference: PlainDate,
  subscriptionRows: readonly GeneratedSubscription[],
  accountIds: readonly string[],
  accountCurrencies: readonly string[],
): GeneratedTransaction[] {
  const windowStart = addMonths(reference, -HISTORY_MONTHS);
  const seen = new Set<string>();
  const rows: GeneratedTransaction[] = [];

  const push = (
    accountIndex: number,
    postedOn: PlainDate,
    startingAmountMinor: number,
    descriptor: string,
    normalizedKey: string,
    channel: BillingChannel,
    subscriptionId: string | null,
    pending: boolean,
  ): void => {
    const accountId = accountIds[accountIndex] ?? accountIds[0];
    if (accountId === undefined) throw new Error('No accounts to write transactions against.');

    let amountMinor = startingAmountMinor;
    let hash = dedupeHash(accountId, postedOn, amountMinor, normalizedKey);
    while (seen.has(`${accountId}|${hash}`)) {
      amountMinor += 1;
      hash = dedupeHash(accountId, postedOn, amountMinor, normalizedKey);
    }
    seen.add(`${accountId}|${hash}`);

    const ordinal = rows.length;
    rows.push({
      id: loadUuid(`transaction:${String(ordinal)}`),
      accountId,
      externalId: `loadtest-${String(ordinal).padStart(6, '0')}`,
      // 14:00 local: a posting is a wall-clock event, and midnight would put every row on a
      // date boundary where a timezone offset changes which month it lands in.
      postedAt: toInstant(postedOn, TIMEZONE, 14),
      amountMinor,
      currency: accountCurrencies[accountIndex] ?? 'USD',
      rawDescriptor: descriptor,
      normalizedKey,
      billingChannel: channel,
      pending,
      subscriptionId,
      dedupeHash: hash,
    });
  };

  for (const subscription of subscriptionRows) {
    const charges = occurrencesBetween(
      subscription.anchor,
      subscription.interval,
      windowStart,
      reference,
    );

    for (const date of charges) {
      // A variable-amount subscription wobbles; a fixed one does not. `scale` with an integer
      // numerator and denominator rather than a float factor: money never leaves integer space,
      // and the rounding mode is named rather than whatever `Math.round` happens to do.
      const base = money(subscription.amountMinor, subscription.currency);
      const amount = subscription.variableAmount
        ? scale(base, integerBetween(random, 82, 122), 100).amountMinor
        : base.amountMinor;

      push(
        subscription.accountIndex,
        date,
        amount,
        subscription.descriptor,
        subscription.normalizedKey,
        subscription.billingChannel,
        subscription.id,
        false,
      );
    }
  }

  // Fill the rest with one-off spend. `windowDays` is computed from the same dates the recurring
  // charges used, so noise and signal cover exactly the same window.
  const windowDays = Math.round(
    (toInstant(reference, TIMEZONE, 12).getTime() - toInstant(windowStart, TIMEZONE, 12).getTime()) /
      86_400_000,
  );

  while (rows.length < TRANSACTION_COUNT) {
    const descriptor = pick(random, NOISE_MERCHANTS);
    const accountIndex = integerBetween(random, 0, accountIds.length - 1);
    const dayOffset = integerBetween(random, 0, windowDays);
    const postedOn = addDays(windowStart, dayOffset);

    push(
      accountIndex,
      postedOn,
      integerBetween(random, 199, 24_999),
      descriptor,
      loadNormalizedKey(descriptor),
      'direct',
      null,
      // Only the tail of the feed is pending, which is what a real one looks like — and it is
      // what `analytics.spendOverTime`'s `pending = false` filter has to exclude.
      dayOffset > windowDays - 4 && random() < 0.5,
    );
  }

  return rows.slice(0, TRANSACTION_COUNT);
}

// ── writing ────────────────────────────────────────────────────────────────────────────

async function inBatches<T>(
  rows: readonly T[],
  size: number,
  write: (chunk: readonly T[]) => Promise<unknown>,
  onProgress?: (done: number) => void,
): Promise<void> {
  for (let start = 0; start < rows.length; start += size) {
    await write(rows.slice(start, start + size));
    onProgress?.(Math.min(start + size, rows.length));
  }
}

async function seedLoadUser(
  db: Database,
  reference: PlainDate,
  totpSecretForStorage: string,
  passwordHash: string,
): Promise<void> {
  const now = new Date();

  await db
    .insert(users)
    .values({
      id: LOAD_USER_ID,
      name: 'Load Test',
      email: LOAD_EMAIL,
      emailVerified: true,
      twoFactorEnabled: true,
      displayCurrency: 'USD',
      timezone: TIMEZONE,
      locale: 'en-GB',
      onboardingCompletedAt: toInstant(addMonths(reference, -HISTORY_MONTHS), TIMEZONE, 9),
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        email: sql`excluded.email`,
        emailVerified: sql`excluded.email_verified`,
        twoFactorEnabled: sql`excluded.two_factor_enabled`,
        displayCurrency: sql`excluded.display_currency`,
        timezone: sql`excluded.timezone`,
        deletedAt: null,
        updatedAt: now,
      },
    });

  await db
    .insert(accounts)
    .values({
      id: loadUuid('account:credential'),
      accountId: LOAD_USER_ID,
      providerId: 'credential',
      userId: LOAD_USER_ID,
      password: passwordHash,
    })
    .onConflictDoUpdate({
      target: accounts.id,
      set: { password: sql`excluded.password`, updatedAt: now },
    });

  await db
    .insert(twoFactors)
    .values({
      id: loadUuid('two-factor:totp'),
      userId: LOAD_USER_ID,
      secret: totpSecretForStorage,
      backupCodes: '',
    })
    .onConflictDoUpdate({
      target: twoFactors.id,
      set: { secret: sql`excluded.secret` },
    });

  await db
    .insert(paymentMethods)
    .values([
      {
        id: PRIMARY_CARD_ID,
        userId: LOAD_USER_ID,
        label: 'Load Visa',
        type: 'card' as const,
        brand: 'visa',
        last4: '4242',
        expMonth: 11,
        expYear: reference.year + 2,
      },
      {
        id: SECOND_CARD_ID,
        userId: LOAD_USER_ID,
        label: 'Load Amex',
        type: 'card' as const,
        brand: 'amex',
        last4: '3007',
        expMonth: 4,
        expYear: reference.year + 3,
      },
    ])
    .onConflictDoUpdate({
      target: paymentMethods.id,
      set: { label: sql`excluded.label`, archivedAt: null, updatedAt: now },
    });
}

/**
 * The bank side.
 *
 * A real sealed access token per connection, through `@ledger/crypto` rather than a placeholder
 * string. That costs nothing here and it is what makes this corpus usable as the subject of the
 * backup-restore drill: `scripts/backup-verify.mjs` proves a restored dump's ciphertext still
 * opens under the current `ENCRYPTION_KEY`, and it needs a sealed row to prove it against.
 */
async function seedConnections(
  db: Database,
  reference: PlainDate,
): Promise<{ accountIds: string[]; accountCurrencies: string[] }> {
  const keyring = await getKeyring();
  const now = new Date();

  const connectionRows = Array.from({ length: CONNECTION_COUNT }, (_unused, index) => {
    const externalItemId = `loadtest-item-${String(index)}`;
    const sealed = seal(
      keyring,
      `loadtest-access-token-${String(index)}`,
      // The same AAD the adapter binds a real token with: table, `<provider>:<itemId>`, column.
      aadFor('bank_connections', `fixture:${externalItemId}`, 'access_token_ciphertext'),
    );

    return {
      id: loadUuid(`connection:${String(index)}`),
      userId: LOAD_USER_ID,
      provider: 'fixture',
      externalItemId,
      institutionId: `ins_load_${String(index)}`,
      institutionName: index === 0 ? 'Load Test Bank' : 'Load Test Card Co',
      institutionLogo: null,
      status: 'active' as const,
      consentExpiresAt: toInstant(addMonths(reference, 6), TIMEZONE, 9),
      accessTokenCiphertext: sealed.ciphertext,
      keyId: sealed.keyId,
      error: null,
      lastSyncedAt: toInstant(reference, TIMEZONE, 6),
      backfillCompletedAt: toInstant(addMonths(reference, -HISTORY_MONTHS), TIMEZONE, 9),
    };
  });

  await db
    .insert(bankConnections)
    .values(connectionRows)
    .onConflictDoUpdate({
      target: bankConnections.id,
      set: {
        // Re-sealed on every run: a rotation between runs would otherwise leave a row under a
        // key id the current keyring cannot open, and the drill would fail for the wrong reason.
        accessTokenCiphertext: sql`excluded.access_token_ciphertext`,
        keyId: sql`excluded.key_id`,
        status: sql`excluded.status`,
        lastSyncedAt: sql`excluded.last_synced_at`,
        updatedAt: now,
      },
    });

  const accountCurrencies = ['USD', 'USD', 'GBP', 'EUR'];
  const accountRows = Array.from({ length: ACCOUNT_COUNT }, (_unused, index) => ({
    id: loadUuid(`bank-account:${String(index)}`),
    connectionId: loadUuid(`connection:${String(index % CONNECTION_COUNT)}`),
    externalId: `loadtest-acct-${String(index)}`,
    name: `Load account ${String(index + 1)}`,
    officialName: null,
    mask: String(4000 + index),
    type: index === 3 ? 'credit' : 'depository',
    subtype: index === 3 ? 'credit card' : 'checking',
    currency: accountCurrencies[index] ?? 'USD',
  }));

  await db
    .insert(bankAccounts)
    .values(accountRows)
    .onConflictDoUpdate({
      target: bankAccounts.id,
      set: { name: sql`excluded.name`, currency: sql`excluded.currency`, updatedAt: now },
    });

  return {
    accountIds: accountRows.map((row) => row.id),
    accountCurrencies: accountRows.map((row) => row.currency),
  };
}

/**
 * A review queue with something in it.
 *
 * `dashboard.attention` counts pending detections, and a queue that is always empty means that
 * query's index never gets exercised at load.
 */
async function seedDetections(
  db: Database,
  random: () => number,
  reference: PlainDate,
  subscriptionRows: readonly GeneratedSubscription[],
): Promise<number> {
  const candidates = subscriptionRows.slice(0, 60);
  const rows = candidates.map((subscription, index) => {
    const status: DetectionStatus =
      index < 30 ? 'pending' : index < 45 ? 'confirmed' : 'dismissed';
    const occurrences = integerBetween(random, 3, 18);
    return {
      id: loadUuid(`detection:${String(index)}`),
      userId: LOAD_USER_ID,
      // Suffixed so a detection never collides with the key its own subscription's charges carry;
      // `detections_user_key_unique` is on (user, key, currency) and two rows would fight.
      normalizedKey: `${subscription.normalizedKey} D${String(index)}`.slice(0, 60),
      merchantId: subscription.merchantId,
      billingChannel: subscription.billingChannel,
      intervalUnit: subscription.interval.unit,
      intervalCount: subscription.interval.count,
      medianAmountMinor: subscription.amountMinor,
      currency: subscription.currency,
      amountCv: '0.0200',
      occurrences,
      firstSeen: formatPlainDate(addMonths(reference, -occurrences)),
      lastSeen: formatPlainDate(addDays(reference, -integerBetween(random, 1, 25))),
      nextExpectedAt: formatPlainDate(addDays(reference, integerBetween(random, 1, 30))),
      confidence: (0.7 + random() * 0.29).toFixed(3),
      status,
      evidence: { transactionIds: [], gapDays: [30, 31, 30] },
      subscriptionId: status === 'confirmed' ? subscription.id : null,
    };
  });

  await db.insert(detections).values(rows).onConflictDoNothing({ target: detections.id });
  return rows.length;
}

async function loadMerchantRefs(db: Database): Promise<MerchantRef[]> {
  return db.select({ id: merchants.id, name: merchants.name }).from(merchants).limit(200);
}

/** `--clean` — everything the load user owns, gone. Cascades from `users`. */
async function clean(db: Database): Promise<void> {
  await db.delete(users).where(eq(users.id, LOAD_USER_ID));
}

// ── entrypoint ─────────────────────────────────────────────────────────────────────────

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const flag = argv.find((argument) => argument.startsWith(`--${name}=`));
  return flag === undefined ? undefined : flag.slice(name.length + 3);
}

async function main(): Promise<void> {
  loadRootEnv();

  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  const argv = process.argv.slice(2);
  const reference = parsePlainDate(flagValue(argv, 'as-of') ?? DEFAULT_REFERENCE_DATE);
  const seedValue = Number(flagValue(argv, 'seed') ?? '20260726');

  const credentials = buildDemoCredentials({
    email: LOAD_EMAIL,
    password: LOAD_PASSWORD,
    issuer: 'Ledger',
  });

  // 300s: the transaction batches are the long pole and a 30s default would kill the run
  // somewhere in the middle of the feed.
  const handle = createDatabase({ url, max: 1, statementTimeoutSeconds: 300 });
  const startedAt = Date.now();

  try {
    if (argv.includes('--clean')) {
      await clean(handle.db);
      console.log(`Removed the load user (${LOAD_EMAIL}) and everything it owned.`);
      return;
    }

    const totp = await sealTotpSecret(credentials.totpSecret);

    const merchantRefs = await loadMerchantRefs(handle.db);
    if (merchantRefs.length === 0) {
      console.error('No merchants in the registry. Run `pnpm seed:demo --merchants-only` first.');
      process.exit(1);
    }

    console.log(`Seeding the load user (${LOAD_EMAIL})…`);
    await seedLoadUser(handle.db, reference, totp.value, credentials.passwordHash);

    const { accountIds, accountCurrencies } = await seedConnections(handle.db, reference);
    console.log(
      `  ${String(CONNECTION_COUNT)} connections, ${String(accountIds.length)} accounts, tokens sealed.`,
    );

    const random = mulberry32(seedValue);
    const subscriptionRows = buildSubscriptions(random, reference, merchantRefs);

    await inBatches(subscriptionRows, 200, (chunk) =>
      handle.db
        .insert(subscriptions)
        .values(
          chunk.map((row) => ({
            id: row.id,
            userId: LOAD_USER_ID,
            merchantId: row.merchantId,
            displayName: row.displayName,
            status: row.status,
            amountMinor: row.amountMinor,
            currency: row.currency,
            intervalUnit: row.interval.unit,
            intervalCount: row.interval.count,
            anchorDate: formatPlainDate(row.anchor),
            nextRenewalAt: row.nextRenewalAt,
            lastChargedAt: row.lastChargedAt,
            trialEndsAt: row.trialEndsAt,
            billingChannel: row.billingChannel,
            paymentMethodId: row.paymentMethodId,
            category: row.category,
            source: 'detected' as const,
            confidence: '0.950',
            variableAmount: row.variableAmount,
            autoRenew: row.status !== 'canceled',
            tags: row.index % 7 === 0 ? ['household'] : [],
          })),
        )
        .onConflictDoNothing({ target: subscriptions.id }),
    );
    console.log(`  ${String(subscriptionRows.length)} subscriptions.`);

    const priceRows = subscriptionRows.flatMap((subscription) =>
      subscription.priceHistory.map((row) => ({
        id: row.id,
        subscriptionId: subscription.id,
        amountMinor: row.amountMinor,
        currency: subscription.currency,
        effectiveFrom: row.effectiveFrom,
        deltaBps: row.deltaBps,
        source: 'detected',
      })),
    );
    await inBatches(priceRows, BATCH_ROWS, (chunk) =>
      handle.db
        .insert(subscriptionPriceHistory)
        .values([...chunk])
        .onConflictDoNothing({ target: subscriptionPriceHistory.id }),
    );
    console.log(`  ${String(priceRows.length)} price-history rows.`);

    const detectionCount = await seedDetections(handle.db, random, reference, subscriptionRows);
    console.log(`  ${String(detectionCount)} detections.`);

    const transactionRows = buildTransactions(
      random,
      reference,
      subscriptionRows,
      accountIds,
      accountCurrencies,
    );
    const linked = transactionRows.filter((row) => row.subscriptionId !== null).length;

    console.log(`  writing ${String(transactionRows.length)} transactions…`);
    await inBatches(
      transactionRows,
      BATCH_ROWS,
      (chunk) =>
        handle.db
          .insert(transactions)
          .values(
            chunk.map((row) => ({
              id: row.id,
              accountId: row.accountId,
              externalId: row.externalId,
              postedAt: row.postedAt,
              amountMinor: row.amountMinor,
              currency: row.currency,
              rawDescriptor: row.rawDescriptor,
              normalizedKey: row.normalizedKey,
              billingChannel: row.billingChannel,
              pending: row.pending,
              subscriptionId: row.subscriptionId,
              dedupeHash: row.dedupeHash,
            })),
          )
          .onConflictDoNothing(),
      (done) => {
        if (done % 10_000 === 0) console.log(`    ${String(done)} / ${String(TRANSACTION_COUNT)}`);
      },
    );

    // The planner will otherwise still be working from whatever statistics it had before 50,000
    // rows arrived, and the first measurement would be of a stale plan rather than of the schema.
    console.log('  analyzing…');
    await handle.sql.unsafe('ANALYZE transactions, subscriptions, detections, subscription_price_history');

    const rule = '─'.repeat(72);
    console.log(`\n${rule}`);
    console.log('  Load corpus seeded.');
    console.log(rule);
    console.log(`  email     ${LOAD_EMAIL}`);
    console.log(`  password  ${LOAD_PASSWORD}`);
    console.log(`  TOTP      ${credentials.totpSecretBase32}`);
    console.log(rule);
    console.log(
      `  ${String(subscriptionRows.length)} subscriptions, ` +
        `${String(transactionRows.length)} transactions (${String(linked)} linked to a subscription), ` +
        `${String(accountIds.length)} accounts`,
    );
    console.log(`  reference date ${formatPlainDate(reference)} (${TIMEZONE})`);
    console.log(`  took ${String(Math.round((Date.now() - startedAt) / 1000))}s`);
    if (!totp.sealed) {
      console.log('  NOTE: the TOTP secret was stored unencrypted — sign-in will reject codes.');
    }
    console.log(`${rule}\n`);
  } catch (error) {
    console.error(`Load seed failed: ${describe(error)}`);
    process.exitCode = 1;
  } finally {
    await handle.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}

export { LOAD_USER_ID, buildSubscriptions, buildTransactions, loadNormalizedKey, mulberry32 };
