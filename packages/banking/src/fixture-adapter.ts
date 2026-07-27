/**
 * The fixture aggregator — the default everywhere that is not production (`AGGREGATOR=fixture`).
 *
 * This is not a stub. It is the adapter dev, demo, CI, and every test in this package run
 * against, which means the sync engine's hardest properties — paging, cursor resumability,
 * pending→posted re-issue, retraction, idempotency — are exercised by the *default* path rather
 * than by a special case someone has to remember to run. A fixture that only returns three rows
 * proves that the code compiles.
 *
 * So it serves 24 months of one household's history across two accounts in two currencies, with
 * the recurring series a real user would recognise (and would be annoyed to still be paying for)
 * plus the noise those series have to be found inside. The design owes its structure to
 * `packages/detection/test/synthetic.ts`, which is the measuring instrument for detection
 * quality — but nothing is imported from there. That file is another package's test directory;
 * this one ships.
 *
 * Two rules, both load-bearing:
 *
 * 1. **No `Math.random`, no `Date.now`.** Randomness is a seeded mulberry32 and time is an
 *    injected `Clock`. A fixture that differs between runs turns a real regression into a flaky
 *    test and gets muted.
 * 2. **The corpus is frozen at first touch.** Paging hands out offsets into an ordered event
 *    list; if the list were regenerated per call against a moving clock, page 4 would not be the
 *    page 4 that page 3's cursor pointed at.
 */

import { createHash } from 'node:crypto';
import {
  type Clock,
  type PlainDate,
  type RecurrenceInterval,
  ANNUAL,
  FOUR_WEEKLY,
  MONTHLY,
  QUARTERLY,
  SystemClock,
  WEEKLY,
  addDays,
  addMonths,
  approximateDays,
  comparePlainDate,
  dayOfWeek,
  daysInMonth,
  isAfter,
  occurrence,
  plainDate,
  today as todayIn,
} from '@ledger/core';
import { type Keyring, getKeyring, safeEqual, seal } from '@ledger/crypto';

import {
  type AggregatorAccount,
  type AggregatorAdapter,
  type AggregatorConnection,
  type AggregatorTransaction,
  type LinkSession,
  type LinkSessionOptions,
  type LinkedItem,
  type SyncPage,
  type WebhookEvent,
  type WebhookKind,
  AggregatorError,
  accessTokenAad,
  toOutflowMinor,
} from './adapter';

export const FIXTURE_PROVIDER = 'fixture';

/** How much history the fixture serves, matching the real backfill window. */
export const FIXTURE_WINDOW_MONTHS = 24;

const DEFAULT_SEED = 20_260_725;
const DEFAULT_PAGE_SIZE = 100;
const CURSOR_PREFIX = 'fixture:v1:';

const CHECKING = 'fixture-acct-checking-usd';
const CARD = 'fixture-acct-card-eur';

const ACCOUNTS: readonly AggregatorAccount[] = [
  {
    externalId: CHECKING,
    name: 'Everyday Checking',
    officialName: 'Fixture Bank Everyday Checking',
    mask: '4417',
    type: 'depository',
    subtype: 'checking',
    currency: 'USD',
  },
  {
    externalId: CARD,
    name: 'Reise Card',
    officialName: 'Fixture Bank Reise Mastercard',
    mask: '9021',
    type: 'credit',
    subtype: 'credit card',
    currency: 'EUR',
  },
];

// ── seeded randomness ──────────────────────────────────────────────────────────────────

interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /**
   * Log-uniform integer in [min, max].
   *
   * Discretionary spend at one merchant is not uniform — a $4 coffee and a $38 round both
   * happen, and the small ones happen more often. It also produces a much higher coefficient of
   * variation than a uniform draw over the same range, which is precisely the property that
   * makes noise fall out of the detector's amount filter instead of masquerading as a price.
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

// ── the planted series ─────────────────────────────────────────────────────────────────

/** How the price of a series moves over the window. */
type AmountPlan =
  | { readonly kind: 'flat'; readonly minor: number }
  /** A price rise partway through — the case the product exists to catch. */
  | {
      readonly kind: 'rise';
      readonly minor: number;
      readonly toMinor: number;
      readonly atIndex: number;
    }
  /** A trial that converted: near-zero, then the real price. */
  | {
      readonly kind: 'trial';
      readonly trialMinor: number;
      readonly minor: number;
      readonly trialCount: number;
    }
  /** Metered billing: the cadence holds, the amount does not. */
  | { readonly kind: 'metered'; readonly minMinor: number; readonly maxMinor: number };

interface SeriesSpec {
  readonly id: string;
  readonly accountExternalId: string;
  readonly currency: string;
  readonly descriptors: readonly string[];
  readonly interval: RecurrenceInterval;
  /** Months after the start of the window that the first charge lands in. */
  readonly startMonth: number;
  /** Day of month for the anchor. 31 clamps, which is the month-end case. */
  readonly anchorDay: number;
  readonly amount: AmountPlan;
  /** Stops after this many charges — a subscription the user cancelled mid-window. */
  readonly stopAfter?: number;
  /** Every nth charge arrives pending first and is re-issued when it posts. */
  readonly reissueEvery?: number;
  readonly note: string;
}

/**
 * The corpus.
 *
 * Chosen so the hard cases are present rather than the easy ones: a month-end anchor that clamps
 * to February, a four-weekly gym that is not monthly, an annual seen twice, a trial that
 * converted, a price rise, a metered utility, a series that stops, and two intermediated billing
 * channels (`APL*` and `PAYPAL *`) whose cancellation route is not the merchant's own website.
 */
const SERIES: readonly SeriesSpec[] = [
  {
    id: 'netflix',
    accountExternalId: CHECKING,
    currency: 'USD',
    descriptors: ['NETFLIX.COM', 'NETFLIX 866-579-7172 CA'],
    interval: MONTHLY,
    startMonth: 0,
    anchorDay: 18,
    amount: { kind: 'rise', minor: 1549, toMinor: 1799, atIndex: 14 },
    note: 'Monthly with a price rise 14 months in.',
  },
  {
    id: 'spotify-us',
    accountExternalId: CHECKING,
    currency: 'USD',
    descriptors: ['SPOTIFY USA', 'SPOTIFY USA 877-778-1161 NY'],
    interval: MONTHLY,
    startMonth: 0,
    anchorDay: 24,
    amount: { kind: 'flat', minor: 1199 },
    reissueEvery: 6,
    note: 'Monthly; every sixth charge arrives pending and is re-issued when it posts.',
  },
  {
    id: 'nytimes',
    accountExternalId: CHECKING,
    currency: 'USD',
    descriptors: ['NYTIMES*NYTIMES', 'NYTIMES*NYTIMES 800-698-4637 NY'],
    interval: MONTHLY,
    startMonth: 0,
    // The 31st. February clamps to the 28th and March goes back to the 31st, so the day-gap
    // sequence reads 28/31/30/31 — noise to anything comparing gaps against a fixed 30.
    anchorDay: 31,
    amount: { kind: 'flat', minor: 1700 },
    note: 'Month-end anchor: the clamping case.',
  },
  {
    id: 'icloud',
    accountExternalId: CHECKING,
    currency: 'USD',
    descriptors: ['APL*ICLOUD STORAGE', 'APL* ICLOUD STORAGE 866-712-7753 CA'],
    interval: MONTHLY,
    startMonth: 0,
    anchorDay: 20,
    amount: { kind: 'flat', minor: 299 },
    note: 'App Store billed — cannot be cancelled on the merchant site.',
  },
  {
    id: 'planet-fitness',
    accountExternalId: CHECKING,
    currency: 'USD',
    descriptors: ['PLANET FITNESS MA', 'PLANET FITNESS 844-880-7180 MA'],
    interval: MONTHLY,
    startMonth: 0,
    anchorDay: 1,
    amount: { kind: 'flat', minor: 1000 },
    note: 'Monthly gym.',
  },
  {
    id: 'github',
    accountExternalId: CHECKING,
    currency: 'USD',
    descriptors: ['GITHUB.COM', 'GITHUB.COM 877-448-4820 CA'],
    interval: MONTHLY,
    startMonth: 1,
    anchorDay: 9,
    amount: { kind: 'flat', minor: 2100 },
    note: 'Monthly.',
  },
  {
    id: 'openai',
    accountExternalId: CHECKING,
    currency: 'USD',
    descriptors: ['OPENAI *CHATGPT SUBSCR', 'OPENAI *CHATGPT SUBSCR 415-799-8888 CA'],
    interval: MONTHLY,
    startMonth: 6,
    anchorDay: 12,
    amount: { kind: 'trial', trialMinor: 100, minor: 2000, trialCount: 1 },
    note: 'A trial that converted — the notification this product exists to send.',
  },
  {
    id: 'hulu',
    accountExternalId: CHECKING,
    currency: 'USD',
    descriptors: ['HULU 877-824-4858 CA', 'HULU'],
    interval: MONTHLY,
    startMonth: 0,
    anchorDay: 6,
    amount: { kind: 'flat', minor: 1799 },
    stopAfter: 9,
    note: 'Cancelled mid-window: the series must be demoted, never invented forward.',
  },
  {
    id: 'blue-apron',
    accountExternalId: CHECKING,
    currency: 'USD',
    descriptors: ['BLUE APRON', 'BLUE APRON 347-560-5723 NY'],
    interval: WEEKLY,
    startMonth: 2,
    anchorDay: 5,
    amount: { kind: 'flat', minor: 5999 },
    note: 'Weekly, starting part-way through the window.',
  },
  {
    id: 'dollar-shave',
    accountExternalId: CHECKING,
    currency: 'USD',
    descriptors: ['DOLLAR SHAVE CLUB', 'DOLLAR SHAVE CLUB 310-870-3373 CA'],
    interval: QUARTERLY,
    startMonth: 1,
    anchorDay: 14,
    amount: { kind: 'flat', minor: 2400 },
    note: 'Quarterly.',
  },
  {
    id: 'seattle-city-light',
    accountExternalId: CHECKING,
    currency: 'USD',
    descriptors: ['SEATTLE CITY LIGHT WEB PMT', 'SEATTLE CITY LIGHT'],
    interval: MONTHLY,
    startMonth: 0,
    anchorDay: 15,
    amount: { kind: 'metered', minMinor: 4200, maxMinor: 13800 },
    note: 'Metered utility: regular cadence, variable amount. Surfaced, flagged, not discarded.',
  },
  {
    id: 'onepassword',
    accountExternalId: CHECKING,
    currency: 'USD',
    descriptors: ['1PASSWORD.COM', '1PASSWORD.COM ON'],
    interval: ANNUAL,
    startMonth: 2,
    anchorDay: 12,
    amount: { kind: 'flat', minor: 3588 },
    note: 'Annual seen twice in the window — the hardest true positive there is.',
  },
  {
    id: 'amazon-prime',
    accountExternalId: CHECKING,
    currency: 'USD',
    descriptors: ['AMZN Mktp US*PRIME MEMBER', 'AMAZON PRIME*2M4XY9'],
    interval: ANNUAL,
    startMonth: 4,
    anchorDay: 3,
    amount: { kind: 'rise', minor: 13900, toMinor: 13900, atIndex: 99 },
    note: 'Annual on the account that also carries heavy Amazon retail noise.',
  },

  // ── the EUR card ──────────────────────────────────────────────────────────────────
  {
    id: 'spotify-eu',
    accountExternalId: CARD,
    currency: 'EUR',
    descriptors: ['SPOTIFY AB STOCKHOLM', 'SPOTIFY AB'],
    interval: MONTHLY,
    startMonth: 0,
    anchorDay: 11,
    amount: { kind: 'flat', minor: 1099 },
    note: 'A second Spotify in a second currency: the duplicate pass must surface it, not merge it.',
  },
  {
    id: 'nordvpn',
    accountExternalId: CARD,
    currency: 'EUR',
    descriptors: ['PAYPAL *NORDVPN', 'PAYPAL *NORDVPN 35314369001'],
    interval: ANNUAL,
    startMonth: 1,
    anchorDay: 27,
    amount: { kind: 'flat', minor: 5988 },
    note: 'PayPal-intermediated annual: the channel changes where the user has to go to cancel.',
  },
  {
    id: 'fitx',
    accountExternalId: CARD,
    currency: 'EUR',
    descriptors: ['FITX BERLIN MITTE', 'FITX FITNESS GMBH'],
    interval: FOUR_WEEKLY,
    startMonth: 0,
    anchorDay: 22,
    amount: { kind: 'flat', minor: 2999 },
    note: 'Four-weekly — 13 charges a year, the interval most often mislabelled monthly.',
  },
  {
    id: 'o2',
    accountExternalId: CARD,
    currency: 'EUR',
    descriptors: ['O2 MOBILE DE MUENCHEN', 'O2 MOBILE DE'],
    interval: MONTHLY,
    startMonth: 0,
    anchorDay: 28,
    amount: { kind: 'flat', minor: 3999 },
    note: 'Carrier billing.',
  },
  {
    id: 'db-abo',
    accountExternalId: CARD,
    currency: 'EUR',
    descriptors: ['DB BAHNCARD ABO', 'DB VERTRIEB GMBH ABO'],
    interval: QUARTERLY,
    startMonth: 2,
    anchorDay: 8,
    amount: { kind: 'flat', minor: 6900 },
    note: 'Quarterly on the foreign-currency account.',
  },
];

/** Descriptors that look like spend and are not recurring. The false-positive material. */
const NOISE_DESCRIPTORS: readonly {
  readonly text: string;
  readonly min: number;
  readonly max: number;
}[] = [
  { text: 'TRADER JOES #182 SEATTLE WA', min: 1800, max: 14_200 },
  { text: 'SAFEWAY #1477 SEATTLE WA', min: 900, max: 11_800 },
  { text: 'STARBUCKS STORE 08812', min: 375, max: 1850 },
  { text: 'SQ *VICTROLA COFFEE', min: 450, max: 2300 },
  { text: 'TST* SUIKA SEATTLE WA', min: 2200, max: 9800 },
  { text: 'SHELL OIL 57444108704', min: 2900, max: 8600 },
  { text: 'AMZN Mktp US*RT4G91LC3', min: 600, max: 18_900 },
  { text: 'UBER *TRIP HELP.UBER.COM', min: 800, max: 4400 },
  { text: 'WALGREENS #5391', min: 500, max: 6200 },
  { text: 'PAYPAL *ETSYSELLER', min: 1200, max: 9400 },
];

const NOISE_DESCRIPTORS_EUR: readonly {
  readonly text: string;
  readonly min: number;
  readonly max: number;
}[] = [
  { text: 'REWE SAGT DANKE 4711 BERLIN', min: 700, max: 9300 },
  { text: 'EDEKA MARKT BERLIN', min: 800, max: 8800 },
  { text: 'BVG FAHRAUSWEIS APP', min: 320, max: 4900 },
  { text: 'DM DROGERIE MARKT SAGT DANKE', min: 500, max: 4200 },
  { text: 'BACKWERK BERLIN HBF', min: 250, max: 1400 },
  { text: 'AMZN Mktp DE*8H2K1L0M', min: 900, max: 15_600 },
];

/** Money arriving. Negative under the Ledger convention — see `adapter.ts`. */
const INFLOW_DESCRIPTOR = 'ACME ROBOTICS PAYROLL DIRECT DEP';
const INFLOW_MINOR = 412_600;

// ── generated corpus ───────────────────────────────────────────────────────────────────

interface FixtureEvent {
  readonly added: AggregatorTransaction | null;
  readonly removedExternalId: string | null;
}

interface Corpus {
  readonly events: readonly FixtureEvent[];
}

export interface FixtureAdapterOptions {
  /** Change it and you get a different — but equally fixed — household. */
  readonly seed?: number;
  readonly pageSize?: number;
  readonly clock?: Clock;
  /** When set, `handleWebhook` requires a matching `x-fixture-signature` header. */
  readonly webhookSecret?: string;
  readonly keyring?: Keyring;
}

export class FixtureAdapter implements AggregatorAdapter {
  readonly provider = FIXTURE_PROVIDER;

  private readonly seed: number;
  private readonly pageSize: number;
  private readonly clock: Clock;
  private readonly webhookSecret: string | null;
  private readonly injectedKeyring: Keyring | null;
  /** Frozen on first touch so a cursor keeps pointing at the same page. */
  private readonly corpora = new Map<string, Corpus>();
  private readonly removed = new Set<string>();

  constructor(options: FixtureAdapterOptions = {}) {
    this.seed = options.seed ?? DEFAULT_SEED;
    this.pageSize = Math.max(options.pageSize ?? DEFAULT_PAGE_SIZE, 1);
    this.clock = options.clock ?? new SystemClock();
    this.webhookSecret = options.webhookSecret ?? null;
    this.injectedKeyring = options.keyring ?? null;
  }

  createLinkSession(userId: string, options: LinkSessionOptions): Promise<LinkSession> {
    void options;
    return Promise.resolve({
      provider: this.provider,
      // Not a credential. It exists so the client flow has the same shape it will have against a
      // real aggregator, and so a demo cannot accidentally be pointed at production.
      linkToken: `fixture-link-${hashToken(`${this.seed}:${userId}`)}`,
      expiresAt: new Date(this.clock.epochMillis() + 4 * 60 * 60 * 1000),
    });
  }

  async exchangeToken(publicToken: string): Promise<LinkedItem> {
    const itemId = `fixture-item-${hashToken(publicToken)}`;
    this.removed.delete(itemId);

    // Sealed even though it protects nothing, because the seam is the point: if the fixture
    // path skipped `seal`, nothing in dev or CI would ever exercise the envelope, the AAD, or a
    // key rotation, and the first time we found out would be in production.
    const sealed = seal(
      await this.keyring(),
      `fixture-access-${itemId}`,
      accessTokenAad(this.provider, itemId),
    );

    return {
      provider: this.provider,
      externalItemId: itemId,
      institutionId: 'ins_fixture',
      institutionName: 'Fixture Bank',
      institutionLogo: null,
      accessTokenCiphertext: sealed.ciphertext,
      keyId: sealed.keyId,
      // 90 days, the usual open-banking consent window, so the health rules have something real
      // to derive from in a demo.
      consentExpiresAt: new Date(this.clock.epochMillis() + 90 * 24 * 60 * 60 * 1000),
    };
  }

  getAccounts(connection: AggregatorConnection): Promise<readonly AggregatorAccount[]> {
    return settled(() => {
      this.assertLive(connection);
      return ACCOUNTS;
    });
  }

  syncTransactions(connection: AggregatorConnection, cursor: string | null): Promise<SyncPage> {
    return settled(() => {
      this.assertLive(connection);
      const corpus = this.corpus(connection.externalItemId);
      const offset = parseCursor(cursor, corpus.events.length, this.provider);

      const slice = corpus.events.slice(offset, offset + this.pageSize);
      const added: AggregatorTransaction[] = [];
      const removed: string[] = [];
      for (const event of slice) {
        if (event.added !== null) added.push(event.added);
        if (event.removedExternalId !== null) removed.push(event.removedExternalId);
      }

      const nextOffset = offset + slice.length;
      return {
        added,
        // The fixture never revises a settled charge. The pending→posted re-issue is modelled
        // the way aggregators actually do it — a second `added` row under a new id — because
        // that is the case `dedupe_hash` exists for, and modelling it as a `modified` would
        // quietly make the backstop untested.
        modified: [],
        removed,
        nextCursor: `${CURSOR_PREFIX}${String(nextOffset)}`,
        hasMore: nextOffset < corpus.events.length,
      };
    });
  }

  handleWebhook(
    rawBody: string,
    headers: Readonly<Record<string, string | undefined>>,
  ): Promise<WebhookEvent> {
    return settled(() => {
      if (this.webhookSecret !== null) {
        const signature = headerValue(headers, 'x-fixture-signature');
        const expected = sha256Hex(`${this.webhookSecret}.${rawBody}`);
        if (signature === null || !safeEqual(signature, expected)) {
          throw new AggregatorError(this.provider, 'invalid_webhook', 'Signature does not verify.');
        }
      }

      const body = parseJsonObject(rawBody, this.provider);
      const type = readString(body, 'type') ?? 'sync_updates';

      return {
        provider: this.provider,
        // A caller-supplied id makes the replay guard testable directly; the body hash is the
        // fallback, and is what a provider that sends no delivery id forces on us.
        externalId: readString(body, 'id') ?? sha256Hex(rawBody),
        itemExternalId: readString(body, 'item_id'),
        type,
        kind: fixtureWebhookKind(type),
        payload: body,
      };
    });
  }

  removeConnection(connection: AggregatorConnection): Promise<void> {
    this.removed.add(connection.externalItemId);
    this.corpora.delete(connection.externalItemId);
    return Promise.resolve();
  }

  // ── internals ────────────────────────────────────────────────────────────────────────

  private async keyring(): Promise<Keyring> {
    return this.injectedKeyring ?? (await getKeyring());
  }

  private assertLive(connection: AggregatorConnection): void {
    if (this.removed.has(connection.externalItemId)) {
      throw new AggregatorError(
        this.provider,
        'item_not_found',
        'This connection has been removed.',
      );
    }
  }

  private corpus(itemId: string): Corpus {
    const existing = this.corpora.get(itemId);
    if (existing !== undefined) return existing;
    /**
     * The item's hash namespaces every transaction's `externalId`. `transactions.external_id`
     * is unique **globally** — true of a real aggregator, whose ids are minted per institution
     * item — so a fixture that emitted `fixture-txn-netflix-000` for every user meant the
     * second user to connect the fixture bank collided with the first user's rows on insert
     * and imported almost nothing. Found by the e2e connect spec running against a database
     * that already carried the demo user's fixture history.
     *
     * The *content* seed is deliberately NOT derived from the item any more. A fixture only
     * ever mints one item per user, so per-item corpora differentiated nothing except users —
     * and that made the detection outcome (how many candidates /review shows) different for
     * every account, which turns a deterministic corpus into an unassertable one. Same seed,
     * same household, for everyone; the namespace above keeps the rows insertable side by side.
     */
    const built = buildCorpus(this.seed, todayIn(this.clock, 'UTC'), hashToken(itemId));
    this.corpora.set(itemId, built);
    return built;
  }
}

// ── generation ─────────────────────────────────────────────────────────────────────────

/**
 * Builds the whole 24-month history, ordered the way a bank feed arrives: oldest first.
 *
 * Exported because the demo seeder and the sync tests both want the corpus without standing up
 * an adapter, and because a generator you cannot inspect is a generator nobody trusts.
 */
export function buildCorpus(seed: number, today: PlainDate, idNamespace = ''): Corpus {
  const rng = mulberry32(seed);
  const windowStart = addMonths(today, -FIXTURE_WINDOW_MONTHS);

  const generated: AggregatorTransaction[] = [];
  for (const spec of SERIES) generated.push(...emitSeries(rng, spec, windowStart, today));
  generated.push(...emitNoise(rng, windowStart, today));
  const holds = emitHolds(windowStart);
  generated.push(...holds);

  /**
   * Every id gets the item's namespace. `transactions.external_id` is globally unique — a real
   * aggregator's ids are minted per item, never shared across users — and without this a second
   * user connecting the fixture bank collides with the first user's rows and imports nothing.
   */
  const rename = (externalId: string): string =>
    idNamespace === ''
      ? externalId
      : externalId.replace(/^fixture-txn-/u, `fixture-txn-${idNamespace}-`);
  const rows = generated.map((row) => ({ ...row, externalId: rename(row.externalId) }));

  // A bank feed is ordered by posting date; ties break on id so the order is total and stable.
  rows.sort(
    (a, b) => comparePlainDate(a.postedAt, b.postedAt) || a.externalId.localeCompare(b.externalId),
  );

  const events: FixtureEvent[] = rows.map((added) => ({ added, removedExternalId: null }));

  // The holds are retracted at the end of the feed. Aggregators do this constantly — a hotel or
  // fuel pre-authorization that never settles — and a sync that cannot delete leaves phantom
  // charges in someone's totals forever.
  for (const hold of holds) {
    events.push({ added: null, removedExternalId: rename(hold.externalId) });
  }

  return { events };
}

/**
 * Pre-authorizations that never settle, so retraction has something real to delete.
 *
 * Distinct from the re-issue pairs on purpose. A re-issued charge is the same money arriving
 * twice under two ids and must be collapsed; a hold is money that never moved and must be
 * removed. Conflating them would leave one of the two paths untested.
 */
function emitHolds(windowStart: PlainDate): AggregatorTransaction[] {
  const specs = [
    { day: 14, month: 20, descriptor: 'MARRIOTT MARQUIS PREAUTH', minor: 25_000 },
    { day: 9, month: 22, descriptor: 'SHELL OIL PREAUTH 57444108704', minor: 10_000 },
  ] as const;

  return specs.map((spec, index) => {
    const anchor = anchorDate(windowStart, spec.month, spec.day);
    return {
      externalId: `fixture-txn-hold-${String(index + 1).padStart(2, '0')}`,
      accountExternalId: CHECKING,
      postedAt: anchor,
      authorizedAt: anchor,
      amountMinor: toOutflowMinor(spec.minor, 'positive-outflow'),
      currency: 'USD',
      rawDescriptor: spec.descriptor,
      pending: true,
      raw: { series: null, note: 'authorization hold, later retracted' },
    };
  });
}

function emitSeries(
  rng: Rng,
  spec: SeriesSpec,
  windowStart: PlainDate,
  today: PlainDate,
): AggregatorTransaction[] {
  const anchor = anchorDate(windowStart, spec.startMonth, spec.anchorDay);
  const rows: AggregatorTransaction[] = [];

  for (let index = 0; ; index += 1) {
    if (spec.stopAfter !== undefined && index >= spec.stopAfter) break;
    const nominal = occurrence(anchor, spec.interval, index);
    if (isAfter(nominal, today)) break;

    const postedAt = jitter(rng, nominal, spec.interval);
    // Jitter can push the last charge past today; a charge the bank has not posted is not
    // evidence, and emitting it would make the corpus depend on which way the jitter fell.
    if (isAfter(postedAt, today)) break;

    const amountMinor = amountFor(rng, spec.amount, index);
    const descriptor = rng.pick(spec.descriptors);
    const base = `${spec.id}-${String(index).padStart(3, '0')}`;

    const reissue = spec.reissueEvery !== undefined && index > 0 && index % spec.reissueEvery === 0;
    if (reissue) {
      // The same charge, twice, under two ids: first as an unsettled authorization, then as the
      // posted transaction. `external_id` cannot catch this; `dedupe_hash` is the whole reason
      // the column exists.
      //
      // The suffixes are `-auth` and `-post` rather than a bare id and a suffix, so that the
      // authorization sorts *before* its re-issue in the feed. That is the order a bank produces
      // and it is the order that makes the collapse a real decision rather than an accident of
      // string comparison.
      rows.push(
        transaction(`fixture-txn-${base}-auth`, spec, postedAt, amountMinor, descriptor, true),
      );
      rows.push(
        transaction(`fixture-txn-${base}-post`, spec, postedAt, amountMinor, descriptor, false),
      );
      continue;
    }
    rows.push(transaction(`fixture-txn-${base}`, spec, postedAt, amountMinor, descriptor, false));
  }

  return rows;
}

function transaction(
  externalId: string,
  spec: SeriesSpec,
  postedAt: PlainDate,
  amountMinor: number,
  rawDescriptor: string,
  pending: boolean,
): AggregatorTransaction {
  return {
    externalId,
    accountExternalId: spec.accountExternalId,
    postedAt,
    authorizedAt: addDays(postedAt, -1),
    // Stated through the helper rather than written as a positive literal, so that the fixture
    // is testing the same convention the real adapters are held to.
    amountMinor: toOutflowMinor(amountMinor, 'positive-outflow'),
    currency: spec.currency,
    rawDescriptor,
    pending,
    raw: { series: spec.id, note: spec.note },
  };
}

function amountFor(rng: Rng, plan: AmountPlan, index: number): number {
  switch (plan.kind) {
    case 'flat':
      return plan.minor;
    case 'rise':
      return index < plan.atIndex ? plan.minor : plan.toMinor;
    case 'trial':
      return index < plan.trialCount ? plan.trialMinor : plan.minor;
    case 'metered':
      return rng.spend(plan.minMinor, plan.maxMinor);
  }
}

/**
 * Jitter budget, scaled to the period.
 *
 * A weekly charge that slips three days has changed its billing day; an annual one that slips
 * three days hit a weekend. Kept strictly inside the detector's own per-interval tolerance, so
 * the corpus tests whether the engine recognises this cadence rather than whether it tolerates a
 * different one.
 */
function jitter(rng: Rng, nominal: PlainDate, interval: RecurrenceInterval): PlainDate {
  const days = approximateDays(interval);
  const budget = days <= 31 ? 1 : days <= 100 ? 2 : 3;
  const shifted = addDays(nominal, rng.int(-budget, budget));

  // Direct debits and ACH pulls do not settle at the weekend; card charges do. Applied only from
  // four-weekly upwards, because a weekly cadence has no tolerance left to absorb it.
  if (days < 28) return shifted;
  const weekday = dayOfWeek(shifted);
  if (weekday === 6) return addDays(shifted, 2);
  if (weekday === 0) return addDays(shifted, 1);
  return shifted;
}

function anchorDate(windowStart: PlainDate, monthOffset: number, day: number): PlainDate {
  const month = addMonths(windowStart, monthOffset);
  return plainDate(month.year, month.month, Math.min(day, daysInMonth(month.year, month.month)));
}

/**
 * The pile everything else has to be found inside.
 *
 * Roughly a dozen discretionary charges a month per account plus one salary credit — the credit
 * matters because a negative amount is the only thing in the corpus that proves the sign
 * convention survived the round trip.
 */
function emitNoise(rng: Rng, windowStart: PlainDate, today: PlainDate): AggregatorTransaction[] {
  const rows: AggregatorTransaction[] = [];
  let sequence = 0;

  for (let month = 0; month <= FIXTURE_WINDOW_MONTHS; month += 1) {
    const start = addMonths(windowStart, month);
    const limit = daysInMonth(start.year, start.month);

    for (const [accountExternalId, currencyCode, pool] of [
      [CHECKING, 'USD', NOISE_DESCRIPTORS],
      [CARD, 'EUR', NOISE_DESCRIPTORS_EUR],
    ] as const) {
      const count = rng.int(9, 15);
      for (let n = 0; n < count; n += 1) {
        const postedAt = plainDate(start.year, start.month, rng.int(1, limit));
        if (isAfter(postedAt, today)) continue;
        const entry = rng.pick(pool);
        sequence += 1;
        rows.push({
          externalId: `fixture-txn-noise-${String(sequence).padStart(5, '0')}`,
          accountExternalId,
          postedAt,
          authorizedAt: postedAt,
          amountMinor: toOutflowMinor(rng.spend(entry.min, entry.max), 'positive-outflow'),
          currency: currencyCode,
          rawDescriptor: entry.text,
          pending: false,
          raw: { series: null, note: 'noise' },
        });
      }
    }

    const payday = plainDate(start.year, start.month, Math.min(26, limit));
    if (!isAfter(payday, today)) {
      sequence += 1;
      rows.push({
        externalId: `fixture-txn-noise-${String(sequence).padStart(5, '0')}`,
        accountExternalId: CHECKING,
        postedAt: payday,
        authorizedAt: payday,
        // Negative: money arriving. Every downstream stage has to keep this out of the
        // subscription candidates, and it cannot do that if the sign is wrong.
        amountMinor: toOutflowMinor(-INFLOW_MINOR, 'positive-outflow'),
        currency: 'USD',
        rawDescriptor: INFLOW_DESCRIPTOR,
        pending: false,
        raw: { series: null, note: 'inflow' },
      });
    }
  }

  return rows;
}

// ── helpers ────────────────────────────────────────────────────────────────────────────

function parseCursor(cursor: string | null, length: number, provider: string): number {
  if (cursor === null) return 0;
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new AggregatorError(provider, 'upstream', 'Cursor was not issued by this adapter.');
  }
  const offset = Number.parseInt(cursor.slice(CURSOR_PREFIX.length), 10);
  if (!Number.isInteger(offset) || offset < 0 || offset > length) {
    throw new AggregatorError(provider, 'upstream', 'Cursor is out of range.');
  }
  return offset;
}

function fixtureWebhookKind(type: string): WebhookKind {
  switch (type) {
    case 'sync_updates':
    case 'historical_ready':
    case 'reauth_required':
    case 'consent_expiring':
    case 'item_removed':
    case 'error':
      return type;
    default:
      return 'other';
  }
}

/**
 * Runs `produce` on a microtask, so a validation failure comes back as a **rejection** rather
 * than as a synchronous throw out of a `Promise`-returning method.
 *
 * The distinction is not academic. `adapter.syncTransactions(...).catch(handle)` never runs
 * `handle` for a synchronous throw, and the real adapters — which do IO — always reject. A
 * fixture that throws where Plaid rejects is a fixture that lets a broken error path pass CI.
 */
function settled<T>(produce: () => T): Promise<T> {
  return Promise.resolve().then(produce);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashToken(value: string): string {
  return sha256Hex(value).slice(0, 16);
}

function headerValue(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value !== undefined && value !== '') return value;
  }
  return null;
}

function parseJsonObject(text: string, provider: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    void cause;
    throw new AggregatorError(provider, 'invalid_webhook', 'Delivery body is not JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AggregatorError(provider, 'invalid_webhook', 'Delivery body is not a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}
