/**
 * Descriptor normalization (brief §4.2).
 *
 * A bank descriptor is a merchant name buried in noise added by three parties who never agreed
 * on a format: the merchant's payment processor (`SQ *`, `TST*`), the billing intermediary
 * (`APPLE.COM/BILL`, `PAYPAL *`), and the user's own bank (`PURCHASE AUTHORIZED ON 03/14`,
 * `CHKCARD`). Clustering charges by descriptor only works once all three layers are gone.
 *
 * Two rules shape everything below.
 *
 * 1. **Nothing is deleted, only marked.** Every pass records the raw offsets it removed and why.
 *    The review UI (§6.4) renders the original descriptor with the noise dimmed and the merchant
 *    highlighted, which is how a user decides whether to trust a detection — and how we debug a
 *    bad one from a screenshot. Deriving those offsets afterwards, in React, from a string that
 *    has already been rewritten, is not possible; so they are produced here.
 * 2. **The billing channel is extracted, not discarded.** `PAYPAL *SPOTIFY` is Spotify billed
 *    through PayPal: the marker leaves the key but sets `channel`. Getting this wrong means
 *    showing a "cancel on spotify.com" link for a subscription that can only be cancelled in the
 *    App Store, which brief §3.1 calls the most damaging thing this product could do.
 *
 * The pass order is load-bearing and is documented at `normalizeDescriptor`.
 */

import type { BillingChannel } from '@ledger/core';

import type { NormalizedDescriptor, StripReason, StrippedSpan, TextSpan } from './types';

// ── working buffer ─────────────────────────────────────────────────────────────────────

/**
 * The descriptor mid-normalization: `text` is what the remaining passes see, `origin[i]` is the
 * offset in the original string that `text[i]` came from. Removing a run closes the gap in
 * `text` — so `RECURRING PMT PAYPAL *NETFLIX` becomes `RECURRING PMT NETFLIX` and the
 * bank-prefix pass can then see a prefix that was not at the front to begin with — while
 * `origin` keeps every surviving character traceable back to the raw string.
 */
interface Working {
  text: string;
  origin: number[];
  readonly spans: StrippedSpan[];
}

interface Token {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** `String.matchAll` on a fresh regex, so a shared `lastIndex` can never make a pass skip a match. */
function* execAll(text: string, pattern: RegExp): Generator<RegExpExecArray> {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const scanner = new RegExp(pattern.source, flags);
  let match = scanner.exec(text);
  while (match !== null) {
    yield match;
    if ((match[0] ?? '').length === 0) scanner.lastIndex += 1;
    match = scanner.exec(text);
  }
}

/**
 * Uppercases without changing length.
 *
 * `'ß'.toUpperCase()` is `'SS'`, and a single character that becomes two would slide every
 * offset after it — silently, and only for German merchants. Characters that do not map 1:1 are
 * left as they are; they are punctuation to the tokenizer either way.
 */
function uppercaseAligned(raw: string): string {
  let out = '';
  for (const char of raw) {
    const upper = char.toUpperCase();
    out += upper.length === char.length ? upper : char;
  }
  return out;
}

function removeRanges(
  state: Working,
  ranges: readonly (readonly [number, number])[],
  reason: StripReason,
): void {
  if (ranges.length === 0) return;

  const limit = state.text.length;
  const removed = new Uint8Array(limit);
  let any = false;
  for (const [from, to] of ranges) {
    for (let i = Math.max(0, from); i < Math.min(to, limit); i += 1) {
      removed[i] = 1;
      any = true;
    }
  }
  if (!any) return;

  // Record the removal in *raw* coordinates, as maximal runs. A single match can map to two
  // runs when an earlier pass already took a bite out of the middle of it.
  let runStart = -1;
  let previous = -2;
  for (let i = 0; i < limit; i += 1) {
    const at = state.origin[i] ?? -1;
    if (removed[i] === 1) {
      if (runStart < 0) runStart = at;
      else if (at !== previous + 1) {
        state.spans.push({ start: runStart, end: previous + 1, reason });
        runStart = at;
      }
      previous = at;
    } else if (runStart >= 0) {
      state.spans.push({ start: runStart, end: previous + 1, reason });
      runStart = -1;
    }
  }
  if (runStart >= 0) state.spans.push({ start: runStart, end: previous + 1, reason });

  let text = '';
  const origin: number[] = [];
  for (let i = 0; i < limit; i += 1) {
    if (removed[i] === 1) continue;
    text += state.text[i] ?? '';
    origin.push(state.origin[i] ?? 0);
  }
  state.text = text;
  state.origin = origin;
}

function stripPattern(
  state: Working,
  pattern: RegExp,
  reason: StripReason,
  rangeOf?: (match: RegExpExecArray) => readonly [number, number],
): void {
  const ranges: (readonly [number, number])[] = [];
  for (const match of execAll(state.text, pattern)) {
    const range =
      rangeOf?.(match) ?? ([match.index, match.index + (match[0] ?? '').length] as const);
    if (range[1] > range[0]) ranges.push(range);
  }
  removeRanges(state, ranges, reason);
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of execAll(text, /[A-Z0-9]+/g)) {
    const value = match[0] ?? '';
    tokens.push({ value, start: match.index, end: match.index + value.length });
  }
  return tokens;
}

// ── billing channel markers (brief §3.1) ───────────────────────────────────────────────

/**
 * Ordered by channel, and within a channel from most specific to least.
 *
 * Order only breaks ties: the channel is decided by the *leftmost* marker, because the
 * intermediary always prefixes the merchant it is billing on behalf of. `PAYPAL *ITUNES` is a
 * PayPal charge; `APL*SPOTIFY` is an App Store charge.
 */
const CHANNEL_MARKERS: readonly { readonly channel: BillingChannel; readonly pattern: RegExp }[] = [
  { channel: 'apple', pattern: /\bAPPLE\s*\.\s*COM\s*\/\s*BILL\b/g },
  { channel: 'apple', pattern: /\bAPPLE\s+COM\s+BILL\b/g },
  { channel: 'apple', pattern: /\bAPPLE\s*\.\s*COM\b/g },
  { channel: 'apple', pattern: /\bITUNES\s*\.\s*COM(?:\s*\/\s*BILL)?\b/g },
  { channel: 'apple', pattern: /\bITUNES\b/g },
  { channel: 'apple', pattern: /\bAPL\s*\*/g },

  { channel: 'google', pattern: /\bGOOGLE\s*\*/g },
  { channel: 'google', pattern: /\bGOOGLE\s+PLAY\b/g },
  { channel: 'google', pattern: /\bPLAY\s+STORE\b/g },

  { channel: 'amazon', pattern: /\b(?:AMZN|AMAZON)\s+DIGITAL(?:\s+SVCS)?\b/g },
  { channel: 'amazon', pattern: /\bPRIME\s+VIDEO\s+CHANNELS?\b/g },

  { channel: 'microsoft', pattern: /\bMICROSOFT\s*\*/g },
  { channel: 'microsoft', pattern: /\bMSFT\s*\*/g },
  { channel: 'microsoft', pattern: /\bMSBILL\s*\.\s*INFO\b/g },

  { channel: 'steam', pattern: /\bSTEAM(?:GAMES|POWERED)?\s*\.\s*COM\b/g },
  { channel: 'steam', pattern: /\bSTEAM\s+GAMES\b/g },
  { channel: 'steam', pattern: /\bVALVE(?:\s+CORP(?:ORATION)?)?\b/g },

  { channel: 'roku', pattern: /\bROKU(?:\s*\.\s*COM)?(?:\s*\/\s*PAY)?\s*\*?/g },

  { channel: 'carrier', pattern: /\bVZWRLSS\s*\*?/g },
  { channel: 'carrier', pattern: /\bVERIZON\s+WIRELESS\b/g },
  { channel: 'carrier', pattern: /\bATT\s*\*(?:\s*BILL)?/g },
  { channel: 'carrier', pattern: /\bT\s*-?\s*MOBILE\b/g },

  { channel: 'paypal', pattern: /\bPAYPAL(?:\s*\.\s*COM)?\s*\*/g },
  { channel: 'paypal', pattern: /\bPP\s*\*/g },
  { channel: 'paypal', pattern: /\bPAYPAL(?:\s*\.\s*COM)?\b/g },
];

/**
 * The key to use when the descriptor was *entirely* channel marker and noise.
 *
 * `APPLE.COM/BILL 866-712-7753 CA` names no merchant at all — Apple bills every App Store
 * subscription under one descriptor. Falling back to the marker keeps those charges clusterable
 * (and honestly labelled) so the merchant can be recovered later from amount, cadence, and the
 * user's own confirmation. Empty for `direct`, where a descriptor that survived nothing has
 * genuinely told us nothing.
 */
const CHANNEL_FALLBACK_KEY: Readonly<Record<BillingChannel, string>> = {
  direct: '',
  apple: 'APPLE',
  google: 'GOOGLE',
  amazon: 'AMAZON',
  paypal: 'PAYPAL',
  roku: 'ROKU',
  carrier: 'CARRIER',
  microsoft: 'MICROSOFT',
  steam: 'STEAM',
  unknown: '',
};

// ── bank and processor prefixes ────────────────────────────────────────────────────────

/**
 * Stripped from the front, repeatedly: banks stack them (`POS DEBIT SQ *BLUE BOTTLE`) and the
 * channel pass can expose a new one by removing what sat in front of it.
 */
const PROCESSOR_PREFIXES: readonly RegExp[] = [
  /^\s*PURCHASE\s+AUTHORIZED\s+ON(?:\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)?\s*/,
  /^\s*(?:POS\s+DEBIT|POS\s+PURCHASE|DEBIT\s+CARD\s+PURCHASE|CHECKCARD|CHKCARD|VISA\s+DDA\s+PUR(?:CH)?|ACH\s+DEBIT|DIRECT\s+DEBIT|RECURRING\s+P(?:MT|AYMENT)|CARD\s+PAYMENT\s+TO|PAYMENT\s+TO)\b\s*/,
  /^\s*(?:SQ|SP|TST|IC|WL|EIG|PY)\s*\*\s*/,
  /^\s*DD\s+(?=[A-Z])/,
  /**
   * Chase ACH transaction-type words, which sit in front of the merchant rather than being part
   * of it. Found against a real 1,100-transaction export, where they split six merchants in two:
   * `PURCHASE PARAMNTPLUS` and `PARAMNTPLUS` were separate clusters, as were `INST XFER SPOTIFY`
   * and `SPOTIFY`, so one subscription was proposed twice at half its true occurrence count —
   * which also halves its confidence and can push a genuine subscription under the surfacing
   * threshold entirely.
   *
   * Anchored and followed by a letter, so a merchant genuinely named "Purchase Plus" survives.
   */
  /^\s*(?:PURCHASE|INST\s+XFER|POS\s+WITHDRAWAL|ONLINE\s+PMT)\s+(?=[A-Z])/,
];

/**
 * `PENDING` on a card authorisation is a state, not a name.
 *
 * Chase writes `UBER * EATS PENDING SAN FRANCISCO CA` while the charge is unsettled and drops the
 * word once it posts, so the same merchant produced two clusters that never merged.
 */
const AUTHORISATION_STATE = /\b(?:PENDING|TEMPORARY\s+AUTH|AUTH\s+HOLD)\b/g;

// ── noise ──────────────────────────────────────────────────────────────────────────────

/** Billing-help domains that are pure noise — they never carry the merchant name. */
const NOISE_DOMAINS =
  /\b(?:AMZN\s*\.\s*COM(?:\s*\/\s*(?:BILL|PMTS))?|G\s*\.\s*CO\s*\/\s*HELPPAY#?|PLAY\s*\.\s*GOOGLE\s*\.\s*COM|WWW\s*\.)/g;

/**
 * Any other domain keeps its first label and loses everything after it: `NETFLIX.COM` is
 * Netflix, `HULU.COM/BILL` is Hulu, `HELP.UBER.COM` is a support host. Stripping the whole
 * token would throw the merchant name away in exactly the cases where the domain is the only
 * place it appears.
 */
const DOMAIN =
  /\b([A-Z0-9][A-Z0-9-]*)((?:\.[A-Z0-9-]+)*(?:\.(?:COM|NET|ORG|IO|TV|CO|UK|DE|FR|NL|ES|IT|SE|DK|NO|FI|IE|EU|US|CA|AI|APP|INFO|BIZ|ME|LY|XYZ))+)(\/\S*)?/g;

const DATE_PATTERNS: readonly RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  /\b\d{1,2}[-.]\d{1,2}[-.]\d{4}\b/g,
];

const PHONE_PATTERNS: readonly RegExp[] = [
  /\+\d{1,3}(?:[\s.-]?\d){7,13}\b/g,
  /\b\(\d{3}\)\s*\d{3}[\s.-]?\d{4}\b/g,
  /\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/g,
  /\b\d{3}[\s.-]\d{7}\b/g,
  // UK/EU: a leading zero and 10–11 digits, grouped any way the bank felt like.
  /\b0\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g,
];

const REFERENCE_PATTERNS: readonly RegExp[] = [
  // An asterisk-prefixed run is an order id only if it contains a digit. `ADOBE *CREATIVE CLOUD`
  // and `PATREON* MEMBERSHIP` put the merchant right after the asterisk.
  /\*(?=[A-Z0-9]*\d)[A-Z0-9]{4,}\b/g,
  /\bGPA\s*\.\s*[A-Z0-9-]+/g,
  /\bORDER(?:\s*#\s*|\s+)[A-Z0-9][A-Z0-9-]{4,}/g,
  /\bREF(?:ERENCE)?(?:\s*[:#.]\s*|\s+)[A-Z0-9]{4,}\b/g,
  /\bINV(?:OICE)?(?:\s*[:#]\s*|\s+)[A-Z0-9]{4,}\b/g,
  /\bID(?:\s*[:#]\s*|\s+)[A-Z0-9]{6,}\b/g,
  /\bSTORE\s*#?\s*\d+\b/g,
  /\bCARD\s*#?\s*\d{4}\b/g,
  /\bTRACE\s*#?\s*\d+\b/g,
  /#\s*[A-Z0-9]+\b/g,
];

const LONG_DIGIT_RUN = /\b\d{6,}\b/g;

const OPAQUE_MIN_LENGTH = 8;
const OPAQUE_MIN_DIGIT_RATIO = 0.4;

/**
 * A long token that is mostly digits but not entirely: `E0800XYZ12`, `P16C7F5AB4`, `F1234567`.
 *
 * The digit ratio is the whole rule, and it is what keeps `MICROSOFT365` (3 digits of 12) and
 * `1PASSWORD` out of it. A product name carries a digit or two; a reference number is made of
 * them.
 */
function isOpaqueReference(value: string): boolean {
  if (value.length < OPAQUE_MIN_LENGTH) return false;
  let digits = 0;
  for (const char of value) if (char >= '0' && char <= '9') digits += 1;
  if (digits === 0 || digits === value.length) return false;
  return digits / value.length >= OPAQUE_MIN_DIGIT_RATIO;
}

function stripOpaqueReferences(state: Working): void {
  const ranges = tokenize(state.text)
    .filter((token) => isOpaqueReference(token.value))
    .map((token) => [token.start, token.end] as const);
  removeRanges(state, ranges, 'reference');
}

// ── trailing junk ──────────────────────────────────────────────────────────────────────

const US_STATES = new Set(
  (
    'AL AK AZ AR CA CO CT DC DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH ' +
    'NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA VI WA WV WI WY'
  ).split(' '),
);

/**
 * Canadian province codes, kept apart from `US_STATES` only so that set's name stays true.
 *
 * Stripped by the same trailing rule. Real acquirers append them — `1PASSWORD.COM ON`,
 * `SHOPIFY OTTAWA ON` — and one left in the key is not a cosmetic blemish: it splits a
 * subscription's charges into two clusters that never merge, so the user sees two half-length
 * series instead of one. The territories are omitted; `YT` and `NU` are rare enough in
 * descriptors that the risk of eating a real trailing token outweighs the benefit.
 */
const CA_PROVINCES = new Set('ON QC BC AB MB SK NS NB PE NL'.split(' '));

/**
 * Country markers, not a full ISO list. Two-letter codes that collide with US states (`DE`, `CA`)
 * are stripped either way, so the ambiguity is harmless; `AT` is deliberately absent because
 * `AT&T` tokenizes to `AT` `T`.
 */
const COUNTRIES = new Set(
  (
    'UK GB GBR USA US CAN IE IRL DE DEU FR FRA NL NLD ES ESP IT ITA SE SWE DK DNK NO NOR FI FIN ' +
    'PL POL PT PRT BE BEL CH CHE CZ AU AUS NZ JP JPN SG MX BR LU'
  ).split(' '),
);

const CORPORATE_SUFFIXES = new Set(
  (
    'LTD LIMITED LLC LLP INC INCORPORATED CORP CORPORATION CO GMBH BV NV PLC AB SARL SA SAS PTY ' +
    'OY APS SRL SPA AG KG'
  ).split(' '),
);

/**
 * Words that describe the *transaction* rather than the merchant. Only stripped from the tail,
 * where they are decoration — `BILL.COM` and `PAYPAL` are merchants, and the first token is
 * never removed by this rule while anything else remains.
 */
const FILLER_WORDS = new Set(
  (
    'BILL BILLING PAYMENT PAYMENTS PMT PMNT PAY AUTOPAY RECURRING SUBSCRIPTION SUBSCR SUBS ' +
    'MEMBERSHIP MONTHLY ANNUAL RENEWAL PURCHASE ONLINE WEB POSTPAID PREPAID SVC SVCS DEBIT ' +
    'CREDIT TRANSACTION STORE ORDER HELP'
  ).split(' '),
);

/**
 * A gazetteer, not a heuristic.
 *
 * The obvious rule — "delete the word or two before a trailing state code" — eats `PLANET` out of
 * `PLANET FITNESS MA`. There is no way to tell a city from a merchant name without a list, so
 * this is a list. Cities that are not on it survive into the key, which is harmless: the key
 * only has to be *stable* per merchant, not pretty.
 */
const CITIES = new Set([
  'LOS GATOS',
  'SAN FRANCISCO',
  'SAN JOSE',
  'SAN DIEGO',
  'SANTA CLARA',
  'SANTA MONICA',
  'MOUNTAIN VIEW',
  'MENLO PARK',
  'PALO ALTO',
  'SUNNYVALE',
  'CUPERTINO',
  'OAKLAND',
  'BERKELEY',
  'FREMONT',
  'SACRAMENTO',
  'LOS ANGELES',
  'LONG BEACH',
  'BURBANK',
  'GLENDALE',
  'PASADENA',
  'ANAHEIM',
  'IRVINE',
  'NEW YORK',
  'BROOKLYN',
  'QUEENS',
  'NEWARK',
  'JERSEY CITY',
  'PHILADELPHIA',
  'PITTSBURGH',
  'BOSTON',
  'CAMBRIDGE',
  'CHICAGO',
  'DETROIT',
  'MILWAUKEE',
  'MINNEAPOLIS',
  'KANSAS CITY',
  'ST LOUIS',
  'NASHVILLE',
  'CHARLOTTE',
  'RALEIGH',
  'ATLANTA',
  'ORLANDO',
  'MIAMI',
  'TAMPA',
  'HOUSTON',
  'DALLAS',
  'AUSTIN',
  'DENVER',
  'SALT LAKE CITY',
  'LAS VEGAS',
  'PHOENIX',
  'TUCSON',
  'ALBUQUERQUE',
  'PORTLAND',
  'SEATTLE',
  'BELLEVUE',
  'REDMOND',
  'BOISE',
  'OMAHA',
  'COLUMBUS',
  'CLEVELAND',
  'CINCINNATI',
  'INDIANAPOLIS',
  'SAN ANTONIO',
  'BALTIMORE',
  'RICHMOND',
  'MEMPHIS',
  'LOUISVILLE',
  'LONDON',
  'MANCHESTER',
  'LEEDS',
  'GLASGOW',
  'EDINBURGH',
  'BRISTOL',
  'CARDIFF',
  'BELFAST',
  'DUBLIN',
  'AMSTERDAM',
  'ROTTERDAM',
  'BERLIN',
  'MUNICH',
  'HAMBURG',
  'PARIS',
  'MADRID',
  'BARCELONA',
  'LISBON',
  'MILAN',
  'ROME',
  'STOCKHOLM',
  'COPENHAGEN',
  'HELSINKI',
  'OSLO',
  'ZURICH',
  'VIENNA',
  'WARSAW',
  'PRAGUE',
  'LUXEMBOURG',
  'TORONTO',
  'VANCOUVER',
  'SYDNEY',
  'MELBOURNE',
]);

const MAX_CITY_TOKENS = 3;

function classifyTrailingToken(value: string): StripReason | null {
  if (
    CITIES.has(value) ||
    US_STATES.has(value) ||
    CA_PROVINCES.has(value) ||
    COUNTRIES.has(value)
  ) {
    return 'location';
  }
  if (CORPORATE_SUFFIXES.has(value) || FILLER_WORDS.has(value)) return 'filler';
  if (/^[A-Z]$/.test(value)) return 'filler';
  // Four or more trailing digits is a store or terminal number. Three is `MICROSOFT 365`.
  if (/^\d{4,}$/.test(value)) return 'reference';
  return null;
}

/** Removes one trailing junk token (or one multi-word city). Returns false when the tail is clean. */
function stripOneTrailingToken(state: Working): boolean {
  const tokens = tokenize(state.text);
  if (tokens.length === 0) return false;

  for (let take = Math.min(MAX_CITY_TOKENS, tokens.length); take >= 1; take -= 1) {
    const slice = tokens.slice(tokens.length - take);
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (first === undefined || last === undefined) continue;

    const phrase = slice.map((token) => token.value).join(' ');
    const reason =
      take === 1 ? classifyTrailingToken(phrase) : CITIES.has(phrase) ? 'location' : null;
    if (reason === null) continue;

    // Take the whitespace in front of the token too, so the decoder dims a contiguous run
    // rather than leaving an orphaned space highlighted.
    let start = first.start;
    while (start > 0 && /\s/.test(state.text[start - 1] ?? '')) start -= 1;
    removeRanges(state, [[start, last.end]], reason);
    return true;
  }
  return false;
}

/**
 * Collapses an immediately repeated token: `NYTIMES*NYTIMES` is one merchant, not two.
 *
 * Processors that prefix their own customer name produce this constantly. The cost is that a
 * genuinely doubled name (`PIZZA PIZZA`) loses a word — acceptable, because the key only has to
 * be stable, and that shape does not occur among subscriptions.
 */
function dropRepeatedTokens(tokens: readonly Token[]): Token[] {
  return tokens.filter((token, index) => token.value !== tokens[index - 1]?.value);
}

/**
 * The foreign-transaction tail Chase appends to a cross-border card charge:
 *
 *   AMAZON.CA PRIME MEMB AMAZON.CA/PRI BC   10/29 CA DOLLAR  11.29 X 0.731000 (EXCHG RTE)
 *
 * The amount and the rate are different on every single charge, so a descriptor that keeps them
 * gives one merchant a new normalized key every month — and a genuinely recurring foreign
 * subscription can never cluster. Found in real Chase data: an Amazon.ca Prime membership
 * produced two unrelated keys for two consecutive charges.
 */
const FX_TAIL =
  /\s+\d{1,2}\/\d{1,2}\s+[A-Z][A-Z .]{2,20}?\s+[\d,]+\.\d{2}\s*X\s*[\d.]+\s*\(EXCHG\s*RTE\)/g;

/**
 * Chase's ACH envelope. A PayPal pull, a payroll credit and a direct debit all arrive as:
 *
 *   ORIG CO NAME:PAYPAL   CO ENTRY DESCR:PURCHASE SEC:WEB IND ID:STEAM GAMES  ORIG ID:PAYPALSI77
 *
 * The merchant is `STEAM GAMES`, in `IND ID` — the *individual* identifier, which for a payment
 * processor is who the money actually went to. `ORIG CO NAME` is the processor, not the payee.
 *
 * Without this pass the label words survive and the merchant does not: every such charge
 * normalized to `ORIG CO NAME CO ENTRY DESCR PURCHASE SEC WEB IND ID ORIG`, so Steam, Roblox and
 * Google all collapsed into one meaningless cluster — losing every real subscription among them
 * and inventing a fake high-frequency one. This was the single worst defect in the engine and it
 * only surfaced against a real bank export.
 *
 * `IND ID` wins when it carries letters. When it is purely numeric it is a customer reference
 * rather than a name, and `ORIG CO NAME` is the best merchant available.
 */
function unwrapAchEnvelope(state: Working): void {
  if (!/\bORIG CO NAME:|\bCO ENTRY DESCR:/.test(state.text)) return;

  const individual = /\bIND ID:\s*([A-Z][A-Z0-9 &.'-]{1,28}?)\s{2,}|\bIND ID:\s*([A-Z][A-Z0-9 &.'-]{1,28})$/.exec(
    state.text,
  );
  const company = /\bORIG CO NAME:\s*([A-Z][A-Z0-9 &.'-]{1,28}?)\s{2,}/.exec(state.text);

  const candidate = (individual?.[1] ?? individual?.[2] ?? '').trim();
  const merchant = /[A-Z]/.test(candidate) ? candidate : (company?.[1] ?? '').trim();
  if (merchant === '') return;

  // Rewritten wholesale rather than stripped piecewise: the envelope is structure, not noise,
  // and the offsets that matter for the descriptor decoder are the merchant's own.
  const start = state.text.indexOf(merchant);
  const origin = start >= 0 ? state.origin.slice(start, start + merchant.length) : state.origin.slice(0, merchant.length);

  state.spans.push({ start: 0, end: state.origin.length, reason: 'processor' });
  state.text = merchant;
  state.origin = origin.length === merchant.length ? origin : Array.from({ length: merchant.length }, (_, i) => i);
}

// ── the pipeline ───────────────────────────────────────────────────────────────────────

/**
 * Normalizes one bank descriptor.
 *
 * Passes run in this order for reasons that are not interchangeable:
 *
 * 1. **Channel markers**, first, because they are the only pass that reads meaning rather than
 *    removing noise, and because a marker like `PAYPAL.COM` has to be consumed whole before the
 *    domain pass splits it into `PAYPAL` + `.COM`.
 * 2. **Bank/processor prefixes**, looped, now that the channel pass may have exposed one.
 * 3. **Domains**, before phone numbers, so a path like `/BILL` cannot be mistaken for anything.
 * 4. **Dates**, before phones, because `03/14/2024` and a phone number share digit shapes.
 * 5. **References, then opaque tokens, then long digit runs** — the specific patterns first, the
 *    ratio heuristic next, the blunt one last, so a token only reaches the blunt rule if nothing
 *    more precise claimed it.
 * 6. **Trailing junk**, last, looped: cities, states, corporate suffixes and filler words only
 *    read as junk once everything to the right of them has already gone.
 */
export function normalizeDescriptor(raw: string): NormalizedDescriptor {
  const upper = uppercaseAligned(raw);
  const state: Working = {
    text: upper,
    origin: Array.from({ length: upper.length }, (_, index) => index),
    spans: [],
  };

  // Before anything else: an ACH envelope hides the merchant inside a labelled field, and every
  // later pass would strip the label and keep the boilerplate. Real Chase data, real failure.
  unwrapAchEnvelope(state);

  // The foreign-transaction tail carries the amount and the FX rate, which differ on every
  // charge — leaving it in gives the same merchant a different key each month.
  stripPattern(state, FX_TAIL, 'reference');

  const { channel, markerSpan } = stripChannelMarkers(state);

  for (let guard = 0; guard < 8; guard += 1) {
    const prefix = PROCESSOR_PREFIXES.find((pattern) => pattern.test(state.text));
    if (prefix === undefined) break;
    stripPattern(state, prefix, 'processor');
  }

  stripPattern(state, AUTHORISATION_STATE, 'filler');
  stripPattern(state, NOISE_DOMAINS, 'url');
  stripPattern(state, DOMAIN, 'url', (match) => [
    match.index + (match[1] ?? '').length,
    match.index + (match[0] ?? '').length,
  ]);
  for (const pattern of DATE_PATTERNS) stripPattern(state, pattern, 'date');
  for (const pattern of PHONE_PATTERNS) stripPattern(state, pattern, 'phone');
  for (const pattern of REFERENCE_PATTERNS) stripPattern(state, pattern, 'reference');
  stripOpaqueReferences(state);
  stripPattern(state, LONG_DIGIT_RUN, 'digits');

  for (let guard = 0; guard < 24; guard += 1) {
    if (!stripOneTrailingToken(state)) break;
  }

  const tokens = dropRepeatedTokens(tokenize(state.text));
  const spans = [...state.spans].sort((a, b) => a.start - b.start || a.end - b.end);

  if (tokens.length === 0) {
    const fallback = CHANNEL_FALLBACK_KEY[channel];
    return {
      raw,
      normalized: fallback,
      channel,
      tokens: fallback === '' ? [] : [fallback],
      tokenSpans: fallback === '' || markerSpan === null ? [] : [markerSpan],
      strippedSpans: spans,
    };
  }

  return {
    raw,
    normalized: tokens.map((token) => token.value).join(' '),
    channel,
    tokens: tokens.map((token) => token.value),
    tokenSpans: tokens.map((token) => ({
      start: state.origin[token.start] ?? 0,
      end: (state.origin[token.end - 1] ?? 0) + 1,
    })),
    strippedSpans: spans,
  };
}

function stripChannelMarkers(state: Working): {
  channel: BillingChannel;
  markerSpan: TextSpan | null;
} {
  const ranges: (readonly [number, number])[] = [];
  let channel: BillingChannel = 'direct';
  let leftmost = Number.POSITIVE_INFINITY;
  let markerSpan: TextSpan | null = null;

  for (const marker of CHANNEL_MARKERS) {
    for (const match of execAll(state.text, marker.pattern)) {
      const length = (match[0] ?? '').length;
      if (length === 0) continue;
      ranges.push([match.index, match.index + length]);
      if (match.index < leftmost) {
        leftmost = match.index;
        channel = marker.channel;
        // Offsets are still 1:1 with `raw` here — the channel pass runs before anything else.
        markerSpan = { start: match.index, end: match.index + length };
      }
    }
  }

  removeRanges(state, ranges, 'channel');
  return { channel, markerSpan };
}

/** The clustering key alone, for callers that do not need the decoder spans. */
export function normalizedKeyOf(raw: string): string {
  return normalizeDescriptor(raw).normalized;
}

// ── fuzzy comparison ───────────────────────────────────────────────────────────────────

function trigrams(value: string): Set<string> {
  const text = value.trim().toUpperCase();
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= text.length; i += 1) grams.add(text.slice(i, i + 3));
  return grams;
}

/**
 * Jaccard similarity over 3-grams: `|A ∩ B| / |A ∪ B|`.
 *
 * Unlike Postgres `pg_trgm` this does not pad word boundaries, because both sides are already
 * normalized keys rather than free text. The threshold the matcher uses (0.82) is high on
 * purpose: at this scale it catches spelling variants of the same name and little else, and a
 * false merchant match is worse than no match — it attaches the wrong cancellation playbook.
 */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}
