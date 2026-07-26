/**
 * The synthetic corpus: 24 months of one user's card and bank history, with the answers attached.
 *
 * This file is the measuring instrument for `golden.test.ts`, and the reason it exists is that
 * "detection quality" is otherwise a matter of opinion (PLAN.md §4 risk register). A recall
 * number is only worth having if the ground truth it is measured against is honest, so the corpus
 * plants the cases that are *hard* rather than the cases that are easy: an annual charge seen
 * twice, a trial that converted, a price rise, a card replaced, a refund, a metered utility, and
 * — just as important — noise that looks recurring and is not.
 *
 * Two constraints shape every line below.
 *
 * 1. **No `Math.random`, no `Date.now`.** The package under test is pure and its tests have to be
 *    reproducible from a seed alone; a corpus that differs between runs turns a real regression
 *    into "flaky test" and gets muted. Randomness comes from a seeded mulberry32, and the
 *    reference date is a constant.
 * 2. **Every transaction is attributable.** Each row belongs either to a planted subscription or
 *    to the noise pile, and nothing is in both. That partition is what makes a false positive
 *    countable rather than arguable.
 *
 * The floats here (log-uniform amount sampling) never touch a monetary *calculation* — they
 * produce an integer minor-unit amount and then get out of the way. The engine's own money rules
 * are unaffected.
 */

import {
  ANNUAL,
  FOUR_WEEKLY,
  MONTHLY,
  QUARTERLY,
  WEEKLY,
  addDays,
  addInterval,
  approximateDays,
  comparePlainDate,
  dayOfWeek,
  isAfter,
  parsePlainDate,
  type Category,
  type PlainDate,
  type RecurrenceInterval,
} from '@ledger/core';

import { createInMemoryRegistry } from '../src/match';
import type { DetectionTransaction, MerchantRegistry, MerchantRegistryEntry } from '../src/types';

// ── the window ─────────────────────────────────────────────────────────────────────────

/** First day of the 24-month window. Every anchor below is expressed relative to it. */
export const WINDOW_START = parsePlainDate('2024-07-16');
/** The reference date detection runs at. A constant, because a clock would make this untestable. */
export const TODAY = parsePlainDate('2026-07-20');

const ACCOUNT_CHECKING = 'acct-checking-1';
const ACCOUNT_CREDIT = 'acct-credit-9';
const ACCOUNT_EURO = 'acct-euro-3';

// ── seeded randomness ──────────────────────────────────────────────────────────────────

interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /**
   * Log-uniform integer in [min, max].
   *
   * Real discretionary spending at one merchant is not uniform — a £3 coffee and a £34 round
   * both happen, and the small ones happen more often. It also produces a much higher coefficient
   * of variation than a uniform draw over the same range, which is exactly the property that
   * makes noise fall out of the engine's amount filter instead of masquerading as a price.
   */
  spend(min: number, max: number): number;
}

function mulberry32(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));

  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      const value = items[int(0, items.length - 1)];
      if (value === undefined) throw new Error('pick() needs a non-empty list.');
      return value;
    },
    spend: (min, max) => Math.max(1, Math.round(min * Math.pow(max / min, next()))),
  };
}

// ── ground truth ───────────────────────────────────────────────────────────────────────

export interface PlantedSubscription {
  readonly id: string;
  /** What `normalizeDescriptor` should reduce every one of its descriptors to. */
  readonly normalizedKey: string;
  readonly currency: string;
  readonly interval: RecurrenceInterval;
  /** The price in force at the end of the window, in minor units. */
  readonly amountMinor: number;
  /** Every row this subscription produced, including the ones detection is expected to drop. */
  readonly transactionIds: readonly string[];
  /** Why this one is in the corpus. Read it when a golden failure names it. */
  readonly note: string;
}

export interface SyntheticCorpus {
  readonly seed: number;
  readonly today: PlainDate;
  readonly windowStart: PlainDate;
  /** Sorted by posting date, then id — a bank feed arrives in order and so does this. */
  readonly transactions: readonly DetectionTransaction[];
  readonly planted: readonly PlantedSubscription[];
  /** The merchant dataset `@ledger/providers` will eventually ship, reduced to these merchants. */
  readonly registry: MerchantRegistry;
  /** Rows belonging to no subscription. Anything detected out of these is a false positive. */
  readonly noiseTransactionIds: readonly string[];
  /**
   * Normalized keys the engine must never surface.
   *
   * Two deliberate near-misses: a merchant charged exactly twice six weeks apart (a cadence that
   * almost fits fortnightly), and one charged three times at unrelated amounts and gaps. Both are
   * the shape a careless engine reports as a subscription.
   */
  readonly nearMissKeys: readonly string[];
}

// ── emission ───────────────────────────────────────────────────────────────────────────

interface SeriesSpec {
  readonly descriptors: readonly string[];
  readonly currency: string;
  readonly accountId: string;
  readonly interval: RecurrenceInterval;
  readonly anchor: PlainDate;
  readonly count: number;
  readonly amountAt: (index: number) => number;
}

/**
 * Jitter budget, in days either side of the projected date.
 *
 * Scaled to the period, and kept strictly inside the engine's own per-interval tolerance
 * (`CADENCE_CANDIDATES`) once the weekend shift is added on top: a corpus that jittered a weekly
 * charge by three days would be testing whether the engine tolerates a *different* cadence, not
 * whether it recognises this one.
 */
function jitterBudget(interval: RecurrenceInterval): number {
  const days = approximateDays(interval);
  if (days <= 31) return 1;
  if (days <= 100) return 2;
  return 3;
}

/**
 * Direct debits and ACH pulls do not settle at the weekend; card charges do.
 *
 * Applied only from monthly upwards, because the ±2-day tolerance the engine allows a weekly
 * cadence has no room for it — which is itself true of the real world, where a weekly charge that
 * slid to Monday every third week would have changed its billing day.
 */
function shiftsOffWeekend(interval: RecurrenceInterval): boolean {
  return approximateDays(interval) >= 28;
}

function postingDate(rng: Rng, nominal: PlainDate, interval: RecurrenceInterval): PlainDate {
  const budget = jitterBudget(interval);
  const jittered = addDays(nominal, rng.int(-budget, budget));
  if (!shiftsOffWeekend(interval)) return jittered;
  const weekday = dayOfWeek(jittered);
  if (weekday === 6) return addDays(jittered, 2);
  if (weekday === 0) return addDays(jittered, 1);
  return jittered;
}

type Mint = () => string;

function createMint(): Mint {
  let issued = 0;
  return () => {
    issued += 1;
    return `txn-${String(issued).padStart(4, '0')}`;
  };
}

function emitSeries(rng: Rng, mint: Mint, spec: SeriesSpec): DetectionTransaction[] {
  const rows: DetectionTransaction[] = [];
  for (let index = 0; index < spec.count; index += 1) {
    const postedAt = postingDate(
      rng,
      addInterval(spec.anchor, spec.interval, index),
      spec.interval,
    );
    const amountMinor = spec.amountAt(index);
    const rawDescriptor = rng.pick(spec.descriptors);
    // A charge the bank has not posted yet is not evidence. Generating past `today` would make
    // the corpus depend on which side of the reference date the jitter landed on.
    if (isAfter(postedAt, TODAY)) continue;
    rows.push({
      id: mint(),
      postedAt,
      amountMinor,
      currency: spec.currency,
      rawDescriptor,
      accountId: spec.accountId,
      pending: false,
    });
  }
  return rows;
}

// ── the planted subscriptions ──────────────────────────────────────────────────────────

interface PlantSpec {
  readonly id: string;
  readonly normalizedKey: string;
  readonly merchantName: string;
  readonly aliases: readonly string[];
  readonly category: Category;
  readonly descriptors: readonly string[];
  readonly currency: string;
  readonly accountId: string;
  readonly interval: RecurrenceInterval;
  readonly anchorIso: string;
  readonly count: number;
  readonly amountMinor: number;
  readonly note: string;
}

/**
 * The straightforward majority: one merchant, one price, one cadence, held for the whole window.
 *
 * They are here to establish the baseline — an engine that cannot find these has no business
 * being measured on the hard ones — and to spread the billing day across the month so that
 * month-end clamping (`NYTIMES`, anchored on the 31st) is exercised by the corpus rather than
 * only by the unit tests.
 */
const PLAIN_PLANTS: readonly PlantSpec[] = [
  {
    id: 'netflix',
    normalizedKey: 'NETFLIX',
    merchantName: 'Netflix',
    aliases: [],
    category: 'streaming_video',
    descriptors: ['NETFLIX.COM', 'NETFLIX 866-579-7172 CA'],
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
    interval: MONTHLY,
    anchorIso: '2024-07-18',
    count: 25,
    amountMinor: 1799,
    note: 'Plain monthly, two descriptor shapes from the same merchant.',
  },
  {
    id: 'spotify',
    normalizedKey: 'SPOTIFY',
    merchantName: 'Spotify',
    aliases: [],
    category: 'music_audio',
    descriptors: ['SPOTIFY USA', 'SPOTIFY USA 877-778-1161 NY'],
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
    interval: MONTHLY,
    anchorIso: '2024-07-24',
    count: 25,
    amountMinor: 1099,
    note: 'Plain monthly.',
  },
  {
    id: 'adobe',
    normalizedKey: 'ADOBE CREATIVE CLOUD',
    merchantName: 'Adobe',
    aliases: ['Adobe Creative Cloud'],
    category: 'design',
    descriptors: ['ADOBE *CREATIVE CLOUD', 'ADOBE *CREATIVE CLOUD 408-536-6000 CA'],
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
    interval: MONTHLY,
    anchorIso: '2024-08-03',
    count: 24,
    amountMinor: 5999,
    note: 'Processor asterisk that must not be read as an order reference.',
  },
  {
    id: 'nytimes',
    normalizedKey: 'NYTIMES',
    merchantName: 'The New York Times',
    aliases: ['NYTimes'],
    category: 'news_publishing',
    descriptors: ['NYTIMES*NYTIMES', 'NYTIMES*NYTIMES 800-698-4637 NY'],
    currency: 'USD',
    accountId: ACCOUNT_CHECKING,
    interval: MONTHLY,
    // The 31st. Every month with fewer days clamps, so the day-gap sequence is 28/31/30/31 and
    // any engine comparing gaps to a fixed 30 reports this as irregular.
    anchorIso: '2024-07-31',
    count: 25,
    amountMinor: 1700,
    note: 'Month-end anchor: the clamping case, planted in the corpus and not only in unit tests.',
  },
  {
    id: 'planet-fitness',
    normalizedKey: 'PLANET FITNESS',
    merchantName: 'Planet Fitness',
    aliases: [],
    category: 'fitness',
    descriptors: ['PLANET FITNESS MA', 'PLANET FITNESS 844-880-7180 MA'],
    currency: 'USD',
    accountId: ACCOUNT_CHECKING,
    interval: MONTHLY,
    anchorIso: '2024-08-01',
    count: 24,
    amountMinor: 1000,
    note: 'Merchant name ending in a word the trailing-junk pass must not eat.',
  },
  {
    id: 'icloud',
    normalizedKey: 'ICLOUD STORAGE',
    merchantName: 'iCloud',
    aliases: ['iCloud Storage'],
    category: 'cloud_storage',
    descriptors: ['APL*ICLOUD STORAGE', 'APL* ICLOUD STORAGE 866-712-7753 CA'],
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
    interval: MONTHLY,
    anchorIso: '2024-07-20',
    count: 25,
    amountMinor: 299,
    note: 'App Store billed: the channel must survive into the candidate.',
  },
  {
    id: 'github',
    normalizedKey: 'GITHUB',
    merchantName: 'GitHub',
    aliases: [],
    category: 'software',
    descriptors: ['GITHUB.COM', 'GITHUB.COM 877-448-4820 CA'],
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
    interval: MONTHLY,
    anchorIso: '2024-08-09',
    count: 24,
    amountMinor: 2100,
    note: 'Plain monthly.',
  },
  {
    id: 'puregym',
    normalizedKey: 'PUREGYM',
    merchantName: 'PureGym',
    aliases: [],
    category: 'fitness',
    descriptors: ['PUREGYM LTD LONDON', 'DD PUREGYM LTD'],
    currency: 'USD',
    accountId: ACCOUNT_CHECKING,
    interval: FOUR_WEEKLY,
    anchorIso: '2024-07-22',
    count: 27,
    amountMinor: 2299,
    note: 'Four-weekly, the interval most often mislabelled monthly (13 charges a year, not 12).',
  },
  {
    id: 'whoop',
    normalizedKey: 'WHOOP',
    merchantName: 'Whoop',
    aliases: [],
    category: 'fitness',
    descriptors: ['WHOOP INC BOSTON', 'WHOOP INC'],
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
    interval: FOUR_WEEKLY,
    anchorIso: '2024-08-06',
    count: 26,
    amountMinor: 3000,
    note: 'Second four-weekly series, so the distinction is not carried by one merchant.',
  },
  {
    id: 'blue-apron',
    normalizedKey: 'BLUE APRON',
    merchantName: 'Blue Apron',
    aliases: [],
    category: 'food_delivery',
    descriptors: ['BLUE APRON', 'BLUE APRON 347-560-5723 NY'],
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
    interval: WEEKLY,
    anchorIso: '2024-09-05',
    count: 40,
    amountMinor: 5999,
    note: 'Weekly, starting part-way through the window.',
  },
  {
    id: 'wash-club',
    normalizedKey: 'THE WASH CLUB',
    merchantName: 'The Wash Club',
    aliases: [],
    category: 'other',
    descriptors: ['THE WASH CLUB', 'THE WASH CLUB SEATTLE WA'],
    currency: 'USD',
    accountId: ACCOUNT_CHECKING,
    interval: WEEKLY,
    anchorIso: '2024-07-19',
    count: 60,
    amountMinor: 1500,
    note: 'Weekly for a long run, to keep the weekly bucket from resting on one series.',
  },
  {
    id: 'dollar-shave',
    normalizedKey: 'DOLLAR SHAVE CLUB',
    merchantName: 'Dollar Shave Club',
    aliases: [],
    category: 'other',
    descriptors: ['DOLLAR SHAVE CLUB', 'DOLLAR SHAVE CLUB 310-870-3373 CA'],
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
    interval: QUARTERLY,
    anchorIso: '2024-08-14',
    count: 8,
    amountMinor: 2400,
    note: 'Quarterly.',
  },
  {
    id: 'terminix',
    normalizedKey: 'TERMINIX',
    merchantName: 'Terminix',
    aliases: [],
    category: 'other',
    descriptors: ['TERMINIX 800-837-6464 TN', 'TERMINIX'],
    currency: 'USD',
    accountId: ACCOUNT_CHECKING,
    interval: QUARTERLY,
    anchorIso: '2024-09-05',
    count: 8,
    amountMinor: 11900,
    note: 'Quarterly at a price high enough that a 2% amount band is wider than the jitter.',
  },
  {
    id: 'onepassword',
    normalizedKey: '1PASSWORD',
    merchantName: '1Password',
    aliases: [],
    category: 'security_vpn',
    descriptors: ['1PASSWORD.COM', '1PASSWORD.COM ON'],
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
    interval: ANNUAL,
    anchorIso: '2024-09-12',
    count: 2,
    amountMinor: 3588,
    note: 'The annual with only two occurrences in the window — the hardest true positive there is.',
  },
  {
    id: 'namecheap',
    normalizedKey: 'NAMECHEAP',
    merchantName: 'Namecheap',
    aliases: [],
    category: 'software',
    descriptors: ['NAMECHEAP.COM', 'NAMECHEAP.COM AZ'],
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
    interval: ANNUAL,
    anchorIso: '2024-07-17',
    count: 3,
    amountMinor: 1298,
    note: 'Annual anchored at the window edge, so three renewals fall inside it.',
  },
  {
    id: 'deezer',
    normalizedKey: 'DEEZER',
    merchantName: 'Deezer',
    aliases: [],
    category: 'music_audio',
    descriptors: ['DEEZER PARIS', 'DEEZER'],
    currency: 'EUR',
    accountId: ACCOUNT_EURO,
    interval: MONTHLY,
    anchorIso: '2024-07-23',
    count: 25,
    amountMinor: 1099,
    note: 'Second currency. Must never share a cluster with a USD series at the same price.',
  },
  {
    id: 'myfitnesspal',
    normalizedKey: 'MYFITNESSPAL',
    merchantName: 'MyFitnessPal',
    aliases: [],
    category: 'fitness',
    descriptors: ['MYFITNESSPAL', 'MYFITNESSPAL DUBLIN'],
    currency: 'EUR',
    accountId: ACCOUNT_EURO,
    interval: QUARTERLY,
    anchorIso: '2024-08-22',
    count: 8,
    amountMinor: 2999,
    note: 'Second currency, longer cadence.',
  },
];

/** Merchants whose series is built by hand below, but which still belong in the registry. */
const SPECIAL_REGISTRY: readonly {
  readonly key: string;
  readonly name: string;
  readonly category: Category;
  readonly typicalIntervals: readonly RecurrenceInterval[];
}[] = [
  { key: 'NOTION', name: 'Notion', category: 'software', typicalIntervals: [MONTHLY] },
  {
    key: 'DISNEYPLUS',
    name: 'Disney Plus',
    category: 'streaming_video',
    typicalIntervals: [MONTHLY],
  },
  { key: 'DROPBOX', name: 'Dropbox', category: 'cloud_storage', typicalIntervals: [MONTHLY] },
  { key: 'AUDIBLE', name: 'Audible', category: 'news_publishing', typicalIntervals: [MONTHLY] },
  {
    key: 'PACIFIC GAS ELECTRIC',
    name: 'Pacific Gas and Electric',
    category: 'utilities',
    typicalIntervals: [MONTHLY],
  },
  {
    key: 'PARAMOUNT PLUS',
    name: 'Paramount Plus',
    category: 'streaming_video',
    typicalIntervals: [MONTHLY],
  },
];

function buildRegistry(): MerchantRegistry {
  const entries: MerchantRegistryEntry[] = PLAIN_PLANTS.map((plant) => ({
    id: plant.id,
    name: plant.merchantName,
    aliases: plant.aliases,
    descriptorPatterns: [plant.normalizedKey],
    typicalIntervals: [plant.interval],
    category: plant.category,
  }));
  for (const special of SPECIAL_REGISTRY) {
    entries.push({
      id: special.key.toLowerCase().replace(/\s+/g, '-'),
      name: special.name,
      aliases: [],
      descriptorPatterns: [special.key],
      typicalIntervals: special.typicalIntervals,
      category: special.category,
    });
  }
  return createInMemoryRegistry(entries);
}

// ── noise ──────────────────────────────────────────────────────────────────────────────

interface NoiseSpec {
  readonly base: string;
  readonly visits: number;
  readonly minMinor: number;
  readonly maxMinor: number;
  readonly currency: string;
  readonly accountId: string;
}

/**
 * Merchants the user pays repeatedly and does not subscribe to.
 *
 * The amount ranges span at least a factor of eight on purpose. That is what a real grocery run
 * or coffee stop looks like, and it is also what pushes the coefficient of variation past the
 * engine's 0.40 ceiling — which is the filter that has to distinguish "a shop I visit" from "a
 * price I pay". A tighter, tidier range would be a corpus that never tests it.
 */
const NOISE_MERCHANTS: readonly NoiseSpec[] = [
  {
    base: 'WHOLE FOODS MKT',
    visits: 20,
    minMinor: 600,
    maxMinor: 11_000,
    currency: 'USD',
    accountId: ACCOUNT_CHECKING,
  },
  {
    base: 'TRADER JOES',
    visits: 16,
    minMinor: 500,
    maxMinor: 9500,
    currency: 'USD',
    accountId: ACCOUNT_CHECKING,
  },
  {
    base: 'SAFEWAY',
    visits: 14,
    minMinor: 400,
    maxMinor: 12_000,
    currency: 'USD',
    accountId: ACCOUNT_CHECKING,
  },
  {
    base: 'ALDI SUED',
    visits: 12,
    minMinor: 350,
    maxMinor: 8500,
    currency: 'EUR',
    accountId: ACCOUNT_EURO,
  },
  {
    base: 'CVS PHARMACY',
    visits: 11,
    minMinor: 500,
    maxMinor: 7400,
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
  },
  {
    base: 'SHELL OIL',
    visits: 10,
    minMinor: 1200,
    maxMinor: 12_500,
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
  },
  {
    base: 'CHEVRON',
    visits: 8,
    minMinor: 1100,
    maxMinor: 11_000,
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
  },
  {
    base: 'BLUE BOTTLE COFFEE',
    visits: 14,
    minMinor: 325,
    maxMinor: 3400,
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
  },
  {
    base: 'PEETS COFFEE',
    visits: 12,
    minMinor: 300,
    maxMinor: 3200,
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
  },
  {
    base: 'CHIPOTLE',
    visits: 9,
    minMinor: 800,
    maxMinor: 6500,
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
  },
  {
    base: 'THAI BASIL KITCHEN',
    visits: 7,
    minMinor: 900,
    maxMinor: 9600,
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
  },
  {
    base: 'OSTERIA MOZZA',
    visits: 5,
    minMinor: 2500,
    maxMinor: 28_000,
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
  },
  {
    base: 'UBER TRIP',
    visits: 18,
    minMinor: 600,
    maxMinor: 8500,
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
  },
  {
    base: 'LYFT RIDE',
    visits: 11,
    minMinor: 550,
    maxMinor: 7800,
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
  },
  {
    base: 'ATM WITHDRAWAL',
    visits: 24,
    minMinor: 2000,
    maxMinor: 24_000,
    currency: 'USD',
    accountId: ACCOUNT_CHECKING,
  },
  {
    base: 'ONLINE TRANSFER TO SAV',
    visits: 16,
    minMinor: 5000,
    maxMinor: 200_000,
    currency: 'USD',
    accountId: ACCOUNT_CHECKING,
  },
  {
    base: 'HOME DEPOT',
    visits: 8,
    minMinor: 1200,
    maxMinor: 42_000,
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
  },
  {
    base: 'TARGET',
    visits: 14,
    minMinor: 800,
    maxMinor: 18_000,
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
  },
  {
    base: 'BEST BUY',
    visits: 5,
    minMinor: 1500,
    maxMinor: 90_000,
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
  },
];

/** One charge each, scattered across the window. The long tail of any real statement. */
const ONE_OFF_MERCHANTS: readonly string[] = [
  'REI CO OP',
  'PATAGONIA',
  'IKEA BROOKLYN',
  'MUJI USA',
  'BARNES AND NOBLE',
  'POWELLS BOOKS',
  'ETSY SELLER',
  'ALIBABA EXPRESS',
  'WAYFAIR',
  'CRATE AND BARREL',
  'ACE HARDWARE',
  'PETCO',
  'PETSMART',
  'PARAGON SPORTS',
  'DICKS SPORTING GOODS',
  'ZARA USA',
  'UNIQLO',
  'NORDSTROM RACK',
  'MACYS',
  'SEPHORA',
  'ULTA BEAUTY',
  'WARBY PARKER',
  'LENSCRAFTERS',
  'GREAT CLIPS',
  'DRYBAR',
  'REGAL CINEMAS',
  'AMC THEATRES',
  'ALAMO DRAFTHOUSE',
  'TICKETMASTER',
  'EVENTBRITE',
  'STUBHUB',
  'DELTA AIR LINES',
  'UNITED AIRLINES',
  'ALASKA AIRLINES',
  'MARRIOTT HOTELS',
  'HILTON GARDEN INN',
  'AIRBNB PAYMENTS',
  'HERTZ RENT A CAR',
  'AVIS CAR RENTAL',
  'AMTRAK',
  'BART CLIPPER',
  'MTA VENDING',
  'SFO PARKING',
  'JIFFY LUBE',
  'MIDAS AUTO SERVICE',
  'LES SCHWAB TIRE',
  'DMV FEES',
  'US POSTAL SERVICE',
  'FEDEX OFFICE',
  'UPS STORE',
  'STAPLES',
  'OFFICE DEPOT',
  'MICHAELS',
  'JOANN FABRIC',
  'GUITAR CENTER',
  'SWEETWATER SOUND',
  'BLICK ART MATERIALS',
  'HOME CHEF ONE TIME',
  'GOLDBELLY',
  'HARRY AND DAVID',
  'EDIBLE ARRANGEMENTS',
  'ORCHARD SUPPLY',
  'SMITH FARM STAND',
  'BAY AREA BIKE REPAIR',
  'NORTH BEACH DENTAL',
  'SUNSET VETERINARY',
  'CITY OF OAKLAND PARKING',
  'STATE FARM CLAIM FEE',
  'GOODWILL DONATION',
  'RED CROSS GIFT',
  'BRIGHTWATER POTTERY',
  'CEDAR HILL NURSERY',
  'PRESIDIO GOLF SHOP',
  'MISSION ROCK RESORT',
  'FERRY BUILDING MKT',
  'TARTINE BAKERY',
  'CITY LIGHTS BOOKSELLERS',
  'GREEN APPLE BOOKS',
  'RASPUTIN MUSIC',
  'AMOEBA RECORDS',
  'LAKESIDE HARDWARE',
  'PACIFIC ORTHOPEDICS',
  'BRIDGEPORT OPTICAL',
  'HALLIDIE PLAZA GARAGE',
  'YERBA BUENA ICE RINK',
  'EXPLORATORIUM',
  'CAL ACADEMY SCIENCES',
  'SFMOMA TICKETS',
  'OAKLAND ZOO',
  'MUIR WOODS SHUTTLE',
  'POINT REYES LODGING',
  'HALF MOON BAY BREWING',
  'ANCHOR STEAM TAPROOM',
  'PHILZ COFFEE ONE OFF',
  'BI RITE CREAMERY',
  'HUMPHRY SLOCOMBE',
  'SWAN OYSTER DEPOT',
  'ZUNI CAFE',
  'NOPA RESTAURANT',
  'STATE BIRD PROVISIONS',
  'FLOUR AND WATER',
  'BURMA SUPERSTAR',
  'HOG ISLAND OYSTER',
  'GOLDEN BOY PIZZA',
  'MITCHELLS ICE CREAM',
  'ARIZMENDI BAKERY',
  'CHEESE BOARD COLLECTIVE',
  'BERKELEY BOWL PRODUCE',
  'MONTEREY FISH MARKET',
  'PRATHER RANCH MEAT',
  'FAR WEST FUNGI',
  'ROXIE THEATER',
  'CASTRO THEATRE',
  'GREAT STAR THEATER',
  'STERN GROVE FESTIVAL',
  'OUTSIDE LANDS MERCH',
];

/** Bank and processor noise wrapped around a merchant name. All of it must normalise away. */
function decorate(rng: Rng, base: string): string {
  const prefix = rng.pick([
    '',
    '',
    '',
    'POS DEBIT ',
    'DEBIT CARD PURCHASE ',
    'PURCHASE AUTHORIZED ON 03/14 ',
  ]);
  const suffix = rng.pick([
    '',
    '',
    '',
    ' STORE 4471',
    ' 415-555-0134 CA',
    ' SAN JOSE CA',
    ' #8891',
  ]);
  return `${prefix}${base}${suffix}`;
}

/**
 * Dates for a merchant the user visits irregularly.
 *
 * Gaps are drawn log-uniformly from 4 to 210 days, which keeps most of them well away from any
 * billing period while still producing the occasional pair that looks fortnightly or monthly.
 * That is the point: the corpus should contain accidental near-cadences, because the engine has
 * to reject them on the evidence rather than because the fixture never offered any.
 */
function irregularDates(rng: Rng, visits: number): PlainDate[] {
  const dates: PlainDate[] = [];
  let cursor = addDays(WINDOW_START, rng.int(0, 40));
  for (let i = 0; i < visits; i += 1) {
    if (isAfter(cursor, TODAY)) break;
    dates.push(cursor);
    cursor = addDays(cursor, rng.spend(4, 210));
  }
  return dates;
}

// ── assembly ───────────────────────────────────────────────────────────────────────────

export function generateSyntheticCorpus(seed: number): SyntheticCorpus {
  const rng = mulberry32(seed);
  const mint = createMint();
  const transactions: DetectionTransaction[] = [];
  const planted: PlantedSubscription[] = [];
  const noiseTransactionIds: string[] = [];

  const plant = (
    id: string,
    normalizedKey: string,
    currency: string,
    interval: RecurrenceInterval,
    amountMinor: number,
    rows: readonly DetectionTransaction[],
    note: string,
  ): void => {
    transactions.push(...rows);
    planted.push({
      id,
      normalizedKey,
      currency,
      interval,
      amountMinor,
      transactionIds: rows.map((row) => row.id),
      note,
    });
  };

  for (const spec of PLAIN_PLANTS) {
    const rows = emitSeries(rng, mint, {
      descriptors: spec.descriptors,
      currency: spec.currency,
      accountId: spec.accountId,
      interval: spec.interval,
      anchor: parsePlainDate(spec.anchorIso),
      count: spec.count,
      amountAt: () => spec.amountMinor,
    });
    plant(
      spec.id,
      spec.normalizedKey,
      spec.currency,
      spec.interval,
      spec.amountMinor,
      rows,
      spec.note,
    );
  }

  // ── trial → paid ─────────────────────────────────────────────────────────────────────
  // A £0.00 authorisation, then the real price a month later. The engine has to read the first
  // charge as an introductory level rather than as a subscription that costs nothing.
  const notion = emitSeries(rng, mint, {
    descriptors: ['NOTION', 'NOTION 415-555-0199 CA'],
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
    interval: MONTHLY,
    anchor: parsePlainDate('2025-02-10'),
    count: 18,
    amountAt: (index) => (index === 0 ? 0 : 1000),
  });
  plant(
    'notion-trial',
    'NOTION',
    'USD',
    MONTHLY,
    1000,
    notion,
    'Trial converting to paid: isTrial and trialEndsAt must both be set.',
  );

  // ── price increase mid-window ────────────────────────────────────────────────────────
  const disney = emitSeries(rng, mint, {
    descriptors: ['DISNEYPLUS.COM', 'DISNEYPLUS.COM 888-905-7888 CA'],
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
    interval: MONTHLY,
    anchor: parsePlainDate('2024-07-26'),
    count: 25,
    amountAt: (index) => (index < 13 ? 1099 : 1399),
  });
  plant(
    'disney-price-rise',
    'DISNEYPLUS',
    'USD',
    MONTHLY,
    1399,
    disney,
    'A +27% price step held for a year. Must be one subscription with a priceChange, not two.',
  );

  // ── the same merchant on two cards ───────────────────────────────────────────────────
  // Concurrent, not sequential: a replaced card looks the same until you notice the two runs
  // overlap. Overlap is what makes this a duplicate rather than a migration.
  const dropboxPrimary = emitSeries(rng, mint, {
    descriptors: ['DROPBOX.COM'],
    currency: 'USD',
    accountId: ACCOUNT_CHECKING,
    interval: MONTHLY,
    anchor: parsePlainDate('2024-08-11'),
    count: 24,
    amountAt: () => 1199,
  });
  const dropboxSecondary = emitSeries(rng, mint, {
    descriptors: ['DROPBOX.COM 415-857-6800 CA'],
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
    interval: MONTHLY,
    anchor: parsePlainDate('2024-08-13'),
    count: 24,
    amountAt: () => 1199,
  });
  plant(
    'dropbox-duplicate',
    'DROPBOX',
    'USD',
    MONTHLY,
    1199,
    [...dropboxPrimary, ...dropboxSecondary],
    'One merchant billing two accounts at once. Two candidates plus a duplicate group.',
  );

  // ── charges that stop ────────────────────────────────────────────────────────────────
  // Four months and then silence. Brief §4.4 is explicit that this is demoted, never discarded —
  // a subscription that stopped is either a cancellation the user forgot or a payment that failed.
  const audible = emitSeries(rng, mint, {
    descriptors: ['AUDIBLE.COM BILL WA'],
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
    interval: MONTHLY,
    anchor: parsePlainDate('2024-08-15'),
    count: 4,
    amountAt: () => 1495,
  });
  plant(
    'audible-stopped',
    'AUDIBLE',
    'USD',
    MONTHLY,
    1495,
    audible,
    'Charges stop four months in. Must still be surfaced, demoted to paused/lapsed.',
  );

  // ── metered utility ──────────────────────────────────────────────────────────────────
  const utility = emitSeries(rng, mint, {
    descriptors: ['PACIFIC GAS ELECTRIC CA', 'PACIFIC GAS ELECTRIC 800-743-5000 CA'],
    currency: 'USD',
    accountId: ACCOUNT_CHECKING,
    interval: MONTHLY,
    anchor: parsePlainDate('2024-07-28'),
    count: 25,
    amountAt: () => 8000 + rng.int(-1900, 1900),
  });
  plant(
    'pge-variable',
    'PACIFIC GAS ELECTRIC',
    'USD',
    MONTHLY,
    8000,
    utility,
    'Variable amount, regular cadence. Surfaced and flagged, not discarded.',
  );

  // ── refunded charge ──────────────────────────────────────────────────────────────────
  const paramount = emitSeries(rng, mint, {
    descriptors: ['PARAMOUNT PLUS', 'PARAMOUNT PLUS 888-274-5343 NY'],
    currency: 'USD',
    accountId: ACCOUNT_CREDIT,
    interval: MONTHLY,
    anchor: parsePlainDate('2024-08-19'),
    count: 24,
    amountAt: () => 1199,
  });
  const refunded = paramount[8];
  if (refunded === undefined) throw new Error('The refund fixture needs a charge to reverse.');
  // The credit carries the *original* descriptor, because that is what a card reversal does — and
  // because clustering is descriptor-keyed, a credit posted under `… REFUND` would land in its
  // own cluster and never be paired with anything.
  const refund: DetectionTransaction = {
    id: mint(),
    postedAt: addDays(refunded.postedAt, 6),
    amountMinor: -refunded.amountMinor,
    currency: refunded.currency,
    rawDescriptor: refunded.rawDescriptor,
    accountId: refunded.accountId,
    pending: false,
  };
  plant(
    'paramount-refund',
    'PARAMOUNT PLUS',
    'USD',
    MONTHLY,
    1199,
    [...paramount, refund],
    'One month refunded in full. The pair cancels out and the hole is absorbed as a missed period.',
  );

  // ── pending duplicates of real charges ───────────────────────────────────────────────
  // Every aggregator emits these; counting them alongside the posted row doubles a subscription.
  // They are attributed to their subscription so they cannot be mistaken for a false positive.
  for (const target of ['netflix', 'spotify', 'github'] as const) {
    const owner = planted.find((entry) => entry.id === target);
    const source = transactions.find((row) => owner?.transactionIds.includes(row.id) === true);
    if (owner === undefined || source === undefined) continue;
    const pendingIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const row: DetectionTransaction = {
        id: mint(),
        postedAt: addDays(source.postedAt, -1 - i),
        amountMinor: source.amountMinor,
        currency: source.currency,
        rawDescriptor: source.rawDescriptor,
        accountId: source.accountId,
        pending: true,
      };
      transactions.push(row);
      pendingIds.push(row.id);
    }
    planted[planted.indexOf(owner)] = {
      ...owner,
      transactionIds: [...owner.transactionIds, ...pendingIds],
    };
  }

  // ── noise ────────────────────────────────────────────────────────────────────────────

  const pushNoise = (row: DetectionTransaction): void => {
    transactions.push(row);
    noiseTransactionIds.push(row.id);
  };

  for (const spec of NOISE_MERCHANTS) {
    for (const postedAt of irregularDates(rng, spec.visits)) {
      pushNoise({
        id: mint(),
        postedAt,
        amountMinor: rng.spend(spec.minMinor, spec.maxMinor),
        currency: spec.currency,
        rawDescriptor: decorate(rng, spec.base),
        accountId: spec.accountId,
        pending: false,
      });
    }
  }

  for (const base of ONE_OFF_MERCHANTS) {
    pushNoise({
      id: mint(),
      postedAt: addDays(WINDOW_START, rng.int(0, 730)),
      amountMinor: rng.spend(700, 45_000),
      currency: 'USD',
      rawDescriptor: decorate(rng, base),
      accountId: rng.pick([ACCOUNT_CHECKING, ACCOUNT_CREDIT]),
      pending: false,
    });
  }

  // ── the two deliberate near-misses ───────────────────────────────────────────────────

  // Exactly twice, six weeks apart, at an identical amount. Two charges is the minimum an
  // occurrence count will accept and 42 days is three fortnights, so this fits a cadence
  // arithmetically and must still be rejected: two points do not make a series.
  const nearMissAnchor = addDays(WINDOW_START, 190);
  for (const offset of [0, 42]) {
    pushNoise({
      id: mint(),
      postedAt: addDays(nearMissAnchor, offset),
      amountMinor: 4995,
      currency: 'USD',
      rawDescriptor: 'CASCADE OUTDOOR SUPPLY',
      accountId: ACCOUNT_CREDIT,
      pending: false,
    });
  }

  // Three charges, unrelated amounts, unrelated gaps. The shape a naive "3+ charges from the
  // same merchant" rule reports and a coefficient of variation rejects.
  const trioAnchor = addDays(WINDOW_START, 300);
  const trio: readonly (readonly [number, number])[] = [
    [0, 1299],
    [23, 8450],
    [120, 3200],
  ];
  for (const [offset, amountMinor] of trio) {
    pushNoise({
      id: mint(),
      postedAt: addDays(trioAnchor, offset),
      amountMinor,
      currency: 'USD',
      rawDescriptor: 'HARBOR POINT MARINA',
      accountId: ACCOUNT_CREDIT,
      pending: false,
    });
  }

  transactions.sort((a, b) => comparePlainDate(a.postedAt, b.postedAt) || a.id.localeCompare(b.id));

  return {
    seed,
    today: TODAY,
    windowStart: WINDOW_START,
    transactions,
    planted,
    registry: buildRegistry(),
    noiseTransactionIds,
    nearMissKeys: ['CASCADE OUTDOOR SUPPLY', 'HARBOR POINT MARINA'],
  };
}
