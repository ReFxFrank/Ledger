/**
 * The descriptor corpus.
 *
 * This file is the specification for `normalizeDescriptor`, and it was written before the
 * normalizer was finished rather than after (PLAN.md, Phase 4: "fixtures first ... they are the
 * spec"). Every entry is a real-shaped bank descriptor: the noise patterns, the truncations, and
 * the inconsistent spacing are all things a card network actually emits.
 *
 * `expectedNormalized` is the clustering key. Two charges from the same subscription must produce
 * the same one, and two charges from different merchants must not — that is the whole contract,
 * and everything downstream (cadence, confidence, duplicate detection) is built on it holding.
 *
 * Where the expectation is lossy or surprising, the entry carries a `note` saying so. Those are
 * the interesting rows: they record a decision, not an accident.
 */

import type { BillingChannel } from '@ledger/core';

export interface DescriptorFixture {
  readonly raw: string;
  /** Empty means "nothing identifying survived" — the caller is expected to discard it. */
  readonly expectedNormalized: string;
  readonly expectedChannel: BillingChannel;
  readonly note?: string;
}

export const DESCRIPTOR_FIXTURES: readonly DescriptorFixture[] = [
  // ── Plain merchant names — billed directly, no intermediary ───────────────────────────────
  // The easy majority. The only work here is dropping the domain suffix, the support phone
  // number, and the city/state the acquirer appended.
  {
    raw: 'NETFLIX.COM',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'Netflix.com Los Gatos CA',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'NETFLIX 866-579-7172 CA',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'SPOTIFY USA',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'SPOTIFY USA 877-778-1161 NY',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'HULU 877-8244858 CA',
    expectedNormalized: 'HULU',
    expectedChannel: 'direct',
  },
  {
    raw: 'HULUPLUS 877-824-4858 CA',
    expectedNormalized: 'HULUPLUS',
    expectedChannel: 'direct',
    note: 'Legacy descriptor; clusters separately from HULU by design.',
  },
  {
    raw: 'DISNEY PLUS 888-905-7888 CA',
    expectedNormalized: 'DISNEY PLUS',
    expectedChannel: 'direct',
  },
  {
    raw: 'DISNEYPLUS.COM',
    expectedNormalized: 'DISNEYPLUS',
    expectedChannel: 'direct',
  },
  {
    raw: 'HBO MAX 877-950-2266',
    expectedNormalized: 'HBO MAX',
    expectedChannel: 'direct',
  },
  {
    raw: 'MAX.COM',
    expectedNormalized: 'MAX',
    expectedChannel: 'direct',
  },
  {
    raw: 'PARAMOUNT+ 888-274-5343',
    expectedNormalized: 'PARAMOUNT',
    expectedChannel: 'direct',
    note: 'The plus sign is punctuation, not part of the key.',
  },
  {
    raw: 'PEACOCK PREMIUM 800-756-9102',
    expectedNormalized: 'PEACOCK PREMIUM',
    expectedChannel: 'direct',
  },
  {
    raw: 'APPLE TV+',
    expectedNormalized: 'APPLE TV',
    expectedChannel: 'direct',
    note: 'No APPLE.COM/BILL marker, so this is a direct charge, not App Store billing.',
  },
  {
    raw: 'YOUTUBEPREMIUM',
    expectedNormalized: 'YOUTUBEPREMIUM',
    expectedChannel: 'direct',
  },
  {
    raw: 'YouTube Premium',
    expectedNormalized: 'YOUTUBE PREMIUM',
    expectedChannel: 'direct',
  },
  {
    raw: 'AUDIBLE.COM 888-283-5051 NJ',
    expectedNormalized: 'AUDIBLE',
    expectedChannel: 'direct',
  },
  {
    raw: 'AUDIBLE US',
    expectedNormalized: 'AUDIBLE',
    expectedChannel: 'direct',
  },
  {
    raw: 'SLING TV 888-291-0217',
    expectedNormalized: 'SLING TV',
    expectedChannel: 'direct',
  },
  {
    raw: 'CRUNCHYROLL 855-347-3427',
    expectedNormalized: 'CRUNCHYROLL',
    expectedChannel: 'direct',
  },
  {
    raw: 'FUBOTV',
    expectedNormalized: 'FUBOTV',
    expectedChannel: 'direct',
  },
  {
    raw: 'SIRIUSXM 888-635-5144',
    expectedNormalized: 'SIRIUSXM',
    expectedChannel: 'direct',
  },
  {
    raw: 'PANDORA *MEDIA',
    expectedNormalized: 'PANDORA MEDIA',
    expectedChannel: 'direct',
  },
  {
    raw: 'TIDAL.COM',
    expectedNormalized: 'TIDAL',
    expectedChannel: 'direct',
  },
  {
    raw: 'DEEZER PARIS FR',
    expectedNormalized: 'DEEZER',
    expectedChannel: 'direct',
  },
  {
    raw: 'STARZ ENTERTAINMENT 888-482-7987',
    expectedNormalized: 'STARZ ENTERTAINMENT',
    expectedChannel: 'direct',
  },
  {
    raw: 'SHOWTIME NETWORKS 855-807-1517',
    expectedNormalized: 'SHOWTIME NETWORKS',
    expectedChannel: 'direct',
  },
  {
    raw: 'AMC NETWORKS 888-262-8600',
    expectedNormalized: 'AMC NETWORKS',
    expectedChannel: 'direct',
  },
  {
    raw: 'BRITBOX 888-274-8687',
    expectedNormalized: 'BRITBOX',
    expectedChannel: 'direct',
  },
  {
    raw: 'ACORN TV',
    expectedNormalized: 'ACORN TV',
    expectedChannel: 'direct',
  },
  {
    raw: 'CURIOSITYSTREAM.COM',
    expectedNormalized: 'CURIOSITYSTREAM',
    expectedChannel: 'direct',
  },
  {
    raw: 'MUBI.COM',
    expectedNormalized: 'MUBI',
    expectedChannel: 'direct',
  },
  {
    raw: 'VIMEO.COM 917-338-0759',
    expectedNormalized: 'VIMEO',
    expectedChannel: 'direct',
  },
  {
    raw: 'DROPBOX*RENEWAL',
    expectedNormalized: 'DROPBOX',
    expectedChannel: 'direct',
  },
  {
    raw: 'ADOBE *CREATIVE CLOUD',
    expectedNormalized: 'ADOBE CREATIVE CLOUD',
    expectedChannel: 'direct',
    note: 'The asterisk run has no digit, so it is a product name and not an order id.',
  },
  {
    raw: 'ADOBE CREATIVE CLOUD',
    expectedNormalized: 'ADOBE CREATIVE CLOUD',
    expectedChannel: 'direct',
  },
  {
    raw: 'ADOBE ACROPRO SUBSCR',
    expectedNormalized: 'ADOBE ACROPRO',
    expectedChannel: 'direct',
  },
  {
    raw: 'NYTimes*NYTimes 800-698-4637 NY',
    expectedNormalized: 'NYTIMES',
    expectedChannel: 'direct',
    note: 'Processor repeats the merchant; the repeat collapses.',
  },
  {
    raw: 'NYT DIGITAL 800-698-4637 NY',
    expectedNormalized: 'NYT DIGITAL',
    expectedChannel: 'direct',
  },
  {
    raw: 'NORDVPN.COM',
    expectedNormalized: 'NORDVPN',
    expectedChannel: 'direct',
  },
  {
    raw: 'EXPRESSVPN.COM',
    expectedNormalized: 'EXPRESSVPN',
    expectedChannel: 'direct',
  },
  {
    raw: '1PASSWORD.COM',
    expectedNormalized: '1PASSWORD',
    expectedChannel: 'direct',
    note: 'Label starting with a digit is still a domain label.',
  },
  {
    raw: 'LASTPASS.COM',
    expectedNormalized: 'LASTPASS',
    expectedChannel: 'direct',
  },
  {
    raw: 'NOTION LABS INC',
    expectedNormalized: 'NOTION LABS',
    expectedChannel: 'direct',
  },
  {
    raw: 'FIGMA MONTHLY',
    expectedNormalized: 'FIGMA',
    expectedChannel: 'direct',
  },
  {
    raw: 'GITHUB.COM',
    expectedNormalized: 'GITHUB',
    expectedChannel: 'direct',
  },
  {
    raw: 'OPENAI *CHATGPT SUBSCR',
    expectedNormalized: 'OPENAI CHATGPT',
    expectedChannel: 'direct',
  },
  {
    raw: 'ANTHROPIC CLAUDE.AI',
    expectedNormalized: 'ANTHROPIC CLAUDE',
    expectedChannel: 'direct',
  },
  {
    raw: 'CLOUDFLARE',
    expectedNormalized: 'CLOUDFLARE',
    expectedChannel: 'direct',
  },
  {
    raw: 'LINKEDIN PREMIUM',
    expectedNormalized: 'LINKEDIN PREMIUM',
    expectedChannel: 'direct',
  },
  {
    raw: 'PELOTON MEMBERSHIP',
    expectedNormalized: 'PELOTON',
    expectedChannel: 'direct',
  },
  {
    raw: 'STRAVA.COM',
    expectedNormalized: 'STRAVA',
    expectedChannel: 'direct',
  },
  {
    raw: 'NINTENDO CO LTD',
    expectedNormalized: 'NINTENDO',
    expectedChannel: 'direct',
  },
  {
    raw: 'PLAYSTATION NETWORK',
    expectedNormalized: 'PLAYSTATION NETWORK',
    expectedChannel: 'direct',
  },
  {
    raw: 'XBOX GAME PASS ULTIMATE',
    expectedNormalized: 'XBOX GAME PASS ULTIMATE',
    expectedChannel: 'direct',
    note: 'Billed on the card directly — contrast with the MICROSOFT* form below.',
  },
  {
    raw: 'WSJ/BARRONS SUBSCRIPTION 800-568-7625',
    expectedNormalized: 'WSJ BARRONS',
    expectedChannel: 'direct',
  },
  {
    raw: 'THE ECONOMIST SUBSCRIPTION',
    expectedNormalized: 'THE ECONOMIST',
    expectedChannel: 'direct',
  },
  {
    raw: 'MEDIUM MONTHLY',
    expectedNormalized: 'MEDIUM',
    expectedChannel: 'direct',
  },
  {
    raw: 'SUBSTACK*THE DIFF',
    expectedNormalized: 'SUBSTACK THE DIFF',
    expectedChannel: 'direct',
  },
  {
    raw: 'PATREON* MEMBERSHIP',
    expectedNormalized: 'PATREON',
    expectedChannel: 'direct',
  },
  {
    raw: 'TWITCHINTERACTIVE',
    expectedNormalized: 'TWITCHINTERACTIVE',
    expectedChannel: 'direct',
  },
  {
    raw: 'DISCORD NITRO',
    expectedNormalized: 'DISCORD NITRO',
    expectedChannel: 'direct',
  },
  {
    raw: 'HELLOFRESH 646-846-3663 NY',
    expectedNormalized: 'HELLOFRESH',
    expectedChannel: 'direct',
  },
  {
    raw: 'BLUE APRON 347-467-3080 NY',
    expectedNormalized: 'BLUE APRON',
    expectedChannel: 'direct',
  },
  {
    raw: 'CHEWY.COM 800-672-4399 FL',
    expectedNormalized: 'CHEWY',
    expectedChannel: 'direct',
  },
  {
    raw: 'BARKBOX 855-501-2275 NY',
    expectedNormalized: 'BARKBOX',
    expectedChannel: 'direct',
  },
  {
    raw: 'DOLLAR SHAVE CLUB',
    expectedNormalized: 'DOLLAR SHAVE CLUB',
    expectedChannel: 'direct',
  },
  {
    raw: 'HARRYS.COM',
    expectedNormalized: 'HARRYS',
    expectedChannel: 'direct',
  },
  {
    raw: 'RITUAL VITAMINS',
    expectedNormalized: 'RITUAL VITAMINS',
    expectedChannel: 'direct',
  },
  {
    raw: 'CALM.COM',
    expectedNormalized: 'CALM',
    expectedChannel: 'direct',
  },
  {
    raw: 'HEADSPACE.COM',
    expectedNormalized: 'HEADSPACE',
    expectedChannel: 'direct',
  },
  {
    raw: 'NOOM* WEIGHT LOSS',
    expectedNormalized: 'NOOM WEIGHT LOSS',
    expectedChannel: 'direct',
  },
  {
    raw: 'MYFITNESSPAL',
    expectedNormalized: 'MYFITNESSPAL',
    expectedChannel: 'direct',
  },
  {
    raw: 'CLASSPASS 917-410-6773 NY',
    expectedNormalized: 'CLASSPASS',
    expectedChannel: 'direct',
  },
  {
    raw: 'EQUINOX 212-774-6363 NY',
    expectedNormalized: 'EQUINOX',
    expectedChannel: 'direct',
  },
  {
    raw: 'PLANET FITNESS BOSTON MA',
    expectedNormalized: 'PLANET FITNESS',
    expectedChannel: 'direct',
  },
  {
    raw: '24 HOUR FITNESS 800-224-0240',
    expectedNormalized: '24 HOUR FITNESS',
    expectedChannel: 'direct',
    note: 'A leading number is part of the name, not a reference.',
  },
  {
    raw: 'LA FITNESS 949-255-7200 CA',
    expectedNormalized: 'LA FITNESS',
    expectedChannel: 'direct',
  },
  {
    raw: 'WEIGHTWATCHERS.COM',
    expectedNormalized: 'WEIGHTWATCHERS',
    expectedChannel: 'direct',
  },
  {
    raw: 'DUOLINGO 412-567-6602 PA',
    expectedNormalized: 'DUOLINGO',
    expectedChannel: 'direct',
  },
  {
    raw: 'BABBEL.COM',
    expectedNormalized: 'BABBEL',
    expectedChannel: 'direct',
  },
  {
    raw: 'MASTERCLASS.COM',
    expectedNormalized: 'MASTERCLASS',
    expectedChannel: 'direct',
  },
  {
    raw: 'COURSERA.ORG',
    expectedNormalized: 'COURSERA',
    expectedChannel: 'direct',
  },
  {
    raw: 'UDEMY 866-283-3583 CA',
    expectedNormalized: 'UDEMY',
    expectedChannel: 'direct',
  },
  {
    raw: 'SKILLSHARE.COM',
    expectedNormalized: 'SKILLSHARE',
    expectedChannel: 'direct',
  },
  {
    raw: 'GRAMMARLY 888-580-8000 CA',
    expectedNormalized: 'GRAMMARLY',
    expectedChannel: 'direct',
  },
  {
    raw: 'EVERNOTE 855-345-3729 CA',
    expectedNormalized: 'EVERNOTE',
    expectedChannel: 'direct',
  },
  {
    raw: 'TODOIST DOIST INC',
    expectedNormalized: 'TODOIST DOIST',
    expectedChannel: 'direct',
  },
  {
    raw: 'ZOOM.US 888-799-9666 CA',
    expectedNormalized: 'ZOOM',
    expectedChannel: 'direct',
  },
  {
    raw: 'SLACK T1234ABCD',
    expectedNormalized: 'SLACK',
    expectedChannel: 'direct',
    note: 'Workspace id: long, mostly digits, opaque.',
  },
  {
    raw: 'ATLASSIAN 415-701-1110 CA',
    expectedNormalized: 'ATLASSIAN',
    expectedChannel: 'direct',
  },
  {
    raw: 'MAILCHIMP 678-999-0141 GA',
    expectedNormalized: 'MAILCHIMP',
    expectedChannel: 'direct',
  },
  {
    raw: 'SQUARESPACE 646-580-3456 NY',
    expectedNormalized: 'SQUARESPACE',
    expectedChannel: 'direct',
  },
  {
    raw: 'WIX.COM 415-639-9034',
    expectedNormalized: 'WIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'WORDPRESS.COM',
    expectedNormalized: 'WORDPRESS',
    expectedChannel: 'direct',
  },
  {
    raw: 'GODADDY.COM 480-505-8855 AZ',
    expectedNormalized: 'GODADDY',
    expectedChannel: 'direct',
  },
  {
    raw: 'NAMECHEAP.COM',
    expectedNormalized: 'NAMECHEAP',
    expectedChannel: 'direct',
  },
  {
    raw: 'LINODE.COM',
    expectedNormalized: 'LINODE',
    expectedChannel: 'direct',
  },
  {
    raw: 'DIGITALOCEAN.COM 855-278-3236',
    expectedNormalized: 'DIGITALOCEAN',
    expectedChannel: 'direct',
  },
  {
    raw: 'BACKBLAZE.COM',
    expectedNormalized: 'BACKBLAZE',
    expectedChannel: 'direct',
  },
  {
    raw: 'PROTONMAIL.COM',
    expectedNormalized: 'PROTONMAIL',
    expectedChannel: 'direct',
  },
  {
    raw: 'MATCH.COM 800-926-2824 TX',
    expectedNormalized: 'MATCH',
    expectedChannel: 'direct',
  },
  {
    raw: 'TINDER 866-284-8433 TX',
    expectedNormalized: 'TINDER',
    expectedChannel: 'direct',
  },
  {
    raw: 'BUMBLE.COM 512-696-1409 TX',
    expectedNormalized: 'BUMBLE',
    expectedChannel: 'direct',
  },
  {
    raw: 'HINGE 844-844-6431 NY',
    expectedNormalized: 'HINGE',
    expectedChannel: 'direct',
  },
  {
    raw: 'ANCESTRY.COM 800-262-3787 UT',
    expectedNormalized: 'ANCESTRY',
    expectedChannel: 'direct',
  },
  {
    raw: 'CONSUMER REPORTS 800-333-0663',
    expectedNormalized: 'CONSUMER REPORTS',
    expectedChannel: 'direct',
  },
  {
    raw: 'WASHINGTONPOST.COM',
    expectedNormalized: 'WASHINGTONPOST',
    expectedChannel: 'direct',
  },
  {
    raw: 'THE ATHLETIC 855-907-3231',
    expectedNormalized: 'THE ATHLETIC',
    expectedChannel: 'direct',
  },
  {
    raw: 'BLOOMBERG.COM 212-318-2000',
    expectedNormalized: 'BLOOMBERG',
    expectedChannel: 'direct',
  },
  {
    raw: 'DOORDASH*DASHPASS',
    expectedNormalized: 'DOORDASH DASHPASS',
    expectedChannel: 'direct',
  },
  {
    raw: 'UBER ONE 03/14',
    expectedNormalized: 'UBER ONE',
    expectedChannel: 'direct',
  },
  {
    raw: 'SPOTIFY FAMILY PLAN',
    expectedNormalized: 'SPOTIFY FAMILY PLAN',
    expectedChannel: 'direct',
  },

  // ── Payment-processor and bank-added prefixes ─────────────────────────────────────────────
  // Every prefix in brief §4.2. They stack — a bank prefix in front of a processor prefix in
  // front of a channel marker — so they are stripped in a loop, not once.
  {
    raw: 'SQ *COFFEE SHOP SEATTLE WA',
    expectedNormalized: 'COFFEE SHOP',
    expectedChannel: 'direct',
  },
  {
    raw: 'SQ*BLUE BOTTLE COFFEE OAKLAND CA',
    expectedNormalized: 'BLUE BOTTLE COFFEE',
    expectedChannel: 'direct',
  },
  {
    raw: 'SQ *THE COFFEE BAR SAN FRANCISCO CA',
    expectedNormalized: 'THE COFFEE BAR',
    expectedChannel: 'direct',
  },
  {
    raw: 'SQ*GYM MEMBERSHIP',
    expectedNormalized: 'GYM',
    expectedChannel: 'direct',
  },
  {
    raw: 'SP * ALLBIRDS SAN FRANCISCO',
    expectedNormalized: 'ALLBIRDS',
    expectedChannel: 'direct',
  },
  {
    raw: 'SP*RIDGE WALLET',
    expectedNormalized: 'RIDGE WALLET',
    expectedChannel: 'direct',
  },
  {
    raw: 'SP *GLOSSIER NEW YORK NY',
    expectedNormalized: 'GLOSSIER',
    expectedChannel: 'direct',
  },
  {
    raw: 'TST* THE OLIVE GARDEN',
    expectedNormalized: 'THE OLIVE GARDEN',
    expectedChannel: 'direct',
  },
  {
    raw: 'TST*CHIPOTLE 1234',
    expectedNormalized: 'CHIPOTLE',
    expectedChannel: 'direct',
  },
  {
    raw: 'TST* SWEETGREEN 1234 NEW YORK NY',
    expectedNormalized: 'SWEETGREEN',
    expectedChannel: 'direct',
  },
  {
    raw: 'IC* INSTACART',
    expectedNormalized: 'INSTACART',
    expectedChannel: 'direct',
  },
  {
    raw: 'IC*INSTACART SUBSCRIPTION',
    expectedNormalized: 'INSTACART',
    expectedChannel: 'direct',
  },
  {
    raw: 'IC* INSTACART EXPRESS',
    expectedNormalized: 'INSTACART EXPRESS',
    expectedChannel: 'direct',
  },
  {
    raw: 'WL *NORTON 855-815-2726',
    expectedNormalized: 'NORTON',
    expectedChannel: 'direct',
  },
  {
    raw: 'WL *AVAST SOFTWARE',
    expectedNormalized: 'AVAST SOFTWARE',
    expectedChannel: 'direct',
  },
  {
    raw: 'EIG*BLUEHOST.COM 888-401-4678',
    expectedNormalized: 'BLUEHOST',
    expectedChannel: 'direct',
  },
  {
    raw: 'EIG*CONSTANT CONTACT',
    expectedNormalized: 'CONSTANT CONTACT',
    expectedChannel: 'direct',
  },
  {
    raw: 'PY *ACME GYM',
    expectedNormalized: 'ACME GYM',
    expectedChannel: 'direct',
  },
  {
    raw: 'PY *PLANET FITNESS',
    expectedNormalized: 'PLANET FITNESS',
    expectedChannel: 'direct',
  },
  {
    raw: 'CHKCARD NETFLIX.COM',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'CHKCARD SPOTIFY USA',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'CHKCARD PAYPAL *SPOTIFY',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'paypal',
    note: 'Bank prefix outside a channel marker; both come off, channel survives.',
  },
  {
    raw: 'POS DEBIT SPOTIFY USA',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'POS DEBIT SQ *TARTINE BAKERY',
    expectedNormalized: 'TARTINE BAKERY',
    expectedChannel: 'direct',
  },
  {
    raw: 'RECURRING PMT NETFLIX.COM',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'RECURRING PAYMENT HULU',
    expectedNormalized: 'HULU',
    expectedChannel: 'direct',
  },
  {
    raw: 'RECURRING PMT PAYPAL *HULU',
    expectedNormalized: 'HULU',
    expectedChannel: 'paypal',
  },
  {
    raw: 'DEBIT CARD PURCHASE SPOTIFY',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'DEBIT CARD PURCHASE APPLE.COM/BILL',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'VISA DDA PUR NETFLIX.COM LOS GATOS CA',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'VISA DDA PUR SPOTIFY USA',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'ACH DEBIT COMCAST CABLE',
    expectedNormalized: 'COMCAST CABLE',
    expectedChannel: 'direct',
  },
  {
    raw: 'ACH DEBIT SPOTIFY USA',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'DIRECT DEBIT VIRGIN MEDIA',
    expectedNormalized: 'VIRGIN MEDIA',
    expectedChannel: 'direct',
  },
  {
    raw: 'DIRECT DEBIT NETFLIX.COM',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'CARD PAYMENT TO SPOTIFY UK LTD',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'CARD PAYMENT TO NETFLIX.COM LONDON',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'PURCHASE AUTHORIZED ON 03/14 NETFLIX.COM 866-579-7172 CA',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'PURCHASE AUTHORIZED ON 11/02 SPOTIFY USA NY CARD 4321',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'PURCHASE AUTHORIZED ON 07/04 SPOTIFY USA 877-778-1161 NY',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'DD SPOTIFY UK',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },

  // ── Channel: Apple ────────────────────────────────────────────────────────────────────────
  // The hardest channel. Apple bills every App Store subscription under one descriptor, so the
  // merchant is usually not in the string at all and the key falls back to the marker itself.
  {
    raw: 'APPLE.COM/BILL 866-712-7753 CA',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'APPLE.COM/BILL',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'APPLE.COM/BILL 866-712-7753',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'APL*ITUNES.COM/BILL',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'APL* ITUNES.COM/BILL 866-712-7753',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'ITUNES.COM/BILL',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'ITUNES.COM/BILL 866-712-7753 CA',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'ITUNES.COM 866-712-7753 CA',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'APPLE.COM/US',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'APL*APPLE ONLINE STORE',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'APPLE COM BILL 866-712-7753 IE',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'APL*APPLE.COM/BILL',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'APPLE.COM/BILL DUBLIN IE',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'APPLE.COM/BILL CUPERTINO CA',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'APL*ITUNES.COM',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'apple.com/bill',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'APL*APPLE.COM/US',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },

  // ── Channel: Google Play ──────────────────────────────────────────────────────────────────
  // The merchant usually survives after the asterisk, which is why the marker is extracted
  // rather than simply deleted.
  {
    raw: 'GOOGLE *YouTubePrem g.co/helppay#',
    expectedNormalized: 'YOUTUBEPREM',
    expectedChannel: 'google',
  },
  {
    raw: 'GOOGLE*YouTube TV g.co/helppay# CA',
    expectedNormalized: 'YOUTUBE TV',
    expectedChannel: 'google',
  },
  {
    raw: 'GOOGLE *Google Storage g.co/helppay#',
    expectedNormalized: 'GOOGLE STORAGE',
    expectedChannel: 'google',
  },
  {
    raw: 'GOOGLE *YOUTUBEPREMIUM',
    expectedNormalized: 'YOUTUBEPREMIUM',
    expectedChannel: 'google',
  },
  {
    raw: 'GOOGLE *ONE g.co/helppay#',
    expectedNormalized: 'ONE',
    expectedChannel: 'google',
    note: 'Google One: the marker is also the merchant, and nothing can tell them apart.',
  },
  {
    raw: 'PLAY STORE ORDER GPA.3305-1234-5678-90123',
    expectedNormalized: 'GOOGLE',
    expectedChannel: 'google',
  },
  {
    raw: 'GOOGLE *SPOTIFY',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'google',
  },
  {
    raw: 'GOOGLE PLAY 855-836-3987 CA',
    expectedNormalized: 'GOOGLE',
    expectedChannel: 'google',
  },
  {
    raw: 'google *nest g.co/helppay#',
    expectedNormalized: 'NEST',
    expectedChannel: 'google',
  },
  {
    raw: 'GOOGLE *YOUTUBE TV',
    expectedNormalized: 'YOUTUBE TV',
    expectedChannel: 'google',
  },
  {
    raw: 'GOOGLE*GOOGLE STORAGE',
    expectedNormalized: 'GOOGLE STORAGE',
    expectedChannel: 'google',
  },
  {
    raw: 'GOOGLE *DISNEY PLUS g.co/helppay#',
    expectedNormalized: 'DISNEY PLUS',
    expectedChannel: 'google',
  },
  {
    raw: 'GOOGLE*CALM 855-703-6721 CA',
    expectedNormalized: 'CALM',
    expectedChannel: 'google',
  },

  // ── Channel: Amazon ───────────────────────────────────────────────────────────────────────
  // Amazon-resold subscriptions carry the reseller marker; an Amazon Prime membership does not,
  // because Amazon bills that one itself.
  {
    raw: 'AMZN Digital*2K9BC1AB2 amzn.com/bill WA',
    expectedNormalized: 'AMAZON',
    expectedChannel: 'amazon',
  },
  {
    raw: 'Amazon Digital Svcs 866-216-1072 WA',
    expectedNormalized: 'AMAZON',
    expectedChannel: 'amazon',
  },
  {
    raw: 'AMZN DIGITAL*3D4E5F6G7',
    expectedNormalized: 'AMAZON',
    expectedChannel: 'amazon',
  },
  {
    raw: 'AMZN Digital*1A2B3C4D5 amzn.com/bill WA',
    expectedNormalized: 'AMAZON',
    expectedChannel: 'amazon',
  },
  {
    raw: 'AMAZON DIGITAL SVCS 866-216-1072 WA',
    expectedNormalized: 'AMAZON',
    expectedChannel: 'amazon',
  },
  {
    raw: 'Prime Video Channels*PARAMOUNT+ 888-802-3080 WA',
    expectedNormalized: 'PARAMOUNT',
    expectedChannel: 'amazon',
  },
  {
    raw: 'PRIME VIDEO CHANNELS SHOWTIME 888-802-3080 WA',
    expectedNormalized: 'SHOWTIME',
    expectedChannel: 'amazon',
  },
  {
    raw: 'Prime Video Channels STARZ',
    expectedNormalized: 'STARZ',
    expectedChannel: 'amazon',
  },
  {
    raw: 'PRIME VIDEO CHANNELS*AMC PLUS 888-802-3080 WA',
    expectedNormalized: 'AMC PLUS',
    expectedChannel: 'amazon',
  },
  {
    raw: 'AMZNPRIME DE',
    expectedNormalized: 'AMZNPRIME',
    expectedChannel: 'direct',
    note: 'Prime membership: Amazon is the merchant, not the intermediary.',
  },
  {
    raw: 'AMAZON PRIME*2X3Y4Z5A6 amzn.com/bill',
    expectedNormalized: 'AMAZON PRIME',
    expectedChannel: 'direct',
  },
  {
    raw: 'AMAZON PRIME MEMBERSHIP 866-216-1072 WA',
    expectedNormalized: 'AMAZON PRIME',
    expectedChannel: 'direct',
  },
  {
    raw: 'PRIME VIDEO*BRITBOX 888-802-3080',
    expectedNormalized: 'PRIME VIDEO BRITBOX',
    expectedChannel: 'direct',
    note: 'Without CHANNELS this is not the reseller marker.',
  },
  {
    raw: 'AMZN MKTP US*RT4YU9O12',
    expectedNormalized: 'AMZN MKTP',
    expectedChannel: 'direct',
  },

  // ── Channel: PayPal ───────────────────────────────────────────────────────────────────────
  // Brief §4.2 spells this case out: the marker sets the channel and the merchant behind it
  // survives into the key.
  {
    raw: 'PAYPAL *SPOTIFY',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'paypal',
  },
  {
    raw: 'PAYPAL *NETFLIX',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'paypal',
  },
  {
    raw: 'PP*GITHUB',
    expectedNormalized: 'GITHUB',
    expectedChannel: 'paypal',
  },
  {
    raw: 'PP *DROPBOX',
    expectedNormalized: 'DROPBOX',
    expectedChannel: 'paypal',
  },
  {
    raw: 'PP*SUBSTACK',
    expectedNormalized: 'SUBSTACK',
    expectedChannel: 'paypal',
  },
  {
    raw: 'PP*STEAM',
    expectedNormalized: 'STEAM',
    expectedChannel: 'paypal',
  },
  {
    raw: 'PAYPAL.COM*NORDVPN',
    expectedNormalized: 'NORDVPN',
    expectedChannel: 'paypal',
  },
  {
    raw: 'PAYPAL *WIKIMEDIA',
    expectedNormalized: 'WIKIMEDIA',
    expectedChannel: 'paypal',
  },
  {
    raw: 'PAYPAL *NYTIMES 402-935-7733 CA',
    expectedNormalized: 'NYTIMES',
    expectedChannel: 'paypal',
  },
  {
    raw: 'PAYPAL *AUDIBLE',
    expectedNormalized: 'AUDIBLE',
    expectedChannel: 'paypal',
  },
  {
    raw: 'PAYPAL *HULU',
    expectedNormalized: 'HULU',
    expectedChannel: 'paypal',
  },
  {
    raw: 'PAYPAL *SKILLSHARE',
    expectedNormalized: 'SKILLSHARE',
    expectedChannel: 'paypal',
  },
  {
    raw: 'PAYPAL *PATREON',
    expectedNormalized: 'PATREON',
    expectedChannel: 'paypal',
  },
  {
    raw: 'PAYPAL *NORDVPN 35314369001',
    expectedNormalized: 'NORDVPN',
    expectedChannel: 'paypal',
  },
  {
    raw: 'PAYPAL *EBAY INC',
    expectedNormalized: 'EBAY',
    expectedChannel: 'paypal',
  },
  {
    raw: 'PAYPAL *2K9BC1AB2',
    expectedNormalized: 'PAYPAL',
    expectedChannel: 'paypal',
    note: 'Nothing but a reference behind the marker — falls back to the channel.',
  },
  {
    raw: 'pAyPaL *sPoTiFy',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'paypal',
  },

  // ── Channel: Roku ─────────────────────────────────────────────────────────────────────────
  // Roku resells channel subscriptions and is the only party that can cancel them.
  {
    raw: 'ROKU.COM/PAY HBO MAX',
    expectedNormalized: 'HBO MAX',
    expectedChannel: 'roku',
  },
  {
    raw: 'ROKU.COM/PAY CBS ALL ACC',
    expectedNormalized: 'CBS ALL ACC',
    expectedChannel: 'roku',
  },
  {
    raw: 'ROKU 816-272-8106 CA',
    expectedNormalized: 'ROKU',
    expectedChannel: 'roku',
  },
  {
    raw: 'ROKU*HULU',
    expectedNormalized: 'HULU',
    expectedChannel: 'roku',
  },
  {
    raw: 'ROKU.COM/PAY SHOWTIME',
    expectedNormalized: 'SHOWTIME',
    expectedChannel: 'roku',
  },
  {
    raw: 'ROKU.COM/PAY 816-272-8106 CA',
    expectedNormalized: 'ROKU',
    expectedChannel: 'roku',
  },
  {
    raw: 'ROKU*PARAMOUNT PLUS',
    expectedNormalized: 'PARAMOUNT PLUS',
    expectedChannel: 'roku',
  },
  {
    raw: 'ROKU.COM/PAY DISCOVERY+',
    expectedNormalized: 'DISCOVERY',
    expectedChannel: 'roku',
  },

  // ── Channel: Microsoft ────────────────────────────────────────────────────────────────────
  // MSBILL.INFO is a billing host and never carries the product name.
  {
    raw: 'MICROSOFT*XBOX GAME PASS MSBILL.INFO WA',
    expectedNormalized: 'XBOX GAME PASS',
    expectedChannel: 'microsoft',
  },
  {
    raw: 'MSFT * E0800XYZ12',
    expectedNormalized: 'MICROSOFT',
    expectedChannel: 'microsoft',
  },
  {
    raw: 'MSFT *E0800ABCDE',
    expectedNormalized: 'MICROSOFT',
    expectedChannel: 'microsoft',
  },
  {
    raw: 'MICROSOFT*ULTIMATE MSBILL.INFO WA',
    expectedNormalized: 'ULTIMATE',
    expectedChannel: 'microsoft',
  },
  {
    raw: 'MICROSOFT*OFFICE 365 MSBILL.INFO',
    expectedNormalized: 'OFFICE 365',
    expectedChannel: 'microsoft',
  },
  {
    raw: 'MSBILL.INFO 800-642-7676 WA',
    expectedNormalized: 'MICROSOFT',
    expectedChannel: 'microsoft',
  },
  {
    raw: 'MSBILL.INFO',
    expectedNormalized: 'MICROSOFT',
    expectedChannel: 'microsoft',
  },
  {
    raw: 'MICROSOFT 365 FAMILY',
    expectedNormalized: 'MICROSOFT 365 FAMILY',
    expectedChannel: 'direct',
    note: 'No asterisk marker: billed directly, not through the Microsoft Store.',
  },
  {
    raw: 'MICROSOFT*XBOX LIVE GOLD',
    expectedNormalized: 'XBOX LIVE GOLD',
    expectedChannel: 'microsoft',
  },
  {
    raw: 'MICROSOFT*OFFICE365 DUBLIN IE',
    expectedNormalized: 'OFFICE365',
    expectedChannel: 'microsoft',
  },
  {
    raw: 'MICROSOFT*STORE MSBILL.INFO',
    expectedNormalized: 'MICROSOFT',
    expectedChannel: 'microsoft',
  },
  {
    raw: 'MICROSOFT*MINECRAFT',
    expectedNormalized: 'MINECRAFT',
    expectedChannel: 'microsoft',
  },

  // ── Channel: Steam ────────────────────────────────────────────────────────────────────────
  // Valve bills under both names; neither ever names the game or the subscription.
  {
    raw: 'STEAMGAMES.COM 425-952-2985 WA',
    expectedNormalized: 'STEAM',
    expectedChannel: 'steam',
  },
  {
    raw: 'STEAMGAMES.COM',
    expectedNormalized: 'STEAM',
    expectedChannel: 'steam',
  },
  {
    raw: 'STEAMGAMES.COM 425-9522985',
    expectedNormalized: 'STEAM',
    expectedChannel: 'steam',
  },
  {
    raw: 'VALVE CORP BELLEVUE WA',
    expectedNormalized: 'STEAM',
    expectedChannel: 'steam',
  },
  {
    raw: 'VALVE CORPORATION',
    expectedNormalized: 'STEAM',
    expectedChannel: 'steam',
  },
  {
    raw: 'STEAM GAMES 425-952-2985',
    expectedNormalized: 'STEAM',
    expectedChannel: 'steam',
  },
  {
    raw: 'STEAMPOWERED.COM',
    expectedNormalized: 'STEAM',
    expectedChannel: 'steam',
  },

  // ── Channel: carrier billing ──────────────────────────────────────────────────────────────
  // Carrier-billed subscriptions are the least recoverable of all: the descriptor names the
  // carrier and an internal code, never the service.
  {
    raw: 'VZWRLSS*APOCC VISB 800-922-0204 FL',
    expectedNormalized: 'APOCC VISB',
    expectedChannel: 'carrier',
    note: 'Verizon internal codes. Barely recoverable, but stable.',
  },
  {
    raw: 'VZWRLSS*BILL PAY 800-922-0204 FL',
    expectedNormalized: 'CARRIER',
    expectedChannel: 'carrier',
  },
  {
    raw: 'VZWRLSS*IVR VB 800-922-0204',
    expectedNormalized: 'IVR VB',
    expectedChannel: 'carrier',
  },
  {
    raw: 'ATT*BILL PAYMENT 800-288-2020 TX',
    expectedNormalized: 'CARRIER',
    expectedChannel: 'carrier',
  },
  {
    raw: 'ATT*BILL PAYMENT',
    expectedNormalized: 'CARRIER',
    expectedChannel: 'carrier',
  },
  {
    raw: 'T-MOBILE POSTPAID PMT',
    expectedNormalized: 'CARRIER',
    expectedChannel: 'carrier',
  },
  {
    raw: 'TMOBILE POSTPAID PMT',
    expectedNormalized: 'CARRIER',
    expectedChannel: 'carrier',
  },
  {
    raw: 'T-MOBILE*PAYMENT',
    expectedNormalized: 'CARRIER',
    expectedChannel: 'carrier',
  },
  {
    raw: 'VERIZON WIRELESS PAYMENTS 800-922-0204',
    expectedNormalized: 'CARRIER',
    expectedChannel: 'carrier',
  },
  {
    raw: 'VERIZON WIRELESS 800-922-0204 FL',
    expectedNormalized: 'CARRIER',
    expectedChannel: 'carrier',
  },

  // ── UK and EU descriptor shapes ───────────────────────────────────────────────────────────
  // Direct debits, legal entity suffixes, and a country code where a US bank would put a state.
  // The same merchant must land on the same key on both sides of the Atlantic.
  {
    raw: 'SPOTIFY UK LTD LONDON',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'SPOTIFY UK LTD',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'SPOTIFY P16C7F5AB4',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
    note: 'UK reference suffix: mostly digits, so it reads as opaque.',
  },
  {
    raw: 'NETFLIX.COM AMSTERDAM NL',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'NETFLIX INTERNATIONAL B.V.',
    expectedNormalized: 'NETFLIX INTERNATIONAL',
    expectedChannel: 'direct',
  },
  {
    raw: 'NETFLIX.COM LONDON GB',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'AMAZON PRIME DE',
    expectedNormalized: 'AMAZON PRIME',
    expectedChannel: 'direct',
  },
  {
    raw: 'AMAZON PRIME NL',
    expectedNormalized: 'AMAZON PRIME',
    expectedChannel: 'direct',
  },
  {
    raw: 'AMZNPRIME NL',
    expectedNormalized: 'AMZNPRIME',
    expectedChannel: 'direct',
  },
  {
    raw: 'SKY DIGITAL 08442 411 653',
    expectedNormalized: 'SKY DIGITAL',
    expectedChannel: 'direct',
  },
  {
    raw: 'DD NETFLIX.COM',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'DD NETFLIX INTERNATIONAL',
    expectedNormalized: 'NETFLIX INTERNATIONAL',
    expectedChannel: 'direct',
  },
  {
    raw: 'DD SKY SUBSCRIPTION',
    expectedNormalized: 'SKY',
    expectedChannel: 'direct',
  },
  {
    raw: 'DD THE GUARDIAN',
    expectedNormalized: 'THE GUARDIAN',
    expectedChannel: 'direct',
  },
  {
    raw: 'DD PURE GYM LTD',
    expectedNormalized: 'PURE GYM',
    expectedChannel: 'direct',
  },
  {
    raw: 'DD VIRGIN MEDIA 0800 001 4000',
    expectedNormalized: 'VIRGIN MEDIA',
    expectedChannel: 'direct',
  },
  {
    raw: 'SPOTIFY AB STOCKHOLM SE',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'SPOTIFY LTD DUBLIN IE',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'SPOTIFY.COM STOCKHOLM SE',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'BBC STUDIOS LONDON GB',
    expectedNormalized: 'BBC STUDIOS',
    expectedChannel: 'direct',
  },
  {
    raw: 'BBC LICENCE FEE',
    expectedNormalized: 'BBC LICENCE FEE',
    expectedChannel: 'direct',
  },
  {
    raw: 'TV LICENSING 0300 790 6165',
    expectedNormalized: 'TV LICENSING',
    expectedChannel: 'direct',
  },
  {
    raw: 'NOW TV LONDON',
    expectedNormalized: 'NOW TV',
    expectedChannel: 'direct',
  },
  {
    raw: 'NOW TV BROADBAND',
    expectedNormalized: 'NOW TV BROADBAND',
    expectedChannel: 'direct',
  },
  {
    raw: 'VIRGIN MEDIA PAYMENTS LTD',
    expectedNormalized: 'VIRGIN MEDIA',
    expectedChannel: 'direct',
  },
  {
    raw: 'SKY UK LTD LONDON',
    expectedNormalized: 'SKY',
    expectedChannel: 'direct',
  },
  {
    raw: 'AMAZON PRIME*MEMBERSHIP LU',
    expectedNormalized: 'AMAZON PRIME',
    expectedChannel: 'direct',
  },
  {
    raw: 'ADOBE SYSTEMS SOFTWARE IRL',
    expectedNormalized: 'ADOBE SYSTEMS SOFTWARE',
    expectedChannel: 'direct',
  },
  {
    raw: 'DISNEY PLUS LONDON GB',
    expectedNormalized: 'DISNEY PLUS',
    expectedChannel: 'direct',
  },
  {
    raw: 'DISNEY PLUS DUBLIN IE',
    expectedNormalized: 'DISNEY PLUS',
    expectedChannel: 'direct',
  },
  {
    raw: 'AUDIBLE UK LTD LONDON',
    expectedNormalized: 'AUDIBLE',
    expectedChannel: 'direct',
  },
  {
    raw: 'AUDIBLE UK',
    expectedNormalized: 'AUDIBLE',
    expectedChannel: 'direct',
  },
  {
    raw: 'AUDIBLE.CO.UK LONDON',
    expectedNormalized: 'AUDIBLE',
    expectedChannel: 'direct',
  },
  {
    raw: 'WWW.NETFLIX.COM AMSTERDAM',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'AMAZON.CO.UK*2K9BC1AB2',
    expectedNormalized: 'AMAZON',
    expectedChannel: 'direct',
  },
  {
    raw: 'GOOGLE *YOUTUBE DUBLIN IE',
    expectedNormalized: 'YOUTUBE',
    expectedChannel: 'google',
  },
  {
    raw: 'APPLE.COM/BILL LONDON GB',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'CARD PAYMENT TO AMAZON PRIME',
    expectedNormalized: 'AMAZON PRIME',
    expectedChannel: 'direct',
  },
  {
    raw: 'THE TIMES LONDON',
    expectedNormalized: 'THE TIMES',
    expectedChannel: 'direct',
  },
  {
    raw: 'DAZN LIMITED LONDON',
    expectedNormalized: 'DAZN',
    expectedChannel: 'direct',
  },
  {
    raw: 'AWS EMEA S.A.R.L.',
    expectedNormalized: 'AWS EMEA',
    expectedChannel: 'direct',
    note: 'Every fragment of the legal form is a single letter and goes.',
  },

  // ── Trailing junk: phones, URLs, store numbers, order ids, dates, digit runs ──────────────
  // One noise shape per entry, so a regression names the pass that broke.
  {
    raw: 'PATREON.COM 4085555555',
    expectedNormalized: 'PATREON',
    expectedChannel: 'direct',
  },
  {
    raw: 'SPOTIFY USA 2024-01-15',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'NORDVPN 2024-03-14',
    expectedNormalized: 'NORDVPN',
    expectedChannel: 'direct',
  },
  {
    raw: 'SPOTIFY USA 03/14/2024',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'HULU 2024-03-14 877-824-4858',
    expectedNormalized: 'HULU',
    expectedChannel: 'direct',
  },
  {
    raw: 'HULU ORDER 12345678',
    expectedNormalized: 'HULU',
    expectedChannel: 'direct',
  },
  {
    raw: 'NETFLIX #1234',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'NETFLIX.COM 1234567890123',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'NETFLIX.COM/BILLING 866-579-7172',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'SIRIUSXM.COM/ACCOUNT 888-635-5144',
    expectedNormalized: 'SIRIUSXM',
    expectedChannel: 'direct',
  },
  {
    raw: 'SPOTIFY REF:8823ABCD',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'SPOTIFY USA REF# 8823ABCD',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'HULU INV 99213',
    expectedNormalized: 'HULU',
    expectedChannel: 'direct',
  },
  {
    raw: 'HULU TRACE#123456',
    expectedNormalized: 'HULU',
    expectedChannel: 'direct',
  },
  {
    raw: 'NETFLIX ID: A1B2C3D4E5',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'ADOBE INV#00012345',
    expectedNormalized: 'ADOBE',
    expectedChannel: 'direct',
  },
  {
    raw: 'AUDIBLE ORDER D01-2345678-1234567',
    expectedNormalized: 'AUDIBLE',
    expectedChannel: 'direct',
  },
  {
    raw: 'AUDIBLE.COM ORDER#D01-1234567',
    expectedNormalized: 'AUDIBLE',
    expectedChannel: 'direct',
  },
  {
    raw: 'PATREON STORE #12345',
    expectedNormalized: 'PATREON',
    expectedChannel: 'direct',
  },
  {
    raw: 'DISNEY PLUS CARD 4321',
    expectedNormalized: 'DISNEY PLUS',
    expectedChannel: 'direct',
  },
  {
    raw: 'STARBUCKS STORE 04321 SEATTLE WA',
    expectedNormalized: 'STARBUCKS',
    expectedChannel: 'direct',
  },
  {
    raw: 'SAFEWAY #1234 SAN JOSE CA',
    expectedNormalized: 'SAFEWAY',
    expectedChannel: 'direct',
  },
  {
    raw: 'WALGREENS #04321 CHICAGO IL',
    expectedNormalized: 'WALGREENS',
    expectedChannel: 'direct',
  },
  {
    raw: 'DUNKIN #336819 BOSTON MA',
    expectedNormalized: 'DUNKIN',
    expectedChannel: 'direct',
  },
  {
    raw: 'SHELL OIL 574421234567',
    expectedNormalized: 'SHELL OIL',
    expectedChannel: 'direct',
  },
  {
    raw: "MCDONALD'S F1234567",
    expectedNormalized: 'MCDONALD',
    expectedChannel: 'direct',
  },
  {
    raw: 'UBER *TRIP HELP.UBER.COM',
    expectedNormalized: 'UBER TRIP',
    expectedChannel: 'direct',
  },

  // ── Case and spacing chaos ────────────────────────────────────────────────────────────────
  // Same merchants, mangled. Every one of these must land on the key its clean form produces.
  {
    raw: 'netflix.com',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'netflix',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'NeTfLiX.CoM  LOS GATOS  CA',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'spotify usa',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: '  SPOTIFY   USA  ',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'HULU***',
    expectedNormalized: 'HULU',
    expectedChannel: 'direct',
  },
  {
    raw: 'SPOTIFY**USA',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: '**SPOTIFY**',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'Netflix.com*',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'NETFLIX.COM.',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'direct',
  },
  {
    raw: 'SPOTIFY-USA',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'direct',
  },
  {
    raw: 'HULU,  INC.',
    expectedNormalized: 'HULU',
    expectedChannel: 'direct',
  },
  {
    raw: 'GOOGLE  *  YouTubePremium',
    expectedNormalized: 'YOUTUBEPREMIUM',
    expectedChannel: 'google',
  },
  {
    raw: 'Google  *  Nest',
    expectedNormalized: 'NEST',
    expectedChannel: 'google',
  },
  {
    raw: 'MICROSOFT  *  XBOX',
    expectedNormalized: 'XBOX',
    expectedChannel: 'microsoft',
  },
  {
    raw: 'AMZN   DIGITAL*2K9BC1AB2',
    expectedNormalized: 'AMAZON',
    expectedChannel: 'amazon',
  },
  {
    raw: 'ApPlE.CoM/BiLl 866-712-7753 CA',
    expectedNormalized: 'APPLE',
    expectedChannel: 'apple',
  },
  {
    raw: 'PAYPAL*SPOTIFY',
    expectedNormalized: 'SPOTIFY',
    expectedChannel: 'paypal',
  },
  {
    raw: 'PAYPAL  *  NETFLIX',
    expectedNormalized: 'NETFLIX',
    expectedChannel: 'paypal',
  },
  {
    raw: 'DISNEY  PLUS   888-905-7888   CA',
    expectedNormalized: 'DISNEY PLUS',
    expectedChannel: 'direct',
  },
  {
    raw: 'sq *coffee shop',
    expectedNormalized: 'COFFEE SHOP',
    expectedChannel: 'direct',
  },

  // ── Barely recoverable ────────────────────────────────────────────────────────────────────
  // Where the honest answer is "not much". These pin the failure mode: an empty key the caller
  // must discard, or a stable-but-meaningless one it may still cluster on.
  {
    raw: 'SP *1234567',
    expectedNormalized: '',
    expectedChannel: 'direct',
    note: 'Nothing but a reference. Empty key — the caller discards it.',
  },
  {
    raw: 'POS DEBIT 00123456789',
    expectedNormalized: '',
    expectedChannel: 'direct',
    note: 'Empty key.',
  },
  {
    raw: 'ACH DEBIT WEB PMT',
    expectedNormalized: '',
    expectedChannel: 'direct',
    note: 'All filler. Empty key.',
  },
  {
    raw: 'WL *STEAM PURCHASE',
    expectedNormalized: 'STEAM',
    expectedChannel: 'direct',
    note: 'A bare STEAM is not a channel marker, so the channel stays direct.',
  },
  {
    raw: 'AMAZON WEB SERVICES AWS.AMAZON.CO WA',
    expectedNormalized: 'AMAZON WEB SERVICES AWS',
    expectedChannel: 'direct',
  },
  {
    raw: 'PG&E 800-743-5000 CA',
    expectedNormalized: 'PG',
    expectedChannel: 'direct',
    note: 'The ampersand splits the name and the orphaned letter goes. Stable, not pretty.',
  },
  {
    raw: 'PAYPAL INST XFER',
    expectedNormalized: 'INST XFER',
    expectedChannel: 'paypal',
  },
  {
    raw: 'CASH APP*JOHN SMITH',
    expectedNormalized: 'CASH APP JOHN SMITH',
    expectedChannel: 'direct',
  },
  {
    raw: 'GEICO *AUTO 800-841-3000',
    expectedNormalized: 'GEICO AUTO',
    expectedChannel: 'direct',
  },
  {
    raw: 'STATE FARM INSURANCE 800-782-8332',
    expectedNormalized: 'STATE FARM INSURANCE',
    expectedChannel: 'direct',
  },

  // ── Non-subscriptions — the false-positive guard ──────────────────────────────────────────
  // Groceries, restaurants, fuel, ATMs, transfers. Nothing here should ever become a candidate;
  // all that is asked of the normalizer is that it produce a clean, stable key and stay quiet.
  {
    raw: "TRADER JOE'S #123 PASADENA CA",
    expectedNormalized: 'TRADER JOE',
    expectedChannel: 'direct',
  },
  {
    raw: 'WHOLE FOODS MKT 10123 AUSTIN TX',
    expectedNormalized: 'WHOLE FOODS MKT',
    expectedChannel: 'direct',
  },
  {
    raw: 'KROGER #123 CINCINNATI OH',
    expectedNormalized: 'KROGER',
    expectedChannel: 'direct',
  },
  {
    raw: 'COSTCO WHSE #0123 SEATTLE WA',
    expectedNormalized: 'COSTCO WHSE',
    expectedChannel: 'direct',
  },
  {
    raw: 'TARGET 00012345 MINNEAPOLIS MN',
    expectedNormalized: 'TARGET',
    expectedChannel: 'direct',
  },
  {
    raw: 'WALMART.COM 800-925-6278 AR',
    expectedNormalized: 'WALMART',
    expectedChannel: 'direct',
  },
  {
    raw: 'PANERA BREAD #601234 AUSTIN TX',
    expectedNormalized: 'PANERA BREAD',
    expectedChannel: 'direct',
  },
  {
    raw: 'SUBWAY 12345 DALLAS TX',
    expectedNormalized: 'SUBWAY',
    expectedChannel: 'direct',
  },
  {
    raw: 'CHIPOTLE 1234 CHICAGO IL',
    expectedNormalized: 'CHIPOTLE',
    expectedChannel: 'direct',
  },
  {
    raw: 'ATM WITHDRAWAL 03/14 CHASE 1234',
    expectedNormalized: 'ATM WITHDRAWAL CHASE',
    expectedChannel: 'direct',
  },
  {
    raw: 'ATM CASH WITHDRAWAL 123 MAIN ST BOSTON MA',
    expectedNormalized: 'ATM CASH WITHDRAWAL 123 MAIN ST',
    expectedChannel: 'direct',
  },
  {
    raw: 'ATM FEE',
    expectedNormalized: 'ATM FEE',
    expectedChannel: 'direct',
  },
  {
    raw: 'OVERDRAFT FEE',
    expectedNormalized: 'OVERDRAFT FEE',
    expectedChannel: 'direct',
  },
  {
    raw: 'CHECK #1234',
    expectedNormalized: 'CHECK',
    expectedChannel: 'direct',
  },
  {
    raw: 'ZELLE PAYMENT TO JOHN SMITH 12345678',
    expectedNormalized: 'ZELLE PAYMENT TO JOHN SMITH',
    expectedChannel: 'direct',
  },
  {
    raw: 'TRANSFER TO SAVINGS 1234567890',
    expectedNormalized: 'TRANSFER TO SAVINGS',
    expectedChannel: 'direct',
  },
  {
    raw: 'VENMO PAYMENT 1234567890',
    expectedNormalized: 'VENMO',
    expectedChannel: 'direct',
  },
  {
    raw: 'EXXONMOBIL 1234 HOUSTON TX',
    expectedNormalized: 'EXXONMOBIL',
    expectedChannel: 'direct',
  },
  {
    raw: 'LYFT *RIDE 03/14',
    expectedNormalized: 'LYFT RIDE',
    expectedChannel: 'direct',
  },
  {
    raw: 'DELTA AIR LINES 0062345678901 ATLANTA GA',
    expectedNormalized: 'DELTA AIR LINES',
    expectedChannel: 'direct',
  },
  {
    raw: 'MARRIOTT HOTELS 12345 NEW YORK NY',
    expectedNormalized: 'MARRIOTT HOTELS',
    expectedChannel: 'direct',
  },
  {
    raw: 'CVS/PHARMACY #04321 MIAMI FL',
    expectedNormalized: 'CVS PHARMACY',
    expectedChannel: 'direct',
  },
  {
    raw: 'HOME DEPOT 1234 DENVER CO',
    expectedNormalized: 'HOME DEPOT',
    expectedChannel: 'direct',
  },
  {
    raw: 'INTEREST PAYMENT',
    expectedNormalized: 'INTEREST',
    expectedChannel: 'direct',
  },
  {
    raw: 'AMZN MKTP US AMZN.COM/BILL WA',
    expectedNormalized: 'AMZN MKTP',
    expectedChannel: 'direct',
  },
];
