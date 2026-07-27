/**
 * The demo dataset, as data.
 *
 * This module is pure: no database, no filesystem, no ambient clock. It takes a `Clock` and
 * returns plain objects, which is what makes `demo.test.ts` able to assert that the fixture
 * really does contain an annual plan with exactly two occurrences, a trial that converts in two
 * days, and a merchant billing two different cards — without a Postgres anywhere.
 *
 * The dataset is not a pile of plausible rows. Every entry is one of the cases that has broken
 * a subscription tracker before: the annual plan that only ever charged twice, the trial nobody
 * cancelled, the price that crept up 20% over two years, the same merchant on two cards, the
 * usage-based bill whose "amount" is a median rather than a promise. If a screen looks fine
 * against this data, it is probably fine.
 *
 * Subscriptions reference merchants by **slug**, not id, because merchant ids are assigned by
 * the registry upsert at write time. Resolving the slug is the writer's job.
 */

import {
  type BillingChannel,
  type Category,
  type Clock,
  DEFAULT_LEAD_TIME_DAYS,
  NOTIFICATION_TYPES,
  type NotificationType,
  type PlainDate,
  type RecurrenceInterval,
  type SubscriptionSource,
  type SubscriptionStatus,
  type CancellationMethod,
  type CancellationStatus,
  ANNUAL,
  MONTHLY,
  addDays,
  addMonths,
  allocate,
  formatPlainDate,
  interval,
  isCommitted,
  lastOccurrenceOnOrBefore,
  money,
  nextOccurrenceAfter,
  relativeChangeBps,
  toInstant,
  today,
} from '@ledger/core';
import { type TransitionTrigger, transition } from '../state/subscription';
import { transitionCancellation } from '../state/cancellation';
import { DEMO_USER_ID, demoUuid } from './ids';
import { type DemoCredentials, buildDemoCredentials } from './credentials';

// ── shapes ─────────────────────────────────────────────────────────────────────────────

export interface DemoUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly displayCurrency: string;
  readonly timezone: string;
  readonly locale: string;
  readonly onboardingCompletedAt: Date;
}

export interface DemoPaymentMethod {
  readonly id: string;
  readonly label: string;
  readonly brand: string;
  readonly last4: string;
  readonly expMonth: number;
  readonly expYear: number;
}

export interface DemoPriceHistoryRow {
  readonly id: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** `YYYY-MM-DD`; the column is `date`, not `timestamptz`. */
  readonly effectiveFrom: string;
  readonly deltaBps: number | null;
  readonly source: string;
}

export interface DemoShare {
  readonly id: string;
  readonly personLabel: string;
  readonly shareMinor: number;
  readonly isSelf: boolean;
}

export interface DemoUsageLog {
  readonly id: string;
  readonly occurredAt: Date;
  readonly note: string | null;
}

export interface DemoSubscription {
  readonly id: string;
  readonly merchantSlug: string | null;
  readonly displayName: string;
  readonly status: SubscriptionStatus;
  readonly amountMinor: number;
  readonly currency: string;
  readonly interval: RecurrenceInterval;
  readonly anchorDate: string;
  readonly nextRenewalAt: Date | null;
  readonly lastChargedAt: Date | null;
  readonly trialEndsAt: Date | null;
  readonly billingChannel: BillingChannel;
  readonly paymentMethodId: string;
  readonly category: Category;
  readonly source: SubscriptionSource;
  readonly confidence: string;
  readonly variableAmount: boolean;
  readonly autoRenew: boolean;
  readonly cancelByAt: Date | null;
  readonly notes: string | null;
  readonly url: string | null;
  readonly tags: readonly string[];
  readonly priceHistory: readonly DemoPriceHistoryRow[];
  readonly shares: readonly DemoShare[];
  readonly usage: readonly DemoUsageLog[];
}

export interface DemoChecklistStep {
  readonly id: string;
  readonly text: string;
  readonly doneAt?: string;
}

export interface DemoCancellationEvent {
  readonly id: string;
  readonly at: Date;
  readonly actor: 'user' | 'system' | 'provider' | 'import';
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface DemoCancellation {
  readonly id: string;
  readonly subscriptionId: string;
  readonly method: CancellationMethod;
  readonly channel: BillingChannel;
  readonly status: CancellationStatus;
  readonly checklist: readonly DemoChecklistStep[];
  readonly deadlineAt: Date | null;
  readonly effectiveAt: Date | null;
  readonly expectedNextChargeAt: Date | null;
  readonly verificationWindowEndsAt: Date | null;
  readonly verifiedAt: Date | null;
  readonly confirmationReference: string | null;
  readonly outcomeNotes: string | null;
  readonly startedAt: Date;
  readonly resolvedAt: Date | null;
  readonly events: readonly DemoCancellationEvent[];
}

export interface DemoNotificationPreference {
  readonly id: string;
  readonly type: NotificationType;
  readonly channels: readonly string[];
  readonly leadTimeDays: number;
}

export interface DemoDataset {
  /** The calendar date everything is measured from. Printed so a stale demo is obvious. */
  readonly referenceDate: PlainDate;
  readonly timezone: string;
  readonly user: DemoUser;
  readonly credentials: DemoCredentials;
  readonly paymentMethods: readonly DemoPaymentMethod[];
  readonly subscriptions: readonly DemoSubscription[];
  readonly cancellations: readonly DemoCancellation[];
  readonly notificationPreferences: readonly DemoNotificationPreference[];
  readonly quietHoursStartMinute: number;
  readonly quietHoursEndMinute: number;
}

export interface BuildDemoDatasetOptions {
  readonly clock: Clock;
  readonly timezone?: string;
  readonly displayCurrency?: string;
  readonly email?: string;
  readonly password?: string;
}

// ── constants worth naming ─────────────────────────────────────────────────────────────

export const DEMO_EMAIL = 'demo@ledger.local';

/** Twelve characters is better-auth's floor for this app; this is deliberately memorable. */
export const DEMO_PASSWORD = 'demo-ledger-2026';

/** The annual plan was bought this long ago, which is what gives it exactly two charges. */
const ANNUAL_PLAN_AGE_MONTHS = 14;

/** The trial converts this many days out, so the 3-day `trial_ending` alert has a target. */
const TRIAL_CONVERTS_IN_DAYS = 2;

const PRIMARY_CARD_ID = demoUuid('payment-method:primary');
const HOUSEHOLD_CARD_ID = demoUuid('payment-method:household');

// ── the specification ──────────────────────────────────────────────────────────────────

type CardKey = 'primary' | 'household';

interface StatusArrival {
  readonly from: SubscriptionStatus;
  readonly trigger: TransitionTrigger;
  readonly to: SubscriptionStatus;
}

interface SubscriptionSpec {
  /** Stable key for the derived UUID. Never change one without meaning to re-key the row. */
  readonly key: string;
  readonly merchantSlug: string;
  readonly displayName: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly interval: RecurrenceInterval;
  /** How long ago the first charge landed. Drives the anchor, and so every projection. */
  readonly anchorMonthsAgo: number;
  readonly anchorDayShift?: number;
  readonly category: Category;
  readonly card: CardKey;
  readonly arrival?: StatusArrival;
  readonly billingChannel?: BillingChannel;
  readonly source?: SubscriptionSource;
  readonly confidence?: string;
  readonly variableAmount?: boolean;
  readonly autoRenew?: boolean;
  /** Days of notice the provider wants. Sets `cancel_by_at` = next renewal − notice. */
  readonly noticePeriodDays?: number;
  readonly notes?: string;
  readonly url?: string;
  readonly tags?: readonly string[];
}

/**
 * Twenty subscriptions across USD, GBP and EUR.
 *
 * The order is the order they were "added", which is also the order the dashboard will show
 * them in before any sort is applied — so the interesting rows are not all at the bottom.
 */
const SUBSCRIPTION_SPECS: readonly SubscriptionSpec[] = [
  {
    key: 'netflix',
    merchantSlug: 'netflix',
    displayName: 'Netflix — Standard with ads',
    amountMinor: 1799,
    currency: 'USD',
    interval: MONTHLY,
    anchorMonthsAgo: 22,
    category: 'streaming_video',
    card: 'primary',
    tags: ['household'],
    notes: 'Split four ways — see shares.',
  },
  {
    key: 'spotify',
    merchantSlug: 'spotify',
    displayName: 'Spotify Premium',
    amountMinor: 1199,
    currency: 'USD',
    interval: MONTHLY,
    anchorMonthsAgo: 26,
    anchorDayShift: 3,
    category: 'music_audio',
    card: 'primary',
    source: 'detected',
    confidence: '0.970',
    notes: 'Went up twice since 2024.',
  },
  {
    key: 'adobe-annual',
    merchantSlug: 'adobe-creative-cloud',
    displayName: 'Adobe Creative Cloud — All Apps (annual)',
    amountMinor: 65_988,
    currency: 'USD',
    interval: ANNUAL,
    anchorMonthsAgo: ANNUAL_PLAN_AGE_MONTHS,
    category: 'design',
    card: 'primary',
    noticePeriodDays: 14,
    notes: 'Annual commitment — cancelling mid-term still bills the remaining months.',
  },
  {
    key: 'chatgpt-trial',
    merchantSlug: 'chatgpt-plus',
    displayName: 'ChatGPT Plus (trial)',
    amountMinor: 2000,
    currency: 'USD',
    interval: MONTHLY,
    anchorMonthsAgo: 0,
    category: 'ai',
    card: 'primary',
    arrival: { from: 'unknown', trigger: 'user_created', to: 'trialing' },
  },
  {
    key: 'disney-personal',
    merchantSlug: 'disney-plus',
    displayName: 'Disney+ (personal card)',
    amountMinor: 1099,
    currency: 'USD',
    interval: MONTHLY,
    anchorMonthsAgo: 9,
    category: 'streaming_video',
    card: 'primary',
    source: 'detected',
    confidence: '0.940',
  },
  {
    key: 'disney-household',
    merchantSlug: 'disney-plus',
    displayName: 'Disney+ (household card)',
    amountMinor: 1099,
    currency: 'USD',
    interval: MONTHLY,
    anchorMonthsAgo: 5,
    anchorDayShift: 11,
    category: 'streaming_video',
    card: 'household',
    source: 'detected',
    confidence: '0.910',
    notes: 'Signed up again on the household card without cancelling the first one.',
  },
  {
    key: 'icloud',
    merchantSlug: 'icloud-plus',
    displayName: 'iCloud+ 2TB',
    amountMinor: 999,
    currency: 'USD',
    interval: MONTHLY,
    anchorMonthsAgo: 31,
    category: 'cloud_storage',
    card: 'primary',
    billingChannel: 'apple',
  },
  {
    key: 'xbox',
    merchantSlug: 'xbox-game-pass',
    displayName: 'Xbox Game Pass Ultimate',
    amountMinor: 1999,
    currency: 'USD',
    interval: MONTHLY,
    anchorMonthsAgo: 15,
    category: 'gaming',
    card: 'household',
    arrival: { from: 'active', trigger: 'user_paused', to: 'paused' },
    autoRenew: false,
    notes: 'Paused for the summer.',
  },
  {
    key: 'xfinity',
    merchantSlug: 'xfinity',
    displayName: 'Xfinity Internet',
    amountMinor: 8412,
    currency: 'USD',
    interval: MONTHLY,
    anchorMonthsAgo: 40,
    anchorDayShift: 5,
    category: 'telecom',
    card: 'primary',
    variableAmount: true,
    source: 'detected',
    confidence: '0.880',
    notes: 'Usage-based — the amount shown is the median of the last six bills.',
  },
  {
    key: 'hbo-cancelled',
    merchantSlug: 'hbo-max',
    displayName: 'HBO Max',
    amountMinor: 1599,
    currency: 'USD',
    interval: MONTHLY,
    anchorMonthsAgo: 18,
    category: 'streaming_video',
    card: 'primary',
    arrival: { from: 'cancel_scheduled', trigger: 'cancellation_verified', to: 'canceled' },
    autoRenew: false,
  },
  {
    key: 'nordvpn',
    merchantSlug: 'nordvpn',
    displayName: 'NordVPN — 1 year',
    amountMinor: 9588,
    currency: 'USD',
    interval: ANNUAL,
    anchorMonthsAgo: 7,
    category: 'security_vpn',
    card: 'primary',
  },
  {
    key: 'nyt',
    merchantSlug: 'new-york-times',
    displayName: 'The New York Times — All Access',
    amountMinor: 2500,
    currency: 'USD',
    interval: MONTHLY,
    anchorMonthsAgo: 13,
    anchorDayShift: 7,
    category: 'news_publishing',
    card: 'primary',
  },
  {
    key: 'patreon',
    merchantSlug: 'patreon',
    displayName: 'Patreon pledges',
    amountMinor: 1500,
    currency: 'USD',
    interval: MONTHLY,
    anchorMonthsAgo: 11,
    category: 'creator_support',
    card: 'household',
    variableAmount: true,
  },
  {
    key: 'guardian',
    merchantSlug: 'the-guardian',
    displayName: 'Guardian — monthly support',
    amountMinor: 1200,
    currency: 'GBP',
    interval: MONTHLY,
    anchorMonthsAgo: 29,
    category: 'news_publishing',
    card: 'household',
  },
  {
    key: 'puregym',
    merchantSlug: 'puregym',
    displayName: 'PureGym — Core',
    amountMinor: 2499,
    currency: 'GBP',
    interval: MONTHLY,
    anchorMonthsAgo: 20,
    anchorDayShift: 2,
    category: 'fitness',
    card: 'household',
    arrival: { from: 'active', trigger: 'cancellation_started', to: 'cancel_scheduled' },
    // The reason this row exists: the notice period, not the price, is what costs people money.
    noticePeriodDays: 30,
  },
  {
    key: 'britbox',
    merchantSlug: 'britbox',
    displayName: 'BritBox',
    amountMinor: 599,
    currency: 'GBP',
    interval: MONTHLY,
    anchorMonthsAgo: 4,
    category: 'streaming_video',
    card: 'household',
  },
  {
    key: 'three-uk',
    merchantSlug: 'three-uk',
    displayName: 'Three UK — SIM only',
    amountMinor: 1600,
    currency: 'GBP',
    interval: MONTHLY,
    anchorMonthsAgo: 34,
    anchorDayShift: 9,
    category: 'telecom',
    card: 'household',
    billingChannel: 'carrier',
  },
  {
    key: 'mubi',
    merchantSlug: 'mubi',
    displayName: 'MUBI',
    amountMinor: 1299,
    currency: 'EUR',
    interval: MONTHLY,
    anchorMonthsAgo: 6,
    category: 'streaming_video',
    card: 'primary',
  },
  {
    key: 'deezer',
    merchantSlug: 'deezer',
    displayName: 'Deezer Premium',
    amountMinor: 1199,
    currency: 'EUR',
    interval: MONTHLY,
    anchorMonthsAgo: 16,
    anchorDayShift: 4,
    category: 'music_audio',
    card: 'primary',
  },
  {
    key: 'babbel',
    merchantSlug: 'babbel',
    displayName: 'Babbel — 6 months',
    amountMinor: 8370,
    currency: 'EUR',
    interval: interval('month', 6),
    anchorMonthsAgo: 10,
    category: 'education',
    card: 'household',
  },
];

// ── builder ────────────────────────────────────────────────────────────────────────────

/**
 * Proves a seeded status is one the product can actually reach.
 *
 * Writing `status: 'paused'` straight into a fixture is how a demo ends up in a state the
 * transition table forbids, which then makes a genuinely broken machine look fine. Routing
 * every non-default status through `transition()` means an illegal fixture fails at build time.
 */
function arriveAt(arrival: StatusArrival | undefined): SubscriptionStatus {
  if (arrival === undefined) {
    return transition('unknown', 'user_created', 'active').to;
  }
  return transition(arrival.from, arrival.trigger, arrival.to).to;
}

export function buildDemoDataset(options: BuildDemoDatasetOptions): DemoDataset {
  const timezone = options.timezone ?? 'Europe/London';
  const referenceDate = today(options.clock, timezone);
  const email = options.email ?? DEMO_EMAIL;

  /** Renewals are wall-clock events; 09:00 local is when a card issuer actually posts them. */
  const at = (date: PlainDate, hour = 9): Date => toInstant(date, timezone, hour);

  const paymentMethods: readonly DemoPaymentMethod[] = [
    {
      id: PRIMARY_CARD_ID,
      label: 'Personal Visa',
      brand: 'visa',
      last4: '4242',
      expMonth: 11,
      expYear: referenceDate.year + 2,
    },
    {
      id: HOUSEHOLD_CARD_ID,
      label: 'Household Amex',
      brand: 'amex',
      last4: '3007',
      expMonth: 4,
      expYear: referenceDate.year + 3,
    },
  ];

  const cardIds: Readonly<Record<CardKey, string>> = {
    primary: PRIMARY_CARD_ID,
    household: HOUSEHOLD_CARD_ID,
  };

  const subscriptions = SUBSCRIPTION_SPECS.map((spec): DemoSubscription => {
    const anchor = addDays(
      addMonths(referenceDate, -spec.anchorMonthsAgo),
      spec.anchorDayShift ?? 0,
    );
    const status = arriveAt(spec.arrival);
    const isTrial = status === 'trialing';

    // A trial has not been charged yet, so its anchor is the *conversion* date: the first real
    // charge. Everything downstream — the alert, the horizon, the committed total — projects
    // from there rather than from the day the trial started.
    const trialEnd = isTrial ? addDays(referenceDate, TRIAL_CONVERTS_IN_DAYS) : null;
    const effectiveAnchor = trialEnd ?? anchor;

    const lastCharged = isTrial
      ? null
      : lastOccurrenceOnOrBefore(effectiveAnchor, spec.interval, referenceDate);
    const nextRenewal = isCommitted(status)
      ? (trialEnd ?? nextOccurrenceAfter(effectiveAnchor, spec.interval, referenceDate))
      : null;

    const notice = spec.noticePeriodDays ?? 0;
    const cancelBy =
      nextRenewal === null || notice === 0
        ? null
        : at(addDays(nextOccurrenceAfter(effectiveAnchor, spec.interval, referenceDate), -notice));

    return {
      id: demoUuid(`subscription:${spec.key}`),
      merchantSlug: spec.merchantSlug,
      displayName: spec.displayName,
      status,
      amountMinor: spec.amountMinor,
      currency: spec.currency,
      interval: spec.interval,
      anchorDate: formatPlainDate(effectiveAnchor),
      nextRenewalAt: nextRenewal === null ? null : at(nextRenewal),
      lastChargedAt: lastCharged === null ? null : at(lastCharged),
      trialEndsAt: trialEnd === null ? null : at(trialEnd, 12),
      billingChannel: spec.billingChannel ?? 'direct',
      paymentMethodId: cardIds[spec.card],
      category: spec.category,
      source: spec.source ?? 'manual',
      confidence: spec.confidence ?? '1.000',
      variableAmount: spec.variableAmount ?? false,
      autoRenew: spec.autoRenew ?? true,
      cancelByAt: cancelBy,
      notes: spec.notes ?? null,
      url: spec.url ?? null,
      tags: spec.tags ?? [],
      priceHistory: spec.key === 'spotify' ? buildSpotifyPriceHistory(referenceDate) : [],
      shares: spec.key === 'netflix' ? buildNetflixShares(spec.amountMinor, spec.currency) : [],
      usage: spec.key === 'netflix' ? buildNetflixUsage(referenceDate, at) : [],
    };
  });

  const hboId = demoUuid('subscription:hbo-cancelled');
  const puregymId = demoUuid('subscription:puregym');

  return {
    referenceDate,
    timezone,
    user: {
      id: DEMO_USER_ID,
      name: 'Demo Ledger',
      email,
      displayCurrency: options.displayCurrency ?? 'USD',
      timezone,
      locale: 'en-GB',
      onboardingCompletedAt: at(addMonths(referenceDate, -3)),
    },
    credentials: buildDemoCredentials({
      email,
      password: options.password ?? DEMO_PASSWORD,
      issuer: 'Ledger',
    }),
    paymentMethods,
    subscriptions,
    cancellations: [
      buildVerifiedCancellation(hboId, referenceDate, at),
      buildOpenCancellation(puregymId, referenceDate, at),
    ],
    notificationPreferences: NOTIFICATION_TYPES.map((type) => ({
      id: demoUuid(`notification-preference:${type}`),
      type,
      channels: ['email', 'in_app'],
      leadTimeDays: DEFAULT_LEAD_TIME_DAYS[type],
    })),
    quietHoursStartMinute: 22 * 60,
    quietHoursEndMinute: 8 * 60,
  };
}

// ── the individual hard cases ──────────────────────────────────────────────────────────

/**
 * Spotify: 9.99 → 10.99 → 11.99 over two years.
 *
 * `deltaBps` is computed with `relativeChangeBps` rather than written by hand, because the whole
 * point of the price-history table is that "+20% since you signed up" is arithmetic on integers,
 * not a number somebody typed.
 */
function buildSpotifyPriceHistory(reference: PlainDate): readonly DemoPriceHistoryRow[] {
  const steps: readonly { readonly monthsAgo: number; readonly amountMinor: number }[] = [
    { monthsAgo: 26, amountMinor: 999 },
    { monthsAgo: 14, amountMinor: 1099 },
    { monthsAgo: 2, amountMinor: 1199 },
  ];

  return steps.map((step, index) => {
    const previous = steps[index - 1];
    return {
      id: demoUuid(`price-history:spotify:${String(index)}`),
      amountMinor: step.amountMinor,
      currency: 'USD',
      effectiveFrom: formatPlainDate(addMonths(reference, -step.monthsAgo)),
      deltaBps:
        previous === undefined
          ? null
          : relativeChangeBps(money(previous.amountMinor, 'USD'), money(step.amountMinor, 'USD')),
      source: 'detected',
    };
  });
}

/**
 * Netflix, split four ways.
 *
 * `allocate` rather than division: 1799 / 4 is not an integer, and the remainder has to land on
 * somebody rather than evaporate. The shares sum to the charge exactly.
 */
function buildNetflixShares(amountMinor: number, currency: string): readonly DemoShare[] {
  const labels = ['You', 'Sam', 'Priya', 'Dad'] as const;
  const parts = allocate(money(amountMinor, currency), labels.length);

  return labels.map((label, index) => ({
    id: demoUuid(`share:netflix:${label}`),
    personLabel: label,
    shareMinor: parts[index]?.amountMinor ?? 0,
    isSelf: index === 0,
  }));
}

/** Enough opens to make /analytics' cost-per-use say something other than "no data". */
function buildNetflixUsage(
  reference: PlainDate,
  at: (date: PlainDate, hour?: number) => Date,
): readonly DemoUsageLog[] {
  const daysAgo = [2, 5, 6, 13, 19, 27] as const;
  return daysAgo.map((days) => ({
    id: demoUuid(`usage:netflix:${String(days)}`),
    occurredAt: at(addDays(reference, -days), 21),
    note: null,
  }));
}

/**
 * The cancellation that worked, and was *verified* — the expected charge never arrived.
 *
 * Only `verified` counts toward the reclaimed-savings figure (brief §6), so this is the row that
 * makes that counter non-zero. A `confirmed` row would leave it at zero and look like a bug.
 */
function buildVerifiedCancellation(
  subscriptionId: string,
  reference: PlainDate,
  at: (date: PlainDate, hour?: number) => Date,
): DemoCancellation {
  const started = at(addDays(reference, -45));
  const verified = at(addDays(reference, -10));

  return {
    id: demoUuid('cancellation:hbo'),
    subscriptionId,
    method: 'account_settings',
    channel: 'direct',
    status: transitionCancellation('confirmed', 'verification_passed', 'verified').to,
    checklist: [
      { id: 'step-1', text: 'Sign in on the web, not in the app.', doneAt: started.toISOString() },
      {
        id: 'step-2',
        text: 'Open Subscription under your profile.',
        doneAt: at(addDays(reference, -45), 10).toISOString(),
      },
      {
        id: 'step-3',
        text: 'Decline the retention offer and confirm.',
        doneAt: at(addDays(reference, -44)).toISOString(),
      },
    ],
    deadlineAt: at(addDays(reference, -40)),
    effectiveAt: at(addDays(reference, -30)),
    expectedNextChargeAt: at(addDays(reference, -22)),
    verificationWindowEndsAt: verified,
    verifiedAt: verified,
    confirmationReference: 'HBO-4471-2291',
    outcomeNotes: 'No charge appeared in the twelve days after the expected renewal.',
    startedAt: started,
    resolvedAt: verified,
    events: [
      {
        id: demoUuid('cancellation-event:hbo:started'),
        at: started,
        actor: 'user',
        type: 'started',
        payload: { channel: 'direct' },
      },
      {
        id: demoUuid('cancellation-event:hbo:confirmed'),
        at: at(addDays(reference, -44)),
        actor: 'provider',
        type: 'status_changed',
        payload: { to: 'confirmed', reference: 'HBO-4471-2291' },
      },
      {
        id: demoUuid('cancellation-event:hbo:verified'),
        at: verified,
        actor: 'system',
        type: 'verified',
        payload: { expectedChargeSeen: false },
      },
    ],
  };
}

/** An open one, so the cancellation board is not an empty state. */
function buildOpenCancellation(
  subscriptionId: string,
  reference: PlainDate,
  at: (date: PlainDate, hour?: number) => Date,
): DemoCancellation {
  const started = at(addDays(reference, -3));

  return {
    id: demoUuid('cancellation:puregym'),
    subscriptionId,
    method: 'web_form',
    channel: 'direct',
    status: transitionCancellation('draft', 'user_started', 'in_progress').to,
    checklist: [
      {
        id: 'step-1',
        text: 'Open the members area and choose Manage membership.',
        doneAt: started.toISOString(),
      },
      { id: 'step-2', text: 'Submit the cancellation form.' },
      { id: 'step-3', text: 'Save the confirmation email as evidence.' },
    ],
    deadlineAt: at(addDays(reference, 4)),
    effectiveAt: null,
    expectedNextChargeAt: null,
    verificationWindowEndsAt: null,
    verifiedAt: null,
    confirmationReference: null,
    outcomeNotes: null,
    startedAt: started,
    resolvedAt: null,
    events: [
      {
        id: demoUuid('cancellation-event:puregym:started'),
        at: started,
        actor: 'user',
        type: 'started',
        payload: { channel: 'direct' },
      },
    ],
  };
}
