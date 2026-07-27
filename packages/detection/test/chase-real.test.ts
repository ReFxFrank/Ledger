import { describe, expect, it } from 'vitest';
import { normalizeDescriptor } from '../src/normalize';

/**
 * Descriptor shapes from a real Chase export.
 *
 * Every case here is a defect this engine actually had, found by running a genuine
 * 1,100-transaction statement through it rather than by imagining what a bank might send.
 * Merchant identifiers are redacted; the *shapes* are verbatim, because the shapes are the spec.
 *
 * The synthetic corpus in `descriptors.ts` was written from knowledge of how descriptors work.
 * This file exists because that turned out not to be the same thing as how one bank actually
 * writes them, and four separate clustering failures were hiding in the gap.
 */

const key = (raw: string): string => normalizeDescriptor(raw).normalized;
const channelOf = (raw: string): string => normalizeDescriptor(raw).channel;

describe('Chase ACH envelope', () => {
  /**
   * The worst defect the engine has had.
   *
   * Chase wraps every ACH pull in labelled fields. The merchant lives in `IND ID` — the
   * individual identifier, which for a payment processor is who the money reached. Before this
   * was handled, the labels survived and the merchant did not: every such charge normalized to
   * `ORIG CO NAME CO ENTRY DESCR PURCHASE SEC WEB IND ID ORIG`, so Steam, Roblox and Google all
   * collapsed into ONE cluster — losing every real subscription among them and inventing a fake
   * high-frequency one out of their sum.
   */
  it('extracts the merchant from IND ID rather than keeping the field labels', () => {
    const steam = normalizeDescriptor(
      'ORIG CO NAME:PAYPAL   CO ENTRY DESCR:PURCHASE SEC:WEB IND ID:STEAM GAMES  ORIG ID:PAYPALSI77',
    );
    expect(steam.normalized).toBe('STEAM');
    // And the channel survives: a Steam subscription is not cancelled on a merchant's website.
    expect(steam.channel).toBe('steam');
  });

  it('does not let two different merchants share the envelope boilerplate', () => {
    const steam = key('ORIG CO NAME:PAYPAL CO ENTRY DESCR:PURCHASE SEC:WEB IND ID:STEAM GAMES  ORIG ID:PAYPALSI77');
    const roblox = key('ORIG CO NAME:PAYPAL CO ENTRY DESCR:PURCHASE SEC:WEB IND ID:ROBLOXCORPO  ORIG ID:PAYPALSI77');
    expect(steam).not.toBe(roblox);
  });

  it('falls back to the originating company when IND ID is only digits', () => {
    // A numeric IND ID is a customer reference, not a name — the company field is then the best
    // merchant available rather than a worse one.
    expect(key('ORIG CO NAME:SPOTIFY USA  CO ENTRY DESCR:PURCHASE SEC:WEB IND ID:1051899913352  ORIG ID:X')).toContain(
      'SPOTIFY',
    );
  });
});

describe('foreign-transaction tail', () => {
  /**
   * A cross-border charge carries the amount and the FX rate, both of which differ every month.
   * A real Amazon.ca Prime membership produced two unrelated keys for two consecutive charges
   * and could therefore never be detected as recurring.
   */
  it('is stripped, so the same foreign subscription clusters across months', () => {
    const october = key('Amazon.ca Prime Memb amazon.ca/pri BC        10/29 CA DOLLAR  11.29 X 0.731000 (EXCHG RTE)');
    const december = key('Amazon.ca Prime Memb amazon.ca/pri BC        12/30 CA DOLLAR  5.64 X 0.728000 (EXCHG RTE)');
    expect(october).toBe(december);
    expect(october).not.toContain('EXCHG');
    expect(october).not.toContain('11');
  });

  it('handles a euro tail as well as a dollar one', () => {
    const august = key('7TV_SUBSCRIPTION RENNES      08/03 Euro       3.99 X 1.086000 (EXCHG RTE)');
    const september = key('7TV_SUBSCRIPTION RENNES      09/03 Euro       3.99 X 1.091000 (EXCHG RTE)');
    expect(august).toBe(september);
    expect(august).not.toContain('EURO');
  });
});

describe('Chase transaction-type prefixes', () => {
  /**
   * `PURCHASE` and `INST XFER` sit in front of the merchant. They split six merchants in two on
   * the real statement, so one subscription was proposed twice at half its occurrence count —
   * which halves its confidence and can push a genuine subscription below the surfacing
   * threshold entirely.
   */
  it('collapses PURCHASE onto the bare merchant', () => {
    expect(key('PURCHASE PARAMNTPLUS')).toBe(key('PARAMNTPLUS'));
  });

  it('collapses INST XFER onto the bare merchant', () => {
    expect(key('INST XFER SPOTIFY')).toBe(key('SPOTIFY'));
  });

  it('leaves a merchant whose name genuinely starts with the word alone', () => {
    // Anchored and followed by whitespace, so "Purchase Plus" survives as itself.
    expect(key('PURCHASEPLUS SUPPLIES')).toContain('PURCHASEPLUS');
  });
});

describe('authorisation state', () => {
  /**
   * Chase writes PENDING while a card charge is unsettled and drops it once posted. The same
   * merchant therefore produced two clusters that never merged — and in the real statement that
   * was what let food delivery look like a subscription: split in two, each half had a tight
   * enough amount range to survive the variance filter. Merged, the true variance showed and the
   * engine correctly discarded it.
   */
  it('is not part of the merchant name', () => {
    expect(key('UBER * EATS PENDING SAN FRANCISCO CA 727756 07/10')).toBe(
      key('UBER * EATS SAN FRANCISCO CA 077677 07/09'),
    );
  });
});

describe('shapes that must NOT collapse', () => {
  it('keeps distinct merchants distinct even when the noise around them matches', () => {
    expect(key('AMAZON MKTPL*4562N1S Amzn.com/bill WA 05/22')).not.toBe(
      key('Amazon.ca Prime Memb amazon.ca/pri BC 10/29 CA DOLLAR 11.29 X 0.731 (EXCHG RTE)'),
    );
  });

  it('still recognises a PayPal-billed merchant as PayPal-billed', () => {
    expect(channelOf('PAYPAL *PATREON MEMBE 415-967-2735 CA 07/10')).toBe('paypal');
  });
});
